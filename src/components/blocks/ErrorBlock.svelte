<script lang="ts">
  // ErrorBlock renderer.
  //
  // Renders a single ErrorBlock (lib/blocks.ts). Used when an adapter
  // could not parse a frame, or when the upstream API returned an error
  // payload that the adapter surfaced as a Block instead of throwing.
  //
  // Visual rules (see app.css + MEMORY.md feedback_ui_taste):
  //   - Restrained Linear/Raycast-style. NO tinted card background, NO
  //     full-block --err fill. The --err color appears only on the ⚠
  //     glyph and the error_type label so the row reads "error" without
  //     screaming. A 2px left border in --err is the strongest accent.
  //   - Role ("SYSTEM" here — always, per schema) sits upper-left as
  //     small uppercase muted text, matching the convention every other
  //     block in this folder will follow.
  //   - Header glyph is the ASCII ⚠ marker for this kind. Header text
  //     is lowercase "error".
  //   - Right-aligned metadata strip is monospace 11px --fg-dim: token
  //     count (when present), source side, source container.
  //
  // Spacing between blocks (8px gap + hairline divider) is the
  // CONTAINER's responsibility, not this component's. We render no
  // bottom border / no outer margin — only padding inside our own box.
  //
  // onJumpToPair is in the props signature for symmetry with the other
  // block renderers (the prompt declares it on every block, only Tool*
  // actually uses it). We accept it and ignore it.

  import type { ErrorBlock } from '../../lib/blocks';
  import { t } from '../../lib/i18n.svelte';

  // ErrorBlock.role is always 'system' per the type, but we route through
  // the same 'blocks.<role>' namespace as the other Block renderers so
  // i18n stays uniform.
  function roleLabel(role: string): string {
    return t('blocks.' + role);
  }

  type Props = {
    block: ErrorBlock;
    onJumpToPair?: (id: string) => void;
  };

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let { block, onJumpToPair: _onJumpToPair }: Props = $props();

  // Right-aligned metadata strip. Token count is optional; source.side
  // and source.container are required by BlockSource. Join with " · "
  // and drop empty cells so a missing token estimate doesn't leave a
  // dangling separator.
  const metaParts = $derived(
    [
      block.token_estimate !== undefined ? `${block.token_estimate} tok` : '',
      block.source.side,
      block.source.container,
    ].filter((s) => s.length > 0),
  );

  // http_status renders inline next to error_type when present:
  //   "parse_error · HTTP 502"
  const typeLine = $derived(
    block.http_status !== undefined
      ? `${block.error_type} · HTTP ${block.http_status}`
      : block.error_type,
  );
</script>

<div class="block block--error" role="group" aria-label="error block">
  <div class="head">
    <span class="role">{roleLabel(block.role)}</span>
    <span class="title">
      <span class="glyph" aria-hidden="true">⚠</span>
      <span class="kind">{t('blocks.error')}</span>
    </span>
    <span class="meta">
      {#each metaParts as part, i (i)}
        {#if i > 0}<span class="sep">·</span>{/if}<span>{part}</span>
      {/each}
    </span>
  </div>

  <div class="body">
    <div class="error-type">{typeLine}</div>
    <pre class="message">{block.error_message}</pre>
    {#if block.error_code}
      <div class="code-line">
        <span class="code-label">{t('blocks.errorCodeLabel')}</span>
        <code class="code-val">{block.error_code}</code>
      </div>
    {/if}
  </div>
</div>

<style>
  /* Block frame: 4px left rail + hairline bottom only. The --err
     severity color still appears inline on the ⚠ glyph and the
     error_type label, so the row reads as a failure without the
     rail competing for status semantics. */
  .block--error {
    position: relative;
    padding: var(--space-3);
    border-top: 0;
    border-right: 0;
    border-bottom: 1px solid var(--border);
    border-left: 4px solid var(--border-strong);
    background: transparent;
    font-family: var(--font-sans);
    font-size: var(--size-input);
    color: var(--fg);
  }

  /* Header row: role (upper-left) · title (centered-ish, left-flow) ·
     metadata strip (pushed right via margin-left: auto on .meta). */
  .head {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
    margin-bottom: var(--space-2);
  }

  /* Role label — 10px uppercase muted, no chip / no pill bg. */
  .role {
    font-family: var(--font-mono);
    font-size: var(--size-label);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--fg-muted);
    flex: none;
  }

  .title {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    flex: none;
  }
  .glyph {
    font-family: var(--font-mono);
    color: var(--err);
    /* The ⚠ glyph is wide in some fonts; nudge baseline so it sits
       with the lowercase "error" text without dragging the row taller. */
    line-height: 1;
  }
  /* Type indicator "error" — lowercase outline chip. */
  .kind {
    color: var(--fg-muted);
    font-size: var(--size-label);
    text-transform: lowercase;
    padding: 1px 4px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-sm);
    line-height: 1;
  }

  .meta {
    margin-left: auto;
    display: inline-flex;
    align-items: baseline;
    gap: 4px;
    font-family: var(--font-mono);
    font-size: var(--size-label);
    color: var(--fg-dim);
    flex: none;
  }
  .meta .sep {
    color: var(--border-strong);
  }

  /* Body: type line first (the most useful debugging field), then the
     raw error message in a <pre> so newlines survive. error_code (if
     any) trails as a small labeled row. */
  .body {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .error-type {
    font-family: var(--font-mono);
    font-size: var(--size-body);
    color: var(--err);
    /* Slight de-emphasis vs. pure --err on every glyph — these are
       muted error codes, not alarms. */
    opacity: 0.95;
  }

  .message {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    font-family: var(--font-mono);
    font-size: var(--size-body);
    color: var(--fg);
    white-space: pre-wrap;
    word-break: break-word;
    overflow-x: auto;
  }

  .code-line {
    display: inline-flex;
    align-items: baseline;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: var(--size-label);
  }
  .code-label {
    color: var(--fg-dim);
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .code-val {
    color: var(--fg-muted);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: 1px 6px;
  }
</style>
