/**
 * Adapter for the OpenAI Image Generation protocol (POST /v1/images/generations).
 *
 * Wire shape (verified against sub2api captures):
 *   req.body = { model, prompt, size, n?, quality?, ... }
 *   resp.body = {
 *     created,
 *     data: [
 *       { b64_json: "<base64 PNG/JPEG>", revised_prompt?: "..." },
 *       ...
 *     ],
 *     output_format?, quality?, size?, usage?
 *   }
 *
 * Non-streaming, single-shot. Emission order:
 *   1. User TextBlock — the prompt
 *   2. Per generated image:
 *        2a. Optional TextBlock — `revised_prompt` (model's reinterpretation)
 *        2b. MediaBlock — the b64_json image
 *
 * The MediaBlock carries the raw base64 in `data_b64`; the renderer
 * decides whether to render inline as a `data:` URL or fetch from the
 * backend's /api/media/<trace_id>/<idx> endpoint once Phase K media
 * extraction lands for this path.
 *
 * Invariants (shared across adapters):
 *   - Never throw — emit ErrorBlock and keep going.
 *   - Every Block has a `source` BlockSource pointing back to the raw blob.
 */

import type {
  Block,
  ErrorBlock,
  MediaBlock,
  TextBlock,
  UnknownBlock,
} from '../blocks';
import type { TraceBlob } from '../trace';

export function adapt(path: string, traceBlob: TraceBlob): Block[] {
  void path;
  const out: Block[] = [];
  let seq = 0;
  const nextSeq = () => seq++;

  try {
    // ---- Request ----
    const reqBody = traceBlob?.req?.body;
    if (reqBody && typeof reqBody === 'object') {
      const body = reqBody as Record<string, unknown>;
      const prompt = typeof body.prompt === 'string' ? body.prompt : null;
      const model = typeof body.model === 'string' ? body.model : '';
      const size = typeof body.size === 'string' ? body.size : '';
      const n = typeof body.n === 'number' ? body.n : null;

      if (prompt) {
        // Render the prompt as a user TextBlock; surface model + size + n
        // as a short prefix so the operator sees the generation parameters
        // without having to expand the Raw tab.
        const meta: string[] = [];
        if (model) meta.push(`model: ${model}`);
        if (size) meta.push(`size: ${size}`);
        if (n != null) meta.push(`n: ${n}`);
        const header = meta.length ? `[${meta.join(' · ')}]\n` : '';
        const txt: TextBlock = {
          type: 'text',
          role: 'user',
          source: { side: 'req', container: 'body', path: 'req.body.prompt' },
          sequence_number: nextSeq(),
          text: header + prompt,
        };
        out.push(txt);
      }
    }

    // ---- Response ----
    const respBody = traceBlob?.resp?.body;
    if (respBody && typeof respBody === 'object') {
      const body = respBody as Record<string, unknown>;
      const data = Array.isArray(body.data) ? (body.data as unknown[]) : [];
      data.forEach((item, idx) => {
        if (!item || typeof item !== 'object') return;
        const entry = item as Record<string, unknown>;
        const revised = typeof entry.revised_prompt === 'string' ? entry.revised_prompt : null;
        const b64 = typeof entry.b64_json === 'string' ? entry.b64_json : null;
        const url = typeof entry.url === 'string' ? entry.url : null;

        if (revised) {
          // The model often rewrites the prompt before generation; render
          // the rewrite as an assistant message so the operator can see
          // how the prompt was interpreted.
          const rev: TextBlock = {
            type: 'text',
            role: 'assistant',
            source: {
              side: 'resp',
              container: 'body',
              path: `resp.body.data[${idx}].revised_prompt`,
              index: idx,
            },
            sequence_number: nextSeq(),
            text: `[revised prompt]\n${revised}`,
          };
          out.push(rev);
        }

        if (b64) {
          const media: MediaBlock = {
            type: 'media',
            role: 'assistant',
            source: {
              side: 'resp',
              container: 'body',
              path: `resp.body.data[${idx}].b64_json`,
              index: idx,
            },
            sequence_number: nextSeq(),
            media_type: 'image',
            mime_type: 'image/png',
            data_b64: b64,
          };
          out.push(media);
        } else if (url) {
          // Some image-gen flavors return a URL instead of inline b64.
          const media: MediaBlock = {
            type: 'media',
            role: 'assistant',
            source: {
              side: 'resp',
              container: 'body',
              path: `resp.body.data[${idx}].url`,
              index: idx,
            },
            sequence_number: nextSeq(),
            media_type: 'image',
            mime_type: 'image/png',
            url,
          };
          out.push(media);
        } else {
          // The item carries neither b64_json nor url — surface it so the
          // operator can see what the upstream actually returned.
          const unk: UnknownBlock = {
            type: 'unknown',
            role: 'system',
            source: {
              side: 'resp',
              container: 'body',
              path: `resp.body.data[${idx}]`,
              index: idx,
            },
            sequence_number: nextSeq(),
            raw_data: entry,
            block_source: 'images.data[*] entry has no b64_json or url',
          };
          out.push(unk);
        }
      });

      // Empty data[]: surface a non-fatal note so the operator sees that
      // the request succeeded structurally but produced no images.
      if (data.length === 0) {
        const err: ErrorBlock = {
          type: 'error',
          role: 'system',
          source: { side: 'resp', container: 'body', path: 'resp.body.data' },
          sequence_number: nextSeq(),
          error_type: 'empty_data',
          error_message: 'images response has no data[] entries',
        };
        out.push(err);
      }
    }
  } catch (e) {
    out.push({
      type: 'error',
      role: 'system',
      source: { side: 'resp', container: 'body' },
      sequence_number: seq++,
      error_type: 'adapter_crash',
      error_message: `images adapter threw: ${(e as Error)?.message ?? String(e)}`,
    } satisfies ErrorBlock);
  }

  return out;
}
