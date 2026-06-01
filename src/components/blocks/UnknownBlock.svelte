<script lang="ts">
  // UnknownBlock — fallback renderer for block kinds the adapter does not
  // recognize. Keeps the raw payload visible (with elision for huge string
  // fields) so the operator can still see what came through.
  //
  // Visual baseline: restrained Linear/Raycast feel — no card background,
  // no role-color bands, single hairline divider, small uppercase role label
  // and a monospace metadata strip on the right.
  import type { UnknownBlock } from '../../lib/blocks';
  import { t } from '../../lib/i18n.svelte';

  function roleLabel(role: string): string {
    return t('blocks.' + role);
  }

  interface Props {
    block: UnknownBlock;
    onJumpToPair?: (id: string) => void;
  }

  // onJumpToPair is accepted for prop-shape parity with ToolCallBlock /
  // ToolResultBlock but is intentionally unused here — unknown blocks have
  // no pairing semantics.
  let { block }: Props = $props();

  // Elision threshold matches BodyTab.svelte (4 KiB). Strings longer than
  // this collapse to a sentinel so the pretty-print stays scannable when
  // an unknown block happens to be e.g. an embedded base64 image payload.
  const ELIDE_THRESHOLD = 4096;

  function elideHuge(value: unknown): unknown {
    if (typeof value === 'string') {
      if (value.length > ELIDE_THRESHOLD) {
        const kb = (value.length / 1024).toFixed(1);
        return `[elided ${kb} KB string]`;
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(elideHuge);
    if (value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        out[k] = elideHuge(v);
      }
      return out;
    }
    return value;
  }

  // Pretty-printed JSON of the raw payload, with oversized strings elided.
  // Falls back to String() if for some reason the value is not serializable
  // (e.g. contains a cycle).
  const pretty = $derived.by(() => {
    try {
      return JSON.stringify(elideHuge(block.raw_data), null, 2);
    } catch (_e) {
      return String(block.raw_data);
    }
  });

  // Header sub-label: "<protocol>/<kind>". The Block schema does not give
  // us a protocol on the block itself, so we use the most descriptive
  // fields available — block_source (human description) and event_type
  // (SSE) or container (REST body / events) — joined with a slash.
  const subLabel = $derived.by(() => {
    const left = block.block_source || block.source.container || '—';
    const right = block.source.event_type || block.source.container || '';
    return right && right !== left ? `${left}/${right}` : left;
  });

  // Token count: only render if the adapter supplied one. Unknown blocks
  // rarely have a meaningful estimate, so we hide the field entirely
  // rather than printing 0.
  const tokens = $derived(block.token_estimate);
</script>

<div class="block block--unknown">
  <div class="header">
    <div class="header-left">
      <span class="role">{roleLabel(block.role)}</span>
      <span class="glyph" aria-hidden="true">?</span>
      <span class="kind">{t('blocks.unknown')}</span>
      <span class="sep" aria-hidden="true">·</span>
      <span class="sub" title={subLabel}>{subLabel}</span>
    </div>
    <div class="header-right">
      {#if tokens != null}
        <span class="meta">{tokens}t</span>
      {/if}
      <span class="meta">{block.source.side}</span>
      <span class="meta">{block.source.container}</span>
    </div>
  </div>

  {#if block.parse_error}
    <div class="parse-error">{t('blocks.parseError', { error: block.parse_error })}</div>
  {/if}

  <pre class="body">{pretty}</pre>
</div>

<style>
  /* Block frame: 4px left rail + hairline bottom only.
     Unknown blocks don't fit the named role/category buckets, so the
     rail defaults to --border-strong; the head row's role label and
     "unknown" kind chip carry identity. */
  .block--unknown {
    padding: var(--space-3);
    border-top: 0;
    border-right: 0;
    border-bottom: 1px solid var(--border);
    border-left: 4px solid var(--border-strong);
    color: var(--fg);
    font-family: var(--font-sans);
  }

  .header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    margin-bottom: var(--space-2);
  }

  .header-left {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    min-width: 0;
  }

  /* Role label — 10px uppercase muted, no chip / no pill bg. */
  .role {
    font-size: var(--size-label);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-muted);
  }

  .glyph {
    color: var(--fg-muted);
    font-family: var(--font-mono);
    font-size: var(--size-body);
  }

  /* Type indicator "unknown" — lowercase outline chip. */
  .kind {
    color: var(--fg-muted);
    font-size: var(--size-label);
    text-transform: lowercase;
    padding: 1px 4px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    line-height: 1;
  }

  .sep {
    color: var(--fg-dim);
    font-size: var(--size-label);
  }

  .sub {
    color: var(--fg-muted);
    font-family: var(--font-mono);
    font-size: var(--size-label);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  .header-right {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    flex-shrink: 0;
  }

  .meta {
    font-family: var(--font-mono);
    font-size: var(--size-label);
    color: var(--fg-dim);
  }

  .parse-error {
    font-family: var(--font-mono);
    font-size: var(--size-label);
    color: var(--warn);
    margin-bottom: var(--space-2);
  }

  /* Mono body — raw unknown payload. Subtle outline, no card bg. */
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
    max-height: 480px;
  }
</style>
