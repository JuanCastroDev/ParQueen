'use strict';

const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const DEMO_PROJECT_ID = 'demo-parkqueen-functions-test';
const PRODUCTION_PROJECT_ID = 'parkqueen-46475363-ccf36';

function localFunction3cAllowed(env) {
  return env.FUNCTIONS_EMULATOR === 'true'
    && env.CURB_LOCAL_FUNCTION3C === 'local'
    && env.GCLOUD_PROJECT === DEMO_PROJECT_ID
    && env.GCLOUD_PROJECT !== PRODUCTION_PROJECT_ID
    && env.FIRESTORE_EMULATOR_HOST === '127.0.0.1:8080'
    && env.FIREBASE_AUTH_EMULATOR_HOST === '127.0.0.1:9099'
    && env.K_REVISION === '1';
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
  const child = spawn(dockerBin(), [
    'run', '-i', '--rm', '-v', `${service}:/app`, '-w', '/app', image,
    'python', '-u', '-c', script,
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffer = '';
  let stderr = '';
  const waiters = [];
  const failWaiters = error => {
    while (waiters.length) waiters.shift().reject(error);
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
  child.on('exit', code => failWaiters(new Error(`Function 3C exited ${code}: ${stderr}`)));
  child.on('error', error => failWaiters(error));
  let chain = Promise.resolve();
  const lookup = tuple => {
    const run = chain.then(() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Function 3C timed out: ${stderr}`)), 20000);
      waiters.push({
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(`${JSON.stringify(tuple)}\n`);
    }));
    chain = run.then(() => {}, () => {});
    return run;
  };
  return { lookup };
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
      if (!geosupport) geosupport = startGeosupport(image, service);
      const result = await geosupport.lookup(body);
      return { status: result.status, text: async () => JSON.stringify(result.payload) };
    };
  return {
    transport,
    getIdToken: async () => 'local-geosupport',
  };
}

module.exports = {
  localFunction3cAllowed,
  createLocalGeosupportTransport,
};
