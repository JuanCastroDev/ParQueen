import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

const FUNCTIONS_DIR = join(REPO_ROOT, 'functions');
const DEMO_ENV_PATH = join(FUNCTIONS_DIR, `.env.${PROJECT_ID}`);
const LOCAL_ENV_PATH = join(FUNCTIONS_DIR, '.env.local');
const DEMO_ENV_TEXT = [
  `WAITLIST_CONFIRM_BASE_URL=${WAITLIST_CONFIRM_BASE_URL}`,
  `WAITLIST_ALLOWED_HOSTNAMES=${WAITLIST_ALLOWED_HOSTNAMES}`,
  '',
].join('\n');
const ATTRIBUTABLE_KEYS = new Set([
  'WAITLIST_CONFIRM_BASE_URL',
  'WAITLIST_ALLOWED_HOSTNAMES',
  'CURB_RESOLVER_MODE',
  'CURB_RESOLVER_URL',
  'CURB_SHADOW_SAMPLE_PERMILLE',
  'CURB_PRODUCT_PATH',
]);

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n');
}

function pathStatus(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function refuseUnexpectedPath(path, label) {
  const stat = pathStatus(path);
  if (!stat) return;
  if (stat.isSymbolicLink()) {
    fail(`${label} is a symlink; refusing to continue`);
  }
  if (!stat.isFile()) {
    fail(`${label} is not a regular file; refusing to continue`);
  }
  fail(`${label} already exists; refusing to overwrite it`);
}

let createdDemoEnv = false;

function createDemoEnv() {
  const fd = openSync(DEMO_ENV_PATH, 'wx', 0o600);
  createdDemoEnv = true;
  try {
    writeSync(fd, DEMO_ENV_TEXT);
  } finally {
    closeSync(fd);
  }
  if (process.platform === 'win32' && process.env.USERNAME) {
    spawnSync('icacls', [
      DEMO_ENV_PATH,
      '/inheritance:r',
      '/grant:r',
      `${process.env.USERNAME}:(R,W)`,
    ], { stdio: 'ignore' });
  }
}

function attributableParameterFile(text) {
  let sawKey = false;
  for (const line of normalizeNewlines(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(trimmed);
    if (!match || !ATTRIBUTABLE_KEYS.has(match[1])) return false;
    if (match[1] === 'WAITLIST_CONFIRM_BASE_URL' && match[2] !== WAITLIST_CONFIRM_BASE_URL) return false;
    if (match[1] === 'WAITLIST_ALLOWED_HOSTNAMES' && match[2] !== WAITLIST_ALLOWED_HOSTNAMES) return false;
    if (match[1].startsWith('CURB_') && !['off', '', '0'].includes(match[2])) return false;
    sawKey = true;
  }
  return sawKey;
}

function removeRegularFile(path) {
  const stat = pathStatus(path);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile()) return 'not a regular file';
  if (dirname(resolve(path)) !== resolve(FUNCTIONS_DIR)) return 'outside the functions directory';
  unlinkSync(path);
  return pathStatus(path) ? 'still present after removal' : null;
}

function cleanupCreatedFiles(localEnvExisted) {
  const problems = [];
  const demoStat = pathStatus(DEMO_ENV_PATH);
  if (createdDemoEnv && demoStat) {
    if (demoStat.isSymbolicLink()) {
      problems.push(`${DEMO_ENV_PATH} is a symlink and was left in place`);
    } else {
      const text = readFileSync(DEMO_ENV_PATH, 'utf8');
      if (!attributableParameterFile(text)) {
        problems.push(`${DEMO_ENV_PATH} remains and could not be attributed to this run`);
      } else {
        const error = removeRegularFile(DEMO_ENV_PATH);
        if (error) problems.push(`${DEMO_ENV_PATH} ${error}`);
      }
    }
  }
  const localStat = pathStatus(LOCAL_ENV_PATH);
  if (!localEnvExisted && localStat) {
    if (localStat.isSymbolicLink()) {
      problems.push(`${LOCAL_ENV_PATH} is a symlink and was left in place`);
    } else {
      const text = readFileSync(LOCAL_ENV_PATH, 'utf8');
      if (!attributableParameterFile(text)) {
        problems.push(`${LOCAL_ENV_PATH} remains and could not be attributed to this run`);
      } else {
        const error = removeRegularFile(LOCAL_ENV_PATH);
        if (error) problems.push(`${LOCAL_ENV_PATH} ${error}`);
      }
    }
  }
  return problems;
}

const vitestScript = 'node node_modules/vitest/vitest.mjs run --config vite.functions.config.ts';
const { node: firebaseNode, js: firebaseJs } = findFirebaseInstallation();
if (!existsSync(firebaseNode)) {
  fail('Firebase CLI Node executable is missing');
}
if (!existsSync(firebaseJs)) {
  fail('Firebase CLI entry point is missing');
}
refuseUnexpectedPath(DEMO_ENV_PATH, `functions/.env.${PROJECT_ID}`);
refuseUnexpectedPath(LOCAL_ENV_PATH, 'functions/.env.local');

let exitCode = 0;
let exitMessage = null;
try {
  createDemoEnv();
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
    exitCode = 1;
    exitMessage = 'Firebase CLI could not be started';
  } else if (result.status !== 0) {
    exitCode = result.status ?? 1;
    exitMessage = 'Functions integration tests failed';
  }
} catch {
  exitCode = exitCode || 1;
  if (!exitMessage) exitMessage = 'Functions integration runner failed before completion';
} finally {
  const problems = cleanupCreatedFiles(false);
  if (problems.length > 0) {
    exitCode = exitCode || 1;
    const cleanupMessage = problems.join('; ');
    exitMessage = exitMessage ? `${exitMessage}; ${cleanupMessage}` : cleanupMessage;
  }
}

if (exitCode !== 0) {
  fail(exitMessage || 'Functions integration tests failed', exitCode);
}

console.log('PASS: Functions integration');
console.log(`Project: ${PROJECT_ID}`);
