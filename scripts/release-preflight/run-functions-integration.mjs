import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PROJECT_ID = 'demo-parkqueen-functions-test';
const WAITLIST_CONFIRM_BASE_URL = 'https://parqueen-marketing.web.app';
const WAITLIST_ALLOWED_HOSTNAMES = 'parqueen-marketing.web.app';
const VITEST_ENTRY = resolve(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs');

function fail(message, code = 1) {
  console.error(`BLOCKED: ${message}`);
  process.exit(code);
}

function findFirebaseInstallation() {
  let listed;
  try {
    listed = execFileSync('where.exe', ['firebase'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    fail('Firebase CLI installation could not be located');
  }
  const firebaseCmd = listed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.toLowerCase().endsWith('firebase.cmd'));
  if (!firebaseCmd) {
    fail('Firebase CLI installation could not be located');
  }
  const firebaseDir = dirname(firebaseCmd);
  return {
    node: resolve(firebaseDir, 'node.exe'),
    js: resolve(firebaseDir, 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js'),
  };
}

if (!existsSync(VITEST_ENTRY)) {
  fail('local Vitest installation is missing; run npm ci first');
}

const vitestScript = 'node node_modules/vitest/vitest.mjs run --config vite.functions.config.ts';
const { node: firebaseNode, js: firebaseJs } = findFirebaseInstallation();
if (!existsSync(firebaseNode)) {
  fail('Firebase CLI Node executable is missing');
}
if (!existsSync(firebaseJs)) {
  fail('Firebase CLI entry point is missing');
}
const env = {
  ...process.env,
  GCLOUD_PROJECT: PROJECT_ID,
  WAITLIST_CONFIRM_BASE_URL,
  WAITLIST_ALLOWED_HOSTNAMES,
  FUNCTIONS_DISCOVERY_TIMEOUT: '30',
};
const result = spawnSync(firebaseNode, [
  firebaseJs,
  'emulators:exec',
  '--only',
  'functions,firestore,auth,storage',
  '--project',
  PROJECT_ID,
  '--',
  vitestScript,
], {
  cwd: REPO_ROOT,
  env,
  stdio: 'inherit',
});

if (result.error) {
  fail('Firebase CLI could not be started');
}
if (result.status !== 0) {
  fail('Functions integration tests failed', result.status ?? 1);
}

console.log('PASS: Functions integration');
console.log(`Project: ${PROJECT_ID}`);
