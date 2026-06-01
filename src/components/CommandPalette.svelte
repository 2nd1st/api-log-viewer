<script lang="ts">
  // CommandPalette — Cmd+K overlay.
  //
  // Indexes three families:
  //   ROUTES: Home, Traces, Export, Settings
  //   FILTER PRESETS: status≥400, last 24h, Claude only, OpenAI only
  //     NOTE: presets currently navigate to #/traces without query params;
  //     App.svelte's applyHash() splits on `/` and would bounce
  //     `#/traces?status=400` back to
  //     #/landing.
  //   RECENT TRACES: passed in via `recentTraces` prop, no API call
  //
  // The component owns its open/closed state. App.svelte binds the
  // global Cmd+K shortcut, and on open we receive a callback via
  // onOpenPalette() from lib/keyboard.ts.

  import { onMount } from 'svelte';
  import { onOpenPalette } from '../lib/keyboard';
  import type { TraceRow } from '../lib/trace';
  import { t } from '../lib/i18n.svelte';

  interface Props {
    /** Recent trace rows for the "RECENT TRACES" section. Empty arrays render the empty state. */
    recentTraces?: TraceRow[];
  }

  let { recentTraces = [] }: Props = $props();

  type Entry =
    | { kind: 'route'; label: string; hint: string; href: string }
    | { kind: 'preset'; label: string; hint: string; href: string }
    | { kind: 'trace'; label: string; hint: string; href: string };

  let open = $state<boolean>(false);
  let query = $state<string>('');
  let selectedIdx = $state<number>(0);
  let inputEl = $state<HTMLInputElement | null>(null);

  // ---------- entries ----------
  //
  // ROUTES and PRESETS are derived rather than const so they pick up
  // the active language. t() reads the lang cell on each call, so any
  // template using ROUTES/PRESETS re-renders on setLang() flip.

  const ROUTES: Entry[] = $derived([
    { kind: 'route', label: t('ui.nav.home'),     hint: '#/landing',  href: '#/landing' },
    { kind: 'route', label: t('ui.nav.traces'),   hint: '#/traces',   href: '#/traces' },
    { kind: 'route', label: t('ui.nav.export'),   hint: '#/export',   href: '#/export' },
    { kind: 'route', label: t('ui.nav.settings'), hint: '#/settings', href: '#/settings' },
  ]);

  // Filter presets — see comment at top of file re: hint vs. href.
  // hint shows the operator-facing query the preset represents;
  // href stays at plain #/traces until hash query-param routing exists.
  const PRESETS: Entry[] = $derived([
    { kind: 'preset', label: t('palette.preset4xx5xx'),   hint: t('palette.preset4xx5xxHint'),   href: '#/traces' },
    { kind: 'preset', label: t('palette.presetLast24h'),  hint: t('palette.presetLast24hHint'),  href: '#/traces' },
    { kind: 'preset', label: t('palette.presetClaude'),   hint: t('palette.presetClaudeHint'),   href: '#/traces' },
    { kind: 'preset', label: t('palette.presetOpenAI'),   hint: t('palette.presetOpenAIHint'),   href: '#/traces' },
  ]);

  // ---------- recent traces → entries ----------

  function traceEntries(rows: TraceRow[]): Entry[] {
    return rows.slice(0, 10).map((r) => {
      const path = r.path ?? '';
      const status = r.status == null ? '—' : String(r.status);
      const idSuffix = r.id ? r.id.slice(-8) : '';
      return {
        kind: 'trace',
        label: path || r.id || '(unknown)',
        hint: `${status} · ${idSuffix}`,
        href: r.id ? `#/traces/${r.id}` : '#/traces',
      } as Entry;
    });
  }

  // ---------- filtered groups ----------

  function matches(e: Entry, q: string): boolean {
    if (!q) return true;
    const needle = q.toLowerCase();
    return (
      e.label.toLowerCase().includes(needle) ||
      e.hint.toLowerCase().includes(needle)
    );
  }

  const routesFiltered  = $derived(ROUTES.filter((e)  => matches(e, query)));
  const presetsFiltered = $derived(PRESETS.filter((e) => matches(e, query)));
  const recentFiltered  = $derived(traceEntries(recentTraces).filter((e) => matches(e, query)));

  // Flat list for keyboard nav — order must match render order.
  const flat = $derived<Entry[]>([
    ...routesFiltered,
    ...presetsFiltered,
    ...recentFiltered,
  ]);

  // Clamp selection when results shrink.
  $effect(() => {
    if (selectedIdx >= flat.length) selectedIdx = Math.max(0, flat.length - 1);
  });

  // ---------- open / close ----------

  function show(): void {
    open = true;
    query = '';
    selectedIdx = 0;
    // Defer focus until the input mounts.
    queueMicrotask(() => inputEl?.focus());
  }

  function hide(): void {
    open = false;
  }

  function activate(e: Entry): void {
    hide();
    // Hash navigation triggers the App.svelte hashchange listener,
    // which routes the view. For same-hash clicks (e.g., already on
    // #/traces and clicking Traces) the browser is a no-op; that's
    // fine — the palette closes either way.
    window.location.hash = e.href;
  }

  function onKeydown(e: KeyboardEvent): void {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      hide();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (flat.length > 0) selectedIdx = (selectedIdx + 1) % flat.length;
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (flat.length > 0) selectedIdx = (selectedIdx - 1 + flat.length) % flat.length;
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const entry = flat[selectedIdx];
      if (entry) activate(entry);
      return;
    }
  }

  // Subscribe to the global shortcut bus.
  onMount(() => {
    const off = onOpenPalette(show);
    return off;
  });

  // Index a given entry within the flat list (for highlight + click).
  function indexOf(e: Entry): number {
    return flat.indexOf(e);
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if open}
  <div class="backdrop" onclick={hide} role="presentation"></div>

  <div class="panel" role="dialog" aria-modal="true" aria-label="Command palette">
    <input
      bind:this={inputEl}
      bind:value={query}
      type="text"
      class="search"
      placeholder={t('palette.placeholder')}
      autocomplete="off"
      spellcheck="false"
    />

    <div class="body">
      {#if routesFiltered.length > 0}
        <div class="section">
          <div class="label">{t('palette.routes')}</div>
          {#each routesFiltered as e (e.label)}
            <button
              type="button"
              class="row"
              class:selected={indexOf(e) === selectedIdx}
              onmouseenter={() => (selectedIdx = indexOf(e))}
              onclick={() => activate(e)}
            >
              <span class="row-label">{e.label}</span>
              <span class="row-hint mono">{e.hint}</span>
            </button>
          {/each}
        </div>
      {/if}

      {#if presetsFiltered.length > 0}
        <div class="section">
          <div class="label">{t('palette.filterPresets')}</div>
          {#each presetsFiltered as e (e.label)}
            <button
              type="button"
              class="row"
              class:selected={indexOf(e) === selectedIdx}
              onmouseenter={() => (selectedIdx = indexOf(e))}
              onclick={() => activate(e)}
            >
              <span class="row-label">{e.label}</span>
              <span class="row-hint mono">{e.hint}</span>
            </button>
          {/each}
        </div>
      {/if}

      <div class="section">
        <div class="label">{t('palette.recentTraces')}</div>
        {#if recentFiltered.length === 0}
          <div class="empty">{t('palette.noRecentTraces')}</div>
        {:else}
          {#each recentFiltered as e (e.href)}
            <button
              type="button"
              class="row"
              class:selected={indexOf(e) === selectedIdx}
              onmouseenter={() => (selectedIdx = indexOf(e))}
              onclick={() => activate(e)}
            >
              <span class="row-label mono">{e.label}</span>
              <span class="row-hint mono">{e.hint}</span>
            </button>
          {/each}
        {/if}
      </div>
    </div>

    <div class="help mono">
      <span>{t('palette.helpNavigate')}</span>
      <span>{t('palette.helpSelect')}</span>
      <span>{t('palette.helpClose')}</span>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: var(--bg-overlay);
    z-index: 100;
  }
  .panel {
    position: fixed;
    top: 15%;
    left: 50%;
    transform: translateX(-50%);
    width: 480px;
    max-width: calc(100vw - 32px);
    max-height: 70vh;
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    z-index: 101;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .search {
    flex: none;
    width: 100%;
    border: 0;
    border-bottom: 1px solid var(--border);
    background: transparent;
    color: var(--fg);
    font-family: var(--font-sans);
    font-size: var(--size-input);
    padding: 12px 16px;
    border-radius: 0;
  }
  .search:focus { outline: none; }
  .body {
    flex: 1;
    overflow-y: auto;
    min-height: 0;
  }
  .section {
    padding: 8px 0;
  }
  .section + .section {
    border-top: 1px solid var(--border);
  }
  .label {
    font-family: var(--font-sans);
    font-size: var(--size-label);
    text-transform: uppercase;
    color: var(--fg-dim);
    letter-spacing: 0;
    padding: 4px 16px;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    padding: 6px 16px 6px 12px;
    background: transparent;
    border: 0;
    border-left: 2px solid transparent;
    border-radius: 0;
    color: var(--fg);
    font: inherit;
    text-align: left;
    cursor: pointer;
  }
  .row.selected {
    background: var(--surface-elevated);
    border-left-color: var(--accent);
  }
  .row:hover { background: var(--surface-elevated); }
  .row-label {
    font-size: var(--size-body);
    color: var(--fg);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row-hint {
    font-size: var(--size-meta);
    color: var(--fg-muted);
    white-space: nowrap;
  }
  .empty {
    padding: 6px 16px;
    color: var(--fg-dim);
    font-size: var(--size-meta);
    font-style: italic;
  }
  .help {
    flex: none;
    border-top: 1px solid var(--border);
    display: flex;
    gap: 16px;
    padding: 6px 16px;
    color: var(--fg-dim);
    font-size: var(--size-label);
  }
</style>
