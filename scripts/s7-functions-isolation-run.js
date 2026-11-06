'use strict';

const { execFileSync, spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const { buildEmulatorEnv, buildTestEnv } = require('../functions/isolatedProcessEnv');

const root = path.resolve(__dirname, '..');
const project = 'demo-parkqueen-s7-fn-iso';
const ports = [8282, 9098, 9298, 5002, 4403, 4503, 9301, 9501];
const blockedSuites = new Set([
  'melvilleCanonicalPersistence.integration.test.js',
  'waitlist.integration.test.js',
  'generateEmailOTP.integration.test.js',
]);
const node = process.execPath;
const firebaseJs = path.join(
  'C:/Users/jayca/AppData/Local/Author Software/nvm/installs/v22.23.3/node_modules/firebase-tools/lib/bin/firebase.js',
);

function fail(message) {
  console.error(message);
  process.exit(1);
}

function listenerPids(ports) {
  let output = '';
  try {
    output = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
  } catch {
    fail('Refusing to start because the demo listeners could not be identified');
  }
  const found = new Set();
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts[3] !== 'LISTENING') continue;
    const port = Number((parts[1] || '').split(':').pop());
    if (ports.includes(port)) found.add(Number(parts[4]));
  }
  return found;
}

function stopIsolatedEmulator(emulator, protectedPids) {
  const pid = emulator && emulator.pid;
  if (!pid || protectedPids.has(pid)) {
    console.error(`Refusing to stop process ${pid || 'unknown'} because it is not the isolated emulator`);
    return;
  }
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // The emulator already exited.
  }
}
function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

const emulatorEnv = buildEmulatorEnv(process.env);
const testEnv = buildTestEnv(process.env, path.join(root, 'functions', 'isolatedNetworkGuard.js'));

async function main() {
  const protectedPids = listenerPids([8080, 9099, 5001]);
  const extra = process.argv.slice(2);
  for (const arg of extra) {
    const base = path.basename(arg);
    if (arg.startsWith('-') || !/^functions[\\/][A-Za-z0-9._-]+\.integration\.test\.js$/.test(arg) || blockedSuites.has(base)) {
      fail(`Refusing isolated launcher argument ${arg}`);
    }
  }
  for (const port of ports) {
    if (!(await portFree(port))) fail(`Isolated port ${port} is already in use`);
  }
  const emulator = spawn(node, [
    firebaseJs,
    'emulators:start',
    '--only', 'auth,firestore,storage,functions',
    '--project', project,
    '--config', 'firebase.s7-fn-iso.json',
  ], { cwd: root, env: emulatorEnv, stdio: ['ignore', 'pipe', 'pipe'] });

  let log = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('isolated emulators did not become ready')), 120000);
    const onData = (chunk) => {
      log += chunk.toString();
      if (log.includes('All emulators ready')) {
        clearTimeout(timer);
        resolve();
      }
      if (log.includes('Error:') && log.includes('Could not start')) {
        clearTimeout(timer);
        reject(new Error(log.slice(-2000)));
      }
    };
    emulator.stdout.on('data', onData);
    emulator.stderr.on('data', onData);
    emulator.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`emulator exited ${code} before ready\n${log.slice(-2000)}`));
    });
  });

  let tests;
  try {
    await ready;
    tests = spawn(node, [
      path.join(root, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--config', 'vite.functions.isolated.config.ts',
      ...extra,
    ], { cwd: root, env: testEnv, stdio: 'inherit' });
    const code = await new Promise((resolve) => tests.once('exit', resolve));
    process.exitCode = code == null ? 1 : code;
  } catch (error) {
    console.error(error.message || error);
    process.exitCode = 1;
  } finally {
    if (tests && tests.exitCode == null) tests.kill();
    stopIsolatedEmulator(emulator, protectedPids);
  }
}

main();
