import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { runCanonicalCurbOrchestrator } = require('./canonicalCurbOrchestrator');
const { publicCurbKey, toPublicCurb } = require('./canonicalCurbIdentity');
const { createPrivateBlockfaceResolver } = require('./privateBlockfaceResolver');
const { resolveCanonicalCurb } = require('./canonicalCurbResolver');

const identity = Object.freeze({
  schemaVersion: 2,
  jurisdiction: 'NYC',
  officialBlockFaceId: '1000000001',
  csclSide: 'LEFT',
  sourceVersion: { resourceId: 'inkn-q76z', version: 'orchestrator-v1' },
  roadway: {
    selectedGlobalId: 'private-global',
    supportingGlobalIds: ['private-global'],
    physicalId: 'private-physical',
    b5sc: 'private-b5sc',
    geometry: { type: 'MultiLineString', coordinates: [[[-74, 40.7], [-73.999, 40.7]]] },
    streetWidthFeet: 34,
  },
  names: {
    borough: 'Bronx', onStreet: 'MARAN PLACE',
    fromStreet: 'WHITE PLAINS ROAD', toStreet: 'LURTING AVENUE', aliases: [],
  },
  side: { cardinal: 'North' },
  resolution: { method: 'automatic', evidenceVersion: 'curb-v2' },
});
const location = Object.freeze({
  lat: 40.7, lng: -73.9999, accuracyMeters: 5, sampleCount: 4, consistencyMeters: 4,
});
const selectedRules = Object.freeze({
  rules: [{ category: 'cleaning', source: 'dot', schedules: [{ days: ['Mon'], startTime: '08:00', endTime: '09:30', side: 'North' }] }],
  cleaning: { category: 'cleaning', source: 'dot', schedules: [{ days: ['Mon'], startTime: '08:00', endTime: '09:30', side: 'North' }] },
  restrictions: [], timeLimits: [], meter: null, admin: [], conflicts: [],
});
const supported = () => ({ state: 'SUPPORTED', identity, publicCurb: toPublicCurb(identity), reasons: [] });

function function3c(officialBlockFaceId = '1000000001') {
  const transport = vi.fn(async () => ({
    status: 200,
    text: async () => JSON.stringify({
      ok: true,
      officialBlockFaceId,
      normalizedStreetNames: {
        onStreet: 'MARAN PLACE',
        crossStreetOne: 'WHITE PLAINS ROAD',
        crossStreetTwo: 'LURTING AVENUE',
      },
      returnCode: '00', reasonCode: ' ',
      sourceVersion: { geosupportRelease: '26C', geosupportVersion: '26.3' },
    }),
  }));
  return {
    blockfaceResolver: createPrivateBlockfaceResolver({
      mode: 'shadow', serviceUrl: 'https://parqueen-test-resolver-uc.a.run.app',
      getIdToken: vi.fn(async () => 'synthetic-token'), transport,
    }),
  };
}

const metadata = { id: 'inkn-q76z', rowsUpdatedAt: 1767225600, viewLastModified: 1767225660 };
const raw = (id, name, geometry, left = '1000000001', right = '1000000002') => ({
  globalid: id, physicalid: `${id}-physical`, b5sc: `${id}-b5sc`,
  l_blockfaceid: left, r_blockfaceid: right, boroughcode: '2', rw_type: '1',
  full_street_name: name, street_name: name, stname_label: name, streetwidth: '34',
  from_level_code: '13', to_level_code: '13', status: '2', nonped: '', accessible: '',
  from_street: 'WHITE PLAINS ROAD', to_street: 'LURTING AVENUE', the_geom: geometry,
});
const fetchFor = rows => vi.fn(async url => ({ ok: true, json: async () => (
  String(url).includes('/api/views/') ? metadata : rows
) }));
let authenticPrimary;
beforeAll(async () => {
  authenticPrimary = await resolveCanonicalCurb(location, {
    fetchFn: fetchFor([raw('private-global', 'MARAN PLACE', {
      type: 'MultiLineString', coordinates: [[[-74.001, 40.69992], [-73.999, 40.69992]]],
    })]), requestNonce: 'server-nonce',
  });
});

function dependencies(overrides = {}) {
  const writes = [];
  const proof = function3c();
  return {
    writes,
    resolveCanonicalCurb: vi.fn(async () => authenticPrimary),
    applyVisualCurbSelection: vi.fn(async () => supported()),
    loadCanonicalRules: vi.fn(async () => ({
      state: 'complete',
      selected: selectedRules,
      sources: { dot: { state: 'complete' } },
    })),
    readCanonicalCache: vi.fn(async () => ({ hit: false, reason: 'exact_identity_missing' })),
    persistCanonicalCurb: vi.fn(async (input) => {
      writes.push(input);
      return { success: true };
    }),
    db: {
      writes,
      doc(path) { return { path, set() { writes.push({ path }); }, async get() { return { exists: false, data: () => null }; } }; },
      batch() { return { set(ref) { writes.push({ path: ref.path }); }, async commit() {} }; },
      async runTransaction() { writes.push({ path: 'transaction' }); },
    },
    requestNonceFactory: () => 'server-nonce',
    inFlight: new Map(),
    telemetry: { emit: vi.fn() },
    blockfaceResolver: proof.blockfaceResolver,
    ...overrides,
  };
}

describe('A1 response-only user resolution', () => {
  it('returns high_confidence without calling persist or writing collections', async () => {
    const deps = dependencies();
    const result = await runCanonicalCurbOrchestrator({ protocolVersion: 2, location }, deps);
    expect(result.status).toBe('high_confidence');
    expect(result.segmentId).toBe(publicCurbKey(authenticPrimary.identity));
    expect(deps.persistCanonicalCurb).not.toHaveBeenCalled();
    expect(deps.writes).toEqual([]);
    expect(Object.keys(result).sort()).toEqual([
      'protocolVersion', 'ruleSummary', 'segmentId', 'sideLabel', 'status', 'streetName',
    ].sort());
  });

  it('uses the same extended contract for fresh results and trusted cache hits', async () => {
    const freshDeps = dependencies();
    const fresh = await runCanonicalCurbOrchestrator({ protocolVersion: 2, responseVersion: 1, location }, freshDeps);
    expect(fresh.status).toBe('high_confidence');
    expect(fresh.responseVersion).toBe(1);
    expect(fresh.cacheHit).toBe(false);
    expect(fresh.publicRules[0]).toMatchObject({ type: 'streetCleaning', source: 'nyc_open_data' });
    expect(fresh.publicSchedules.cleaning[0]).toMatchObject({ days: ['Mon'], startTime: '08:00' });
    expect(freshDeps.persistCanonicalCurb).not.toHaveBeenCalled();

    const cachedRules = [{ category: 'cleaning', type: 'streetCleaning', source: 'nyc_open_data', schedules: [{ days: ['Mon'], startTime: '08:00', endTime: '09:30' }] }];
    const cacheDeps = dependencies({
      readCanonicalCache: vi.fn(async () => ({
        hit: true,
        publicSegment: { ...toPublicCurb(identity), ruleSummary: { cleaningAvailable: true, rulesResolved: true } },
        publicRules: cachedRules,
      })),
    });
    const cached = await runCanonicalCurbOrchestrator({ protocolVersion: 2, responseVersion: 1, location }, cacheDeps);
    expect(cached.status).toBe('high_confidence');
    expect(cached.responseVersion).toBe(1);
    expect(cached.cacheHit).toBe(true);
    expect(cached.publicSchedules.cleaning).toHaveLength(1);
    expect(cacheDeps.persistCanonicalCurb).not.toHaveBeenCalled();
    expect(cacheDeps.loadCanonicalRules).not.toHaveBeenCalled();
  });

  it('does not persist after timeout, cancellation, source failure, or conflicting rules', async () => {
    const timeoutDeps = dependencies();
    const timedController = new AbortController();
    timedController.abort();
    const timed = await runCanonicalCurbOrchestrator(
      { protocolVersion: 2, location },
      {
        ...timeoutDeps,
        signal: timedController.signal,
        deadlineAt: Date.now() - 1,
        persistAllowed: () => false,
        persistToken: 'expired',
      },
    );
    expect(timed.status).toBe('unsupported');
    expect(timeoutDeps.persistCanonicalCurb).not.toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort();
    const cancelDeps = dependencies();
    const cancelled = await runCanonicalCurbOrchestrator(
      { protocolVersion: 2, location },
      { ...cancelDeps, signal: controller.signal },
    );
    expect(cancelled.status).toBe('unsupported');
    expect(cancelDeps.persistCanonicalCurb).not.toHaveBeenCalled();

    const failDeps = dependencies({
      loadCanonicalRules: vi.fn(async () => { throw new Error('dot down'); }),
    });
    // loadSelectedRules catches and continues with empty selected; no persist
    const failed = await runCanonicalCurbOrchestrator({ protocolVersion: 2, location }, failDeps);
    expect(failDeps.persistCanonicalCurb).not.toHaveBeenCalled();
    expect(failed.status).toBe('unsupported');

    const conflictDeps = dependencies({
      loadCanonicalRules: vi.fn(async () => ({
        state: 'complete',
        selected: { ...selectedRules, conflicts: [{ category: 'cleaning', sources: ['dot', 'sweepNyc'] }] },
        sources: { dot: { state: 'complete' } },
      })),
    });
    const conflicted = await runCanonicalCurbOrchestrator({ protocolVersion: 2, location }, conflictDeps);
    expect(conflicted).toEqual({ protocolVersion: 2, status: 'unsupported', reason: 'source_unavailable' });
    expect(conflictDeps.persistCanonicalCurb).not.toHaveBeenCalled();
  });
});
