import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { createPrivateBlockfaceResolver } = require('./privateBlockfaceResolver');
const { createLocalGeosupportTransport, localFunction3cAllowed } = require('./localGeosupportTransport');

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
});
