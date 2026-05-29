<script lang="ts">
  // Conversation tab — adapter-driven block timeline.
  //
  // Previous incarnation inlined an extractTurns / contentToText / SSE
  // walker right here in the component. That logic now lives in the
  // per-protocol adapters under lib/adapters/. This component is a thin
  // shell that:
  //   1. Runs the dispatch adapter `adapt(path, trace) -> Block[]`.
  //   2. Renders each Block through the right component in
  //      components/blocks/* (switched on block.type).
  //   3. Wires onJumpToPair so tool_call ↔ tool_result blocks can
  //      scrollIntoView each other. ToolResultBlock hardcodes an anchor
  //      href of `#tool-call-${tool_id}` so the tool_call wrapper id
  //      MUST be exactly that.
  //   4. Surfaces a small counts strip at the top (text / reasoning /
  //      tool_call / tool_result / media / error / unknown).
  //   5. Keeps the "include earlier turns from this session" checkbox.
  //      In session mode the loader walks up to 30 sibling traces via
  //      /api/traces?session_root_id=...; each trace gets its own
  //      adapt() pass and the first trace contributes all blocks while
  //      every subsequent trace contributes only its response-side
  //      blocks (the request side is prior history already shown).
  //
  // includeSession + onIncludeSessionToggle are inherited from DetailPanel
  // via TabBodyCtx so the toggle survives tab switches within one trace.

  import { authFetch } from '../../lib/api';
  import { shortId, shortTs } from '../../lib/format';
  import { adapt } from '../../lib/adapters';
  import type { Block } from '../../lib/blocks';
  import { countByType } from '../../lib/blocks';

  import TextBlockComp from '../blocks/TextBlock.svelte';
  import ReasoningBlockComp from '../blocks/ReasoningBlock.svelte';
  import ToolCallBlockComp from '../blocks/ToolCallBlock.svelte';
  import ToolResultBlockComp from '../blocks/ToolResultBlock.svelte';
  import MediaBlockComp from '../blocks/MediaBlock.svelte';
  import ErrorBlockComp from '../blocks/ErrorBlock.svelte';
  import UnknownBlockComp from '../blocks/UnknownBlock.svelte';

  import type { TraceBlob } from '../DetailPanel.svelte';

  // ---------- types ----------

  interface Row {
    id: string;
    path: string;
    session_root_id?: string | null;
    ts_start?: string;
    [k: string]: unknown;
  }

  interface Props {
    row: Row;
    trace: TraceBlob;
    includeSession: boolean;
    onIncludeSessionToggle: (v: boolean) => void;
  }

  const { row, trace, includeSession, onIncludeSessionToggle }: Props = $props();

  // ---------- session-include checkbox state ----------
  //
  // No session_root_id on the row -> checkbox disabled.
  const hasSession = $derived(!!row.session_root_id);

  // ---------- single-trace block timeline ----------

  const singleTraceBlocks = $derived<Block[]>(adapt(row.path, trace));

  // ---------- session transcript loader ----------

  interface SessionEntry {
    traceId: string;
    tsStart: string;
    blocks: Block[];
  }

  type TranscriptState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; entries: SessionEntry[] };

  let transcript = $state<TranscriptState>({ kind: 'idle' });

  $effect(() => {
    if (!includeSession || !row.session_root_id) {
      transcript = { kind: 'idle' };
      return;
    }
    let cancelled = false;
    const sessionRootId = row.session_root_id;
    transcript = { kind: 'loading' };
    (async () => {
      try {
        const r = await authFetch(
          `api/traces?session_root_id=${sessionRootId}&limit=100`,
        );
        const j = await r.json();
        const traceRows: Array<{ id: string; ts_start: string; path: string }> = (
          j.traces || []
        )
          .slice()
          .sort((a: any, b: any) => a.ts_start.localeCompare(b.ts_start));

        const entries: SessionEntry[] = [];
        let added = 0;
        for (let i = 0; i < traceRows.length; i++) {
          if (cancelled) return;
          const tRow = traceRows[i];
          const dr = await authFetch(`api/traces/${tRow.id}`);
          if (!dr.ok) continue;
          const dj = await dr.json();
          const tb: TraceBlob = (dj.trace ?? {}) as TraceBlob;
          let entryBlocks = adapt(tRow.path, tb);
          // For non-first traces the request side is prior history we
          // already showed via the first trace; keep response-side blocks
          // only. The first trace contributes its full timeline.
          if (i !== 0) {
            entryBlocks = entryBlocks.filter((b) => b.source.side === 'resp');
          }
          entries.push({
            traceId: tRow.id,
            tsStart: tRow.ts_start,
            blocks: entryBlocks,
          });
          added++;
          if (added >= 30) break;
        }
        if (cancelled) return;
        transcript = { kind: 'ready', entries };
      } catch (e: any) {
        if (cancelled) return;
        transcript = { kind: 'error', message: e?.message || String(e) };
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  // ---------- counts strip ----------
  //
  // Sum over the currently rendered blocks (single or session). The
  // count names use the actual Block type strings (text, reasoning,
  // tool_call, tool_result, media, error, unknown) so they line up
  // with lib/blocks.ts countByType.

  const COUNT_ORDER = [
    'text',
    'reasoning',
    'tool_call',
    'tool_result',
    'media',
    'error',
    'unknown',
  ] as const;

  const flatBlocks = $derived.by<Block[]>(() => {
    if (!includeSession || !row.session_root_id) return singleTraceBlocks;
    if (transcript.kind === 'ready') {
      return transcript.entries.flatMap((e) => e.blocks);
    }
    return [];
  });

  const counts = $derived(countByType(flatBlocks));

  // ---------- jump-to-pair: scroll the paired block's wrapper into view ----------
  //
  // Both directions hand us the same tool_id. The direction is determined
  // by which block calls us (we know via the closure we make in the
  // template). To keep behavior simple we look up the OTHER element from
  // the wrapper id namespace:
  //   tool_call wrapper:  #tool-call-${tool_id}
  //   tool_result wrapper:#tool-result-${tool_id}
  // ToolResultBlock already hardcodes `href="#tool-call-${tool_id}"` so
  // we MUST keep that id naming.
  function jumpToId(elementId: string) {
    if (typeof document === 'undefined') return;
    const el = document.getElementById(elementId);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
</script>

<div class="convo-controls">
  <label>
    <input
      type="checkbox"
      checked={includeSession}
      onchange={(e) =>
        onIncludeSessionToggle((e.currentTarget as HTMLInputElement).checked)}
      disabled={!hasSession}
    />
    include earlier turns from this session ({shortId(row.session_root_id)})
  </label>
  <div class="counts">
    {#each COUNT_ORDER as t (t)}
      {#if (counts[t] || 0) > 0}
        <span class="count">{counts[t]} {t}</span>
      {/if}
    {/each}
  </div>
</div>

{#if includeSession && hasSession && transcript.kind === 'loading'}
  <div class="muted">loading session transcript…</div>
{:else if includeSession && hasSession && transcript.kind === 'error'}
  <div class="err">session transcript failed: {transcript.message}</div>
{:else if includeSession && hasSession && transcript.kind === 'ready'}
  <div class="blocks">
    {#each transcript.entries as entry, i (entry.traceId)}
      <div class="session-divider">
        turn {i + 1} · {shortTs(entry.tsStart)} · {shortId(entry.traceId)}
      </div>
      {#each entry.blocks as block (block.sequence_number ?? `${entry.traceId}:${block.type}:${block.source.path ?? ''}`)}
        {@const wrapperId =
          block.type === 'tool_call'
            ? `tool-call-${block.tool_id}`
            : block.type === 'tool_result'
              ? `tool-result-${block.tool_id}`
              : undefined}
        <div class="block-wrap" id={wrapperId}>
          {#if block.type === 'text'}
            <TextBlockComp {block} />
          {:else if block.type === 'reasoning'}
            <ReasoningBlockComp {block} />
          {:else if block.type === 'tool_call'}
            <ToolCallBlockComp
              {block}
              onJumpToPair={(id) => jumpToId(`tool-result-${id}`)}
            />
          {:else if block.type === 'tool_result'}
            <ToolResultBlockComp
              {block}
              onJumpToPair={(id) => jumpToId(`tool-call-${id}`)}
            />
          {:else if block.type === 'media'}
            <MediaBlockComp {block} />
          {:else if block.type === 'error'}
            <ErrorBlockComp {block} />
          {:else}
            <UnknownBlockComp {block} />
          {/if}
        </div>
      {/each}
    {/each}
  </div>
{:else if singleTraceBlocks.length === 0}
  <div class="muted">no extractable conversation</div>
{:else}
  <div class="blocks">
    {#each singleTraceBlocks as block (block.sequence_number ?? `${block.type}:${block.source.path ?? ''}`)}
      {@const wrapperId =
        block.type === 'tool_call'
          ? `tool-call-${block.tool_id}`
          : block.type === 'tool_result'
            ? `tool-result-${block.tool_id}`
            : undefined}
      <div class="block-wrap" id={wrapperId}>
        {#if block.type === 'text'}
          <TextBlockComp {block} />
        {:else if block.type === 'reasoning'}
          <ReasoningBlockComp {block} />
        {:else if block.type === 'tool_call'}
          <ToolCallBlockComp
            {block}
            onJumpToPair={(id) => jumpToId(`tool-result-${id}`)}
          />
        {:else if block.type === 'tool_result'}
          <ToolResultBlockComp
            {block}
            onJumpToPair={(id) => jumpToId(`tool-call-${id}`)}
          />
        {:else if block.type === 'media'}
          <MediaBlockComp {block} />
        {:else if block.type === 'error'}
          <ErrorBlockComp {block} />
        {:else}
          <UnknownBlockComp {block} />
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .convo-controls {
    margin-bottom: 12px;
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
    font-family: var(--mono);
    font-size: 11px;
  }
  .convo-controls label {
    display: inline-flex;
    gap: 5px;
    align-items: center;
    color: var(--fg-muted);
  }
  .convo-controls input[type='checkbox'] {
    accent-color: var(--accent);
  }
  .counts {
    margin-left: auto;
    display: flex;
    gap: 10px;
    color: var(--fg-dim);
  }
  .count {
    white-space: nowrap;
  }

  .blocks {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-width: 920px;
  }
  .block-wrap {
    scroll-margin-top: 80px;
  }

  .session-divider {
    color: var(--fg-muted);
    font-family: var(--mono);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 10px 0 4px;
    border-bottom: 1px dashed var(--border);
    margin-top: 10px;
  }
  .session-divider:first-child {
    margin-top: 0;
  }

  .muted {
    color: var(--fg-muted);
    font-family: var(--mono);
    font-size: 12px;
  }
  .err {
    color: var(--err);
    font-family: var(--mono);
    font-size: 12px;
  }
</style>
