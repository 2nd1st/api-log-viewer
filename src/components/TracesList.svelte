<script lang="ts" module>
  // ---------- public types (exported for parent / sibling concerns) ----------
  //
  // TraceRow mirrors the shape returned by GET api/traces in the original
  // viewer. Only the fields actually read by renderTracesList() are
  // declared — anything else the backend includes is ignored.
  export interface TraceRow {
    id: string;
    ts_start?: string | null;
    status?: number | null;
    path?: string | null;
    model?: string | null;
    key_hash?: string | null;
    session_root_id?: string | null;
  }

  // Same Filters shape as FilterSidebar exports. Duplicated here (rather
  // than imported) to keep TracesList stand-alone — the parent can hand
  // either object in as long as the field names match.
  export interface TracesFilters {
    status?: string;
    path?: string;
    model?: string;
    key_hash?: string;
    session_root_id?: string;
    since?: string;
    limit?: string;
  }
</script>

<script lang="ts">
  // TracesList — fetch + render the /api/traces list with cursor pagination.
  //
  // Direct port of api-log/internal/viewer/static/index.html, ~lines
  // 753-837 plus the page-next / page-prev click handlers (~1374-1383).
  // Behavior preserved 1:1:
  //
  //   - readFilters() exact param mapping (status / path / model /
  //     key_hash / session_root_id / since / limit). The path field
  //     empty-or-"*" => no path filter, matching the original's
  //     `if (p && p !== '*')` guard.
  //   - GET api/traces?<qs>[&cursor=...]; on success, replace `traces`
  //     with j.traces (defaulting to []) and `cursor` with
  //     j.next_cursor || null.
  //   - cursorStack semantics:
  //       reload({ reset: true }) clears the stack.
  //       next pushes the CURRENT next-cursor onto the stack and reloads
  //         with it (matches original page-next handler verbatim).
  //       prev pops the stack and reloads with whatever cursor is now on
  //         top (or null if the stack is empty).
  //   - datalist accumulation: every fetch merges path / model / key_hash
  //     values from the returned rows into knownPaths / knownModels /
  //     knownKeys sets. Surfaced as bindable props so the parent's
  //     FilterSidebar can render <option>s.
  //   - rendered columns and order: time | status | path | model | key |
  //     session. Selected row gets the `selected` class. Empty status
  //     renders as the em-dash '—' (same character as in the original).
  //     key column shows the first 8 chars of key_hash with the full
  //     hash in the title attribute. session column is shortId() of
  //     session_root_id with the full id in title.
  //   - status messages emitted via onStatus: `${n} loaded` on success,
  //     `'list failed'` on failure. Exact strings preserved.
  //   - pager state surfaced via onPagerChange:
  //       prevDisabled = cursorStack.length === 0
  //       nextDisabled = !cursor
  //       info = `${n} rows` or 'empty'
  //
  // Out of scope for this concern (handled by sibling concerns):
  //   - the filter sidebar inputs / Apply / Clear buttons
  //   - the traces/sessions mode toggle
  //   - the detail panel + hash routing
  //   - the actual <button>s for prev / next / info — the parent owns the
  //     pager UI (matching SessionsList.svelte's onPagerChange pattern).
  //     Parents call next() / prev() on this component via bind:this.
  //
  // INVENTED signatures (no shared types module exists yet):
  //   - authFetch: (url: string, opts?: RequestInit) => Promise<Response>
  //     — typically the project-wide auth wrapper from lib/api.ts. Passed
  //     in so the component stays decoupled from the module-level token
  //     cell and easier to test.
  //   - setStatus / onStatus: (text, kind) => void — same shape as in
  //     SessionsList.svelte. Exact text strings are part of the contract.
  //   - onSelectTrace: (id: string) => void — row click handler. Parent
  //     wires this to its selectTrace() equivalent (hash routing + detail
  //     panel update).
  //   - onPagerChange: parent reflects the disabled / info state in its
  //     pager UI.
  //   - Sets are passed as $bindable so the component can add to them in
  //     place, mirroring the original `state.knownPaths.add(...)`. The
  //     parent's FilterSidebar reads them reactively for <datalist>.

  import { shortId, shortTs, statusClass } from '../lib/format';

  interface Props {
    filters: TracesFilters;
    selectedId?: string | null;

    /** Bump to force a reload (e.g. on Apply / mode-switch back to traces). */
    reloadKey?: number;
    /** When true, the next reload resets cursorStack (matches reset: true). */
    reloadResets?: boolean;

    knownPaths?: Set<string>;
    knownModels?: Set<string>;
    knownKeys?: Set<string>;

    authFetch: (url: string, opts?: RequestInit) => Promise<Response>;
    onStatus: (text: string, kind?: 'good' | 'bad' | '') => void;
    onSelectTrace: (id: string) => void;
    onPagerChange?: (state: {
      prevDisabled: boolean;
      nextDisabled: boolean;
      info: string;
    }) => void;
  }

  let {
    filters,
    selectedId = null,
    reloadKey = 0,
    reloadResets = true,
    knownPaths = $bindable(new Set<string>()),
    knownModels = $bindable(new Set<string>()),
    knownKeys = $bindable(new Set<string>()),
    authFetch,
    onStatus,
    onSelectTrace,
    onPagerChange,
  }: Props = $props();

  // ---------- internal state ----------

  let traces = $state<TraceRow[]>([]);
  // The next-page cursor returned by the last fetch. null when on the
  // final page.
  let cursor = $state<string | null>(null);
  // Stack of cursors used to get to the current page. Pushed on next,
  // popped on prev. Cleared on reset.
  let cursorStack = $state<string[]>([]);

  // ---------- readFilters() — exact 1:1 port ----------
  //
  // Build the URLSearchParams the same way the original did. The path
  // field's "" / "*" → no-filter behavior is preserved here verbatim.
  function readFilters(): URLSearchParams {
    const qs = new URLSearchParams();
    const s = (filters.status ?? '').trim();
    if (s) qs.set('status', s);
    // Path filter: pre-populated with DEFAULT_PATH_FILTER on boot;
    // operator edits freely. Empty box = no path filter (see all);
    // "*" alone is also treated as "see all" (more intuitive than
    // an empty box).
    const p = (filters.path ?? '').trim();
    if (p && p !== '*') qs.set('path', p);
    const m = (filters.model ?? '').trim();
    if (m) qs.set('model', m);
    const kh = (filters.key_hash ?? '').trim();
    if (kh) qs.set('key_hash', kh);
    const sr = (filters.session_root_id ?? '').trim();
    if (sr) qs.set('session_root_id', sr);
    const si = (filters.since ?? '').trim();
    if (si) qs.set('since', si);
    const lim = (filters.limit ?? '').trim();
    if (lim) qs.set('limit', lim);
    return qs;
  }

  // ---------- loadTraces() — direct port ----------

  async function loadTraces(opts: { reset?: boolean; cursor?: string | null } = {}) {
    let useCursor = opts.cursor ?? null;
    if (opts.reset) {
      cursorStack = [];
      useCursor = null;
    }
    const qs = readFilters();
    if (useCursor) qs.set('cursor', useCursor);
    try {
      const r = await authFetch('api/traces?' + qs.toString());
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      const rows: TraceRow[] = j.traces || [];
      traces = rows;
      cursor = j.next_cursor || null;

      // Accumulate filter suggestions. We mutate the bound sets in place
      // and reassign so $bindable change-tracking picks it up (Sets are
      // referentially stable in Svelte 5 — reassign forces a notify).
      let pathsChanged = false;
      let modelsChanged = false;
      let keysChanged = false;
      for (const t of rows) {
        if (t.path && !knownPaths.has(t.path)) {
          knownPaths.add(t.path);
          pathsChanged = true;
        }
        if (t.model && !knownModels.has(t.model)) {
          knownModels.add(t.model);
          modelsChanged = true;
        }
        if (t.key_hash && !knownKeys.has(t.key_hash)) {
          knownKeys.add(t.key_hash);
          keysChanged = true;
        }
      }
      if (pathsChanged) knownPaths = new Set(knownPaths);
      if (modelsChanged) knownModels = new Set(knownModels);
      if (keysChanged) knownKeys = new Set(knownKeys);

      onStatus(`${traces.length} loaded`, 'good');
      emitPagerState();
    } catch (_e) {
      onStatus('list failed', 'bad');
    }
  }

  function emitPagerState() {
    onPagerChange?.({
      prevDisabled: cursorStack.length === 0,
      nextDisabled: !cursor,
      info: traces.length ? `${traces.length} rows` : 'empty',
    });
  }

  // ---------- public methods (parent calls via bind:this) ----------

  export function reload(opts: { reset?: boolean } = { reset: true }) {
    return loadTraces({ reset: opts.reset });
  }

  // Page next — matches the original page-next handler verbatim:
  //   if (!state.cursor) return;
  //   state.cursorStack.push(state.cursor);
  //   loadTraces({ cursor: state.cursor });
  export function next() {
    if (!cursor) return;
    cursorStack.push(cursor);
    cursorStack = cursorStack; // notify
    loadTraces({ cursor });
  }

  // Page prev — matches the original page-prev handler verbatim:
  //   state.cursorStack.pop();
  //   const prev = state.cursorStack[state.cursorStack.length - 1] || null;
  //   loadTraces({ cursor: prev });
  export function prev() {
    cursorStack.pop();
    cursorStack = cursorStack; // notify
    const prevCursor = cursorStack[cursorStack.length - 1] || null;
    loadTraces({ cursor: prevCursor });
  }

  // ---------- reload trigger ----------
  //
  // Reload is event-driven, NOT reactive on the `filters` prop — the
  // original only re-fetched on Apply / Clear / next / prev / initial
  // load, never on a filter keystroke. We watch `reloadKey` (a counter
  // the parent bumps) so a keystroke that mutates `filters.path` does
  // not trigger a request.
  $effect(() => {
    void reloadKey;
    loadTraces({ reset: reloadResets });
  });

  // ---------- auto-refresh ----------
  //
  // Operator-controlled polling. Stored as a label ('off' | '5s' | '10s'
  // | '30s' | '60s' | '5m') so the persisted value is self-describing.
  // We intentionally only auto-refresh page 1 (cursorStack empty) — pol-
  // ling deep into a paginated stream would scramble the page boundary
  // under the operator. When the user has paged forward, the timer is
  // effectively dormant until they return to page 1.
  //
  // UX guard: if the user is focused inside the table (e.g. a row has
  // keyboard focus) or has scrolled within the last 2s, skip the tick.
  // This is best-effort — we resume on the next tick automatically.

  type RefreshOpt = 'off' | '5s' | '10s' | '30s' | '60s' | '5m';
  const REFRESH_SECONDS: Record<RefreshOpt, number> = {
    off: 0,
    '5s': 5,
    '10s': 10,
    '30s': 30,
    '60s': 60,
    '5m': 300,
  };
  const REFRESH_OPTIONS: RefreshOpt[] = ['off', '5s', '10s', '30s', '60s', '5m'];

  function readPersistedRefresh(): RefreshOpt {
    try {
      const v = localStorage.getItem('apilog.traces.autorefresh');
      if (v && v in REFRESH_SECONDS) return v as RefreshOpt;
    } catch {
      // localStorage may throw in private mode / sandboxed iframes —
      // silently fall back to default.
    }
    return 'off';
  }

  let refreshOpt = $state<RefreshOpt>(readPersistedRefresh());
  let lastScrollAt = $state<number>(0);
  let tableEl = $state<HTMLTableElement | null>(null);

  function onRefreshChange(e: Event) {
    const v = (e.currentTarget as HTMLSelectElement).value as RefreshOpt;
    refreshOpt = v;
    try {
      localStorage.setItem('apilog.traces.autorefresh', v);
    } catch {
      // see readPersistedRefresh()
    }
  }

  function onScroll() {
    lastScrollAt = Date.now();
  }

  function shouldSkipTick(): boolean {
    // Skip while paginated past page 1 — see comment above.
    if (cursorStack.length > 0) return true;
    // Skip while a row inside this table has focus.
    if (tableEl && tableEl.contains(document.activeElement)) return true;
    // Skip if the user scrolled within the last 2s.
    if (Date.now() - lastScrollAt < 2000) return true;
    return false;
  }

  $effect(() => {
    const secs = REFRESH_SECONDS[refreshOpt];
    if (!secs) return;
    const id = setInterval(() => {
      if (shouldSkipTick()) return;
      loadTraces({ reset: true });
    }, secs * 1000);
    return () => clearInterval(id);
  });
</script>

<svelte:window onscroll={onScroll} />

<div class="toolbar">
  <label class="ar">
    <span class="ar-label">auto-refresh</span>
    <select value={refreshOpt} onchange={onRefreshChange}>
      {#each REFRESH_OPTIONS as opt (opt)}
        <option value={opt}>{opt}</option>
      {/each}
    </select>
    <span class="ar-state" title={refreshOpt === 'off' ? 'auto-refresh off' : `refreshing every ${REFRESH_SECONDS[refreshOpt]}s`}>
      {refreshOpt === 'off' ? '○ off' : `↻ ${refreshOpt}`}
    </span>
  </label>
</div>

<table bind:this={tableEl} onwheel={onScroll} ontouchmove={onScroll}>
  <thead>
    <tr>
      <th>time</th>
      <th>status</th>
      <th>path</th>
      <th>model</th>
      <th>key</th>
      <th>session</th>
    </tr>
  </thead>
  <tbody>
    {#each traces as t (t.id)}
      <tr
        data-id={t.id}
        class:selected={t.id === selectedId}
        onclick={() => onSelectTrace(t.id)}
      >
        <td class="t">{shortTs(t.ts_start)}</td>
        <td class="s {statusClass(t.status)}">{t.status ?? '—'}</td>
        <td>{t.path ?? ''}</td>
        <td class="m">{t.model ?? '—'}</td>
        <td class="k" title={t.key_hash ?? ''}>{(t.key_hash ?? '').slice(0, 8)}</td>
        <td class="sess" title={t.session_root_id ?? ''}
          >{shortId(t.session_root_id)}</td
        >
      </tr>
    {/each}
  </tbody>
</table>

<style>
  /* Mirrors the original #list table styles (index.html ~lines 116-148),
     translated onto the zinc palette in app.css:
       --line  -> --border
       --panel -> --bg-elev
       --panel-2 -> --bg-elev-2
       --muted / --fg-dim -> --fg-muted / --fg-dim
     Scoped so SessionsList can keep its own copy without collision. */

  table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--mono);
    font-size: 11.5px;
  }
  thead {
    position: sticky;
    top: 0;
    z-index: 1;
    background: var(--bg-elev);
  }
  th {
    text-align: left;
    padding: 7px 10px;
    color: var(--fg-muted);
    font-weight: 500;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
  }
  td {
    padding: 5px 10px;
    border-bottom: 1px solid var(--border);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 0; /* triggers ellipsis with table-layout: auto */
  }
  td.t { width: 88px; color: var(--fg-dim); }
  td.s { width: 44px; }
  td.m { width: 88px; color: var(--fg-dim); }
  td.k { width: 70px; color: var(--fg-muted); }
  td.sess { width: 80px; color: var(--fg-muted); }

  tbody tr { cursor: pointer; }
  tbody tr:hover { background: var(--bg-elev-2); }
  tbody tr.selected {
    background: rgba(94, 234, 212, 0.08);
    box-shadow: inset 2px 0 0 var(--accent);
  }

  /* status-class color hooks (defined here so the component is
     self-contained; identical to globals .st-2/.st-4/.st-5/.st-x in the
     original index.html lines 145-148). */
  td.s.st-2 { color: var(--ok); }
  td.s.st-4 { color: var(--warn); }
  td.s.st-5 { color: var(--err); }
  td.s.st-x { color: var(--fg-muted); }

  /* Thin auto-refresh toolbar above the table. Restrained — monospace,
     dim labels, the select inherits the global input styles. */
  .toolbar {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--gap-2);
    padding: var(--gap-1) var(--gap-2);
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
    font-family: var(--mono);
    font-size: 11px;
  }
  .ar {
    display: inline-flex;
    align-items: center;
    gap: var(--gap-2);
    color: var(--fg-dim);
  }
  .ar-label {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 10px;
  }
  .ar select {
    font-family: var(--mono);
    font-size: 11px;
    padding: 1px 4px;
  }
  .ar-state {
    color: var(--fg-muted);
    min-width: 3.5em;
    text-align: right;
  }
</style>
