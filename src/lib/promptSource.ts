// promptSource — classify the protocol's top-level system /
// instructions text into known L1 (vendor harness) vs L2 (project /
// user) source families. Pure heuristics over substring signals; we
// don't synthesize anything the prompt doesn't itself reveal.

export type PromptSource =
  | 'codex'
  | 'claude-code'
  | 'opencode'
  | 'cursor'
  | 'unknown';

export type PromptLayer = 'L1' | 'L2' | 'mixed';

interface PromptSourceResult {
  source: PromptSource;
  layer: PromptLayer;
  signals: string[];
}

// L1 signal substrings (case-sensitive where the harness emits them
// as-is; case-insensitive matching for the prose ones).
const CODEX_TAGS = ['<personality>', '<values>', '<interaction_style>'];

/**
 * classifyPromptSource inspects a system prompt string and returns
 * its best-guess source family + layer + matched signal substrings.
 *
 * Layer logic:
 *   - 'L1' when only vendor-harness signals match (XML tags etc.).
 *   - 'L2' when only project / user markdown signals match (no XML).
 *   - 'mixed' when both are present — system + developer concatenated.
 *
 * Unknown text returns source='unknown'. signals[] always reflects
 * what actually matched so a debug surface can show why.
 */
export function classifyPromptSource(text: string): PromptSourceResult {
  const t = text ?? '';
  const signals: string[] = [];

  // ---- L1 signals -----------------------------------------------------
  let l1Source: PromptSource | null = null;

  for (const tag of CODEX_TAGS) {
    if (t.includes(tag)) {
      signals.push(tag);
      l1Source = 'codex';
    }
  }
  if (/You are Claude/i.test(t)) {
    signals.push('You are Claude');
    l1Source = l1Source ?? 'claude-code';
  }
  if (/Anthropic/.test(t)) {
    signals.push('Anthropic');
    l1Source = l1Source ?? 'claude-code';
  }
  if (/opencode/i.test(t)) {
    signals.push('opencode');
    l1Source = l1Source ?? 'opencode';
  }
  if (/cursor/i.test(t)) {
    signals.push('cursor');
    l1Source = l1Source ?? 'cursor';
  }

  // ---- L2 signal: markdown without XML tags ---------------------------
  // Heuristic: lines starting with '#' (heading) or '- ' (list) and
  // no XML-style tag-at-line-start that L1 would emit.
  const hasMarkdown =
    /^#{1,6}\s/m.test(t) || /^[-*]\s/m.test(t) || /\n#{1,6}\s/.test(t);
  const hasXmlTag = /^<[a-zA-Z][\w-]*>/m.test(t);
  const isL2 = hasMarkdown && !hasXmlTag;
  if (isL2) signals.push('markdown-no-xml');

  // ---- Compose result -------------------------------------------------
  if (l1Source && isL2) {
    return { source: l1Source, layer: 'mixed', signals };
  }
  if (l1Source) {
    return { source: l1Source, layer: 'L1', signals };
  }
  if (isL2) {
    // Markdown-only with no vendor harness signature — we know it's
    // L2-shaped but can't attribute the source.
    return { source: 'unknown', layer: 'L2', signals };
  }
  return { source: 'unknown', layer: 'L1', signals };
}
