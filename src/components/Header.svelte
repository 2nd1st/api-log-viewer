<script lang="ts">
  // Header / nav strip.
  //
  // The brand text "api-log/viewer" stays. Nav tabs are now:
  //   - Home     (#/landing)  — default home view; nav label reads "Home",
  //                             the route stays "/landing" for stable
  //                             bookmark surface. Component still named
  //                             Landing.svelte (internal naming).
  //   - Traces   (#/traces)   — list + detail surface
  //
  // The legacy Healthz tab is gone; the operator data is absorbed into
  // the Home view's "internal" section (see Landing.svelte). The legacy
  // #/dashboard route still resolves (App.svelte rewrites it to
  // #/landing on entry) so old bookmarks keep working.
  //
  // Phase L additions (2026-05-30):
  //   - Theme toggle button between status pill and token chip.
  //     Single click swaps dark <-> light and persists via lib/theme.
  //     Inline SVG glyphs only — no icon library.
  //   - CSS uses the Phase L tokens (--fg-muted, --border, --accent,
  //     --size-body, --size-meta, --font-mono).
  //
  // Phase 1 i18n additions (2026-05-30):
  //   - Nav labels and aria/title strings go through t() so they switch
  //     when the operator flips the language.
  //   - Small text-only language toggle ("EN" / "中") sits between the
  //     status pill and the theme toggle, mirroring the theme-toggle
  //     shape. setLang() persists to localStorage['apilog.lang'].
  //   - The status pill text itself is built upstream (App / TracesList)
  //     so we leave its rendering alone here; statusText is still a
  //     pass-through prop.

  import { getTheme, toggleTheme } from '../lib/theme';
  import { getLang, setLang, t } from '../lib/i18n.svelte';

  export type View = 'landing' | 'traces' | 'plugins' | 'export' | 'settings';
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

  let theme = $state(getTheme());
</script>

<header>
  <span class="brand">api-log<span class="slash">/</span>viewer</span>
  <nav>
    <a
      data-view="landing"
      href="#/landing"
      class:active={view === 'landing'}
    >{t('ui.nav.home')}</a>
    <a
      data-view="traces"
      href="#/traces"
      class:active={view === 'traces'}
    >{t('ui.nav.traces')}</a>
    <a
      data-view="plugins"
      href="#/plugins"
      class:active={view === 'plugins'}
    >{t('ui.nav.plugins')}</a>
    <a
      data-view="export"
      href="#/export"
      class:active={view === 'export'}
    >{t('ui.nav.export')}</a>
    <a
      data-view="settings"
      href="#/settings"
      class:active={view === 'settings'}
    >{t('ui.nav.settings')}</a>
  </nav>
  <div class="spacer"></div>
  <span
    class="status"
    class:bad={statusLevel === 'bad'}
    class:warn={statusLevel === 'warn'}
  >{statusText}</span>
  <button
    type="button"
    class="lang-toggle"
    aria-label={t('ui.langToggle')}
    title={t('ui.langToggle')}
    onclick={() => { setLang(getLang() === 'en' ? 'zh' : 'en'); }}
  >{getLang() === 'en' ? 'EN' : '中'}</button>
  <button
    type="button"
    class="theme-toggle"
    aria-label={t('ui.themeToggle')}
    title={t('ui.themeToggle')}
    onclick={() => { theme = toggleTheme(); }}
  >
    {#if theme === 'dark'}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
      </svg>
    {:else}
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="4"/>
        <path d="M12 2v2"/>
        <path d="M12 20v2"/>
        <path d="M4.93 4.93l1.41 1.41"/>
        <path d="M17.66 17.66l1.41 1.41"/>
        <path d="M2 12h2"/>
        <path d="M20 12h2"/>
        <path d="M4.93 19.07l1.41-1.41"/>
        <path d="M17.66 6.34l1.41-1.41"/>
      </svg>
    {/if}
  </button>
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
  /* Tokens: see app.css. Header uses --surface for fill, --border for
     the bottom hairline, --fg-muted/--fg for nav contrast, --accent
     for the active underline. */
  header {
    display: flex;
    align-items: center;
    gap: 20px;
    padding: 0 var(--space-4);
    height: 38px;
    flex: none;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .brand {
    font-family: var(--font-mono);
    font-size: var(--size-body);
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
    padding: 0 var(--space-3);
    color: var(--fg-muted);
    font-size: var(--size-body);
    border-bottom: 1px solid transparent;
    margin-bottom: -1px;
    text-decoration: none;
  }
  nav a:hover {
    color: var(--fg);
    text-decoration: none;
  }
  nav a.active {
    color: var(--fg);
    border-bottom-color: var(--accent);
  }
  .spacer { flex: 1; }
  .status {
    font-family: var(--font-mono);
    font-size: var(--size-meta);
    color: var(--fg-muted);
  }
  .status.bad { color: var(--err); }
  .status.warn { color: var(--warn); }

  .theme-toggle {
    background: transparent;
    border: 0;
    color: var(--fg-dim);
    padding: 4px;
    cursor: pointer;
    line-height: 0;
    border-radius: var(--radius-md);
  }
  .theme-toggle:hover { color: var(--fg); }
  .theme-toggle svg {
    display: block;
    width: 16px;
    height: 16px;
  }

  /* Language toggle — text-only sibling of .theme-toggle. 10px sans,
     dim → bright on hover. No border, no background; same 4px hit area
     so it doesn't visually outweigh the theme glyph next to it. */
  .lang-toggle {
    background: transparent;
    border: 0;
    color: var(--fg-dim);
    padding: 4px;
    cursor: pointer;
    font-family: var(--font-sans);
    font-size: var(--size-label);
    line-height: 1;
    letter-spacing: 0.04em;
    border-radius: var(--radius-md);
    transition: color 150ms ease-out;
  }
  .lang-toggle:hover { color: var(--fg); }

  .icon-btn {
    background: none;
    border: none;
    color: var(--fg-muted);
    padding: 4px;
    cursor: pointer;
    font: inherit;
    line-height: 1;
    border-radius: var(--radius-md);
  }
  .icon-btn:hover { color: var(--fg); }
  .icon-btn svg {
    display: block;
    width: 14px;
    height: 14px;
  }
</style>
