// xmlPrompt — parse codex-style flat XML-tagged system prompts into
// ordered <tag, body> sections so renderer C can lay them out as
// labeled blocks. Lenient: self-closing and unclosed tags are
// ignored. Pure functions; no DOM, no Svelte.

interface XmlSection {
  tag: string;
  body: string;
}

// Top-level opening tag at the start of a line: <name> with no '/'
// before the '>'. Captures the tag name. Case-insensitive matching
// is done by lowercasing when comparing closers.
const OPEN_TAG_RE = /^[ \t]*<([a-zA-Z][\w-]*)>[ \t]*$/gm;

// Known agent-harness injection tags. When one of these appears the
// renderer should always collapse the block by default, even when
// it's the only XML section in the prompt — the harness scaffolding
// is noise that hides the actual user intent below it.
const HARNESS_TAGS: ReadonlySet<string> = new Set([
  'skills_instructions',
  'available_skills',
  'available_tools',
  'system-reminder',
  'environment_details',
  'environment_context',
  'tool_definitions',
]);

export function isHarnessTag(tag: string): boolean {
  return HARNESS_TAGS.has(tag.toLowerCase());
}

/**
 * extractHarnessMeta returns a short count badge for a harness
 * section (e.g. "30 skills" for an available_skills block, "12
 * tools" for available_tools). Returns null when the tag has no
 * known counter heuristic — the caller falls back to the generic
 * line-count label.
 */
export function extractHarnessMeta(tag: string, body: string): string | null {
  const t = tag.toLowerCase();
  const b = body ?? '';
  if (t === 'available_skills' || t === 'skills_instructions') {
    const matches = b.match(/<skill\b/gi);
    const n = matches ? matches.length : 0;
    if (n > 0) return n === 1 ? '1 skill' : `${n} skills`;
  }
  if (t === 'available_tools' || t === 'tool_definitions') {
    const matches = b.match(/<tool\b/gi);
    const n = matches ? matches.length : 0;
    if (n > 0) return n === 1 ? '1 tool' : `${n} tools`;
  }
  return null;
}

/**
 * hasXmlSections returns true when text contains ≥2 top-level
 * line-anchored opening tags, OR ≥1 known harness tag (which is
 * always worth collapsing on its own). Used by callers to decide
 * whether to route through the XML renderer at all.
 */
export function hasXmlSections(text: string): boolean {
  const t = text ?? '';
  if (!t) return false;
  let count = 0;
  // Reset lastIndex because OPEN_TAG_RE is a /g regex shared across calls.
  OPEN_TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OPEN_TAG_RE.exec(t)) !== null) {
    count++;
    if (isHarnessTag(m[1])) return true;
    if (count >= 2) return true;
  }
  return false;
}

/**
 * parseXmlSections splits the input into a flat list of sections.
 * Each section's `tag` is the lowercased tag name (no angle brackets)
 * and `body` is the inner text between matching <tag> and </tag>,
 * untouched (leading/trailing whitespace preserved).
 *
 * Lenient parsing rules:
 *   - Only opening tags at the start of a line count as section starts.
 *   - Matching closer </tag> must also be line-anchored.
 *   - Unclosed openers are skipped (no section emitted).
 *   - Self-closing tags (<foo/>) are ignored — codex prompts don't use them.
 *   - Flat only: nested tags inside a section stay in the body verbatim.
 *
 * Returns [] when no sections are detected.
 */
export function parseXmlSections(text: string): XmlSection[] {
  const t = text ?? '';
  if (!t) return [];

  const sections: XmlSection[] = [];
  // Collect all opening tag matches first so we have positions to
  // scan from.
  OPEN_TAG_RE.lastIndex = 0;
  const opens: Array<{ tag: string; start: number; bodyStart: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = OPEN_TAG_RE.exec(t)) !== null) {
    opens.push({
      tag: m[1].toLowerCase(),
      start: m.index,
      bodyStart: m.index + m[0].length,
    });
  }
  if (opens.length === 0) return [];

  for (const op of opens) {
    // Search for the matching line-anchored closer after bodyStart.
    // We escape the tag name (alphanumeric/_/-only by the opener regex
    // so escaping is a no-op, but stay safe).
    const safeTag = op.tag.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&');
    const closerRe = new RegExp(
      `^[ \\t]*<\\/${safeTag}>[ \\t]*$`,
      'im',
    );
    const tail = t.slice(op.bodyStart);
    const closerMatch = closerRe.exec(tail);
    if (!closerMatch) continue; // unclosed — skip
    const bodyEnd = op.bodyStart + closerMatch.index;
    // Trim the single trailing newline that sits between body and
    // the closer's line, but keep the inner content otherwise as-is.
    let body = t.slice(op.bodyStart, bodyEnd);
    if (body.startsWith('\n')) body = body.slice(1);
    if (body.endsWith('\n')) body = body.slice(0, -1);
    sections.push({ tag: op.tag, body });
  }

  return sections;
}
