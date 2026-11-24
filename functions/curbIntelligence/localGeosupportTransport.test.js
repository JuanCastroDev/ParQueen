import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { createPrivateBlockfaceResolver } = require('./privateBlockfaceResolver');
const {
  createLocalGeosupportTransport,
  demoLocalResolverBinding,
  localFunction3cAllowed,
  localStreetIntelligenceBinding,
  LOCAL_LOGICAL_FUNCTION3C_URL,
  stopLocalGeosupport,
} = require('./localGeosupportTransport');

const PRODUCTION_FUNCTION_3C = 'https://parqueen-curb-resolver-spike-oxbozdhlwa-uc.a.run.app';

const demoEnv = {
  FUNCTIONS_EMULATOR: 'true',
  CURB_LOCAL_FUNCTION3C: 'local',
  GCLOUD_PROJECT: 'demo-parkqueen-functions-test',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
  K_REVISION: '1',
  CURB_LOCAL_GEOSUPPORT_IMAGE: 'sha256:local',
  CURB_LOCAL_GEOSUPPORT_SERVICE: 'C:/local/service',
};

describe('local Function 3C transport', () => {
  it('stays unavailable unless the demo emulator process is explicit', () => {
    expect(createLocalGeosupportTransport({ ...demoEnv, FUNCTIONS_EMULATOR: 'false' })).toBeNull();
    expect(createLocalGeosupportTransport({ ...demoEnv, CURB_LOCAL_FUNCTION3C: 'off' })).toBeNull();
    expect(createLocalGeosupportTransport({
      ...demoEnv,
      GCLOUD_PROJECT: 'parkqueen-46475363-ccf36',
    })).toBeNull();
    expect(createLocalGeosupportTransport({
      ...demoEnv,
      FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com',
    })).toBeNull();
    expect(createLocalGeosupportTransport({ ...demoEnv, K_REVISION: 'createSegment-00042-abc' })).toBeNull();
    expect(localFunction3cAllowed({})).toBe(false);
  });

  it('does not call the configured run.app URL', async () => {
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (...args) => {
      calls.push(args[0]);
      throw new Error('production fetch refused');
    };
    try {
      const local = createLocalGeosupportTransport({
        ...demoEnv,
        CURB_LOCAL_GEOSUPPORT_IMAGE: '',
        CURB_LOCAL_GEOSUPPORT_SERVICE: '',
      });
      const resolver = createPrivateBlockfaceResolver({
        mode: 'shadow',
        serviceUrl: 'https://local-demo-disabled.run.app',
        transport: local.transport,
        getIdToken: local.getIdToken,
      });
      const result = await resolver.resolve({
        borough: 'BRONX',
        onStreet: 'MELVILLE STREET',
        crossStreetOne: 'VAN NEST AVENUE',
        crossStreetTwo: 'MORRIS PARK AVENUE',
        compassDirection: 'W',
      });
      expect(result.ok).toBe(false);
      expect(calls).toEqual([]);
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('keeps a misconfigured demo session away from production Firebase and Function 3C', async () => {
    const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const runtimeStart = index.indexOf('async function _runCanonicalCurbV2');
    const runtime = index.slice(runtimeStart, index.indexOf('// ─── Hydrant', runtimeStart));
    const closedAt = runtime.indexOf("localBinding.mode === 'closed'");
    expect(closedAt).toBeGreaterThan(-1);
    expect(closedAt).toBeLessThan(runtime.indexOf('orchestratorDependencies'));
    expect(runtime).toContain('localStreetIntelligenceBinding()');
    expect(runtime).toContain('demoLocalResolverBinding(localBinding)');
    expect(runtime).toContain("localBinding.mode === 'local'");
    expect(runtime).toContain('demoLocalBinding: demoBinding');
    expect(runtime).toContain('attachOwnerPilot(orchestratorDependencies, verifiedUid)');

    const misconfigured = [
      { ...demoEnv, GCLOUD_PROJECT: 'parkqueen-46475363-ccf36', CURB_OFFICIAL_LION_PRIMARY: 'local' },
      { ...demoEnv, FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9098', CURB_OFFICIAL_LION_PRIMARY: 'local' },
      { ...demoEnv, FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com' },
      { ...demoEnv, FUNCTIONS_EMULATOR: 'false' },
      { ...demoEnv, CURB_LOCAL_FUNCTION3C: 'off', CURB_OFFICIAL_LION_PRIMARY: 'local' },
    ];
    const calls = [];
    const originalFetch = global.fetch;
    global.fetch = async (url) => {
      calls.push(String(url));
      throw new Error('production fetch refused');
    };
    try {
      for (const env of misconfigured) {
        let openedProductionFirebase = false;
        const binding = localStreetIntelligenceBinding(env);
        expect(binding.mode).toBe('closed');
        if (binding.mode !== 'closed') {
          openedProductionFirebase = true;
          const resolver = createPrivateBlockfaceResolver({
            mode: 'shadow',
            serviceUrl: PRODUCTION_FUNCTION_3C,
            ...(binding.mode === 'local' ? {
              transport: binding.transport,
              getIdToken: binding.getIdToken,
            } : {}),
          });
          await resolver.resolve({
            borough: 'BRONX',
            onStreet: 'MELVILLE STREET',
            crossStreetOne: 'VAN NEST AVENUE',
            crossStreetTwo: 'MORRIS PARK AVENUE',
            compassDirection: 'W',
          });
        }
        expect(openedProductionFirebase).toBe(false);
      }
      expect(calls).toEqual([]);
      const production = localStreetIntelligenceBinding({
        FUNCTIONS_EMULATOR: 'false',
        CURB_LOCAL_FUNCTION3C: 'off',
        CURB_OFFICIAL_LION_PRIMARY: 'off',
        GCLOUD_PROJECT: 'parkqueen-46475363-ccf36',
      });
      expect(production).toEqual({ mode: 'production' });
    } finally {
      global.fetch = originalFetch;
    }
  });

  it('binds the exact logical URL only for a verified local demo session', () => {
    const binding = localStreetIntelligenceBinding(demoEnv);
    expect(binding.mode).toBe('local');
    const demo = demoLocalResolverBinding(binding, demoEnv);
    expect(demo).toMatchObject({
      mode: 'local',
      logicalServiceUrl: LOCAL_LOGICAL_FUNCTION3C_URL,
      transport: binding.transport,
      getIdToken: binding.getIdToken,
    });
    expect(demoLocalResolverBinding({ ...binding, mode: 'production' }, demoEnv)).toBeNull();
    expect(demoLocalResolverBinding({ ...binding, transport: null }, demoEnv)).toBeNull();
    expect(demoLocalResolverBinding({ ...binding, getIdToken: null }, demoEnv)).toBeNull();
    expect(demoLocalResolverBinding(binding, { ...demoEnv, GCLOUD_PROJECT: 'parkqueen-46475363-ccf36' })).toBeNull();
    expect(demoLocalResolverBinding(binding, { ...demoEnv, FUNCTIONS_EMULATOR: 'false' })).toBeNull();
    expect(demoLocalResolverBinding(binding, { ...demoEnv, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8180' })).toBeNull();
    expect(demoLocalResolverBinding(binding, { ...demoEnv, FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9098' })).toBeNull();
    expect(demoLocalResolverBinding(binding, { ...demoEnv, K_REVISION: '2' })).toBeNull();
    expect(demoLocalResolverBinding(binding, { ...demoEnv, CURB_LOCAL_FUNCTION3C: 'off' })).toBeNull();
  });
});

describe('local Function 3C process cleanup', () => {
  const childProcess = require('node:child_process');
  const requestBody = JSON.stringify({
    borough: 'BRONX',
    onStreet: 'MELVILLE STREET',
    crossStreetOne: 'VAN NEST AVENUE',
    crossStreetTwo: 'MORRIS PARK AVENUE',
    compassDirection: 'W',
  });
  const nativeLine = `PARQUEEN_GEO ${JSON.stringify({
    status: 200,
    payload: { ok: true, officialBlockFaceId: '1522611401' },
  })}\n`;
  let cidRoot;

  function helperChild(stdoutText) {
    const data = [];
    let onExit = () => {};
    const child = {
      pid: 7,
      killed: false,
      exitCode: null,
      signalCode: null,
      stdin: { write() {} },
      stdout: { on(event, handler) { if (event === 'data') data.push(handler); } },
      stderr: { on() {} },
      on(event, handler) { if (event === 'exit') onExit = handler; },
      kill() { this.killed = true; },
      unref() {},
    };
    queueMicrotask(() => {
      for (const handler of data) handler(Buffer.from(stdoutText));
      child.exitCode = 0;
      onExit(0);
    });
    return child;
  }

  function installSpawn({
    cid = 'abc123def4567890abc123def4567890abc123def4567890abc123def4567890',
    writeCid = 'immediate',
    inspectRunning = false,
  } = {}) {
    const calls = [];
    const handlers = {};
    const child = {
      pid: 4242,
      killed: false,
      exitCode: null,
      signalCode: null,
      stdin: { write() { return true; } },
      stdout: { on(event, handler) { if (event === 'data') handlers.stdout = handler; } },
      stderr: { on() {} },
      on(event, handler) { handlers[event] = handler; },
      kill() {
        this.killed = true;
        if (this.exitCode !== null) return;
        this.exitCode = 1;
        handlers.exit?.(1);
      },
      unref() {},
    };
    vi.spyOn(childProcess, 'spawn').mockImplementation((bin, args = []) => {
      calls.push(args);
      if (String(bin).toLowerCase() === 'taskkill') return helperChild('');
      if (args[0] === 'rm') return helperChild('');
      if (args[0] === 'inspect') return helperChild(inspectRunning ? 'true\n' : 'false\n');
      const cidFile = args[args.indexOf('--cidfile') + 1];
      if (writeCid === 'immediate') writeFileSync(cidFile, `${cid}\n`);
      if (writeCid === 'late') setTimeout(() => writeFileSync(cidFile, `${cid}\n`), 40);
      return child;
    });
    return { child, calls, handlers, cid };
  }

  function localEnv() {
    return { ...demoEnv, CURB_LOCAL_CID_DIRECTORY: cidRoot };
  }

  function runCalls(calls) {
    return calls.filter(args => args[0] === 'run');
  }

  beforeEach(() => {
    cidRoot = mkdtempSync(join(tmpdir(), 'parqueen-f3c-test-'));
  });

  afterEach(async () => {
    await stopLocalGeosupport();
    vi.useRealTimers();
    vi.restoreAllMocks();
    rmSync(cidRoot, { recursive: true, force: true });
  });

  it('does not spawn Docker when the request is already aborted', async () => {
    const { calls } = installSpawn();
    const local = createLocalGeosupportTransport(localEnv());
    const controller = new AbortController();
    controller.abort();
    await expect(local.transport({
      body: requestBody,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
    expect(runCalls(calls)).toEqual([]);
  });

  it('stops the owned container when the request is cancelled during startup', async () => {
    const { child, calls, cid } = installSpawn({ writeCid: 'late' });
    const local = createLocalGeosupportTransport(localEnv());
    const controller = new AbortController();
    const pending = local.transport({ body: requestBody, signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
    expect(child.killed).toBe(true);
    expect(calls.filter(args => args[0] === 'rm')).toEqual([['rm', '-f', cid]]);
    expect(calls.filter(args => args[0] === 'inspect')).toEqual([
      ['inspect', '-f', '{{.State.Running}}', cid],
    ]);
    expect(existsSync(calls.find(args => args[0] === 'run')[argsIndex(calls, 'run')])).toBe(false);
  });

  it('stops the owned container while waiting for native output', async () => {
    const { child, calls, cid } = installSpawn();
    const local = createLocalGeosupportTransport(localEnv());
    const controller = new AbortController();
    const pending = local.transport({ body: requestBody, signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await assertion;
    expect(child.killed).toBe(true);
    expect(calls.filter(args => args[0] === 'rm')).toEqual([['rm', '-f', cid]]);
    expect(runCalls(calls)).toHaveLength(1);
  });

  it('drops native output that arrives as the request is cancelled', async () => {
    const { calls, handlers, cid } = installSpawn();
    const local = createLocalGeosupportTransport(localEnv());
    const controller = new AbortController();
    const pending = local.transport({ body: requestBody, signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    handlers.stdout(Buffer.from(nativeLine));
    controller.abort();
    await assertion;
    expect(calls.filter(args => args[0] === 'rm')).toEqual([['rm', '-f', cid]]);
  });

  it('stops the owned container when the lookup times out with no output', async () => {
    vi.useFakeTimers();
    const { child, calls, cid } = installSpawn();
    const local = createLocalGeosupportTransport(localEnv());
    const pending = local.transport({ body: requestBody });
    const assertion = expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    await vi.advanceTimersByTimeAsync(20000);
    await assertion;
    expect(child.killed).toBe(true);
    expect(calls.filter(args => args[0] === 'rm')).toEqual([['rm', '-f', cid]]);
  });

  it('reports the container when the Docker CLI exits and the container remains', async () => {
    const { child, calls, handlers, cid } = installSpawn({ inspectRunning: true });
    const local = createLocalGeosupportTransport(localEnv());
    const pending = local.transport({ body: requestBody });
    const assertion = expect(pending).rejects.toMatchObject({
      message: expect.stringContaining(`Container ${cid} remained running.`),
      containerId: cid,
    });
    child.exitCode = 0;
    handlers.exit(0);
    await assertion;
    expect(child.killed).toBe(false);
    expect(calls.filter(args => args[0] === 'rm')).toEqual([['rm', '-f', cid]]);
  });

  it('reports a cleanup failure instead of hiding an orphaned container', async () => {
    const { calls, cid } = installSpawn({ inspectRunning: true });
    const local = createLocalGeosupportTransport(localEnv());
    const controller = new AbortController();
    const pending = local.transport({ body: requestBody, signal: controller.signal });
    const assertion = expect(pending).rejects.toMatchObject({
      message: expect.stringContaining(`Container ${cid} remained running.`),
      containerId: cid,
    });
    controller.abort();
    await assertion;
    expect(calls.some(args => args.includes('prune'))).toBe(false);
  });

  it('cancels a queued request with the same owned container', async () => {
    const { calls } = installSpawn();
    const local = createLocalGeosupportTransport(localEnv());
    const firstController = new AbortController();
    const secondController = new AbortController();
    const first = local.transport({ body: requestBody, signal: firstController.signal });
    const second = local.transport({ body: requestBody, signal: secondController.signal });
    const firstAssertion = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const secondAssertion = expect(second).rejects.toMatchObject({ name: 'AbortError' });
    firstController.abort();
    await firstAssertion;
    await secondAssertion;
    expect(runCalls(calls)).toHaveLength(1);
    expect(calls.filter(args => args[0] === 'rm')).toHaveLength(1);
  });

  it('starts a fresh owned container after a failed session', async () => {
    const { calls } = installSpawn();
    const local = createLocalGeosupportTransport(localEnv());
    const first = new AbortController();
    const firstPending = local.transport({ body: requestBody, signal: first.signal });
    const firstAssertion = expect(firstPending).rejects.toMatchObject({ name: 'AbortError' });
    first.abort();
    await firstAssertion;
    const second = new AbortController();
    const secondPending = local.transport({ body: requestBody, signal: second.signal });
    const secondAssertion = expect(secondPending).rejects.toMatchObject({ name: 'AbortError' });
    second.abort();
    await secondAssertion;
    expect(runCalls(calls)).toHaveLength(2);
    expect(calls.filter(args => args[0] === 'rm')).toHaveLength(2);
  });

  it('does not spawn Docker for an unreadable request', async () => {
    const { calls } = installSpawn();
    const local = createLocalGeosupportTransport(localEnv());
    await expect(local.transport({ body: 'not-json' })).rejects.toThrow('unreadable request');
    expect(calls).toEqual([]);
  });

  function argsIndex(calls, command) {
    const args = calls.find(entry => entry[0] === command);
    return args.indexOf('--cidfile') + 1;
  }
});
