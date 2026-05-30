<script lang="ts">
  import type { ToolCallBlock } from '../../lib/blocks';
  import { t } from '../../lib/i18n.svelte';

  // ToolCallBlock.role is always 'assistant' per the type. We keep the
  // helper anyway for symmetry with the other Block renderers and so
  // future role expansions don't drift.
  function roleLabel(role: string): string {
    return t('blocks.' + role);
  }

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

<div class="block block--tool-call" id={`tool-call-${block.tool_id}`}>
  <div class="row row--top">
    <span class="role">{roleLabel(block.role)}</span>
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
    <div class="body body--empty">{t('blocks.noInput')}</div>
  {/if}
</div>

<style>
  /* Phase 2B block frame — 4px left rail (tool category = --border-strong)
     + hairline bottom only. No top/right border, no card background. */
  .block {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    border-top: 0;
    border-right: 0;
    border-bottom: 1px solid var(--border);
    border-left: 4px solid var(--border-strong);
  }

  .row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .row--top {
    justify-content: space-between;
    min-height: 14px;
  }

  /* Role label — 10px uppercase muted, no chip / no pill bg. */
  .role {
    font-size: var(--size-label);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-muted);
  }

  .meta {
    display: flex;
    gap: var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--size-label);
    color: var(--fg-dim);
  }

  .meta__item + .meta__item::before {
    content: '·';
    margin-right: var(--space-2);
    color: var(--border-strong);
  }

  .row--header {
    flex-wrap: wrap;
    gap: var(--space-2);
    font-size: var(--size-input);
  }

  .glyph {
    color: var(--fg-muted);
    font-family: var(--font-mono);
    width: 1ch;
    display: inline-block;
    text-align: center;
  }

  .tool-name {
    font-family: var(--font-mono);
    color: var(--fg);
  }

  .sep {
    color: var(--border-strong);
  }

  /* Type indicator — lowercase outline chip per Phase 2B spec:
     10px, no background fill, 1px var(--border-strong) outline,
     1px padding, --radius-sm corners. */
  .kind {
    font-family: var(--font-mono);
    font-size: var(--size-label);
    color: var(--fg-muted);
    text-transform: lowercase;
    padding: 1px 4px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    line-height: 1;
  }

  .id,
  .id-link {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--size-label);
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
    outline: 1px solid var(--accent);
    outline-offset: 2px;
  }

  /* Mono body for tool_call args per spec. No card background — just
     a subtle outline so the args block reads as code, not as a card. */
  .body {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    font-family: var(--font-mono);
    font-size: var(--size-body);
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
