<script lang="ts">
  // Landing — default home view (#/, #/dashboard).
  //
  // Operator-triage layout, not analytics. Sections in render order:
  //
  //   STATUS strip       — single row: live/stalled dot, last poll,
  //                        data dir bytes, uptime, this-week trace count
  //   CAPABILITY strip   — protocol chips (chat · messages · responses ·
  //                        gemini); lit when at least one trace in the
  //                        last hour used that protocol
  //   NEEDS ATTENTION    — last 10 traces in the last 30 min where
  //                        status≥400 OR dur>30s OR truncated.
  //                        Empty state is rendered (not hidden) — the
  //                        section's value to an operator is partly the
  //                        confirmation "yes I checked, nothing is on fire"
  //   VOLUME             — traces/minute sparkline over the last 60 min,
  //                        bucketed from row.ts_start; SVG bars, no chart lib
  //   INTERNAL · healthz — collapsible. Auto-expanded on the transition
  //                        into a warn/err state (operator can still close
  //                        manually thereafter)
  //
  // Polling: /api/traces?limit=200 + /healthz every 10s for the row table
  // and counters; this-week count fetched at most once every 60s (cap 5
  // pages × limit=500); a 1s now-ticker drives the relative-time labels
  // and the stalled-pulse check so the UI doesn't freeze between polls.

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
    key_hash?: string | null;
    truncated_req?: boolean;
    truncated_resp?: boolean;
    [k: string]: unknown;
  }

  interface Props {
    authFetch: (path: string, opts?: RequestInit) => Promise<Response>;
  }

  const { authFetch }: Props = $props();

  // ---------- now ticker (1s) ----------
  //
  // A dedicated ticker independent of the data poll. Without it, every
  // relative-time label ("33s ago", "● stalled if no poll in 30s") freezes
  // between polls — looks fine in a screenshot, broken in practice.

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

  // ---------- this-week count (60s cache, capped pagination) ----------

  const WEEK_CACHE_MS = 60_000;
  const WEEK_MAX_PAGES = 5;
  const WEEK_PAGE_LIMIT = 500;

  let weekCount = $state<number | null>(null);
  let weekCappedAtFloor = $state(false);
  let weekFetchedAt = 0;
  let weekFetchInFlight = false;

  async function loadWeekCount() {
    if (weekFetchInFlight) return;
    if (Date.now() - weekFetchedAt < WEEK_CACHE_MS) return;
    weekFetchInFlight = true;
    try {
      const sinceDate = new Date(Date.now() - 7 * 86_400_000);
      const sinceIso =
        sinceDate.toISOString().slice(0, 10) + 'T00:00:00Z';
      let total = 0;
      let cursor: string | null = null;
      let pages = 0;
      let cappedAtFloor = false;
      // Paginate until exhausted or cap. Break on empty page too,
      // belt-and-suspenders against an API that ever returns
      // next_cursor=non-null + traces=[].
      while (pages < WEEK_MAX_PAGES) {
        const qs = new URLSearchParams();
        qs.set('since', sinceIso);
        qs.set('limit', String(WEEK_PAGE_LIMIT));
        if (cursor) qs.set('cursor', cursor);
        const r = await authFetch('api/traces?' + qs.toString());
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        const page: unknown[] = j.traces || [];
        total += page.length;
        pages++;
        cursor = j.next_cursor || null;
        if (!cursor || page.length === 0) break;
        if (pages >= WEEK_MAX_PAGES && cursor) {
          cappedAtFloor = true;
        }
      }
      weekCount = total;
      weekCappedAtFloor = cappedAtFloor;
      weekFetchedAt = Date.now();
    } catch {
      // swallow — keep previous weekCount; "?" surfaces only on cold start
    } finally {
      weekFetchInFlight = false;
    }
  }

  // ---------- 10s polling ----------

  $effect(() => {
    loadList();
    loadHealthz();
    loadWeekCount();
    const t = setInterval(() => {
      loadList();
      loadHealthz();
      loadWeekCount(); // no-op until cache age > 60s
    }, 10_000);
    return () => clearInterval(t);
  });

  // ---------- STATUS strip derivations ----------

  const stalled = $derived(
    lastPollAt > 0 && now - lastPollAt > 30_000,
  );

  const lastPollLabel = $derived.by(() => {
    if (lastPollAt === 0) return '—';
    const ageSec = Math.max(0, Math.floor((now - lastPollAt) / 1000));
    if (ageSec < 60) return `${ageSec}s ago`;
    if (ageSec < 3600) return `${Math.floor(ageSec / 60)}m ago`;
    return `${Math.floor(ageSec / 3600)}h ago`;
  });

  const dataDirLabel = $derived.by(() => {
    const b = healthz?.counters?.total_bytes;
    if (b == null) return '?';
    return humanBytes(b);
  });

  const uptimeLabel = $derived.by(() => {
    const s = healthz?.uptime_seconds;
    if (s == null) return '?';
    if (s < 60) return `${Math.floor(s)}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86_400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86_400)}d`;
  });

  const weekLabel = $derived.by(() => {
    if (weekCount == null) return '?';
    if (weekCappedAtFloor) return `${weekCount}+`;
    return String(weekCount);
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
  // The empty-state copy asserts "last 30 minutes", so we scope incident
  // detection to that window too — otherwise the line "No incidents in
  // the last 30 minutes" can be untrue (an older incident sat unmatched
  // only because newer non-incident rows pushed it out of our 200-row
  // window).

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

  // ---------- VOLUME sparkline ----------

  const SPARK_BUCKETS = 60;
  const SPARK_BUCKET_MS = 60_000;
  const SPARK_HEIGHT = 200;
  const SPARK_WIDTH = 600; // viewBox; CSS scales to container

  const sparkData = $derived.by(() => {
    // Bucket index 0 = oldest minute (59 min ago), 59 = current minute.
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
    const innerH = SPARK_HEIGHT - 8; // leave 8px headroom
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
  //
  // Auto-expand on the transition into warn/err. Using a $state + $effect
  // (rather than binding open to a $derived) so the operator can still
  // collapse it manually while a warn persists.

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

  // Transition detector: force-open on rising edge (clean → alert).
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

  <!-- ---------- STATUS strip ---------- -->
  <section class="status">
    <span class="status-dot" class:stalled aria-hidden="true">●</span>
    <span class="status-text">
      {#if stalled}stalled{:else}live · backend OK{/if}
    </span>
    <span class="status-sep">·</span>
    <span class="status-kv"
      ><span class="k">last poll</span>
      <span class="v">{lastPollLabel}</span></span
    >
    <span class="status-sep">·</span>
    <span class="status-kv"
      ><span class="k">data dir</span> <span class="v">{dataDirLabel}</span></span
    >
    <span class="status-sep">·</span>
    <span class="status-kv"
      ><span class="k">uptime</span> <span class="v">{uptimeLabel}</span></span
    >
    <span class="status-sep">·</span>
    <span class="status-kv"
      ><span class="k">this week</span> <span class="v">{weekLabel}</span></span
    >
  </section>

  <!-- ---------- CAPABILITY strip ---------- -->
  <section class="capability">
    <span class="cap-label">protocols</span>
    {#each PROTOCOL_CHIPS as chip (chip.key)}
      <span
        class="chip"
        class:lit={recentProtocolHits.has(chip.key)}
        title={recentProtocolHits.has(chip.key)
          ? 'seen in the last hour'
          : 'no traces in the last hour'}>{chip.label}</span
      >
    {/each}
    <span class="cap-tail">recognized · last hour</span>
  </section>

  <!-- ---------- NEEDS ATTENTION ---------- -->
  <section class="attention">
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

  <!-- ---------- VOLUME sparkline ---------- -->
  <section class="volume">
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
  <section class="internal" class:open={internalOpen}>
    <button
      type="button"
      class="internal-toggle"
      aria-expanded={internalOpen}
      onclick={() => (internalOpen = !internalOpen)}
    >
      <span class="caret">{internalOpen ? '▾' : '▸'}</span>
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
    gap: var(--gap-6);
    min-height: 0;
  }

  .err-banner {
    padding: var(--gap-2) var(--gap-3);
    border: 1px solid var(--err);
    border-radius: var(--radius);
    color: var(--err);
    font-family: var(--mono);
    font-size: 12px;
  }

  /* ---------- STATUS strip ---------- */
  .status {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--gap-3);
    padding: var(--gap-3) var(--gap-4);
    border: 1px solid var(--border);
    background: var(--bg-elev);
    font-family: var(--mono);
    font-size: 12px;
  }
  .status-dot {
    color: var(--ok);
    font-size: 10px;
    line-height: 1;
    position: relative;
    top: -1px;
  }
  .status-dot.stalled {
    color: var(--err);
  }
  .status-text {
    color: var(--fg);
  }
  .status-sep {
    color: var(--fg-dim);
  }
  .status-kv {
    display: inline-flex;
    gap: var(--gap-2);
    align-items: baseline;
  }
  .status-kv .k {
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 10px;
  }
  .status-kv .v {
    color: var(--fg);
  }

  /* ---------- CAPABILITY strip ---------- */
  .capability {
    display: flex;
    align-items: baseline;
    gap: var(--gap-2);
    padding: var(--gap-2) var(--gap-4);
    border: 1px solid var(--border);
    background: var(--bg-elev);
    font-family: var(--mono);
    font-size: 11px;
  }
  .cap-label {
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 10px;
    margin-right: var(--gap-2);
  }
  .chip {
    padding: 2px 8px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--fg-dim);
    background: transparent;
  }
  .chip.lit {
    color: var(--accent);
    border-color: var(--accent-dim);
  }
  .cap-tail {
    margin-left: auto;
    color: var(--fg-dim);
    font-size: 10px;
  }

  /* ---------- section heads ---------- */
  .section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: var(--gap-3);
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
    padding: var(--gap-2) 0;
  }

  /* ---------- NEEDS ATTENTION ---------- */
  .attention {
    border: 1px solid var(--border);
    background: var(--bg-elev);
    padding: var(--gap-3) var(--gap-4);
  }
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
    gap: var(--gap-3);
    align-items: center;
    width: 100%;
    padding: var(--gap-2) 0;
    background: transparent;
    border: none;
    border-left: 2px solid transparent;
    border-radius: 0;
    text-align: left;
    cursor: pointer;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--fg);
  }
  .incident-row:hover {
    border-left-color: var(--accent);
    background: var(--bg-elev-2);
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
    gap: var(--gap-1);
    flex-wrap: nowrap;
  }
  .reason {
    padding: 1px 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 10px;
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

  /* ---------- VOLUME ---------- */
  .volume {
    border: 1px solid var(--border);
    background: var(--bg-elev);
    padding: var(--gap-3) var(--gap-4);
  }
  .spark-wrap {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
  }
  .spark {
    width: 100%;
    height: 200px;
    display: block;
  }
  .spark-bar {
    fill: var(--accent);
    opacity: 0.55;
  }
  .spark-axis {
    display: flex;
    justify-content: space-between;
    font-family: var(--mono);
    font-size: 10px;
    color: var(--fg-dim);
  }

  /* ---------- INTERNAL ---------- */
  .internal {
    border: 1px solid var(--border);
    background: var(--bg-elev);
  }
  .internal-toggle {
    display: flex;
    align-items: baseline;
    gap: var(--gap-2);
    width: 100%;
    padding: var(--gap-2) var(--gap-4);
    background: transparent;
    border: none;
    border-radius: 0;
    text-align: left;
    cursor: pointer;
    color: var(--fg-muted);
    font-family: var(--mono);
    font-size: 11px;
  }
  .internal-toggle:hover {
    color: var(--fg);
  }
  .caret {
    color: var(--fg-dim);
    width: 12px;
    display: inline-block;
  }
  .alert-tag {
    color: var(--warn);
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .err-tag {
    color: var(--err);
    font-family: var(--mono);
    font-size: 10px;
  }
  .internal-body {
    padding: 0 var(--gap-4) var(--gap-4);
    display: flex;
    flex-direction: column;
    gap: var(--gap-3);
    opacity: 0.85;
  }
  .group-title.sub {
    margin-top: var(--gap-2);
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
    padding: var(--gap-2) var(--gap-3);
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
  .hcard.bad .hcard-value {
    color: var(--err);
  }
  .hcard.warn .hcard-value {
    color: var(--warn);
  }
  .p50-tag {
    color: var(--fg-muted);
    font-size: 10px;
    font-weight: 400;
  }
</style>
