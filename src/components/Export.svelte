<script lang="ts">
  // Export tab — bundle matching traces into a zip with agent instructions.
  //
  // Contract: phase-i-export-contract.md
  //   GET /api/export?status=&path=&model=&key_hash=&session_root_id=&since=&until=&limit=
  //   -> application/zip with Content-Disposition: attachment
  //
  // PHILOSOPHY (Phase 2 B revamp — Vercel-leaning delta 2026-05-30):
  //   - Two-card layout: Filters card (left) + Generate card (right) +
  //     Recent Exports section below. Earlier passes flat-stacked
  //     everything in one scrolling column; the operator said it read
  //     "rough". Grouping tells the operator what they're doing.
  //   - Wider whitespace (--space-6 inside cards, --space-4 between)
  //     and --radius-lg (8px) for the primary cards. --radius-md (6px)
  //     for inputs and the Generate button.
  //   - Single accent token is reserved for active state / focus ring
  //     only (R7 narrowed scope). Primary Generate button uses INVERT —
  //     bg=var(--fg) / text=var(--bg) — so the page reads monochrome
  //     with one quiet semaphore, not decoration.
  //   - Numbers right-align (operator: "都是左对齐很怪"). The matching-
  //     row count uses --size-display (24px sans 600) as the headline.
  //   - NO new deps, NO webfonts, NO chart lib. System sans fallback
  //     chain only.
  //
  // HONEST COUNT LABELING:
  //   /api/traces caps at 500 rows. We probe with the operator's
  //   filter set, then label the result:
  //     - returned == operator's limit (which is ≤ 500): "≤ {n}"
  //     - returned == 500 AND operator's limit > 500: "≥ 500"
  //     - returned < cap on either side: exact "{n}"
  //   Why this matters: showing a limit-capped number in a 24px display
  //   font implies authority. We can't add a count endpoint (two-
  //   projects rule), but we can refuse to lie.
  //
  // SIZE ESTIMATE:
  //   rows × ~10kB, rendered via humanBytes. Tagged with ≈ prefix
  //   (see export.estimatedSize). Same honesty caveat as count — if
  //   the count is ≤ / ≥, the size carries the same prefix.
  //
  // RECENT EXPORTS:
  //   localStorage['apilog.recent_exports'] = JSON array of up to 5
  //   {ts, filename, rowCount, sizeBytes, query} entries, most recent
  //   first. Click row to re-download (synthesizes a new fetch with the
  //   stored query) and copy the query to clipboard.
  //
  // INVENTED prop signature:
  //   - authFetch: same fn the rest of the app uses. Used for the
  //     autocomplete sample, the live count probe, AND the export blob
  //     download.

  import { api } from '../lib/api';
  import { humanBytes } from '../lib/format';
  import { t, getLang } from '../lib/i18n.svelte';

  interface Props {
    authFetch: (path: string, opts?: RequestInit) => Promise<Response>;
  }

  const { authFetch }: Props = $props();

  // ---------- form state ----------
  //
  // Field names match FilterSidebar / the contract's query params 1:1.
  // Defaults are deliberately empty so the operator picks scope — the
  // export is a destructive-ish action (writes a zip to disk and hands
  // data to an agent), so we don't pre-populate any filter.
  //
  // f_limit kept as a string deliberately. Earlier passes used
  // type="number" and the two-way binding coerced to number, breaking
  // the .trim() in buildQS. Keeping it as text + inputmode="numeric"
  // sidesteps the coercion.

  let f_status = $state<string>('');
  let f_path = $state<string>('');
  let f_model = $state<string>('');
  let f_keyhash = $state<string>('');
  let f_session = $state<string>('');
  let f_since = $state<string>('');
  let f_until = $state<string>('');
  let f_limit = $state<string>('1000');

  // ---------- autocomplete sample ----------
  //
  // One-shot probe of /api/traces?limit=200 on mount. We collect the
  // distinct path / model / key_hash (8-char prefix) values seen in
  // the sample and surface them as <datalist> options. This is a
  // snapshot, not live — typing in the filter inputs does NOT re-fetch.
  // It just hints "did I mean /v1/messages?", not a full search index.

  let knownPaths = $state<string[]>([]);
  let knownModels = $state<string[]>([]);
  let knownKeys = $state<string[]>([]);
  let sampleLoaded = false;

  async function loadSample(): Promise<void> {
    if (sampleLoaded) return;
    sampleLoaded = true;
    try {
      const r = await authFetch('api/traces?limit=200');
      if (!r.ok) return;
      const j = await r.json();
      const rows: Array<{ path?: string; model?: string; key_hash?: string }> =
        j.traces || [];
      const paths = new Set<string>();
      const models = new Set<string>();
      const keys = new Set<string>();
      for (const row of rows) {
        if (row.path) paths.add(row.path);
        if (row.model) models.add(row.model);
        if (row.key_hash) keys.add(row.key_hash.slice(0, 8));
      }
      knownPaths = [...paths].sort();
      knownModels = [...models].sort();
      knownKeys = [...keys].sort();
    } catch {
      /* sample is best-effort; silent failure is fine */
    }
  }

  $effect(() => {
    void loadSample();
  });

  // ---------- query string construction ----------
  //
  // buildQS() returns a URLSearchParams with the current filter values,
  // omitting empty fields. Used for the count probe, the download URL,
  // and the URL hint. Validation is the server's job — bad input gets
  // a 400 with a structured error, surfaced as genError.

  function buildQS(): URLSearchParams {
    const qs = new URLSearchParams();
    const s = f_status.trim();
    if (s) qs.set('status', s);
    const p = f_path.trim();
    if (p && p !== '*') qs.set('path', p);
    const m = f_model.trim();
    if (m) qs.set('model', m);
    const k = f_keyhash.trim();
    if (k) qs.set('key_hash', k);
    const sr = f_session.trim();
    if (sr) qs.set('session_root_id', sr);
    const si = f_since.trim();
    if (si) qs.set('since', si);
    const un = f_until.trim();
    if (un) qs.set('until', un);
    const lim = f_limit.trim();
    if (lim) qs.set('limit', lim);
    return qs;
  }

  // ---------- live matching-row count ----------
  //
  // Debounced probe of /api/traces with the current filter set. We
  // can't ask the backend for a true count (no count endpoint, no new
  // API asks per the two-projects rule), so we probe with the
  // operator's limit capped to 500 (the /api/traces ceiling) and label
  // the result honestly:
  //   - returned == probeLimit: true count is AT LEAST n. Render as
  //     "≥ {n}". A cap hit always implies n is a LOWER bound, never
  //     an upper bound — /api/traces never returns fewer than
  //     probeLimit rows when more would have matched.
  //   - else: exact "{n}".
  //
  // We track which ceiling we hit (operator limit vs the hard 500 cap)
  // because it matters for the size estimate hint, but the display
  // operator is "≥" in both capped cases.

  type CountState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'ok'; n: number; capped: boolean; cappedBy: 'op' | 'api' | null }
    | { kind: 'err'; message: string };

  let count = $state<CountState>({ kind: 'idle' });
  let countToken = 0;

  // Track the filter inputs so the $effect re-runs on any change.
  $effect(() => {
    // Read every filter field — establishes the reactivity dependency.
    void [
      f_status,
      f_path,
      f_model,
      f_keyhash,
      f_session,
      f_since,
      f_until,
      f_limit,
    ];
    countToken += 1;
    const myToken = countToken;
    count = { kind: 'loading' };
    const handle = setTimeout(() => {
      void refreshCount(myToken);
    }, 350);
    return () => clearTimeout(handle);
  });

  async function refreshCount(token: number): Promise<void> {
    // 500 is the /api/traces hard cap (see traces.go parseFilters).
    // We probe with min(operator limit, 500). If the response hits the
    // cap, label honestly.
    const opLimitRaw = parseInt(f_limit.trim() || '0', 10);
    const opLimit = Number.isFinite(opLimitRaw) && opLimitRaw > 0
      ? opLimitRaw
      : 0; // 0 = "unlimited" on the export side, treat probe as 500
    const probeLimit = opLimit > 0 ? Math.min(opLimit, 500) : 500;
    const qs = buildQS();
    qs.set('limit', String(probeLimit));
    try {
      const r = await authFetch('api/traces?' + qs.toString());
      if (token !== countToken) return; // a newer probe is in flight
      if (!r.ok) {
        count = { kind: 'err', message: 'count probe ' + r.status };
        return;
      }
      const j = await r.json();
      const rows: unknown[] = Array.isArray(j.traces) ? j.traces : [];
      const n = rows.length;
      let capped = false;
      let cappedBy: 'op' | 'api' | null = null;
      if (n === probeLimit) {
        capped = true;
        // Which ceiling did we hit? Useful for the size-hint copy but
        // does NOT change the display operator — true count ≥ n in
        // both cases.
        cappedBy = opLimit === 0 || opLimit > 500 ? 'api' : 'op';
      }
      if (token !== countToken) return;
      count = { kind: 'ok', n, capped, cappedBy };
    } catch (e: any) {
      if (token !== countToken) return;
      count = { kind: 'err', message: e?.message ?? String(e) };
    }
  }

  // Display formatters for count + size, both honest about caps.
  // A cap hit always means the displayed number is a LOWER bound, so
  // both capped variants render as "≥ {n}". The size estimate carries
  // the same "≥" semantic in those cases — what we render is a floor,
  // not a midpoint.
  const countDisplay = $derived.by((): string => {
    if (count.kind === 'idle' || count.kind === 'loading') return '—';
    if (count.kind === 'err') return '—';
    if (count.capped) return t('export.countAtLeast', { n: count.n });
    return String(count.n);
  });

  const sizeDisplay = $derived.by((): string => {
    if (count.kind !== 'ok') return '—';
    const bytes = count.n * 10 * 1024;
    const base = t('export.estimatedSize', { size: humanBytes(bytes) });
    // If the count is a floor, the size derived from it is also a floor.
    return count.capped ? t('export.sizeAtLeast', { size: base }) : base;
  });

  // ---------- generate ----------
  //
  // Build the URL, hit it with authFetch (so the bearer token rides
  // along), convert the response into a Blob, then synthesize an
  // <a download> click. window.location.href won't work — a navigation
  // can't carry the Authorization header.

  let generating = $state<boolean>(false);
  let genError = $state<string | null>(null);

  async function generate(): Promise<void> {
    if (generating) return;
    generating = true;
    genError = null;
    try {
      const qs = buildQS();
      const qsStr = qs.toString();
      const r = await authFetch('api/export?' + qsStr);
      if (!r.ok) {
        let msg = t('export.failed', { status: r.status });
        try {
          const j = await r.json();
          if (j && j.message) msg = `${j.error ?? 'error'}: ${j.message}`;
        } catch { /* not JSON */ }
        throw new Error(msg);
      }
      // Pull a filename out of Content-Disposition if present, else
      // synthesize one. The contract guarantees attachment + filename
      // but a defensive fallback costs nothing.
      const cd = r.headers.get('Content-Disposition') ?? '';
      let filename = 'api-log-export.zip';
      const m = cd.match(/filename="?([^";]+)"?/);
      if (m) filename = m[1];
      const blob = await r.blob();
      const sizeBytes = blob.size;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      // Remember this export. Best-effort — localStorage can throw in
      // private-mode Safari. The captured rowCount uses the live count
      // probe at click time; if it's still loading we record null and
      // the recent-exports row reads "—".
      recordRecent({
        ts: Date.now(),
        filename,
        rowCount: count.kind === 'ok' ? count.n : null,
        sizeBytes,
        query: qsStr,
      });
    } catch (e: any) {
      genError = e?.message ?? String(e);
    } finally {
      generating = false;
    }
  }

  // ---------- recent exports ----------
  //
  // Keep the last 5, newest first. Stored in localStorage so they
  // survive page reload. Re-download replays the saved query against
  // /api/export (filters may have shifted, so the result isn't byte-
  // identical to the original — that's fine; the contract doesn't
  // promise stable bytes anyway).

  interface RecentExport {
    ts: number;
    filename: string;
    rowCount: number | null;
    sizeBytes: number;
    query: string;
  }

  const RECENT_KEY = 'apilog.recent_exports';

  function loadRecent(): RecentExport[] {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      if (!raw) return [];
      const j = JSON.parse(raw);
      if (!Array.isArray(j)) return [];
      return j.filter(
        (e) =>
          e &&
          typeof e.ts === 'number' &&
          typeof e.filename === 'string' &&
          typeof e.query === 'string',
      ) as RecentExport[];
    } catch {
      return [];
    }
  }

  let recent = $state<RecentExport[]>(loadRecent());

  function recordRecent(entry: RecentExport): void {
    const next = [entry, ...recent.filter((r) => r.query !== entry.query)].slice(0, 5);
    recent = next;
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* private mode — UI still updates for the session */
    }
  }

  let copiedTick = $state<number>(0);

  async function reDownload(entry: RecentExport): Promise<void> {
    // Copy the query string to clipboard for transparency, then trigger
    // a fresh download with the saved filter set.
    try {
      await navigator.clipboard?.writeText(entry.query);
      copiedTick = Date.now();
      setTimeout(() => {
        if (Date.now() - copiedTick >= 1500) copiedTick = 0;
      }, 1600);
    } catch {
      /* clipboard unavailable in some contexts — ignore */
    }
    try {
      const r = await authFetch('api/export?' + entry.query);
      if (!r.ok) {
        genError = t('export.failed', { status: r.status });
        return;
      }
      const cd = r.headers.get('Content-Disposition') ?? '';
      let filename = entry.filename;
      const m = cd.match(/filename="?([^";]+)"?/);
      if (m) filename = m[1];
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e: any) {
      genError = e?.message ?? String(e);
    }
  }

  function fmtRecentTs(ms: number): string {
    const d = new Date(ms);
    // Lean on browser locale via the active i18n lang. Doesn't need to
    // round-trip — display only.
    const lang = getLang() === 'zh' ? 'zh-CN' : 'en-GB';
    return (
      d.toLocaleDateString(lang) +
      ' ' +
      d.toLocaleTimeString(lang, { hour12: false })
    );
  }

  // The URL Generate will actually request. Surfaced as a hint below
  // the button — pure transparency, not a preview semantic.
  const requestUrl = $derived(api('api/export?' + buildQS().toString()));
</script>

<div class="export">
  <div class="page-container">
  <!-- HEADER -->
  <header class="head">
    <div class="title">{t('export.title')}</div>
    <div class="subtitle">{t('export.subtitle')}</div>
  </header>

  <!-- TWO-COLUMN: Filters | Generate -->
  <div class="export-cards">
    <!-- FILTERS CARD -->
    <section class="card filters-card">
      <h3 class="card-title">{t('export.cardFilters')}</h3>

      <div class="form">
        <div class="row">
          <label for="x-status">{t('filters.status')}</label>
          <select id="x-status" bind:value={f_status}>
            <option value="">{t('ui.any')}</option>
            <option value="2xx">2xx</option>
            <option value="4xx">4xx</option>
            <option value="5xx">5xx</option>
            <option value="200">200</option>
            <option value="401">401</option>
            <option value="403">403</option>
            <option value="404">404</option>
            <option value="429">429</option>
            <option value="500">500</option>
            <option value="502">502</option>
          </select>
        </div>

        <div class="row">
          <label for="x-path">
            {t('filters.path')}
            <span class="hint">{t('filters.hintPrefix')}</span>
          </label>
          <input
            class="input"
            id="x-path"
            list="x-dl-paths"
            placeholder={t('filters.placeholderPathPrefix')}
            autocomplete="off"
            bind:value={f_path}
          />
          <datalist id="x-dl-paths">
            {#each knownPaths as v (v)}
              <option value={v}></option>
            {/each}
          </datalist>
        </div>

        <div class="row">
          <label for="x-model">{t('filters.model')}</label>
          <input
            class="input"
            id="x-model"
            list="x-dl-models"
            placeholder={t('ui.any')}
            autocomplete="off"
            bind:value={f_model}
          />
          <datalist id="x-dl-models">
            {#each knownModels as v (v)}
              <option value={v}></option>
            {/each}
          </datalist>
        </div>

        <div class="row">
          <label for="x-keyhash">
            {t('filters.keyHash')}
            <span class="hint">{t('filters.hintKeyPrefix')}</span>
          </label>
          <input
            class="input"
            id="x-keyhash"
            list="x-dl-keys"
            placeholder={t('filters.placeholderPrefix')}
            autocomplete="off"
            bind:value={f_keyhash}
          />
          <datalist id="x-dl-keys">
            {#each knownKeys as v (v)}
              <option value={v}></option>
            {/each}
          </datalist>
        </div>

        <div class="row">
          <label for="x-session">{t('filters.sessionRootId')}</label>
          <input
            class="input"
            id="x-session"
            placeholder={t('filters.placeholderUlid')}
            autocomplete="off"
            bind:value={f_session}
          />
        </div>

        <div class="row two-col">
          <div class="row">
            <label for="x-since">
              {t('filters.since')}
              <span class="hint">{t('filters.hintIso')}</span>
            </label>
            <input
              class="input"
              id="x-since"
              placeholder={t('filters.placeholderIsoSince')}
              autocomplete="off"
              bind:value={f_since}
            />
          </div>
          <div class="row">
            <label for="x-until">
              {t('filters.until')}
              <span class="hint">{t('filters.hintIso')}</span>
            </label>
            <input
              class="input"
              id="x-until"
              placeholder={t('filters.placeholderIsoUntil')}
              autocomplete="off"
              bind:value={f_until}
            />
          </div>
        </div>

        <div class="row">
          <label for="x-limit">
            {t('filters.limit')}
            <span class="hint">{t('filters.hintNoUpperBound')}</span>
          </label>
          <input
            class="input"
            id="x-limit"
            type="text"
            inputmode="numeric"
            pattern="[0-9]*"
            autocomplete="off"
            bind:value={f_limit}
          />
        </div>
      </div>
    </section>

    <!-- GENERATE CARD -->
    <section class="card generate-card">
      <h3 class="card-title">{t('export.cardGenerate')}</h3>

      <div class="metric">
        <div class="metric-label">{t('export.matchingRows')}</div>
        <div class="metric-value" class:loading={count.kind === 'loading'}>
          {countDisplay}
        </div>
        <div class="metric-sub">
          {sizeDisplay}
          <span class="meta-sep">·</span>
          <span class="meta-hint">{t('export.sizeHint')}</span>
        </div>
      </div>

      <button
        type="button"
        class="primary"
        onclick={generate}
        disabled={generating}
      >
        {generating ? t('export.generating') : t('export.generateButton')}
      </button>

      <p class="helper">{t('export.helper')}</p>

      {#if genError}
        <div class="err">{genError}</div>
      {/if}

      <div class="debug" title={requestUrl}>{requestUrl}</div>
    </section>
  </div>

  <!-- RECENT EXPORTS -->
  <section class="card recent-card export-recent">
    <h3 class="card-title">{t('export.recentExports')}</h3>

    {#if recent.length === 0}
      <div class="recent-empty">{t('export.noRecent')}</div>
    {:else}
      <ul class="recent-list">
        {#each recent as entry (entry.ts + entry.query)}
          <li class="recent-row">
            <div class="recent-main">
              <div class="recent-ts">{fmtRecentTs(entry.ts)}</div>
              <div class="recent-filename" title={entry.filename}>
                {entry.filename}
              </div>
            </div>
            <div class="recent-meta">
              <span class="num">
                {entry.rowCount == null
                  ? '—'
                  : t('export.rows', { n: entry.rowCount })}
              </span>
              <span class="num">{humanBytes(entry.sizeBytes)}</span>
              <button
                type="button"
                class="link"
                onclick={() => void reDownload(entry)}
              >
                {t('export.redownload')}
              </button>
            </div>
          </li>
        {/each}
      </ul>
      {#if copiedTick > 0}
        <div class="copied-flash">{t('export.queryCopied')}</div>
      {/if}
    {/if}
  </section>
  </div>
</div>

<style>
  /* Phase 2 B revamp — Vercel-leaning delta on canonical Phase L tokens.
     Wider whitespace, bordered cards (no shadow / no gradient), invert
     primary button, right-aligned numbers. Accent reserved for focus
     ring + active state — page reads monochrome. */

  /* .export is the outer scroll/flex shell; .page-container (global
     utility from app.css) lives inside it and supplies the centered
     max-width + horizontal padding. The inner vertical rhythm
     (header → cards grid → recent) is restored here via a flex column
     scoped to .page-container under this surface. */
  .export {
    display: flex;
    flex-direction: column;
    overflow: auto;
    flex: 1;
    min-height: 0;
  }
  .export :global(.page-container) {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  /* ---------- header ---------- */

  .head {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin-bottom: var(--space-2);
  }
  .head .title {
    font-family: var(--font-sans);
    font-size: var(--size-label);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fg-muted);
  }
  .head .subtitle {
    font-family: var(--font-sans);
    font-size: var(--size-body);
    color: var(--fg-dim);
    line-height: 1.5;
  }

  /* ---------- grid: Filters | Generate ---------- */

  .export-cards {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-6);
  }

  /* On narrow viewports stack the two cards. The recent card
     always spans the row by virtue of being a sibling section. */
  @media (max-width: 720px) {
    .export-cards {
      grid-template-columns: 1fr;
    }
  }

  /* Recent Exports sits below the two-card grid as a sibling section.
     It auto-fills the page-container's horizontal extent; the explicit
     margin keeps the rhythm between cards-row and recent-row aligned
     with the inside-card padding. */
  .export-recent {
    margin-top: var(--space-6);
  }

  /* ---------- cards (real ones this time) ---------- */

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .card-title {
    margin: 0;
    padding: 0;
    font-family: var(--font-sans);
    font-size: var(--size-label);
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--fg-muted);
    background: transparent;
    border: 0;
  }

  /* ---------- filters form ---------- */

  .form {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .form .row {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }
  .form .row.two-col {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
  }
  .form label {
    font-family: var(--font-sans);
    font-size: var(--size-label);
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    display: flex;
    align-items: center;
    gap: 6px;
    background: transparent;
    border: 0;
    padding: 0;
  }
  .form label .hint {
    color: var(--fg-dim);
    font-size: var(--size-label);
    text-transform: none;
    letter-spacing: 0;
  }
  .form .input,
  .form select {
    margin: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 7px 10px;
    background: var(--bg);
    color: var(--fg);
    font-family: var(--font-mono);
    font-size: var(--size-input);
    line-height: 1.4;
    outline: none;
    box-shadow: none;
    transition: border-color 150ms ease;
  }
  .form .input:focus,
  .form select:focus {
    border-color: var(--accent); /* accent reserved for focus ring (R7) */
  }
  .form select {
    appearance: none;
    /* Functional dropdown chevron — the one gradient we keep. */
    background-image:
      linear-gradient(45deg, transparent 50%, var(--fg-muted) 50%),
      linear-gradient(135deg, var(--fg-muted) 50%, transparent 50%);
    background-position:
      calc(100% - 14px) 13px,
      calc(100% - 9px) 13px;
    background-size:
      5px 5px,
      5px 5px;
    background-repeat: no-repeat;
    padding-right: 22px;
  }

  /* ---------- generate card: headline metric + invert button ---------- */

  .metric {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    text-align: right;
    padding-bottom: var(--space-2);
    border-bottom: 1px solid var(--border);
  }
  .metric-label {
    font-family: var(--font-sans);
    font-size: var(--size-label);
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .metric-value {
    font-family: var(--font-sans);
    font-size: var(--size-display);
    font-weight: 600;
    color: var(--fg);
    font-variant-numeric: tabular-nums;
    line-height: 1.1;
  }
  .metric-value.loading {
    color: var(--fg-dim);
  }
  .metric-sub {
    font-family: var(--font-sans);
    font-size: var(--size-body);
    color: var(--fg-dim);
    font-variant-numeric: tabular-nums;
  }
  .metric-sub .meta-sep {
    margin: 0 6px;
    color: var(--border-strong);
  }
  .metric-sub .meta-hint {
    color: var(--fg-dim);
  }

  /* Invert primary button. Theme-aware via the shared --fg / --bg.
     Hover lightens to --fg-muted; same in both themes. */
  .primary {
    align-self: stretch;
    background: var(--fg);
    color: var(--bg);
    border: 1px solid var(--fg);
    border-radius: var(--radius-md);
    padding: 0 var(--space-4);
    height: 38px;
    font-family: var(--font-sans);
    font-size: var(--size-input);
    font-weight: 500;
    cursor: pointer;
    box-shadow: none;
    transition: background-color 150ms ease, border-color 150ms ease;
  }
  .primary:hover:not(:disabled) {
    background: var(--fg-muted);
    border-color: var(--fg-muted);
  }
  .primary:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .helper {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--size-body);
    color: var(--fg-dim);
    line-height: 1.5;
  }

  .err {
    color: var(--err);
    font-family: var(--font-sans);
    font-size: var(--size-body);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--err);
    border-radius: var(--radius-md);
    background: transparent;
  }

  .debug {
    border-top: 1px solid var(--border);
    padding-top: var(--space-2);
    margin-top: auto;
    color: var(--fg-dim);
    font-family: var(--font-mono);
    font-size: var(--size-label);
    overflow-wrap: anywhere;
    word-break: break-all;
  }

  /* ---------- recent exports ---------- */

  .recent-card {
    gap: var(--space-3);
  }

  .recent-empty {
    font-family: var(--font-sans);
    font-size: var(--size-body);
    color: var(--fg-dim);
    padding: var(--space-3) 0;
  }

  .recent-list {
    margin: 0;
    padding: 0;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0;
  }
  .recent-row {
    display: flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-3) 0;
    border-top: 1px solid var(--border);
  }
  .recent-row:first-child {
    border-top: 0;
  }
  .recent-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .recent-ts {
    font-family: var(--font-mono);
    font-size: var(--size-meta);
    color: var(--fg-dim);
    font-variant-numeric: tabular-nums;
  }
  .recent-filename {
    font-family: var(--font-mono);
    font-size: var(--size-input);
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .recent-meta {
    display: flex;
    align-items: baseline;
    gap: var(--space-4);
    flex-shrink: 0;
  }
  .recent-meta .num {
    font-family: var(--font-mono);
    font-size: var(--size-meta);
    color: var(--fg-muted);
    font-variant-numeric: tabular-nums;
    text-align: right;
    min-width: 56px;
  }
  .recent-meta .link {
    background: transparent;
    border: 0;
    padding: 0;
    color: var(--fg-muted);
    font-family: var(--font-sans);
    font-size: var(--size-body);
    cursor: pointer;
    text-decoration: underline;
    text-decoration-color: var(--border);
    text-underline-offset: 3px;
    transition: color 150ms ease, text-decoration-color 150ms ease;
  }
  .recent-meta .link:hover {
    color: var(--fg);
    text-decoration-color: var(--fg);
  }

  .copied-flash {
    font-family: var(--font-sans);
    font-size: var(--size-body);
    color: var(--fg-muted);
    padding-top: var(--space-2);
  }
</style>
