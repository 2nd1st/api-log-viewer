<script lang="ts">
  import type { ReasoningBlock } from '../../lib/blocks';

  interface Props {
    block: ReasoningBlock;
    onJumpToPair?: (id: string) => void;
  }

  // onJumpToPair is unused for reasoning blocks; kept for prop-shape parity.
  let { block }: Props = $props();

  // The block has "body to expand" only when the upstream actually delivered
  // text — either a summary line or plaintext reasoning. In OpenAI Responses
  // (the dominant source) both are absent and we render a single-line
  // tombstone. NEVER surface "encrypted_content" or "plaintext not available"
  // wording — the absence is communicated by the row being uncollapsible.
  const hasBody = $derived(
    !!(block.summary && block.summary.trim().length > 0) ||
    !!(block.reasoning_text && block.reasoning_text.trim().length > 0)
  );

  let expanded = $state(false);

  const tokenLabel = $derived.by(() => {
    if (typeof block.token_estimate === 'number') return `${block.token_estimate}t`;
    if (typeof block.budget_tokens === 'number') return `≤${block.budget_tokens}t`;
    return '';
  });

  // Truncated id for the meta strip. rs_0c74…3aa45 keeps the prefix
  // (so you can tell at a glance it's a Responses reasoning id) plus the
  // last 5 chars so two adjacent reasoning rows are visually distinct.
  const idLabel = $derived.by(() => {
    if (!block.id) return '';
    if (block.id.length <= 12) return block.id;
    return block.id.slice(0, 6) + '…' + block.id.slice(-5);
  });

  function toggle() {
    if (!hasBody) return;
    expanded = !expanded;
  }
</script>

<div class="block" class:has-body={hasBody} class:is-expanded={expanded}>
  <button
    class="head"
    type="button"
    onclick={toggle}
    disabled={!hasBody}
    aria-expanded={hasBody ? expanded : undefined}
    aria-label={hasBody ? (expanded ? 'Collapse reasoning' : 'Expand reasoning') : 'reasoning (no body delivered)'}
  >
    <span class="marker" aria-hidden="true">
      {hasBody ? (expanded ? '▾' : '▸') : '·'}
    </span>
    <span class="role">assistant · reasoning</span>

    {#if hasBody && !expanded && block.summary}
      <span class="summary">{block.summary}</span>
    {:else}
      <span class="spacer"></span>
    {/if}

    <span class="meta mono">
      {#if idLabel}<span class="meta-item meta-id">{idLabel}</span>{/if}
      {#if tokenLabel}<span class="meta-item">{tokenLabel}</span>{/if}
      <span class="meta-item">{block.source.side}</span>
      <span class="meta-item">{block.source.container}</span>
    </span>
  </button>

  {#if expanded && hasBody}
    <div class="body">
      {#if block.summary && block.reasoning_text}
        <div class="summary-line">{block.summary}</div>
        <pre class="text mono">{block.reasoning_text}</pre>
      {:else if block.reasoning_text}
        <pre class="text mono">{block.reasoning_text}</pre>
      {:else if block.summary}
        <div class="summary-line">{block.summary}</div>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* Phase 2B block frame — 4px left rail (reasoning category =
     --border-strong) + hairline bottom only. No top/right border. */
  .block {
    color: var(--fg-dim);
    border-top: 0;
    border-right: 0;
    border-bottom: 1px solid var(--border);
    border-left: 4px solid var(--border-strong);
    padding: var(--space-3);
    font-size: var(--size-input);
  }

  .head {
    width: 100%;
    display: grid;
    grid-template-columns: auto auto 1fr auto;
    align-items: center;
    gap: var(--space-2);
    background: transparent;
    border: 0;
    border-radius: 0;
    padding: 0;
    color: inherit;
    text-align: left;
    cursor: pointer;
    min-height: 18px;
  }
  .head:hover { border: 0; }
  .head:disabled { cursor: default; }
  .has-body .head:hover .role { color: var(--fg-muted); }
  .head:focus-visible {
    outline: 1px solid var(--accent);
    outline-offset: 2px;
  }

  .marker {
    font-family: var(--font-mono);
    font-size: var(--size-meta);
    color: var(--fg-dim);
    width: 10px;
    display: inline-block;
    text-align: center;
  }

  /* Role label — 10px uppercase muted, no chip / no pill bg. */
  .role {
    font-size: var(--size-label);
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-muted);
    font-family: var(--font-sans);
    white-space: nowrap;
  }

  .summary {
    font-family: var(--font-sans);
    font-size: var(--size-body);
    color: var(--fg-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .spacer { min-width: 0; }

  .meta {
    display: inline-flex;
    gap: var(--space-2);
    font-size: var(--size-label);
    color: var(--fg-dim);
    text-align: right;
    white-space: nowrap;
  }
  .meta-item { display: inline-block; }
  .meta-id {
    opacity: 0.7;
    font-feature-settings: "tnum";
  }

  .body {
    margin-top: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-left: 1px solid var(--border);
    margin-left: 4px;
  }
  .summary-line {
    color: var(--fg-muted);
    font-family: var(--font-sans);
    font-size: var(--size-input);
    margin-bottom: var(--space-2);
  }
  /* Reasoning body — mono, since it's raw model trace text. */
  .text {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--fg-muted);
    font-family: var(--font-mono);
    font-size: var(--size-body);
    line-height: 1.55;
  }
</style>
