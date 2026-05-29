<script lang="ts">
  // App.svelte — top-level shell.
  //
  // Direct 1:1 port of the IIFE at the bottom of the original viewer
  // (api-log/internal/viewer/static/index.html lines ~525-1420). This
  // component is pure composition: it owns the top-level state object
  // (view, listMode, selectedId, filter values, datalist suggestion sets,
  // status banner text/kind, auth-modal visibility, pager state) and
  // wires every sibling component together exactly the way the original
  // IIFE wired its DOM lookups.
  //
  // What this file is NOT responsible for (lives in sibling components):
  //   - Header markup & CSS                     (components/Header.svelte)
  //   - Filter sidebar + datalists              (components/FilterSidebar.svelte)
  //   - Traces / sessions mode toggle           (components/ListModeToggle.svelte)
  //   - Traces list table + pager methods       (components/TracesList.svelte)
  //   - Sessions list table                     (components/SessionsList.svelte)
  //   - Detail head/meta/tabs/loading           (components/DetailPanel.svelte)
  //   - Each tab body                           (components/tabs/*.svelte)
  //   - Healthz dashboard + polling             (components/HealthzView.svelte)
  //   - Auth modal                              (components/AuthModal.svelte)
  //   - Auth/token plumbing                     (lib/api.ts)
  //
  // Behavior preserved 1:1 with the legacy IIFE:
  //   - hash routing via window.addEventListener('hashchange', applyHash)
  //   - default path filter from localStorage['apilog.default_path']
  //     (consumed via DEFAULT_PATH_FILTER from lib/api.ts)
  //   - boot: if (!token) showAuthModal(); applyHash();
  //   - Refresh button: reloads list in traces view, polls healthz once
  //     in healthz view.
  //   - Pager: prev / next call into TracesList exposed methods; sessions
  //     mode keeps both disabled (matches original renderSessionsList).
  //   - Session-row click in SessionsList: open latest trace in session
  //     (handled inside SessionsList; surfaces id via onSelectTrace).

  import {
    DEFAULT_PATH_FILTER,
    authFetch,
    getToken,
    registerAuthModalHandler,
  } from './lib/api';

  import Header from './components/Header.svelte';
  import FilterSidebar from './components/FilterSidebar.svelte';
  import type { Filters } from './components/FilterSidebar.svelte';
  import ListModeToggle from './components/ListModeToggle.svelte';
  import type { ListMode } from './components/ListModeToggle.svelte';
  import TracesList from './components/TracesList.svelte';
  import SessionsList from './components/SessionsList.svelte';
  import DetailPanel from './components/DetailPanel.svelte';
  import type { TabBodyCtx } from './components/DetailPanel.svelte';
  import HealthzView from './components/HealthzView.svelte';
  import AuthModal from './components/AuthModal.svelte';

  import ConversationTab from './components/tabs/ConversationTab.svelte';
  import OverviewTab from './components/tabs/OverviewTab.svelte';
  import HeadersTab from './components/tabs/HeadersTab.svelte';
  import BodyTab from './components/tabs/BodyTab.svelte';
  import EventsTab from './components/tabs/EventsTab.svelte';
  import SessionTab from './components/tabs/SessionTab.svelte';
  import ReplayTab from './components/tabs/ReplayTab.svelte';

  // ---------- top-level state (matches the `state` object in the IIFE) ----------

  type View = 'traces' | 'healthz';

  let view = $state<View>('traces');
  let listMode = $state<ListMode>('traces');

  // Selected trace id — drives the .selected row class in TracesList AND
  // the traceId prop on DetailPanel (which does its own fetch + hash).
  let selectedId = $state<string | null>(null);

  // Filter values — initial path seeded from DEFAULT_PATH_FILTER, matching
  // the original boot snippet `if ($('f-path').value === '') $('f-path').value = DEFAULT_PATH_FILTER;`
  let filters = $state<Filters>({
    status: '',
    path: DEFAULT_PATH_FILTER,
    model: '',
    key_hash: '',
    session_root_id: '',
    since: '',
    limit: '100',
  });

  // Datalist accumulation sets — TracesList writes into these via $bindable.
  let knownPaths = $state<Set<string>>(new Set());
  let knownModels = $state<Set<string>>(new Set());
  let knownKeys = $state<Set<string>>(new Set());

  // Status banner state — original setStatus() target. Header renders it.
  // StatusKind 'good' has no CSS rule in the original, so map it to '' for
  // Header's statusLevel ('' | 'bad' | 'warn'); the legacy CSS only styled
  // .bad and .warn.
  type StatusKind = 'good' | 'bad' | 'warn' | '';
  let statusText = $state<string>('connecting…');
  let statusKind = $state<StatusKind>('');

  function setStatus(text: string, kind: StatusKind = ''): void {
    statusText = text;
    statusKind = kind;
  }

  // Auth modal visibility. bindable on AuthModal.
  let authModalOpen = $state<boolean>(false);

  // Reload keys — bump to force a fresh fetch in TracesList / SessionsList
  // without their filters-as-props triggering on every keystroke. Mirrors
  // the original event-driven loadList({ reset: true }) calls.
  let tracesReloadKey = $state<number>(0);
  let sessionsReloadKey = $state<number>(0);
  let healthzReloadKey = $state<number>(0);

  // Pager state — App owns the UI, TracesList drives the data via the
  // onPagerChange callback. SessionsList disables both buttons.
  let pagerPrevDisabled = $state<boolean>(true);
  let pagerNextDisabled = $state<boolean>(true);
  let pagerInfo = $state<string>('—');

  // Imperative handle on TracesList so the pager buttons can call its
  // exported next() / prev() methods (matches original page-next / page-prev
  // click handlers calling loadTraces({ cursor }) with stack bookkeeping).
  let tracesListRef = $state<TracesList | null>(null);

  // ---------- auth modal hook (top-level init, not $effect) ----------
  //
  // Register at module init so any 401 / no-token authFetch in a child
  // $effect that runs before App's effects still pops the modal.
  registerAuthModalHandler(() => {
    authModalOpen = true;
  });

  // ---------- hash routing (1:1 port of applyHash) ----------

  // Strict route enum — unknown routes log a warn and fall back to
  // 'traces' explicitly. Add new views here as they ship (export,
  // settings, dashboard, etc.) so typos surface immediately.
  const KNOWN_VIEWS: readonly View[] = ['traces', 'healthz'];

  function applyHash(): void {
    const h = window.location.hash || '#/traces';
    const parts = h.split('/');
    const v = (parts[1] || 'traces') as View;
    if (KNOWN_VIEWS.includes(v)) {
      view = v;
    } else {
      console.warn(`[apilog] unknown route ${h}, falling back to #/traces`);
      view = 'traces';
    }
    if (view === 'traces' && parts[2]) {
      const id = parts[2];
      if (id !== selectedId) selectedId = id;
    }
  }

  // Listen for browser-driven hash changes. The token-save / parent-link /
  // row-click paths use history.replaceState which does NOT fire hashchange,
  // so there's no loop.
  $effect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  });

  // ---------- selection handlers ----------
  //
  // Row click in TracesList → setSelectedId. DetailPanel's $effect on
  // traceId handles the fetch + history.replaceState. The original
  // selectTrace() did all of that imperatively; DetailPanel encapsulates it.
  function onSelectTrace(id: string): void {
    selectedId = id;
  }

  // ---------- header button handlers ----------

  function onRefresh(): void {
    if (view === 'traces') {
      // Mirror: loadList({ reset: true }) — same key bump as Apply / Clear.
      if (listMode === 'traces') tracesReloadKey++;
      else sessionsReloadKey++;
    } else {
      // Healthz: original called loadHealthz() directly. HealthzView's
      // $effect re-runs on key change; bumping remounts it which kicks off
      // an immediate fetch (same end result as a discrete loadHealthz()).
      healthzReloadKey++;
    }
  }

  function onAuth(): void {
    authModalOpen = true;
  }

  // ---------- filter sidebar handlers ----------
  //
  // Apply / Clear / Enter / status-change all funnel into one place in the
  // original (loadList({ reset: true })). We mirror that by bumping the
  // active mode's reload key — TracesList's $effect re-runs with reset.

  function onApplyFilters(): void {
    if (listMode === 'traces') tracesReloadKey++;
    else sessionsReloadKey++;
  }

  function onClearFilters(): void {
    // FilterSidebar already mutated `filters` back to defaults (including
    // restoring DEFAULT_PATH_FILTER in path and '100' in limit). All we
    // owe is the reload, matching the original f-clear handler tail.
    if (listMode === 'traces') tracesReloadKey++;
    else sessionsReloadKey++;
  }

  // ---------- mode toggle ----------
  //
  // ListModeToggle is bindable; it flips `listMode` itself. The onChange
  // callback exists so the parent can trigger the reload (matches the
  // original switchMode → loadList({ reset: true }) wiring).
  function onModeChange(m: ListMode): void {
    // Mode switch already remounts the active list (different {#if} branch),
    // which triggers its mount-time load. No extra key bump needed — but
    // selectedId stays so the previously selected trace remains highlighted
    // when the user toggles back. Matches the original state.selectedId
    // persistence across mode switches.
    void m;
  }

  // ---------- pager handlers ----------

  function onPagerNext(): void {
    tracesListRef?.next();
  }

  function onPagerPrev(): void {
    tracesListRef?.prev();
  }

  function onTracesPagerChange(s: {
    prevDisabled: boolean;
    nextDisabled: boolean;
    info: string;
  }): void {
    pagerPrevDisabled = s.prevDisabled;
    pagerNextDisabled = s.nextDisabled;
    pagerInfo = s.info;
  }

  function onSessionsPagerChange(s: {
    prevDisabled: boolean;
    nextDisabled: boolean;
    info: string;
  }): void {
    // Sessions mode always disables both (matches original renderSessionsList).
    pagerPrevDisabled = s.prevDisabled;
    pagerNextDisabled = s.nextDisabled;
    pagerInfo = s.info;
  }

  // ---------- auth-modal saved → reload current view ----------
  //
  // Mirror of the original token-save click tail:
  //   if (state.view === 'traces') loadList({ reset: true });
  //   else loadHealthz();
  function onTokenSaved(): void {
    if (view === 'traces') {
      if (listMode === 'traces') tracesReloadKey++;
      else sessionsReloadKey++;
    } else {
      healthzReloadKey++;
    }
  }

  // ---------- boot sequence ----------
  //
  // 1) If no token on disk, pop the modal (operator sees it immediately).
  // 2) applyHash() — picks view + selectedId from the URL, kicks off the
  //    initial list load via the mounted TracesList's own $effect.
  $effect(() => {
    if (!getToken()) authModalOpen = true;
    applyHash();
  });

  // Map StatusKind → Header's statusLevel. The original CSS had no .good
  // rule, so 'good' renders as the default muted color (same as '').
  const statusLevel = $derived(
    statusKind === 'bad' ? 'bad' : statusKind === 'warn' ? 'warn' : '',
  );
</script>

<Header
  {view}
  {statusText}
  {statusLevel}
  {onRefresh}
  {onAuth}
/>

<main>
  {#if view === 'traces'}
  <section id="traces">
    <FilterSidebar
      bind:values={filters}
      {knownPaths}
      {knownModels}
      {knownKeys}
      onApply={onApplyFilters}
      onClear={onClearFilters}
    />

    <div id="list">
      <ListModeToggle bind:mode={listMode} onChange={onModeChange} />

      <div class="table-wrap">
        {#if listMode === 'traces'}
          <TracesList
            bind:this={tracesListRef}
            {filters}
            {selectedId}
            reloadKey={tracesReloadKey}
            reloadResets={true}
            bind:knownPaths
            bind:knownModels
            bind:knownKeys
            {authFetch}
            onStatus={setStatus}
            {onSelectTrace}
            onPagerChange={onTracesPagerChange}
          />
        {:else}
          <SessionsList
            filters={{ since: filters.since, limit: filters.limit }}
            reloadKey={sessionsReloadKey}
            {authFetch}
            {setStatus}
            {onSelectTrace}
            onPagerChange={onSessionsPagerChange}
          />
        {/if}
      </div>

      <div class="pager">
        <button
          type="button"
          onclick={onPagerPrev}
          disabled={pagerPrevDisabled}
        >← prev</button>
        <button
          type="button"
          onclick={onPagerNext}
          disabled={pagerNextDisabled}
        >next →</button>
        <span class="info">{pagerInfo}</span>
      </div>
    </div>

    <DetailPanel
      traceId={selectedId}
      {authFetch}
      onSelect={(id) => (selectedId = id)}
    >
      {#snippet tabBody({ detail, tab, convoIncludeSession, setConvoIncludeSession }: TabBodyCtx)}
        {#if tab === 'conversation'}
          <!-- ConversationTab's Row.path is required; TraceRow.path is optional.
               Fall back to '' so the protocol-detection branches see an empty
               string (same effect as `path && path.indexOf(...) !== -1` being
               false for every branch — matches original behavior for a
               path-less row). -->
          <ConversationTab
            row={{
              ...detail.row,
              path: detail.row.path ?? '',
              ts_start: detail.row.ts_start ?? undefined,
            }}
            trace={detail.trace ?? {}}
            includeSession={convoIncludeSession}
            onIncludeSessionToggle={setConvoIncludeSession}
          />
        {:else if tab === 'overview'}
          <OverviewTab row={detail.row} />
        {:else if tab === 'headers'}
          <HeadersTab trace={detail.trace} />
        {:else if tab === 'body'}
          <BodyTab trace={detail.trace} />
        {:else if tab === 'events'}
          <EventsTab trace={detail.trace} />
        {:else if tab === 'session'}
          <SessionTab row={detail.row} onSelect={(id) => (selectedId = id)} />
        {:else if tab === 'replay'}
          <!-- ReplayTab uses trace.id to build the replay URL; the trace
               *blob* has no id, only detail.row does. Pass the row. -->
          <ReplayTab trace={detail.row} />
        {/if}
      {/snippet}
    </DetailPanel>
  </section>
  {/if}

  {#if view === 'healthz'}
  <section id="healthz">
    {#key healthzReloadKey}
      <HealthzView {authFetch} {setStatus} />
    {/key}
  </section>
  {/if}
</main>

<AuthModal bind:open={authModalOpen} onSaved={onTokenSaved} />

<style>
  /* ---------- main shell ----------
     `flex: 1; overflow: hidden` so the inner panels (filters, list,
     detail) own their own scroll regions. Only one view is mounted at
     a time (via {#if view === ...}) so we don't need .active toggling.
  */
  main {
    flex: 1;
    overflow: hidden;
    display: flex;
    min-height: 0;
  }

  /* ---------- traces view: filter / list / detail ----------
     Same horizontal three-pane layout the original used. */
  #traces {
    flex: 1;
    display: flex;
    flex-direction: row;
    min-height: 0;
    min-width: 0;
  }

  /* ---------- list pane ----------
     Width 52%, min/max, right border, vertical stack: list-mode toggle
     on top, scrollable table in the middle, pager on the bottom.
     Matches original #list (lines 116-120, 150-164). */
  #list {
    width: 52%;
    min-width: 380px;
    max-width: 720px;
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  #list .table-wrap {
    flex: 1;
    overflow: auto;
    min-height: 0;
  }

  /* ---------- pager ----------
     Original lines 150-164: thin bar at the bottom of #list, with two
     buttons and a right-aligned info span. */
  #list .pager {
    flex: none;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 7px 10px;
    border-top: 1px solid var(--border);
    background: var(--bg-elev);
    font-family: var(--mono);
    font-size: 11px;
  }
  #list .pager button {
    background: var(--bg);
    color: var(--fg-muted);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 2px 8px;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
  }
  #list .pager button:hover:not(:disabled) {
    color: var(--fg);
    border-color: var(--border-strong);
  }
  #list .pager button:disabled {
    opacity: 0.35;
    cursor: default;
  }
  #list .pager .info {
    margin-left: auto;
    color: var(--fg-muted);
  }

  /* ---------- healthz view container ----------
     Column layout with padding so cards don't run to the edge.
     HealthzView owns its own .cards grids. */
  #healthz {
    flex: 1;
    display: flex;
    flex-direction: column;
    padding: 0;
    overflow: auto;
    min-height: 0;
  }
</style>
