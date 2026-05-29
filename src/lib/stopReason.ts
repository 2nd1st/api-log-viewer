// stopReason — translate protocol-specific stop / finish_reason codes
// into one operator-language label per outcome, plus a severity tone
// the caller maps to --ok / --warn / --err (severity-only colors per
// viewer PHILOSOPHY; no role-coded fills).

export type StopTone = 'ok' | 'warn' | 'err' | '';

/**
 * translateStopReason normalizes the raw stop / finish_reason string
 * emitted by OpenAI- and Anthropic-shaped responses into a single
 * operator-facing phrase + a severity tone.
 *
 * Tone meaning:
 *   ''     — neutral / informational
 *   'ok'   — natural end
 *   'warn' — truncated, waiting on tool, content filtered
 *   'err'  — failure / incomplete
 *
 * Unknown raw values are echoed back verbatim with a neutral tone so
 * the viewer surfaces what the protocol actually said rather than
 * inventing a category.
 */
export function translateStopReason(
  raw: string | null | undefined,
): { label: string; tone: StopTone } {
  if (raw == null || raw === '') return { label: '—', tone: '' };
  const r = String(raw).toLowerCase();

  if (r === 'length') {
    return { label: 'truncated at max_tokens', tone: 'warn' };
  }
  if (r === 'stop' || r === 'end_turn' || r === 'completed') {
    return { label: 'natural end', tone: 'ok' };
  }
  if (r === 'tool_calls' || r === 'tool_use' || r === 'function_call') {
    return { label: 'waiting on tool result', tone: 'warn' };
  }
  if (r === 'content_filter') {
    return { label: 'content filter triggered', tone: 'warn' };
  }
  if (r === 'error' || r === 'failed' || r === 'incomplete') {
    return { label: 'failed', tone: 'err' };
  }
  // Unknown — surface raw verbatim with neutral tone.
  return { label: String(raw), tone: '' };
}
