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

export type PromptLayer = 'L1' | 'L2' | 'mixed' | 'unknown';

interface PromptSourceResult {
  source: PromptSource;
  layer: PromptLayer;
  signals: string[];
}

// Codex L1 XML-tag signals. Matched case-insensitively because the
// harness has shipped variants over time; presence of any of these is
// a strong indicator the text contains the codex vendor harness.
const CODEX_TAGS = [
  '<personality>',
  '<values>',
  '<interaction_style>',
  '<escalation>',
  '<engineering_judgment>',
  '<output_format>',
  '<reasoning>',
  '<general>',
];

/**
 * classifyPromptSource inspects a system prompt string and returns
 * its best-guess source family + layer + matched signal substrings.
 *
 * Layer logic:
 *   - 'L1' when only vendor-harness signals match (XML tags etc.).
 *   - 'L2' when only project / user markdown signals match (no XML).
 *   - 'mixed' when both XML tags and markdown headers are present —
 *     a sign of L1 + L2 concatenated into the same prompt slot.
 *
 * signals[] always reflects what actually matched so a debug surface
 * can show why. For codex XML tags the bare tag name (no angle
 * brackets) is pushed.
 */
export function classifyPromptSource(text: string): PromptSourceResult {
  const t = text ?? '';
  const lower = t.toLowerCase();
  const signals: string[] = [];

  // ---- L1 signals -----------------------------------------------------
  let l1Source: PromptSource | null = null;
  let codexXmlHit = false;

  for (const tag of CODEX_TAGS) {
    if (lower.includes(tag)) {
      // Push just the tag name without angle brackets, per spec.
      signals.push(tag.slice(1, -1));
      l1Source = 'codex';
      codexXmlHit = true;
    }
  }
  // Codex XML tags are a strong, unambiguous signal: short-circuit
  // attribution to codex before any other harness checks can claim it.
  if (codexXmlHit) {
    l1Source = 'codex';
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

  // ---- L2 signal: markdown headers ------------------------------------
  // A '#' heading anywhere in the text is the cheap L2/AGENTS.md tell.
  const hasMarkdownHeader = /^#{1,6}\s/m.test(t) || /\n#{1,6}\s/.test(t);
  if (hasMarkdownHeader) signals.push('markdown-header');

  // ---- Compose result -------------------------------------------------
  // Per spec, layer is driven by codex XML presence + markdown headers:
  //   XML  + md → mixed (L1 + L2 concatenated)
  //   XML  only → L1
  //   md   only → L2 (user-supplied AGENTS.md style)
  //   neither   → unknown
  if (codexXmlHit && hasMarkdownHeader) {
    return { source: l1Source ?? 'codex', layer: 'mixed', signals };
  }
  if (codexXmlHit) {
    return { source: l1Source ?? 'codex', layer: 'L1', signals };
  }
  if (l1Source && hasMarkdownHeader) {
    return { source: l1Source, layer: 'mixed', signals };
  }
  if (l1Source) {
    return { source: l1Source, layer: 'L1', signals };
  }
  if (hasMarkdownHeader) {
    return { source: 'unknown', layer: 'L2', signals };
  }
  return { source: 'unknown', layer: 'unknown', signals };
}
