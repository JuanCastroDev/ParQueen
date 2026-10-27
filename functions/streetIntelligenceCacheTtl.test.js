import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const requireFromHere = createRequire(import.meta.url);
const { runCanonicalCurbOrchestrator } = requireFromHere('./curbIntelligence/canonicalCurbOrchestrator');
const { resolveCanonicalCurb } = requireFromHere('./curbIntelligence/canonicalCurbResolver');
const { createPrivateBlockfaceResolver } = requireFromHere('./curbIntelligence/privateBlockfaceResolver');
const {
  STREET_INTELLIGENCE_CACHE_TTL_MS,
  STREET_INTELLIGENCE_CACHE_FUTURE_SKEW_MS,
  createStreetIntelligenceCacheBoundary,
} = requireFromHere('./streetIntelligenceCacheTtl');

const location = Object.freeze({
  lat: 40.7,
  lng: -73.9999,
  accuracyMeters: 5,
  sampleCount: 4,
  consistencyMeters: 4,
});
const metadata = { id: 'inkn-q76z', rowsUpdatedAt: 1767225600, viewLastModified: 1767225660 };
const raw = (id, name, geometry) => ({
  globalid: id, physicalid: `${id}-physical`, b5sc: `${id}-b5sc`,
  l_blockfaceid: '1000000001', r_blockfaceid: '1000000002', boroughcode: '2', rw_type: '1',
  full_street_name: name, street_name: name, stname_label: name, streetwidth: '34',
  from_level_code: '13', to_level_code: '13', status: '2', nonped: '', accessible: '',
  from_street: 'WHITE PLAINS ROAD', to_street: 'LURTING AVENUE', the_geom: geometry,
});
const line = {
  type: 'MultiLineString',
  coordinates: [[[-74.001, 40.69992], [-73.999, 40.69992]]],
};

function memoryDb() {
  const docs = new Map();
  return {
    docs,
    doc(path) {
      return {
        path,
        async get() {
          return { exists: docs.has(path), data: () => docs.get(path) };
        },
      };
    },
    batch() {
      const ops = [];
      return {
        set(ref, data) { ops.push([ref.path, data]); },
        async commit() {
          for (const [path, data] of ops) docs.set(path, data);
        },
      };
    },
  };
}

function clockAt(start) {
  let now = start;
  return {
    get now() { return now; },
    set now(value) { now = value; },
    Timestamp: {
      now: () => {
        const captured = now;
        return { toMillis: () => captured };
      },
    },
  };
}

function proofResolver() {
  const transport = vi.fn(async () => ({
    status: 200,
    text: async () => JSON.stringify({
      ok: true,
      officialBlockFaceId: '1000000001',
      normalizedStreetNames: {
        onStreet: 'MARAN PLACE',
        crossStreetOne: 'WHITE PLAINS ROAD',
        crossStreetTwo: 'LURTING AVENUE',
      },
      returnCode: '00',
      reasonCode: ' ',
      sourceVersion: { geosupportRelease: 'release-a', geosupportVersion: '1' },
    }),
  }));
  return {
    transport,
    blockfaceResolver: createPrivateBlockfaceResolver({
      mode: 'shadow',
      serviceUrl: 'https://parqueen-test-resolver-uc.a.run.app',
      getIdToken: vi.fn(async () => 'synthetic-token'),
      transport,
    }),
  };
}

let authenticPrimary;

beforeAll(async () => {
  authenticPrimary = await resolveCanonicalCurb(location, {
    fetchFn: vi.fn(async url => ({
      ok: true,
      json: async () => (String(url).includes('/api/views/') ? metadata : [raw('private-global', 'MARAN PLACE', line)]),
    })),
    requestNonce: 'server-nonce',
  });
});

function rules() {
  return vi.fn(async () => ({
    state: 'complete',
    selected: {
      rules: [], cleaning: null, restrictions: [], timeLimits: [], meter: null, admin: [], conflicts: [],
    },
    sources: {},
  }));
}

async function resolveWith(boundary, db, clock, resolveResult, extra = {}) {
  const proof = proofResolver();
  const seen = [];
  const result = await runCanonicalCurbOrchestrator({ protocolVersion: 2, location }, {
    db,
    Timestamp: clock.Timestamp,
    resolveCanonicalCurb: vi.fn(async () => resolveResult),
    blockfaceResolver: proof.blockfaceResolver,
    readCanonicalCache: async (input) => {
      const cache = await boundary.readCanonicalCache(input);
      seen.push(cache);
      return cache;
    },
    persistCanonicalCurb: boundary.persistCanonicalCurb,
    loadCanonicalRules: rules(),
    inFlight: new Map(),
    ...extra,
  });
  return { result, proof, seen };
}

describe('Street Intelligence product cache TTL', () => {
  it('freezes a named one-day TTL and an inclusive boundary', () => {
    expect(STREET_INTELLIGENCE_CACHE_TTL_MS).toBe(86400000);
    expect(STREET_INTELLIGENCE_CACHE_FUTURE_SKEW_MS).toBe(120000);
  });

  it('accepts a fresh cache entry that already passed proof and source checks', async () => {
    const db = memoryDb();
    const clock = clockAt(1_700_000_000_000);
    const boundary = createStreetIntelligenceCacheBoundary({ Timestamp: clock.Timestamp });
    const first = await resolveWith(boundary, db, clock, authenticPrimary);
    expect(first.result.status).toBe('high_confidence');
    expect(first.seen.at(-1).hit).toBe(false);
    const second = await resolveWith(boundary, db, clock, authenticPrimary);
    expect(second.seen.at(-1).hit).toBe(true);
    expect(second.result.status).toBe('high_confidence');
    expect(second.proof.transport).toHaveBeenCalledTimes(1);
  });

  it('keeps an entry eligible at exactly the TTL and rejects one millisecond past it', async () => {
    const db = memoryDb();
    const clock = clockAt(1_700_000_000_000);
    const boundary = createStreetIntelligenceCacheBoundary({ Timestamp: clock.Timestamp });
    await resolveWith(boundary, db, clock, authenticPrimary);
    clock.now += STREET_INTELLIGENCE_CACHE_TTL_MS;
    const atBoundary = await resolveWith(boundary, db, clock, authenticPrimary);
    expect(atBoundary.seen.at(-1).hit).toBe(true);
    clock.now += 1;
    const past = await resolveWith(boundary, db, clock, authenticPrimary);
    expect(past.seen.at(-1)).toEqual({ hit: false, reason: 'cache_expired' });
    expect(past.result.status).toBe('high_confidence');
    expect(past.proof.transport).toHaveBeenCalledTimes(1);
  });

  it('rejects a missing, malformed, or future cache timestamp', async () => {
    const db = memoryDb();
    const clock = clockAt(1_700_000_000_000);
    const boundary = createStreetIntelligenceCacheBoundary({ Timestamp: clock.Timestamp });
    await resolveWith(boundary, db, clock, authenticPrimary);
    const segment = [...db.docs.keys()].find(path => path.startsWith('streetSegments/'));

    db.docs.get(segment).updatedAt = undefined;
    const missing = await resolveWith(boundary, db, clock, authenticPrimary);
    expect(missing.seen.at(-1).reason).toBe('cache_expired');

    db.docs.get(segment).updatedAt = 'yesterday';
    const malformed = await resolveWith(boundary, db, clock, authenticPrimary);
    expect(malformed.seen.at(-1).reason).toBe('cache_expired');

    db.docs.get(segment).updatedAt = { toMillis: () => Number.POSITIVE_INFINITY };
    const nonFinite = await resolveWith(boundary, db, clock, authenticPrimary);
    expect(nonFinite.seen.at(-1).reason).toBe('cache_expired');

    db.docs.get(segment).updatedAt = { toMillis: () => clock.now + STREET_INTELLIGENCE_CACHE_FUTURE_SKEW_MS + 1 };
    const future = await resolveWith(boundary, db, clock, authenticPrimary);
    expect(future.seen.at(-1).reason).toBe('cache_expired');
  });

  it('rejects a fresh entry when the source version or proof does not match', async () => {
    const db = memoryDb();
    const clock = clockAt(1_700_000_000_000);
    const boundary = createStreetIntelligenceCacheBoundary({ Timestamp: clock.Timestamp });
    await resolveWith(boundary, db, clock, authenticPrimary);
    const identityPath = [...db.docs.keys()].find(path => path.startsWith('curbIdentities/'));
    const stored = db.docs.get(identityPath);
    stored.identity = {
      ...stored.identity,
      sourceVersion: { ...stored.identity.sourceVersion, version: 'other-version' },
    };
    const mismatch = await resolveWith(boundary, db, clock, authenticPrimary);
    expect(mismatch.seen.at(-1).hit).toBe(false);
    expect(mismatch.seen.at(-1).reason).toBe('cache_curb_mismatch');

    const unproven = await boundary.readCanonicalCache({
      db,
      topologyResult: authenticPrimary,
      identityProof: null,
    });
    expect(unproven).toEqual({ hit: false, reason: 'identity_proof_invalid' });
  });

  it('does not treat an expired entry as authoritative and still requires a new proof', async () => {
    const db = memoryDb();
    const clock = clockAt(1_700_000_000_000);
    const boundary = createStreetIntelligenceCacheBoundary({ Timestamp: clock.Timestamp });
    await resolveWith(boundary, db, clock, authenticPrimary);
    clock.now += STREET_INTELLIGENCE_CACHE_TTL_MS + 1;
    const expired = await resolveWith(boundary, db, clock, authenticPrimary);
    expect(expired.seen.at(-1).hit).toBe(false);
    expect(expired.proof.transport).toHaveBeenCalledTimes(1);
    expect(expired.result.segmentId).toMatch(/^curb2_[a-f0-9]{32}$/);
  });

  it('does not refresh cache authority when resolution fails', async () => {
    const db = memoryDb();
    const clock = clockAt(1_700_000_000_000);
    const boundary = createStreetIntelligenceCacheBoundary({ Timestamp: clock.Timestamp });
    const persist = vi.fn(boundary.persistCanonicalCurb);
    const failed = await runCanonicalCurbOrchestrator({ protocolVersion: 2, location }, {
      db,
      Timestamp: clock.Timestamp,
      resolveCanonicalCurb: vi.fn(async () => ({ state: 'UNSUPPORTED', reason: 'candidate_incomplete' })),
      readCanonicalCache: boundary.readCanonicalCache,
      persistCanonicalCurb: persist,
      inFlight: new Map(),
    });
    expect(failed.status).toBe('unsupported');
    expect(persist).not.toHaveBeenCalled();
    expect(db.docs.size).toBe(0);
  });

  it('writes a server timestamp only through a successful frozen persist', async () => {
    const db = memoryDb();
    const clock = clockAt(1_700_000_000_000);
    const boundary = createStreetIntelligenceCacheBoundary({ Timestamp: clock.Timestamp });
    await resolveWith(boundary, db, clock, authenticPrimary);
    const segment = [...db.docs.values()].find(doc => doc.segmentId);
    expect(segment.updatedAt.toMillis()).toBe(clock.now);
    const before = segment.updatedAt.toMillis();
    clock.now += 1000;
    const refused = await boundary.persistCanonicalCurb({
      db,
      Timestamp: clock.Timestamp,
      topologyResult: authenticPrimary,
      identityProof: { forged: true },
      selectedRules: { rules: [] },
    });
    expect(refused.success).toBe(false);
    expect(segment.updatedAt.toMillis()).toBe(before);
  });

  it('fails closed when trusted server time is unavailable', async () => {
    const boundary = createStreetIntelligenceCacheBoundary({
      Timestamp: { now: () => ({ toMillis: () => Number.NaN }) },
      readCanonicalCache: async () => ({
        hit: true,
        publicSegment: { updatedAt: { toMillis: () => 1_700_000_000_000 } },
      }),
    });
    await expect(boundary.readCanonicalCache({})).resolves.toEqual({
      hit: false,
      reason: 'cache_clock_unavailable',
    });
  });
});
