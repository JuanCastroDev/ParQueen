// General PR suite.
// Omits only the private 26C provenance file. npm test is unchanged and
// still runs that file. Release preflight also still calls vitest directly.
// This policy change requires independent Security/QA acceptance before merge.

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRIVATE_SUITE = 'functions/curbIntelligence/provenanceAndConflict.test.cjs';
const VITEST = resolve(ROOT, 'node_modules', 'vitest', 'vitest.mjs');

const banner = [
  'GENERAL PR SUITE',
  `EXCLUDED: ${PRIVATE_SUITE}`,
  'Only the private 26C provenance suite is omitted.',
  'The 11 genuine successor cases are not skipped inside that file.',
  'Run them with: node scripts/ci/private-provenance-suite.mjs',
  'npm test is unchanged and still includes the private suite.',
  'CI test-scope policy: independent Security/QA acceptance is required before merge.',
].join('\n');

console.log(banner);
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${banner}\n`);
}

const child = spawnSync(process.execPath, [
  VITEST,
  'run',
  '--exclude',
  PRIVATE_SUITE,
  ...process.argv.slice(2),
], {
  cwd: ROOT,
  stdio: 'inherit',
  env: process.env,
});

if (child.error) {
  console.error('GENERAL PR SUITE failed to start Vitest.');
  process.exit(1);
}
process.exit(child.status ?? 1);
