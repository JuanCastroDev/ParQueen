'use strict';

const Module = require('node:module');

const HEAVY_CANONICAL_MODULES = [
  'canonicalCurbOrchestrator.js',
  'csclSocrataAdapter.js',
  'planimetricCurbAdapter.js',
  'parkNycSocrataAdapter.js',
  'privateBlockfaceResolver.js',
  'privateBlockfaceResolverConfig.js',
  'curbTelemetry.js',
];

function loaderApi() {
  try {
    return require('./canonicalV2ModuleLoader');
  } catch {
    return {};
  }
}

describe('canonical V2 module discovery boundary', () => {
  it('does not load the canonical V2 dependency graph while importing functions/index.js', () => {
    process.env.GCLOUD_PROJECT = 'demo-functions-discovery';
    process.env.FIREBASE_CONFIG = JSON.stringify({
      projectId: 'demo-functions-discovery',
      storageBucket: 'demo-functions-discovery.appspot.com',
    });

    const originalLoad = Module._load;
    const directCanonicalLoads = [];
    Module._load = function trackedLoad(request, parent, isMain) {
      if (parent?.filename?.endsWith('index.js')
        && HEAVY_CANONICAL_MODULES.some(name => request.endsWith(name.replace('.js', '')))) {
        directCanonicalLoads.push(request);
      }
      return originalLoad.call(this, request, parent, isMain);
    };
    try {
      require('../index.js');
    } finally {
      Module._load = originalLoad;
    }

    expect(directCanonicalLoads).toEqual([]);
  });

  it('initializes the canonical graph once and reuses it for later V2 requests', () => {
    const { createCanonicalV2ModuleLoader } = loaderApi();
    expect(typeof createCanonicalV2ModuleLoader).toBe('function');
    let loadCount = 0;
    const modules = { runCanonicalCurbOrchestrator: () => 'ok' };
    const loader = createCanonicalV2ModuleLoader(() => {
      loadCount += 1;
      return modules;
    });

    expect(loadCount).toBe(0);
    expect(loader.get()).toBe(modules);
    expect(loader.get()).toBe(modules);
    expect(loader.initialize()).toBe(modules);
    expect(loadCount).toBe(1);
  });

  it('keeps legacy requests away from canonical initialization', () => {
    const { selectCanonicalV2Handler } = loaderApi();
    expect(typeof selectCanonicalV2Handler).toBe('function');
    const fallback = () => 'v2';
    expect(selectCanonicalV2Handler({}, null, fallback)).toBeNull();
    expect(selectCanonicalV2Handler({ protocolVersion: 1 }, null, fallback)).toBeNull();
  });

  it('preserves the callable hook without initializing production V2 modules', () => {
    const { selectCanonicalV2Handler } = loaderApi();
    expect(typeof selectCanonicalV2Handler).toBe('function');
    const hook = () => 'hook';
    const fallback = () => 'fallback';
    expect(selectCanonicalV2Handler({ protocolVersion: 2 }, hook, fallback)).toBe(hook);
  });
});
