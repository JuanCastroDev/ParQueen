'use strict';

const { existsSync } = require('node:fs');
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

let geosupport = null;

function startGeosupport(image, service) {
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
  const child = require('node:child_process').spawn(dockerBin(), [
    'run', '-i', '--rm', '-v', `${service}:/app`, '-w', '/app', image,
    'python', '-u', '-c', script,
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffer = '';
  let stderr = '';
  const waiters = [];
  const session = { stopped: false, lookup: null };
  const finish = error => {
    if (session.stopped) return;
    session.stopped = true;
    if (geosupport === session) geosupport = null;
    const pending = waiters.splice(0);
    for (const waiter of pending) waiter.reject(error);
    killTree(child);
  };
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith('PARQUEEN_GEO ')) {
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(JSON.parse(line.slice('PARQUEEN_GEO '.length)));
      }
      newline = buffer.indexOf('\n');
    }
  });
  child.stderr.on('data', chunk => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2000);
  });
  child.on('exit', code => finish(new Error(`Function 3C exited ${code}: ${stderr.slice(-200)}`)));
  child.on('error', error => finish(error));
  let chain = Promise.resolve();
  session.lookup = (tuple, signal) => {
    const run = chain.then(() => new Promise((resolve, reject) => {
      if (session.stopped || signal?.aborted) {
        const error = namedError('AbortError', 'The local Function 3C request was cancelled.');
        if (!session.stopped) finish(error);
        reject(error);
        return;
      }
      let settled = false;
      const settle = (report, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        report(value);
      };
      const timer = setTimeout(() => {
        finish(namedError('TimeoutError', 'Function 3C timed out'));
      }, LOCAL_LOOKUP_TIMEOUT_MS);
      const onAbort = () => {
        finish(namedError('AbortError', 'The local Function 3C request was cancelled.'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      waiters.push({
        resolve: value => settle(resolve, value),
        reject: error => settle(reject, error),
      });
      try {
        child.stdin.write(`${JSON.stringify(tuple)}\n`);
      } catch (error) {
        finish(error);
      }
    }));
    chain = run.then(() => {}, () => {});
    return run;
  };
  session.stop = () => finish(namedError('AbortError', 'The local Function 3C process was stopped.'));
  return session;
}

function stopLocalGeosupport() {
  geosupport?.stop?.();
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
      if (!geosupport || geosupport.stopped) geosupport = startGeosupport(image, service);
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
