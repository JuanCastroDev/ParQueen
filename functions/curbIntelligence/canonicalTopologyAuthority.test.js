import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  resolveCanonicalCurb, hasPrimaryTopologyAuthority, hasAmbiguousTopologyAuthority,
} = require('./canonicalCurbResolver');
const { runCanonicalCurbOrchestrator } = require('./canonicalCurbOrchestrator');
const { applyVisualCurbSelection } = require('./visualCurbSelection');
const { readCanonicalCache, persistCanonicalCurb } = require('./canonicalCurbPersistence');

function recursiveFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(recursiveFreeze);
  return Object.freeze(value);
}

function csclRow(overrides = {}) {
  const globalid = overrides.globalid || 'horizontal-road';
  return {
    globalid,
    physicalid: overrides.physicalid || `${globalid}-physical`,
    l_blockfaceid: overrides.l_blockfaceid || '1000000001',
    r_blockfaceid: overrides.r_blockfaceid || '1000000002',
    boroughcode: '2',
    b5sc: overrides.b5sc || `${globalid}-b5sc`,
    rw_type: '1',
    full_street_name: overrides.full_street_name || 'HORIZONTAL ROAD',
    street_name: overrides.full_street_name || 'HORIZONTAL ROAD',
    stname_label: overrides.full_street_name || 'Horizontal Road',
    streetwidth: overrides.streetwidth || '34',
    from_level_code: '13',
    to_level_code: '13',
    accessible: '',
    nonped: '',
    status: '2',
    from_street: 'WEST CROSS STREET',
    to_street: 'EAST CROSS STREET',
    the_geom: {
      type: 'MultiLineString',
      coordinates: overrides.coordinates || [[[-74.001, 40.7], [-73.999, 40.7]]],
    },
  };
}

const horizontal = csclRow();
const vertical = csclRow({
  globalid: 'vertical-road',
  l_blockfaceid: '2000000001',
  r_blockfaceid: '2000000002',
  full_street_name: 'VERTICAL ROAD',
  coordinates: [[[-74, 40.699], [-74, 40.701]]],
});

const location = () => ({
  lat: 40.70005,
  lng: -73.99995,
  accuracyMeters: 1,
  sampleCount: 3,
  consistencyMeters: 2,
});

const noPlanimetric = () => ({
  queryCurbs: vi.fn(async () => ({
    candidates: [],
    completeness: { state: 'COMPLETE', reason: null },
    sourceVersion: { resourceId: '5xvt-8cbk', version: 'fixture-plan-v1' },
  })),
});

const metadata = Object.freeze({ id: 'inkn-q76z', rowsUpdatedAt: 1767225600, viewLastModified: 1767225660 });
const fetchFor = candidates => vi.fn(async url => ({
  ok: true,
  json: async () => String(url).includes('/api/views/') ? metadata : candidates,
}));

describe('canonical topology authority regressions', () => {
  it('current within_circle omission changes the canonical authority conclusion', async () => {
    const complete = await resolveCanonicalCurb(location(), {
      fetchFn: fetchFor([horizontal, vertical]),
      planimetricStore: noPlanimetric(),
      requestNonce: 'complete-population-control',
    });
    const callerCreatedPartialStore = {
      queryCandidates: vi.fn(async () => ({
        candidates: [], completeness: { state: 'COMPLETE', reason: null },
      })),
    };
    const result = await resolveCanonicalCurb(location(), {
      candidateStore: callerCreatedPartialStore,
      planimetricStore: noPlanimetric(),
      requestNonce: 'within-circle-omission-red',
    });

    expect(complete).toMatchObject({ state: 'AMBIGUOUS' });
    expect(complete.candidates).toHaveLength(2);
    expect(result).toMatchObject({ state: 'UNSUPPORTED', reasons: ['authority_attestation_invalid'] });
  });

  it('planimetric evidence cannot promote an ambiguous CSCL population to primary', async () => {
    const fetchFn = fetchFor([horizontal, vertical]);
    const planimetricStore = {
      queryCurbs: vi.fn(async () => ({
        candidates: [{
          curbId: 'favored-horizontal-curb',
          geometry: {
            type: 'MultiLineString',
            coordinates: [[[-74.0002, 40.70004], [-73.9998, 40.70004]]],
          },
        }],
        completeness: { state: 'COMPLETE', reason: null },
        sourceVersion: { resourceId: '5xvt-8cbk', version: 'fixture-plan-v1' },
      })),
    };

    const result = await resolveCanonicalCurb({
      ...location(), lat: 40.70004, lng: -73.99997, accuracyMeters: 3,
    }, {
      fetchFn,
      planimetricStore,
      requestNonce: 'planimetric-escalation-red',
    });

    expect(result.state).not.toBe('SUPPORTED');
    expect(result).toMatchObject({ state: 'AMBIGUOUS' });
    expect(result.candidates).toHaveLength(2);
    expect(hasAmbiguousTopologyAuthority(result)).toBe(true);
  });

  it('visual selection cannot promote a member that fails geometry plausibility', async () => {
    const narrowHorizontal = csclRow({
      globalid: 'horizontal',
      physicalid: 'horizontal',
      b5sc: 'horizontal',
      full_street_name: 'horizontal',
      streetwidth: '1',
    });
    const validVertical = csclRow({
      globalid: 'vertical',
      physicalid: 'vertical',
      b5sc: 'vertical',
      l_blockfaceid: '2000000001',
      r_blockfaceid: '2000000002',
      full_street_name: 'vertical',
      coordinates: [[[-74, 40.699], [-74, 40.701]]],
    });
    const point = location();
    const alone = await resolveCanonicalCurb(point, {
      fetchFn: fetchFor([narrowHorizontal]), requestNonce: 'geometry-review',
    });
    const mixed = await resolveCanonicalCurb(point, {
      fetchFn: fetchFor([narrowHorizontal, validVertical]), requestNonce: 'geometry-review',
    });
    const token = mixed.candidates.find(candidate => candidate.streetName === 'horizontal')?.token;
    const promoted = await applyVisualCurbSelection({ location: point, candidateToken: token }, {
      fetchFn: fetchFor([narrowHorizontal, validVertical]),
    });

    expect(alone).toMatchObject({ state: 'UNSUPPORTED', reasons: ['implausible_geometry'] });
    expect(mixed.state).toBe('AMBIGUOUS');
    expect(promoted.state).toBe('UNSUPPORTED');
    expect(hasPrimaryTopologyAuthority(promoted)).toBe(false);
  });

  it('does not transfer production topology authority through copies or reconstruction', async () => {
    const result = await resolveCanonicalCurb({
      ...location(), lat: 40.70008, lng: -73.9995,
    }, {
      fetchFn: fetchFor([horizontal]), requestNonce: 'authority-original',
    });
    expect(result.state).toBe('SUPPORTED');
    expect(hasPrimaryTopologyAuthority(result)).toBe(true);
    expect(hasPrimaryTopologyAuthority({ ...result })).toBe(false);
    const deepCopy = JSON.parse(JSON.stringify(result));
    expect(hasPrimaryTopologyAuthority(deepCopy)).toBe(false);
    expect(hasPrimaryTopologyAuthority(recursiveFreeze(deepCopy))).toBe(false);
    expect(hasPrimaryTopologyAuthority(Object.freeze({ ...result }))).toBe(false);
    expect(hasPrimaryTopologyAuthority(recursiveFreeze({
      state: 'SUPPORTED', reasons: [], identity: result.identity, publicCurb: result.publicCurb,
    }))).toBe(false);
    if (typeof structuredClone === 'function') {
      expect(hasPrimaryTopologyAuthority(structuredClone(result))).toBe(false);
    }
  });

  it('rejects an exact result minted by an isolated unauthorized owner instance', async () => {
    const modulePath = require.resolve('./canonicalCurbResolver');
    const canonicalEntry = require.cache[modulePath];
    delete require.cache[modulePath];
    let foreign;
    try {
      const isolatedOwner = require('./canonicalCurbResolver');
      foreign = await isolatedOwner.resolveCanonicalCurb({
        ...location(), lat: 40.70008, lng: -73.9995,
      }, { fetchFn: fetchFor([horizontal]), requestNonce: 'foreign-owner' });
      expect(isolatedOwner.hasPrimaryTopologyAuthority(foreign)).toBe(true);
    } finally {
      require.cache[modulePath] = canonicalEntry;
    }
    expect(hasPrimaryTopologyAuthority(foreign)).toBe(false);
    const readCanonicalCacheSeam = vi.fn();
    const persistCanonicalCurbSeam = vi.fn();
    await expect(runCanonicalCurbOrchestrator({
      protocolVersion: 2,
      location: { ...location(), lat: 40.70008, lng: -73.9995 },
    }, {
      resolveCanonicalCurb: vi.fn(async () => foreign),
      readCanonicalCache: readCanonicalCacheSeam,
      persistCanonicalCurb: persistCanonicalCurbSeam,
      loadCanonicalRules: vi.fn(),
      inFlight: new Map(),
    })).resolves.toEqual({ protocolVersion: 2, status: 'unsupported', reason: 'source_unavailable' });
    expect(readCanonicalCacheSeam).not.toHaveBeenCalled();
    expect(persistCanonicalCurbSeam).not.toHaveBeenCalled();

    const db = { doc: vi.fn(), batch: vi.fn() };
    await expect(readCanonicalCache({ db, topologyResult: foreign }))
      .resolves.toEqual({ hit: false, reason: 'authority_invalid' });
    await expect(persistCanonicalCurb({
      db, Timestamp: { now: vi.fn() }, topologyResult: foreign, selectedRules: { rules: [] },
    })).resolves.toEqual({ success: false, reason: 'authority_invalid' });
    expect(db.doc).not.toHaveBeenCalled();
    expect(db.batch).not.toHaveBeenCalled();
  });
});
