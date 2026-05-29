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
  .block {
    color: var(--fg-dim);
    border-bottom: 1px solid var(--border);
    padding: var(--gap-2) 0;
    font-size: 13px;
  }

  .head {
    width: 100%;
    display: grid;
    grid-template-columns: auto auto 1fr auto;
    align-items: center;
    gap: var(--gap-2);
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
    outline: 1px solid var(--accent-dim);
    outline-offset: 2px;
  }

  .marker {
    font-family: var(--mono);
    font-size: 11px;
    color: var(--fg-dim);
    width: 10px;
    display: inline-block;
    text-align: center;
  }

  .role {
    font-size: 10px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-dim);
    font-family: var(--sans);
    white-space: nowrap;
  }

  .summary {
    font-family: var(--sans);
    font-size: 12px;
    color: var(--fg-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .spacer { min-width: 0; }

  .meta {
    display: inline-flex;
    gap: var(--gap-2);
    font-size: 11px;
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
    margin-top: var(--gap-2);
    padding: var(--gap-2) var(--gap-3);
    border-left: 1px solid var(--border);
    margin-left: 4px;
  }
  .summary-line {
    color: var(--fg-muted);
    font-family: var(--sans);
    font-size: 13px;
    margin-bottom: var(--gap-2);
  }
  .text {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--fg-muted);
    font-size: 12px;
    line-height: 1.55;
  }
</style>
