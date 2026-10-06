import { createServer, type Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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

describe('handoff reachability contract', () => {
  it('anchors the handoff action card directly above the nav instead of floating mid-map', () => {
    const mobile = css.slice(css.indexOf('@media (max-width: 767px)'), css.indexOf('.mobile-primary-nav-ping {'));
    expect(mobile).toMatch(/\.mobile-map-controls \.handoff-action-card\s*\{[^}]*position:\s*fixed/);
    expect(mobile).toMatch(/bottom:\s*calc\(var\(--mobile-primary-nav-space\) \+ 14px\)/);
    expect(mobile).toMatch(/right:\s*max\(82px,/);
    expect(mobile).toMatch(/pointer-events:\s*auto/);
    expect(mobile).not.toMatch(/orientation:\s*landscape/);

    const landscape = css.slice(
      css.indexOf('@media (orientation: landscape) and (max-height: 430px) and (max-width: 767px)'),
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
  let server: Server;
  let chrome: ChildProcess;
  let chromeStderr = '';
  let browser: ((method: string, params?: Record<string, unknown>) => Promise<any>) | undefined;
  let page: (method: string, params?: Record<string, unknown>) => Promise<any>;
  let port = 0;

  beforeAll(async () => {
    await boot();
  }, 60000);

  afterAll(async () => {
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
    if (!chromeExited) {
      try {
        await browser?.('Browser.close');
      } catch {
        // Browser.close can sever the DevTools socket before its response arrives.
      }
      chromeExited = await waitForChromeExit(3000);
    }
    if (!chromeExited && chrome && chrome.exitCode === null && chrome.signalCode === null) {
      chrome.kill('SIGKILL');
      chromeExited = await waitForChromeExit(3000);
    }

    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });

    // CI runners occasionally keep Chrome profile files busy for a moment after
    // process exit. Cleanup is hygiene, not part of the reachability assertion.
    // Never turn otherwise-passing product assertions red for that OS race.
    if (chromeExited) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 });
      } catch (error) {
        const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined;
        if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') throw error;
      }
    }
  });

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

    const profileDir = path.join(dir, 'profile');
    const activePortFile = path.join(profileDir, 'DevToolsActivePort');
    chromeStderr = '';
    chrome = spawn(chromeBin!, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-dev-shm-usage',
      `--user-data-dir=${profileDir}`,
      '--remote-debugging-port=0',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    chrome.stderr?.on('data', (chunk) => {
      chromeStderr = (chromeStderr + String(chunk)).slice(-4000);
    });

    let debugPort = 0;
    let browserPath = '';
    for (let i = 0; i < 150 && (!debugPort || !browserPath); i++) {
      if (chrome.exitCode !== null || chrome.signalCode !== null) break;
      try {
        const [portLine, pathLine] = readFileSync(activePortFile, 'utf8').trim().split(/\r?\n/);
        const parsedPort = Number(portLine);
        if (Number.isInteger(parsedPort) && parsedPort > 0 && pathLine) {
          debugPort = parsedPort;
          browserPath = pathLine;
          break;
        }
      } catch {
        // Chrome writes DevToolsActivePort only after the DevTools endpoint is ready.
      }
      await sleep(100);
    }
    if (!debugPort || !browserPath) {
      const diagnostic = chromeStderr.replace(/\s+/g, ' ').trim().slice(-1000);
      throw new Error(`Chrome DevTools did not start${diagnostic ? `: ${diagnostic}` : ''}`);
    }

    const browserWs = new WebSocket(
      `ws://127.0.0.1:${debugPort}${browserPath.startsWith('/') ? browserPath : `/${browserPath}`}`,
    );
    await new Promise<void>((resolve, reject) => {
      browserWs.addEventListener('open', () => resolve());
      browserWs.addEventListener('error', () => reject(new Error('browser socket')));
    });
    browser = wire(browserWs);
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
      '({ picked: window.__picked, prevented: window.__pd, viewport: innerWidth + "x" + innerHeight, short: matchMedia("(orientation: landscape) and (max-height: 430px) and (max-width: 767px)").matches })',
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
  let server: Server;
  let chrome: ChildProcess;
  let chromeStderr = '';
  let browser: ((method: string, params?: Record<string, unknown>) => Promise<any>) | undefined;
  let xvfb: ChildProcess;
  let page: (method: string, params?: Record<string, unknown>) => Promise<any>;
  let port = 0;

  beforeAll(async () => {
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

    const profileDir = path.join(dir, 'profile');
    const activePortFile = path.join(profileDir, 'DevToolsActivePort');
    chromeStderr = '';
    const display = 50 + Math.floor(Math.random() * 20);
    xvfb = spawn('Xvfb', [`:${display}`, '-screen', '0', '1280x800x24', '-ac'], { stdio: 'ignore' });
    await sleep(300);
    chrome = spawn(chromeBin!, [
      '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-dev-shm-usage',
      '--window-size=420,780', '--window-position=0,0',
      `--user-data-dir=${profileDir}`,
      '--remote-debugging-port=0',
    ], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, DISPLAY: `:${display}` } });
    chrome.stderr?.on('data', (chunk) => {
      chromeStderr = (chromeStderr + String(chunk)).slice(-4000);
    });

    let debugPort = 0;
    let browserPath = '';
    for (let i = 0; i < 150 && (!debugPort || !browserPath); i++) {
      if (chrome.exitCode !== null || chrome.signalCode !== null) break;
      try {
        const [portLine, pathLine] = readFileSync(activePortFile, 'utf8').trim().split(/\r?\n/);
        const parsedPort = Number(portLine);
        if (Number.isInteger(parsedPort) && parsedPort > 0 && pathLine) {
          debugPort = parsedPort;
          browserPath = pathLine;
          break;
        }
      } catch {
        // Chrome writes DevToolsActivePort only after the DevTools endpoint is ready.
      }
      await sleep(100);
    }
    if (!debugPort || !browserPath) {
      const diagnostic = chromeStderr.replace(/\s+/g, ' ').trim().slice(-1000);
      throw new Error(`Chrome DevTools did not start${diagnostic ? `: ${diagnostic}` : ''}`);
    }

    const browserWs = new WebSocket(
      `ws://127.0.0.1:${debugPort}${browserPath.startsWith('/') ? browserPath : `/${browserPath}`}`,
    );
    await new Promise<void>((resolve, reject) => {
      browserWs.addEventListener('open', () => resolve());
      browserWs.addEventListener('error', () => reject(new Error('browser socket')));
    });
    browser = wire(browserWs);
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
  }, 60000);

  afterAll(async () => {
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
    if (!chromeExited) {
      try {
        await browser?.('Browser.close');
      } catch {
        // Browser.close can sever the DevTools socket before its response arrives.
      }
      chromeExited = await waitForChromeExit(3000);
    }
    if (!chromeExited && chrome && chrome.exitCode === null && chrome.signalCode === null) {
      chrome.kill('SIGKILL');
      chromeExited = await waitForChromeExit(3000);
    }
    if (xvfb && xvfb.exitCode === null && xvfb.signalCode === null) {
      xvfb.kill('SIGKILL');
    }

    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });

    // CI runners occasionally keep Chrome profile files busy for a moment after
    // process exit. Cleanup is hygiene, not part of the reachability assertion.
    // Never turn otherwise-passing product assertions red for that OS race.
    if (chromeExited) {
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 });
      } catch (error) {
        const code = error && typeof error === 'object' ? (error as NodeJS.ErrnoException).code : undefined;
        if (code !== 'ENOTEMPTY' && code !== 'EBUSY' && code !== 'EPERM') throw error;
      }
    }
  });

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
