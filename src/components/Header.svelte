<script lang="ts">
  // Header / nav strip.
  //
  // The brand text "api-log/viewer" stays. Nav tabs are now:
  //   - Landing  (#/landing)  — default home view
  //   - Traces   (#/traces)   — list + detail surface
  //
  // The legacy Healthz tab is gone; the operator data is absorbed into
  // the Landing's "internal" section (see Landing.svelte). The legacy
  // #/dashboard route still resolves (App.svelte rewrites it to
  // #/landing on entry) so old bookmarks keep working.
  //
  // The parent owns `view`, the status text + level, and the click
  // callbacks. The <a href="#/..."> tags rely on the App.svelte
  // hashchange listener to drive the actual route change.

  export type View = 'landing' | 'traces';
  export type StatusLevel = '' | 'bad' | 'warn';

  interface Props {
    /** Currently active view; drives which nav tab gets .active. */
    view: View;
    /** Status text shown to the right of the nav. */
    statusText?: string;
    /** Status severity → maps to .bad / .warn CSS classes. */
    statusLevel?: StatusLevel;
    /** Refresh button click. */
    onRefresh?: () => void;
    /** Auth button click. */
    onAuth?: () => void;
  }

  let {
    view,
    statusText = 'connecting…',
    statusLevel = '',
    onRefresh,
    onAuth,
  }: Props = $props();
</script>

<header>
  <span class="brand">api-log<span class="slash">/</span>viewer</span>
  <nav>
    <a
      data-view="landing"
      href="#/landing"
      class:active={view === 'landing'}
    >Landing</a>
    <a
      data-view="traces"
      href="#/traces"
      class:active={view === 'traces'}
    >Traces</a>
  </nav>
  <div class="spacer"></div>
  <span
    class="status"
    class:bad={statusLevel === 'bad'}
    class:warn={statusLevel === 'warn'}
  >{statusText}</span>
  <button
    type="button"
    class="icon-btn"
    title="reload"
    onclick={() => onRefresh?.()}
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path></svg>
  </button>
  <button
    type="button"
    class="icon-btn"
    title="set admin token"
    onclick={() => onAuth?.()}
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
  </button>
</header>

<style>
  /* Mirrors the original header CSS, translated to app.css palette:
       --line       -> --border
       --muted      -> --fg-muted
       --fg-dim     -> --fg-dim
       --panel      -> --bg-elev
       --bad        -> --err
       --warn       -> --warn
  */
  header {
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 0 16px;
    height: 38px;
    flex: none;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
  }
  .brand {
    font-family: var(--mono);
    font-size: 12px;
    font-weight: 600;
    color: var(--fg);
    letter-spacing: 0;
  }
  .brand .slash { color: var(--fg-muted); }
  nav {
    display: flex;
    gap: 0;
    height: 100%;
  }
  nav a {
    display: flex;
    align-items: center;
    padding: 0 12px;
    color: var(--fg-muted);
    font-size: 12px;
    border-bottom: 1px solid transparent;
    margin-bottom: -1px;
    text-decoration: none;
  }
  nav a:hover {
    color: var(--fg-dim);
    text-decoration: none;
  }
  nav a.active {
    color: var(--fg);
    border-bottom-color: var(--accent);
  }
  .spacer { flex: 1; }
  .status {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--fg-muted);
  }
  .status.bad { color: var(--err); }
  .status.warn { color: var(--warn); }
  .icon-btn {
    background: none;
    border: none;
    color: var(--fg-muted);
    padding: 4px;
    cursor: pointer;
    font: inherit;
    line-height: 1;
    border-radius: var(--radius);
  }
  .icon-btn:hover { color: var(--fg); }
  .icon-btn svg {
    display: block;
    width: 14px;
    height: 14px;
  }
</style>
