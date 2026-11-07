'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const guard = require('./isolatedNetworkGuard');
const { spawnSync, execSync, fork } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const dns = require('node:dns');
const http = require('node:http');
const http2 = require('node:http2');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');

function refused(fn) {
  assert.throws(fn, (error) => error && error.code === 'ERR_ISOLATED_NETWORK');
}

test('non-loopback TCP is rejected before a socket connect', () => {
  const before = guard.originalConnectCalls();
  refused(() => net.connect(80, '203.0.113.10'));
  assert.equal(guard.originalConnectCalls(), before);
});

test('external HTTPS is rejected before DNS or a handshake', () => {
  const dnsBefore = guard.originalDnsCalls();
  const connectBefore = guard.originalConnectCalls();
  refused(() => https.get('https://api.sendgrid.com/v3/mail/send'));
  refused(() => https.get('https://generativelanguage.googleapis.com'));
  refused(() => https.get('https://vision.googleapis.com'));
  refused(() => https.get('https://overpass-api.de/api/interpreter'));
  assert.equal(guard.originalDnsCalls(), dnsBefore);
  assert.equal(guard.originalConnectCalls(), connectBefore);
});

test('fetch and HTTP reject external hosts before a connection', () => {
  const before = guard.originalConnectCalls();
  refused(() => http.get('http://example.com'));
  refused(() => globalThis.fetch('https://example.com'));
  assert.equal(guard.originalConnectCalls(), before);
});

test('raw TLS and HTTP/2 reject a non-loopback host', () => {
  const before = guard.originalConnectCalls();
  refused(() => tls.connect({ host: 'example.com', port: 443 }));
  refused(() => http2.connect('https://example.com'));
  assert.equal(guard.originalConnectCalls(), before);
});

test('DNS lookup of an external name does not call the resolver', () => {
  const before = guard.originalDnsCalls();
  refused(() => dns.lookup('api.sendgrid.com', () => {}));
  refused(() => dns.promises.resolve4('overpass-api.de'));
  assert.equal(guard.originalDnsCalls(), before);
});

test('live demo ports are rejected on loopback', () => {
  const before = guard.originalConnectCalls();
  for (const port of guard.FORBIDDEN_PORTS) {
    refused(() => net.connect(port, '127.0.0.1'));
    refused(() => net.connect(port, '::1'));
  }
  assert.equal(guard.originalConnectCalls(), before);
});

test('an approved emulator port accepts a local IPv4 and IPv6 connection', async () => {
  const ipv4 = await listenAndConnect('127.0.0.1', 8282);
  const ipv6 = await listenAndConnect('::1', 9098);
  assert.equal(ipv4, 'ok');
  assert.equal(ipv6, 'ok');
});

test('the socket connect method cannot be replaced', () => {
  assert.throws(() => {
    Object.defineProperty(net.Socket.prototype, 'connect', { value() {} });
  });
});

test('a node child inherits the guard even when NODE_OPTIONS is cleared', () => {
  const script = "require('node:net').connect(443, '203.0.113.10')";
  const result = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 5000,
    env: { ...process.env, NODE_OPTIONS: '' },
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}`, /ERR_ISOLATED_NETWORK|Refusing non-loopback/);
  assert.doesNotMatch(`${result.stderr}`, /ENOTFOUND|ECONNREFUSED|ETIMEDOUT/);
});

test('shell execution is rejected before the shell starts', () => {
  refused(() => execSync('hostname'));
});

test('a non-node child process is rejected', () => {
  refused(() => spawnSync('curl.exe', ['https://example.com']));
});

test('a shelled external command is rejected', () => {
  refused(() => spawnSync('curl.exe https://example.com', { shell: true }));
});

test('a PATH node name and a different executable are rejected', () => {
  refused(() => spawnSync('node', ['-e', 'process.exit(0)']));
  refused(() => spawnSync('node.exe', ['-e', 'process.exit(0)']));
  refused(() => spawnSync('esbuild.exe', ['--version']));
  refused(() => spawnSync(process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe', ['/c', 'hostname']));
});

test('a trusted node cannot be launched through a shell or an unreviewed preload', () => {
  refused(() => spawnSync(process.execPath, ['-e', 'process.exit(0)'], { shell: true }));
  refused(() => spawnSync(process.execPath, ['--import', 'data:text/javascript,1']));
  refused(() => spawnSync(process.execPath, ['--experimental-loader', 'loader.js']));
  refused(() => spawnSync(process.execPath, ['-r', 'C:\\evil-preload.js']));
});

test('shell arguments cannot extend the net use exception', () => {
  refused(() => spawnSync('net use & curl.exe', { shell: true }));
  refused(() => spawnSync('net use', ['&', 'curl.exe'], { shell: true }));
  refused(() => execSync('net use & hostname'));
});

test('the installed esbuild executable is the only accepted build binary', () => {
  assert.equal(typeof guard.TRUSTED_ESBUILD, 'string');
  assert.notEqual(guard.TRUSTED_ESBUILD, '');
  const result = spawnSync(guard.TRUSTED_ESBUILD, ['--version'], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^\d+\.\d+\.\d+/);
});

test('an unreviewed worker preload is rejected before the thread starts', () => {
  refused(() => new Worker('process.exit(0)', { eval: true, execArgv: ['--require', 'C:\\evil-preload.js'] }));
  refused(() => new Worker('process.exit(0)', { eval: true, execArgv: ['--import', 'data:text/javascript,1'] }));
  refused(() => new Worker('process.exit(0)', { eval: true, execArgv: ['--experimental-loader', 'loader.js'] }));
  refused(() => new Worker('process.exit(0)', { eval: true, execArgv: ['-r', 'C:\\evil-preload.js'] }));
});

test('a worker keeps reviewed runtime flags after the guard', async () => {
  const worker = new Worker(
    "const { parentPort } = require('node:worker_threads'); parentPort.postMessage(process.execArgv);",
    { eval: true, execArgv: ['--experimental-import-meta-resolve', '--conditions', 'node'] },
  );
  const argv = await new Promise((resolve, reject) => {
    worker.once('message', resolve);
    worker.once('error', reject);
  });
  await worker.terminate();
  assert.deepEqual(argv.slice(0, 2), ['--require', guard.GUARD_FILE]);
  assert.equal(argv.includes('--import'), false);
  assert.equal(argv.includes('--experimental-import-meta-resolve'), true);
  assert.deepEqual(argv.slice(argv.indexOf('--conditions'), argv.indexOf('--conditions') + 2), ['--conditions', 'node']);
});

test('a worker rejects an external connection', async () => {
  const worker = new Worker("require('node:net').connect(443, '203.0.113.10')", { eval: true });
  const error = await new Promise((resolve) => {
    worker.once('error', resolve);
  });
  assert.equal(error.code, 'ERR_ISOLATED_NETWORK');
});

test('a fork rejects an unreviewed preload and a substitute executable', () => {
  refused(() => fork(guard.GUARD_FILE, [], { execArgv: ['--import', 'data:text/javascript,1'] }));
  refused(() => fork(guard.GUARD_FILE, [], { execPath: process.env.ComSpec || 'C:\\Windows\\System32\\cmd.exe' }));
});

function listenAndConnect(host, port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => {
      socket.end('ok');
    });
    server.once('error', reject);
    server.listen(port, host, () => {
      try {
        const socket = net.connect(port, host, () => {
          socket.once('data', (chunk) => {
            socket.end();
            server.close(() => resolve(chunk.toString()));
          });
        });
        socket.once('error', (error) => {
          server.close(() => reject(error));
        });
      } catch (error) {
        server.close(() => reject(error));
      }
    });
  });
}
