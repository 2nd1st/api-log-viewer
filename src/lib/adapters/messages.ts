/**
 * Adapter for Anthropic Messages protocol (/v1/messages).
 *
 * Walks the Anthropic request/response shape into the viewer's Block[] union.
 * The sub2api gateway proxies the official Anthropic Messages API as-is, so
 * we follow the public schema:
 *   https://docs.anthropic.com/claude/reference/messages_post
 *
 * Request shape (cheat sheet):
 *   {
 *     model, max_tokens,
 *     system?: string | Array<{ type: 'text', text: string, cache_control?, ... }>,
 *     messages: [
 *       {
 *         role: 'user' | 'assistant',
 *         content: string | Array<ContentBlock>
 *       },
 *       ...
 *     ],
 *     tools?, tool_choice?, metadata?, stream?
 *   }
 *
 * Non-streaming response shape:
 *   {
 *     id, model, role: 'assistant', type: 'message',
 *     content: Array<ContentBlock>,
 *     stop_reason, stop_sequence, usage
 *   }
 *
 * Error response shape (4xx/5xx):
 *   { type: 'error', error: { type, message } }
 *
 * Streaming SSE event types (when used):
 *   message_start             -> { message: {...} }
 *   content_block_start       -> { index, content_block }
 *   content_block_delta       -> { index, delta: { type, text|partial_json|thinking|... } }
 *   content_block_stop        -> { index }
 *   message_delta             -> { delta: { stop_reason, stop_sequence }, usage }
 *   message_stop              -> {}
 *   ping                      -> {}
 *   error                     -> { error: {type, message} }
 *
 * Content block variants we handle (req+resp):
 *   text                      -> TextBlock
 *   thinking                  -> ReasoningBlock (plaintext)
 *   redacted_thinking         -> ReasoningBlock (is_encrypted=true)
 *   tool_use                  -> ToolCallBlock (kind='function', captures id)
 *   tool_result               -> ToolResultBlock (role='tool', pairs via tool_use_id)
 *   server_tool_use           -> ToolCallBlock (kind='web_search'|... based on name)
 *   web_search_tool_result    -> ToolResultBlock (kind comes from sibling server_tool_use)
 *   image                     -> MediaBlock (image; source.type=base64|url)
 *   document                  -> MediaBlock (document; source.type=base64|url|text|content)
 *
 * Note: Anthropic puts tool_result blocks INSIDE user-role messages on the
 * request side. We unpack them and emit role='tool' regardless of their
 * enclosing message role, to match the schema (ToolResultBlock.role === 'tool').
 *
 * Note: no real streaming /messages samples existed at write-time, but the
 * non-streaming path was verified against ~30 sub2api detail blobs. The SSE
 * path is built strictly off the documented Anthropic stream contract.
 */

import type {
  Block,
  BlockSource,
  ErrorBlock,
  MediaBlock,
  ReasoningBlock,
  TextBlock,
  ToolCallBlock,
  ToolResultBlock,
  UnknownBlock,
} from '../blocks';
import type { TraceBlob } from '../../components/DetailPanel.svelte';

// ---------- public entry ----------

export function adapt(path: string, traceBlob: TraceBlob): Block[] {
  const blocks: Block[] = [];
  try {
    // Request side first (chronologically: client sent it before server replied).
    blocks.push(...adaptRequest(path, traceBlob));
    // Then response side.
    blocks.push(...adaptResponse(path, traceBlob));
  } catch (e: any) {
    blocks.push(makeError('req', 'adapter_panic', e?.message ?? String(e), { path }));
  }
  // Stamp sequence_number so downstream renderers have a stable order
  // independent of any later re-sorting.
  blocks.forEach((b, i) => {
    b.sequence_number = i;
  });
  return blocks;
}

// ---------- request side ----------

function adaptRequest(_path: string, traceBlob: TraceBlob): Block[] {
  const out: Block[] = [];
  const reqBody = traceBlob?.req?.body;
  if (!reqBody || typeof reqBody !== 'object') return out;

  // -- system prompt: string | Array<TextBlockParam> --
  const sys = (reqBody as any).system;
  if (sys !== undefined && sys !== null) {
    try {
      if (typeof sys === 'string') {
        if (sys.length > 0) {
          out.push({
            type: 'text',
            role: 'system',
            text: sys,
            source: { side: 'req', container: 'body', path: 'req.body.system' },
          });
        }
      } else if (Array.isArray(sys)) {
        for (let i = 0; i < sys.length; i++) {
          const item = sys[i];
          const src: BlockSource = {
            side: 'req',
            container: 'body',
            path: `req.body.system[${i}]`,
            index: i,
          };
          // System array entries are normally { type: 'text', text }, but be
          // defensive about other shapes.
          if (item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') {
            if (item.text.length > 0) {
              out.push({
                type: 'text',
                role: 'system',
                text: item.text,
                source: src,
              });
            }
          } else if (typeof item === 'string') {
            if (item.length > 0) {
              out.push({ type: 'text', role: 'system', text: item, source: src });
            }
          } else {
            out.push(makeUnknown('req', 'unrecognized system entry', item, src.path ?? ''));
          }
        }
      } else {
        out.push(makeUnknown('req', 'unrecognized system shape', sys, 'req.body.system'));
      }
    } catch (e: any) {
      out.push(makeError('req', 'parse_error', e?.message ?? String(e), { where: 'system' }));
    }
  }

  // -- messages[] --
  const messages = (reqBody as any).messages;
  if (Array.isArray(messages)) {
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg || typeof msg !== 'object') {
        out.push(makeUnknown('req', 'message not an object', msg, `req.body.messages[${i}]`));
        continue;
      }
      const role = mapMessageRole(msg.role);
      const content = msg.content;
      const basePath = `req.body.messages[${i}]`;

      try {
        if (typeof content === 'string') {
          // String content shortcut: equivalent to a single text block.
          if (content.length > 0) {
            out.push({
              type: 'text',
              role: role === 'tool' ? 'user' : role,
              text: content,
              source: { side: 'req', container: 'body', path: `${basePath}.content`, index: i },
            });
          }
        } else if (Array.isArray(content)) {
          for (let j = 0; j < content.length; j++) {
            const part = content[j];
            const src: BlockSource = {
              side: 'req',
              container: 'body',
              path: `${basePath}.content[${j}]`,
              index: j,
            };
            try {
              out.push(...contentBlockToBlocks(part, role, src));
            } catch (e: any) {
              out.push(makeError('req', 'parse_error', e?.message ?? String(e), {
                where: `messages[${i}].content[${j}]`,
              }));
            }
          }
        } else if (content !== undefined && content !== null) {
          out.push(makeUnknown('req', 'unrecognized content shape', content, `${basePath}.content`));
        }
      } catch (e: any) {
        out.push(makeError('req', 'parse_error', e?.message ?? String(e), {
          where: `messages[${i}]`,
        }));
      }
    }
  } else if (messages !== undefined) {
    out.push(makeUnknown('req', 'messages is not an array', messages, 'req.body.messages'));
  }

  return out;
}

// ---------- response side ----------

function adaptResponse(_path: string, traceBlob: TraceBlob): Block[] {
  const out: Block[] = [];
  const resp = traceBlob?.resp;
  if (!resp) return out;

  // Streaming path: events present and non-empty.
  const events = Array.isArray(resp.events) ? resp.events : [];
  if (events.length > 0) {
    try {
      out.push(...adaptResponseStream(events));
      return out;
    } catch (e: any) {
      out.push(makeError('resp', 'sse_frame_error', e?.message ?? String(e), {
        where: 'resp.events',
      }));
      // fall through and ALSO try resp.body in case the body was buffered
    }
  }

  // Non-streaming path: single JSON body.
  const body = resp.body;
  if (body && typeof body === 'object') {
    try {
      out.push(...adaptResponseBody(body));
    } catch (e: any) {
      out.push(makeError('resp', 'parse_error', e?.message ?? String(e), {
        where: 'resp.body',
      }));
    }
  }

  return out;
}

function adaptResponseBody(body: any): Block[] {
  const out: Block[] = [];

  // Anthropic-style API error envelope: { type: 'error', error: { type, message } }.
  // sub2api also surfaces upstream errors verbatim (e.g. 429 "No available
  // accounts"), so emit an ErrorBlock so the operator can see WHY.
  if (body?.type === 'error' || body?.error) {
    const err = body.error ?? body;
    out.push({
      type: 'error',
      role: 'system',
      error_type: 'api_error',
      error_message:
        typeof err === 'string'
          ? err
          : err?.message ?? JSON.stringify(err),
      error_code: err?.type,
      source: { side: 'resp', container: 'body', path: 'resp.body.error' },
    });
    return out;
  }

  const content = body?.content;
  if (Array.isArray(content)) {
    for (let i = 0; i < content.length; i++) {
      const part = content[i];
      const src: BlockSource = {
        side: 'resp',
        container: 'body',
        path: `resp.body.content[${i}]`,
        index: i,
      };
      try {
        out.push(...contentBlockToBlocks(part, 'assistant', src));
      } catch (e: any) {
        out.push(makeError('resp', 'parse_error', e?.message ?? String(e), {
          where: `content[${i}]`,
        }));
      }
    }
  } else if (content !== undefined && content !== null) {
    out.push(makeUnknown('resp', 'content is not an array', content, 'resp.body.content'));
  }

  // Surface non-natural stop reasons as an info-level error block. 'end_turn'
  // and 'stop_sequence' are normal; 'max_tokens' / 'tool_use' / 'refusal' /
  // 'pause_turn' carry signal worth showing.
  const sr = body?.stop_reason;
  if (sr && sr !== 'end_turn' && sr !== 'stop_sequence' && sr !== 'tool_use') {
    out.push({
      type: 'error',
      role: 'system',
      error_type: 'stop_reason',
      error_message: `stop_reason=${sr}`,
      source: { side: 'resp', container: 'body', path: 'resp.body.stop_reason' },
    });
  }

  return out;
}

// ---------- streaming (SSE) ----------
//
// Anthropic Messages SSE groups blocks by integer `index` (NOT by an
// OpenAI-style item_id). We open a partial slot on content_block_start,
// append on content_block_delta, finalize on content_block_stop.

interface PartialBlock {
  index: number;
  type: string; // 'text' | 'thinking' | 'tool_use' | 'server_tool_use' | 'redacted_thinking' | 'web_search_tool_result' | ...
  // shared accumulators
  text: string; // for text and thinking
  partial_json: string; // for tool_use input_json_delta
  signature: string; // for thinking signature_delta
  // captured at start
  start_block: any; // raw content_block from start event
  source: BlockSource;
}

function adaptResponseStream(
  events: Array<{ t_delta_ms?: number; event?: string; data?: any }>
): Block[] {
  const out: Block[] = [];
  const partials = new Map<number, PartialBlock>();

  for (let ei = 0; ei < events.length; ei++) {
    const ev = events[ei];
    const data = parseSseData(ev?.data);
    const eventType = ev?.event ?? data?.type;

    const src: BlockSource = {
      side: 'resp',
      container: 'events',
      path: `resp.events[${ei}]`,
      index: ei,
      event_type: typeof eventType === 'string' ? eventType : undefined,
    };

    if (data === null) {
      out.push(makeError('resp', 'sse_frame_error', 'unparseable SSE data', { index: ei }));
      continue;
    }

    try {
      switch (eventType) {
        case 'message_start':
          // Carries message metadata (model, usage); we don't need to emit it.
          break;

        case 'content_block_start': {
          const idx = data.index;
          const cb = data.content_block;
          if (typeof idx !== 'number' || !cb) break;
          // NB: cb.input on tool_use is an EMPTY placeholder ({}) that
          // gets filled via input_json_delta events. Do NOT seed partial_json
          // from it, or appended deltas will produce malformed JSON like
          // `{}{"a":1}`. We fall back to cb.input only at finalize time if
          // no deltas arrived.
          partials.set(idx, {
            index: idx,
            type: String(cb.type ?? ''),
            text: typeof cb.text === 'string' ? cb.text : '',
            partial_json: '',
            signature: typeof cb.signature === 'string' ? cb.signature : '',
            start_block: cb,
            source: { ...src, path: `${src.path}.content_block[${idx}]` },
          });
          break;
        }

        case 'content_block_delta': {
          const idx = data.index;
          const delta = data.delta;
          if (typeof idx !== 'number' || !delta) break;
          const slot = partials.get(idx);
          if (!slot) {
            // delta with no matching start — emit as standalone error, don't drop
            out.push(makeError('resp', 'sse_frame_error', `delta for unstarted block index=${idx}`, {
              index: ei,
            }));
            break;
          }
          switch (delta.type) {
            case 'text_delta':
              if (typeof delta.text === 'string') slot.text += delta.text;
              break;
            case 'thinking_delta':
              if (typeof delta.thinking === 'string') slot.text += delta.thinking;
              break;
            case 'input_json_delta':
              if (typeof delta.partial_json === 'string') slot.partial_json += delta.partial_json;
              break;
            case 'signature_delta':
              if (typeof delta.signature === 'string') slot.signature += delta.signature;
              break;
            case 'citations_delta':
              // citations attach to the current block; we don't yet model
              // them on TextBlock at stream-time — flush them into the start
              // record so we can append on stop.
              if (!slot.start_block.citations) slot.start_block.citations = [];
              if (delta.citation) slot.start_block.citations.push(delta.citation);
              break;
            default:
              // unknown delta type — ignore quietly, don't poison the stream
              break;
          }
          break;
        }

        case 'content_block_stop': {
          const idx = data.index;
          if (typeof idx !== 'number') break;
          const slot = partials.get(idx);
          if (!slot) break;
          const finalBlocks = finalizePartial(slot);
          out.push(...finalBlocks);
          partials.delete(idx);
          break;
        }

        case 'message_delta':
          // Carries stop_reason / usage updates; surface unusual stops.
          {
            const sr = data?.delta?.stop_reason;
            if (sr && sr !== 'end_turn' && sr !== 'stop_sequence' && sr !== 'tool_use') {
              out.push({
                type: 'error',
                role: 'system',
                error_type: 'stop_reason',
                error_message: `stop_reason=${sr}`,
                source: src,
              });
            }
          }
          break;

        case 'message_stop':
          break;

        case 'ping':
          break;

        case 'error':
          {
            const err = data?.error ?? data;
            out.push({
              type: 'error',
              role: 'system',
              error_type: 'api_error',
              error_message:
                typeof err === 'string' ? err : err?.message ?? JSON.stringify(err),
              error_code: err?.type,
              source: src,
            });
          }
          break;

        default:
          // Unknown / unannounced event — ignore unless it looks like a frame
          // with content_block (some proxies omit the event name).
          if (data?.content_block && typeof data?.index === 'number') {
            // Treat as implicit content_block_start
            const cb = data.content_block;
            partials.set(data.index, {
              index: data.index,
              type: String(cb.type ?? ''),
              text: typeof cb.text === 'string' ? cb.text : '',
              partial_json: '',
              signature: '',
              start_block: cb,
              source: src,
            });
          }
          break;
      }
    } catch (e: any) {
      out.push(makeError('resp', 'sse_frame_error', e?.message ?? String(e), {
        where: `events[${ei}] ${eventType ?? ''}`,
      }));
    }
  }

  // Flush any partials that never got a content_block_stop (truncated stream).
  const leftover = Array.from(partials.values()).sort((a, b) => a.index - b.index);
  for (const slot of leftover) {
    try {
      const finalBlocks = finalizePartial(slot);
      out.push(...finalBlocks);
    } catch (e: any) {
      out.push(makeError('resp', 'sse_frame_error', e?.message ?? String(e), {
        where: `leftover partial index=${slot.index}`,
      }));
    }
  }

  return out;
}

function finalizePartial(slot: PartialBlock): Block[] {
  const cb = slot.start_block ?? {};
  switch (slot.type) {
    case 'text': {
      const block: TextBlock = {
        type: 'text',
        role: 'assistant',
        text: slot.text,
        source: slot.source,
      };
      if (Array.isArray(cb.citations) && cb.citations.length > 0) {
        block.citations = cb.citations.map((c: any) => ({
          source: String(c?.source ?? c?.document_title ?? ''),
          url: c?.url,
          title: c?.title ?? c?.document_title,
        }));
      }
      return [block];
    }
    case 'thinking': {
      const block: ReasoningBlock = {
        type: 'reasoning',
        role: 'assistant',
        reasoning_text: slot.text,
        source: slot.source,
      };
      return [block];
    }
    case 'redacted_thinking': {
      const block: ReasoningBlock = {
        type: 'reasoning',
        role: 'assistant',
        reasoning_text: typeof cb.data === 'string' ? cb.data : slot.text,
        is_encrypted: true,
        source: slot.source,
      };
      return [block];
    }
    case 'tool_use':
    case 'server_tool_use': {
      let parsedInput: unknown;
      let raw_input: string | undefined;
      if (slot.partial_json.length > 0) {
        try {
          parsedInput = JSON.parse(slot.partial_json);
        } catch {
          parsedInput = undefined;
          raw_input = slot.partial_json;
        }
      } else if (cb.input && typeof cb.input === 'object') {
        parsedInput = cb.input;
      } else {
        parsedInput = {};
      }
      const name = String(cb.name ?? '');
      const kind: ToolCallBlock['kind'] =
        slot.type === 'server_tool_use' ? serverToolKindFromName(name) : 'function';
      const block: ToolCallBlock = {
        type: 'tool_call',
        role: 'assistant',
        tool_id: String(cb.id ?? `tool_use:${slot.index}`),
        tool_name: name,
        kind,
        input: parsedInput,
        source: slot.source,
      };
      if (raw_input !== undefined) block.raw_input = raw_input;
      return [block];
    }
    case 'web_search_tool_result': {
      // Streamed result of a server_tool_use. Pair via tool_use_id.
      const block: ToolResultBlock = {
        type: 'tool_result',
        role: 'tool',
        tool_id: String(cb.tool_use_id ?? cb.id ?? `tool_result:${slot.index}`),
        tool_name: 'web_search',
        result_text: safeStringify(cb.content ?? cb),
        result_structured: cb.content,
        source: slot.source,
      };
      return [block];
    }
    default:
      return [
        makeUnknown(
          'resp',
          `unrecognized streamed block type=${slot.type}`,
          cb,
          slot.source.path ?? ''
        ),
      ];
  }
}

// ---------- per-content-block dispatch (shared between req and resp) ----------

function contentBlockToBlocks(
  part: any,
  role: ReturnType<typeof mapMessageRole>,
  source: BlockSource
): Block[] {
  if (part === null || part === undefined) return [];
  if (typeof part === 'string') {
    if (part.length === 0) return [];
    const block: TextBlock = {
      type: 'text',
      role: role === 'tool' ? 'user' : role,
      text: part,
      source,
    };
    return [block];
  }
  if (typeof part !== 'object') {
    return [makeUnknown(source.side, 'content part is not an object', part, source.path ?? '')];
  }

  const t = String(part.type ?? '');

  switch (t) {
    case 'text': {
      const text = typeof part.text === 'string' ? part.text : '';
      if (text.length === 0) return [];
      const block: TextBlock = {
        type: 'text',
        role: role === 'tool' ? 'user' : role,
        text,
        source,
      };
      if (Array.isArray(part.citations) && part.citations.length > 0) {
        block.citations = part.citations.map((c: any) => ({
          source: String(c?.source ?? c?.document_title ?? c?.type ?? ''),
          url: c?.url,
          title: c?.title ?? c?.document_title,
        }));
      }
      return [block];
    }

    case 'thinking': {
      const block: ReasoningBlock = {
        type: 'reasoning',
        role: 'assistant',
        reasoning_text: typeof part.thinking === 'string' ? part.thinking : '',
        source,
      };
      return [block];
    }

    case 'redacted_thinking': {
      const block: ReasoningBlock = {
        type: 'reasoning',
        role: 'assistant',
        // The plaintext isn't available — store the encrypted blob ID/data
        // so the UI can show "encrypted" without claiming empty content.
        reasoning_text:
          typeof part.data === 'string'
            ? part.data
            : safeStringify(part.data ?? ''),
        is_encrypted: true,
        source,
      };
      return [block];
    }

    case 'tool_use': {
      const block: ToolCallBlock = {
        type: 'tool_call',
        role: 'assistant',
        tool_id: String(part.id ?? `tool_use:${source.path ?? source.index ?? 'unk'}`),
        tool_name: String(part.name ?? ''),
        kind: 'function',
        input: part.input ?? {},
        source,
      };
      return [block];
    }

    case 'server_tool_use': {
      const name = String(part.name ?? '');
      const block: ToolCallBlock = {
        type: 'tool_call',
        role: 'assistant',
        tool_id: String(part.id ?? `server_tool_use:${source.path ?? source.index ?? 'unk'}`),
        tool_name: name,
        kind: serverToolKindFromName(name),
        input: part.input ?? {},
        source,
      };
      return [block];
    }

    case 'tool_result': {
      // tool_result lives inside a user-role message but the schema forces
      // role='tool'.
      const toolUseId = String(part.tool_use_id ?? part.id ?? '');
      const content = part.content;
      const { text, structured } = flattenToolResultContent(content);
      const block: ToolResultBlock = {
        type: 'tool_result',
        role: 'tool',
        tool_id: toolUseId,
        tool_name: '', // not present on Anthropic tool_result; renderer can
        // look it up via pairing.
        result_text: text,
        is_error: part.is_error === true,
        source,
      };
      if (structured !== undefined) block.result_structured = structured;
      return [block];
    }

    case 'web_search_tool_result': {
      const toolUseId = String(part.tool_use_id ?? part.id ?? '');
      const block: ToolResultBlock = {
        type: 'tool_result',
        role: 'tool',
        tool_id: toolUseId,
        tool_name: 'web_search',
        result_text: safeStringify(part.content ?? ''),
        result_structured: part.content,
        source,
      };
      return [block];
    }

    case 'image': {
      const block = anthropicMediaToBlock(part, 'image', role, source);
      return block ? [block] : [];
    }

    case 'document': {
      const block = anthropicMediaToBlock(part, 'document', role, source);
      return block ? [block] : [];
    }

    default:
      return [
        makeUnknown(source.side, `unrecognized content type=${t}`, part, source.path ?? ''),
      ];
  }
}

// ---------- helpers ----------

function mapMessageRole(role: any): 'user' | 'assistant' | 'system' | 'tool' {
  switch (role) {
    case 'assistant':
      return 'assistant';
    case 'system':
      return 'system';
    case 'user':
      return 'user';
    default:
      // Anthropic only allows 'user' and 'assistant' on messages[]; unknown
      // roles probably indicate a non-standard payload. Default to user so
      // we still render the content somewhere.
      return 'user';
  }
}

function serverToolKindFromName(name: string): ToolCallBlock['kind'] {
  const n = name.toLowerCase();
  if (n.includes('web_search') || n === 'web_search_tool') return 'web_search';
  if (n.includes('file_search') || n === 'file_search_tool') return 'file_search';
  if (n.includes('code') || n.includes('python')) return 'code_exec';
  if (n.includes('image') && (n.includes('gen') || n.includes('create'))) return 'image_gen';
  return 'function';
}

/**
 * Anthropic tool_result.content can be:
 *   - string
 *   - Array<{type: 'text', text} | {type: 'image', source}>
 * We extract a flat text blob (concatenated text parts) and preserve the
 * original array as result_structured if it carried more than text.
 */
function flattenToolResultContent(
  content: unknown
): { text: string; structured?: unknown } {
  if (content === undefined || content === null) {
    return { text: '' };
  }
  if (typeof content === 'string') {
    return { text: content };
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    let sawNonText = false;
    for (const c of content) {
      if (c && typeof c === 'object') {
        if (c.type === 'text' && typeof c.text === 'string') {
          parts.push(c.text);
        } else {
          sawNonText = true;
          // Best-effort include media descriptors as text
          parts.push(safeStringify(c));
        }
      } else if (typeof c === 'string') {
        parts.push(c);
      }
    }
    return {
      text: parts.join('\n'),
      structured: sawNonText ? content : undefined,
    };
  }
  // Object content — stringify
  return { text: safeStringify(content), structured: content };
}

/**
 * Build a MediaBlock from an Anthropic image/document content block.
 * Returns undefined and emits an UnknownBlock instead if the source shape is unrecognized.
 */
function anthropicMediaToBlock(
  part: any,
  media_type: 'image' | 'document',
  role: ReturnType<typeof mapMessageRole>,
  source: BlockSource
): Block | undefined {
  const src = part.source;
  if (!src || typeof src !== 'object') {
    return makeUnknown(source.side, `${media_type} missing source`, part, source.path ?? '');
  }
  const blockRole: MediaBlock['role'] = role === 'assistant' ? 'assistant' : 'user';

  // Common shapes:
  //   { type: 'base64', media_type: 'image/png', data: '...' }
  //   { type: 'url',    url: 'https://...' }
  //   { type: 'text',   media_type: 'text/plain', data: '...' }     (document)
  //   { type: 'content',content: [{type:'text', text:'...'}, ...] } (document)
  //   { type: 'file',   file_id: '...' }
  let mime = String(src.media_type ?? '');
  if (!mime) {
    mime = media_type === 'image' ? 'image/*' : 'application/octet-stream';
  }
  const block: MediaBlock = {
    type: 'media',
    role: blockRole,
    media_type,
    mime_type: mime,
    source,
  };
  if (typeof src.data === 'string') block.data_b64 = src.data;
  if (typeof src.url === 'string') block.url = src.url;
  if (typeof src.file_id === 'string') block.url = `file:${src.file_id}`;
  if (typeof part.title === 'string') block.filename = part.title;
  return block;
}

function parseSseData(data: unknown): any {
  if (data === null || data === undefined) return null;
  if (typeof data === 'object') return data;
  if (typeof data === 'string') {
    const trimmed = data.trim();
    if (trimmed === '' || trimmed === '[DONE]') return {};
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  return null;
}

function safeStringify(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function makeError(
  side: 'req' | 'resp',
  error_type: string,
  message: string,
  extra?: Record<string, unknown>
): ErrorBlock {
  return {
    type: 'error',
    role: 'system',
    error_type,
    error_message: extra ? `${message} (${safeStringify(extra)})` : message,
    source: { side, container: 'body' },
  };
}

function makeUnknown(
  side: 'req' | 'resp',
  desc: string,
  raw: unknown,
  pathStr: string
): UnknownBlock {
  return {
    type: 'unknown',
    role: 'system',
    raw_data: raw,
    block_source: desc,
    source: { side, container: 'body', path: pathStr },
  };
}
