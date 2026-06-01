// promptSource.test.ts — plain assertion table for extractProjectContext
// and extractSkills. No vitest in this project (see package.json:
// scripts.check uses svelte-check, no test runner configured), so the
// tests run only when this file is invoked directly via tsx / node
// --import tsx. Critically: NOTHING in the app imports this file, so
// Vite excludes it from the bundle and there is zero gz delta.
//
// To run manually:
//   npx tsx src/lib/promptSource.test.ts
//
// Each case carries a short comment naming the real shape it
// represents (reference fixture shape or vendor harness style).

import {
  extractProjectContext,
  extractSkills,
  type ProjectContext,
} from './promptSource';

interface Case<I, O> {
  name: string;
  input: I;
  expect: O;
}

function eq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

let passed = 0;
let failed = 0;
function check(name: string, got: unknown, want: unknown): void {
  if (eq(got, want)) {
    passed++;
    // Uncomment for verbose logs during local debugging:
    // console.log(`  ok  ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}`);
    console.error(`        got:  ${JSON.stringify(got)}`);
    console.error(`        want: ${JSON.stringify(want)}`);
  }
}

// ---------------------------------------------------------------------
// extractProjectContext
// ---------------------------------------------------------------------

const ctxCases: Case<string, ProjectContext | null>[] = [
  {
    // Shape: Claude Code user-turn system reminder — the injection
    // format the harness uses to drop CLAUDE.md content into the
    // prompt.
    name: 'CLAUDE.md path-prefixed ref + heading on next line',
    input:
      'Contents of /Users/example/.claude/CLAUDE.md (project instructions, checked into the codebase):\n\n# example-project\n\n## Section',
    expect: {
      name: 'example-project',
      source: 'claude-md',
    },
  },
  {
    // Shape: codex variant with AGENTS.md absolute-path mention.
    name: 'AGENTS.md path-prefixed ref + adjacent heading',
    input:
      'Loaded /home/leif/proj/AGENTS.md (governs this repo):\n\n# acme-billing\n\nProject overview.',
    expect: { name: 'acme-billing', source: 'agents-md' },
  },
  {
    // Restraint check: a *prose* mention of CLAUDE.md must NOT trigger
    // the claude-md branch, because the next heading ("# Executing
    // actions with care") is part of the vendor harness, not the
    // project. A reference fixture has the prompt body mention
    // "durable instructions like CLAUDE.md files" before vendor
    // harness headings. Expectation: fall through to first-heading.
    name: 'prose mention "like CLAUDE.md" does not trigger claude-md',
    input:
      '# System\n\nyou are claude code.\n\nyou should respect durable instructions like CLAUDE.md files, but only when authorized.',
    expect: { name: 'System', source: 'first-heading' },
  },
  {
    // First-heading fallback: a plain L2-only AGENTS.md style prompt
    // that starts directly with a `# Name`. No file reference.
    name: 'first heading only',
    input: '# my-cool-project\n\nDo not run `rm -rf /`.',
    expect: { name: 'my-cool-project', source: 'first-heading' },
  },
  {
    name: 'empty string → null',
    input: '',
    expect: null,
  },
  {
    name: 'whitespace-only → null',
    input: '   \n\t  \n',
    expect: null,
  },
  {
    name: 'no heading anywhere → null',
    input: 'just a prose paragraph with no markdown headings at all.',
    expect: null,
  },
  {
    // Codex inline-code project name. `# \`my-project\`` should
    // surface as "my-project" — bare, not wrapped in backticks.
    name: 'inline backticks stripped',
    input: '# `my-project`\n\nReadme body.',
    expect: { name: 'my-project', source: 'first-heading' },
  },
  {
    // Mixed L1+L2: codex XML wrapper ends, then L2 heading begins.
    // The leading `</personality>` close should be skipped so the
    // first-heading branch still picks "edge-router" as the project.
    name: 'heading after leading XML close tag',
    input: '</personality>\n\n# edge-router\n\nProject context body.',
    expect: { name: 'edge-router', source: 'first-heading' },
  },
];

console.log('extractProjectContext:');
for (const c of ctxCases) {
  check(c.name, extractProjectContext(c.input), c.expect);
}

// ---------------------------------------------------------------------
// extractSkills
// ---------------------------------------------------------------------

const skillCases: Case<string, string[]>[] = [
  {
    // Real codex shape — fixtures with 30+ <skill><name>X</name>…
    // </skill> blocks under <available_skills>.
    name: 'multi-skill body-name declaration (codex shape)',
    input:
      '<available_skills>\n  <skill>\n    <name>ai-search</name>\n    <description>...</description>\n  </skill>\n  <skill>\n    <name>gen-image</name>\n    <description>...</description>\n  </skill>\n</available_skills>',
    expect: ['ai-search', 'gen-image'],
  },
  {
    // Some Claude Code variants advertise a subagent via attribute.
    name: 'subagent with name attribute',
    input: '<subagent name="researcher" tier="pro">...</subagent>',
    expect: ['researcher'],
  },
  {
    // Mixed types must come back in DOCUMENT order, not type-grouped.
    name: 'mixed subagent + skill order preserved',
    input:
      '<subagent>\n<name>planner</name>\n</subagent>\n<skill>\n<name>web-fetch</name>\n</skill>\n<subagent>\n<name>reviewer</name>\n</subagent>',
    expect: ['planner', 'web-fetch', 'reviewer'],
  },
  {
    // Duplicate name (same skill repeated) → only first appears.
    name: 'dedup duplicate names',
    input:
      '<skill><name>fmt</name></skill>\n<skill><name>fmt</name></skill>\n<skill><name>lint</name></skill>',
    expect: ['fmt', 'lint'],
  },
  {
    name: 'no match → empty array',
    input: 'just prose, no XML',
    expect: [],
  },
  {
    // Defensive: harness encoded a name; we should decode it for
    // display. Real-world likelihood is low but the cost is one
    // replace chain.
    name: 'HTML entity decode in name',
    input: '<skill><name>diff&lt;file&gt;</name></skill>',
    expect: ['diff<file>'],
  },
  {
    // Codex-style personality declaration.
    name: 'personality with body-name',
    input: '<personality>\n  <name>strict</name>\n  <values>...</values>\n</personality>',
    expect: ['strict'],
  },
  {
    // Some Claude Code projects emit <agent name="X">. Matches the
    // attribute-form branch.
    name: 'agent with name attribute (single quotes)',
    input: "<agent name='auditor'>...</agent>",
    expect: ['auditor'],
  },
  {
    // Hyphens / underscores / dots in names must survive.
    name: 'punctuation in names is preserved',
    input: '<skill><name>mars.blog</name></skill><skill><name>code_review</name></skill>',
    expect: ['mars.blog', 'code_review'],
  },
];

console.log('extractSkills:');
for (const c of skillCases) {
  check(c.name, extractSkills(c.input), c.expect);
}

console.log(`\n${passed} passed, ${failed} failed.`);
if (failed > 0) {
  // Non-zero exit for CI / manual runs to flag regressions. `process`
  // is intentionally untyped here so the file doesn't pull in
  // @types/node — svelte-check runs in browser-libs-only mode.
  const g = globalThis as unknown as {
    process?: { exit: (code: number) => void };
  };
  if (g.process) g.process.exit(1);
}
