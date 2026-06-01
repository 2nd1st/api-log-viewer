/**
 * Adapter for OpenAI Responses protocol (/v1/responses).
 *
 * Responses is the heavy SSE-driven protocol used by Codex / agentic clients.
 * A single turn has two halves:
 *
 *   1. PRIOR-TURN REPLAY -- req.body.input[] is the full transcript echoed
 *      back to the model. Items include `message`, `reasoning`,
 *      `function_call`, `function_call_output`, `custom_tool_call`,
 *      `custom_tool_call_output`. Plus a top-level `instructions` string
 *      that we surface as a system message.
 *
 *   2. NEW ASSISTANT TURN -- resp.events[] is the SSE stream. We rebuild
 *      blocks by `item_id`:
 *        - response.output_item.added (start a Block)
 *        - response.function_call_arguments.delta / .done (accumulate args)
 *        - response.output_text.delta / .done (accumulate text)
 *        - response.custom_tool_call_input.delta / .done (accumulate input)
 *        - response.content_part.added / .done (informational)
 *        - response.output_item.done (finalize, may carry encrypted_content
 *          for reasoning items that never streamed plaintext)
 *        - response.completed (terminal)
 *
 * Emission order: prior-turn blocks first, then SSE blocks in the order
 * their `output_item.added` events arrive. Tool_result blocks must share
 * `tool_id` with their tool_call -- we use `call_id` (e.g. "call_...") so
 * buildToolPairings() can match them.
 *
 * We never throw -- malformed shapes produce ErrorBlock entries with the
 * parse-failure detail so the UI can show what went wrong.
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
} from '../blocks';

// ---------------------------------------------------------------------------
// Local types -- intentionally permissive. We're parsing untrusted JSON.
// ---------------------------------------------------------------------------

import type { TraceBlob } from '../trace';

type Json = any;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeSource(
  side: 'req' | 'resp',
  container: BlockSource['container'],
  path: string,
  extra: Partial<BlockSource> = {}
): BlockSource {
  return { side, container, path, ...extra };
}

function tryParseJson(raw: string): unknown {
  if (typeof raw !== 'string' || raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function makeErrorBlock(
  source: BlockSource,
  errorType: string,
  message: string
): ErrorBlock {
  return {
    type: 'error',
    role: 'system',
    source,
    error_type: errorType,
    error_message: message,
  };
}

function makeUnknownBlock(source: BlockSource, raw: unknown, desc: string): Block {
  return {
    type: 'unknown',
    role: 'system',
    source,
    raw_data: raw,
    block_source: desc,
  };
}

// Map output_item.added item.type to a tool 'kind' label.
function toolKindFor(itemType: string): ToolCallBlock['kind'] {
  switch (itemType) {
    case 'function_call':
      return 'function';
    case 'custom_tool_call':
      return 'custom';
    case 'web_search_call':
      return 'web_search';
    case 'file_search_call':
      return 'file_search';
    case 'code_interpreter_call':
    case 'computer_call':
      return 'code_exec';
    case 'image_generation_call':
      return 'image_gen';
    default:
      return 'function';
  }
}

// ---------------------------------------------------------------------------
// Prior-turn (req.body.input[]) walker
// ---------------------------------------------------------------------------

function adaptInputItem(item: Json, index: number): Block[] {
  const pathBase = `trace.req.body.input[${index}]`;
  const source = safeSource('req', 'body', pathBase, { index });

  if (!item || typeof item !== 'object') {
    return [makeUnknownBlock(source, item, 'non-object input item')];
  }

  const itemType = String(item.type ?? '');

  try {
    switch (itemType) {
      case 'message':
        return adaptInputMessage(item, index);

      case 'reasoning': {
        // OpenAI Responses keeps the actual reasoning text server-side; the
        // client almost always receives ONLY encrypted_content + empty
        // summary[]. When the model does emit a summary (rare in codex
        // traffic), surface it on its own field. reasoning_text stays for
        // the rare cases where content[].text actually carries plaintext.
        const summaryText = Array.isArray(item.summary)
          ? item.summary
              .map((s: Json) => (typeof s?.text === 'string' ? s.text : ''))
              .filter((s: string) => s.length > 0)
              .join('\n')
          : '';
        const contentText = Array.isArray(item.content)
          ? item.content
              .map((c: Json) => (typeof c?.text === 'string' ? c.text : ''))
              .filter((s: string) => s.length > 0)
              .join('\n')
          : '';
        const block: ReasoningBlock = {
          type: 'reasoning',
          role: 'assistant',
          source,
          reasoning_text: contentText,
          summary: summaryText || undefined,
          id: typeof item.id === 'string' ? item.id : undefined,
          is_encrypted:
            typeof item.encrypted_content === 'string' &&
            item.encrypted_content.length > 0
              ? true
              : undefined,
        };
        return [block];
      }

      case 'function_call': {
        const args = typeof item.arguments === 'string' ? item.arguments : '';
        const parsed = tryParseJson(args);
        const callId = String(item.call_id ?? item.id ?? `fc_${index}`);
        const block: ToolCallBlock = {
          type: 'tool_call',
          role: 'assistant',
          source,
          tool_id: callId,
          tool_name: String(item.name ?? 'function'),
          kind: 'function',
          input: parsed !== undefined ? parsed : args,
          raw_input: parsed === undefined ? args : undefined,
          call_id: callId,
        };
        return [block];
      }

      case 'function_call_output': {
        const callId = String(item.call_id ?? `fc_out_${index}`);
        const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
        const block: ToolResultBlock = {
          type: 'tool_result',
          role: 'tool',
          source,
          tool_id: callId,
          tool_name: 'function',
          result_text: output,
          is_error: false,
        };
        return [block];
      }

      case 'custom_tool_call': {
        const callId = String(item.call_id ?? item.id ?? `ctc_${index}`);
        const input = typeof item.input === 'string' ? item.input : '';
        const block: ToolCallBlock = {
          type: 'tool_call',
          role: 'assistant',
          source,
          tool_id: callId,
          tool_name: String(item.name ?? 'custom'),
          kind: 'custom',
          input,
          raw_input: input,
          call_id: callId,
        };
        return [block];
      }

      case 'custom_tool_call_output': {
        const callId = String(item.call_id ?? `ctc_out_${index}`);
        const output = typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? '');
        const block: ToolResultBlock = {
          type: 'tool_result',
          role: 'tool',
          source,
          tool_id: callId,
          tool_name: 'custom',
          result_text: output,
          is_error: false,
        };
        return [block];
      }

      default:
        return [makeUnknownBlock(source, item, `unknown input item type "${itemType}"`)];
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return [makeErrorBlock(source, 'parse_error', `input[${index}] (${itemType}): ${msg}`)];
  }
}

function adaptInputMessage(item: Json, index: number): Block[] {
  const pathBase = `trace.req.body.input[${index}]`;
  const rawRole = String(item.role ?? 'user');
  const role: TextBlock['role'] =
    rawRole === 'assistant' || rawRole === 'developer' || rawRole === 'system'
      ? rawRole
      : 'user';

  const content = item.content;

  // String-form content: rare but legal in Responses API.
  if (typeof content === 'string') {
    return [
      {
        type: 'text',
        role,
        source: safeSource('req', 'body', `${pathBase}.content`, { index }),
        text: content,
      } satisfies TextBlock,
    ];
  }

  if (!Array.isArray(content)) {
    // Empty content (e.g. tool stub messages) -- skip silently.
    return [];
  }

  const out: Block[] = [];
  content.forEach((c: Json, ci: number) => {
    const cPath = `${pathBase}.content[${ci}]`;
    const cSource = safeSource('req', 'body', cPath, { index: ci });
    if (!c || typeof c !== 'object') {
      out.push(makeUnknownBlock(cSource, c, 'non-object content part'));
      return;
    }
    const cType = String(c.type ?? '');
    if (cType === 'input_text' || cType === 'output_text' || cType === 'text') {
      out.push({
        type: 'text',
        role,
        source: cSource,
        text: typeof c.text === 'string' ? c.text : '',
      } satisfies TextBlock);
    } else if (cType === 'input_image' || cType === 'image_url') {
      // input_image: the URL form is URL-only (we never
      // fetch remote https://...). The data: URL form is rare but legal —
      // when present, extract the base64 inline. NB: idx ordering matches
      // backend extractor walk order (convention, not contract — see
      // chat.ts comment).
      const url = typeof c.image_url === 'string' ? c.image_url : c.image_url?.url;
      const media: MediaBlock = {
        type: 'media',
        role: role === 'developer' || role === 'system' ? 'user' : role,
        source: cSource,
        media_type: 'image',
        mime_type: 'image/*',
      };
      if (typeof url === 'string' && url.startsWith('data:')) {
        const m = url.match(/^data:([^;,]+)(?:;base64)?,(.*)$/);
        if (m) {
          media.mime_type = m[1] || media.mime_type;
          media.data_b64 = m[2];
        } else {
          media.url = url;
        }
      } else if (typeof url === 'string') {
        media.url = url;
      }
      out.push(media);
    } else if (cType === 'input_file') {
      // input_file content block (Responses API): may carry inline base64
      // via `file_data` (data: URL or raw b64), a remote `file_url`, or a
      // server-side `file_id` reference. The backend extractor doesn't
      // currently extract input_file (UNTESTED — no real samples at write
      // time), so the idx convention only kicks in if/when it adds support;
      // until then the inline b64 is rendered directly from data_b64.
      const mediaRole: MediaBlock['role'] =
        role === 'developer' || role === 'system' ? 'user' : role;
      const filename = typeof c.filename === 'string' ? c.filename : undefined;
      const media: MediaBlock = {
        type: 'media',
        role: mediaRole,
        source: cSource,
        media_type: 'document',
        mime_type: 'application/octet-stream',
      };
      if (filename) media.filename = filename;
      const fileData = typeof c.file_data === 'string' ? c.file_data : undefined;
      const fileUrl = typeof c.file_url === 'string' ? c.file_url : undefined;
      const fileId = typeof c.file_id === 'string' ? c.file_id : undefined;
      if (fileData) {
        if (fileData.startsWith('data:')) {
          const m = fileData.match(/^data:([^;,]+)(?:;base64)?,(.*)$/);
          if (m) {
            media.mime_type = m[1] || media.mime_type;
            media.data_b64 = m[2];
          } else {
            media.data_b64 = fileData;
          }
        } else {
          media.data_b64 = fileData;
        }
      } else if (fileUrl) {
        media.url = fileUrl;
      } else if (fileId) {
        media.url = `file:${fileId}`;
      }
      out.push(media);
    } else {
      out.push(makeUnknownBlock(cSource, c, `unknown message content type "${cType}"`));
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// SSE walker
// ---------------------------------------------------------------------------

/**
 * Tracks an in-progress block built from SSE events, indexed by item_id.
 * The block is mutated in place as deltas/done events arrive; once
 * output_item.added has fired we already pushed the block into the output
 * array, so later mutations show up in the final result.
 */
interface InProgress {
  block: Block;
  // Accumulator buffers for streaming content. We keep these separate
  // from the block fields so we can still see partial state if .done
  // never arrives (truncated trace, connection drop).
  text?: string;
  args?: string;
  // Sibling MediaBlock for image_generation_call items. The image bytes
  // (b64) arrive on output_item.done, not .added, so we pre-create an
  // empty MediaBlock at start time and fill it at finalize time.
  // Mutated in place; already pushed to `out`.
  media?: MediaBlock;
}

function adaptEvents(events: Array<{ event?: string; data?: Json }>): Block[] {
  const out: Block[] = [];
  const byItemId = new Map<string, InProgress>();

  events.forEach((evt, evtIdx) => {
    const eventName = String(evt?.event ?? '');
    const data = evt?.data ?? {};
    const source = safeSource('resp', 'events', `trace.resp.events[${evtIdx}]`, {
      index: evtIdx,
      event_type: eventName,
    });

    try {
      switch (eventName) {
        case 'response.created':
        case 'response.in_progress':
        case 'response.content_part.added':
        case 'response.content_part.done':
          // Informational -- text accumulates via output_text.delta/.done
          // and the .added/.done content_part events don't carry new content
          // beyond what we already track.
          return;

        case 'response.output_item.added':
          startBlock(data, source, out, byItemId);
          return;

        case 'response.function_call_arguments.delta': {
          const id = String(data.item_id ?? '');
          const ip = byItemId.get(id);
          if (!ip || ip.block.type !== 'tool_call') return;
          const delta = typeof data.delta === 'string' ? data.delta : '';
          ip.args = (ip.args ?? '') + delta;
          ip.block.raw_input = ip.args;
          return;
        }

        case 'response.function_call_arguments.done': {
          const id = String(data.item_id ?? '');
          const ip = byItemId.get(id);
          if (!ip || ip.block.type !== 'tool_call') return;
          const finalArgs =
            typeof data.arguments === 'string' ? data.arguments : ip.args ?? '';
          ip.args = finalArgs;
          ip.block.raw_input = finalArgs;
          const parsed = tryParseJson(finalArgs);
          if (parsed !== undefined) {
            ip.block.input = parsed;
          } else {
            ip.block.input = finalArgs;
          }
          return;
        }

        case 'response.custom_tool_call_input.delta': {
          const id = String(data.item_id ?? '');
          const ip = byItemId.get(id);
          if (!ip || ip.block.type !== 'tool_call') return;
          const delta = typeof data.delta === 'string' ? data.delta : '';
          ip.args = (ip.args ?? '') + delta;
          ip.block.raw_input = ip.args;
          ip.block.input = ip.args;
          return;
        }

        case 'response.custom_tool_call_input.done': {
          const id = String(data.item_id ?? '');
          const ip = byItemId.get(id);
          if (!ip || ip.block.type !== 'tool_call') return;
          const finalInput = typeof data.input === 'string' ? data.input : ip.args ?? '';
          ip.args = finalInput;
          ip.block.raw_input = finalInput;
          ip.block.input = finalInput;
          return;
        }

        case 'response.output_text.delta': {
          const id = String(data.item_id ?? '');
          const ip = byItemId.get(id);
          if (!ip || ip.block.type !== 'text') return;
          const delta = typeof data.delta === 'string' ? data.delta : '';
          ip.text = (ip.text ?? '') + delta;
          ip.block.text = ip.text;
          return;
        }

        case 'response.output_text.done': {
          const id = String(data.item_id ?? '');
          const ip = byItemId.get(id);
          if (!ip || ip.block.type !== 'text') return;
          const finalText = typeof data.text === 'string' ? data.text : ip.text ?? '';
          ip.text = finalText;
          ip.block.text = finalText;
          return;
        }

        case 'response.output_item.done': {
          finalizeItem(data, byItemId);
          return;
        }

        case 'response.completed':
        case 'response.failed':
        case 'response.incomplete':
          // Terminal -- nothing left to accumulate. We could harvest
          // .response.output here as a fallback if SSE was truncated, but
          // for v0 we trust the per-item events we've already processed.
          return;

        default:
          // Unknown event type -- skip silently. Many newer events
          // (reasoning summary deltas, refusal, etc.) we don't yet model
          // and ignoring them is better than polluting the timeline.
          return;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      out.push(
        makeErrorBlock(source, 'sse_frame_error', `events[${evtIdx}] (${eventName}): ${msg}`)
      );
    }
  });

  return out;
}

function startBlock(
  data: Json,
  source: BlockSource,
  out: Block[],
  byItemId: Map<string, InProgress>
): void {
  const item = data?.item;
  if (!item || typeof item !== 'object') return;
  const itemId = String(item.id ?? '');
  if (!itemId) return;
  // Don't double-emit if an item_id repeats (defensive).
  if (byItemId.has(itemId)) return;

  const itemType = String(item.type ?? '');

  if (itemType === 'message') {
    const block: TextBlock = {
      type: 'text',
      role: 'assistant',
      source,
      text: '',
    };
    byItemId.set(itemId, { block, text: '' });
    out.push(block);
    return;
  }

  if (itemType === 'reasoning') {
    const block: ReasoningBlock = {
      type: 'reasoning',
      role: 'assistant',
      source,
      reasoning_text: '',
      id: typeof item.id === 'string' ? item.id : undefined,
      is_encrypted:
        typeof item.encrypted_content === 'string' && item.encrypted_content.length > 0
          ? true
          : undefined,
    };
    byItemId.set(itemId, { block });
    out.push(block);
    return;
  }

  if (
    itemType === 'function_call' ||
    itemType === 'custom_tool_call' ||
    itemType === 'web_search_call' ||
    itemType === 'file_search_call' ||
    itemType === 'code_interpreter_call' ||
    itemType === 'computer_call' ||
    itemType === 'image_generation_call'
  ) {
    const callId = String(item.call_id ?? item.id ?? itemId);
    const initialArgs = typeof item.arguments === 'string' ? item.arguments : '';
    const initialInput = typeof item.input === 'string' ? item.input : '';
    const seedRaw = initialArgs || initialInput;
    const block: ToolCallBlock = {
      type: 'tool_call',
      role: 'assistant',
      source,
      tool_id: callId,
      tool_name: String(item.name ?? itemType),
      kind: toolKindFor(itemType),
      input: seedRaw ? tryParseJson(seedRaw) ?? seedRaw : '',
      raw_input: seedRaw || undefined,
      call_id: callId,
    };
    const slot: InProgress = { block, args: seedRaw };

    // image_generation_call: pre-create a sibling MediaBlock. The actual
    // base64 `result` lands on output_item.done; we fill data_b64 there.
    // UNTESTED — no real samples at write time; field shape (`result` as
    // b64, `output_format` for mime) is taken from the OpenAI Responses
    // spec. NB: idx ordering matches backend extractor walk order
    // (convention not contract — see chat.ts comment).
    if (itemType === 'image_generation_call') {
      const seedResult = typeof item.result === 'string' ? item.result : undefined;
      const seedFormat =
        typeof item.output_format === 'string' ? item.output_format : undefined;
      const media: MediaBlock = {
        type: 'media',
        role: 'assistant',
        source,
        media_type: 'image',
        mime_type: seedFormat ? `image/${seedFormat}` : 'image/png',
      };
      if (seedResult) media.data_b64 = seedResult;
      slot.media = media;
      out.push(block);
      out.push(media);
      byItemId.set(itemId, slot);
      return;
    }

    byItemId.set(itemId, slot);
    out.push(block);
    return;
  }

  // Unrecognized output_item -- record it so we can see what slipped through.
  const unknown = makeUnknownBlock(source, item, `unrecognized output_item.type "${itemType}"`);
  byItemId.set(itemId, { block: unknown });
  out.push(unknown);
}

function finalizeItem(data: Json, byItemId: Map<string, InProgress>): void {
  const item = data?.item;
  if (!item || typeof item !== 'object') return;
  const itemId = String(item.id ?? '');
  const ip = byItemId.get(itemId);
  if (!ip) return;

  // Reasoning items only carry meaningful content on .done -- the model
  // never emits a streaming reasoning delta in this protocol; we just see
  // .added (empty) and .done (with encrypted_content and/or summary).
  if (ip.block.type === 'reasoning' && item.type === 'reasoning') {
    const summaryText = Array.isArray(item.summary)
      ? item.summary
          .map((s: Json) => (typeof s?.text === 'string' ? s.text : ''))
          .filter((s: string) => s.length > 0)
          .join('\n')
      : '';
    const contentText = Array.isArray(item.content)
      ? item.content
          .map((c: Json) => (typeof c?.text === 'string' ? c.text : ''))
          .filter((s: string) => s.length > 0)
          .join('\n')
      : '';
    if (contentText.length > 0) ip.block.reasoning_text = contentText;
    if (summaryText.length > 0) ip.block.summary = summaryText;
    if (typeof item.id === 'string' && !ip.block.id) ip.block.id = item.id;
    if (
      typeof item.encrypted_content === 'string' &&
      item.encrypted_content.length > 0
    ) {
      ip.block.is_encrypted = true;
    } else if (contentText.length > 0) {
      ip.block.is_encrypted = undefined;
    }
    return;
  }

  // For message items, response.output_item.done carries the final content
  // array. Use it as a fallback if output_text.done never delivered text
  // (e.g. refusal, non-text content).
  if (ip.block.type === 'text' && item.type === 'message') {
    if (!ip.block.text || ip.block.text.length === 0) {
      const parts: string[] = Array.isArray(item.content)
        ? item.content.map((c: Json) => (typeof c?.text === 'string' ? c.text : ''))
        : [];
      const text = parts.filter((s: string) => s.length > 0).join('\n');
      if (text.length > 0) ip.block.text = text;
    }
    return;
  }

  // For tool calls, mirror final args/input from the item snapshot if our
  // streamed accumulator missed it.
  if (ip.block.type === 'tool_call') {
    const finalArgs = typeof item.arguments === 'string' ? item.arguments : '';
    const finalInput = typeof item.input === 'string' ? item.input : '';
    const snapshot = finalArgs || finalInput;
    if (snapshot && (!ip.block.raw_input || ip.block.raw_input.length === 0)) {
      ip.block.raw_input = snapshot;
      const parsed = tryParseJson(snapshot);
      ip.block.input = parsed !== undefined ? parsed : snapshot;
    }
    // image_generation_call: fill the sibling MediaBlock's data_b64 from
    // item.result. Mime taken from item.output_format if present, else
    // left as the default seeded at start time. The MediaBlock has been
    // in `out` since startBlock; mutating in place is the same pattern
    // used for streamed text/reasoning blocks above.
    if (ip.media && item.type === 'image_generation_call') {
      const finalResult = typeof item.result === 'string' ? item.result : '';
      if (finalResult && !ip.media.data_b64) ip.media.data_b64 = finalResult;
      const fmt =
        typeof item.output_format === 'string' ? item.output_format : '';
      if (fmt) ip.media.mime_type = `image/${fmt}`;
    }
    return;
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function adapt(_path: string, traceBlob: TraceBlob): Block[] {
  const blocks: Block[] = [];

  if (!traceBlob || typeof traceBlob !== 'object') {
    return [
      makeErrorBlock(
        safeSource('req', 'body', 'trace'),
        'parse_error',
        'traceBlob is not an object'
      ),
    ];
  }

  // ----- Phase 1: prior-turn replay from req.body -----

  const reqBody = traceBlob.req?.body;
  if (reqBody && typeof reqBody === 'object') {
    try {
      // instructions -- a single system-side string in Responses (separate
      // from the input[] array). Surface it so users can see the system
      // prompt in conversation order.
      if (typeof reqBody.instructions === 'string' && reqBody.instructions.length > 0) {
        blocks.push({
          type: 'text',
          role: 'system',
          source: safeSource('req', 'body', 'trace.req.body.instructions'),
          text: reqBody.instructions,
        } satisfies TextBlock);
      }

      const input = reqBody.input;
      if (Array.isArray(input)) {
        input.forEach((item: Json, idx: number) => {
          for (const block of adaptInputItem(item, idx)) {
            blocks.push(block);
          }
        });
      } else if (input !== undefined && input !== null) {
        // Some clients send `input: "..."` as a bare string for one-shot
        // calls. Treat it like a single user message.
        if (typeof input === 'string') {
          blocks.push({
            type: 'text',
            role: 'user',
            source: safeSource('req', 'body', 'trace.req.body.input'),
            text: input,
          } satisfies TextBlock);
        } else {
          blocks.push(
            makeUnknownBlock(
              safeSource('req', 'body', 'trace.req.body.input'),
              input,
              'req.body.input is not an array or string'
            )
          );
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      blocks.push(
        makeErrorBlock(
          safeSource('req', 'body', 'trace.req.body'),
          'parse_error',
          `req.body walk failed: ${msg}`
        )
      );
    }
  }

  // ----- Phase 2: SSE stream from resp.events -----

  const events = traceBlob.resp?.events;
  if (Array.isArray(events) && events.length > 0) {
    try {
      const sseBlocks = adaptEvents(events);
      for (const b of sseBlocks) blocks.push(b);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      blocks.push(
        makeErrorBlock(
          safeSource('resp', 'events', 'trace.resp.events'),
          'sse_frame_error',
          `events walk failed: ${msg}`
        )
      );
    }
  }

  return blocks;
}
