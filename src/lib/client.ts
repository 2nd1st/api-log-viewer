// Client (UA) identification — extracted verbatim from OverviewTab so
// other surfaces (filters, dashboards, transcript headers) can match
// against the same family taxonomy without re-inventing the regex.
// Pure functions; no DOM, no Svelte.

/**
 * classifyClient inspects a raw User-Agent string and returns the
 * known family + optional version. Falls back to the first
 * whitespace-or-slash-separated chunk of the UA when no family
 * matches, and finally to 'unknown' for empty input.
 *
 * Per memory feedback_ultracode_target: keep it honest; show what we
 * have. The raw UA is always echoed back so the renderer can surface
 * it when the family is a guess.
 */
export function classifyClient(
  ua: string,
): { family: string; version?: string; raw: string } {
  const u = (ua ?? '').trim();
  if (!u) return { family: 'unknown', raw: '' };
  // Codex CLI family
  if (/codex/i.test(u)) {
    const m = u.match(/codex[^0-9]*([\d.]+)/i);
    return { family: 'codex', version: m?.[1], raw: u };
  }
  if (/claude-cli|claude-code/i.test(u)) {
    const m = u.match(/(?:claude-cli|claude-code)\/([\d.]+)/i);
    return { family: 'claude-code', version: m?.[1], raw: u };
  }
  if (/opencode/i.test(u)) {
    const m = u.match(/opencode\/([\d.]+)/i);
    return { family: 'opencode', version: m?.[1], raw: u };
  }
  if (/^OpenAI\//.test(u) || /openai-python|openai-node/i.test(u)) {
    const m = u.match(/(?:openai[^0-9]*)([\d.]+)/i);
    return { family: 'openai-sdk', version: m?.[1], raw: u };
  }
  if (/anthropic-sdk|anthropic-python|anthropic-typescript/i.test(u)) {
    const m = u.match(/(?:anthropic[^0-9]*)([\d.]+)/i);
    return { family: 'anthropic-sdk', version: m?.[1], raw: u };
  }
  if (/cursor/i.test(u)) return { family: 'cursor', raw: u };
  if (/continue/i.test(u)) return { family: 'continue', raw: u };
  if (/^curl\//.test(u)) {
    const m = u.match(/curl\/([\d.]+)/i);
    return { family: 'curl', version: m?.[1], raw: u };
  }
  if (/^Mozilla\//.test(u)) return { family: 'browser', raw: u };
  // First non-space chunk before /
  const first = u.split(/[\s/]/, 1)[0];
  return { family: first || 'unknown', raw: u };
}
