// Private provenance suite.
// Local command: node scripts/ci/private-provenance-suite.mjs
// Requires PARQUEEN_PROVENANCE_SUCCESSOR to be the genuine 45710043-byte
// successor. A missing file or a different digest fails closed.
// This command does not upload the artifact and does not print its contents.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PRIVATE_SUITE = 'functions/curbIntelligence/provenanceAndConflict.test.cjs';
const SUCCESSOR_SHA256 = 'e1ca91f7ba05e874449f168242509908ab7d587be3fc7f3352c66c0851cbc225';
const VITEST = resolve(ROOT, 'node_modules', 'vitest', 'vitest.mjs');

function failClosed(message) {
  console.error('PRIVATE PROVENANCE SUITE: FAIL_CLOSED');
  console.error(message);
  process.exit(1);
}

const successorPath = process.env.PARQUEEN_PROVENANCE_SUCCESSOR;
if (!successorPath) {
  failClosed('PARQUEEN_PROVENANCE_SUCCESSOR is required. The genuine successor is not in the repository.');
}

let bytes;
try {
  bytes = readFileSync(successorPath);
} catch {
  failClosed('The genuine successor could not be read.');
}

const digest = createHash('sha256').update(bytes).digest('hex');
if (digest !== SUCCESSOR_SHA256) {
  failClosed('genuine successor SHA256 mismatch');
}

console.log('PRIVATE PROVENANCE SUITE');
console.log(`SUCCESSOR_SHA256: ${SUCCESSOR_SHA256}`);
console.log('Digest verified. Running the 11 genuine provenance cases.');

const child = spawnSync(process.execPath, [
  VITEST,
  'run',
  PRIVATE_SUITE,
], {
  cwd: ROOT,
  stdio: 'inherit',
  env: process.env,
});

if (child.error) {
  failClosed('Vitest could not be started.');
}
process.exit(child.status ?? 1);
