'use strict';

const { randomBytes } = require('node:crypto');
const { existsSync, mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { performance } = require('node:perf_hooks');
const DEMO_PROJECT_ID = 'demo-parkqueen-functions-test';
const LOCAL_LOGICAL_FUNCTION3C_URL = 'http://127.0.0.1:9';
const LOCAL_LOOKUP_TIMEOUT_MS = 20000;
const PRODUCTION_PROJECT_ID = 'parkqueen-46475363-ccf36';
const DEMO_AUTH_HOST = '127.0.0.1:9099';
const DEMO_FIRESTORE_HOST = '127.0.0.1:8080';

function localDemoSession(env = process.env) {
  const project = typeof env.GCLOUD_PROJECT === 'string' ? env.GCLOUD_PROJECT : '';
  return env.FUNCTIONS_EMULATOR === 'true'
    && project === DEMO_PROJECT_ID
    && project !== PRODUCTION_PROJECT_ID
    && env.FIRESTORE_EMULATOR_HOST === DEMO_FIRESTORE_HOST
    && env.FIREBASE_AUTH_EMULATOR_HOST === DEMO_AUTH_HOST
    && env.K_REVISION === '1';
}

function localModeRequested(env = process.env) {
  return env.CURB_LOCAL_FUNCTION3C === 'local' || env.CURB_OFFICIAL_LION_PRIMARY === 'local';
}

function localFunction3cAllowed(env) {
  return localDemoSession(env) && env.CURB_LOCAL_FUNCTION3C === 'local';
}

function localStreetIntelligenceBinding(env = process.env) {
  if (!localModeRequested(env)) return { mode: 'production' };
  if (!localDemoSession(env)) return { mode: 'closed' };
  const local = createLocalGeosupportTransport(env);
  if (!local) return { mode: 'closed' };
  return {
    mode: 'local',
    transport: local.transport,
    getIdToken: local.getIdToken,
    officialLionPrimary: env.CURB_OFFICIAL_LION_PRIMARY === 'local',
  };
}

function dockerBin(env = process.env) {
  const configured = typeof env.CURB_LOCAL_DOCKER_BIN === 'string' ? env.CURB_LOCAL_DOCKER_BIN.trim() : '';
  if (configured && existsSync(configured)) return configured;
  const standard = 'C:/Program Files/Docker/Docker/resources/bin/docker.exe';
  return existsSync(standard) ? standard : 'docker';
}

function failingTransport(message) {
  return async () => {
    throw new Error(message);
  };
}

function namedError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

function killTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try { child.kill(); } catch { /* The process has already exited. */ }
  if (process.platform !== 'win32' || !child.pid) return;
  const killer = require('node:child_process').spawn(
    'taskkill',
    ['/PID', String(child.pid), '/T', '/F'],
    { windowsHide: true, stdio: 'ignore' },
  );
  killer.on('error', () => {});
  killer.unref?.();
}

function notePhase(env, phase, elapsedMs) {
  if (env?.FUNCTIONS_EMULATOR !== 'true' || env?.GCLOUD_PROJECT !== DEMO_PROJECT_ID) return;
  try {
    console.log(JSON.stringify({
      record: 'parqueen_local_function3c_phase',
      phase,
      elapsedMs: Math.max(0, Math.round(elapsedMs)),
    }));
  } catch { /* timing never changes the lookup */ }
}

// The orchestrator stops waiting at its deadline, so a cleanup failure raised later would reach
// nobody. Record every cleanup outcome here; failures go to stderr with the container identity.
function noteCleanup(env, result, elapsedMs) {
  if (env?.FUNCTIONS_EMULATOR !== 'true' || env?.GCLOUD_PROJECT !== DEMO_PROJECT_ID) return;
  try {
    const line = JSON.stringify({
      record: 'parqueen_local_function3c_cleanup',
      outcome: result.ok ? 'absent' : result.reason,
      containerName: result.name,
      containerId: result.id || null,
      ...(result.ok ? {} : { detail: result.detail || null }),
      elapsedMs: Math.max(0, Math.round(elapsedMs)),
    });
    if (result.ok) console.log(line);
    else console.error(line);
  } catch { /* logging never changes cleanup */ }
}

function readContainerId(cidFile) {
  try {
    const id = readFileSync(cidFile, 'utf8').trim();
    return /^[a-f0-9]{12,64}$/i.test(id) ? id : null;
  } catch {
    return null;
  }
}

function runDocker(bin, args) {
  return new Promise(resolve => {
    let child;
    try {
      child = require('node:child_process').spawn(bin, args, {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ status: 127, stdout: '', stderr: error.message });
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    const timer = setTimeout(() => {
      killTree(child);
      resolve({ status: 124, stdout, stderr });
    }, 10000);
    child.on('error', error => {
      clearTimeout(timer);
      resolve({ status: 127, stdout, stderr: error.message });
    });
    child.on('exit', status => {
      clearTimeout(timer);
      resolve({ status: status ?? 1, stdout, stderr });
    });
  });
}

// Every session's container carries a unique name and a matching label, so cleanup can find it
// without the cidfile and can refuse to touch any container this session did not create.
const OWNER_LABEL = 'parqueen.function3c.run';
const CLEANUP_BUDGET_MS = 15000;
const CLEANUP_MAX_ATTEMPTS = 8;
const CLI_EXIT_WAIT_MS = 3000;
const ABSENCE_RECHECK_MS = 250;
const delay = ms => new Promise(resolve => { setTimeout(resolve, ms); });

function ownedContainer() {
  const run = randomBytes(8).toString('hex');
  return { run, name: `parqueen-f3c-${run}` };
}

// Only Docker's own "not found" answer proves absence. Daemon, transport, timeout (124) and spawn
// (127) failures are "unknown", never "absent".
function classifyInspect(result, owner) {
  if (result.status === 0) {
    const [id = '', label = ''] = result.stdout.trim().split(/\s+/);
    if (!/^[a-f0-9]{64}$/i.test(id)) return { state: 'unknown', detail: 'unreadable inspect output' };
    return label === owner.run ? { state: 'owned', id } : { state: 'foreign', id };
  }
  if (/\bNo such (container|object)\b/i.test(result.stderr)) return { state: 'absent' };
  const detail = result.stderr.trim().split(/\r?\n/).pop() || `docker inspect exited ${result.status}`;
  return { state: 'unknown', detail: detail.slice(0, 200) };
}

function inspectOwned(bin, owner) {
  return runDocker(bin, [
    'inspect', '--type', 'container',
    '-f', `{{.Id}} {{index .Config.Labels "${OWNER_LABEL}"}}`,
    owner.name,
  ]).then(result => classifyInspect(result, owner));
}

function waitForCliExit(child, exited) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return Promise.race([exited, delay(CLI_EXIT_WAIT_MS)]);
}

// Success means Docker reported the owned container absent twice, after the Docker CLI exited, so
// a container whose create was still in flight is caught. Anything else is reported, not hidden.
async function releaseOwnedContainer(bin, child, exited, cidFile, owner) {
  const startedAt = Date.now();
  killTree(child);
  await waitForCliExit(child, exited);
  let id = readContainerId(cidFile);
  let absentChecks = 0;
  let last = { state: 'unknown', detail: 'not inspected' };
  try {
    for (let attempt = 0; attempt < CLEANUP_MAX_ATTEMPTS && Date.now() - startedAt < CLEANUP_BUDGET_MS; attempt += 1) {
      last = await inspectOwned(bin, owner);
      if (last.state === 'absent') {
        absentChecks += 1;
        if (absentChecks >= 2) return { ok: true, id, name: owner.name };
        await delay(ABSENCE_RECHECK_MS);
        continue;
      }
      absentChecks = 0;
      if (last.state === 'foreign') {
        return { ok: false, id: last.id, name: owner.name, reason: 'not_owned' };
      }
      if (last.state === 'owned') {
        id = last.id;
        await runDocker(bin, ['rm', '-f', last.id]);
        continue;
      }
      await delay(ABSENCE_RECHECK_MS);
    }
    return {
      ok: false,
      id,
      name: owner.name,
      reason: last.state === 'owned' ? 'still_present' : 'unverified',
      detail: last.detail,
    };
  } finally {
    rmSync(join(cidFile, '..'), { recursive: true, force: true });
  }
}

function cleanupFailure(error, result) {
  const label = result.id ? `${result.name} (${result.id})` : result.name;
  const text = result.reason === 'not_owned'
    ? `Container name ${result.name} belongs to a container this session did not create; it was not removed.`
    : result.reason === 'still_present'
      ? `Container ${label} remained after removal.`
      : `Container ${label} could not be confirmed removed: ${result.detail}.`;
  const orphan = namedError('Error', `${error.message} ${text}`);
  orphan.containerId = result.id;
  orphan.containerName = result.name;
  orphan.cleanup = result.reason;
  orphan.cause = error;
  return orphan;
}

let geosupport = null;

function startGeosupport(image, service, env) {
  const script = [
    'import json, sys',
    'from resolver_service.native_adapter import Geosupport26CAdapter',
    'from resolver_service.service import ResolverService',
    'service = ResolverService(Geosupport26CAdapter())',
    'for line in sys.stdin:',
    '    line = line.strip()',
    '    if not line: continue',
    '    result = service.resolve_payload(json.loads(line))',
    '    sys.stdout.write("PARQUEEN_GEO " + json.dumps({"status": result.status_code, "payload": result.payload}) + "\\n")',
    '    sys.stdout.flush()',
  ].join('\n');
  const startedAt = performance.now();
  const cidDirectory = typeof env?.CURB_LOCAL_CID_DIRECTORY === 'string' && env.CURB_LOCAL_CID_DIRECTORY.trim()
    ? env.CURB_LOCAL_CID_DIRECTORY.trim() : tmpdir();
  const runDirectory = mkdtempSync(join(cidDirectory, 'parqueen-f3c-'));
  const cidFile = join(runDirectory, 'cid');
  const bin = dockerBin(env);
  const owner = ownedContainer();
  const child = require('node:child_process').spawn(bin, [
    'run', '-i', '--rm', '--cidfile', cidFile,
    '--name', owner.name, '--label', `${OWNER_LABEL}=${owner.run}`,
    '-v', `${service}:/app`, '-w', '/app', image,
    'python', '-u', '-c', script,
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let cliExited;
  const exited = new Promise(resolve => { cliExited = resolve; });
  notePhase(env, 'cli_spawn', performance.now() - startedAt);
  let buffer = '';
  let stderr = '';
  let containerNoted = false;
  const waiters = [];
  const listeners = [];
  const session = { stopped: false, lookup: null, failure: null };
  const finish = error => {
    if (session.stopped) return session.failure;
    session.stopped = true;
    if (geosupport === session) geosupport = null;
    for (const [signal, onAbort] of listeners) signal.removeEventListener('abort', onAbort);
    const pending = waiters.splice(0);
    const cleanupStartedAt = performance.now();
    session.failure = releaseOwnedContainer(bin, child, exited, cidFile, owner)
      .then(result => {
        noteCleanup(env, result, performance.now() - cleanupStartedAt);
        return result.ok ? error : cleanupFailure(error, result);
      });
    for (const waiter of pending) {
      session.failure.then(reason => waiter.reject(reason));
    }
    return session.failure;
  };
  const watchContainer = () => {
    if (containerNoted || session.stopped) return;
    if (!readContainerId(cidFile)) return;
    containerNoted = true;
    clearInterval(containerWatch);
    notePhase(env, 'container_created', performance.now() - startedAt);
  };
  const containerWatch = setInterval(watchContainer, 50);
  const originalFinish = finish;
  session.finish = error => {
    clearInterval(containerWatch);
    return originalFinish(error);
  };
  child.stdout.on('data', chunk => {
    if (session.stopped) return;
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith('PARQUEEN_GEO ')) {
        const waiter = waiters.shift();
        if (waiter && !session.stopped) {
          notePhase(env, 'native_result', performance.now() - startedAt);
          try {
            waiter.resolve(JSON.parse(line.slice('PARQUEEN_GEO '.length)));
          } catch (error) {
            session.finish(error);
          }
        }
      }
      newline = buffer.indexOf('\n');
    }
  });
  child.stderr.on('data', chunk => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2000);
  });
  child.on('exit', code => {
    cliExited();
    session.finish(new Error(`Function 3C exited ${code}: ${stderr.slice(-200)}`));
  });
  child.on('error', error => {
    cliExited();
    session.finish(error);
  });
  let chain = Promise.resolve();
  session.lookup = (tuple, signal) => {
    const run = chain.then(() => new Promise((resolve, reject) => {
      const deliverStopped = () => {
        Promise.resolve(session.failure).then(reason => reject(reason));
      };
      if (session.stopped || signal?.aborted) {
        const error = namedError('AbortError', 'The local Function 3C request was cancelled.');
        if (!session.stopped) session.finish(error);
        deliverStopped();
        return;
      }
      let settled = false;
      const settle = (report, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        report(value);
      };
      const timer = setTimeout(() => {
        session.finish(namedError('TimeoutError', 'Function 3C timed out'));
      }, LOCAL_LOOKUP_TIMEOUT_MS);
      const onAbort = () => {
        session.finish(namedError('AbortError', 'The local Function 3C request was cancelled.'));
      };
      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
        listeners.push([signal, onAbort]);
      }
      waiters.push({
        resolve: value => {
          queueMicrotask(() => {
            if (settled) return;
            if (signal?.aborted || session.stopped) {
              const failure = session.finish(namedError(
                'AbortError', 'The local Function 3C request was cancelled.',
              ));
              Promise.resolve(failure).then(reason => settle(reject, reason));
              return;
            }
            settle(resolve, value);
          });
        },
        reject: reason => settle(reject, reason),
      });
      try {
        child.stdin.write(`${JSON.stringify(tuple)}\n`);
      } catch (error) {
        session.finish(error);
      }
    }));
    chain = run.then(() => {}, () => {});
    return run;
  };
  session.stop = () => session.finish(namedError('AbortError', 'The local Function 3C process was stopped.'));
  return session;
}

function stopLocalGeosupport() {
  return geosupport?.stop?.() || Promise.resolve();
}

function createLocalGeosupportTransport(env = process.env) {
  if (!localFunction3cAllowed(env)) return null;
  const image = typeof env.CURB_LOCAL_GEOSUPPORT_IMAGE === 'string' ? env.CURB_LOCAL_GEOSUPPORT_IMAGE.trim() : '';
  const service = typeof env.CURB_LOCAL_GEOSUPPORT_SERVICE === 'string' ? env.CURB_LOCAL_GEOSUPPORT_SERVICE.trim() : '';
  const transport = (!image || !service)
    ? failingTransport('Local Function 3C image or service path is missing.')
    : async request => {
      let body;
      try {
        body = JSON.parse(request.body);
      } catch {
        throw new Error('Local Function 3C received an unreadable request.');
      }
      if (request.signal?.aborted) {
        throw namedError('AbortError', 'The local Function 3C request was cancelled.');
      }
      if (!geosupport || geosupport.stopped) geosupport = startGeosupport(image, service, env);
      const result = await geosupport.lookup(body, request.signal);
      return { status: result.status, text: async () => JSON.stringify(result.payload) };
    };
  return {
    transport,
    getIdToken: async () => 'local-geosupport',
  };
}

function demoLocalResolverBinding(binding, env = process.env) {
  if (!binding || binding.mode !== 'local') return null;
  if (!localFunction3cAllowed(env)) return null;
  if (typeof binding.transport !== 'function' || typeof binding.getIdToken !== 'function') return null;
  return Object.freeze({
    mode: 'local',
    logicalServiceUrl: LOCAL_LOGICAL_FUNCTION3C_URL,
    transport: binding.transport,
    getIdToken: binding.getIdToken,
  });
}

module.exports = {
  DEMO_AUTH_HOST,
  DEMO_FIRESTORE_HOST,
  DEMO_PROJECT_ID,
  LOCAL_LOGICAL_FUNCTION3C_URL,
  PRODUCTION_PROJECT_ID,
  localDemoSession,
  localModeRequested,
  localFunction3cAllowed,
  localStreetIntelligenceBinding,
  demoLocalResolverBinding,
  createLocalGeosupportTransport,
  stopLocalGeosupport,
};
