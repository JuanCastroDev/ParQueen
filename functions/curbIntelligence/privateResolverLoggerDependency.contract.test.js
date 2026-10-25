'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RESULT_PREFIX = 'RC03G_DEPENDENCY_RESULT:';

describe('private resolver logger cold dependency contract', () => {
  it('keeps an ordinary sample-zero early exit free of root Firebase provider loading', () => {
    const compositionPath = path.resolve(__dirname, 'privateResolverComposition.js');
    const childSource = String.raw`
      'use strict';
      const Module = require('node:module');
      const originalLoad = Module._load;
      const originalResolve = Module._resolveFilename;
      const loads = [];
      Module._load = function observedLoad(request, parent, isMain) {
        let resolved = null;
        try { resolved = originalResolve.call(Module, request, parent, isMain); } catch {}
        loads.push({ request, resolved, parent: parent?.filename || null });
        return originalLoad.call(this, request, parent, isMain);
      };

      (async () => {
        const { observePrivateResolverShadow } = require(process.argv[1]);
        const productionResult = { success: true, segmentId: 'ordinary-sample-zero' };
        const counters = {
          sourceFactory: 0,
          resolverFactory: 0,
          relationshipFactory: 0,
          shadow: 0,
          sweepShadow: 0,
        };
        const result = await observePrivateResolverShadow({
          productionResult,
          location: { lat: 40.712, lng: -74.006, accuracyMeters: 10 },
          productionPath: 'nyc_open_data_fallback',
        }, {
          readConfig: () => ({
            mode: 'shadow',
            serviceUrl: 'https://private.invalid',
            samplePermille: 0,
            productPath: 'off',
          }),
          operatorAuthorized: false,
          sourceDependenciesFactory: () => {
            counters.sourceFactory += 1;
            throw new Error('source factory must remain unconstructed');
          },
          resolverFactory: () => {
            counters.resolverFactory += 1;
            throw new Error('resolver must remain unconstructed');
          },
          relationshipProviderFactory: () => {
            counters.relationshipFactory += 1;
            throw new Error('relationship provider must remain unconstructed');
          },
          runShadow: async () => {
            counters.shadow += 1;
            throw new Error('shadow must not run');
          },
          runSweepSideResolution: async () => {
            counters.sweepShadow += 1;
            throw new Error('sweep shadow must not run');
          },
        });

        const forbiddenLoads = loads.filter(({ request, resolved }) =>
          request === 'firebase-functions'
          || request === 'firebase-admin'
          || request.startsWith('firebase-admin/')
          || request === '@google-cloud/firestore'
          || request.startsWith('@google-cloud/firestore/')
          || /[\\/]node_modules[\\/]firebase-admin[\\/]/.test(resolved || '')
          || /[\\/]node_modules[\\/]@google-cloud[\\/]firestore[\\/]/.test(resolved || '')
          || /firebase-functions[\\/]lib[\\/]v2[\\/]providers[\\/]firestore/.test(resolved || '')
        );
        const payload = {
          sameResultReference: result === productionResult,
          counters,
          loadedFirebaseFunctionsLoggerSubpath: loads.some(item => item.request === 'firebase-functions/logger'),
          loadedFirebaseFunctionsRoot: loads.some(item => item.request === 'firebase-functions'),
          forbiddenLoads,
          observedLoadCount: loads.length,
        };
        process.stdout.write('${RESULT_PREFIX}' + JSON.stringify(payload) + '\n');
      })().catch(error => {
        process.stderr.write(error.stack + '\n');
        process.exitCode = 1;
      });
    `;

    const execution = spawnSync(process.execPath, ['-e', childSource, compositionPath], {
      cwd: path.resolve(__dirname, '..', '..'),
      encoding: 'utf8',
      env: {
        ...process.env,
        GCLOUD_PROJECT: 'demo-functions-discovery',
        GOOGLE_CLOUD_PROJECT: 'demo-functions-discovery',
        FIREBASE_CONFIG: JSON.stringify({ projectId: 'demo-functions-discovery' }),
      },
      maxBuffer: 4 * 1024 * 1024,
    });

    expect(execution.status, execution.stderr).toBe(0);
    const lines = execution.stdout.trim().split(/\r?\n/);
    const resultLine = lines.find(line => line.startsWith(RESULT_PREFIX));
    expect(resultLine, execution.stdout).toBeTruthy();
    const result = JSON.parse(resultLine.slice(RESULT_PREFIX.length));
    const structuredLogs = lines.slice(0, lines.indexOf(resultLine)).map(line => JSON.parse(line));

    expect(result.sameResultReference).toBe(true);
    expect(result.counters).toEqual({
      sourceFactory: 0,
      resolverFactory: 0,
      relationshipFactory: 0,
      shadow: 0,
      sweepShadow: 0,
    });
    expect(structuredLogs).toContainEqual(expect.objectContaining({
      event: 'curb_product_skip',
      reason: 'product_path_off',
      severity: 'INFO',
    }));
    expect(result.loadedFirebaseFunctionsLoggerSubpath).toBe(true);
    expect(result.loadedFirebaseFunctionsRoot).toBe(false);
    expect(result.forbiddenLoads).toEqual([]);
  });
});
