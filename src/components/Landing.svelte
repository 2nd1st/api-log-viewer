<script lang="ts">
  // Landing — default home view (#/, #/landing, #/dashboard alias).
  //
  // Phase 2 A reshape (operator 2026-05-30):
  //
  //   - Cut NEEDS ATTENTION + INTERNAL · healthz. Service-ops UI lives in
  //     CPA / sub2gpt; the viewer's job is LLM content, not service ops.
  //   - 5 sections in render order: STATUS, CAPABILITY, ACTIVE CLIENTS,
  //     TOKEN USAGE, VOLUME.
  //   - Vercel aesthetic: wider whitespace, larger sans display numbers,
  //     right-aligned numerics, 6px corners, subtle 150ms hover, no
  //     drop shadows, bordered-only cards.
  //   - Single accent (teal-300) is reserved for active state / palette
  //     selected row / focus ring. NOT used on sparkline fill or block
  //     left rails — the page reads more monochrome.
  //
  // Fetch shape: /api/traces?limit=200 + /healthz every 10s. The bulk
  // healthz card grid is gone; we still poll healthz for the STATUS strip
  // (uptime, total traces appended, total bytes).
  //
  // i18n: every user-visible English string goes through t('home.*');
  // numeric values + dates are formatted but not translated.

  import { detectProtocol, type Protocol } from '../lib/adapters';
  import { humanBytes } from '../lib/format';
  import { t } from '../lib/i18n.svelte';

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
    const tick = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => clearInterval(tick);
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
  //
  // Only the four fields STATUS reads (appended + total_bytes +
  // total_media_files + uptime_seconds for the bytes/h rate) matter
  // now that the INTERNAL card grid is gone and R8 has swapped the
  // service-perf cells (proxy / api / uptime) for content-volume
  // cells (traces / data / media / last-write). The wider counters
  // type is kept narrow so type errors surface if the backend shape
  // drifts.

  interface HealthzCounters {
    appended?: number;
    total_bytes?: number;
    total_media_files?: number;
  }

  interface Healthz {
    uptime_seconds: number;
    counters?: HealthzCounters;
  }

  let healthz = $state<Healthz | null>(null);

  async function loadHealthz() {
    try {
      const r = await authFetch('healthz');
      if (!r.ok) throw new Error(String(r.status));
      healthz = (await r.json()) as Healthz;
    } catch {
      // STATUS cells degrade to em-dash on failure; no banner needed
      // here — the proxy/api dot still reads from lastPollAt.
    }
  }

  // ---------- 10s polling ----------

  $effect(() => {
    loadList();
    loadHealthz();
    const poll = setInterval(() => {
      loadList();
      loadHealthz();
    }, 10_000);
    return () => clearInterval(poll);
  });

  // ---------- STATUS derivations ----------

  const stalled = $derived(
    lastPollAt > 0 && now - lastPollAt > 30_000,
  );

  const dataDirLabel = $derived.by(() => {
    const b = healthz?.counters?.total_bytes;
    if (b == null) return '—';
    return humanBytes(b);
  });

  // bytes/hour estimated from total_bytes / uptime_seconds. The
  // STATUS DATA cell renders this below the headline as a content-
  // volume rate (operator quote: "dump 了多少内容"). Em-dash on
  // missing or zero-uptime input — better silent fallback than a
  // bogus "Infinity B/h".
  const dataRateLabel = $derived.by(() => {
    const b = healthz?.counters?.total_bytes;
    const s = healthz?.uptime_seconds;
    if (b == null || !s || s <= 0) return '—';
    return humanBytes((b / s) * 3600);
  });

  const tracesTotalLabel = $derived.by(() => {
    const n = healthz?.counters?.appended;
    if (n == null) return '—';
    return n.toLocaleString();
  });

  const mediaTotalLabel = $derived.by(() => {
    const n = healthz?.counters?.total_media_files;
    if (n == null) return '—';
    return n.toLocaleString();
  });

  // Per-kind breakdown would need per-trace detail fetches (the list
  // endpoint only exposes media_count as an int). R8 ships the total
  // file count only; operator can click into a trace to see kinds.
  const mediaCountForSubline = $derived.by(() => {
    return healthz?.counters?.total_media_files ?? 0;
  });

  // Newest ts_start in the sample → relative-age label. Falls back to
  // em-dash on cold start.
  const lastWriteLabel = $derived.by(() => {
    let newest = 0;
    for (const r of rows) {
      if (!r.ts_start) continue;
      const ts = new Date(r.ts_start).getTime();
      if (Number.isFinite(ts) && ts > newest) newest = ts;
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
      const ts = new Date(r.ts_start).getTime();
      if (Number.isNaN(ts) || ts < cutoff) continue;
      seen.add(detectProtocol(r.path));
    }
    return seen;
  });

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
  // in muted sans (it's a ratio, not a signal).

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
  //
  // Bars use --fg (not --accent) per the Phase 2 A monochrome shift:
  // accent is reserved for active state / focus / palette selection.

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
      const ts = new Date(r.ts_start).getTime();
      if (Number.isNaN(ts) || ts < cutoff || ts > now) continue;
      const ageMs = now - ts;
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

  // ---------- TOKEN USAGE hit-rate formatting ----------

  const hitRatePercent = $derived.by(() => {
    const r = tokenTotals.hitRate;
    return r >= 0.1 ? (r * 100).toFixed(0) : (r * 100).toFixed(1);
  });
</script>

<div class="landing">
  {#if rowsLoadError}
    <div class="err-banner">{t('home.listFetchFailed', { message: rowsLoadError })}</div>
  {/if}

  <!-- ---------- STATUS ---------- -->
  <section class="block status-block">
    <div class="section-head">
      <h3 class="group-title">{t('home.status')}</h3>
      <span class="sample-tag" class:stalled>
        {stalled ? t('home.sampleStalled') : t('home.sampleLive')}
      </span>
    </div>
    <div class="status-strip">
      <div class="status-cell">
        <div class="m-label">{t('home.traces')}</div>
        <div class="m-value m-value-lg">{tracesTotalLabel}</div>
      </div>
      <div class="status-cell">
        <div class="m-label">{t('home.data')}</div>
        <div class="m-value m-value-lg">{dataDirLabel}</div>
        <div class="cell-sub">{t('home.dataRate', { rate: dataRateLabel })}</div>
      </div>
      <div class="status-cell">
        <div class="m-label">{t('home.media')}</div>
        <div class="m-value m-value-lg">{mediaTotalLabel}</div>
        <div class="cell-sub">
          {mediaCountForSubline > 0
            ? t('home.mediaFiles', { n: mediaCountForSubline.toLocaleString() })
            : '—'}
        </div>
      </div>
      <div class="status-cell">
        <div class="m-label">{t('home.lastWrite')}</div>
        <div class="m-value">{lastWriteLabel}</div>
      </div>
    </div>
  </section>

  <!-- ---------- CAPABILITY ---------- -->
  <section class="block">
    <div class="section-head">
      <h3 class="group-title">{t('home.capability')}</h3>
      <span class="sample-tag">{t('home.sampleRecognizedLastHour')}</span>
    </div>
    <div class="chip-row">
      {#each PROTOCOL_CHIPS as chip (chip.key)}
        <span
          class="chip"
          class:lit={recentProtocolHits.has(chip.key)}
          title={recentProtocolHits.has(chip.key)
            ? t('home.chipSeenLastHour')
            : t('home.chipNoTrafficLastHour')}>{chip.label}</span
        >
      {/each}
    </div>
  </section>

  <!-- ---------- ACTIVE CLIENTS ---------- -->
  <section class="block">
    <div class="section-head">
      <h3 class="group-title">{t('home.activeClients')}</h3>
      <span class="sample-tag">{t('home.sampleRecent200TopN', { n: ACTIVE_CLIENTS_LIMIT })}</span>
    </div>
    {#if activeClients.length === 0}
      <div class="empty">{t('home.noClientKind')}</div>
    {:else}
      <table class="mono-table clients-table">
        <thead>
          <tr>
            <th class="col-kind">{t('home.tableKind')}</th>
            <th class="col-version">{t('home.tableVersion')}</th>
            <th class="col-count">{t('home.tableCount')}</th>
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
  <section class="block block-wide-gap">
    <div class="section-head">
      <h3 class="group-title">{t('home.tokenUsage')}</h3>
      <span class="sample-tag">{t('home.sampleRecent200Sums')}</span>
    </div>
    <div class="metric-row">
      <div class="metric">
        <div class="m-label">{t('home.prompt')}</div>
        <div class="m-value">{fmtTokenCount(tokenTotals.prompt)}</div>
      </div>
      <div class="metric">
        <div class="m-label">{t('home.completion')}</div>
        <div class="m-value">{fmtTokenCount(tokenTotals.completion)}</div>
      </div>
      <div class="metric">
        <div class="m-label">{t('home.cacheRead')}</div>
        <div class="m-value">
          {fmtTokenCount(tokenTotals.cached)}
          <span class="m-sub">{t('home.hitRate', { percent: hitRatePercent })}</span>
        </div>
      </div>
      <div class="metric">
        <div class="m-label">{t('home.cacheCreation')}</div>
        <div class="m-value">{fmtTokenCount(tokenTotals.cacheCreate)}</div>
      </div>
    </div>
  </section>

  <!-- ---------- VOLUME sparkline ---------- -->
  <section class="block">
    <div class="section-head">
      <h3 class="group-title">{t('home.volume')}</h3>
      <span class="sample-tag"
        >{t('home.sampleVolume', { total: sparkData.total, peak: sparkData.max })}</span
      >
    </div>
    <div class="spark-wrap">
      <svg
        class="spark"
        viewBox="0 0 {SPARK_WIDTH} {SPARK_HEIGHT}"
        preserveAspectRatio="none"
        role="img"
        aria-label={t('home.sparkAriaLabel')}
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
              <title>{bar.count}</title>
            </rect>
          {/if}
        {/each}
      </svg>
      <div class="spark-axis">
        <span>{t('home.axis60min')}</span>
        <span>{t('home.axisNow')}</span>
      </div>
    </div>
  </section>
</div>

<style>
  /* ---------- outer layout ---------- *
   *
   * Wider whitespace between sections per Phase 2 A. var(--space-section)
   * (32px) is the base gap; the TOKEN USAGE → VOLUME boundary widens to
   * var(--space-section-wide) (48px) because the two sections read as
   * different concepts (sums vs. throughput timeline). The wider gap is
   * applied via `.block-wide-gap + section` so the rule survives even if
   * sections are reordered.
   */
  .landing {
    flex: 1;
    overflow: auto;
    padding: var(--space-6) var(--space-6) var(--space-8);
    display: flex;
    flex-direction: column;
    gap: var(--space-section);
    min-height: 0;
  }
  .block-wide-gap + .block {
    margin-top: calc(var(--space-section-wide) - var(--space-section));
  }

  .err-banner {
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--err);
    border-radius: var(--radius-md);
    color: var(--err);
    font-family: var(--font-mono);
    font-size: var(--size-meta);
  }

  /* ---------- block frame (hairline border, no card chrome) ---------- *
   *
   * 6px corners via var(--radius-md) per Phase 1's Vercel-leaning token
   * delta. No drop shadow, no nested card. The border-only treatment is
   * load-bearing — adding fills breaks the restraint principle.
   */
  .block {
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface);
    padding: var(--space-4) var(--space-6);
  }

  .section-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: var(--space-4);
  }
  .group-title {
    font-family: var(--font-sans);
    font-size: var(--size-label);
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 500;
    margin: 0;
  }
  .sample-tag {
    font-family: var(--font-sans);
    font-size: var(--size-label);
    color: var(--fg-dim);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .sample-tag.stalled {
    color: var(--err);
  }
  .empty {
    color: var(--fg-dim);
    font-family: var(--font-sans);
    font-size: var(--size-body);
    padding: var(--space-2) 0;
  }

  /* ---------- STATUS strip (R8 content-volume cells) ---------- *
   *
   * Phase 2 A R8 swap: the STATUS strip is now 4 equal-width content-
   * volume cells (TRACES / DATA / MEDIA / LAST WRITE), each rendered
   * as its own micro-card via the shared block chrome — --surface bg
   * + 1px --border + var(--radius-md) 6px corners + var(--space-4)
   * padding. The single-accent rule is preserved (no --accent on
   * these cells — accent stays reserved for active state / focus /
   * palette selection).
   *
   * Layout is CSS grid 4×1fr rather than the auto-fit minmax pattern
   * used by .metric-row, because the operator-mandated cut from 6
   * cells to 4 means we have room to commit to a fixed 4-up layout
   * at every breakpoint above ~640px. The micro-card chrome reads
   * better when each cell is wide enough to right-align a multi-
   * digit headline without wrapping.
   */
  .status-strip {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--space-4);
  }
  .status-cell {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface);
    padding: var(--space-4);
  }
  .cell-sub {
    font-family: var(--font-sans);
    font-size: var(--size-meta);
    color: var(--fg-dim);
    text-align: right;
    line-height: 1.2;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ---------- metric row (TOKEN USAGE) ---------- *
   *
   * Vercel-aesthetic delta: label sits top-left in small uppercase sans;
   * value sits below right-aligned in sans semibold display size. The
   * right-alignment is the operator's "都是左对齐很怪" fix — numbers
   * stick to the right edge of each cell so the eye can scan a column
   * of values vertically. Display weight (--font-weight-display = 600)
   * carries the visual weight that mono used to in Phase H.
   */
  .metric-row {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(148px, 1fr));
    gap: var(--space-6);
  }
  .metric {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }
  .m-label {
    font-family: var(--font-sans);
    font-size: var(--size-label);
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    text-align: left;
  }
  .m-value {
    font-family: var(--font-sans);
    font-size: var(--size-display);
    font-weight: var(--font-weight-display);
    color: var(--fg);
    line-height: 1.1;
    text-align: right;
    display: flex;
    align-items: baseline;
    justify-content: flex-end;
    gap: var(--space-2);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .m-value-lg {
    font-size: var(--size-display-lg);
  }
  .m-sub {
    color: var(--fg-dim);
    font-family: var(--font-sans);
    font-size: var(--size-body);
    font-weight: 400;
  }

  /* ---------- CAPABILITY chips ----------
   *
   * Presence signal, not selection — lit reads as bright --fg with a
   * stronger border, dim reads as --fg-dim with hairline border. Accent
   * stays out of this strip per the Phase 2 A narrower-accent rule.
   * Mono kept on chip labels because they're protocol identifiers
   * (chat / messages / responses / gemini).
   */
  .chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }
  .chip {
    padding: 3px 10px;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    color: var(--fg-dim);
    background: transparent;
    font-family: var(--font-mono);
    font-size: var(--size-meta);
    transition: color 150ms ease, border-color 150ms ease;
  }
  .chip.lit {
    color: var(--fg);
    border-color: var(--border-strong);
  }

  /* ---------- ACTIVE CLIENTS table ---------- *
   *
   * Mono for identifier columns (kind / version) and the count — count
   * column is right-aligned so the column reads as a stack of digits.
   * Row hover fades the surface up 150ms; no transform-based hover.
   */
  .mono-table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--font-mono);
    font-size: var(--size-body);
  }
  .mono-table th,
  .mono-table td {
    padding: var(--space-2) var(--space-3);
    text-align: left;
    border-bottom: 1px solid var(--border);
  }
  .mono-table thead th {
    font-family: var(--font-sans);
    font-size: var(--size-label);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--fg-muted);
    border-bottom-color: var(--border-strong);
  }
  .mono-table tbody tr {
    transition: background-color 150ms ease;
  }
  .mono-table tbody tr:hover {
    background: var(--surface-elevated);
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
    width: 120px;
  }
  .clients-table th.col-count {
    text-align: right;
  }

  /* ---------- VOLUME sparkline ---------- *
   *
   * Monochrome shift (Phase 2 A R7): bar fill is --fg, not --accent. The
   * accent is reserved for active state / focus / palette selection now,
   * so the sparkline reads as quiet operator data rather than decoration.
   * Opacity 0.6 keeps full bars from feeling heavy against the surface.
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
    fill: var(--fg);
    opacity: 0.6;
  }
  .spark-axis {
    display: flex;
    justify-content: space-between;
    font-family: var(--font-sans);
    font-size: var(--size-label);
    color: var(--fg-dim);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
</style>
