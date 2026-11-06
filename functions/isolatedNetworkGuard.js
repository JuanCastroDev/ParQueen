'use strict';

// Application patch for the Node test process. It does not confine the
// Firebase emulator JVM, native TCP bindings, or UDP.
const cp = require('node:child_process');
const dns = require('node:dns');
const fs = require('node:fs');
const http = require('node:http');
const http2 = require('node:http2');
const https = require('node:https');
const net = require('node:net');
const path = require('node:path');
const tls = require('node:tls');

const GUARD_FILE = __filename;
const APPROVED_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
const APPROVED_PORTS = new Set([8282, 9098, 9298, 5002, 4403, 4503, 9301, 9501]);
const FORBIDDEN_PORTS = new Set([8080, 9099, 9199, 5001, 4400, 4500]);

const state = {
  installed: false,
  originalConnectCalls: 0,
  originalDnsCalls: 0,
};

function refusal(message) {
  const error = new Error(message);
  error.code = 'ERR_ISOLATED_NETWORK';
  throw error;
}

function normalizeHost(host) {
  if (typeof host !== 'string' || host.trim() === '') return '';
  let value = host.trim().toLowerCase().replace(/\.$/, '');
  if (value.startsWith('[') && value.endsWith(']')) value = value.slice(1, -1);
  if (value.startsWith('::ffff:')) value = value.slice('::ffff:'.length);
  return value;
}

function assertDestination(host, port) {
  const normalized = normalizeHost(host || '');
  const numeric = Number(port);
  if (!APPROVED_HOSTS.has(normalized)) {
    refusal(`Refusing non-loopback destination ${host || '(missing)'}`);
  }
  if (!Number.isInteger(numeric) || FORBIDDEN_PORTS.has(numeric) || !APPROVED_PORTS.has(numeric)) {
    refusal(`Refusing destination port ${port}`);
  }
}

function endpointFromConnectArgs(args) {
  const source = Array.isArray(args[0]) ? args[0] : args;
  const first = source[0];
  if (typeof first === 'string' && Number.isNaN(Number(first))) return { ipc: true };
  if (typeof first === 'number' || (typeof first === 'string' && /^\d+$/.test(first))) {
    return { host: typeof source[1] === 'string' ? source[1] : 'localhost', port: Number(first) };
  }
  if (first && typeof first === 'object') {
    if (first.path && first.port == null && first.host == null && first.hostname == null) return { ipc: true };
    return { host: first.host || first.hostname || 'localhost', port: first.port };
  }
  refusal('Refusing socket connect without a destination');
}

function endpointFromHttpArgs(args) {
  const first = args[0];
  if (typeof first === 'string' || first instanceof URL) {
    const url = new URL(first);
    const fallback = url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80;
    return { host: url.hostname, port: url.port || fallback };
  }
  if (first && typeof first === 'object') {
    const protocol = String(first.protocol || 'http:');
    const fallback = protocol === 'https:' || protocol === 'wss:' ? 443 : 80;
    let host = first.hostname || first.host || 'localhost';
    let port = first.port;
    if (typeof host === 'string') {
      const trimmed = host.trim();
      const v4 = /^(.*):(\d+)$/.exec(trimmed);
      if (v4 && trimmed.indexOf(':') === trimmed.lastIndexOf(':')) {
        host = v4[1];
        if (port == null || port === '') port = v4[2];
      }
    }
    return { host, port: port == null || port === '' ? fallback : port };
  }
  refusal('Refusing HTTP request without a destination');
}

function lock(object, name, value) {
  const current = Object.getOwnPropertyDescriptor(object, name);
  if (current && current.configurable === false && current.value === value) return;
  Object.defineProperty(object, name, {
    configurable: false,
    enumerable: current ? current.enumerable : true,
    writable: false,
    value,
  });
}

function guardCall(original, endpoint) {
  if (!endpoint.ipc) assertDestination(endpoint.host, endpoint.port);
  state.originalConnectCalls += 1;
  return original;
}

function canonicalPath(file) {
  if (typeof file !== 'string' || file.trim() === '' || file.includes('\0')) return '';
  try {
    return fs.realpathSync.native(path.resolve(file));
  } catch {
    return '';
  }
}

function samePath(left, right) {
  if (!left || !right) return false;
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

const TRUSTED_NODE = canonicalPath(process.execPath);

function installedEsbuild() {
  const packages = {
    'win32 x64': '@esbuild/win32-x64',
    'win32 arm64': '@esbuild/win32-arm64',
    'win32 ia32': '@esbuild/win32-ia32',
  };
  const pkg = packages[`${process.platform} ${process.arch}`];
  if (!pkg) return '';
  try {
    return canonicalPath(require.resolve(`${pkg}/esbuild.exe`));
  } catch {
    return '';
  }
}

const TRUSTED_ESBUILD = installedEsbuild();

function reviewedPreload(file) {
  const real = canonicalPath(file);
  if (!real) return false;
  if (samePath(real, canonicalPath(GUARD_FILE))) return true;
  let warning = '';
  try {
    warning = canonicalPath(path.join(path.dirname(require.resolve('vitest/package.json')), 'suppress-warnings.cjs'));
  } catch {
    return false;
  }
  if (!samePath(real, warning)) return false;
  const source = fs.readFileSync(real, 'utf8');
  return !/\brequire\s*\(|\bimport\s|\bnode:net\b|\bnode:http\b|\bchild_process\b|\bworker_threads\b/.test(source);
}

function isAllowedWorkerFlag(flag) {
  if (flag === '--experimental-import-meta-resolve' || flag === '--experimental-vm-modules') return 'flag';
  if (flag.startsWith('--cpu-prof') || flag.startsWith('--heap-prof') || flag.startsWith('--diagnostic-dir')) return 'flag';
  if (flag === '--conditions' || flag.startsWith('--conditions=')) return 'condition';
  return '';
}

function reviewExecArgv(execArgv) {
  const input = Array.isArray(execArgv) ? execArgv : [];
  const kept = [];
  const preloads = [];
  for (let index = 0; index < input.length; index += 1) {
    const flag = input[index];
    if (typeof flag !== 'string' || flag.includes('\0')) refusal('Refusing worker option');
    const preload = /^(?:--require|-r|--import|--loader|--experimental-loader)(?:=(.*))?$/.exec(flag);
    if (preload) {
      const kind = flag.startsWith('--import') || flag.startsWith('--loader') || flag.startsWith('--experimental-loader');
      const value = preload[1] != null ? preload[1] : input[index += 1];
      if (kind || !reviewedPreload(value)) refusal('Refusing worker preload');
      preloads.push(value);
      continue;
    }
    const allowed = isAllowedWorkerFlag(flag);
    if (!allowed) refusal(`Refusing worker option ${flag}`);
    if (allowed === 'condition' && flag === '--conditions') {
      const value = input[index += 1];
      if (typeof value !== 'string' || !/^[A-Za-z0-9_|.-]+$/.test(value)) refusal('Refusing worker condition');
      kept.push(flag, value);
      continue;
    }
    if (allowed === 'condition' && !/^--conditions=[A-Za-z0-9_|.-]+$/.test(flag)) refusal('Refusing worker condition');
    kept.push(flag);
  }
  const argv = ['--require', GUARD_FILE];
  for (const preload of preloads) {
    if (!samePath(canonicalPath(preload), canonicalPath(GUARD_FILE))) argv.push('--require', preload);
  }
  return argv.concat(kept);
}

function rejectNodePreloads(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (typeof flag !== 'string') continue;
    const preload = /^(?:--require|-r|--import|--loader|--experimental-loader)(?:=(.*))?$/.exec(flag);
    if (!preload) continue;
    if (flag.startsWith('--import') || flag.startsWith('--loader') || flag.startsWith('--experimental-loader')) {
      refusal('Refusing node preload');
    }
    const value = preload[1] != null ? preload[1] : argv[index + 1];
    if (!reviewedPreload(value)) refusal('Refusing node preload');
  }
}

function trustedCommand(command) {
  if (typeof command !== 'string' || !path.isAbsolute(command)) return '';
  const real = canonicalPath(command);
  if (samePath(real, TRUSTED_NODE)) return 'node';
  if (samePath(real, TRUSTED_ESBUILD)) return 'esbuild';
  return '';
}

function forceGuardEnv(env) {
  const next = { ...(env || process.env) };
  next.NODE_OPTIONS = `--require ${GUARD_FILE}`;
  return next;
}

function normalizeSpawn(args, options) {
  let argv = [];
  let opts = {};
  let callback;
  if (typeof args === 'function') callback = args;
  else if (Array.isArray(args)) {
    argv = args;
    if (typeof options === 'function') callback = options;
    else if (options && typeof options === 'object') opts = options;
  } else if (args && typeof args === 'object') {
    opts = args;
    if (typeof options === 'function') callback = options;
  } else if (typeof options === 'function') callback = options;
  else if (options && typeof options === 'object') opts = options;
  return { argv, opts, callback };
}

function install() {
  if (state.installed) return state;

  const originalSocketConnect = net.Socket.prototype.connect;
  lock(net.Socket.prototype, 'connect', function guardedSocketConnect(...args) {
    const endpoint = endpointFromConnectArgs(args);
    const original = guardCall(originalSocketConnect, endpoint);
    return original.apply(this, args);
  });

  const originalTlsConnect = tls.connect;
  lock(tls, 'connect', function guardedTlsConnect(...args) {
    const first = args[0];
    if (typeof first === 'number') assertDestination(typeof args[1] === 'string' ? args[1] : 'localhost', first);
    else if (first && typeof first === 'object') assertDestination(first.host || first.hostname || first.servername || 'localhost', first.port);
    else refusal('Refusing TLS connect without a destination');
    state.originalConnectCalls += 1;
    return originalTlsConnect.apply(this, args);
  });

  for (const [mod, name] of [[http, 'request'], [http, 'get'], [https, 'request'], [https, 'get']]) {
    const original = mod[name];
    lock(mod, name, function guardedHttp(...args) {
      const endpoint = endpointFromHttpArgs(args);
      assertDestination(endpoint.host, endpoint.port);
      return original.apply(this, args);
    });
  }

  const originalHttp2Connect = http2.connect;
  lock(http2, 'connect', function guardedHttp2(authority, options, listener) {
    const url = new URL(authority);
    const fallback = url.protocol === 'https:' ? 443 : 80;
    assertDestination(url.hostname, url.port || fallback);
    return originalHttp2Connect.call(this, authority, options, listener);
  });

  const originalFetch = globalThis.fetch;
  if (typeof originalFetch === 'function') {
    lock(globalThis, 'fetch', function guardedFetch(input, init) {
      const raw = typeof input === 'string' || input instanceof URL ? input : input && input.url;
      const url = new URL(raw);
      const fallback = url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80;
      assertDestination(url.hostname, url.port || fallback);
      return originalFetch.call(this, input, init);
    });
  }

  function guardDns(target, names) {
    for (const name of names) {
      if (typeof target[name] !== 'function') continue;
      const original = target[name];
      lock(target, name, function guardedDnsMethod(hostname, ...rest) {
        if (!APPROVED_HOSTS.has(normalizeHost(String(hostname || '')))) {
          refusal(`Refusing DNS lookup for ${hostname}`);
        }
        state.originalDnsCalls += 1;
        return original.call(this, hostname, ...rest);
      });
    }
  }
  guardDns(dns, ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveTxt']);
  guardDns(dns.promises, ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCname', 'resolveMx', 'resolveTxt']);

  const originalNetConnect = net.connect;
  lock(net, 'connect', function guardedNetConnect(...args) {
    const endpoint = endpointFromConnectArgs(args);
    if (!endpoint.ipc) assertDestination(endpoint.host, endpoint.port);
    return originalNetConnect.apply(this, args);
  });

  function wrapSpawn(original) {
    return function guardedSpawn(command, args, options) {
      const split = normalizeSpawn(args, options);
      const localShell = split.opts.shell === true && typeof command === 'string' && command.trim() === 'net use' && split.argv.length === 0;
      const trusted = localShell ? '' : trustedCommand(command);
      if (!localShell && !trusted) refusal(`Refusing child process ${command}`);
      if (!localShell && split.opts.shell) refusal('Refusing shell execution');
      const opts = { ...split.opts };
      if (trusted === 'node') {
        rejectNodePreloads(split.argv);
        opts.env = forceGuardEnv(split.opts.env);
      }
      if (split.callback) return original.call(this, command, split.argv, opts, split.callback);
      return original.call(this, command, split.argv, opts);
    };
  }
  lock(cp, 'spawn', wrapSpawn(cp.spawn));
  lock(cp, 'spawnSync', wrapSpawn(cp.spawnSync));
  lock(cp, 'execFile', wrapSpawn(cp.execFile));
  lock(cp, 'execFileSync', wrapSpawn(cp.execFileSync));
  const originalExec = cp.exec;
  const originalExecSync = cp.execSync;
  function shellAllowed(command) {
    return typeof command === 'string' && command.trim() === 'net use';
  }
  lock(cp, 'exec', function guardedExec(command, options, callback) {
    if (!shellAllowed(command)) refusal('Refusing shell execution');
    if (typeof options === 'function') return originalExec.call(this, command, options);
    return originalExec.call(this, command, options, callback);
  });
  lock(cp, 'execSync', function guardedExecSync(command, options) {
    if (!shellAllowed(command)) refusal('Refusing shell execution');
    return originalExecSync.call(this, command, options);
  });
  const originalFork = cp.fork;
  lock(cp, 'fork', function guardedFork(modulePath, args, options) {
    const split = normalizeSpawn(args, options);
    if (split.opts.execPath && !samePath(canonicalPath(split.opts.execPath), TRUSTED_NODE)) {
      refusal('Refusing fork executable');
    }
    const opts = {
      ...split.opts,
      env: forceGuardEnv(split.opts.env),
      execArgv: reviewExecArgv(split.opts.execArgv),
      execPath: process.execPath,
    };
    return originalFork.call(this, modulePath, split.argv, opts);
  });

  const workerThreads = require('node:worker_threads');
  const OriginalWorker = workerThreads.Worker;
  class GuardedWorker extends OriginalWorker {
    constructor(filename, options = {}) {
      const execArgv = reviewExecArgv(options.execArgv);
      super(filename, { ...options, execArgv });
    }
  }
  lock(workerThreads, 'Worker', GuardedWorker);

  state.installed = true;
  return state;
}

install();

module.exports = {
  APPROVED_HOSTS,
  APPROVED_PORTS,
  FORBIDDEN_PORTS,
  GUARD_FILE,
  TRUSTED_NODE,
  TRUSTED_ESBUILD,
  install,
  assertDestination,
  originalConnectCalls: () => state.originalConnectCalls,
  originalDnsCalls: () => state.originalDnsCalls,
};
