'use strict';

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

async function readContainerIdSoon(cidFile) {
  const started = Date.now();
  let id = readContainerId(cidFile);
  while (!id && Date.now() - started < 1000) {
    await new Promise(resolve => { setTimeout(resolve, 50); });
    id = readContainerId(cidFile);
  }
  return id;
}

async function releaseOwnedContainer(bin, child, cidFile) {
  killTree(child);
  const id = await readContainerIdSoon(cidFile);
  if (!id) {
    rmSync(join(cidFile, '..'), { recursive: true, force: true });
    return { ok: true, id: null };
  }
  await runDocker(bin, ['rm', '-f', id]);
  const inspect = await runDocker(bin, ['inspect', '-f', '{{.State.Running}}', id]);
  const running = inspect.status === 0 && inspect.stdout.trim() === 'true';
  rmSync(join(cidFile, '..'), { recursive: true, force: true });
  return { ok: !running, id };
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
  const child = require('node:child_process').spawn(bin, [
    'run', '-i', '--rm', '--cidfile', cidFile,
    '-v', `${service}:/app`, '-w', '/app', image,
    'python', '-u', '-c', script,
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
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
    session.failure = releaseOwnedContainer(bin, child, cidFile).then(result => {
      if (result.ok) return error;
      const orphan = namedError('Error', `${error.message} Container ${result.id} remained running.`);
      orphan.containerId = result.id;
      orphan.cause = error;
      return orphan;
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
  child.on('exit', code => session.finish(new Error(`Function 3C exited ${code}: ${stderr.slice(-200)}`)));
  child.on('error', error => session.finish(error));
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
