<script lang="ts">
  // App.svelte — top-level shell.
  //
  // Owns the top-level state (view, listMode, selectedId, filter values,
  // datalist suggestion sets, status banner text/kind, auth-modal
  // visibility, pager state) and wires every sibling component together.
  //
  // Routing (as of the dashboard switch):
  //   #/                  -> Dashboard (default)
  //   #/dashboard         -> Dashboard
  //   #/traces            -> traces list + detail panel
  //   #/traces/<id>       -> traces list + that trace selected
  //   anything else       -> console.warn + fall back to #/dashboard
  //
  // The boot $effect calls applyHash(); if no hash on first load we
  // explicitly set #/dashboard so the URL matches the rendered view.
  //
  // What this file is NOT responsible for (lives in sibling components):
  //   - Header markup & CSS                     (components/Header.svelte)
  //   - Default home page                        (components/Dashboard.svelte)
  //   - Filter sidebar + datalists              (components/FilterSidebar.svelte)
  //   - Traces / sessions mode toggle           (components/ListModeToggle.svelte)
  //   - Traces list table + pager methods       (components/TracesList.svelte)
  //   - Sessions list table                     (components/SessionsList.svelte)
  //   - Detail head/meta/tabs/loading           (components/DetailPanel.svelte)
  //   - Each tab body                           (components/tabs/*.svelte)
  //   - Auth modal                              (components/AuthModal.svelte)
  //   - Auth/token plumbing                     (lib/api.ts)

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
  import Dashboard from './components/Dashboard.svelte';
  import AuthModal from './components/AuthModal.svelte';

  import ConversationTab from './components/tabs/ConversationTab.svelte';
  import OverviewTab from './components/tabs/OverviewTab.svelte';
  import HeadersTab from './components/tabs/HeadersTab.svelte';
  import BodyTab from './components/tabs/BodyTab.svelte';

  // ---------- top-level state ----------

  type View = 'dashboard' | 'traces';

  let view = $state<View>('dashboard');
  let listMode = $state<ListMode>('traces');

  let selectedId = $state<string | null>(null);

  let filters = $state<Filters>({
    status: '',
    path: DEFAULT_PATH_FILTER,
    model: '',
    key_hash: '',
    session_root_id: '',
    since: '',
    limit: '100',
  });

  let knownPaths = $state<Set<string>>(new Set());
  let knownModels = $state<Set<string>>(new Set());
  let knownKeys = $state<Set<string>>(new Set());

  type StatusKind = 'good' | 'bad' | 'warn' | '';
  let statusText = $state<string>('connecting…');
  let statusKind = $state<StatusKind>('');

  function setStatus(text: string, kind: StatusKind = ''): void {
    statusText = text;
    statusKind = kind;
  }

  let authModalOpen = $state<boolean>(false);

  let tracesReloadKey = $state<number>(0);
  let sessionsReloadKey = $state<number>(0);
  let dashboardReloadKey = $state<number>(0);

  let pagerPrevDisabled = $state<boolean>(true);
  let pagerNextDisabled = $state<boolean>(true);
  let pagerInfo = $state<string>('—');

  let tracesListRef = $state<TracesList | null>(null);

  // ---------- auth modal hook ----------
  registerAuthModalHandler(() => {
    authModalOpen = true;
  });

  // ---------- hash routing ----------
  //
  // KNOWN_VIEWS is the allowlist; anything else logs a warn and falls
  // back to 'dashboard'. The legacy #/healthz route is gone — the dashboard
  // absorbed its content via Dashboard.svelte's "internal" section.
  const KNOWN_VIEWS: readonly View[] = ['dashboard', 'traces'];

  function applyHash(): void {
    const h = window.location.hash;
    // Empty hash / `#` / `#/` all map to dashboard.
    if (!h || h === '#' || h === '#/') {
      view = 'dashboard';
      return;
    }
    const parts = h.split('/');
    const v = (parts[1] || 'dashboard') as View;
    if ((KNOWN_VIEWS as readonly string[]).includes(v)) {
      view = v;
    } else {
      console.warn(`[apilog] unknown route ${h}, falling back to #/dashboard`);
      view = 'dashboard';
    }
    if (view === 'traces' && parts[2]) {
      const id = parts[2];
      if (id !== selectedId) selectedId = id;
    }
  }

  $effect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('hashchange', applyHash);
    return () => window.removeEventListener('hashchange', applyHash);
  });

  // ---------- selection handlers ----------

  function onSelectTrace(id: string): void {
    selectedId = id;
    // If a dashboard activity-row click bumped us here, switch the view
    // so the detail panel actually shows up.
    if (view !== 'traces') {
      view = 'traces';
      if (typeof window !== 'undefined') {
        history.replaceState(null, '', `#/traces/${id}`);
      }
    }
  }

  // ---------- header button handlers ----------

  function onRefresh(): void {
    if (view === 'traces') {
      if (listMode === 'traces') tracesReloadKey++;
      else sessionsReloadKey++;
    } else {
      // dashboard
      dashboardReloadKey++;
    }
  }

  function onAuth(): void {
    authModalOpen = true;
  }

  // ---------- filter sidebar handlers ----------

  function onApplyFilters(): void {
    if (listMode === 'traces') tracesReloadKey++;
    else sessionsReloadKey++;
  }

  function onClearFilters(): void {
    if (listMode === 'traces') tracesReloadKey++;
    else sessionsReloadKey++;
  }

  // ---------- mode toggle ----------
  function onModeChange(m: ListMode): void {
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
    pagerPrevDisabled = s.prevDisabled;
    pagerNextDisabled = s.nextDisabled;
    pagerInfo = s.info;
  }

  // ---------- auth-modal saved → reload current view ----------
  function onTokenSaved(): void {
    if (view === 'traces') {
      if (listMode === 'traces') tracesReloadKey++;
      else sessionsReloadKey++;
    } else {
      dashboardReloadKey++;
    }
  }

  // ---------- boot sequence ----------
  //
  // 1) If no token on disk, pop the modal.
  // 2) If there's no hash, force #/dashboard so the URL reflects the view.
  // 3) applyHash() picks view + selectedId from the URL.
  $effect(() => {
    if (!getToken()) authModalOpen = true;
    if (typeof window !== 'undefined') {
      if (!window.location.hash) {
        history.replaceState(null, '', '#/dashboard');
      }
    }
    applyHash();
  });

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
  {#if view === 'dashboard'}
  <section id="dashboard">
    {#key dashboardReloadKey}
      <Dashboard {authFetch} {onSelectTrace} />
    {/key}
  </section>
  {/if}

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
        {#if tab === 'overview'}
          <OverviewTab
            row={detail.row}
            trace={detail.trace ?? {}}
            {authFetch}
            onSelect={(id) => (selectedId = id)}
          />
        {:else if tab === 'conversation'}
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
        {:else if tab === 'headers'}
          <HeadersTab trace={detail.trace} />
        {:else if tab === 'body'}
          <BodyTab trace={detail.trace} />
        {/if}
      {/snippet}
    </DetailPanel>
  </section>
  {/if}
</main>

<AuthModal bind:open={authModalOpen} onSaved={onTokenSaved} />

<style>
  main {
    flex: 1;
    overflow: hidden;
    display: flex;
    min-height: 0;
  }

  #dashboard {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 0;
  }

  #traces {
    flex: 1;
    display: flex;
    flex-direction: row;
    min-height: 0;
    min-width: 0;
  }

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
</style>
