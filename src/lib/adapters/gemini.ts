/**
 * Adapter for Google Gemini protocol (/v1beta/models/*:generateContent etc.).
 *
 * ============================================================================
 *  TODO: UNTESTED — no real sub2api samples exist for Gemini at write-time.
 *  This adapter is designed from the public Gemini /v1beta docs
 *  (REST `generateContent` + `streamGenerateContent` shapes) and the
 *  GenerativeAI SDK types. Every code path SHOULD be revisited the first
 *  time a real Gemini trace lands in sub2api so we can verify part shapes,
 *  SSE event names, and tool-call ID conventions.
 * ============================================================================
 *
 * Gemini request shape (cheat sheet):
 *   {
 *     systemInstruction?: { role?: 'system', parts: Part[] } | { parts: Part[] } | string,
 *     contents: [
 *       { role: 'user' | 'model' | 'function', parts: Part[] },
 *       ...
 *     ],
 *     tools?, toolConfig?, safetySettings?, generationConfig?
 *   }
 *
 * Gemini response shape (non-streaming):
 *   {
 *     candidates: [
 *       {
 *         content: { role: 'model', parts: Part[] },
 *         finishReason?, safetyRatings?, citationMetadata?, groundingMetadata?
 *       },
 *       ...
 *     ],
 *     usageMetadata?, promptFeedback?
 *   }
 *
 * Streaming (`streamGenerateContent` / SSE): each event payload is a
 * partial GenerateContentResponse — i.e., the SAME top-level shape as
 * above but with incremental `candidates[].content.parts` deltas. We
 * accumulate text parts per (candidateIndex, partIndex) into a single
 * TextBlock; non-text parts (functionCall, executableCode, etc.) are
 * emitted as separate blocks the moment they appear (they're either
 * present in full or not at all — Gemini doesn't stream tool-call
 * arguments token-by-token like OpenAI Responses).
 *
 * Part variants we handle:
 *   - text: string
 *   - inlineData: { mimeType, data }                       -> MediaBlock
 *   - fileData:   { mimeType, fileUri }                    -> MediaBlock (url)
 *   - functionCall: { name, args }                         -> ToolCallBlock
 *   - functionResponse: { name, response }                 -> ToolResultBlock
 *   - executableCode: { language, code }                   -> ToolCallBlock (code_exec)
 *   - codeExecutionResult: { outcome, output }             -> ToolResultBlock
 *   - thought: boolean | string  (extended thinking)       -> ReasoningBlock
 *     (Gemini 2.0/2.5 "thinking" mode: parts may carry a `thought: true`
 *      flag on a text part, OR a dedicated `{ thought: '...text...' }`
 *      shape depending on SDK version — we handle both.)
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
import type { TraceBlob } from '../trace';

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

  // systemInstruction may be:
  //   - string (rare/legacy)
  //   - { parts: Part[] }
  //   - { role: 'system', parts: Part[] }
  const sys = (reqBody as any).systemInstruction ?? (reqBody as any).system_instruction;
  if (sys) {
    try {
      if (typeof sys === 'string') {
        out.push({
          type: 'text',
          role: 'system',
          text: sys,
          source: { side: 'req', container: 'body', path: 'req.body.systemInstruction' },
        });
      } else if (Array.isArray(sys?.parts)) {
        for (let i = 0; i < sys.parts.length; i++) {
          out.push(
            ...partsToBlocks(sys.parts[i], 'system', {
              side: 'req',
              container: 'body',
              path: `req.body.systemInstruction.parts[${i}]`,
              index: i,
            })
          );
        }
      } else {
        out.push(
          makeUnknown('req', 'unrecognized systemInstruction shape', sys, 'req.body.systemInstruction')
        );
      }
    } catch (e: any) {
      out.push(makeError('req', 'parse_error', e?.message ?? String(e), {
        where: 'systemInstruction',
      }));
    }
  }

  const contents = (reqBody as any).contents;
  if (Array.isArray(contents)) {
    for (let i = 0; i < contents.length; i++) {
      const turn = contents[i];
      const role = mapGeminiRole(turn?.role);
      const parts = Array.isArray(turn?.parts) ? turn.parts : [];
      for (let j = 0; j < parts.length; j++) {
        try {
          out.push(
            ...partsToBlocks(parts[j], role, {
              side: 'req',
              container: 'body',
              path: `req.body.contents[${i}].parts[${j}]`,
              index: j,
            })
          );
        } catch (e: any) {
          out.push(makeError('req', 'parse_error', e?.message ?? String(e), {
            where: `contents[${i}].parts[${j}]`,
          }));
        }
      }
    }
  } else if (contents !== undefined) {
    out.push(makeUnknown('req', 'contents is not an array', contents, 'req.body.contents'));
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

  // Non-streaming path: single JSON body with candidates[].
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

  // Top-level promptFeedback.blockReason — surface as an error block so the
  // operator sees WHY the model declined.
  const block = body?.promptFeedback?.blockReason;
  if (block) {
    out.push({
      type: 'error',
      role: 'system',
      error_type: 'prompt_blocked',
      error_message: `Prompt blocked: ${block}`,
      source: { side: 'resp', container: 'body', path: 'resp.body.promptFeedback' },
    });
  }

  const candidates = body?.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    // Some Gemini errors come back as { error: {...} } at the top level.
    if (body?.error) {
      const err = body.error;
      out.push({
        type: 'error',
        role: 'system',
        error_type: 'api_error',
        error_message: typeof err === 'string' ? err : err?.message ?? JSON.stringify(err),
        error_code: err?.status,
        http_status: err?.code,
        source: { side: 'resp', container: 'body', path: 'resp.body.error' },
      });
    }
    return out;
  }

  // We typically only render candidate[0] (the chosen one). Additional
  // candidates are rare in production and would clutter the timeline.
  // TODO: revisit if any real trace uses candidateCount > 1.
  const cand = candidates[0];
  const parts = cand?.content?.parts;
  if (Array.isArray(parts)) {
    for (let i = 0; i < parts.length; i++) {
      try {
        out.push(
          ...partsToBlocks(parts[i], 'assistant', {
            side: 'resp',
            container: 'body',
            path: `resp.body.candidates[0].content.parts[${i}]`,
            index: i,
          })
        );
      } catch (e: any) {
        out.push(makeError('resp', 'parse_error', e?.message ?? String(e), {
          where: `candidates[0].content.parts[${i}]`,
        }));
      }
    }
  }

  // finishReason worth surfacing if it's anything but STOP / MAX_TOKENS
  const fr = cand?.finishReason;
  if (fr && fr !== 'STOP' && fr !== 'MAX_TOKENS' && fr !== 'FINISH_REASON_UNSPECIFIED') {
    out.push({
      type: 'error',
      role: 'system',
      error_type: 'finish_reason',
      error_message: `finishReason=${fr}`,
      source: { side: 'resp', container: 'body', path: 'resp.body.candidates[0].finishReason' },
    });
  }

  return out;
}

// ---------- streaming (SSE) ----------
//
// Gemini's streamGenerateContent emits successive GenerateContentResponse
// frames. We accumulate text parts by (candidateIndex, partIndex); other
// part kinds (functionCall, inlineData, etc.) we treat as one-shot — emit
// the first time we see them.

interface TextAccum {
  text: string;
  source: BlockSource;
  finalized: boolean;
}

function adaptResponseStream(
  events: Array<{ t_delta_ms?: number; event?: string; data?: any }>
): Block[] {
  const out: Block[] = [];

  // partKey = `${candidateIndex}:${partIndex}` -> running text
  const textAccum = new Map<string, TextAccum>();
  // emittedNonText prevents double-emitting one-shot parts that get echoed
  // in a final frame. Key = `${candidateIndex}:${partIndex}:${kind}`.
  const emittedNonText = new Set<string>();
  // Reasoning ("thought") accumulator — same shape as text.
  const thoughtAccum = new Map<string, TextAccum>();

  // First pass: walk every event, push non-text blocks immediately, build
  // up text/thought accumulators.
  for (let ei = 0; ei < events.length; ei++) {
    const ev = events[ei];
    const data = ev?.data;
    if (!data || typeof data !== 'object') continue;

    // Some proxies stream `{ candidates: [...] }`; others wrap in
    // `{ data: { candidates: [...] } }` or include `error`. Handle both.
    const frame = data?.candidates ? data : data?.data ?? data;
    if (frame?.error) {
      out.push({
        type: 'error',
        role: 'system',
        error_type: 'api_error',
        error_message:
          typeof frame.error === 'string'
            ? frame.error
            : frame.error?.message ?? JSON.stringify(frame.error),
        source: {
          side: 'resp',
          container: 'events',
          path: `resp.events[${ei}].data.error`,
          index: ei,
          event_type: ev?.event,
        },
      });
      continue;
    }

    const candidates = frame?.candidates;
    if (!Array.isArray(candidates)) continue;

    for (let ci = 0; ci < candidates.length; ci++) {
      const cand = candidates[ci];
      const parts = cand?.content?.parts;
      if (!Array.isArray(parts)) continue;
      for (let pi = 0; pi < parts.length; pi++) {
        const part = parts[pi];
        if (!part || typeof part !== 'object') continue;

        const key = `${ci}:${pi}`;
        const src: BlockSource = {
          side: 'resp',
          container: 'events',
          path: `resp.events[${ei}].data.candidates[${ci}].content.parts[${pi}]`,
          index: ei,
          event_type: ev?.event,
        };

        // Thought / reasoning part — accumulate
        if (isThoughtPart(part)) {
          const text = extractThoughtText(part);
          const cur = thoughtAccum.get(key);
          if (cur) cur.text += text;
          else thoughtAccum.set(key, { text, source: src, finalized: false });
          continue;
        }

        // Plain text part — accumulate
        if (typeof part.text === 'string') {
          const cur = textAccum.get(key);
          if (cur) cur.text += part.text;
          else textAccum.set(key, { text: part.text, source: src, finalized: false });
          continue;
        }

        // One-shot non-text parts: only emit once per (candidate, part).
        const kind = nonTextKind(part);
        const emitKey = `${key}:${kind}`;
        if (emittedNonText.has(emitKey)) continue;
        emittedNonText.add(emitKey);
        try {
          out.push(...partsToBlocks(part, 'assistant', src));
        } catch (e: any) {
          out.push(makeError('resp', 'parse_error', e?.message ?? String(e), {
            where: `events[${ei}] candidate[${ci}].part[${pi}]`,
          }));
        }
      }

      // finishReason on a streaming candidate — surface unusual ones
      const fr = cand?.finishReason;
      if (fr && fr !== 'STOP' && fr !== 'MAX_TOKENS' && fr !== 'FINISH_REASON_UNSPECIFIED') {
        out.push({
          type: 'error',
          role: 'system',
          error_type: 'finish_reason',
          error_message: `finishReason=${fr}`,
          source: {
            side: 'resp',
            container: 'events',
            path: `resp.events[${ei}].data.candidates[${ci}].finishReason`,
            index: ei,
            event_type: ev?.event,
          },
        });
      }
    }
  }

  // Emit accumulated reasoning then text blocks, in (candidate, part) order.
  // Reasoning conventionally precedes the text it produced, so we emit
  // it first per part-index slot.
  const allKeys = new Set<string>([...thoughtAccum.keys(), ...textAccum.keys()]);
  const orderedKeys = Array.from(allKeys).sort((a, b) => {
    const [ac, ap] = a.split(':').map(Number);
    const [bc, bp] = b.split(':').map(Number);
    return ac - bc || ap - bp;
  });
  for (const k of orderedKeys) {
    const tho = thoughtAccum.get(k);
    if (tho) {
      const block: ReasoningBlock = {
        type: 'reasoning',
        role: 'assistant',
        reasoning_text: tho.text,
        source: tho.source,
      };
      out.push(block);
    }
    const txt = textAccum.get(k);
    if (txt) {
      const block: TextBlock = {
        type: 'text',
        role: 'assistant',
        text: txt.text,
        source: txt.source,
      };
      out.push(block);
    }
  }

  return out;
}

function isThoughtPart(part: any): boolean {
  // Two shapes we've seen referenced in docs/SDK:
  //   { thought: true, text: '...' }   (flag on a text part)
  //   { thought: '...string...' }      (dedicated thought field)
  if (part?.thought === true && typeof part?.text === 'string') return true;
  if (typeof part?.thought === 'string') return true;
  return false;
}

function extractThoughtText(part: any): string {
  if (typeof part?.thought === 'string') return part.thought;
  if (typeof part?.text === 'string') return part.text;
  return '';
}

function nonTextKind(part: any): string {
  if (part?.inlineData || part?.inline_data) return 'inlineData';
  if (part?.fileData || part?.file_data) return 'fileData';
  if (part?.functionCall || part?.function_call) return 'functionCall';
  if (part?.functionResponse || part?.function_response) return 'functionResponse';
  if (part?.executableCode || part?.executable_code) return 'executableCode';
  if (part?.codeExecutionResult || part?.code_execution_result) return 'codeExecutionResult';
  return 'unknown';
}

// ---------- per-part dispatch ----------

function partsToBlocks(
  part: any,
  role: TextBlock['role'] | 'assistant' | 'tool',
  source: BlockSource
): Block[] {
  if (!part || typeof part !== 'object') {
    return [makeUnknown(source.side, 'part is not an object', part, source.path ?? '')];
  }

  // Order matters: check the most specific variants first.

  // -- thought / reasoning (Gemini 2.x thinking mode) --
  if (isThoughtPart(part)) {
    const block: ReasoningBlock = {
      type: 'reasoning',
      role: 'assistant',
      reasoning_text: extractThoughtText(part),
      source,
    };
    return [block];
  }

  // -- text --
  if (typeof part.text === 'string') {
    // Only emit if there's actual content; empty-string parts are noise.
    if (part.text.length === 0) return [];
    const textRole: TextBlock['role'] =
      role === 'tool'
        ? 'user' // tool messages on the request side are functionResponse, not text
        : (role as TextBlock['role']);
    const block: TextBlock = {
      type: 'text',
      role: textRole,
      text: part.text,
      source,
    };
    return [block];
  }

  // -- inlineData (base64 binary) --
  const inline = part.inlineData ?? part.inline_data;
  if (inline) {
    const mime = String(inline.mimeType ?? inline.mime_type ?? 'application/octet-stream');
    const block: MediaBlock = {
      type: 'media',
      role: role === 'tool' ? 'user' : (role === 'system' || role === 'developer' ? 'user' : role),
      media_type: mediaTypeFromMime(mime),
      mime_type: mime,
      data_b64: typeof inline.data === 'string' ? inline.data : undefined,
      source,
    };
    return [block];
  }

  // -- fileData (file_id / fileUri reference) --
  const fileData = part.fileData ?? part.file_data;
  if (fileData) {
    const mime = String(fileData.mimeType ?? fileData.mime_type ?? 'application/octet-stream');
    const block: MediaBlock = {
      type: 'media',
      role: role === 'tool' ? 'user' : (role === 'system' || role === 'developer' ? 'user' : role),
      media_type: mediaTypeFromMime(mime),
      mime_type: mime,
      url: fileData.fileUri ?? fileData.file_uri,
      source,
    };
    return [block];
  }

  // -- functionCall (model wants to call a tool) --
  const fc = part.functionCall ?? part.function_call;
  if (fc) {
    const name = String(fc.name ?? '');
    // Gemini doesn't return a stable per-call ID in the same way OpenAI
    // does. We synthesize one from the source path so ToolResultBlock can
    // pair via name-matching fallback OR by id if echoed back.
    const tool_id = String(fc.id ?? `${name}:${source.path ?? source.index ?? 'unk'}`);
    const block: ToolCallBlock = {
      type: 'tool_call',
      role: 'assistant',
      tool_id,
      tool_name: name,
      kind: 'function',
      input: fc.args ?? {},
      call_id: fc.id,
      source,
    };
    return [block];
  }

  // -- functionResponse (caller hands tool output back to the model) --
  const fr = part.functionResponse ?? part.function_response;
  if (fr) {
    const name = String(fr.name ?? '');
    const tool_id = String(fr.id ?? `${name}:pair`);
    // The response payload sits under fr.response — could be string,
    // object, or nested { output: ... }. Render both raw and structured.
    const resp = fr.response;
    const result_text =
      typeof resp === 'string'
        ? resp
        : (() => {
            try {
              return JSON.stringify(resp, null, 2);
            } catch {
              return String(resp);
            }
          })();
    const block: ToolResultBlock = {
      type: 'tool_result',
      role: 'tool',
      tool_id,
      tool_name: name,
      result_text,
      result_structured: typeof resp === 'object' && resp !== null ? resp : undefined,
      source,
    };
    return [block];
  }

  // -- executableCode (Gemini code-execution: model emits code to run) --
  const ec = part.executableCode ?? part.executable_code;
  if (ec) {
    const language = String(ec.language ?? 'python').toLowerCase();
    const code = String(ec.code ?? '');
    const tool_id = `code_exec:${source.path ?? source.index ?? 'unk'}`;
    const block: ToolCallBlock = {
      type: 'tool_call',
      role: 'assistant',
      tool_id,
      tool_name: 'code_execution',
      kind: 'code_exec',
      input: { language, code },
      raw_input: code,
      source,
    };
    return [block];
  }

  // -- codeExecutionResult (output of the code Gemini ran) --
  const cer = part.codeExecutionResult ?? part.code_execution_result;
  if (cer) {
    // We can't perfectly pair to its executableCode without ordering info,
    // but the consumer can pair by adjacency in the timeline. Use a stable
    // synthesized id so at least it has SOMETHING for findToolResults().
    const tool_id = `code_exec:${source.path ?? source.index ?? 'unk'}`;
    const outcome = cer.outcome ?? cer.status;
    const block: ToolResultBlock = {
      type: 'tool_result',
      role: 'tool',
      tool_id,
      tool_name: 'code_execution',
      result_text: String(cer.output ?? ''),
      is_error: typeof outcome === 'string' && outcome !== 'OUTCOME_OK' && outcome !== 'OK',
      result_structured: cer,
      source,
    };
    return [block];
  }

  // Unknown part shape — emit as Unknown so the UI can show the raw blob.
  return [makeUnknown(source.side, 'unrecognized Gemini part', part, source.path ?? '')];
}

// ---------- helpers ----------

function mapGeminiRole(role: any): TextBlock['role'] | 'assistant' | 'tool' {
  // Gemini canonical roles: 'user', 'model', 'function', 'system' (rare).
  // Map to our union:
  //   user     -> user
  //   model    -> assistant
  //   function -> tool
  //   system   -> system
  switch (role) {
    case 'model':
      return 'assistant';
    case 'function':
      return 'tool';
    case 'system':
      return 'system';
    case 'user':
      return 'user';
    default:
      // unspecified role in contents[] — default to user (most common)
      return 'user';
  }
}

function mediaTypeFromMime(mime: string): MediaBlock['media_type'] {
  const m = mime.toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (
    m === 'application/pdf' ||
    m.startsWith('text/') ||
    m.includes('document') ||
    m.includes('msword') ||
    m.includes('officedocument')
  ) {
    return 'document';
  }
  return 'other';
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
    error_message: extra ? `${message} (${JSON.stringify(extra)})` : message,
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
