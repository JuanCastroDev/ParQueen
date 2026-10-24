import { spawn, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Regression tests for the Chrome harness teardown in handoffReachability.regression.test.ts.
// They live in their own file so that file keeps exactly its five reachability tests.
const harnessPath = path.join(__dirname, 'handoffReachability.regression.test.ts');
const harnessSource = readFileSync(harnessPath, 'utf8');
const root = path.resolve(__dirname, '../..');

function limit(name: string) {
  const match = harnessSource.match(new RegExp(`^const ${name} = (\\d+);$`, 'm'));
  if (!match) throw new Error(`${name} is not declared as a numeric constant in the harness`);
  return Number(match[1]);
}

function which(bin: string) {
  try {
    return execFileSync('which', [bin], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

// The fault-path test below runs the real harness behind a fake Chrome that
// holds back Browser.close. It is fault injection, so it is opt-in only:
// set HANDOFF_FAULT_TESTS=1 to run it. Normal CI does not set it, and then
// the test reports as skipped while the static check still runs.
const faultTestsEnabled = process.env.HANDOFF_FAULT_TESTS === '1';

// The harness picks the first of these names on PATH, so the shim takes the first name.
const realChrome = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].map(which).find(Boolean);

// Fault shim: launches the real Chrome as its own child (same process group), puts a TCP proxy
// in front of its DevTools port and silently holds back every Browser.close sent on the browser
// socket. Chrome then never answers and never exits by itself, which is the R5 hang.
const shimSource = `
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const args = process.argv.slice(2);
// The harness keeps Chrome's stderr to itself, so the shim reports to its own log file.
const log = (m) => fs.appendFileSync(process.env.HANDOFF_FAULT_LOG, '[fault-shim] ' + m + '\\n');
const real = process.env.HANDOFF_FAULT_REAL_CHROME;
if (args.includes('--version')) {
  const v = spawn(real, args, { stdio: 'inherit' });
  v.on('exit', (code) => process.exit(code ?? 1));
  return;
}
const dirArg = args.find((a) => a.startsWith('--user-data-dir='));
const profile = dirArg.slice('--user-data-dir='.length);
const realProfile = profile + '-fault-' + process.env.HANDOFF_FAULT_TAG;
fs.mkdirSync(profile, { recursive: true });
const chrome = spawn(real, args.map((a) => (a === dirArg ? '--user-data-dir=' + realProfile : a)), { stdio: ['ignore', 'ignore', 'inherit'] });
chrome.on('exit', (code, signal) => process.exit(code ?? 1));
function filterFrames(onFrame) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      const masked = (buf[1] & 0x80) !== 0;
      const total = off + (masked ? 4 : 0) + len;
      if (buf.length < total) return;
      const frame = buf.subarray(0, total);
      const payload = Buffer.from(frame.subarray(total - len));
      if (masked) { const mask = frame.subarray(off, off + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4]; }
      onFrame(frame, payload.toString('utf8'));
      buf = buf.subarray(total);
    }
  };
}
function proxy(realPort) {
  return net.createServer((client) => {
    const upstream = net.connect(realPort, '127.0.0.1');
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    upstream.pipe(client);
    let head = Buffer.alloc(0);
    let onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\\r\\n\\r\\n');
      if (end < 0) return;
      const request = head.subarray(0, end + 4);
      const rest = head.subarray(end + 4);
      upstream.write(request);
      if (/^GET \\/devtools\\/browser\\//.test(request.toString('latin1'))) {
        onData = filterFrames((frame, text) => {
          if (/"method":"Browser\\.close"/.test(text)) { log('held back Browser.close pid=' + chrome.pid); return; }
          upstream.write(frame);
        });
      } else {
        onData = (c) => upstream.write(c);
      }
      if (rest.length) onData(rest);
    };
    client.on('data', (chunk) => onData(chunk));
    client.on('end', () => upstream.end());
  });
}
const startedAt = Date.now();
const poll = setInterval(() => {
  let text;
  try { text = fs.readFileSync(path.join(realProfile, 'DevToolsActivePort'), 'utf8'); } catch { return; }
  const [portLine, pathLine] = text.trim().split(/\\r?\\n/);
  if (!pathLine) return;
  clearInterval(poll);
  const server = proxy(Number(portLine));
  server.listen(0, '127.0.0.1', () => {
    const tmp = path.join(profile, 'DevToolsActivePort.tmp');
    fs.writeFileSync(tmp, server.address().port + '\\n' + pathLine + '\\n');
    fs.renameSync(tmp, path.join(profile, 'DevToolsActivePort'));
    log('proxying DevTools ' + server.address().port + ' -> ' + portLine + ' after ' + (Date.now() - startedAt) + 'ms');
  });
}, 50);
`;

function processesTagged(tag: string) {
  const found: string[] = [];
  for (const pid of readdirSync('/proc').filter((name) => /^\d+$/.test(name))) {
    try {
      if (readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0').includes(`HANDOFF_FAULT_TAG=${tag}`)) {
        found.push(`${pid} ${readFileSync(`/proc/${pid}/cmdline`, 'latin1').replace(/\0/g, ' ').slice(0, 120)}`);
      }
    } catch {
      // The process exited while it was being read, or it is not ours.
    }
  }
  return found;
}

describe('handoff harness teardown bounds', () => {
  it('bounds Browser.close and every suite teardown with explicit limits that fit inside the hook timeout', () => {
    const close = limit('BROWSER_CLOSE_TIMEOUT_MS');
    const exitWait = limit('CHROME_EXIT_WAIT_MS');
    const server = limit('SERVER_CLOSE_TIMEOUT_MS');
    const profile = limit('PROFILE_REMOVE_TIMEOUT_MS');
    const teardown = limit('SUITE_TEARDOWN_TIMEOUT_MS');
    expect(close + 3 * exitWait + server + profile).toBeLessThan(teardown);
    // Each suite's afterAll carries the explicit limit instead of Vitest's 10s default.
    expect(harnessSource.match(/^ {2}\}, SUITE_TEARDOWN_TIMEOUT_MS\);$/gm)).toHaveLength(2);
    // Browser.close is only ever sent through the bounded helper, and the reap runs in a finally.
    expect(harnessSource.match(/'Browser\.close'/g)).toHaveLength(1);
    expect(harnessSource).toMatch(/settleWithin\(Promise\.race\(\[browser\('Browser\.close'\), exited\]\), BROWSER_CLOSE_TIMEOUT_MS/);
    expect(harnessSource.match(/\} finally \{\n(?: +\/\/.*\n)* +reapSession\(session, 'afterAll'\);/g)).toHaveLength(2);
    // Synchronous removal retries would block the event loop and with it the hook timer.
    expect(harnessSource).not.toMatch(/rmSync\(/);
    // The suites' own test and boot timeouts are unchanged.
    expect(limit('CHROME_DEVTOOLS_DEADLINE_MS')).toBe(30000);
    expect(limit('BROWSER_BOOT_TIMEOUT_MS')).toBe(120000);
  });

  it.skipIf(!faultTestsEnabled || !realChrome)('SIGKILLs and reaps a Chrome that never answers Browser.close within the teardown limit', async () => {
    const tag = `${process.pid}-${Date.now()}`;
    const work = mkdtempSync(path.join(tmpdir(), 'handoff-teardown-fault-'));
    try {
      const bin = path.join(work, 'bin');
      mkdirSync(bin);
      const shim = path.join(bin, 'google-chrome');
      writeFileSync(shim, `#!${process.execPath}\n${shimSource}`);
      chmodSync(shim, 0o755);
      const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` };
      for (const key of Object.keys(env)) if (key.startsWith('VITEST') || key === 'TEST' || key === 'NODE_ENV') delete env[key];
      env.HANDOFF_FAULT_TAG = tag;
      env.HANDOFF_FAULT_REAL_CHROME = realChrome!;
      env.HANDOFF_FAULT_LOG = path.join(work, 'fault.log');
      writeFileSync(env.HANDOFF_FAULT_LOG, '');

      const startedAt = Date.now();
      const child = spawn(process.execPath, [path.join(root, 'node_modules/vitest/vitest.mjs'), 'run', path.relative(root, harnessPath)], {
        cwd: root, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let output = '';
      child.stdout!.on('data', (chunk) => { output += String(chunk); });
      child.stderr!.on('data', (chunk) => { output += String(chunk); });
      const code = await new Promise<number | null>((resolve) => {
        const timer = setTimeout(() => {
          try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* already gone */ }
        }, 200000);
        child.once('exit', (exitCode) => { clearTimeout(timer); resolve(exitCode); });
      });
      const plain = output.replace(/\x1b\[[0-9;]*m/g, '');
      const faultLog = readFileSync(env.HANDOFF_FAULT_LOG, 'utf8');
      const report = `exit=${code} after ${Date.now() - startedAt}ms\n${faultLog}\n${plain.slice(-6000)}`;

      // The fault was live in both Chrome suites, and every reachability assertion still passed.
      expect(faultLog.match(/\[fault-shim\] held back Browser\.close/g), report).toHaveLength(2);
      expect(code, report).toBe(0);
      expect(plain, report).toMatch(/Tests +5 passed \(5\)/);
      for (const suite of ['headless', 'desktop']) {
        expect(plain, report).toContain(`${suite}: Browser.close did not answer within ${limit('BROWSER_CLOSE_TIMEOUT_MS')}ms`);
        expect(plain, report).toMatch(new RegExp(`${suite}: reap \\(afterAll\\) pid=\\d+ `));
        const finished = plain.match(new RegExp(`${suite}: teardown finished in (\\d+)ms \\(limit (\\d+)ms\\) chrome exited=true`));
        expect(finished, report).not.toBeNull();
        expect(Number(finished![1]), report).toBeGreaterThanOrEqual(limit('BROWSER_CLOSE_TIMEOUT_MS'));
        expect(Number(finished![1]), report).toBeLessThan(limit('SUITE_TEARDOWN_TIMEOUT_MS'));
      }
      expect(plain, report).not.toMatch(/Hook timed out/);

      // Nothing the nested run started (shim, real Chrome and its helpers, Xvfb) outlives it.
      let leaked = processesTagged(tag);
      for (let i = 0; i < 50 && leaked.length; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        leaked = processesTagged(tag);
      }
      expect(leaked, report).toEqual([]);
    } finally {
      for (const pid of processesTagged(tag)) {
        try { process.kill(Number(pid.split(' ')[0]), 'SIGKILL'); } catch { /* already gone */ }
      }
      rmSync(work, { recursive: true, force: true });
    }
  }, 240000);
});
