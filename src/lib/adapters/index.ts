/**
 * Adapter dispatch entry point.
 *
 * Routes a raw TraceBlob to the right per-protocol adapter based on the
 * trace's request path. Falls back to a generic unknown-emitter for paths
 * the viewer hasn't taught itself yet, so the timeline at least shows
 * SOMETHING instead of silently rendering empty.
 *
 * Path detection rules (substring match; the backend records the request path as received):
 *   - /v1/chat/completions      -> chat.ts          (OpenAI Chat)
 *   - /v1/messages              -> messages.ts      (Anthropic Messages)
 *   - /v1/responses             -> responses.ts     (OpenAI Responses)
 *   - :generateContent or
 *     :streamGenerateContent or
 *     /v1beta/                  -> gemini.ts        (Google Gemini)
 *   - everything else           -> emitUnknown()    (one block per side, raw blob)
 *
 * Adapters all share the same signature: `adapt(path, traceBlob) => Block[]`.
 * None of them throw — the worst-case path is an ErrorBlock + UnknownBlock.
 */

import type { Block, UnknownBlock } from '../blocks';
import type { TraceBlob } from '../trace';

import { adapt as adaptChat } from './chat';
import { adapt as adaptMessages } from './messages';
import { adapt as adaptResponses } from './responses';
import { adapt as adaptImages } from './images';
import { adapt as adaptGemini } from './gemini';

/**
 * Detect which adapter to use based on the request path.
 * Exported so the Dashboard / TracesList "protocol" KPI can reuse it.
 */
export type Protocol =
  | 'openai_chat'
  | 'anthropic_messages'
  | 'openai_responses'
  | 'openai_images'
  | 'google_gemini'
  | 'unknown';

export function detectProtocol(path: string | null | undefined): Protocol {
  const p = path ?? '';
  if (p.indexOf('/v1/chat/completions') !== -1) return 'openai_chat';
  if (p.indexOf('/v1/messages') !== -1) return 'anthropic_messages';
  if (p.indexOf('/v1/responses') !== -1) return 'openai_responses';
  if (p.indexOf('/v1/images/') !== -1) return 'openai_images';
  if (
    p.indexOf(':generateContent') !== -1 ||
    p.indexOf(':streamGenerateContent') !== -1 ||
    p.indexOf('/v1beta/') !== -1
  ) {
    return 'google_gemini';
  }
  return 'unknown';
}

/**
 * Dispatch: route a (path, traceBlob) pair to the right adapter.
 * Falls back to a generic unknown-emitter when no adapter matches.
 */
export function adapt(path: string | null | undefined, traceBlob: TraceBlob | null | undefined): Block[] {
  const p = path ?? '';
  const tb = (traceBlob ?? {}) as TraceBlob;
  switch (detectProtocol(p)) {
    case 'openai_chat':
      return adaptChat(p, tb);
    case 'anthropic_messages':
      return adaptMessages(p, tb);
    case 'openai_responses':
      return adaptResponses(p, tb);
    case 'openai_images':
      return adaptImages(p, tb);
    case 'google_gemini':
      return adaptGemini(p, tb);
    default:
      return emitUnknown(p, tb);
  }
}

/**
 * Generic fallback. Emits one UnknownBlock per non-empty side so the
 * Conversation tab renders SOMETHING rather than collapsing to "no blocks".
 */
function emitUnknown(path: string, trace: TraceBlob): Block[] {
  const out: Block[] = [];
  let seq = 0;
  if (trace?.req?.body !== undefined && trace.req.body !== null) {
    const u: UnknownBlock = {
      type: 'unknown',
      role: 'system',
      source: { side: 'req', container: 'body', path: 'trace.req.body' },
      sequence_number: seq++,
      raw_data: trace.req.body,
      block_source: `unknown protocol for path=${path || '(empty)'} — req.body shown verbatim`,
    };
    out.push(u);
  }
  if (trace?.resp?.body !== undefined && trace.resp.body !== null) {
    const u: UnknownBlock = {
      type: 'unknown',
      role: 'system',
      source: { side: 'resp', container: 'body', path: 'trace.resp.body' },
      sequence_number: seq++,
      raw_data: trace.resp.body,
      block_source: `unknown protocol for path=${path || '(empty)'} — resp.body shown verbatim`,
    };
    out.push(u);
  } else if (trace?.resp?.events && trace.resp.events.length > 0) {
    const u: UnknownBlock = {
      type: 'unknown',
      role: 'system',
      source: { side: 'resp', container: 'events', path: 'trace.resp.events' },
      sequence_number: seq++,
      raw_data: trace.resp.events,
      block_source: `unknown protocol for path=${path || '(empty)'} — resp.events shown verbatim`,
    };
    out.push(u);
  }
  return out;
}
