// Temporary Linux discovery probe. Emits only fixed event names.
// Raw Firebase output stays in memory and is never written to the job log.

import { spawn } from 'node:child_process';
import { existsSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = resolve(ROOT, 's7-discovery-probe-out');
const PROJECT = 'demo-parkqueen-s7-fn-iso';
const SENTINEL = 'C:/Users/jayca/AppData/Local/ParQueen/s7-fn-iso-no-adc.json';
const DEADLINE_MS = 60000;
const GRACE_MS = 5000;

export function observe(line, state) {
  const text = String(line);
  if (text.includes('Detected demo project ID "demo-parkqueen-s7-fn-iso"')) state.project = true;
  else if (text.includes('Firestore Emulator was started')) state.firestore = true;
  else if (/Watching .+ for Cloud Functions/.test(text)) state.worker = true;
  else if (/^Serving at port \d+$/.test(text.trim())) state.listening = true;
  else if (text.includes('Could not find functions.yaml')) state.request = true;
  else if (text.includes('Got response from /__/functions.yaml')) state.response = true;
  else if (text.includes('Loaded functions definitions from source:')) state.definitions = true;
  else if (text.trim() === 'FUNCTIONS_DISCOVERY_READY') state.ready = true;
  else state.unknown += 1;
}

export function freshState() {
  return {
    project: false,
    firestore: false,
    worker: false,
    listening: false,
    request: false,
    response: false,
    definitions: false,
    ready: false,
    unknown: 0,
  };
}

export function publicEvents(state) {
  const events = ['PROBE_STARTED'];
  if (state.project) events.push('PROJECT_ISOLATION_VERIFIED');
  if (state.firestore) events.push('FIRESTORE_EMULATOR_STARTED');
  if (state.worker) events.push('FUNCTIONS_WORKER_STARTED');
  if (state.listening) events.push('FUNCTIONS_DISCOVERY_SERVER_LISTENING');
  if (state.request) events.push('FUNCTIONS_DISCOVERY_REQUEST_OBSERVED');
  if (state.response) events.push('FUNCTIONS_DISCOVERY_RESPONSE_OBSERVED');
  if (state.definitions) events.push('FUNCTIONS_DEFINITIONS_LOADED');
  if (state.ready) events.push('FUNCTIONS_DISCOVERY_READY');
  events.push('FUNCTIONS_INTEGRATION_UNVERIFIED');
  return events;
}

function emit(name) {
  const allowed = new Set([
    'PROBE_STARTED',
    'PROJECT_ISOLATION_VERIFIED',
    'FIRESTORE_EMULATOR_STARTED',
    'FUNCTIONS_WORKER_STARTED',
    'FUNCTIONS_DISCOVERY_SERVER_LISTENING',
    'FUNCTIONS_DISCOVERY_REQUEST_OBSERVED',
    'FUNCTIONS_DISCOVERY_RESPONSE_OBSERVED',
    'FUNCTIONS_DEFINITIONS_LOADED',
    'FUNCTIONS_DISCOVERY_READY',
    'DISCOVERY_TIMEOUT',
    'DISCOVERY_PROCESS_EXIT',
    'DISCOVERY_FAILED',
    'FUNCTIONS_INTEGRATION_UNVERIFIED',
    'DISCOVERY_PASS',
    'DISCOVERY_ERROR',
    'DIAGNOSTIC_BLOCKED',
  ]);
  if (!allowed.has(name)) return;
  process.stdout.write(`${name}\n`);
}

function classify(state, timedOut, exitCode) {
  if (timedOut) return 'DISCOVERY_TIMEOUT';
  if (state.ready && exitCode === 0 && state.definitions) return 'DISCOVERY_PASS';
  return 'DISCOVERY_ERROR';
}

let failing = false;
export function failClosed() {
  if (failing) return;
  failing = true;
  try { process.stdout.write('DIAGNOSTIC_INTERNAL_ERROR\n'); } catch { /* marker only */ }
  process.exit(1);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  process.on('uncaughtException', () => failClosed());
  process.on('unhandledRejection', () => failClosed());
  try {
    if (process.platform !== 'linux') {
      emit('DIAGNOSTIC_BLOCKED');
      process.exit(1);
    }
    run();
  } catch {
    failClosed();
  }
}

function run() {
  emit('PROBE_STARTED');
  const state = freshState();
  const started = Date.now();
  let timedOut = false;
  let settled = false;
  const child = spawn('firebase', [
    '--debug',
    'emulators:exec',
    '--config', 'firebase.s7-fn-iso.json',
    '--only', 'functions,firestore,auth,storage',
    '--project', PROJECT,
    'node -e "console.log(\'FUNCTIONS_DISCOVERY_READY\')"',
  ], {
    cwd: ROOT,
    detached: true,
    env: {
      ...process.env,
      GCLOUD_PROJECT: PROJECT,
      GOOGLE_CLOUD_PROJECT: PROJECT,
      S7_ISOLATED_PROJECT: PROJECT,
      FUNCTIONS_DISCOVERY_TIMEOUT: '20',
      GOOGLE_APPLICATION_CREDENTIALS: SENTINEL,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  function take(chunk) {
    for (const line of chunk.toString().split(/\n/)) observe(line, state);
  }
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  child.on('error', () => failClosed());

  function stopGroup(signal) {
    if (!child.pid || child.pid === process.pid) return;
    try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* exited */ } }
  }

  const timer = setTimeout(() => {
    timedOut = true;
    emit('DISCOVERY_TIMEOUT');
    stopGroup('SIGTERM');
    setTimeout(() => stopGroup('SIGKILL'), GRACE_MS);
  }, DEADLINE_MS);

  child.on('exit', (status) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    const exitCode = Number.isInteger(status) ? status : 1;
    const outcome = classify(state, timedOut, exitCode);
    for (const name of publicEvents(state)) {
      if (name !== 'PROBE_STARTED') emit(name);
    }
    emit('DISCOVERY_PROCESS_EXIT');
    emit(outcome);
    mkdirSync(OUT, { recursive: true });
    const milestones = {
      outcome,
      elapsedMs: Date.now() - started,
      exitCode,
      unknown: state.unknown,
      project: state.project,
      firestore: state.firestore,
      worker: state.worker,
      listening: state.listening,
      request: state.request,
      response: state.response,
      definitions: state.definitions,
      ready: state.ready,
      integration: 'UNVERIFIED',
    };
    writeFileSync(resolve(OUT, 'milestones.json'), `${JSON.stringify(milestones)}\n`);
    writeFileSync(resolve(OUT, 'result.txt'), `${outcome}\nFUNCTIONS_INTEGRATION_UNVERIFIED\n`);
    const debugLog = resolve(ROOT, 'firebase-debug.log');
    if (existsSync(debugLog)) {
      try { unlinkSync(debugLog); } catch { /* leave untracked; not uploaded */ }
    }
    process.exit(outcome === 'DISCOVERY_PASS' ? 0 : 1);
  });
}
