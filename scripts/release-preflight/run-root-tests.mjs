import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILD_WRAPPER = resolve(REPO_ROOT, 'scripts', 'release-preflight', 'run-production-build.mjs');
const VITEST_ENTRY = resolve(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

function fail(message, code = 1) {
  console.error(`BLOCKED: ${message}`);
  process.exit(code);
}

if (!existsSync(BUILD_WRAPPER)) {
  fail('isolated production build wrapper is missing');
}
if (!existsSync(VITEST_ENTRY)) {
  fail('local Vitest installation is missing; run npm ci first');
}

const build = spawnSync(process.execPath, [BUILD_WRAPPER], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  env: process.env,
});

if (build.error) {
  fail('isolated production build could not be started');
}
if (build.status !== 0) {
  fail('isolated production build gate failed', build.status ?? 1);
}

const tests = spawnSync(process.execPath, [VITEST_ENTRY, 'run'], {
  cwd: REPO_ROOT,
  stdio: 'inherit',
  env: process.env,
});

if (tests.error) {
  fail('root Vitest could not be started');
}
if (tests.status !== 0) {
  fail('root test gate failed', tests.status ?? 1);
}

console.log('PASS: deterministic root test gate');
