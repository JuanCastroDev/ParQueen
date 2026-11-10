import { execFileSync, spawnSync } from 'node:child_process';
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ID = 'demo-parkqueen-parking-fence-iso';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEMO_ENV_PATH = resolve(REPO_ROOT, 'functions', `.env.${PROJECT_ID}`);
const LOCAL_ENV_PATH = resolve(REPO_ROOT, 'functions', '.env.local');
const CONFIG_PATH = resolve(REPO_ROOT, 'firebase.functions-isolated-ci.json');
const CREDENTIAL_SENTINEL = resolve(REPO_ROOT, 'functions', 'parking-fence-no-adc.json');
const SAFE_KEYS = new Set([
  'WAITLIST_CONFIRM_BASE_URL',
  'WAITLIST_ALLOWED_HOSTNAMES',
  'CURB_RESOLVER_MODE',
  'CURB_RESOLVER_URL',
  'CURB_SHADOW_SAMPLE_PERMILLE',
  'CURB_PRODUCT_PATH',
]);
const DEMO_ENV_TEXT = [
  'WAITLIST_CONFIRM_BASE_URL=https://parqueen-marketing.web.app',
  'WAITLIST_ALLOWED_HOSTNAMES=parqueen-marketing.web.app',
  'CURB_RESOLVER_MODE=off',
  'CURB_RESOLVER_URL=',
  'CURB_SHADOW_SAMPLE_PERMILLE=0',
  'CURB_PRODUCT_PATH=off',
  '',
].join('\n');
const CONFIG_TEXT = `${JSON.stringify({
  functions: { source: 'functions' },
  firestore: { rules: 'firestore.rules', indexes: 'firestore.indexes.json' },
  storage: { rules: 'storage.rules' },
  emulators: {
    functions: { port: 5003 },
    firestore: { port: 8493 },
    auth: { port: 9097 },
    storage: { port: 9297 },
    ui: { enabled: false },
    hub: { port: 4413 },
    logging: { port: 4513 },
  },
}, null, 2)}\n`;
function fail(message, code = 1) {
  console.error(`BLOCKED: ${message}`);
  process.exit(code);
}

if (PROJECT_ID !== 'demo-parkqueen-parking-fence-iso' || !PROJECT_ID.startsWith('demo-')) {
  fail('Isolated fence tests refuse every project except demo-parkqueen-parking-fence-iso');
}
if (lstatSync(CREDENTIAL_SENTINEL, { throwIfNoEntry: false })) {
  fail('The isolated credential sentinel must not exist');
}

function pathStatus(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

if (pathStatus(DEMO_ENV_PATH)) fail(`${DEMO_ENV_PATH} already exists; refusing to overwrite it`);
if (pathStatus(LOCAL_ENV_PATH)) fail(`${LOCAL_ENV_PATH} already exists; refusing to overwrite it`);
if (pathStatus(CONFIG_PATH)) fail(`${CONFIG_PATH} already exists; refusing to overwrite it`);

function firebaseLaunch() {
  if (process.platform !== 'win32') return { command: 'firebase', args: [] };
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
  if (!firebaseCmd) fail('Firebase CLI installation could not be located');
  return {
    command: process.execPath,
    args: [resolve(dirname(firebaseCmd), 'node_modules', 'firebase-tools', 'lib', 'bin', 'firebase.js')],
  };
}

const vitestCommand = 'node node_modules/vitest/vitest.mjs run --config vite.functions.isolated.config.ts';
const script = process.platform === 'win32'
  ? vitestCommand
  : `sh -c 'echo FUNCTIONS_ISOLATED_VITEST_START; ${vitestCommand}'`;

function safeParameterFile(path) {
  const text = readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  let sawKey = false;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(trimmed);
    if (!match || !SAFE_KEYS.has(match[1])) return false;
    if (match[1] === 'WAITLIST_CONFIRM_BASE_URL' && match[2] !== 'https://parqueen-marketing.web.app') return false;
    if (match[1] === 'WAITLIST_ALLOWED_HOSTNAMES' && match[2] !== 'parqueen-marketing.web.app') return false;
    if (match[1].startsWith('CURB_') && !['off', '', '0'].includes(match[2])) return false;
    sawKey = true;
  }
  return sawKey;
}

const localEnvExisted = Boolean(pathStatus(LOCAL_ENV_PATH));
let createdEnv = false;
let createdConfig = false;
let exitCode = 0;
try {
  const envFd = openSync(DEMO_ENV_PATH, 'wx', 0o600);
  createdEnv = true;
  try {
    writeSync(envFd, DEMO_ENV_TEXT);
  } finally {
    closeSync(envFd);
  }
  const configFd = openSync(CONFIG_PATH, 'wx', 0o600);
  createdConfig = true;
  try {
    writeSync(configFd, CONFIG_TEXT);
  } finally {
    closeSync(configFd);
  }
  const launch = firebaseLaunch();
  const result = spawnSync(launch.command, [
    ...launch.args,
    'emulators:exec',
    '--only',
    'functions,firestore,auth,storage',
    '--project',
    PROJECT_ID,
    '--config',
    CONFIG_PATH,
    script,
  ], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      GCLOUD_PROJECT: PROJECT_ID,
      GOOGLE_CLOUD_PROJECT: PROJECT_ID,
      S7_ISOLATED_PROJECT: PROJECT_ID,
      GOOGLE_APPLICATION_CREDENTIALS: CREDENTIAL_SENTINEL,
      FIREBASE_CONFIG: JSON.stringify({
        projectId: PROJECT_ID,
        storageBucket: `${PROJECT_ID}.appspot.com`,
      }),
    },
    stdio: 'inherit',
  });
  if (result.error) {
    exitCode = 1;
    console.error('BLOCKED: Firebase CLI could not be started');
  } else if (result.status !== 0) {
    exitCode = result.status ?? 1;
  }
} finally {
  if (createdEnv) {
    try {
      unlinkSync(DEMO_ENV_PATH);
    } catch (error) {
      console.error(`BLOCKED: could not remove ${DEMO_ENV_PATH}`);
      exitCode = exitCode || 1;
      void error;
    }
  }
  if (createdConfig) {
    try {
      unlinkSync(CONFIG_PATH);
    } catch (error) {
      console.error(`BLOCKED: could not remove ${CONFIG_PATH}`);
      exitCode = exitCode || 1;
      void error;
    }
  }
  if (!localEnvExisted && pathStatus(LOCAL_ENV_PATH)) {
    if (safeParameterFile(LOCAL_ENV_PATH)) {
      try {
        unlinkSync(LOCAL_ENV_PATH);
      } catch (error) {
        console.error(`BLOCKED: could not remove ${LOCAL_ENV_PATH}`);
        exitCode = exitCode || 1;
        void error;
      }
    } else {
      console.error(`BLOCKED: ${LOCAL_ENV_PATH} was created and is not a known emulator parameter file`);
      exitCode = exitCode || 1;
    }
  }
}

process.exit(exitCode);
