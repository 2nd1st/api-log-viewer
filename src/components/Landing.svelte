<script lang="ts">
  // Landing — default home view (#/, #/landing, #/dashboard alias).
  //
  // Operator-triage layout, not analytics. Sections in render order:
  //
  //   STATUS             — six metric cells: PROXY :7861, API :7862,
  //                        UPTIME, TRACES (healthz.appended), DATA bytes,
  //                        LAST WRITE (newest row age from sample)
  //   CAPABILITY         — protocol chips lit/dim; lit when at least
  //                        one trace in the last hour used that protocol.
  //                        Lit = bright --fg, dim = --fg-dim. No accent
  //                        on status/presence signals.
  //   NEEDS ATTENTION    — rows in the last 30 min where
  //                        status≥400 OR dur>30s OR truncated
  //   ACTIVE CLIENTS     — top 5 client_kind groups from the 200-row
  //                        sample: kind | version (most recent) | count
  //   TOKEN USAGE        — sums over the 200-row sample: PROMPT,
  //                        COMPLETION, CACHE READ (with hit-rate),
  //                        CACHE CREATION
  //   VOLUME             — traces/min bar sparkline over last 60 min
  //                        from the same sample. --accent fills bars.
  //   INTERNAL · healthz — collapsible (default closed). Caret takes
  //                        --accent only when open. Auto-opens on the
  //                        rising edge of drops/dial-err/etc.
  //
  // Fetch shape: /api/traces?limit=200 + /healthz every 10s. The slow
  // ?since=monday week-count is gone — Phase L explicitly drops it.
  // A 1s now-ticker drives relative-time labels independently of polls.

  import { detectProtocol, type Protocol } from '../lib/adapters';
  import { humanBytes, fmtMs, statusClass } from '../lib/format';

  // ---------- row shape (subset of /api/traces row) ----------

  interface ListRow {
    id: string;
    ts_start?: string | null;
    ts_end?: string | null;
    status?: number | null;
    path?: string | null;
    model?: string | null;
    client?: string | null;
    client_kind?: string | null;
    client_version?: string | null;
    key_hash?: string | null;
    prompt_tokens?: number | null;
    completion_tokens?: number | null;
    cached_tokens?: number | null;
    cache_creation_tokens?: number | null;
    truncated_req?: boolean;
    truncated_resp?: boolean;
    [k: string]: unknown;
  }

  interface Props {
    authFetch: (path: string, opts?: RequestInit) => Promise<Response>;
  }

  const { authFetch }: Props = $props();

  // ---------- now ticker (1s) ----------

  let now = $state(Date.now());

  $effect(() => {
    const t = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(t);
  });

  // ---------- list state ----------

  let rows = $state<ListRow[]>([]);
  let rowsLoadError = $state<string>('');
  let lastPollAt = $state<number>(0);

  async function loadList() {
    try {
      const r = await authFetch('api/traces?limit=200');
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      rows = (j.traces || []) as ListRow[];
      rowsLoadError = '';
      lastPollAt = Date.now();
    } catch (e: any) {
      rowsLoadError = e?.message || String(e);
    }
  }

  // ---------- healthz state ----------

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
    total_bytes?: number;
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

  // ---------- 10s polling ----------

  $effect(() => {
    loadList();
    loadHealthz();
    const t = setInterval(() => {
      loadList();
      loadHealthz();
    }, 10_000);
    return () => clearInterval(t);
  });

  // ---------- STATUS derivations ----------

  const stalled = $derived(
    lastPollAt > 0 && now - lastPollAt > 30_000,
  );

  const uptimeLabel = $derived.by(() => {
    const s = healthz?.uptime_seconds;
    if (s == null) return '—';
    if (s < 60) return `${Math.floor(s)}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86_400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86_400)}d`;
  });

  const dataDirLabel = $derived.by(() => {
    const b = healthz?.counters?.total_bytes;
    if (b == null) return '—';
    return humanBytes(b);
  });

  const tracesTotalLabel = $derived.by(() => {
    const n = healthz?.counters?.appended;
    if (n == null) return '—';
    return n.toLocaleString();
  });

  // Newest ts_start in the sample → relative-age label. Falls back to
  // last poll time on cold start so the cell isn't blank.
  const lastWriteLabel = $derived.by(() => {
    let newest = 0;
    for (const r of rows) {
      if (!r.ts_start) continue;
      const t = new Date(r.ts_start).getTime();
      if (Number.isFinite(t) && t > newest) newest = t;
    }
    if (newest === 0) return '—';
    const ageSec = Math.max(0, Math.floor((now - newest) / 1000));
    if (ageSec < 60) return `${ageSec}s ago`;
    if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
    if (ageSec < 86_400) return `${Math.floor(ageSec / 3600)}h ago`;
    return `${Math.floor(ageSec / 86_400)}d ago`;
  });

  // ---------- CAPABILITY strip ----------

  const PROTOCOL_CHIPS: ReadonlyArray<{ label: string; key: Protocol }> = [
    { label: 'chat', key: 'openai_chat' },
    { label: 'messages', key: 'anthropic_messages' },
    { label: 'responses', key: 'openai_responses' },
    { label: 'gemini', key: 'google_gemini' },
  ];

  const recentProtocolHits = $derived.by(() => {
    const cutoff = now - 60 * 60 * 1000;
    const seen = new Set<Protocol>();
    for (const r of rows) {
      if (!r.ts_start) continue;
      const t = new Date(r.ts_start).getTime();
      if (Number.isNaN(t) || t < cutoff) continue;
      seen.add(detectProtocol(r.path));
    }
    return seen;
  });

  // ---------- NEEDS ATTENTION ----------
  //
  // Last 30 min, status≥400 OR slow (>30s) OR truncated. Empty state is
  // rendered (not hidden) — "yes I checked, nothing is on fire" is the
  // load-bearing value for an operator.

  const ATTENTION_WINDOW_MS = 30 * 60 * 1000;
  const ATTENTION_LIMIT = 10;
  const SLOW_MS = 30_000;

  type Incident = ListRow & {
    _ageLabel: string;
    _durMs: number | null;
    _reasons: string[];
  };

  const incidents = $derived.by<Incident[]>(() => {
    const cutoff = now - ATTENTION_WINDOW_MS;
    const out: Incident[] = [];
    for (const r of rows) {
      if (!r.ts_start) continue;
      const t = new Date(r.ts_start).getTime();
      if (Number.isNaN(t) || t < cutoff) continue;
      const status = r.status ?? 0;
      let durMs: number | null = null;
      if (r.ts_start && r.ts_end) {
        const d = new Date(r.ts_end).getTime() - t;
        if (Number.isFinite(d)) durMs = d;
      }
      const reasons: string[] = [];
      if (status >= 500) reasons.push('5xx');
      else if (status >= 400) reasons.push('4xx');
      if (durMs != null && durMs > SLOW_MS) reasons.push('slow');
      if (r.truncated_req || r.truncated_resp) reasons.push('truncated');
      if (reasons.length === 0) continue;

      const ageSec = Math.max(0, Math.floor((now - t) / 1000));
      let ageLabel: string;
      if (ageSec < 60) ageLabel = `${ageSec}s ago`;
      else if (ageSec < 3600) ageLabel = `${Math.floor(ageSec / 60)}m ago`;
      else ageLabel = `${Math.floor(ageSec / 3600)}h ago`;

      out.push({
        ...r,
        _ageLabel: ageLabel,
        _durMs: durMs,
        _reasons: reasons,
      });
      if (out.length >= ATTENTION_LIMIT) break;
    }
    return out;
  });

  function jumpToTrace(id: string) {
    window.location.hash = `#/traces/${id}`;
  }

  function shortKey(k: string | null | undefined): string {
    if (!k) return '—';
    return k.slice(0, 8);
  }

  // ---------- ACTIVE CLIENTS ----------
  //
  // Group the 200-row sample by client_kind. Version comes from the most
  // recent row in the group (rows arrive newest-first from the API). Top
  // 5 by count; if fewer kinds present, render what's there.

  const ACTIVE_CLIENTS_LIMIT = 5;

  interface ClientAgg {
    kind: string;
    version: string;
    count: number;
  }

  const activeClients = $derived.by<ClientAgg[]>(() => {
    const m = new Map<string, ClientAgg>();
    for (const r of rows) {
      const kind = (r.client_kind ?? '').trim() || 'unknown';
      const existing = m.get(kind);
      if (existing) {
        existing.count++;
      } else {
        m.set(kind, {
          kind,
          // Rows arrive newest→oldest, so the first row we see for a
          // kind carries the most recent version string.
          version: (r.client_version ?? '').trim() || '—',
          count: 1,
        });
      }
    }
    return Array.from(m.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, ACTIVE_CLIENTS_LIMIT);
  });

  // ---------- TOKEN USAGE ----------
  //
  // Four sums over the 200-row sample. Cache hit-rate = cached_tokens
  // sum / prompt_tokens sum, rendered alongside the CACHE READ value
  // in muted mono — no status color (it's a ratio, not a signal).

  const tokenTotals = $derived.by(() => {
    let prompt = 0;
    let completion = 0;
    let cached = 0;
    let cacheCreate = 0;
    for (const r of rows) {
      prompt += Number(r.prompt_tokens ?? 0) || 0;
      completion += Number(r.completion_tokens ?? 0) || 0;
      cached += Number(r.cached_tokens ?? 0) || 0;
      cacheCreate += Number(r.cache_creation_tokens ?? 0) || 0;
    }
    const hitRate = prompt > 0 ? cached / prompt : 0;
    return { prompt, completion, cached, cacheCreate, hitRate };
  });

  function fmtTokenCount(n: number): string {
    if (n === 0) return '0';
    if (n < 1000) return String(n);
    if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
    return `${(n / 1_000_000).toFixed(n < 10_000_000 ? 2 : 1)}M`;
  }

  // ---------- VOLUME sparkline ----------

  const SPARK_BUCKETS = 60;
  const SPARK_BUCKET_MS = 60_000;
  const SPARK_HEIGHT = 64;
  const SPARK_WIDTH = 600; // viewBox; CSS scales to container

  const sparkData = $derived.by(() => {
    const buckets = new Array<number>(SPARK_BUCKETS).fill(0);
    const windowMs = SPARK_BUCKETS * SPARK_BUCKET_MS;
    const cutoff = now - windowMs;
    for (const r of rows) {
      if (!r.ts_start) continue;
      const t = new Date(r.ts_start).getTime();
      if (Number.isNaN(t) || t < cutoff || t > now) continue;
      const ageMs = now - t;
      const fromEnd = Math.floor(ageMs / SPARK_BUCKET_MS);
      const idx = SPARK_BUCKETS - 1 - fromEnd;
      if (idx >= 0 && idx < SPARK_BUCKETS) buckets[idx]++;
    }
    const max = buckets.reduce((m, v) => Math.max(m, v), 0);
    const barW = SPARK_WIDTH / SPARK_BUCKETS;
    const innerH = SPARK_HEIGHT - 4;
    const bars = buckets.map((count, i) => {
      const h = max === 0 ? 0 : (count / max) * innerH;
      return {
        x: i * barW,
        y: SPARK_HEIGHT - h,
        w: Math.max(0, barW - 1),
        h,
        count,
      };
    });
    const total = buckets.reduce((s, v) => s + v, 0);
    return { bars, max, total };
  });

  // ---------- INTERNAL · healthz ----------

  let internalOpen = $state(false);
  let prevHasAlert = false;

  interface HCard {
    label: string;
    value: string;
    sub: string;
    kind: null | 'bad' | 'warn';
  }

  const healthzCards = $derived.by<HCard[]>(() => {
    if (!healthz) return [];
    const c = (healthz.counters || {}) as HealthzCounters;
    const drops =
      ((c.drop_writer_full ?? 0) | 0) +
      ((c.drop_jsonl_fail ?? 0) | 0) +
      ((c.drop_sqlite_fail ?? 0) | 0);
    const trunc =
      ((c.truncated_req_total ?? 0) | 0) +
      ((c.truncated_resp_total ?? 0) | 0);
    return [
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

  const hasAlert = $derived(
    healthzCards.some((c) => c.kind === 'bad' || c.kind === 'warn'),
  );

  // Force-open on rising edge (clean → alert) so the operator notices
  // even with the section collapsed.
  $effect(() => {
    const cur = hasAlert;
    if (cur && !prevHasAlert) internalOpen = true;
    prevHasAlert = cur;
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

<div class="landing">
  {#if rowsLoadError}
    <div class="err-banner">list fetch failed: {rowsLoadError}</div>
  {/if}

  <!-- ---------- STATUS ---------- -->
  <section class="block status-block">
    <div class="section-head">
      <h3 class="group-title">status</h3>
      <span class="sample-tag" class:stalled>
        {#if stalled}stalled · last poll &gt; 30s{:else}live · last poll OK{/if}
      </span>
    </div>
    <div class="metric-row">
      <div class="metric">
        <div class="m-label">proxy</div>
        <div class="m-value">:7861</div>
      </div>
      <div class="metric">
        <div class="m-label">api</div>
        <div class="m-value">:7862</div>
      </div>
      <div class="metric">
        <div class="m-label">uptime</div>
        <div class="m-value">{uptimeLabel}</div>
      </div>
      <div class="metric">
        <div class="m-label">traces</div>
        <div class="m-value">{tracesTotalLabel}</div>
      </div>
      <div class="metric">
        <div class="m-label">data</div>
        <div class="m-value">{dataDirLabel}</div>
      </div>
      <div class="metric">
        <div class="m-label">last write</div>
        <div class="m-value">{lastWriteLabel}</div>
      </div>
    </div>
  </section>

  <!-- ---------- CAPABILITY ---------- -->
  <section class="block">
    <div class="section-head">
      <h3 class="group-title">capability</h3>
      <span class="sample-tag">recognized · last hour</span>
    </div>
    <div class="chip-row">
      {#each PROTOCOL_CHIPS as chip (chip.key)}
        <span
          class="chip"
          class:lit={recentProtocolHits.has(chip.key)}
          title={recentProtocolHits.has(chip.key)
            ? 'seen in the last hour'
            : 'no traces in the last hour'}>{chip.label}</span
        >
      {/each}
    </div>
  </section>

  <!-- ---------- NEEDS ATTENTION ---------- -->
  <section class="block">
    <div class="section-head">
      <h3 class="group-title">needs attention</h3>
      <span class="sample-tag">last 30 min · top {ATTENTION_LIMIT}</span>
    </div>
    {#if incidents.length === 0}
      <div class="empty">No incidents in the last 30 minutes.</div>
    {:else}
      <ul class="incidents" role="list">
        {#each incidents as inc (inc.id)}
          <li class="incident">
            <button
              type="button"
              class="incident-row"
              onclick={() => jumpToTrace(inc.id)}
            >
              <span class="i-age">{inc._ageLabel}</span>
              <span class="i-status {statusClass(inc.status)}"
                >{inc.status ?? '—'}</span
              >
              <span class="i-path" title={inc.path ?? ''}
                >{inc.path ?? '—'}</span
              >
              <span class="i-model">{inc.model ?? '—'}</span>
              <span class="i-dur">{fmtMs(inc._durMs)}</span>
              <span class="i-key">{shortKey(inc.key_hash)}</span>
              <span class="i-reasons">
                {#each inc._reasons as r (r)}
                  <span
                    class="reason"
                    class:r-err={r === '5xx'}
                    class:r-warn={r === '4xx' || r === 'slow' || r === 'truncated'}
                    >{r}</span
                  >
                {/each}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- ---------- ACTIVE CLIENTS ---------- -->
  <section class="block">
    <div class="section-head">
      <h3 class="group-title">active clients</h3>
      <span class="sample-tag">recent 200 requests · top {ACTIVE_CLIENTS_LIMIT}</span>
    </div>
    {#if activeClients.length === 0}
      <div class="empty">No client_kind in the recent 200 requests.</div>
    {:else}
      <table class="mono-table clients-table">
        <thead>
          <tr>
            <th class="col-kind">kind</th>
            <th class="col-version">version</th>
            <th class="col-count">trace count</th>
          </tr>
        </thead>
        <tbody>
          {#each activeClients as c (c.kind)}
            <tr>
              <td class="col-kind">{c.kind}</td>
              <td class="col-version">{c.version}</td>
              <td class="col-count">{c.count}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    {/if}
  </section>

  <!-- ---------- TOKEN USAGE ---------- -->
  <section class="block">
    <div class="section-head">
      <h3 class="group-title">token usage</h3>
      <span class="sample-tag">recent 200 requests · sums</span>
    </div>
    <div class="metric-row">
      <div class="metric">
        <div class="m-label">prompt</div>
        <div class="m-value">{fmtTokenCount(tokenTotals.prompt)}</div>
      </div>
      <div class="metric">
        <div class="m-label">completion</div>
        <div class="m-value">{fmtTokenCount(tokenTotals.completion)}</div>
      </div>
      <div class="metric">
        <div class="m-label">cache read</div>
        <div class="m-value">
          {fmtTokenCount(tokenTotals.cached)}
          <span class="m-sub"
            >hit {(tokenTotals.hitRate * 100).toFixed(tokenTotals.hitRate >= 0.1 ? 0 : 1)}%</span
          >
        </div>
      </div>
      <div class="metric">
        <div class="m-label">cache creation</div>
        <div class="m-value">{fmtTokenCount(tokenTotals.cacheCreate)}</div>
      </div>
    </div>
  </section>

  <!-- ---------- VOLUME sparkline ---------- -->
  <section class="block">
    <div class="section-head">
      <h3 class="group-title">volume</h3>
      <span class="sample-tag"
        >traces/min · {sparkData.total} in window · peak {sparkData.max}</span
      >
    </div>
    <div class="spark-wrap">
      <svg
        class="spark"
        viewBox="0 0 {SPARK_WIDTH} {SPARK_HEIGHT}"
        preserveAspectRatio="none"
        role="img"
        aria-label="traces per minute over the last 60 minutes"
      >
        {#each sparkData.bars as bar, i (i)}
          {#if bar.h > 0}
            <rect
              x={bar.x}
              y={bar.y}
              width={bar.w}
              height={bar.h}
              class="spark-bar"
            >
              <title>{bar.count} trace{bar.count === 1 ? '' : 's'}</title>
            </rect>
          {/if}
        {/each}
      </svg>
      <div class="spark-axis">
        <span>60 min</span>
        <span>now</span>
      </div>
    </div>
  </section>

  <!-- ---------- INTERNAL · healthz (collapsible) ---------- -->
  <section class="block internal" class:open={internalOpen}>
    <button
      type="button"
      class="internal-toggle"
      aria-expanded={internalOpen}
      onclick={() => (internalOpen = !internalOpen)}
    >
      <span class="caret" class:active={internalOpen}
        >{internalOpen ? '▾' : '▸'}</span
      >
      <span class="group-title">internal · healthz</span>
      {#if hasAlert}
        <span class="alert-tag">attention</span>
      {/if}
      {#if healthzLoadError}
        <span class="err-tag">{healthzLoadError}</span>
      {/if}
    </button>

    {#if internalOpen}
      <div class="internal-body">
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
              <div class="hcard-value">
                {t.p50} <span class="p50-tag">p50</span>
              </div>
              <div class="hcard-sub">
                p95 {t.p95} · p99 {t.p99} · n {t.count} · mean {t.mean}
              </div>
            </div>
          {/each}
        </div>
      </div>
    {/if}
  </section>
</div>

<style>
  .landing {
    flex: 1;
    overflow: auto;
    padding: 20px 24px 32px;
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
    min-height: 0;
  }

  .err-banner {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--err);
    color: var(--err);
    font-family: var(--font-mono);
    font-size: var(--size-meta);
  }

  /* ---------- block frame (hairline border, no card chrome) ---------- */
  .block {
    border: 1px solid var(--border);
    background: var(--surface);
    padding: var(--space-3) var(--space-4);
  }

  .section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: var(--space-3);
  }
  .group-title {
    font-size: var(--size-label);
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0;
  }
  .sample-tag {
    font-family: var(--font-mono);
    font-size: var(--size-label);
    color: var(--fg-dim);
  }
  .sample-tag.stalled {
    color: var(--err);
  }
  .empty {
    color: var(--fg-dim);
    font-family: var(--font-mono);
    font-size: var(--size-meta);
    padding: var(--space-2) 0;
  }

  /* ---------- metric row (STATUS + TOKEN USAGE) ---------- */
  .metric-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(132px, 1fr));
    gap: var(--space-4);
  }
  .metric {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .m-label {
    font-size: var(--size-label);
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .m-value {
    font-family: var(--font-mono);
    font-size: var(--size-meta);
    color: var(--fg);
    display: flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .m-sub {
    color: var(--fg-dim);
    font-size: var(--size-label);
  }

  /* ---------- CAPABILITY chips ----------
   *
   * Per Phase L principle 4, accent must not carry status/presence
   * semantics. "Lit" here signals "has traffic in the last hour" —
   * that's a presence signal, not selection — so lit chips read in
   * bright --fg, dim chips in --fg-dim. Hairline border in both
   * states; no fills.
   */
  .chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .chip {
    padding: 2px 8px;
    border: 1px solid var(--border);
    color: var(--fg-dim);
    background: transparent;
    font-family: var(--font-mono);
    font-size: var(--size-meta);
  }
  .chip.lit {
    color: var(--fg);
    border-color: var(--border-strong);
  }

  /* ---------- NEEDS ATTENTION ---------- */
  .incidents {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
  }
  .incident + .incident {
    border-top: 1px solid var(--border);
  }
  .incident-row {
    display: grid;
    grid-template-columns: 80px 56px 1fr 160px 64px 80px auto;
    gap: var(--space-3);
    align-items: center;
    width: 100%;
    padding: var(--space-2) 0;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    border-radius: 0;
    text-align: left;
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: var(--size-meta);
    color: var(--fg);
  }
  .incident-row:hover {
    border-left-color: var(--border-strong);
    background: var(--surface-elevated);
  }
  .i-age {
    color: var(--fg-dim);
  }
  .i-status {
    text-align: right;
    color: var(--fg-muted);
  }
  .i-status.st-4 {
    color: var(--warn);
  }
  .i-status.st-5 {
    color: var(--err);
  }
  .i-status.st-2 {
    color: var(--ok);
  }
  .i-path {
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .i-model {
    color: var(--fg-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .i-dur {
    color: var(--fg-muted);
    text-align: right;
  }
  .i-key {
    color: var(--fg-dim);
  }
  .i-reasons {
    display: inline-flex;
    gap: var(--space-1);
    flex-wrap: nowrap;
  }
  .reason {
    padding: 1px 6px;
    border: 1px solid var(--border);
    font-size: var(--size-label);
    color: var(--fg-muted);
    line-height: 1.4;
  }
  .reason.r-warn {
    color: var(--warn);
    border-color: var(--warn);
  }
  .reason.r-err {
    color: var(--err);
    border-color: var(--err);
  }

  /* ---------- ACTIVE CLIENTS table ---------- */
  .mono-table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--font-mono);
    font-size: var(--size-meta);
  }
  .mono-table th,
  .mono-table td {
    padding: var(--space-2) var(--space-3);
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  .mono-table thead th {
    font-size: var(--size-label);
    font-weight: 400;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--fg-muted);
    border-bottom-color: var(--border-strong);
  }
  .mono-table tbody tr:last-child td {
    border-bottom: none;
  }
  .clients-table .col-kind {
    color: var(--fg);
  }
  .clients-table .col-version {
    color: var(--fg-muted);
  }
  .clients-table .col-count {
    text-align: right;
    color: var(--fg);
    width: 100px;
  }
  .clients-table th.col-count {
    text-align: right;
  }

  /* ---------- VOLUME sparkline ----------
   *
   * Bars (preserved from Phase H, per principle 6 "no new sparklines").
   * --accent fills the bars — this is one of the two places in Landing
   * where accent is allowed.
   */
  .spark-wrap {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .spark {
    width: 100%;
    height: 64px;
    display: block;
  }
  .spark-bar {
    fill: var(--accent);
    opacity: 0.7;
  }
  .spark-axis {
    display: flex;
    justify-content: space-between;
    font-family: var(--font-mono);
    font-size: var(--size-label);
    color: var(--fg-dim);
  }

  /* ---------- INTERNAL ----------
   *
   * Caret takes --accent ONLY when the section is open (the second
   * allowed accent in Landing). Closed caret stays dim.
   */
  .internal {
    padding: 0;
  }
  .internal-toggle {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2) var(--space-4);
    background: transparent;
    border: none;
    border-radius: 0;
    text-align: left;
    cursor: pointer;
    color: var(--fg-muted);
    font-family: var(--font-mono);
    font-size: var(--size-meta);
  }
  .internal-toggle:hover {
    color: var(--fg);
  }
  .caret {
    color: var(--fg-dim);
    width: 12px;
    display: inline-block;
  }
  .caret.active {
    color: var(--accent);
  }
  .alert-tag {
    color: var(--warn);
    font-size: var(--size-label);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .err-tag {
    color: var(--err);
    font-family: var(--font-mono);
    font-size: var(--size-label);
  }
  .internal-body {
    padding: 0 var(--space-4) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .group-title.sub {
    margin-top: var(--space-2);
  }
  .internal-cards {
    display: grid;
    gap: 1px;
    grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
    background: var(--border);
    border: 1px solid var(--border);
  }
  .hcard {
    background: var(--surface);
    padding: var(--space-2) var(--space-3);
  }
  .hcard-label {
    color: var(--fg-muted);
    font-size: var(--size-label);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .hcard-value {
    font-family: var(--font-mono);
    font-size: 14px;
    margin-top: 3px;
    color: var(--fg);
  }
  .hcard-sub {
    color: var(--fg-dim);
    font-size: var(--size-label);
    font-family: var(--font-mono);
    margin-top: 3px;
  }
  .hcard.bad .hcard-value {
    color: var(--err);
  }
  .hcard.warn .hcard-value {
    color: var(--warn);
  }
  .p50-tag {
    color: var(--fg-muted);
    font-size: var(--size-label);
  }
</style>
