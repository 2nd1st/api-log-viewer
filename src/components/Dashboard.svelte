<script lang="ts">
  // Dashboard — default home view (#/, #/dashboard).
  //
  // Polls /api/traces?limit=200 + /healthz every 10s. The list endpoint
  // returns ROW METADATA ONLY (no req/resp bodies — see internal/api/
  // traces.go listTraces handler). So the KPIs split into two tiers:
  //
  //   tier 1 — straight off the row metadata (cheap, full N=200):
  //     - total traces in window
  //     - top "protocol" (derived from path via lib/adapters detectProtocol)
  //     - top model (row.model)
  //     - top client (row.client — UA-based identifier the gateway captures)
  //     - error rate (status not in 200-299)
  //     - slow trace count (ts_end - ts_start > 30s)
  //
  //   tier 2 — needs detail blobs (capped at the 30 most recent traces):
  //     - block-type distribution (run adapt() on each, then countByType)
  //     - top tools used (tool_call.tool_name across all blocks)
  //   Both tier-2 charts are explicitly labeled "(recent 30)" so the
  //   operator knows the sample size. This matches the existing
  //   "viewer is a viewer, not an exporter" 30-trace pattern from
  //   ConversationTab's session-include loader.
  //
  // Below the KPIs sits an "Internal" section that absorbs the old
  // healthz cards + per-trace timings, but rendered smaller / dimmer so
  // it doesn't compete with the operator-facing stats.
  //
  // Refresh button: bumping reloadKey from the parent remounts this whole
  // component so the polling timers and fetch state reset cleanly.

  import { detectProtocol } from '../lib/adapters';
  import { adapt } from '../lib/adapters';
  import { countByType } from '../lib/blocks';
  import type { Block, ToolCallBlock } from '../lib/blocks';
  import { shortId, shortTs, statusClass } from '../lib/format';
  import type { TraceBlob } from './DetailPanel.svelte';

  // ---------- row shape (subset of /api/traces row) ----------

  interface ListRow {
    id: string;
    ts_start?: string | null;
    ts_end?: string | null;
    status?: number | null;
    path?: string | null;
    model?: string | null;
    client?: string | null;
    key_hash?: string | null;
    session_root_id?: string | null;
    [k: string]: unknown;
  }

  interface Props {
    authFetch: (path: string, opts?: RequestInit) => Promise<Response>;
    onSelectTrace?: (id: string) => void;
  }

  const { authFetch, onSelectTrace }: Props = $props();

  // ---------- list state ----------

  let rows = $state<ListRow[]>([]);
  let rowsLoadError = $state<string>('');

  async function loadList() {
    try {
      const r = await authFetch('api/traces?limit=200');
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      rows = (j.traces || []) as ListRow[];
      rowsLoadError = '';
    } catch (e: any) {
      rowsLoadError = e?.message || String(e);
    }
  }

  // ---------- healthz state (absorbed from HealthzView) ----------

  interface TimingBucket {
    p50_ms?: number;
    p95_ms?: number;
    p99_ms?: number;
    count?: number;
    mean_ms?: number;
  }

  interface HealthzCounters {
    appended?: number;
    appended_2xx?: number;
    appended_4xx?: number;
    appended_5xx?: number;
    indexed?: number;
    drop_writer_full?: number;
    drop_jsonl_fail?: number;
    drop_sqlite_fail?: number;
    truncated_req_total?: number;
    truncated_resp_total?: number;
    writer_chan_high_water?: number;
    slow_traces?: number;
    upstream_dial_err?: number;
    timings?: Record<string, TimingBucket>;
  }

  interface Healthz {
    uptime_seconds: number;
    counters?: HealthzCounters;
  }

  let healthz = $state<Healthz | null>(null);
  let healthzLoadError = $state<string>('');

  async function loadHealthz() {
    try {
      const r = await authFetch('healthz');
      if (!r.ok) throw new Error(String(r.status));
      healthz = (await r.json()) as Healthz;
      healthzLoadError = '';
    } catch (e: any) {
      healthzLoadError = e?.message || String(e);
    }
  }

  // ---------- detail blobs for block-type tiers (bounded at 30) ----------

  const DETAIL_SAMPLE_SIZE = 30;

  let detailBlocks = $state<Block[]>([]);
  let detailSampleCount = $state<number>(0);

  /**
   * Fetch up to N most-recent traces' detail blobs, run adapt() on each,
   * flatten the resulting Block[]s. Re-runs whenever the rows list changes.
   *
   * Concurrency: serial. The dashboard polls every 10s so a slow burst of
   * 30 fetches won't pile up — we cap with a cancelled flag.
   */
  async function refreshDetailSample(currentRows: ListRow[]) {
    const sample = currentRows.slice(0, DETAIL_SAMPLE_SIZE);
    const all: Block[] = [];
    for (const row of sample) {
      try {
        const r = await authFetch(`api/traces/${row.id}`);
        if (!r.ok) continue;
        const j = await r.json();
        const tb: TraceBlob = (j.trace ?? {}) as TraceBlob;
        const blocks = adapt(row.path ?? '', tb);
        for (const b of blocks) all.push(b);
      } catch {
        // swallow — one bad detail shouldn't blank the chart
      }
    }
    detailBlocks = all;
    detailSampleCount = sample.length;
  }

  // ---------- 10s polling ----------

  $effect(() => {
    loadList();
    loadHealthz();
    const t = setInterval(() => {
      loadList();
      loadHealthz();
    }, 10000);
    return () => clearInterval(t);
  });

  // Whenever the rows list updates, re-pull the detail sample. This runs
  // independently from the 10s timer so a quick refresh button bump
  // (which doesn't restart the interval) still updates the charts.
  $effect(() => {
    if (rows.length === 0) {
      detailBlocks = [];
      detailSampleCount = 0;
      return;
    }
    let cancelled = false;
    (async () => {
      const snapshot = rows.slice();
      if (cancelled) return;
      await refreshDetailSample(snapshot);
    })();
    return () => {
      cancelled = true;
    };
  });

  // ---------- KPI derivations (tier 1 — row metadata) ----------

  function topKey<T extends string>(items: Array<T | null | undefined>): { value: T | null; count: number } {
    const counts = new Map<T, number>();
    for (const x of items) {
      if (!x) continue;
      counts.set(x, (counts.get(x) ?? 0) + 1);
    }
    let best: T | null = null;
    let bestN = 0;
    for (const [k, n] of counts) {
      if (n > bestN) {
        best = k;
        bestN = n;
      }
    }
    return { value: best, count: bestN };
  }

  const total = $derived(rows.length);

  const topProtocol = $derived.by(() => {
    const protos = rows.map((r) => detectProtocol(r.path));
    return topKey(protos);
  });

  const topModel = $derived.by(() => topKey(rows.map((r) => r.model)));

  const topClient = $derived.by(() => topKey(rows.map((r) => r.client)));

  const errorRate = $derived.by(() => {
    if (rows.length === 0) return { pct: 0, errs: 0 };
    const errs = rows.filter((r) => {
      const s = r.status ?? 0;
      return s < 200 || s >= 300;
    }).length;
    return { pct: (errs / rows.length) * 100, errs };
  });

  const slowCount = $derived.by(() => {
    let n = 0;
    for (const r of rows) {
      if (!r.ts_start || !r.ts_end) continue;
      const dur = new Date(r.ts_end).getTime() - new Date(r.ts_start).getTime();
      if (dur > 30000) n++;
    }
    return n;
  });

  // ---------- block-type distribution (tier 2 — detail sample) ----------

  const blockCounts = $derived(countByType(detailBlocks));

  const BLOCK_TYPE_ORDER = [
    'text',
    'reasoning',
    'tool_call',
    'tool_result',
    'media',
    'error',
    'unknown',
  ] as const;

  const blockBars = $derived.by(() => {
    const entries = BLOCK_TYPE_ORDER.map((t) => ({
      type: t,
      count: blockCounts[t] || 0,
    }))
      .filter((e) => e.count > 0)
      .sort((a, b) => b.count - a.count);
    const max = entries.reduce((m, e) => Math.max(m, e.count), 0);
    return entries.map((e) => ({
      ...e,
      pct: max === 0 ? 0 : (e.count / max) * 100,
    }));
  });

  // ---------- top tools (tier 2 — detail sample) ----------

  const topTools = $derived.by(() => {
    const counts = new Map<string, number>();
    for (const b of detailBlocks) {
      if (b.type !== 'tool_call') continue;
      const tc = b as ToolCallBlock;
      const name = tc.tool_name || 'unknown';
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const arr = Array.from(counts.entries())
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
    const max = arr.reduce((m, e) => Math.max(m, e.count), 0);
    return arr.map((e) => ({ ...e, pct: max === 0 ? 0 : (e.count / max) * 100 }));
  });

  // ---------- recent activity tape (last 30 by ts_start) ----------

  const recentRows = $derived.by(() =>
    rows
      .slice()
      .sort((a, b) => (b.ts_start ?? '').localeCompare(a.ts_start ?? ''))
      .slice(0, 30),
  );

  // ---------- top active sessions (replacement for the cut Sessions list) ----------

  interface SessionEntry {
    sessionRootId: string;
    turns: number;
    firstTs: string;
    lastTs: string;
    lastPath: string;
    lastStatus: number | null;
    firstTraceId: string;
    lastTraceId: string;
  }

  const topSessions = $derived.by<SessionEntry[]>(() => {
    const bySession = new Map<string, SessionEntry>();
    for (const r of rows) {
      const sid = r.session_root_id;
      if (!sid) continue;
      const ts = r.ts_start ?? '';
      const existing = bySession.get(sid);
      if (!existing) {
        bySession.set(sid, {
          sessionRootId: sid,
          turns: 1,
          firstTs: ts,
          lastTs: ts,
          lastPath: r.path ?? '',
          lastStatus: r.status ?? null,
          firstTraceId: r.id,
          lastTraceId: r.id,
        });
        continue;
      }
      existing.turns++;
      if (ts > existing.lastTs) {
        existing.lastTs = ts;
        existing.lastPath = r.path ?? existing.lastPath;
        existing.lastStatus = r.status ?? existing.lastStatus;
        existing.lastTraceId = r.id;
      }
      if (ts && (!existing.firstTs || ts < existing.firstTs)) {
        existing.firstTs = ts;
        existing.firstTraceId = r.id;
      }
    }
    return Array.from(bySession.values())
      .sort((a, b) => b.lastTs.localeCompare(a.lastTs))
      .slice(0, 8);
  });

  function sessionSpanMs(s: SessionEntry): number {
    if (!s.firstTs || !s.lastTs) return 0;
    return new Date(s.lastTs).getTime() - new Date(s.firstTs).getTime();
  }

  function fmtSpan(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60_000).toFixed(1)}m`;
  }

  function handleRowClick(id: string) {
    onSelectTrace?.(id);
    if (typeof window !== 'undefined') {
      window.location.hash = `#/traces/${id}`;
    }
  }

  // ---------- internal/healthz derivations ----------

  const healthzCards = $derived.by(() => {
    if (!healthz) return [];
    const h = healthz;
    const c = (h.counters || {}) as HealthzCounters;
    const drops =
      ((c.drop_writer_full ?? 0) | 0) +
      ((c.drop_jsonl_fail ?? 0) | 0) +
      ((c.drop_sqlite_fail ?? 0) | 0);
    const trunc =
      ((c.truncated_req_total ?? 0) | 0) +
      ((c.truncated_resp_total ?? 0) | 0);
    return [
      {
        label: 'uptime',
        value: Math.floor(h.uptime_seconds / 60) + 'm',
        sub:
          new Date(Date.now() - h.uptime_seconds * 1000)
            .toISOString()
            .slice(0, 19) + 'Z',
        kind: null as null | 'bad' | 'warn',
      },
      {
        label: 'appended',
        value: String(c.appended ?? 0),
        sub: `2xx ${(c.appended_2xx ?? 0) | 0} · 4xx ${(c.appended_4xx ?? 0) | 0} · 5xx ${(c.appended_5xx ?? 0) | 0}`,
        kind: null,
      },
      {
        label: 'indexed',
        value: String(c.indexed ?? 0),
        sub: `lag ${(c.appended ?? 0) - (c.indexed ?? 0)}`,
        kind: null,
      },
      {
        label: 'drops',
        value: String(drops),
        sub: `writer ${(c.drop_writer_full ?? 0) | 0} · jsonl ${(c.drop_jsonl_fail ?? 0) | 0} · sqlite ${(c.drop_sqlite_fail ?? 0) | 0}`,
        kind: drops > 0 ? 'bad' : null,
      },
      {
        label: 'truncated',
        value: String(trunc),
        sub: `req ${(c.truncated_req_total ?? 0) | 0} · resp ${(c.truncated_resp_total ?? 0) | 0}`,
        kind: trunc > 0 ? 'warn' : null,
      },
      {
        label: 'writer chan',
        value: String(c.writer_chan_high_water ?? 0),
        sub: 'high-water / 1024',
        kind: null,
      },
      {
        label: 'slow traces',
        value: String((c.slow_traces ?? 0) | 0),
        sub: '> 30s end-to-end',
        kind: ((c.slow_traces ?? 0) | 0) > 0 ? 'warn' : null,
      },
      {
        label: 'upstream dial err',
        value: String((c.upstream_dial_err ?? 0) | 0),
        sub: 'dns / tls / refused',
        kind: ((c.upstream_dial_err ?? 0) | 0) > 0 ? 'bad' : null,
      },
    ];
  });

  const TIMING_KEYS = ['drain_ms', 'parse_ms', 'sqlite_ms'] as const;

  const healthzTimings = $derived.by(() => {
    if (!healthz) return [];
    const t = healthz.counters?.timings || {};
    return TIMING_KEYS.map((k) => {
      const v: TimingBucket = t[k] || {};
      return {
        key: k,
        label: k.replace('_ms', ''),
        p50: v.p50_ms ?? 0,
        p95: v.p95_ms ?? 0,
        p99: v.p99_ms ?? 0,
        count: v.count ?? 0,
        mean: (v.mean_ms ?? 0).toFixed(2),
      };
    });
  });
</script>

<div class="dashboard">
  {#if rowsLoadError}
    <div class="err-banner">list fetch failed: {rowsLoadError}</div>
  {/if}

  <!-- ---------- KPI grid (tier 1: row metadata) ---------- -->
  <section class="kpis">
    <div class="kpi">
      <div class="kpi-label">traces</div>
      <div class="kpi-value">{total}</div>
      <div class="kpi-sub">last 200</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">top protocol</div>
      <div class="kpi-value">{topProtocol.value ?? '—'}</div>
      <div class="kpi-sub">{topProtocol.count} traces</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">top model</div>
      <div class="kpi-value">{topModel.value ?? '—'}</div>
      <div class="kpi-sub">{topModel.count} traces</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">top client</div>
      <div class="kpi-value">{topClient.value ?? '—'}</div>
      <div class="kpi-sub">{topClient.count} traces</div>
    </div>
    <div class="kpi" class:bad={errorRate.pct >= 10}>
      <div class="kpi-label">errors</div>
      <div class="kpi-value">{errorRate.pct.toFixed(1)}%</div>
      <div class="kpi-sub">{errorRate.errs} / {total} non-2xx</div>
    </div>
    <div class="kpi" class:warn={slowCount > 0}>
      <div class="kpi-label">slow traces</div>
      <div class="kpi-value">{slowCount}</div>
      <div class="kpi-sub">&gt; 30s end-to-end</div>
    </div>
  </section>

  <!-- ---------- block-type distribution + top tools (tier 2: detail sample) ---------- -->
  <section class="charts">
    <div class="chart">
      <div class="chart-head">
        <h3 class="group-title">block types</h3>
        <span class="sample-tag">recent {detailSampleCount}</span>
      </div>
      {#if blockBars.length === 0}
        <div class="empty">no blocks parsed yet</div>
      {:else}
        <div class="bars">
          {#each blockBars as bar (bar.type)}
            <div class="bar-row">
              <span class="bar-label">{bar.type}</span>
              <div class="bar-track">
                <div class="bar-fill" style="width: {bar.pct}%"></div>
              </div>
              <span class="bar-count">{bar.count}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <div class="chart">
      <div class="chart-head">
        <h3 class="group-title">top tools</h3>
        <span class="sample-tag">recent {detailSampleCount}</span>
      </div>
      {#if topTools.length === 0}
        <div class="empty">no tool_call blocks</div>
      {:else}
        <div class="bars">
          {#each topTools as tool (tool.name)}
            <div class="bar-row">
              <span class="bar-label">{tool.name}</span>
              <div class="bar-track">
                <div class="bar-fill" style="width: {tool.pct}%"></div>
              </div>
              <span class="bar-count">{tool.count}</span>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  </section>

  <!-- ---------- top active sessions ---------- -->
  <section class="sessions">
    <div class="chart-head">
      <h3 class="group-title">top sessions</h3>
      <span class="sample-tag">recent {rows.length}</span>
    </div>
    {#if topSessions.length === 0}
      <div class="empty">no sessions in this window</div>
    {:else}
      <div class="session-table">
        {#each topSessions as s (s.sessionRootId)}
          <button type="button" class="session-row" onclick={() => handleRowClick(s.lastTraceId)}>
            <span class="s-id mono">{shortId(s.sessionRootId)}</span>
            <span class="s-turns mono">{s.turns} turns</span>
            <span class="s-span mono">{fmtSpan(sessionSpanMs(s))}</span>
            <span class="s-path mono">{s.lastPath}</span>
            <span class="s-status mono {statusClass(s.lastStatus)}">{s.lastStatus ?? '—'}</span>
            <span class="s-last mono">{shortTs(s.lastTs)}</span>
          </button>
        {/each}
      </div>
    {/if}
  </section>

  <!-- ---------- recent activity tape ---------- -->
  <section class="activity">
    <h3 class="group-title">recent activity</h3>
    {#if recentRows.length === 0}
      <div class="empty">no traces</div>
    {:else}
      <div class="tape">
        {#each recentRows as r (r.id)}
          <button
            type="button"
            class="tape-row"
            onclick={() => handleRowClick(r.id)}
          >
            <span class="t-ts">{shortTs(r.ts_start ?? null)}</span>
            <span class="t-status {statusClass(r.status ?? null)}">{r.status ?? '—'}</span>
            <span class="t-path">{r.path ?? ''}</span>
            <span class="t-model">{r.model ?? ''}</span>
            <span class="t-id">{shortId(r.id)}</span>
          </button>
        {/each}
      </div>
    {/if}
  </section>

  <!-- ---------- internal (absorbed from HealthzView; smaller / dimmer) ---------- -->
  <section class="internal">
    <div class="internal-head">
      <h3 class="group-title">internal · healthz</h3>
      {#if healthzLoadError}
        <span class="err-tag">{healthzLoadError}</span>
      {/if}
    </div>
    <div class="internal-cards">
      {#each healthzCards as card (card.label)}
        <div
          class="hcard"
          class:bad={card.kind === 'bad'}
          class:warn={card.kind === 'warn'}
        >
          <div class="hcard-label">{card.label}</div>
          <div class="hcard-value">{card.value}</div>
          <div class="hcard-sub">{card.sub}</div>
        </div>
      {/each}
    </div>

    <h4 class="group-title sub">per-trace timings (ms)</h4>
    <div class="internal-cards">
      {#each healthzTimings as t (t.key)}
        <div class="hcard">
          <div class="hcard-label">{t.label}</div>
          <div class="hcard-value">{t.p50} <span class="p50-tag">p50</span></div>
          <div class="hcard-sub">
            p95 {t.p95} · p99 {t.p99} · n {t.count} · mean {t.mean}
          </div>
        </div>
      {/each}
    </div>
  </section>
</div>

<style>
  .dashboard {
    flex: 1;
    overflow: auto;
    padding: 20px 24px 32px;
    display: flex;
    flex-direction: column;
    gap: 24px;
    min-height: 0;
  }

  .err-banner {
    padding: 8px 12px;
    border: 1px solid var(--err);
    border-radius: var(--radius);
    color: var(--err);
    font-family: var(--mono);
    font-size: 12px;
  }

  /* ---------- KPI grid ---------- */
  .kpis {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 1px;
    background: var(--border);
    border: 1px solid var(--border);
  }
  .kpi {
    background: var(--bg-elev);
    padding: 14px 16px;
  }
  .kpi-label {
    color: var(--fg-muted);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .kpi-value {
    font-family: var(--mono);
    font-size: 22px;
    font-weight: 500;
    margin-top: 4px;
    color: var(--fg);
    overflow-wrap: anywhere;
  }
  .kpi-sub {
    color: var(--fg-dim);
    font-size: 11px;
    font-family: var(--mono);
    margin-top: 4px;
  }
  .kpi.bad .kpi-value { color: var(--err); }
  .kpi.warn .kpi-value { color: var(--warn); }

  /* ---------- charts row ---------- */
  .charts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  @media (max-width: 900px) {
    .charts { grid-template-columns: 1fr; }
  }

  .chart {
    border: 1px solid var(--border);
    background: var(--bg-elev);
    padding: 14px 16px;
  }
  .chart-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .group-title {
    font-size: 10px;
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0;
  }
  .sample-tag {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--fg-dim);
  }
  .empty {
    color: var(--fg-dim);
    font-family: var(--mono);
    font-size: 11px;
    padding: 8px 0;
  }
  .bars {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .bar-row {
    display: grid;
    grid-template-columns: 110px 1fr 40px;
    align-items: center;
    gap: 10px;
    font-family: var(--mono);
    font-size: 11px;
  }
  .bar-label {
    color: var(--fg-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bar-track {
    height: 8px;
    background: var(--bg);
    border-radius: 2px;
    overflow: hidden;
  }
  .bar-fill {
    height: 100%;
    background: var(--accent);
    opacity: 0.55;
  }
  .bar-count {
    color: var(--fg-dim);
    text-align: right;
  }

  /* ---------- activity tape ---------- */
  .activity, .sessions {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .session-table {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    background: var(--bg-elev);
  }
  .session-row {
    display: grid;
    grid-template-columns: 90px 80px 80px 1fr 50px 110px;
    align-items: center;
    gap: 12px;
    padding: 6px 12px;
    border: none;
    border-bottom: 1px solid var(--border);
    background: transparent;
    color: var(--fg);
    font-size: 11px;
    text-align: left;
    cursor: pointer;
  }
  .session-row:last-child { border-bottom: none; }
  .session-row:hover { background: var(--bg-elev-2); }
  .s-id     { color: var(--accent); }
  .s-turns  { color: var(--fg); }
  .s-span   { color: var(--fg-muted); }
  .s-path   { color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .s-status { font-weight: 600; }
  .s-last   { color: var(--fg-muted); text-align: right; }

  .tape {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border);
    background: var(--bg-elev);
  }
  .tape-row {
    display: grid;
    grid-template-columns: 90px 50px 1fr 160px 70px;
    align-items: center;
    gap: 12px;
    padding: 6px 12px;
    border: none;
    border-bottom: 1px solid var(--border);
    background: transparent;
    color: var(--fg);
    font-family: var(--mono);
    font-size: 11px;
    text-align: left;
    cursor: pointer;
  }
  .tape-row:last-child { border-bottom: none; }
  .tape-row:hover { background: var(--bg-elev-2); }
  .t-ts { color: var(--fg-muted); }
  .t-status { font-weight: 600; }
  .t-path { color: var(--fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .t-model { color: var(--fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .t-id { color: var(--fg-dim); text-align: right; }
  .st-2 { color: var(--ok); }
  .st-4 { color: var(--warn); }
  .st-5 { color: var(--err); }
  .st-x { color: var(--fg-muted); }

  /* ---------- internal section (absorbed healthz) ---------- */
  .internal {
    opacity: 0.78;
    font-size: 11px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 8px;
  }
  .internal-head {
    display: flex;
    align-items: baseline;
    gap: 12px;
  }
  .err-tag {
    color: var(--err);
    font-family: var(--mono);
    font-size: 10px;
  }
  .group-title.sub {
    margin-top: 6px;
  }
  .internal-cards {
    display: grid;
    gap: 1px;
    grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
    background: var(--border);
    border: 1px solid var(--border);
  }
  .hcard {
    background: var(--bg-elev);
    padding: 10px 12px;
  }
  .hcard-label {
    color: var(--fg-muted);
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .hcard-value {
    font-family: var(--mono);
    font-size: 16px;
    font-weight: 500;
    margin-top: 3px;
    color: var(--fg);
  }
  .hcard-sub {
    color: var(--fg-dim);
    font-size: 10px;
    font-family: var(--mono);
    margin-top: 3px;
  }
  .hcard.bad .hcard-value { color: var(--err); }
  .hcard.warn .hcard-value { color: var(--warn); }
  .p50-tag {
    color: var(--fg-muted);
    font-size: 10px;
    font-weight: 400;
  }
</style>
