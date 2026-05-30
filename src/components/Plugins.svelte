<script lang="ts">
  // Plugins — top-level page promoted out of Settings (W4.2).
  //
  // Why this exists:
  //   The plugin surface used to live as a card mid-way through
  //   Settings.svelte. As the editor (rule rows, probability sliders,
  //   per-type forms) grew, the operator wanted it pinned to its own
  //   nav tab so it's discoverable from the header without scrolling
  //   past Display / Default Filters / Auth.
  //
  // What this file is:
  //   A minimal scrollable shell. PluginList already self-wraps in
  //   its own .card with title (settings.plugins.sectionTitle) and
  //   helper (settings.plugins.sectionHelper) — adding another page
  //   header here would render the exact same title + helper twice.
  //   So this page intentionally hosts PluginList directly inside the
  //   .page-container; PluginList's card-head serves as the page
  //   title. See W4.2 dispatch notes.
  //
  // Structure copied from Export.svelte (the matching case — top-level
  // page, default 1180px page-container, takes authFetch). The outer
  // .plugins div is the scroll element (overflow:auto; flex:1;
  // min-height:0); .page-container handles centered max-width +
  // horizontal padding via the global utility in app.css.

  import PluginList from './plugins/PluginList.svelte';
  import type { AuthFetch } from '../lib/plugins';

  interface Props {
    authFetch: AuthFetch;
  }

  const { authFetch }: Props = $props();
</script>

<div class="plugins">
  <div class="page-container">
    <PluginList {authFetch} />
  </div>
</div>

<style>
  /* Outer scroll shell — mirrors Export.svelte's .export.
     .page-container is the global centered column utility from app.css
     (default max-width 1180px); we don't override its width because
     the plugin row layout (type badge + id + actions) reads better
     with the same horizontal room Home/Export get. */
  .plugins {
    display: flex;
    flex-direction: column;
    overflow: auto;
    flex: 1;
    min-height: 0;
  }
  .plugins :global(.page-container) {
    display: flex;
    flex-direction: column;
    gap: var(--space-section);
  }
</style>
