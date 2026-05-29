<script lang="ts">
  // Header / nav strip.
  //
  // Ported 1:1 from internal/viewer/static/index.html (the <header> block
  // around lines 409-423 plus the matching CSS at lines 38-66). Includes:
  //   - brand text "api-log/viewer" with a muted slash
  //   - hash-based nav tabs (Traces, Healthz)
  //   - status indicator (connecting…, may carry .bad or .warn class)
  //   - refresh icon button
  //   - auth icon button (opens the admin-token modal in the parent)
  //
  // The original was string-driven (querySelectorAll('#nav a') + classList
  // toggles). In the Svelte port the parent owns `view` (so routing /
  // list-loading code can react to it via $effect), the status text +
  // level, and the click callbacks. The brand string, nav labels, hash
  // targets (#/traces, #/healthz) and SVG icons are reproduced verbatim
  // so behavior is indistinguishable from the original.
  //
  // Note on routing: the original wires hash changes via
  // window.addEventListener('hashchange', applyHash). That global wiring
  // lives at the App.svelte level — this component just renders <a> tags
  // that point at #/traces and #/healthz the same way the original did,
  // and reflects the current `view` value via the .active class.

  export type View = 'traces' | 'healthz';
  export type StatusLevel = '' | 'bad' | 'warn';

  interface Props {
    /** Currently active view; drives which nav tab gets .active. */
    view: View;
    /** Status text shown to the right of the nav. Original default: "connecting…". */
    statusText?: string;
    /** Status severity → maps to .bad / .warn CSS classes. Empty = neutral. */
    statusLevel?: StatusLevel;
    /** Refresh button click; original wiring was `#refresh` → reload. */
    onRefresh?: () => void;
    /** Auth button click; original wiring was `#auth-btn` → showAuthModal. */
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
      data-view="traces"
      href="#/traces"
      class:active={view === 'traces'}
    >Traces</a>
    <a
      data-view="healthz"
      href="#/healthz"
      class:active={view === 'healthz'}
    >Healthz</a>
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
  /* Mirrors the original "header" CSS block from index.html lines 38-66,
     translated to the new variable names defined in app.css:
       --line       -> --border
       --muted      -> --fg-muted
       --fg-dim     -> --fg-dim (unchanged)
       --panel      -> --bg-elev
       --bad        -> --err
       --warn       -> --warn
     Layout numbers (38px height, 16px padding, 20px gap, 14px icons,
     12px brand/nav font, 11px status font, 12px nav padding) are kept
     identical so the strip lines up the same way at the same density. */
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
