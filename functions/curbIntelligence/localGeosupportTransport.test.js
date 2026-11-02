import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { readFileSync } = require('node:fs');
const { createPrivateBlockfaceResolver } = require('./privateBlockfaceResolver');
const {
  createLocalGeosupportTransport,
  localFunction3cAllowed,
  localStreetIntelligenceBinding,
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
    expect(runtime).toContain("localBinding.mode === 'local'");
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
});
