<script lang="ts">
  import type { ToolResultBlock } from '../../lib/blocks';
  import { t } from '../../lib/i18n.svelte';

  // ToolResultBlock.role is always 'tool'. We translate it via the
  // shared 'blocks.<role>' namespace so other languages can use a
  // local term (e.g. zh: 工具).
  function roleLabel(role: string): string {
    return t('blocks.' + role);
  }

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
    <span class="block__role">{roleLabel(block.role)}</span>
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
  /* Block frame: 4px left rail + hairline bottom only. Error variant keeps --err on the rail so
     the row reads "this one failed" at a glance; --err is severity,
     not role, so the cross-cutting accent rule is preserved. */
  .block {
    padding: var(--space-3);
    border-top: 0;
    border-right: 0;
    border-bottom: 1px solid var(--border);
    border-left: 4px solid var(--border-strong);
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
    gap: var(--space-2);
    font-size: var(--size-body);
    color: var(--fg-muted);
  }

  /* Role label — 10px uppercase muted, no chip / no pill bg. */
  .block__role {
    text-transform: uppercase;
    font-size: var(--size-label);
    letter-spacing: 0.06em;
    color: var(--fg-muted);
    min-width: 36px;
  }

  .block__glyph {
    color: var(--fg-muted);
    font-size: var(--size-body);
    line-height: 1;
  }

  .block--err .block__glyph {
    color: var(--err);
  }

  .block__arrow {
    color: var(--fg-dim);
    font-size: var(--size-body);
    line-height: 1;
  }

  .block__tool-name {
    color: var(--fg);
    font-size: var(--size-body);
  }

  .block__refs {
    color: var(--accent);
    font-size: var(--size-meta);
    margin-left: var(--space-1);
  }
  .block__refs:hover {
    color: var(--accent);
    text-decoration: underline;
  }

  .block__meta {
    margin-left: auto;
    display: inline-flex;
    gap: var(--space-2);
    font-size: var(--size-label);
    color: var(--fg-dim);
  }

  .block__body {
    margin-top: var(--space-2);
    padding-left: 44px; /* align under tool name, past role label */
  }

  /* Mono body for tool_result per spec. Subtle outline, no card bg. */
  .result {
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
    max-height: 480px;
    overflow-y: auto;
  }

  .result--err {
    color: var(--err);
    border-color: var(--border-strong);
  }
</style>
