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

// =====================================================================
// L2 helpers — project context + declared skills
// =====================================================================
//
// classifyPromptSource above answers the layer-question; the two
// extractors below pull *identifiers* out of the L2 portion of a
// prompt: the project this trace belongs to and the named skills /
// subagents the harness advertised. Both are pure heuristics with no
// XML/markdown parsing dependency — regex + a tiny HTML-entity
// fallback. Patterns are documented against reference fixtures.

export interface ProjectContext {
  /** Display name, with surrounding backticks stripped. */
  name: string;
  /**
   * Where the name came from:
   *   - "agents-md"     — `AGENTS.md` injection reference adjacent to a heading
   *   - "claude-md"     — `CLAUDE.md` injection reference adjacent to a heading
   *   - "first-heading" — text simply starts with `# …` (no file ref)
   */
  source: 'agents-md' | 'claude-md' | 'first-heading';
}

// Strip backticks AND trim — codex / claude code occasionally inline
// the project name as `# Project: \`my-project\`` or `# \`my-proj\``.
// We only strip the wrappers; backticks inside the middle of the name
// are preserved literally (extremely rare in practice).
function cleanHeadingText(raw: string): string {
  let s = raw.trim();
  // Drop trailing CR (cleanup before we slice further).
  s = s.replace(/[\r]+$/, '');
  // If the entire text is wrapped in backticks, peel one layer.
  if (s.startsWith('`') && s.endsWith('`') && s.length >= 2) {
    s = s.slice(1, -1).trim();
  }
  // Strip backticks anywhere — names like `# \`my-project\`` should
  // display as `my-project`, not with the inline-code wrapper.
  s = s.replace(/`/g, '').trim();
  return s;
}

// Match an injection-style file reference for AGENTS.md / CLAUDE.md.
// The real shape Claude Code uses in user-turn system reminders is:
//   "Contents of /Users/example/.claude/CLAUDE.md (project instructions…):"
// Codex variants drop "Contents of" and write a bare absolute path.
// We require either the "Contents of" preamble OR a path separator
// immediately before the filename — both rule out the prose-mention
// false positive (e.g. "durable instructions like CLAUDE.md files").
//
// Group 1 captures the trailing filename literal, so we can branch
// agents-md vs claude-md off the same match.
const FILE_REF_RE =
  /(?:Contents of\s+\S*?|[/\\][^\s]*?)\b(AGENTS\.md|CLAUDE\.md|agents\.md|claude\.md)\b/;

// First markdown heading after a given offset. We seek to the next
// "\n#" (or start-of-string "#") and capture the heading body. Stop at
// the line break.
const HEADING_AT_LINE_START_RE = /(?:^|\n)#{1,6}\s+([^\n]+)/;

/**
 * Extract a {name, source} for the project this prompt is talking
 * about. Strategy:
 *
 *   1. If text contains an AGENTS.md / CLAUDE.md injection-style file
 *      reference (path-prefixed OR "Contents of …" preamble — *not*
 *      a bare prose mention), take the FIRST `# …` heading whose
 *      offset is *after* the reference and within a short window.
 *      That heading is the project name.
 *   2. Else if the text *starts* with a `# …` heading (after
 *      skipping any leading XML close tag or whitespace), return that
 *      heading text as the project name with source: "first-heading".
 *   3. Else null.
 *
 * Edge cases handled:
 *   - Inline backticks around the name are stripped
 *   - Empty / whitespace-only text → null
 *   - "L1 XML + L2 markdown" mixed prompts: we step past the closing
 *     `</tag>` line of any leading XML section before looking for the
 *     first heading (source: "first-heading" path).
 *   - The vendor harness "# System" / "# Tone and style" headings are
 *     deliberately NOT matched — they only appear inside L1, never
 *     adjacent to an AGENTS.md / CLAUDE.md file reference, so source
 *     "agents-md"/"claude-md" stays accurate. The "first-heading"
 *     path can still pick a vendor heading on raw L1 text; that's the
 *     documented best-effort behavior — operators reading the source
 *     pill ("first heading") know it's the weakest signal.
 */
export function extractProjectContext(systemPrompt: string): ProjectContext | null {
  const text = (systemPrompt ?? '').trim();
  if (!text) return null;

  // ----- strategy 1: file reference + adjacent heading -----
  const ref = FILE_REF_RE.exec(text);
  if (ref) {
    const refEnd = ref.index + ref[0].length;
    const fileName = ref[1].toLowerCase();
    // Look for a markdown heading within a tight window after the
    // reference — the injection format puts the heading on the next
    // non-empty line, so 400 chars is generous but caps blast radius
    // when the operator wrote prose between the ref and the next
    // heading.
    const window = text.slice(refEnd, refEnd + 400);
    const headingMatch = HEADING_AT_LINE_START_RE.exec(window);
    if (headingMatch) {
      const name = cleanHeadingText(headingMatch[1]);
      if (name) {
        return {
          name,
          source: fileName.startsWith('agents') ? 'agents-md' : 'claude-md',
        };
      }
    }
    // Fall through if the file ref had no following heading.
  }

  // ----- strategy 2: text starts with a heading (skip leading XML) -----
  // Step past any leading "</tag>" close so a mixed L1+L2 prompt that
  // ends its XML scaffold immediately before a markdown heading still
  // identifies the project.
  let searchFrom = 0;
  const leadingXmlClose = /^\s*<\/[a-zA-Z][\w-]*>\s*/.exec(text);
  if (leadingXmlClose) {
    searchFrom = leadingXmlClose[0].length;
  }
  // Require the heading at the start (after optional whitespace) of
  // the remainder — i.e. the FIRST non-empty line must be a heading.
  const startHeading = /^\s*#{1,6}\s+([^\n]+)/.exec(text.slice(searchFrom));
  if (startHeading) {
    const name = cleanHeadingText(startHeading[1]);
    if (name) return { name, source: 'first-heading' };
  }

  return null;
}

/**
 * Decode the three HTML entities we realistically encounter inside a
 * `<name>` tag value: lt / gt / amp. amp is decoded LAST so a
 * pre-encoded "&amp;lt;" round-trips correctly to "&lt;" not "<".
 * Numeric / hex entities are out of scope — codex / claude code skill
 * names don't use them.
 */
function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Skill / subagent / agent / personality declarations the harness
// advertises in the system prompt. Real codex example:
//   <skill>
//     <name>ai-search</name>
//     <description>…</description>
//   </skill>
//
// Two shapes are recognized:
//   A. `<tag ... > … <name>X</name> … </tag>` — name inside body
//   B. `<tag name="X" …>` or `<tag name='X' …>` — name as attribute
//
// We run both as a single combined regex with named alternates and
// keep declaration order by sorting by match index before dedup.
// `(?=[\s>])` (not `\b`) terminates the tag name — `\b` would let
// `<skill-name>` (a known false positive in Claude Code prompts that
// mention the `Skill` tool) match the `<skill` alternation.
const NAME_BODY_RE =
  /<(subagent|skill|agent|personality)(?=[\s>])[^>]*>[\s\S]*?<name>\s*([^<]+?)\s*<\/name>/gi;
const NAME_ATTR_RE =
  /<(subagent|skill|agent|personality)(?=[\s>])[^>]*\bname\s*=\s*(["'])([^"']+)\2/gi;

/**
 * Pull out the set of distinct skill / subagent names declared
 * anywhere in the system prompt. Returned in declaration order
 * (first appearance wins for dedup).
 *
 * Empty array when nothing matches — safe to gate UI rows on
 * `result.length > 0`.
 */
export function extractSkills(systemPrompt: string): string[] {
  const text = systemPrompt ?? '';
  if (!text) return [];

  type Hit = { idx: number; name: string };
  const hits: Hit[] = [];

  // Both regexes are /g; reset lastIndex defensively because they're
  // module-scope and could be mid-iteration from a prior call.
  NAME_BODY_RE.lastIndex = 0;
  for (let m = NAME_BODY_RE.exec(text); m !== null; m = NAME_BODY_RE.exec(text)) {
    const raw = decodeHtmlEntities(m[2]).trim();
    if (raw) hits.push({ idx: m.index, name: raw });
  }
  NAME_ATTR_RE.lastIndex = 0;
  for (let m = NAME_ATTR_RE.exec(text); m !== null; m = NAME_ATTR_RE.exec(text)) {
    const raw = decodeHtmlEntities(m[3]).trim();
    if (raw) hits.push({ idx: m.index, name: raw });
  }

  // Sort by first appearance so a mixed `<subagent>` then `<skill>`
  // prompt reports them in document order, not type-grouped.
  hits.sort((a, b) => a.idx - b.idx);

  // Dedup preserving first occurrence.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of hits) {
    if (seen.has(h.name)) continue;
    seen.add(h.name);
    out.push(h.name);
  }
  return out;
}
