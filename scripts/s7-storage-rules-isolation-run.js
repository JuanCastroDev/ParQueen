'use strict';

const { execFileSync, spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

const { buildEmulatorEnv } = require('../functions/isolatedProcessEnv');

const root = path.resolve(__dirname, '..');
const project = 'demo-parkqueen-s7-fn-iso';
const firestorePort = 8282;
const storagePort = 9298;
const requiredFree = [firestorePort, storagePort, 4403];
const forbidden = new Set([8080, 9199, 9099, 5001, 4400, 4500]);
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
    fail('Refusing to start because listeners could not be identified');
  }
  const found = new Map();
  for (const line of output.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts[3] !== 'LISTENING') continue;
    const port = Number((parts[1] || '').split(':').pop());
    if (ports.includes(port)) found.set(port, Number(parts[4]));
  }
  return found;
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
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

async function main() {
  if (process.argv.length > 2) fail('This runner accepts no arguments');
  if (forbidden.has(firestorePort) || forbidden.has(storagePort)) {
    fail('Refusing to start because the selected ports are live-demo ports');
  }
  const demo = listenerPids([8080, 9099, 5001]);
  if (!demo.has(8080) || !demo.has(9099) || !demo.has(5001)) {
    fail('Refusing to start because the live demo listeners are not the expected set');
  }
  const protectedPids = new Set(demo.values());
  for (const port of requiredFree) {
    if (!(await portFree(port))) fail(`Isolated port ${port} is already in use`);
  }

  const emulatorEnv = buildEmulatorEnv(process.env);
  if (emulatorEnv.GCLOUD_PROJECT !== project || emulatorEnv.GOOGLE_CLOUD_PROJECT !== project) {
    fail('Refusing to start because the emulator environment is not the isolated project');
  }
  const emulator = spawn(node, [
    firebaseJs,
    'emulators:start',
    '--only', 'firestore,storage',
    '--project', project,
    '--config', 'firebase.s7-fn-iso.json',
  ], { cwd: root, env: emulatorEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  if (protectedPids.has(emulator.pid)) fail('Refusing to use a live demo process as the isolated emulator');

  let log = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('isolated storage emulators did not become ready')), 120000);
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

  const testEnv = buildEmulatorEnv(process.env);
  testEnv.S7_RULES_PROJECT_ID = project;
  testEnv.S7_FIRESTORE_EMULATOR_PORT = String(firestorePort);
  testEnv.S7_STORAGE_EMULATOR_PORT = String(storagePort);
  let tests;
  try {
    await ready;
    const started = listenerPids([firestorePort, storagePort, 8080, 9199]);
    if (started.get(8080) !== demo.get(8080) || started.has(9199)) {
      throw new Error('Isolated startup changed a live demo listener');
    }
    if (started.get(firestorePort) === demo.get(8080) || !started.has(firestorePort) || !started.has(storagePort)) {
      throw new Error('Isolated Firestore or Storage emulator did not bind its dedicated port');
    }
    tests = spawn(node, [
      path.join(root, 'node_modules/vitest/vitest.mjs'),
      'run',
      '--config', 'vite.storage-rules.config.ts',
    ], { cwd: root, env: testEnv, stdio: 'inherit' });
    const code = await new Promise((resolve) => tests.once('exit', resolve));
    process.exitCode = code == null ? 1 : code;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  } finally {
    if (tests && tests.exitCode == null) tests.kill();
    stopIsolatedEmulator(emulator, protectedPids);
  }
}

main();
