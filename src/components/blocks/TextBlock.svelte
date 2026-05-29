<script lang="ts">
  import type { TextBlock } from '../../lib/blocks';
  import { renderMarkdown, looksLikeMarkdown } from '../../lib/markdown';

  interface Props {
    block: TextBlock;
    onJumpToPair?: (id: string) => void;
  }

  let { block }: Props = $props();

  const COLLAPSE_THRESHOLD = 30;

  const lines = $derived(block.text.split('\n'));
  const isLong = $derived(lines.length > COLLAPSE_THRESHOLD);

  let collapsed = $state(true);
  const showCollapsed = $derived(isLong && collapsed);

  const sourceLabel = $derived(`${block.source.side} ${block.source.container}`);

  const visibleText = $derived(
    showCollapsed ? lines.slice(0, COLLAPSE_THRESHOLD).join('\n') : block.text,
  );

  const renderAsMarkdown = $derived(looksLikeMarkdown(visibleText));
  const markdownHtml = $derived(renderAsMarkdown ? renderMarkdown(visibleText) : '');

  const hiddenLineCount = $derived(isLong ? lines.length - COLLAPSE_THRESHOLD : 0);
</script>

<div class="block role-{block.role}">
  <header class="head">
    <span class="role">{block.role}</span>
    <span class="meta">
      {#if block.token_estimate !== undefined}
        <span class="meta-item">{block.token_estimate}t</span>
      {/if}
      <span class="meta-item">{sourceLabel}</span>
    </span>
  </header>

  <div class="body">
    {#if renderAsMarkdown}
      <div class="md">{@html markdownHtml}</div>
    {:else}
      <pre class="plain">{visibleText}</pre>
    {/if}
  </div>

  {#if isLong}
    <button
      type="button"
      class="toggle"
      onclick={() => (collapsed = !collapsed)}
    >
      {collapsed ? `show ${hiddenLineCount} more lines` : 'collapse'}
    </button>
  {/if}
</div>

<style>
  /* Role-edge accent — restraint variant of "color block per role".
     Each role gets a 2px LEFT border in a different shade. Backgrounds
     stay flat. This is the only role-coded visual signal. */
  .block {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
    padding: var(--gap-2) var(--gap-3);
    border-bottom: 1px solid var(--border);
    border-left: 2px solid transparent;
  }
  .block.role-user      { border-left-color: var(--fg-dim); }
  .block.role-assistant { border-left-color: var(--accent); }
  .block.role-system    { border-left-color: var(--border-strong); }
  .block.role-developer { border-left-color: var(--border-strong); }

  .head {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1;
  }

  .role {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 500;
  }
  .role-user      .role { color: var(--fg-muted); }
  .role-assistant .role { color: var(--accent); }
  .role-system    .role { color: var(--fg-dim); }
  .role-developer .role { color: var(--fg-dim); }

  .meta {
    margin-left: auto;
    display: flex;
    gap: var(--gap-3);
    color: var(--fg-dim);
  }
  .meta-item { white-space: nowrap; }

  .body {
    font-family: var(--sans);
    font-size: 13px;
    line-height: 1.55;
    color: var(--fg);
  }

  .plain {
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
    font-family: var(--sans);
    font-size: 13px;
    line-height: 1.55;
  }

  /* Markdown body — Linear/Raycast-leaning restraint. */
  .md :global(.md-h)  {
    margin: 14px 0 6px;
    line-height: 1.3;
    color: var(--fg);
    font-weight: 600;
    letter-spacing: -0.005em;
  }
  .md :global(.md-h:first-child) { margin-top: 0; }
  .md :global(.md-h1) { font-size: 17px; }
  .md :global(.md-h2) { font-size: 15px; }
  .md :global(.md-h3) { font-size: 13.5px; }
  .md :global(.md-h4),
  .md :global(.md-h5),
  .md :global(.md-h6) {
    font-size: 12px;
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .md :global(.md-p) {
    margin: 6px 0;
    word-break: break-word;
  }

  .md :global(.md-list) {
    margin: 6px 0;
    padding-left: 20px;
  }
  .md :global(li)      { margin: 2px 0; }
  .md :global(li > p)  { margin: 0; }

  .md :global(strong)  { font-weight: 600; color: var(--fg); }
  .md :global(em)      { font-style: italic; }

  .md :global(code) {
    font-family: var(--mono);
    font-size: 12px;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 3px;
    padding: 0 4px;
    color: var(--fg);
  }
  .md :global(.md-pre) {
    margin: var(--gap-2) 0;
    padding: var(--gap-2) var(--gap-3);
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    overflow-x: auto;
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.5;
    color: var(--fg);
  }
  .md :global(.md-pre > code) {
    background: transparent;
    border: 0;
    padding: 0;
    border-radius: 0;
    font-size: 12px;
  }

  .md :global(.md-quote) {
    margin: var(--gap-2) 0;
    padding-left: var(--gap-3);
    border-left: 2px solid var(--border-strong);
    color: var(--fg-muted);
  }

  .md :global(a) {
    color: var(--accent);
    text-decoration: none;
  }
  .md :global(a:hover) { text-decoration: underline; }

  .md :global(.md-hr) {
    border: 0;
    border-top: 1px solid var(--border);
    margin: var(--gap-3) 0;
  }

  .toggle {
    align-self: flex-start;
    background: transparent;
    border: none;
    padding: 0;
    color: var(--fg-muted);
    font-family: var(--mono);
    font-size: 11px;
    cursor: pointer;
  }
  .toggle:hover { color: var(--accent); }
</style>
