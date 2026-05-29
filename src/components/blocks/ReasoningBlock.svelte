<script lang="ts">
  import type { ReasoningBlock } from '../../lib/blocks';

  interface Props {
    block: ReasoningBlock;
    onJumpToPair?: (id: string) => void;
  }

  // onJumpToPair is intentionally unused for reasoning blocks; only tool_call /
  // tool_result use it. We still accept it to keep the props contract uniform.
  let { block }: Props = $props();

  let expanded = $state(false);

  // The schema has no explicit summary field, so derive a one-line preview from
  // the leading prose of reasoning_text. Strip newlines, collapse whitespace,
  // clip to a sensible width.
  const preview = $derived.by(() => {
    const text = (block.reasoning_text ?? '').trim();
    if (!text) return '';
    const firstChunk = text.split(/\n\s*\n/, 1)[0] ?? text;
    const flat = firstChunk.replace(/\s+/g, ' ').trim();
    return flat.length > 160 ? flat.slice(0, 160) + '…' : flat;
  });

  const hasBody = $derived(
    !!(block.reasoning_text && block.reasoning_text.trim().length > 0)
  );

  const tokenLabel = $derived.by(() => {
    if (typeof block.token_estimate === 'number') return `${block.token_estimate}t`;
    if (typeof block.budget_tokens === 'number') return `≤${block.budget_tokens}t`;
    return '';
  });

  function toggle() {
    if (!hasBody && !block.is_encrypted) return;
    expanded = !expanded;
  }
</script>

<div class="block" class:is-expanded={expanded}>
  <button
    class="head"
    type="button"
    onclick={toggle}
    aria-expanded={expanded}
    aria-label={expanded ? 'Collapse reasoning' : 'Expand reasoning'}
  >
    <span class="marker" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
    <span class="role">assistant · reasoning</span>

    {#if !expanded}
      <span class="preview">
        {#if block.is_encrypted}
          <span class="enc">encrypted reasoning</span>
        {:else if preview}
          {preview}
        {:else}
          <span class="enc">(empty)</span>
        {/if}
      </span>
    {:else}
      <span class="preview-spacer"></span>
    {/if}

    <span class="meta mono">
      {#if tokenLabel}<span class="meta-item">{tokenLabel}</span>{/if}
      <span class="meta-item">{block.source.side}</span>
      <span class="meta-item">{block.source.container}</span>
    </span>
  </button>

  {#if expanded}
    <div class="body">
      {#if block.is_encrypted && !hasBody}
        <div class="enc-note mono">
          encrypted_content — plaintext not available in this trace
        </div>
      {:else}
        <pre class="text mono">{block.reasoning_text}</pre>
        {#if block.is_encrypted && hasBody}
          <div class="enc-note mono">encrypted_content present alongside text</div>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .block {
    /* Distinctive dim color — reasoning is "behind the curtain" thought. */
    color: var(--fg-dim);
    border-bottom: 1px solid var(--border);
    padding: var(--gap-2) 0;
    font-size: 13px;
  }

  .head {
    /* override the global <button> styling — reasoning row is a flat line, not a card. */
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
    min-height: 20px;
  }
  .head:hover { border: 0; }
  .head:hover .role { color: var(--fg-muted); }
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

  .preview {
    font-family: var(--sans);
    font-style: italic;
    color: var(--fg-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .preview-spacer { min-width: 0; }
  .enc {
    font-style: normal;
    color: var(--fg-dim);
    opacity: 0.8;
  }

  .meta {
    display: inline-flex;
    gap: var(--gap-2);
    font-size: 11px;
    color: var(--fg-dim);
    text-align: right;
    white-space: nowrap;
  }
  .meta-item { display: inline-block; }

  .body {
    margin-top: var(--gap-2);
    padding: var(--gap-2) var(--gap-3);
    /* Hairline-only — no card fill, per visual baseline. */
    border-left: 1px solid var(--border);
    margin-left: 4px;
  }

  .text {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--fg-muted);
    font-size: 12px;
    line-height: 1.55;
  }

  .enc-note {
    margin-top: var(--gap-2);
    font-size: 11px;
    color: var(--fg-dim);
  }
</style>
