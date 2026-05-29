<script lang="ts">
  // Overview tab: key-value render of the row object with type formatting.
  //
  // Mirrors the original viewer (api-log/internal/viewer/static/index.html,
  // tab === 'overview' branch in renderDetailTab):
  //
  //   - iterate Object.entries(row)
  //   - null/undefined            -> '' (rendered as em-dash, with .empty class)
  //   - typeof v === 'object'     -> JSON.stringify(v)
  //   - everything else           -> String(v)
  //
  // Svelte's `{value}` interpolation does HTML-escaping, so the original
  // esc() helper is no longer needed.

  type Row = Record<string, unknown>;

  interface Props {
    row: Row;
  }

  const { row }: Props = $props();

  const entries = $derived(Object.entries(row ?? {}));

  function formatValue(v: unknown): string {
    if (v == null) return '';
    if (typeof v === 'object') {
      try {
        return JSON.stringify(v);
      } catch {
        return String(v);
      }
    }
    return String(v);
  }
</script>

<div class="kv">
  {#each entries as [k, v] (k)}
    {@const val = formatValue(v)}
    <div class="k">{k}</div>
    <div class="v" class:empty={val === ''}>{val === '' ? '—' : val}</div>
  {/each}
</div>

<style>
  .kv {
    font-family: var(--mono);
    font-size: 11.5px;
    display: grid;
    grid-template-columns: 180px 1fr;
    border-top: 1px solid var(--border);
  }
  .kv > div {
    padding: 5px 10px;
    border-bottom: 1px solid var(--border);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .kv .k {
    color: var(--fg-muted);
    background: var(--bg-elev);
  }
  .kv .v.empty {
    color: var(--fg-dim);
  }
</style>
