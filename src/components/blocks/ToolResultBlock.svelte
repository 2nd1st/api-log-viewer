<script lang="ts">
  import type { ToolResultBlock } from '../../lib/blocks';

  interface Props {
    block: ToolResultBlock;
    onJumpToPair?: (id: string) => void;
  }

  let { block, onJumpToPair }: Props = $props();

  /**
   * Try to pretty-print the result.
   *  - If result_structured is present (object/array), JSON.stringify it.
   *  - Else if result_text parses as JSON, pretty-print that.
   *  - Else render result_text as-is (monospace).
   */
  const pretty = $derived.by(() => {
    if (block.result_structured !== undefined && block.result_structured !== null) {
      try {
        return {
          text: JSON.stringify(block.result_structured, null, 2),
          isJson: true,
        };
      } catch {
        /* fall through */
      }
    }
    const raw = block.result_text ?? '';
    const trimmed = raw.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        return { text: JSON.stringify(JSON.parse(trimmed), null, 2), isJson: true };
      } catch {
        /* fall through */
      }
    }
    return { text: raw, isJson: false };
  });

  const isError = $derived(block.is_error === true);

  const sourceSummary = $derived.by(() => {
    const s = block.source;
    return `${s.side}·${s.container}`;
  });

  function handleJumpClick(e: MouseEvent) {
    e.preventDefault();
    if (onJumpToPair && block.tool_id) {
      onJumpToPair(block.tool_id);
    }
  }
</script>

<div class="block block--tool-result" class:block--err={isError} id={`tool-result-${block.tool_id}`}>
  <div class="block__header">
    <span class="block__role">{block.role}</span>
    <span class="block__glyph" aria-hidden="true">{isError ? '⚠' : '⚙'}</span>
    <span class="block__arrow" title="result of">←</span>
    <span class="block__tool-name mono">{block.tool_name}</span>
    {#if onJumpToPair && block.tool_id}
      <a
        class="block__refs mono"
        href="#tool-call-{block.tool_id}"
        onclick={handleJumpClick}
        title="Jump to matching tool_call"
      >↑ call</a>
    {/if}
    <span class="block__meta mono">
      {#if block.token_estimate !== undefined}
        <span class="meta__tok">{block.token_estimate}t</span>
      {/if}
      <span class="meta__src">{sourceSummary}</span>
    </span>
  </div>

  <div class="block__body">
    <pre class="result mono" class:result--err={isError}>{pretty.text}</pre>
  </div>
</div>

<style>
  .block {
    padding: var(--gap-2) var(--gap-3);
    border-bottom: 1px solid var(--border);
    /* Tool results are model-side responses — share the assistant edge color. */
    border-left: 2px solid var(--accent);
  }
  .block:last-child {
    border-bottom: none;
  }
  .block--err {
    border-left-color: var(--err);
  }

  .block__header {
    display: flex;
    align-items: baseline;
    gap: var(--gap-2);
    font-size: 12px;
    color: var(--fg-muted);
  }

  .block__role {
    text-transform: uppercase;
    font-size: 10px;
    letter-spacing: 0.06em;
    color: var(--fg-dim);
    min-width: 36px;
  }

  .block__glyph {
    color: var(--fg-muted);
    font-size: 12px;
    line-height: 1;
  }

  .block--err .block__glyph {
    color: var(--err);
  }

  .block__arrow {
    color: var(--fg-dim);
    font-size: 12px;
    line-height: 1;
  }

  .block__tool-name {
    color: var(--fg);
    font-size: 12px;
  }

  .block__refs {
    color: var(--accent);
    font-size: 11px;
    margin-left: var(--gap-1);
  }
  .block__refs:hover {
    color: var(--accent-dim);
    text-decoration: underline;
  }

  .block__meta {
    margin-left: auto;
    display: inline-flex;
    gap: var(--gap-2);
    font-size: 11px;
    color: var(--fg-dim);
  }

  .block__body {
    margin-top: var(--gap-2);
    padding-left: 44px; /* align under tool name, past role label */
  }

  .result {
    margin: 0;
    padding: var(--gap-2) var(--gap-3);
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-size: 12px;
    line-height: 1.5;
    color: var(--fg);
    white-space: pre-wrap;
    word-break: break-word;
    overflow-x: auto;
    max-height: 480px;
    overflow-y: auto;
  }

  .result--err {
    color: var(--err);
    border-color: var(--border-strong);
  }
</style>
