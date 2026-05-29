<script lang="ts">
  // Toggle between 'traces' and 'sessions' list modes.
  //
  // Ported 1:1 from internal/viewer/static/index.html (switchMode + the
  // two mode-* buttons). The original behavior:
  //   - clicking a mode button while already in that mode is a no-op
  //   - flipping mode calls loadList({ reset: true })
  //   - active button gets the .active class
  //
  // In the Svelte port the `mode` value is owned by the parent (so the
  // rest of the app — list loader, filter inputs — can observe it via
  // the same source of truth). We expose a bindable prop and an
  // explicit onChange callback that the parent uses to trigger the list
  // reload, mirroring the original switchMode -> loadList({ reset: true })
  // wiring.

  export type ListMode = 'traces' | 'sessions';

  interface Props {
    mode: ListMode;
    onChange?: (mode: ListMode) => void;
  }

  let { mode = $bindable('traces'), onChange }: Props = $props();

  function switchMode(m: ListMode) {
    if (mode === m) return;
    mode = m;
    onChange?.(m);
  }
</script>

<div class="list-mode-toggle">
  <button
    type="button"
    class:active={mode === 'traces'}
    onclick={() => switchMode('traces')}
  >traces</button>
  <button
    type="button"
    class:active={mode === 'sessions'}
    onclick={() => switchMode('sessions')}
  >sessions</button>
</div>

<style>
  /* Mirrors the original .list-mode-toggle rules from index.html,
     translated to the new CSS variable names defined in app.css
     (--border instead of --line, --fg-muted instead of --muted, etc.). */
  .list-mode-toggle {
    display: flex;
    gap: 0;
    font-family: var(--mono);
    font-size: 11px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-elev);
  }
  .list-mode-toggle button {
    background: transparent;
    border: 1px solid var(--border);
    color: var(--fg-muted);
    padding: 3px 10px;
    cursor: pointer;
    font: inherit;
    font-size: 11px;
    border-radius: 0;
  }
  .list-mode-toggle button:first-child {
    border-radius: var(--radius) 0 0 var(--radius);
  }
  .list-mode-toggle button:last-child {
    border-radius: 0 var(--radius) var(--radius) 0;
    border-left: none;
  }
  .list-mode-toggle button.active {
    color: var(--fg);
    background: var(--bg);
    border-color: var(--border-strong);
  }
  .list-mode-toggle button:hover {
    border-color: var(--border-strong);
  }
</style>
