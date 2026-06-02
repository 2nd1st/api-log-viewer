// Smoke tests for clientDisplay. Run via `pnpm test` if integrated
// into the test runner, or manually via tsx. The tests aren't wired
// into the existing test command (which currently only runs
// promptSource.test.ts) — they're here as documentation + safety net.

import { displayClientVersion, clientLabel } from './clientDisplay';

const cases: Array<{
  name: string;
  kind: string | null | undefined;
  version: string | null | undefined;
  wantVersion: string;
  wantLabel: string;
}> = [
  {
    name: 'go-http-client hides version',
    kind: 'go-http-client',
    version: '2.0',
    wantVersion: '—',
    wantLabel: 'go-http-client',
  },
  {
    name: 'go-http-client 1.1 also hidden',
    kind: 'go-http-client',
    version: '1.1',
    wantVersion: '—',
    wantLabel: 'go-http-client',
  },
  {
    name: 'claude-cli shows version',
    kind: 'claude-cli',
    version: '0.5.13',
    wantVersion: '0.5.13',
    wantLabel: 'claude-cli 0.5.13',
  },
  {
    name: 'curl shows version',
    kind: 'curl',
    version: '8.7.1',
    wantVersion: '8.7.1',
    wantLabel: 'curl 8.7.1',
  },
  {
    name: 'null version',
    kind: 'browser',
    version: null,
    wantVersion: '—',
    wantLabel: 'browser',
  },
  {
    name: 'empty version',
    kind: 'opencode-cli',
    version: '',
    wantVersion: '—',
    wantLabel: 'opencode-cli',
  },
  {
    name: 'null kind yields empty label',
    kind: null,
    version: '8.7.1',
    wantVersion: '8.7.1',
    wantLabel: '',
  },
];

let failed = 0;
let passed = 0;
for (const c of cases) {
  const gotVersion = displayClientVersion(c.kind, c.version);
  const gotLabel = clientLabel(c.kind, c.version);
  if (gotVersion !== c.wantVersion) {
    console.error(`FAIL [${c.name}] displayClientVersion: got ${JSON.stringify(gotVersion)}, want ${JSON.stringify(c.wantVersion)}`);
    failed++;
  } else {
    passed++;
  }
  if (gotLabel !== c.wantLabel) {
    console.error(`FAIL [${c.name}] clientLabel: got ${JSON.stringify(gotLabel)}, want ${JSON.stringify(c.wantLabel)}`);
    failed++;
  } else {
    passed++;
  }
}

console.log(`clientDisplay: ${passed} passed, ${failed} failed.`);
if (failed > 0) throw new Error(`clientDisplay tests: ${failed} failed`);
