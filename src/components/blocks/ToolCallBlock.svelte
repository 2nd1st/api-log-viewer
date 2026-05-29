<script lang="ts">
  import type { ToolCallBlock } from '../../lib/blocks';

  interface Props {
    block: ToolCallBlock;
    onJumpToPair?: (id: string) => void;
  }

  let { block, onJumpToPair }: Props = $props();

  // Pretty-print the input. Fall back to raw_input if input failed to parse.
  let prettyInput = $derived.by(() => {
    if (block.input !== undefined && block.input !== null) {
      try {
        return JSON.stringify(block.input, null, 2);
      } catch {
        // circular or otherwise non-serializable
        return String(block.input);
      }
    }
    if (block.raw_input) return block.raw_input;
    return '';
  });

  // Header label: codex pattern for custom tools is "custom: <name>"
  let displayName = $derived(
    block.kind === 'custom' ? `custom: ${block.tool_name}` : block.tool_name
  );

  let kindLabel = $derived(block.kind);

  // Metadata strip pieces
  let tokenStr = $derived(
    block.token_estimate !== undefined ? `${block.token_estimate}t` : ''
  );
  let sideStr = $derived(block.source.side);
  let containerStr = $derived(block.source.container);

  // Correlation id — prefer call_id when present (links cleanly back to API), else tool_id
  let correlationId = $derived(block.call_id ?? block.tool_id);

  function handleJump() {
    onJumpToPair?.(block.tool_id);
  }
</script>

<div class="block block--tool-call">
  <div class="row row--top">
    <span class="role">{block.role}</span>
    <div class="meta">
      {#if tokenStr}<span class="meta__item">{tokenStr}</span>{/if}
      <span class="meta__item">{sideStr}</span>
      <span class="meta__item">{containerStr}</span>
    </div>
  </div>

  <div class="row row--header">
    <span class="glyph" aria-hidden="true">⚙</span>
    <span class="tool-name">{displayName}</span>
    <span class="sep">·</span>
    <span class="kind">{kindLabel}</span>
    {#if correlationId}
      {#if onJumpToPair}
        <button
          type="button"
          class="id-link"
          title="Jump to matching tool_result"
          onclick={handleJump}
        >
          {correlationId}
        </button>
      {:else}
        <span class="id">{correlationId}</span>
      {/if}
    {/if}
  </div>

  {#if prettyInput}
    <pre class="body"><code>{prettyInput}</code></pre>
  {:else}
    <div class="body body--empty">(no input)</div>
  {/if}
</div>

<style>
  .block {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
    padding: var(--gap-2) 0;
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
  }

  .row--top {
    justify-content: space-between;
    min-height: 14px;
  }

  .role {
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-dim);
  }

  .meta {
    display: flex;
    gap: var(--gap-2);
    font-family: var(--mono);
    font-size: 11px;
    color: var(--fg-dim);
  }

  .meta__item + .meta__item::before {
    content: '·';
    margin-right: var(--gap-2);
    color: var(--border-strong);
  }

  .row--header {
    flex-wrap: wrap;
    gap: var(--gap-2);
    font-size: 13px;
  }

  .glyph {
    color: var(--fg-muted);
    font-family: var(--mono);
    width: 1ch;
    display: inline-block;
    text-align: center;
  }

  .tool-name {
    font-family: var(--mono);
    color: var(--fg);
  }

  .sep {
    color: var(--border-strong);
  }

  .kind {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--fg-muted);
  }

  .id,
  .id-link {
    margin-left: auto;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--fg-dim);
  }

  .id-link {
    background: transparent;
    border: none;
    padding: 0;
    cursor: pointer;
    border-radius: 0;
  }
  .id-link:hover {
    color: var(--accent);
    text-decoration: underline;
  }
  .id-link:focus-visible {
    outline: 1px solid var(--accent-dim);
    outline-offset: 2px;
  }

  .body {
    margin: 0;
    padding: var(--gap-2) var(--gap-3);
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.5;
    color: var(--fg);
    white-space: pre-wrap;
    word-break: break-word;
    overflow-x: auto;
  }

  .body code {
    font: inherit;
    color: inherit;
    background: transparent;
  }

  .body--empty {
    color: var(--fg-dim);
    font-style: italic;
  }
</style>
