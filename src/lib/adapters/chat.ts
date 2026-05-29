/**
 * Adapter for the OpenAI Chat Completions protocol (POST /v1/chat/completions).
 *
 * Real-world shapes (verified against /tmp/sub2api-samples/details):
 *   - req.body is almost always a parsed dict with `messages: [...]`.
 *   - resp can arrive in any of these forms:
 *       (a) resp.body = dict     -> either a chat.completion OR an error envelope
 *                                   ({ error: { message, type } }).
 *       (b) resp.body_b64 set    -> raw bytes. ~50% of traffic ends up here even
 *                                   on the happy path, because the upstream tried
 *                                   to parse SSE first, failed ("sse: no SSE frames
 *                                   found"), and stuffed the raw JSON into b64
 *                                   with a parse_error annotation. We MUST try
 *                                   JSON.parse first and only fall back to SSE
 *                                   reconstruction if that fails.
 *       (c) resp.events present  -> structured SSE events (rare for chat).
 *
 * Invariants:
 *   - Never throw. On any failure path, emit an ErrorBlock describing the issue
 *     and keep going.
 *   - Blocks are emitted in request-order, then response-order. The renderer
 *     uses `sequence_number` as a tiebreaker.
 *   - Every Block carries a `source` annotation so the operator can trace it
 *     back to the raw blob.
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

// ==================== Public API ====================

export function adapt(path: string, traceBlob: TraceBlob): Block[] {
  // `path` is accepted to match the adapter signature and to leave room for
  // path-conditional behavior (e.g. legacy /v1/completions reuse). Chat
  // logic itself does not branch on it today.
  void path;
  const out: Block[] = [];
  let seq = 0;
  const nextSeq = () => seq++;

  try {
    // ---- Request ----
    if (traceBlob?.req) {
      const reqBody = traceBlob.req.body;
      if (reqBody && typeof reqBody === 'object') {
        emitFromRequestBody(reqBody, out, nextSeq);
      } else if (typeof traceBlob.req.body_b64 === 'string') {
        // Rare: caller stuffed the request into b64 (e.g. raw upload).
        const decoded = tryDecodeB64(traceBlob.req.body_b64);
        const parsed = decoded != null ? tryParseJson(decoded) : null;
        if (parsed && typeof parsed === 'object') {
          emitFromRequestBody(parsed as Record<string, unknown>, out, nextSeq, 'body_b64');
        } else {
          out.push(makeError('req', 'body_b64', 'parse_error', 'failed to decode request body_b64 as JSON', nextSeq()));
        }
      }
    }

    // ---- Response ----
    if (traceBlob?.resp) {
      adaptResponse(traceBlob.resp, out, nextSeq);
    }
  } catch (e) {
    // Defensive last-resort guard: never propagate.
    out.push(
      makeError(
        'resp',
        'body',
        'adapter_crash',
        `chat adapter threw: ${(e as Error)?.message ?? String(e)}`,
        nextSeq(),
      ),
    );
  }

  return out;
}

// ==================== Request walker ====================

/**
 * Walk `messages[]` in order. For each message:
 *   - role:'tool'   -> ToolResultBlock (linked via tool_call_id)
 *   - assistant tool_calls -> ToolCallBlock per call
 *   - content:string -> TextBlock
 *   - content:array  -> map each part (text/image_url) to Text or MediaBlock
 */
function emitFromRequestBody(
  body: Record<string, unknown>,
  out: Block[],
  nextSeq: () => number,
  container: 'body' | 'body_b64' = 'body',
): void {
  const messages = body['messages'];
  if (!Array.isArray(messages)) {
    // Not a chat.completion request shape; emit one unknown so it's visible.
    out.push(
      makeUnknown(
        'req',
        container,
        'request body has no messages[] array',
        body,
        nextSeq(),
        undefined,
      ),
    );
    return;
  }

  messages.forEach((rawMsg, mi) => {
    if (!rawMsg || typeof rawMsg !== 'object') return;
    const msg = rawMsg as Record<string, unknown>;
    const role = asString(msg['role']) ?? 'user';
    const basePath = `trace.req.body.messages[${mi}]`;

    // tool message -> ToolResultBlock
    if (role === 'tool') {
      const toolCallId = asString(msg['tool_call_id']) ?? `chat:tool:${mi}`;
      const content = msg['content'];
      const resultText = typeof content === 'string'
        ? content
        : (content == null ? '' : safeStringify(content));
      const tr: ToolResultBlock = {
        type: 'tool_result',
        role: 'tool',
        source: {
          side: 'req',
          container,
          path: basePath,
          index: mi,
        },
        sequence_number: nextSeq(),
        tool_id: toolCallId,
        tool_name: asString(msg['name']) ?? 'unknown',
        result_text: resultText,
      };
      out.push(tr);
      return;
    }

    // assistant tool_calls (may coexist with content)
    if (role === 'assistant' && Array.isArray(msg['tool_calls'])) {
      const toolCalls = msg['tool_calls'] as Array<Record<string, unknown>>;
      toolCalls.forEach((tc, ti) => {
        out.push(toolCallFromChat(tc, ti, {
          side: 'req',
          container,
          path: `${basePath}.tool_calls[${ti}]`,
          index: ti,
        }, nextSeq()));
      });
    }

    // content
    const content = msg['content'];
    if (typeof content === 'string') {
      if (content.length === 0) return; // skip blank
      out.push(textBlock(content, role, {
        side: 'req',
        container,
        path: `${basePath}.content`,
        index: mi,
      }, nextSeq()));
    } else if (Array.isArray(content)) {
      content.forEach((part, pi) => {
        const partSource: BlockSource = {
          side: 'req',
          container,
          path: `${basePath}.content[${pi}]`,
          index: pi,
        };
        emitContentPart(part, role, partSource, out, nextSeq);
      });
    } else if (content == null) {
      // assistant message with only tool_calls is valid; skip silently.
    } else {
      out.push(
        makeUnknown('req', container, 'unrecognized content shape', content, nextSeq(), `${basePath}.content`),
      );
    }
  });
}

/**
 * Map one chat-style content array entry to a Block.
 *   { type: 'text', text } -> TextBlock
 *   { type: 'image_url', image_url: { url } } -> MediaBlock
 *   { type: 'input_audio', input_audio: { data, format } } -> MediaBlock
 *   anything else -> UnknownBlock
 */
function emitContentPart(
  part: unknown,
  role: string,
  source: BlockSource,
  out: Block[],
  nextSeq: () => number,
): void {
  if (!part || typeof part !== 'object') {
    out.push(makeUnknown(source.side, source.container, 'non-object content part', part, nextSeq(), source.path));
    return;
  }
  const p = part as Record<string, unknown>;
  const t = asString(p['type']);

  if (t === 'text' || (typeof p['text'] === 'string' && !t)) {
    const text = asString(p['text']) ?? '';
    out.push(textBlock(text, role, source, nextSeq()));
    return;
  }

  if (t === 'image_url') {
    const inner = p['image_url'];
    const url = typeof inner === 'string'
      ? inner
      : (inner && typeof inner === 'object' ? asString((inner as Record<string, unknown>)['url']) : undefined);
    const media: MediaBlock = {
      type: 'media',
      role: role === 'assistant' ? 'assistant' : 'user',
      source,
      sequence_number: nextSeq(),
      media_type: 'image',
      mime_type: guessMimeFromUrl(url) ?? 'image/*',
      url: url ?? undefined,
    };
    // dataURI in url -> store as data_b64 too for downstream display.
    if (url && url.startsWith('data:')) {
      const m = url.match(/^data:([^;,]+)(?:;base64)?,(.*)$/);
      if (m) {
        media.mime_type = m[1] || media.mime_type;
        media.data_b64 = m[2];
      }
    }
    out.push(media);
    return;
  }

  if (t === 'input_audio') {
    const inner = (p['input_audio'] ?? {}) as Record<string, unknown>;
    const fmt = asString(inner['format']) ?? 'wav';
    const media: MediaBlock = {
      type: 'media',
      role: role === 'assistant' ? 'assistant' : 'user',
      source,
      sequence_number: nextSeq(),
      media_type: 'audio',
      mime_type: `audio/${fmt}`,
      data_b64: asString(inner['data']) ?? undefined,
    };
    out.push(media);
    return;
  }

  out.push(makeUnknown(source.side, source.container, `unknown content part type=${t ?? '?'}`, part, nextSeq(), source.path));
}

// ==================== Response handling ====================

function adaptResponse(
  resp: NonNullable<TraceBlob['resp']>,
  out: Block[],
  nextSeq: () => number,
): void {
  // 1) Structured events (rare for chat; mirror the Responses-style ingest).
  const events = resp.events ?? [];
  if (events.length > 0) {
    adaptSseEvents(events, out, nextSeq);
    return;
  }

  // 2) Parsed body dict — could be chat.completion OR an error envelope.
  if (resp.body && typeof resp.body === 'object') {
    walkResponseObject(resp.body as Record<string, unknown>, 'body', out, nextSeq);
    return;
  }

  // 3) body_b64 fallback — try JSON first (200s with parse_error live here),
  //    then SSE reconstruction, then surface the parse error.
  if (typeof resp.body_b64 === 'string' && resp.body_b64.length > 0) {
    const decoded = tryDecodeB64(resp.body_b64);
    if (decoded == null) {
      out.push(
        makeError(
          'resp',
          'body_b64',
          'b64_decode_error',
          `failed to base64-decode response body_b64${formatParseErr(resp)}`,
          nextSeq(),
        ),
      );
      return;
    }

    // Try plain JSON first — happy path for non-streamed responses.
    const asJson = tryParseJson(decoded);
    if (asJson && typeof asJson === 'object') {
      walkResponseObject(asJson as Record<string, unknown>, 'body_b64', out, nextSeq);
      return;
    }

    // SSE reconstruction.
    const sseSynth = trySseReconstruct(decoded);
    if (sseSynth.synthesized) {
      walkResponseObject(sseSynth.value as Record<string, unknown>, 'body_b64', out, nextSeq);
      return;
    }

    // Neither JSON nor SSE worked — emit the parse error with a snippet.
    const snippet = decoded.slice(0, 200);
    out.push(
      makeError(
        'resp',
        'body_b64',
        'parse_error',
        `could not parse response body_b64 as JSON or SSE${formatParseErr(resp)}; snippet: ${snippet}`,
        nextSeq(),
      ),
    );
    return;
  }

  // 4) Nothing usable — possibly a 5xx with no captured body. If the upstream
  //    annotated a parse_error, surface it; otherwise stay silent so the
  //    timeline doesn't bloat with empty noise.
  const parseErr = (resp as Record<string, unknown>)['parse_error'];
  if (typeof parseErr === 'string' && parseErr.length > 0) {
    out.push(
      makeError(
        'resp',
        'body',
        'parse_error',
        `upstream reported parse_error with no body captured: ${parseErr}`,
        nextSeq(),
      ),
    );
  }
}

/**
 * Discriminator for a parsed response object. Used by both the `body`-dict
 * path and the `body_b64 -> JSON` path.
 *   - has `choices` -> walk choices[].message.{reasoning_content, content, tool_calls}
 *   - has `error`   -> ErrorBlock
 *   - otherwise     -> UnknownBlock
 */
function walkResponseObject(
  body: Record<string, unknown>,
  container: 'body' | 'body_b64' | 'events',
  out: Block[],
  nextSeq: () => number,
): void {
  // Error envelope: { error: { message, type, code? } }
  if (body['error'] && typeof body['error'] === 'object') {
    const err = body['error'] as Record<string, unknown>;
    const eb: ErrorBlock = {
      type: 'error',
      role: 'system',
      source: { side: 'resp', container, path: 'trace.resp.body.error' },
      sequence_number: nextSeq(),
      error_type: asString(err['type']) ?? 'api_error',
      error_message: asString(err['message']) ?? safeStringify(err),
      error_code: asString(err['code']),
    };
    out.push(eb);
    return;
  }

  const choices = body['choices'];
  if (!Array.isArray(choices)) {
    out.push(
      makeUnknown(
        'resp',
        container,
        'response body has neither choices[] nor error{}',
        body,
        nextSeq(),
        'trace.resp.body',
      ),
    );
    return;
  }

  choices.forEach((rawChoice, ci) => {
    if (!rawChoice || typeof rawChoice !== 'object') return;
    const choice = rawChoice as Record<string, unknown>;
    const message = (choice['message'] ?? choice['delta']) as Record<string, unknown> | undefined;
    if (!message || typeof message !== 'object') return;
    const basePath = `trace.resp.body.choices[${ci}].message`;

    // reasoning_content first (some providers stream it before answer text)
    const reasoning = message['reasoning_content'];
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      const rb: ReasoningBlock = {
        type: 'reasoning',
        role: 'assistant',
        source: { side: 'resp', container, path: `${basePath}.reasoning_content`, index: ci },
        sequence_number: nextSeq(),
        reasoning_text: reasoning,
      };
      out.push(rb);
    }

    // visible content
    const content = message['content'];
    if (typeof content === 'string' && content.length > 0) {
      out.push(textBlock(content, 'assistant', {
        side: 'resp',
        container,
        path: `${basePath}.content`,
        index: ci,
      }, nextSeq()));
    } else if (Array.isArray(content)) {
      // chat content arrays are rare on responses, but be lenient.
      content.forEach((part, pi) => {
        emitContentPart(part, 'assistant', {
          side: 'resp',
          container,
          path: `${basePath}.content[${pi}]`,
          index: pi,
        }, out, nextSeq);
      });
    }

    // tool_calls
    const toolCalls = message['tool_calls'];
    if (Array.isArray(toolCalls)) {
      toolCalls.forEach((tc, ti) => {
        if (!tc || typeof tc !== 'object') return;
        out.push(
          toolCallFromChat(tc as Record<string, unknown>, ti, {
            side: 'resp',
            container,
            path: `${basePath}.tool_calls[${ti}]`,
            index: ti,
          }, nextSeq()),
        );
      });
    }
  });
}

// ==================== SSE handling ====================

/**
 * Try to reconstruct a chat.completion-shaped object from a raw SSE byte
 * stream. Chat SSE frames look like:
 *   data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}
 *   data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"name":"foo","arguments":"{\"x\":"}}]}}]}
 *   data: [DONE]
 *
 * Returns { synthesized: false } if we couldn't find any usable frames.
 * On success, returns a chat.completion object so walkResponseObject can
 * consume it via the normal `choices[]` path.
 */
function trySseReconstruct(decoded: string): { synthesized: boolean; value: unknown } {
  const lines = decoded.split(/\r?\n/);
  const frames: Array<Record<string, unknown>> = [];
  for (const ln of lines) {
    if (!ln.startsWith('data:')) continue;
    const payload = ln.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    const parsed = tryParseJson(payload);
    if (parsed && typeof parsed === 'object') {
      frames.push(parsed as Record<string, unknown>);
    }
  }
  if (frames.length === 0) return { synthesized: false, value: null };

  // Accumulate per choice index. chat-completion stream uses `delta` (not
  // `message`) and groups tool_calls by their own `.index`, not by id.
  type Acc = {
    content: string;
    reasoning: string;
    role?: string;
    tool_calls: Map<number, { id?: string; name?: string; args: string }>;
  };
  const choicesAcc = new Map<number, Acc>();
  const ensure = (ci: number): Acc => {
    let a = choicesAcc.get(ci);
    if (!a) {
      a = { content: '', reasoning: '', tool_calls: new Map() };
      choicesAcc.set(ci, a);
    }
    return a;
  };

  for (const frame of frames) {
    const choices = frame['choices'];
    if (!Array.isArray(choices)) continue;
    for (const rawCh of choices) {
      if (!rawCh || typeof rawCh !== 'object') continue;
      const ch = rawCh as Record<string, unknown>;
      const ci = typeof ch['index'] === 'number' ? (ch['index'] as number) : 0;
      const acc = ensure(ci);
      const delta = ch['delta'] as Record<string, unknown> | undefined;
      if (!delta) continue;

      if (typeof delta['role'] === 'string') acc.role = delta['role'] as string;
      if (typeof delta['content'] === 'string') acc.content += delta['content'] as string;
      if (typeof delta['reasoning_content'] === 'string') acc.reasoning += delta['reasoning_content'] as string;

      const tcs = delta['tool_calls'];
      if (Array.isArray(tcs)) {
        for (const rawTc of tcs) {
          if (!rawTc || typeof rawTc !== 'object') continue;
          const tc = rawTc as Record<string, unknown>;
          const tci = typeof tc['index'] === 'number' ? (tc['index'] as number) : 0;
          let slot = acc.tool_calls.get(tci);
          if (!slot) {
            slot = { args: '' };
            acc.tool_calls.set(tci, slot);
          }
          if (typeof tc['id'] === 'string') slot.id = tc['id'] as string;
          const fn = tc['function'] as Record<string, unknown> | undefined;
          if (fn) {
            if (typeof fn['name'] === 'string') slot.name = fn['name'] as string;
            if (typeof fn['arguments'] === 'string') slot.args += fn['arguments'] as string;
          }
        }
      }
    }
  }

  // Synthesize a chat.completion-shaped object.
  const choices: Array<Record<string, unknown>> = [];
  const sortedKeys = Array.from(choicesAcc.keys()).sort((a, b) => a - b);
  for (const ci of sortedKeys) {
    const acc = choicesAcc.get(ci)!;
    const message: Record<string, unknown> = {
      role: acc.role ?? 'assistant',
    };
    if (acc.content) message['content'] = acc.content;
    if (acc.reasoning) message['reasoning_content'] = acc.reasoning;
    if (acc.tool_calls.size > 0) {
      const tcArr = Array.from(acc.tool_calls.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([idx, slot]) => ({
          index: idx,
          id: slot.id,
          type: 'function',
          function: { name: slot.name, arguments: slot.args },
        }));
      message['tool_calls'] = tcArr;
    }
    choices.push({ index: ci, message });
  }
  return { synthesized: true, value: { choices } };
}

/**
 * Adapt structured SSE events (`resp.events`). Chat almost never uses this,
 * but the upstream may surface it; we route through the same reconstruction
 * by stitching events back into a textual SSE payload.
 */
function adaptSseEvents(
  events: Array<{ t_delta_ms?: number; event?: string; data?: unknown }>,
  out: Block[],
  nextSeq: () => number,
): void {
  const lines: string[] = [];
  for (const ev of events) {
    if (ev?.data == null) continue;
    const payload = typeof ev.data === 'string' ? ev.data : safeStringify(ev.data);
    lines.push(`data: ${payload}`);
  }
  const synth = trySseReconstruct(lines.join('\n'));
  if (synth.synthesized) {
    walkResponseObject(synth.value as Record<string, unknown>, 'events', out, nextSeq);
  } else {
    out.push(
      makeError(
        'resp',
        'events',
        'sse_frame_error',
        `could not reconstruct chat.completion from ${events.length} SSE event(s)`,
        nextSeq(),
      ),
    );
  }
}

// ==================== Block constructors ====================

function textBlock(text: string, role: string, source: BlockSource, seq: number): TextBlock {
  return {
    type: 'text',
    role: (['user', 'assistant', 'system', 'developer'].includes(role) ? role : 'user') as TextBlock['role'],
    source,
    sequence_number: seq,
    text,
  };
}

function toolCallFromChat(
  tc: Record<string, unknown>,
  fallbackIdx: number,
  source: BlockSource,
  seq: number,
): ToolCallBlock {
  const id = asString(tc['id']) ?? `chat:tool_call:${fallbackIdx}`;
  const fn = (tc['function'] ?? {}) as Record<string, unknown>;
  const name = asString(fn['name']) ?? 'unknown';
  const rawArgs = asString(fn['arguments']) ?? '';
  let input: unknown = undefined;
  let raw_input: string | undefined;
  if (rawArgs.length > 0) {
    const parsed = tryParseJson(rawArgs);
    if (parsed !== undefined) {
      input = parsed;
    } else {
      // Either still streaming or non-JSON arguments — preserve verbatim.
      raw_input = rawArgs;
    }
  }
  return {
    type: 'tool_call',
    role: 'assistant',
    source,
    sequence_number: seq,
    tool_id: id,
    tool_name: name,
    kind: 'function',
    input,
    raw_input,
    call_id: id,
  };
}

function makeError(
  side: 'req' | 'resp',
  container: 'body' | 'events' | 'body_b64',
  error_type: string,
  error_message: string,
  seq: number,
): ErrorBlock {
  return {
    type: 'error',
    role: 'system',
    source: { side, container },
    sequence_number: seq,
    error_type,
    error_message,
  };
}

function makeUnknown(
  side: 'req' | 'resp',
  container: 'body' | 'events' | 'body_b64',
  description: string,
  raw: unknown,
  seq: number,
  path?: string,
): UnknownBlock {
  return {
    type: 'unknown',
    role: 'system',
    source: { side, container, path },
    sequence_number: seq,
    raw_data: raw,
    block_source: description,
  };
}

// ==================== Tiny helpers ====================

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function tryParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function tryDecodeB64(b64: string): string | null {
  try {
    if (typeof atob === 'function') {
      // browser path: atob -> percent-encoded UTF-8 reconstruction
      const bin = atob(b64);
      // Use TextDecoder when available for proper UTF-8.
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      if (typeof TextDecoder !== 'undefined') {
        return new TextDecoder('utf-8').decode(bytes);
      }
      return bin;
    }
    // Node fallback (tests).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const B = (globalThis as any).Buffer;
    if (B) return B.from(b64, 'base64').toString('utf-8');
    return null;
  } catch {
    return null;
  }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function formatParseErr(resp: Record<string, unknown>): string {
  const pe = (resp as Record<string, unknown>)['parse_error'];
  return typeof pe === 'string' && pe.length > 0 ? ` (upstream parse_error: ${pe})` : '';
}

function guessMimeFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = url.match(/^data:([^;,]+)/);
  if (m) return m[1];
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
  if (!ext) return undefined;
  if (ext === 'png') return 'image/png';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'svg') return 'image/svg+xml';
  return undefined;
}
