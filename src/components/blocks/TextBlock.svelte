<script lang="ts">
  import type { TextBlock } from '../../lib/blocks';
  import { renderMarkdown, looksLikeMarkdown } from '../../lib/markdown';
  import { hasXmlSections, parseXmlSections, isHarnessTag, extractHarnessMeta } from '../../lib/xmlPrompt';
  import { t } from '../../lib/i18n.svelte';

  // Localized role label. The block.role enum is 'user' | 'assistant' |
  // 'system' | 'developer' here; we look up the matching 'blocks.<role>'
  // dictionary key. If the role doesn't have a key, t() falls back to
  // the raw string, preserving the original semantics.
  function roleLabel(role: string): string {
    return t('blocks.' + role);
  }

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

  // --- XML section path -----------------------------------------------------
  // Codex L1 system prompts are flat XML: <personality>…</personality>
  // <instructions>…</instructions> etc. When detected, render as a
  // collapsible stack so the operator can drill into one section without
  // scrolling 5000 lines.
  const isXml = $derived(hasXmlSections(visibleText));
  const xmlSections = $derived(isXml ? parseXmlSections(visibleText) : []);

  // Section identity uses position (`${tag}@${i}`) because tags can repeat.
  // Open-set tracks which section bodies are currently rendered. Default:
  // first NON-harness section is open (harness blocks like
  // skills_instructions / available_skills / system-reminder stay collapsed
  // by default because they're scaffolding noise hiding the real prompt).
  // We don't reset this when visibleText changes (collapse/expand toggle)
  // — operator's choices persist.
  let openSections = $state<Set<string>>(new Set<string>());
  let openInitialized = $state(false);
  $effect(() => {
    if (!openInitialized && xmlSections.length > 0) {
      const initial = new Set<string>();
      const firstNonHarness = xmlSections.findIndex((s) => !isHarnessTag(s.tag));
      if (firstNonHarness >= 0) {
        const s = xmlSections[firstNonHarness];
        initial.add(`${s.tag}@${firstNonHarness}`);
      }
      // If every section is harness, leave the set empty — operator has to
      // expand explicitly. That's the point.
      openSections = initial;
      openInitialized = true;
    }
  });

  function toggleSection(key: string) {
    const next = new Set(openSections);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    openSections = next;
  }

  function sectionLineCount(body: string): number {
    if (!body) return 0;
    return body.split('\n').length;
  }

  // --- Plain markdown path --------------------------------------------------
  const renderAsMarkdown = $derived(!isXml && looksLikeMarkdown(visibleText));
  const markdownHtml = $derived(renderAsMarkdown ? renderMarkdown(visibleText) : '');

  const hiddenLineCount = $derived(isLong ? lines.length - COLLAPSE_THRESHOLD : 0);
</script>

<div class="block role-{block.role}">
  <header class="head">
    <span class="role">{roleLabel(block.role)}</span>
    <span class="meta">
      {#if block.token_estimate !== undefined}
        <span class="meta-item">{block.token_estimate}t</span>
      {/if}
      <span class="meta-item">{sourceLabel}</span>
    </span>
  </header>

  <div class="body">
    {#if isXml}
      <div class="xml">
        {#each xmlSections as section, i (i)}
          {@const key = `${section.tag}@${i}`}
          {@const open = openSections.has(key)}
          {@const lc = sectionLineCount(section.body)}
          {@const harnessMeta = extractHarnessMeta(section.tag, section.body)}
          {@const harness = isHarnessTag(section.tag)}
          <div class="xml-section" class:xml-harness={harness}>
            <button
              type="button"
              class="xml-head"
              aria-expanded={open}
              onclick={() => toggleSection(key)}
            >
              <span class="xml-marker">{open ? '▾' : '▸'}</span>
              <span class="xml-tag">{section.tag}</span>
              <span class="xml-size">
                {#if harnessMeta}{harnessMeta} · {/if}{lc === 1 ? t('blocks.lineCountOne', { n: lc }) : t('blocks.lineCountMany', { n: lc })}
              </span>
            </button>
            {#if open}
              <div class="xml-body md">{@html renderMarkdown(section.body)}</div>
            {/if}
          </div>
        {/each}
      </div>
    {:else if renderAsMarkdown}
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
      {collapsed ? t('blocks.showMoreLines', { n: hiddenLineCount }) : t('blocks.collapse')}
    </button>
  {/if}
</div>

<style>
  /* Block frame: 4px left role rail + hairline bottom only.
     No top/right border, no card background, no shadow. Role rail is
     the only role-coded visual signal. */
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
  .block.role-user      { border-left-color: var(--fg-dim); }
  .block.role-assistant { border-left-color: var(--accent); }
  .block.role-system    { border-left-color: var(--border-strong); }
  .block.role-developer { border-left-color: var(--border-strong); }

  .head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--size-label);
    line-height: 1;
  }

  /* Role label — flat 10px uppercase muted, no chip / no pill bg.
     The left rail carries role identity; the label just names it. */
  .role {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-weight: 500;
    font-size: var(--size-label);
    color: var(--fg-muted);
  }

  .meta {
    margin-left: auto;
    display: flex;
    gap: var(--space-3);
    color: var(--fg-dim);
    font-size: var(--size-label);
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

  /* XML section stack — flat list of collapsible <tag> bodies. No
     backgrounds, no role color. Only a hairline border-bottom per row
     to give the stack a tabular spine. */
  .xml {
    display: flex;
    flex-direction: column;
    gap: var(--gap-2);
  }
  .xml-section {
    border-bottom: 1px solid var(--border);
    padding-bottom: var(--gap-2);
  }
  .xml-section:last-child {
    border-bottom: 0;
    padding-bottom: 0;
  }

  .xml-head {
    display: flex;
    align-items: center;
    gap: var(--gap-2);
    width: 100%;
    background: transparent;
    border: 0;
    padding: 2px 0;
    color: var(--fg-muted);
    font-family: var(--mono);
    font-size: 11px;
    line-height: 1;
    text-align: left;
    cursor: pointer;
  }
  .xml-head:hover { color: var(--accent); }
  .xml-head:hover .xml-tag { color: var(--accent); }

  .xml-marker {
    display: inline-block;
    width: 10px;
    color: var(--fg-dim);
    font-family: var(--mono);
  }

  .xml-tag {
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--fg-muted);
    font-weight: 500;
  }

  .xml-size {
    margin-left: auto;
    color: var(--fg-dim);
  }

  .xml-body {
    margin-top: var(--gap-2);
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
