import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  readCanonicalCache,
  persistCanonicalCurb,
  migrateCompatibleLegacyRules,
  canonicalGeometry,
} = require('./canonicalCurbPersistence');
const { publicCurbKey } = require('./canonicalCurbIdentity');
const { resolveCanonicalCurb } = require('./canonicalCurbResolver');
const { createPrivateBlockfaceResolver } = require('./privateBlockfaceResolver');
const { proveCanonicalCurbIdentity } = require('./canonicalCurbIdentityProof');

const identity = (overrides = {}) => ({
  schemaVersion: 2,
  jurisdiction: 'NYC',
  officialBlockFaceId: '1000000001',
  csclSide: 'LEFT',
  sourceVersion: { resourceId: 'inkn-q76z', version: 'fixture-v2' },
  roadway: {
    selectedGlobalId: 'private-global',
    supportingGlobalIds: ['private-global'],
    physicalId: 'private-physical',
    b5sc: 'private-b5sc',
    geometry: { type: 'MultiLineString', coordinates: [[[-74, 40.7], [-73.999, 40.7]]] },
    streetWidthFeet: 34,
  },
  names: {
    borough: 'Bronx',
    onStreet: 'MARAN PLACE',
    fromStreet: 'WHITE PLAINS ROAD',
    toStreet: 'LURTING AVENUE',
    aliases: ['MARAN PL'],
  },
  side: { cardinal: 'North' },
  resolution: { method: 'automatic', evidenceVersion: 'curb-v2' },
  ...overrides,
});

function memoryDb(seed = {}) {
  const docs = new Map(Object.entries(seed));
  const writes = [];
  return {
    docs,
    writes,
    doc(path) {
      return {
        path,
        async get() {
          const value = docs.get(path);
          return { exists: value !== undefined, data: () => value };
        },
      };
    },
    batch() {
      const pending = [];
      return {
        set(ref, value) { pending.push({ path: ref.path, value }); },
        async commit() {
          for (const write of pending) {
            docs.set(write.path, write.value);
            writes.push(write);
          }
        },
      };
    },
  };
}

const Timestamp = { now: () => 'timestamp-now' };
const metadata = { id: 'inkn-q76z', rowsUpdatedAt: 1767225600, viewLastModified: 1767225660 };
async function topology(lat = 40.70005) {
  const row = {
    globalid: 'private-global', physicalid: 'private-physical', b5sc: 'private-b5sc',
    l_blockfaceid: '1000000001', r_blockfaceid: '1000000002', boroughcode: '2', rw_type: '1',
    full_street_name: 'MARAN PLACE', street_name: 'MARAN PLACE', stname_label: 'MARAN PL',
    streetwidth: '34', from_level_code: '13', to_level_code: '13', status: '2', nonped: '', accessible: '',
    from_street: 'WHITE PLAINS ROAD', to_street: 'LURTING AVENUE',
    the_geom: { type: 'MultiLineString', coordinates: [[[-74, 40.7], [-73.999, 40.7]]] },
  };
  const fetchFn = vi.fn(async url => ({ ok: true, json: async () => (
    String(url).includes('/api/views/') ? metadata : [row]
  ) }));
  return resolveCanonicalCurb({ lat, lng: -73.9999, accuracyMeters: 1, sampleCount: 3, consistencyMeters: 1 }, {
    fetchFn, requestNonce: 'persistence-authority',
  });
}

async function proofFor(topologyResult, officialBlockFaceId = topologyResult.identity.officialBlockFaceId) {
  const body = {
    ok: true,
    officialBlockFaceId,
    normalizedStreetNames: {
      onStreet: 'MARAN PLACE', crossStreetOne: 'WHITE PLAINS ROAD', crossStreetTwo: 'LURTING AVENUE',
    },
    returnCode: '00', reasonCode: ' ',
    sourceVersion: { geosupportRelease: '26C', geosupportVersion: '26.3' },
  };
  const blockfaceResolver = createPrivateBlockfaceResolver({
    mode: 'shadow', serviceUrl: 'https://parqueen-test-resolver-uc.a.run.app',
    getIdToken: vi.fn(async () => 'synthetic-token'),
    transport: vi.fn(async () => ({ status: 200, text: async () => JSON.stringify(body) })),
  });
  return proveCanonicalCurbIdentity(topologyResult, { blockfaceResolver });
}

describe('canonical curb persistence', () => {
  it('rejects copied or caller-created topology before batch construction', async () => {
    const genuine = await topology();
    const identityProof = await proofFor(genuine);
    const db = memoryDb();
    db.batch = vi.fn(db.batch);
    await expect(persistCanonicalCurb({
      db, Timestamp, topologyResult: { ...genuine }, identityProof, selectedRules: { rules: [] },
    })).resolves.toEqual({ success: false, reason: 'authority_invalid' });
    expect(db.batch).not.toHaveBeenCalled();
  });
  it('rejects copied or reconstructed identity proof before batch construction', async () => {
    const topologyResult = await topology();
    const identityProof = await proofFor(topologyResult);
    const db = memoryDb();
    db.batch = vi.fn(db.batch);

    await expect(persistCanonicalCurb({
      db, Timestamp, topologyResult, identityProof: { ...identityProof }, selectedRules: { rules: [] },
    })).resolves.toEqual({ success: false, reason: 'identity_proof_invalid' });
    expect(db.batch).not.toHaveBeenCalled();
  });
  it('canonicalizes semantically equal geometry while preserving meaningful order', () => {
    const base = { type: 'MultiLineString', coordinates: [[[0, 40.7], [1, 40.8]]] };
    const negativeZero = { type: 'MultiLineString', coordinates: [[[-0, 40.7], [1, 40.8]]] };
    const reversed = { type: 'MultiLineString', coordinates: [[[1, 40.8], [0, 40.7]]] };
    expect(canonicalGeometry(base)).toBe(canonicalGeometry(negativeZero));
    expect(canonicalGeometry(base)).not.toBe(canonicalGeometry(reversed));
    expect(canonicalGeometry(base)).toMatch(/^[a-f0-9]{64}$/);
  });
  it('writes private identity only to curbIdentities and sanitized public segment/rules', async () => {
    const db = memoryDb();
    const topologyResult = await topology();
    const identityProof = await proofFor(topologyResult);
    const selectedRules = { rules: [{
      category: 'cleaning',
      source: 'dot',
      schedules: [{ side: 'North', days: ['Mon'], startTime: '08:00', endTime: '09:30' }],
      officialBlockFaceId: 'forbidden-face',
      diagnostics: { globalId: 'forbidden-global' },
    }] };

    const result = await persistCanonicalCurb({ db, Timestamp, topologyResult, identityProof, selectedRules });
    const key = publicCurbKey(topologyResult.identity);

    expect(result).toEqual({ success: true, publicCurbKey: key, ruleCount: 1 });
    expect(db.docs.get(`curbIdentities/${key}`)).toMatchObject({
      identity: { officialBlockFaceId: '1000000001' },
    });
    const publicWrites = db.writes.filter(write => !write.path.startsWith('curbIdentities/'));
    const serialized = JSON.stringify(publicWrites).toLowerCase();
    expect(serialized).not.toMatch(/1000000001|forbidden-face|forbidden-global|blockface|globalid|physicalid|b5sc|diagnostic/);
    expect(db.docs.get(`streetSegments/${key}`)).toMatchObject({
      segmentId: key,
      streetName: 'MARAN PLACE',
      sideLabel: 'North',
      status: 'active',
      protocolVersion: 2,
      activeRuleSetVersion: expect.stringMatching(/^curbrules2_/),
    });
    const publicRule = publicWrites.find(write => write.path.includes('/streetRules/')).value;
    expect(publicRule).toMatchObject({
      type: 'streetCleaning',
      source: 'nyc_open_data',
      protocolVersion: 2,
      ruleSetVersion: expect.stringMatching(/^curbrules2_/),
      supersededAt: null,
    });
  });

  it('publishes a new active generation so removed rules cannot remain active', async () => {
    const db = memoryDb();
    const topologyResult = await topology();
    const identityProof = await proofFor(topologyResult);
    const curb = topologyResult.identity;
    const key = publicCurbKey(curb);
    await persistCanonicalCurb({
      db, Timestamp, topologyResult, identityProof,
      selectedRules: { rules: [
        { category: 'cleaning', source: 'dot', schedules: [{ side: 'North', days: ['Mon'], startTime: '08:00', endTime: '09:00' }] },
        { category: 'restriction', type: 'noParking', source: 'dot', schedules: [{ side: 'North', days: ['Mon'], anytime: true }] },
      ] },
    });
    const firstVersion = db.docs.get(`streetSegments/${key}`).activeRuleSetVersion;

    await persistCanonicalCurb({
      db, Timestamp, topologyResult, identityProof,
      selectedRules: { rules: [{ category: 'cleaning', source: 'dot', schedules: [{ side: 'North', days: ['Tue'], startTime: '10:00', endTime: '11:00' }] }] },
    });
    const secondVersion = db.docs.get(`streetSegments/${key}`).activeRuleSetVersion;
    const activeRules = [...db.docs.entries()]
      .filter(([path, value]) => path.includes('/streetRules/') && value.ruleSetVersion === secondVersion);

    expect(secondVersion).not.toBe(firstVersion);
    expect(activeRules).toHaveLength(1);
    expect(activeRules[0][1].schedules[0].days).toEqual(['Tue']);
  });

  it('normalizes ParkNYC meter windows into the schedules consumed by the card', async () => {
    const db = memoryDb();
    const topologyResult = await topology();
    const identityProof = await proofFor(topologyResult);
    const curb = topologyResult.identity;
    const key = publicCurbKey(curb);
    await persistCanonicalCurb({
      db, Timestamp, topologyResult, identityProof,
      selectedRules: { rules: [{
        category: 'meter',
        source: 'park_nyc',
        windows: [{ side: 'North', days: ['Mon'], startTime: '09:00', endTime: '19:00' }],
        maxStayMinutes: 120,
        rate: { display: '$3.50/hour' },
      }] },
    });
    const meter = [...db.docs.entries()]
      .find(([path]) => path.startsWith(`streetSegments/${key}/streetRules/`))[1];

    expect(meter).toMatchObject({
      type: 'meter',
      source: 'park_nyc',
      schedules: [{ side: 'North', days: ['Mon'], startTime: '09:00', endTime: '19:00' }],
      meterTerms: { maxStayMinutes: 120, rateDisplay: '$3.50/hour' },
    });
    expect(meter.windows).toBeUndefined();
  });

  it('reuses only the exact public key and separates opposite/crossing identities', async () => {
    const topologyResult = await topology();
    const identityProof = await proofFor(topologyResult);
    const north = topologyResult.identity;
    const south = identity({ officialBlockFaceId: '1000000002', csclSide: 'RIGHT', side: { cardinal: 'South' } });
    const northKey = publicCurbKey(north);
    const southKey = publicCurbKey(south);
    const db = memoryDb({
      [`curbIdentities/${northKey}`]: {
        schemaVersion: 2,
        cacheCompatibilityVersion: 'canonical-curb-cache-compatibility-1',
        publicCurbKey: northKey,
        identity: north,
      },
      [`streetSegments/${northKey}`]: {
        ...topologyResult.publicCurb,
        protocolVersion: 2,
        cacheCompatibilityVersion: 'canonical-curb-cache-compatibility-1',
        activeRuleSetVersion: 'curbrules2_0123456789abcdef0123',
      },
    });

    await expect(readCanonicalCache({ db, topologyResult, identityProof }))
      .resolves.toMatchObject({ hit: true, identity: north });
    await expect(readCanonicalCache({ db, topologyResult: { ...topologyResult, identity: south }, identityProof }))
      .resolves.toEqual({ hit: false, reason: 'authority_invalid' });
    expect(northKey).not.toBe(southKey);
  });

  it('does not allow an otherwise compatible cache hit without the exact current proof', async () => {
    const topologyResult = await topology();
    const identityProof = await proofFor(topologyResult);
    const key = publicCurbKey(topologyResult.identity);
    const db = memoryDb({
      [`curbIdentities/${key}`]: {
        schemaVersion: 2,
        cacheCompatibilityVersion: 'canonical-curb-cache-compatibility-1',
        publicCurbKey: key,
        identity: topologyResult.identity,
      },
      [`streetSegments/${key}`]: {
        ...topologyResult.publicCurb,
        protocolVersion: 2,
        cacheCompatibilityVersion: 'canonical-curb-cache-compatibility-1',
        activeRuleSetVersion: 'curbrules2_0123456789abcdef0123',
      },
    });

    await expect(readCanonicalCache({ db, topologyResult }))
      .resolves.toEqual({ hit: false, reason: 'identity_proof_invalid' });
    await expect(readCanonicalCache({ db, topologyResult, identityProof: { ...identityProof } }))
      .resolves.toEqual({ hit: false, reason: 'identity_proof_invalid' });
  });

  it('treats a matching-BFI mixed or partial cache generation as a miss', async () => {
    const topologyResult = await topology();
    const identityProof = await proofFor(topologyResult);
    const key = publicCurbKey(topologyResult.identity);
    const db = memoryDb({
      [`curbIdentities/${key}`]: { schemaVersion: 2, identity: topologyResult.identity },
      [`streetSegments/${key}`]: { ...topologyResult.publicCurb, protocolVersion: 1 },
    });
    await expect(readCanonicalCache({ db, topologyResult, identityProof }))
      .resolves.toEqual({ hit: false, reason: 'cache_curb_mismatch' });
  });

  it('rejects missing rule-generation provenance and cross-document public-key mismatch', async () => {
    const topologyResult = await topology();
    const identityProof = await proofFor(topologyResult);
    const key = publicCurbKey(topologyResult.identity);
    const privateDocument = {
      schemaVersion: 2,
      cacheCompatibilityVersion: 'canonical-curb-cache-compatibility-1',
      publicCurbKey: key,
      identity: topologyResult.identity,
    };
    const publicDocument = {
      ...topologyResult.publicCurb,
      protocolVersion: 2,
      cacheCompatibilityVersion: 'canonical-curb-cache-compatibility-1',
      activeRuleSetVersion: 'curbrules2_0123456789abcdef0123',
    };
    const missingGeneration = memoryDb({
      [`curbIdentities/${key}`]: privateDocument,
      [`streetSegments/${key}`]: { ...publicDocument, activeRuleSetVersion: undefined },
    });
    const wrongBinding = memoryDb({
      [`curbIdentities/${key}`]: { ...privateDocument, publicCurbKey: 'curb2_00000000000000000000000000000000' },
      [`streetSegments/${key}`]: publicDocument,
    });
    const incompatiblePublicSchema = memoryDb({
      [`curbIdentities/${key}`]: privateDocument,
      [`streetSegments/${key}`]: { ...publicDocument, schemaVersion: 1 },
    });

    await expect(readCanonicalCache({ db: missingGeneration, topologyResult, identityProof }))
      .resolves.toEqual({ hit: false, reason: 'cache_curb_mismatch' });
    await expect(readCanonicalCache({ db: wrongBinding, topologyResult, identityProof }))
      .resolves.toEqual({ hit: false, reason: 'cache_curb_mismatch' });
    await expect(readCanonicalCache({ db: incompatiblePublicSchema, topologyResult, identityProof }))
      .resolves.toEqual({ hit: false, reason: 'cache_curb_mismatch' });
  });

  it('does not copy incompatible legacy radius-cache rules and emits mismatch', async () => {
    const emit = vi.fn();
    const result = await migrateCompatibleLegacyRules({
      identity: identity(),
      legacySegment: {
        streetName: 'WHITE PLAINS ROAD',
        parkingSide: 'East',
        distanceMeters: 2,
      },
      legacyRules: [{ type: 'streetCleaning' }],
      relationshipMatches: false,
      emit,
    });

    expect(result).toEqual({ copied: false, reason: 'cache_curb_mismatch', rules: [] });
    expect(emit).toHaveBeenCalledWith('cache_curb_mismatch', { protocolVersion: 2 });
  });

  it('copies legacy rules only when street, side, and official relationship all match', async () => {
    const legacyRules = [{
      category: 'cleaning',
      source: 'sweepNyc',
      schedules: [{ side: 'North', days: ['Mon'], startTime: '08:00', endTime: '08:30' }],
    }];
    const result = await migrateCompatibleLegacyRules({
      identity: identity(),
      legacySegment: { streetName: 'MARAN PLACE', parkingSide: 'North', distanceMeters: 70 },
      legacyRules,
      relationshipMatches: true,
    });

    expect(result).toMatchObject({ copied: true, reason: 'compatible' });
    expect(result.rules).toHaveLength(1);
  });
});
