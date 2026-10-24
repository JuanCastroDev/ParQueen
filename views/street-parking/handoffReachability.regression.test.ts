import { createServer, type Server } from 'node:http';
import { execFileSync, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import type { Readable } from 'node:stream';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';

const require = createRequire(import.meta.url);
const root = path.resolve(__dirname, '../..');
const css = readFileSync(path.join(root, 'index.css'), 'utf8');
const sheetSource = readFileSync(path.join(__dirname, 'BottomSheet.tsx'), 'utf8');

function commandExists(bin: string) {
  try {
    require('node:child_process').execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const chromeBin = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].find(commandExists);
const xvfbBin = commandExists('Xvfb');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Environment boot only. CI runners have shown Chrome stalling with no output, or exiting
// silently, before DevTools comes up. Each attempt waits on a wall-clock deadline and a failed
// attempt is relaunched once on a fresh profile. Every assertion still runs only after
// DevTools is up, so a broken page or a missed click fails exactly as before.
const CHROME_DEVTOOLS_DEADLINE_MS = 30000;
const CHROME_LAUNCH_ATTEMPTS = 2;
const BROWSER_BOOT_TIMEOUT_MS = 120000;

// Teardown only. Every wait in a suite's afterAll has an explicit bound, so a Chrome that
// never answers Browser.close (the CDP helper below never rejects a call whose response does
// not arrive) or a step that stalls cannot hang the hook. A bound that expires is logged and
// teardown moves on to the process-group SIGKILL and reap, which always run. Worst case of the
// bounded waits: close 3000 + 3 x exit wait 3000 + server 2000 + profile removal 5000 =
// 19000ms, inside SUITE_TEARDOWN_TIMEOUT_MS. None of these limits touches a test or boot timeout.
const BROWSER_CLOSE_TIMEOUT_MS = 3000;
const CHROME_EXIT_WAIT_MS = 3000;
const SERVER_CLOSE_TIMEOUT_MS = 2000;
const PROFILE_REMOVE_TIMEOUT_MS = 5000;
const SUITE_TEARDOWN_TIMEOUT_MS = 30000;

// Harness diagnostics go straight to the worker's stderr so CI logs keep them whether the
// boot succeeds or fails. They never feed an assertion.
function harnessLog(message: string) {
  process.stderr.write(`[handoff-harness] ${message}\n`);
}
const tail = (text: string, max = 600) => text.replace(/\s+/g, ' ').trim().slice(-max);

// Every Chrome and Xvfb this file spawns is the leader of its own process group
// (detached) and is registered here until it has been reaped. A suite's afterAll reaps its
// own group set, and a process 'exit' hook reaps anything left, so neither a startup
// deadline nor an expired beforeAll hook can leak a browser, its helper processes, or Xvfb.
// After a suite has been closed, a boot still running in the background (vitest does not
// cancel a timed-out hook) cannot spawn anything new: spawnTracked kills it and throws.
type HarnessSession = { name: string; closed: boolean; children: Set<ChildProcess> };
const harnessSessions = new Set<HarnessSession>();

function createHarnessSession(name: string): HarnessSession {
  const session = { name, closed: false, children: new Set<ChildProcess>() };
  harnessSessions.add(session);
  return session;
}

function killProcessGroup(child: ChildProcess) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    // ESRCH: the whole group is already gone.
  }
  try {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  } catch {
    // Already exited.
  }
}

function spawnTracked(session: HarnessSession, command: string, args: string[], options: SpawnOptions) {
  if (session.closed) throw new Error(`${session.name}: harness already torn down, not spawning ${command}`);
  const child = spawn(command, args, { ...options, detached: true });
  session.children.add(child);
  if (session.closed) killProcessGroup(child);
  return child;
}

function reapSession(session: HarnessSession, why: string) {
  session.closed = true;
  for (const child of session.children) {
    const alive = child.exitCode === null && child.signalCode === null;
    killProcessGroup(child);
    harnessLog(`${session.name}: reap (${why}) pid=${child.pid} ${alive ? 'was running, SIGKILLed group' : 'already exited, group swept'}`);
  }
  session.children.clear();
}

process.once('exit', () => {
  for (const session of harnessSessions) reapSession(session, 'process exit');
});
// File-level backstop: runs after both suites' own afterAll hooks, even if one of them threw.
afterAll(() => {
  for (const session of harnessSessions) if (session.children.size) reapSession(session, 'file afterAll');
});

// Waits for work for at most timeoutMs. Never rejects: the caller gets the value, the error,
// or 'timed out'. A rejection that lands after the bound expired is logged, not dropped.
async function settleWithin<T>(work: Promise<T>, timeoutMs: number, lateFailure: (error: unknown) => void) {
  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = work.then(
    (value) => ({ state: 'done' as const, value }),
    (error: unknown) => {
      if (expired) lateFailure(error);
      return { state: 'failed' as const, error };
    },
  );
  const deadline = new Promise<{ state: 'timed out' }>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      resolve({ state: 'timed out' });
    }, timeoutMs);
  });
  try {
    return await Promise.race([settled, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

const errorText = (error: unknown) => tail(String(error instanceof Error ? error.message : error), 200);

// Asks Chrome to close itself, for at most BROWSER_CLOSE_TIMEOUT_MS. Chrome exiting counts as
// an answer, since Browser.close can sever the DevTools socket before its response arrives.
async function closeBrowserWithin(
  session: HarnessSession,
  browser: ((method: string, params?: Record<string, unknown>) => Promise<any>) | undefined,
  chrome: ChildProcess,
) {
  if (!browser) return;
  const startedAt = Date.now();
  const exited = new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
  const outcome = await settleWithin(Promise.race([browser('Browser.close'), exited]), BROWSER_CLOSE_TIMEOUT_MS, (error) => {
    harnessLog(`${session.name}: Browser.close failed after its ${BROWSER_CLOSE_TIMEOUT_MS}ms bound: ${errorText(error)}`);
  });
  if (outcome.state === 'timed out') {
    harnessLog(`${session.name}: Browser.close did not answer within ${BROWSER_CLOSE_TIMEOUT_MS}ms pid=${chrome.pid}; continuing to SIGKILL and reap`);
  } else if (outcome.state === 'failed') {
    harnessLog(`${session.name}: Browser.close failed after ${Date.now() - startedAt}ms pid=${chrome.pid}: ${errorText(outcome.error)}`);
  }
}

async function closeServerWithin(session: HarnessSession, server: Server | undefined) {
  if (!server) return;
  const closed = new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  const outcome = await settleWithin(closed, SERVER_CLOSE_TIMEOUT_MS, (error) => {
    harnessLog(`${session.name}: fixture server close failed after its ${SERVER_CLOSE_TIMEOUT_MS}ms bound: ${errorText(error)}`);
  });
  if (outcome.state === 'timed out') {
    server.closeAllConnections();
    harnessLog(`${session.name}: fixture server did not close within ${SERVER_CLOSE_TIMEOUT_MS}ms; dropped its open connections`);
  } else if (outcome.state === 'failed' && (outcome.error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') {
    harnessLog(`${session.name}: fixture server close failed: ${errorText(outcome.error)}`);
  }
}

// CI runners occasionally keep Chrome profile files busy for a moment after
// process exit. Cleanup is hygiene, not part of the reachability assertion.
// Never turn otherwise-passing product assertions red for that OS race. The removal is
// asynchronous so its retries cannot block the event loop (and with it the hook timer).
async function removeProfileWithin(session: HarnessSession, dir: string) {
  const outcome = await settleWithin(rm(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 }), PROFILE_REMOVE_TIMEOUT_MS, (error) => {
    harnessLog(`${session.name}: temp dir ${dir} removal failed after its ${PROFILE_REMOVE_TIMEOUT_MS}ms bound: ${errorText(error)}`);
  });
  if (outcome.state === 'timed out') {
    harnessLog(`${session.name}: temp dir ${dir} not removed within ${PROFILE_REMOVE_TIMEOUT_MS}ms; leaving it`);
  } else if (outcome.state === 'failed') {
    const code = outcome.error && typeof outcome.error === 'object' ? (outcome.error as NodeJS.ErrnoException).code : undefined;
    if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') throw outcome.error;
    harnessLog(`${session.name}: temp dir ${dir} not removed (${code}); leaving it`);
  }
}

function printEnvironmentOnce(session: HarnessSession) {
  const image = [process.env.ImageOS, process.env.ImageVersion].filter(Boolean).join(' ') || 'n/a';
  let version: string;
  try {
    version = execFileSync(chromeBin!, ['--version'], { encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch (error) {
    version = `unavailable (${tail(String((error as Error).message), 200)})`;
  }
  harnessLog(`${session.name}: runner image=${image} node=${process.version} chrome binary=${chromeBin} --version: ${version}`);
}

async function launchChromeWithDevTools(session: HarnessSession, baseDir: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  const failures: string[] = [];
  for (let attempt = 1; attempt <= CHROME_LAUNCH_ATTEMPTS; attempt++) {
    const profileDir = path.join(baseDir, attempt === 1 ? 'profile' : `profile-${attempt}`);
    const activePortFile = path.join(profileDir, 'DevToolsActivePort');
    const startedAt = Date.now();
    let stderr = '';
    const chrome = spawnTracked(session, chromeBin!, [...args, `--user-data-dir=${profileDir}`, '--remote-debugging-port=0'], {
      stdio: ['ignore', 'ignore', 'pipe'],
      env,
    });
    const exited = new Promise<void>((resolve) => chrome.once('exit', () => resolve()));
    chrome.stderr?.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4000);
    });

    while (Date.now() - startedAt < CHROME_DEVTOOLS_DEADLINE_MS) {
      if (session.closed) break;
      if (chrome.exitCode !== null || chrome.signalCode !== null) break;
      try {
        const [portLine, pathLine] = readFileSync(activePortFile, 'utf8').trim().split(/\r?\n/);
        const debugPort = Number(portLine);
        if (Number.isInteger(debugPort) && debugPort > 0 && pathLine) {
          harnessLog(`${session.name}: chrome attempt ${attempt}/${CHROME_LAUNCH_ATTEMPTS}: devtools up after ${Date.now() - startedAt}ms pid=${chrome.pid} exit=n/a (running) stderr tail: ${tail(stderr) || '(none)'}`);
          return { chrome, debugPort, browserPath: pathLine };
        }
      } catch {
        // Chrome writes DevToolsActivePort only after the DevTools endpoint is ready.
      }
      await sleep(100);
    }

    const running = chrome.exitCode === null && chrome.signalCode === null;
    const state = running ? 'still running' : `exited code=${chrome.exitCode} signal=${chrome.signalCode}`;
    killProcessGroup(chrome);
    if (running) await Promise.race([exited, sleep(3000)]);
    session.children.delete(chrome);
    const diagnostic = stderr.replace(/\s+/g, ' ').trim().slice(-1000);
    const reason = session.closed ? 'harness torn down' : running ? 'deadline expired' : 'exited early';
    harnessLog(`${session.name}: chrome attempt ${attempt}/${CHROME_LAUNCH_ATTEMPTS}: FAILED (${reason}) after ${Date.now() - startedAt}ms pid=${chrome.pid} ${state}${running ? ' (SIGKILLed group)' : ''} stderr tail: ${tail(stderr) || '(none)'}`);
    failures.push(`attempt ${attempt}: ${state} after ${Date.now() - startedAt}ms${diagnostic ? `: ${diagnostic}` : ' (no stderr)'}`);
    if (session.closed) break;
  }
  throw new Error(`Chrome DevTools did not start: ${failures.join(' | ')}`);
}

// -displayfd makes Xvfb pick a free display and report it only once it accepts connections.
// This replaces a fixed 300ms sleep on a random display number, which let headed Chrome
// start before any X server was listening ("Missing X server or $DISPLAY").
async function startXvfb(session: HarnessSession): Promise<{ xvfb: ChildProcess; display: string }> {
  const startedAt = Date.now();
  const xvfb = spawnTracked(session, 'Xvfb', ['-displayfd', '3', '-screen', '0', '1280x800x24', '-ac'], {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  xvfb.stderr?.on('data', (chunk) => {
    stderr = (stderr + String(chunk)).slice(-2000);
  });
  const displayPipe = xvfb.stdio[3] as Readable;
  try {
    const display = await new Promise<string>((resolve, reject) => {
      let out = '';
      const timer = setTimeout(() => reject(new Error('no display reported within 15000ms')), 15000);
      displayPipe.on('data', (chunk) => {
        out += String(chunk);
        const match = out.match(/^(\d+)\s*\n/);
        if (match) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      xvfb.once('exit', (code, signal) => {
        clearTimeout(timer);
        reject(new Error(`exited code=${code} signal=${signal}`));
      });
      xvfb.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    displayPipe.destroy();
    harnessLog(`${session.name}: xvfb display=:${display} ready after ${Date.now() - startedAt}ms pid=${xvfb.pid}`);
    return { xvfb, display: `:${display}` };
  } catch (error) {
    killProcessGroup(xvfb);
    harnessLog(`${session.name}: xvfb FAILED after ${Date.now() - startedAt}ms pid=${xvfb.pid} exit code=${xvfb.exitCode} signal=${xvfb.signalCode}: ${(error as Error).message} stderr tail: ${tail(stderr) || '(none)'}`);
    const diagnostic = stderr.replace(/\s+/g, ' ').trim().slice(-1000);
    throw new Error(`Xvfb did not start: ${(error as Error).message}${diagnostic ? `: ${diagnostic}` : ''}`);
  }
}

describe('handoff reachability contract', () => {
  it('anchors the handoff action card directly above the nav instead of floating mid-map', () => {
    const mobile = css.slice(css.indexOf('@media (max-width: 767px)'), css.indexOf('.mobile-primary-nav-ping {'));
    expect(mobile).toMatch(/\.mobile-map-controls \.handoff-action-card\s*\{[^}]*position:\s*fixed/);
    expect(mobile).toMatch(/bottom:\s*calc\(var\(--mobile-primary-nav-space\) \+ 14px\)/);
    expect(mobile).toMatch(/right:\s*max\(82px,/);
    expect(mobile).toMatch(/pointer-events:\s*auto/);
    expect(mobile).not.toMatch(/orientation:\s*landscape/);

    const landscape = css.slice(
      css.indexOf('@media (max-height: 500px) {'),
      css.indexOf('@media (min-width: 768px)'),
    );
    expect(landscape).toMatch(/\.mobile-map-controls \.handoff-action-card\s*\{[^}]*position:\s*fixed[^}]*bottom:\s*calc\(var\(--mobile-primary-nav-space\) \+ 10px\)/s);
    expect(landscape).toMatch(/\.handoff-action-card:has\(\+ \.map-timer-chip\)\s*\{[^}]*\+ 118px/);
  });

  it('keeps an open sheet above fixed map controls and drops those controls from hit testing', () => {
    expect(css).toMatch(/\.sp-page \.pq-bottom-sheet-root\s*\{[^}]*z-index:\s*40/s);
    expect(css).toMatch(/\.sp-page:has\(\.pq-bottom-sheet-root\) \.map-secondary-controls \*[\s\S]*pointer-events:\s*none/);
    expect(css).toMatch(/\.handoff-failure-reason\s*\{[^}]*touch-action:\s*manipulation/s);
    expect(sheetSource).toMatch(/fromControl = !!target\?\.closest\('button, a, input, textarea, select, label'\)/);
    expect(sheetSource).toMatch(/if \(!fromHandle && \(sheet\.scrollTop > 0 \|\| fromControl\)\)/);
  });
});

describe.skipIf(!chromeBin)('handoff reachability in Chrome', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'handoff-reach-'));
  const session = createHarnessSession('headless');
  let server: Server;
  let chrome: ChildProcess;
  let browser: ((method: string, params?: Record<string, unknown>) => Promise<any>) | undefined;
  let page: (method: string, params?: Record<string, unknown>) => Promise<any>;
  let port = 0;

  beforeAll(async () => {
    printEnvironmentOnce(session);
    await boot();
  }, BROWSER_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    const teardownStartedAt = Date.now();
    const waitForChromeExit = (timeoutMs: number) => new Promise<boolean>((resolve) => {
      if (!chrome || chrome.exitCode !== null || chrome.signalCode !== null) {
        resolve(true);
        return;
      }
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        chrome.off('exit', onExit);
        resolve(false);
      }, timeoutMs);
      chrome.once('exit', onExit);
    });

    let chromeExited = !chrome || chrome.exitCode !== null || chrome.signalCode !== null;
    try {
      if (!chromeExited) {
        await closeBrowserWithin(session, browser, chrome);
        chromeExited = await waitForChromeExit(CHROME_EXIT_WAIT_MS);
      }
      if (!chromeExited && chrome && chrome.exitCode === null && chrome.signalCode === null) {
        chrome.kill('SIGKILL');
        chromeExited = await waitForChromeExit(CHROME_EXIT_WAIT_MS);
      }
    } finally {
      // Also covers a beforeAll that timed out mid-launch: kills every tracked Chrome/Xvfb
      // process group, including ones the suite variables never received, and blocks new spawns.
      reapSession(session, 'afterAll');
    }
    if (!chromeExited) chromeExited = await waitForChromeExit(CHROME_EXIT_WAIT_MS);

    await closeServerWithin(session, server);
    if (chromeExited) await removeProfileWithin(session, dir);
    harnessLog(`${session.name}: teardown finished in ${Date.now() - teardownStartedAt}ms (limit ${SUITE_TEARDOWN_TIMEOUT_MS}ms) chrome exited=${chromeExited}`);
  }, SUITE_TEARDOWN_TIMEOUT_MS);

  async function boot() {
    const esbuild = require('esbuild') as typeof import('esbuild');
    const postcss = require('postcss') as typeof import('postcss').default;
    const tailwind = require('tailwindcss');
    const autoprefixer = require('autoprefixer');
    const compiled = await postcss([tailwind(path.join(root, 'tailwind.config.js')), autoprefixer])
      .process(css, { from: path.join(root, 'index.css') });
    writeFileSync(path.join(dir, 'app.css'), compiled.css);
    await esbuild.build({
      absWorkingDir: root,
      entryPoints: [path.join(__dirname, 'handoffReachability.fixture.tsx')],
      bundle: true,
      format: 'esm',
      outfile: path.join(dir, 'fixture.js'),
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' },
    });
    writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`);

    server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const file = path.join(dir, url.pathname === '/' ? 'index.html' : url.pathname);
      try {
        const body = readFileSync(file);
        const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
        res.writeHead(200, { 'content-type': type });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('missing');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;

    const launched = await launchChromeWithDevTools(session, dir, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-dev-shm-usage',
    ]);
    chrome = launched.chrome;
    const { debugPort, browserPath } = launched;

    const browserWs = new WebSocket(
      `ws://127.0.0.1:${debugPort}${browserPath.startsWith('/') ? browserPath : `/${browserPath}`}`,
    );
    await new Promise<void>((resolve, reject) => {
      browserWs.addEventListener('open', () => resolve());
      browserWs.addEventListener('error', () => reject(new Error('browser socket')));
    });
    browser = wire(browserWs);
    try {
      const version = await browser('Browser.getVersion');
      harnessLog(`${session.name}: CDP Browser.getVersion product=${version.product} protocol=${version.protocolVersion} revision=${version.revision}`);
    } catch (error) {
      harnessLog(`${session.name}: CDP Browser.getVersion unavailable: ${tail(String((error as Error).message), 200)}`);
    }
    const { targetId } = await browser('Target.createTarget', { url: 'about:blank' });
    let target: { id: string; webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 50 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json() as Array<{ id: string; webSocketDebuggerUrl: string }>;
        target = list.find((item) => item.id === targetId);
      } catch {
        // The target list may lag briefly behind Target.createTarget on busy CI hosts.
      }
      if (!target) await sleep(100);
    }
    if (!target) throw new Error('Chrome target did not become available');
    const pageWs = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      pageWs.addEventListener('open', () => resolve());
      pageWs.addEventListener('error', () => reject(new Error('page socket')));
    });
    page = wire(pageWs);
    await page('Page.enable');
    await page('Runtime.enable');
  }

  async function open(mode: 'chip' | 'sheet', width: number, height: number) {
    const metrics = { width, height, deviceScaleFactor: 1, mobile: true, screenWidth: width, screenHeight: height };
    await page('Emulation.setDeviceMetricsOverride', metrics);
    if (mode === 'sheet') await page('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await page('Page.navigate', { url: `http://127.0.0.1:${port}/?mode=${mode}` });
    let sized = { w: 0, h: 0, readyState: 'unknown' };
    for (let i = 0; i < 100; i++) {
      try {
        // Navigation returns before Chrome necessarily applies the page viewport
        // metadata. Re-apply emulation and wait for the requested layout viewport
        // instead of sampling the transient 980px mobile fallback.
        await page('Emulation.setDeviceMetricsOverride', metrics);
        sized = await ev<{ w: number; h: number; readyState: string }>(
          `({ w: innerWidth, h: innerHeight, readyState: document.readyState })`,
        );
        if (sized.readyState !== 'loading' && sized.w === width && sized.h === height) break;
      } catch {
        // The execution context may briefly disappear while navigation commits.
      }
      await sleep(100);
    }
    if (sized.w !== width || sized.h !== height) {
      throw new Error(
        `viewport ${sized.w}x${sized.h} (ready=${sized.readyState}), wanted ${width}x${height}`,
      );
    }
    for (let i = 0; i < 40; i++) {
      const ready = await ev<boolean>(mode === 'chip'
        ? '!!document.querySelector("[data-testid=finish-handoff-chip] button")'
        : '!!document.querySelector(".handoff-failure-reason")');
      if (ready) {
        await new Promise((r) => setTimeout(r, 350));
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(`fixture ${mode} did not render`);
  }

  async function ev<T>(expression: string): Promise<T> {
    const res = await page('Runtime.evaluate', { expression, returnByValue: true });
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails.exception || res.exceptionDetails));
    return res.result.value as T;
  }

  it('keeps the portrait chip center reachable by mouse and touch', async () => {
    await open('chip', 390, 844);
    const probe = await ev<{
      position: string;
      self: boolean;
      hit: string;
      x: number;
      y: number;
      innerWidth: number;
      innerHeight: number;
      mobile: boolean;
      ruleCount: number;
    }>(`(() => {
      const card = document.querySelector('[data-testid=finish-handoff-chip]');
      const button = card.querySelector('button');
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      const sheet = [...document.styleSheets].map((s) => { try { return [...s.cssRules].length; } catch { return -1; } });
      return {
        position: getComputedStyle(card).position,
        self: !!(hit && (hit === button || button.contains(hit))),
        hit: (hit && (hit.className || hit.id) || '').toString().slice(0, 80),
        x, y,
        innerWidth, innerHeight,
        mobile: matchMedia('(max-width: 767px)').matches,
        ruleCount: sheet.reduce((a, b) => a + (b > 0 ? b : 0), 0),
      };
    })()`);
    expect(probe.position, JSON.stringify(probe)).toBe('fixed');
    expect(probe.self, probe.hit).toBe(true);
    expect(probe.y).toBeGreaterThan(0);
    expect(probe.y).toBeLessThan(844);

    await page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: probe.x, y: probe.y });
    await page('Input.dispatchMouseEvent', { type: 'mousePressed', x: probe.x, y: probe.y, button: 'left', clickCount: 1 });
    await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: probe.x, y: probe.y, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 50));
    expect(await ev<number>('window.__resumed')).toBe(1);

    await page('Page.reload');
    await open('chip', 390, 844);
    const again = await ev<{ x: number; y: number }>(`(() => {
      const button = document.querySelector('[data-testid=finish-handoff-chip] button');
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    await page('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
    await page('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: again.x, y: again.y, id: 1 }] });
    await page('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await new Promise((r) => setTimeout(r, 80));
    expect(await ev<number>('window.__resumed')).toBe(1);
  }, 60000);

  it('delivers mouse and touch clicks to every short-landscape failure reason', async () => {
    await open('sheet', 700, 400);
    const reasons = ['Someone else got it', "Finder hadn't left yet", "Couldn't find the location", 'Other'];
    const hits = await ev<Array<{ text: string; self: boolean; hit: string }>>(`(() => {
      const buttons = [...document.querySelectorAll('.handoff-failure-reason')];
      return buttons.map((button) => {
        button.scrollIntoView({ block: 'center' });
        const rect = button.getBoundingClientRect();
        const x = rect.left + Math.min(rect.width / 2, 180);
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        const right = document.elementFromPoint(rect.right - 12, y);
        const onButton = (node) => !!(node && (node === button || button.contains(node)));
        return {
          text: button.textContent.trim(),
          self: onButton(hit) && onButton(right),
          hit: [hit, right].map((node) => (node && (node.className || node.id) || '').toString().slice(0, 40)).join(' | '),
        };
      });
    })()`);
    expect(hits.map((h) => h.text)).toEqual(reasons);
    for (const hit of hits) expect(hit.self, `${hit.text} -> ${hit.hit}`).toBe(true);

    const target = await ev<{ x: number; y: number; text: string }>(`(() => {
      const button = document.querySelector('.handoff-failure-reason');
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, text: button.textContent.trim() };
    })()`);
    await page('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 50));
    expect(await ev<string>('window.__picked')).toBe(target.text);

    await page('Page.reload');
    await open('sheet', 740, 360);
    const touch = await ev<{ x: number; y: number; text: string }>(`(() => {
      const button = [...document.querySelectorAll('.handoff-failure-reason')].find((el) => el.textContent.includes('Other'));
      button.scrollIntoView({ block: 'center' });
      const rect = button.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: Math.min(rect.top + rect.height / 2, innerHeight - 2), text: button.textContent.trim() };
    })()`);
    await ev(`(() => {
      window.__pd = [];
      const orig = Event.prototype.preventDefault;
      Event.prototype.preventDefault = function() {
        window.__pd.push(this.type);
        return orig.apply(this, arguments);
      };
    })()`);
    await page('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: touch.x, y: touch.y, id: 1 }] });
    await page('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await new Promise((r) => setTimeout(r, 150));
    const touchResult = await ev<{ picked: string | null; prevented: string[]; viewport: string; short: boolean }>(
      '({ picked: window.__picked, prevented: window.__pd, viewport: innerWidth + "x" + innerHeight, short: matchMedia("(max-height: 500px)").matches })',
    );
    expect(touchResult.short, JSON.stringify(touchResult)).toBe(true);
    expect(touchResult.prevented, JSON.stringify(touchResult)).not.toContain('touchmove');
    expect(touchResult.picked, JSON.stringify(touchResult)).toBe(touch.text);
  }, 60000);
});

// Headed Chrome on Xvfb, not headless. Headless reports pointer:none and hover:none,
// which is not a resized desktop window. This suite is skipped when Chrome or Xvfb
// is missing. A "Chrome DevTools did not start" error here is that environment
// failing to boot, not a missed click on the failure-reason button. The assertions
// below run only after DevTools is up, and they require pointer:fine and hover:hover.
describe.skipIf(!chromeBin || !xvfbBin)('handoff failure reasons in a resized desktop window', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'handoff-desktop-'));
  const session = createHarnessSession('desktop');
  let server: Server;
  let chrome: ChildProcess;
  let browser: ((method: string, params?: Record<string, unknown>) => Promise<any>) | undefined;
  let xvfb: ChildProcess;
  let page: (method: string, params?: Record<string, unknown>) => Promise<any>;
  let port = 0;

  beforeAll(async () => {
    printEnvironmentOnce(session);
    const esbuild = require('esbuild') as typeof import('esbuild');
    const postcss = require('postcss') as typeof import('postcss').default;
    const tailwind = require('tailwindcss');
    const autoprefixer = require('autoprefixer');
    const compiled = await postcss([tailwind(path.join(root, 'tailwind.config.js')), autoprefixer])
      .process(css, { from: path.join(root, 'index.css') });
    writeFileSync(path.join(dir, 'app.css'), compiled.css);
    await esbuild.build({
      absWorkingDir: root,
      entryPoints: [path.join(__dirname, 'handoffReachability.fixture.tsx')],
      bundle: true,
      format: 'esm',
      outfile: path.join(dir, 'fixture.js'),
      jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"development"' },
    });
    writeFileSync(path.join(dir, 'index.html'), `<!doctype html><html class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`);
    server = createServer((req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const file = path.join(dir, url.pathname === '/' ? 'index.html' : url.pathname);
      try {
        const body = readFileSync(file);
        const type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
        res.writeHead(200, { 'content-type': type });
        res.end(body);
      } catch {
        res.writeHead(404);
        res.end('missing');
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;

    const started = await startXvfb(session);
    xvfb = started.xvfb;
    const launched = await launchChromeWithDevTools(session, dir, [
      '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-dev-shm-usage',
      '--window-size=420,780', '--window-position=0,0',
    ], { ...process.env, DISPLAY: started.display });
    chrome = launched.chrome;
    const { debugPort, browserPath } = launched;

    const browserWs = new WebSocket(
      `ws://127.0.0.1:${debugPort}${browserPath.startsWith('/') ? browserPath : `/${browserPath}`}`,
    );
    await new Promise<void>((resolve, reject) => {
      browserWs.addEventListener('open', () => resolve());
      browserWs.addEventListener('error', () => reject(new Error('browser socket')));
    });
    browser = wire(browserWs);
    try {
      const version = await browser('Browser.getVersion');
      harnessLog(`${session.name}: CDP Browser.getVersion product=${version.product} protocol=${version.protocolVersion} revision=${version.revision}`);
    } catch (error) {
      harnessLog(`${session.name}: CDP Browser.getVersion unavailable: ${tail(String((error as Error).message), 200)}`);
    }
    const { targetId } = await browser('Target.createTarget', { url: 'about:blank' });
    let target: { id: string; webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 50 && !target; i++) {
      try {
        const list = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json() as Array<{ id: string; webSocketDebuggerUrl: string }>;
        target = list.find((item) => item.id === targetId);
      } catch {
        // The target list may lag briefly behind Target.createTarget on busy CI hosts.
      }
      if (!target) await sleep(100);
    }
    if (!target) throw new Error('Chrome target did not become available');
    const pageWs = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      pageWs.addEventListener('open', () => resolve());
      pageWs.addEventListener('error', () => reject(new Error('page socket')));
    });
    page = wire(pageWs);
    await page('Page.enable');
    await page('Runtime.enable');
  }, BROWSER_BOOT_TIMEOUT_MS);

  afterAll(async () => {
    const teardownStartedAt = Date.now();
    const waitForChromeExit = (timeoutMs: number) => new Promise<boolean>((resolve) => {
      if (!chrome || chrome.exitCode !== null || chrome.signalCode !== null) {
        resolve(true);
        return;
      }
      const onExit = () => {
        clearTimeout(timer);
        resolve(true);
      };
      const timer = setTimeout(() => {
        chrome.off('exit', onExit);
        resolve(false);
      }, timeoutMs);
      chrome.once('exit', onExit);
    });

    let chromeExited = !chrome || chrome.exitCode !== null || chrome.signalCode !== null;
    try {
      if (!chromeExited) {
        await closeBrowserWithin(session, browser, chrome);
        chromeExited = await waitForChromeExit(CHROME_EXIT_WAIT_MS);
      }
      if (!chromeExited && chrome && chrome.exitCode === null && chrome.signalCode === null) {
        chrome.kill('SIGKILL');
        chromeExited = await waitForChromeExit(CHROME_EXIT_WAIT_MS);
      }
    } finally {
      // Also covers a beforeAll that timed out mid-launch: kills every tracked Chrome/Xvfb
      // process group, including ones the suite variables never received, and blocks new spawns.
      reapSession(session, 'afterAll');
    }
    if (!chromeExited) chromeExited = await waitForChromeExit(CHROME_EXIT_WAIT_MS);
    if (xvfb && xvfb.exitCode === null && xvfb.signalCode === null) {
      xvfb.kill('SIGKILL');
    }

    await closeServerWithin(session, server);
    if (chromeExited) await removeProfileWithin(session, dir);
    harnessLog(`${session.name}: teardown finished in ${Date.now() - teardownStartedAt}ms (limit ${SUITE_TEARDOWN_TIMEOUT_MS}ms) chrome exited=${chromeExited}`);
  }, SUITE_TEARDOWN_TIMEOUT_MS);

  async function ev<T>(expression: string): Promise<T> {
    const res = await page('Runtime.evaluate', { expression, returnByValue: true });
    if (res.exceptionDetails) throw new Error(JSON.stringify(res.exceptionDetails.exception || res.exceptionDetails));
    return res.result.value as T;
  }

  it('delivers a desktop-window mouse click to a portrait failure reason after No luck', async () => {
    await page('Page.navigate', { url: `http://127.0.0.1:${port}/?mode=sheet&step=outcome` });
    for (let i = 0; i < 40; i++) {
      const ready = await ev<boolean>('!![...document.querySelectorAll("button")].find((el) => el.textContent.includes("No luck"))');
      if (ready) break;
      await new Promise((r) => setTimeout(r, 100));
      if (i === 39) throw new Error('outcome step did not render');
    }
    await new Promise((r) => setTimeout(r, 350));

    const environment = await ev<{
      viewport: string;
      fine: boolean;
      hover: boolean;
      mobile: boolean;
      portrait: boolean;
    }>(`({
      viewport: innerWidth + "x" + innerHeight,
      fine: matchMedia("(pointer: fine)").matches,
      hover: matchMedia("(hover: hover)").matches,
      mobile: matchMedia("(max-width: 767px)").matches,
      portrait: innerHeight > innerWidth,
    })`);
    expect(environment.fine, JSON.stringify(environment)).toBe(true);
    expect(environment.hover, JSON.stringify(environment)).toBe(true);
    expect(environment.mobile, JSON.stringify(environment)).toBe(true);
    expect(environment.portrait, JSON.stringify(environment)).toBe(true);

    const noLuck = await ev<{ x: number; y: number; hit: string; self: boolean }>(`(() => {
      const button = [...document.querySelectorAll("button")].find((el) => el.textContent.includes("No luck"));
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        x, y,
        self: !!(hit && (hit === button || button.contains(hit))),
        hit: (hit && (hit.className || hit.tagName) || "").toString().slice(0, 80),
      };
    })()`);
    expect(noLuck.self, noLuck.hit).toBe(true);
    await page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: noLuck.x, y: noLuck.y });
    await page('Input.dispatchMouseEvent', { type: 'mousePressed', x: noLuck.x, y: noLuck.y, button: 'left', clickCount: 1 });
    await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: noLuck.x, y: noLuck.y, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 80));
    expect(await ev<string>('window.__step')).toBe('failure_reason');

    await ev(`(() => {
      window.__events = [];
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        document.addEventListener(type, (event) => {
          const target = event.target;
          window.__events.push({
            type,
            tag: target && target.tagName,
            className: target && String(target.className || "").slice(0, 80),
            text: target && String(target.textContent || "").trim().slice(0, 40),
            defaultPrevented: event.defaultPrevented,
          });
        }, true);
      }
    })()`);

    const reason = await ev<{ x: number; y: number; text: string; self: boolean; hit: string }>(`(() => {
      const button = document.querySelector(".handoff-failure-reason");
      const rect = button.getBoundingClientRect();
      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = document.elementFromPoint(x, y);
      return {
        x, y,
        text: button.textContent.trim(),
        self: !!(hit && (hit === button || button.contains(hit))),
        hit: (hit && (hit.className || hit.tagName) || "").toString().slice(0, 80),
      };
    })()`);
    expect(reason.self, reason.hit).toBe(true);
    expect(reason.text).toContain('Someone else got it');

    await page('Input.dispatchMouseEvent', { type: 'mouseMoved', x: reason.x, y: reason.y });
    await page('Input.dispatchMouseEvent', { type: 'mousePressed', x: reason.x, y: reason.y, button: 'left', clickCount: 1 });
    await page('Input.dispatchMouseEvent', { type: 'mouseReleased', x: reason.x + 3, y: reason.y + 2, button: 'left', clickCount: 1 });
    await new Promise((r) => setTimeout(r, 80));

    const result = await ev<{ picked: string | null; events: Array<{ type: string; className: string; defaultPrevented: boolean }> }>(
      '({ picked: window.__picked, events: window.__events })',
    );
    const types = result.events.map((event) => event.type);
    expect(types, JSON.stringify(result)).toEqual(expect.arrayContaining(['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']));
    expect(result.events.every((event) => event.className.includes('handoff-failure-reason')), JSON.stringify(result)).toBe(true);
    expect(result.events.some((event) => event.defaultPrevented), JSON.stringify(result)).toBe(false);
    expect(result.picked, JSON.stringify(result)).toBe(reason.text);
  }, 60000);
});

function wire(ws: WebSocket) {
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  let seq = 0;
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(String(ev.data));
    const waiter = pending.get(msg.id);
    if (!waiter) return;
    pending.delete(msg.id);
    if (msg.error) waiter.reject(new Error(JSON.stringify(msg.error)));
    else waiter.resolve(msg.result);
  });
  return (method: string, params: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
