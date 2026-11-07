// Temporary Linux discovery probe. Emits only fixed event names.
// Raw Firebase output stays in memory and is never written to the job log.

import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { existsSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = resolve(ROOT, 's7-discovery-probe-out');
const PROJECT = 'demo-parkqueen-s7-fn-iso';
const SENTINEL = 'C:/Users/jayca/AppData/Local/ParQueen/s7-fn-iso-no-adc.json';
const DEADLINE_MS = 60000;
const GRACE_MS = 5000;

const MAX_LINE = 4096;
const KEYS = ['project', 'firestore', 'worker', 'listening', 'request', 'response', 'definitions', 'ready'];

export function observe(line, state, elapsedMs) {
  const text = String(line).slice(0, MAX_LINE);
  let key = '';
  if (text.includes('Detected demo project ID "demo-parkqueen-s7-fn-iso"')) key = 'project';
  else if (text.includes('Firestore Emulator was started')) key = 'firestore';
  else if (/Watching .+ for Cloud Functions/.test(text)) key = 'worker';
  else if (/^Serving at port \d+$/.test(text.trim())) key = 'listening';
  else if (text.includes('Could not find functions.yaml')) key = 'request';
  else if (text.includes('Got response from /__/functions.yaml')) key = 'response';
  else if (text.includes('Loaded functions definitions from source:')) key = 'definitions';
  else if (text.trim() === 'FUNCTIONS_DISCOVERY_READY') key = 'ready';
  if (!key) {
    state.unknown += 1;
    return;
  }
  if (state[key]) return;
  state[key] = true;
  state.times[key] = elapsedMs;
}

export function createLineBuffer(onLine) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  return {
    push(chunk) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      pending += decoder.write(buf);
      for (;;) {
        const cr = pending.indexOf('\r\n');
        const lf = pending.indexOf('\n');
        let cut = -1;
        let width = 1;
        if (cr !== -1 && (lf === -1 || cr < lf)) {
          cut = cr;
          width = 2;
        } else if (lf !== -1) {
          cut = lf;
        }
        if (cut === -1) break;
        onLine(pending.slice(0, Math.min(cut, MAX_LINE)));
        pending = pending.slice(cut + width);
      }
      if (pending.length > MAX_LINE) {
        onLine(pending.slice(0, MAX_LINE));
        pending = '';
      }
    },
    end() {
      pending += decoder.end();
      if (pending.length) onLine(pending.slice(0, MAX_LINE));
      pending = '';
    },
  };
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
    times: {},
  };
}

export function classifyRun(facts) {
  const loaded = Number.isInteger(facts.definitionsMs);
  const ready = Number.isInteger(facts.readyMs);
  const beforeDeadline = loaded && ready && facts.definitionsMs < facts.deadlineMs && facts.readyMs < facts.deadlineMs;
  if (beforeDeadline && facts.exitCode === 0 && !facts.terminated && facts.streamsClosed && Number.isInteger(facts.exitMs) && facts.exitMs < facts.deadlineMs) {
    return 'DISCOVERY_PASS';
  }
  if (beforeDeadline && (facts.terminated || !facts.streamsClosed || !Number.isInteger(facts.exitMs) || facts.exitMs >= facts.deadlineMs)) {
    return 'DISCOVERY_CLEANUP_STALL';
  }
  if (facts.deadlineFired && !beforeDeadline) return 'DISCOVERY_TIMEOUT';
  return 'DISCOVERY_ERROR';
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
    'DISCOVERY_CLEANUP_STALL',
    'DISCOVERY_ERROR',
    'DIAGNOSTIC_BLOCKED',
  ]);
  if (!allowed.has(name)) return;
  process.stdout.write(`${name}\n`);
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
  const started = process.hrtime.bigint();
  const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6 | 0;
  state.times.start = 0;
  let deadlineFired = false;
  let terminated = false;
  let settled = false;
  let exitCode = null;
  let exitSignal = '';
  let exitMs = null;
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

  const stdout = createLineBuffer((line) => observe(line, state, elapsed()));
  const stderr = createLineBuffer((line) => observe(line, state, elapsed()));
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  child.stdout.on('end', () => stdout.end());
  child.stderr.on('end', () => stderr.end());
  child.on('error', () => failClosed());

  function stopGroup(signal) {
    if (!child.pid || child.pid === process.pid) return;
    terminated = true;
    try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* exited */ } }
  }

  let killTimer = null;
  let forceTimer = null;
  const timer = setTimeout(() => {
    deadlineFired = true;
    state.times.deadline = elapsed();
    emit('DISCOVERY_TIMEOUT');
    stopGroup('SIGTERM');
    killTimer = setTimeout(() => stopGroup('SIGKILL'), GRACE_MS);
    forceTimer = setTimeout(() => finish(false), GRACE_MS + 2000);
  }, DEADLINE_MS);

  child.on('exit', (status, signal) => {
    exitCode = Number.isInteger(status) ? status : null;
    exitSignal = signal === 'SIGTERM' || signal === 'SIGKILL' ? signal : '';
    exitMs = elapsed();
  });

  function finish(streamsClosed) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    clearTimeout(forceTimer);
    stdout.end();
    stderr.end();
    const facts = {
      deadlineMs: DEADLINE_MS,
      deadlineFired,
      terminated,
      streamsClosed,
      exitCode,
      exitMs,
      definitionsMs: state.times.definitions,
      readyMs: state.times.ready,
    };
    const outcome = classifyRun(facts);
    for (const name of publicEvents(state)) {
      if (name !== 'PROBE_STARTED') emit(name);
    }
    emit('DISCOVERY_PROCESS_EXIT');
    emit(outcome);
    const times = { start: 0, closed: elapsed() };
    for (const key of KEYS) times[key] = Number.isInteger(state.times[key]) ? state.times[key] : null;
    times.deadline = Number.isInteger(state.times.deadline) ? state.times.deadline : null;
    times.exit = exitMs;
    mkdirSync(OUT, { recursive: true });
    writeFileSync(resolve(OUT, 'milestones.json'), `${JSON.stringify({
      outcome,
      elapsedMs: elapsed(),
      exitCode,
      signal: exitSignal || 'NONE',
      deadlineFired,
      terminated,
      streamsClosed,
      unknown: state.unknown,
      times,
      integration: 'UNVERIFIED',
    })}\n`);
    writeFileSync(resolve(OUT, 'result.txt'), `${outcome}\nFUNCTIONS_INTEGRATION_UNVERIFIED\n`);
    const debugLog = resolve(ROOT, 'firebase-debug.log');
    if (existsSync(debugLog)) {
      try { unlinkSync(debugLog); } catch { /* not uploaded */ }
    }
    process.exit(outcome === 'DISCOVERY_PASS' ? 0 : 1);
  }

  child.on('close', () => finish(true));
}
