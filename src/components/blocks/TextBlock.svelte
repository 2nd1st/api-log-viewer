<script lang="ts">
  import type { TextBlock } from '../../lib/blocks';

  interface Props {
    block: TextBlock;
    onJumpToPair?: (id: string) => void;
  }

  let { block }: Props = $props();

  const COLLAPSE_THRESHOLD = 30;

  // Split text into lines once for both render + line-count math
  const lines = $derived(block.text.split('\n'));
  const isLong = $derived(lines.length > COLLAPSE_THRESHOLD);

  let collapsed = $state(true);
  const showCollapsed = $derived(isLong && collapsed);

  // Source label (e.g. "req body", "resp events")
  const sourceLabel = $derived(`${block.source.side} ${block.source.container}`);

  // Segment the text into plain spans and ```code fences``` for markdown-light
  // highlighting. We do NOT pull in a full markdown lib.
  interface Segment {
    kind: 'text' | 'code';
    content: string;
    lang?: string;
  }

  function segment(src: string): Segment[] {
    const out: Segment[] = [];
    const re = /```([\w-]*)\n?([\s\S]*?)```/g;
    let last = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      if (m.index > last) {
        out.push({ kind: 'text', content: src.slice(last, m.index) });
      }
      out.push({ kind: 'code', lang: m[1] || undefined, content: m[2] });
      last = re.lastIndex;
    }
    if (last < src.length) {
      out.push({ kind: 'text', content: src.slice(last) });
    }
    return out;
  }

  const visibleText = $derived(
    showCollapsed ? lines.slice(0, COLLAPSE_THRESHOLD).join('\n') : block.text,
  );
  const segments = $derived(segment(visibleText));

  const hiddenLineCount = $derived(isLong ? lines.length - COLLAPSE_THRESHOLD : 0);
</script>

<div class="block">
  <header class="head">
    <span class="glyph" aria-hidden="true">─</span>
    <span class="role">{block.role}</span>
    <span class="meta">
      {#if block.token_estimate !== undefined}
        <span class="meta-item">{block.token_estimate}t</span>
      {/if}
      <span class="meta-item">{sourceLabel}</span>
    </span>
  </header>

  <div class="body">
    {#each segments as seg}
      {#if seg.kind === 'code'}
        <pre class="code"><code>{seg.content}</code></pre>
      {:else}
        <span class="text">{seg.content}</span>
      {/if}
    {/each}
  </div>

  {#if isLong}
    <button
      type="button"
      class="toggle"
      onclick={() => (collapsed = !collapsed)}
    >
      <span class="toggle-glyph" aria-hidden="true">▸</span>
      {collapsed ? `show ${hiddenLineCount} more lines` : 'collapse'}
    </button>
  {/if}
</div>

<style>
  .block {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
    padding: var(--gap-2) 0;
    border-bottom: 1px solid var(--border);
  }

  .head {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1;
  }

  .glyph {
    color: var(--fg-dim);
    width: 1ch;
    display: inline-block;
    text-align: center;
  }

  .role {
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 500;
  }

  .meta {
    margin-left: auto;
    display: flex;
    gap: var(--gap-3);
    color: var(--fg-dim);
  }

  .meta-item {
    white-space: nowrap;
  }

  .body {
    font-family: var(--sans);
    font-size: 13px;
    line-height: 1.5;
    color: var(--fg);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .text {
    white-space: pre-wrap;
  }

  .code {
    margin: var(--gap-2) 0;
    padding: var(--gap-2) var(--gap-3);
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-family: var(--mono);
    font-size: 12px;
    line-height: 1.5;
    color: var(--fg);
    overflow-x: auto;
    white-space: pre;
  }

  .code code {
    font-family: inherit;
    background: transparent;
    padding: 0;
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
    display: inline-flex;
    align-items: center;
    gap: var(--gap-1);
  }

  .toggle:hover {
    color: var(--accent);
  }

  .toggle-glyph {
    display: inline-block;
    transition: transform 0.12s ease;
  }

  .toggle:not(:has(+ *)) .toggle-glyph {
    /* nothing — glyph rotation handled inline below if needed */
  }
</style>
