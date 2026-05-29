<script lang="ts">
  // Conversation tab — ported 1:1 from the original viewer
  // (api-log/internal/viewer/static/index.html, ~lines 967–1208).
  //
  // What this component does:
  //   1. extractTurns(path, req, resp, events) — normalize a single
  //      trace's request body + response body/events into a list of
  //      { role, content, raw? } turns. Handles three protocols:
  //        - /v1/chat/completions  (OpenAI Chat, stream + non-stream)
  //        - /v1/messages          (Anthropic Messages)
  //        - /v1/responses         (OpenAI Responses)
  //      Falls back to a generic messages[] / prompt shape for unknown
  //      paths. Also recovers the assistant turn from a base64 body
  //      when the recorder couldn't parse SSE (sub2gpt edge case).
  //   2. Renders the current trace's turns, with a top checkbox to
  //      include earlier turns from this session — fetches up to 30
  //      sibling traces via the same /api/traces?session_root_id=...
  //      pagination path the original used.
  //   3. renderConvoTurns surfaces tool_use / tool_result content
  //      blocks underneath the turn's flattened text content.

  import { authFetch } from '../../lib/api';
  import { shortId, shortTs, humanBytes } from '../../lib/format';

  // ---------- types ----------
  //
  // Kept intentionally loose — the original viewer worked off `any`
  // shaped objects parsed from JSONL. The Trace / Row types here are
  // the minimum surface this tab reads.

  interface ReqBody {
    system?: unknown;
    messages?: Array<{ role?: string; content?: unknown }>;
    input?: unknown;
    instructions?: string;
    prompt?: string;
    [k: string]: unknown;
  }

  interface RespBody {
    choices?: Array<{ message?: { content?: unknown } }>;
    content?: unknown;
    output_text?: string;
    output?: Array<{ content?: Array<{ text?: string }> }>;
    error?: unknown;
    [k: string]: unknown;
  }

  interface SSEEvent {
    event?: string;
    data?: any;
  }

  interface Trace {
    req?: { body?: ReqBody | null } | null;
    resp?: {
      body?: RespBody | null;
      body_b64?: string | null;
      events?: SSEEvent[];
    } | null;
  }

  interface Row {
    id: string;
    path: string;
    session_root_id?: string | null;
    ts_start?: string;
    // arbitrary other columns the parent passes through — unused here.
    [k: string]: unknown;
  }

  interface Turn {
    role?: string;
    content?: string;
    raw?: any;
    divider?: string;
  }

  interface Props {
    row: Row;
    trace: Trace;
  }

  const { row, trace }: Props = $props();

  // ---------- session-include checkbox ----------
  //
  // The original holds this on a global `state.convoIncludeSession`.
  // In the port it's local component state; persists across re-renders
  // of this tab for the lifetime of the component, matching the
  // original's behavior of resetting when the user navigates away.

  let convoIncludeSession = $state(false);

  // The disabled-state mirrors the original: no session → checkbox
  // disabled (and toggling it has no effect).
  const hasSession = $derived(!!row.session_root_id);

  // ---------- length cap (matches original CONVO_CONTENT_MAX_BYTES) ----------

  const CONVO_CONTENT_MAX_BYTES = 16384;

  function capText(s: unknown): string {
    if (typeof s !== 'string' || s.length <= CONVO_CONTENT_MAX_BYTES) {
      return typeof s === 'string' ? s : '';
    }
    return (
      s.slice(0, CONVO_CONTENT_MAX_BYTES) +
      '\n…[truncated ' +
      humanBytes(s.length - CONVO_CONTENT_MAX_BYTES) +
      ' more]'
    );
  }

  // contentToText handles both plain strings and the OpenAI/Anthropic
  // multi-modal content-block forms ([{type:"text", text:"..."}, ...]).
  function contentToText(c: unknown): string {
    if (c == null) return '';
    if (typeof c === 'string') return capText(c);
    if (Array.isArray(c)) {
      return c
        .map((b) => {
          if (typeof b === 'string') return capText(b);
          if (b && typeof b === 'object') {
            if (b.type === 'text' || b.text) return capText(b.text || '');
            if (b.type === 'tool_use') {
              const inp = JSON.stringify(b.input || {});
              return `[tool_use ${b.name || ''} ${inp.length > 512 ? inp.slice(0, 512) + '…' : inp}]`;
            }
            if (b.type === 'tool_result')
              return `[tool_result ${b.tool_use_id || ''}: ${capText(contentToText(b.content))}]`;
            if (b.type === 'image' || b.type === 'image_url') return '[image]';
            if (b.type === 'thinking')
              return b.thinking ? `[thinking] ${capText(b.thinking)}` : '[thinking]';
          }
          return JSON.stringify(b);
        })
        .join('');
    }
    if (typeof c === 'object') return capText(JSON.stringify(c));
    return capText(String(c));
  }

  function assistantFromEvents(
    events: SSEEvent[],
    isAnthropic: boolean,
    isResponses: boolean,
  ): string {
    let buf = '';
    for (const e of events) {
      const d = e.data;
      if (!d || typeof d !== 'object') continue;
      // Anthropic Messages streaming.
      if (isAnthropic) {
        if (d.type === 'content_block_delta' && d.delta) {
          if (d.delta.type === 'text_delta' && typeof d.delta.text === 'string')
            buf += d.delta.text;
          else if (
            d.delta.type === 'thinking_delta' &&
            typeof d.delta.thinking === 'string'
          )
            buf += d.delta.thinking;
        }
        continue;
      }
      // OpenAI Responses streaming.
      if (isResponses) {
        if (d.type === 'response.output_text.delta' && typeof d.delta === 'string') {
          buf += d.delta;
          continue;
        }
        if (typeof d.delta === 'string') {
          buf += d.delta;
          continue;
        }
        if (d.delta && typeof d.delta.text === 'string') {
          buf += d.delta.text;
          continue;
        }
        continue;
      }
      // OpenAI Chat streaming (default).
      if (d.choices && d.choices[0]) {
        const ch = d.choices[0];
        if (ch.delta && typeof ch.delta.content === 'string') {
          buf += ch.delta.content;
          continue;
        }
      }
    }
    return buf;
  }

  // The viewer reads two distinct sources to reconstruct a conversation:
  //   1. The request body's prior turns (messages[] / input).
  //   2. The response — body (non-streaming) OR events[] (SSE).
  //
  // Different protocols spell these differently; the extractor returns
  // a normalized list of { role, content, raw? } turns for one trace.

  function extractTurns(
    path: string,
    req: ReqBody | null | undefined,
    resp: RespBody | null | undefined,
    events: SSEEvent[],
  ): Turn[] {
    const turns: Turn[] = [];
    const isChat = !!path && path.indexOf('/v1/chat/completions') !== -1;
    const isAnthropic = !!path && path.indexOf('/v1/messages') !== -1;
    const isResponses = !!path && path.indexOf('/v1/responses') !== -1;

    // ---- prior turns from request ----
    if (isChat || isAnthropic) {
      if (req && Array.isArray((req as any).system)) {
        // Anthropic permits system as array of blocks; collapse to text.
        const text = (req as any).system
          .map((b: any) =>
            typeof b === 'string' ? b : b.text || JSON.stringify(b),
          )
          .join('\n');
        if (text) turns.push({ role: 'system', content: text });
      } else if (req && typeof (req as any).system === 'string') {
        turns.push({ role: 'system', content: (req as any).system });
      }
      const msgs = (req && req.messages) || [];
      for (const m of msgs) {
        turns.push({
          role: m.role,
          content: contentToText(m.content),
          raw: m,
        });
      }
    } else if (isResponses) {
      if (req && req.instructions)
        turns.push({ role: 'system', content: req.instructions });
      if (req && req.input != null) {
        if (typeof req.input === 'string') {
          turns.push({ role: 'user', content: req.input });
        } else if (Array.isArray(req.input)) {
          for (const item of req.input) {
            if (typeof item === 'string') {
              turns.push({ role: 'user', content: item });
            } else if (item && item.role && item.content) {
              turns.push({
                role: item.role,
                content: contentToText(item.content),
                raw: item,
              });
            } else if (item && item.type) {
              turns.push({
                role: item.role || 'user',
                content: contentToText(item.content || item.text || item),
                raw: item,
              });
            }
          }
        }
      }
    } else {
      // Unknown protocol — try a generic shape.
      const msgs = (req && req.messages) || [];
      for (const m of msgs)
        turns.push({
          role: m.role || 'user',
          content: contentToText(m.content),
          raw: m,
        });
      if (req && typeof req.prompt === 'string')
        turns.push({ role: 'user', content: req.prompt });
    }

    // ---- assistant turn from response ----
    let assistantText = '';
    if (events && events.length) {
      assistantText = assistantFromEvents(events, isAnthropic, isResponses);
    } else if (resp) {
      if (isChat && resp.choices && resp.choices[0]) {
        assistantText = contentToText(resp.choices[0].message?.content || '');
      } else if (isAnthropic && resp.content) {
        assistantText = contentToText(resp.content);
      } else if (isResponses) {
        // Responses non-streaming: output_text shortcut OR walk
        // output[].content[].text
        if (typeof resp.output_text === 'string') assistantText = resp.output_text;
        else if (Array.isArray(resp.output)) {
          assistantText = resp.output
            .flatMap((o) => (o.content || []).map((c) => c.text || ''))
            .join('');
        }
      } else if (resp.error) {
        // Error response — surface as a system-role pseudo-turn.
        turns.push({
          role: 'system',
          content: 'ERROR ' + JSON.stringify(resp.error),
        });
      }
    }
    if (assistantText) turns.push({ role: 'assistant', content: assistantText });
    return turns;
  }

  // ---------- per-trace turn build (single trace, no session) ----------

  function buildSingleTraceTurns(): Turn[] {
    const path = row.path;
    const req = (trace.req && trace.req.body) || null;
    let resp: RespBody | null = (trace.resp && trace.resp.body) || null;
    const events: SSEEvent[] = (trace.resp && trace.resp.events) || [];
    // Defensive: some upstreams (sub2gpt observed) mis-label a plain
    // JSON chat.completion response as Content-Type: text/event-stream.
    // The recorder's SSE parser falls back to body_b64 in that case
    // and leaves resp.body null. Try to recover here so the
    // conversation tab still gets the assistant turn.
    if (!resp && events.length === 0 && trace.resp && trace.resp.body_b64) {
      try {
        const raw = atob(trace.resp.body_b64);
        resp = JSON.parse(raw);
      } catch {
        /* keep resp null; we'll just show user turn */
      }
    }
    return extractTurns(path, req, resp, events);
  }

  // ---------- session transcript loader ----------
  //
  // When the include-session box is checked, walk all traces in the
  // session (ordered by ts_start), pull each trace's JSONL, extract
  // turns, and concatenate. The first trace contributes all its turns;
  // every subsequent trace contributes only its last user turn + the
  // assistant turn (the rest is already history on the wire). Hard
  // cap at 30 traces — original comment: "viewer is a viewer, not an
  // exporter".

  type TranscriptState =
    | { kind: 'idle'; turns: Turn[] }
    | { kind: 'loading' }
    | { kind: 'error'; message: string }
    | { kind: 'ready'; turns: Turn[] };

  let transcript = $state<TranscriptState>({ kind: 'idle', turns: [] });

  // Compute the turns to render. For single-trace mode this is a
  // derived value; for session mode it's the loaded transcript.
  const renderedTurns = $derived.by<Turn[]>(() => {
    if (!convoIncludeSession || !row.session_root_id) {
      return buildSingleTraceTurns();
    }
    if (transcript.kind === 'ready' || transcript.kind === 'idle') {
      return transcript.turns;
    }
    return [];
  });

  // When the user enables the session checkbox (or the row/session
  // changes while it's already enabled), kick off the multi-trace
  // fetch. When disabled, drop any in-flight state.
  $effect(() => {
    if (!convoIncludeSession || !row.session_root_id) {
      transcript = { kind: 'idle', turns: [] };
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
        const all: Turn[] = [];
        let added = 0;
        for (let i = 0; i < traceRows.length; i++) {
          if (cancelled) return;
          const tRow = traceRows[i];
          const dr = await authFetch(`api/traces/${tRow.id}`);
          if (!dr.ok) continue;
          const dj = await dr.json();
          const ev: SSEEvent[] = (dj.trace.resp && dj.trace.resp.events) || [];
          const turns = extractTurns(
            tRow.path,
            dj.trace.req && dj.trace.req.body,
            dj.trace.resp && dj.trace.resp.body,
            ev,
          );
          // For non-first turns the request already carries the prior
          // history, so just keep the last assistant turn from this
          // trace (avoid duplication). For the first trace we keep all
          // turns of its body.
          if (i === 0) {
            all.push({
              divider: `turn 1 · ${shortTs(tRow.ts_start)} · ${shortId(tRow.id)}`,
            });
            all.push(...turns);
          } else {
            all.push({
              divider: `turn ${i + 1} · ${shortTs(tRow.ts_start)} · ${shortId(tRow.id)}`,
            });
            const lastUser = [...turns].reverse().find((t) => t.role === 'user');
            const assistant = turns.find((t) => t.role === 'assistant');
            if (lastUser) all.push(lastUser);
            if (assistant) all.push(assistant);
          }
          added++;
          if (added >= 30) break;
        }
        if (cancelled) return;
        transcript = { kind: 'ready', turns: all };
      } catch (e: any) {
        if (cancelled) return;
        transcript = { kind: 'error', message: e?.message || String(e) };
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  // ---------- per-turn tool-call/result blocks ----------
  //
  // The original surfaces tool_use / tool_result content blocks from
  // the raw message structure (not just the flattened content string),
  // so the viewer can show what the model called and what it got back.

  interface ToolBlock {
    kind: 'tool_use' | 'tool_result';
    name: string;
    body: string;
  }

  function toolBlocks(t: Turn): ToolBlock[] {
    const out: ToolBlock[] = [];
    if (t.raw && Array.isArray(t.raw.content)) {
      for (const b of t.raw.content) {
        if (b && b.type === 'tool_use') {
          out.push({
            kind: 'tool_use',
            name: b.name || 'tool',
            body: JSON.stringify(b.input || {}),
          });
        } else if (b && b.type === 'tool_result') {
          out.push({
            kind: 'tool_result',
            name: 'tool_result',
            body: contentToText(b.content),
          });
        }
      }
    }
    return out;
  }

  function turnClass(role: string | undefined): string {
    if (role === 'assistant') return 'assistant';
    if (role === 'system') return 'system';
    return 'user';
  }
</script>

<div class="convo-controls">
  <label>
    <input
      type="checkbox"
      bind:checked={convoIncludeSession}
      disabled={!hasSession}
    />
    include earlier turns from this session ({shortId(row.session_root_id)})
  </label>
</div>

{#if convoIncludeSession && hasSession && transcript.kind === 'loading'}
  <div class="muted">loading session transcript…</div>
{:else if convoIncludeSession && hasSession && transcript.kind === 'error'}
  <div class="err">session transcript failed: {transcript.message}</div>
{:else if renderedTurns.length === 0}
  <div class="muted">no extractable conversation</div>
{:else}
  <div class="convo">
    {#each renderedTurns as t, i (i)}
      {#if t.divider}
        <div class="session-divider">{t.divider}</div>
      {:else}
        {@const role = t.role || 'user'}
        <div class="turn {turnClass(role)}">
          <div class="role">{role}</div>
          <div class="content">{t.content || ''}</div>
          {#each toolBlocks(t) as tb (tb.kind + ':' + tb.body)}
            <div class="tool">
              {tb.kind === 'tool_use' ? '↗' : '↙'}
              <span class="tool-name">{tb.name}</span>
              {tb.body}
            </div>
          {/each}
        </div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  /* Conversation transcript — ported from the original index.html
     (~lines 280–315). Variables mapped to the Svelte app palette:
       --line       → --border
       --line-2     → --border-strong
       --panel      → --bg-elev
       --panel-2    → --bg-elev-2
       --muted      → --fg-muted
       --good       → --ok
       --warn       → --warn
       --bad        → --err
       --fg-dim     → --fg-dim
       --r          → --radius
       --mono/--font→ --mono / --sans
  */

  .convo {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-width: 920px;
  }
  .convo .turn {
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--bg-elev);
    padding: 9px 12px;
  }
  .convo .turn.user {
    border-color: var(--border-strong);
  }
  .convo .turn.system {
    background: var(--bg);
  }
  .convo .turn.assistant {
    background: var(--bg-elev-2);
  }
  .convo .role {
    font-family: var(--mono);
    font-size: 10px;
    color: var(--fg-muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 4px;
  }
  .convo .turn.assistant .role {
    color: var(--accent);
  }
  .convo .turn.user .role {
    color: var(--ok);
  }
  .convo .turn.system .role {
    color: var(--warn);
  }
  .convo .content {
    font-family: var(--sans);
    font-size: 12.5px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    color: var(--fg);
  }
  .convo .tool {
    margin-top: 6px;
    padding: 6px 8px;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    font-family: var(--mono);
    font-size: 11px;
    color: var(--fg-dim);
  }
  .convo .tool .tool-name {
    color: var(--accent);
  }
  .session-divider {
    color: var(--fg-muted);
    font-family: var(--mono);
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 4px 0;
    border-bottom: 1px dashed var(--border);
  }
  .convo-controls {
    margin-bottom: 12px;
    display: flex;
    gap: 8px;
    align-items: center;
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

  .muted {
    color: var(--fg-muted);
  }
  .err {
    color: var(--err);
  }
</style>
