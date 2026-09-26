import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  readCanonicalCache,
  persistCanonicalCurb,
  migrateCompatibleLegacyRules,
} = require('./canonicalCurbPersistence');
const { publicCurbKey } = require('./canonicalCurbIdentity');

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

describe('canonical curb persistence', () => {
  it('writes private identity only to curbIdentities and sanitized public segment/rules', async () => {
    const db = memoryDb();
    const selectedRules = { rules: [{
      category: 'cleaning',
      source: 'dot',
      schedules: [{ side: 'North', days: ['Mon'], startTime: '08:00', endTime: '09:30' }],
      officialBlockFaceId: 'forbidden-face',
      diagnostics: { globalId: 'forbidden-global' },
    }] };

    const result = await persistCanonicalCurb({ db, Timestamp, identity: identity(), selectedRules });
    const key = publicCurbKey(identity());

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
    const curb = identity();
    const key = publicCurbKey(curb);
    await persistCanonicalCurb({
      db, Timestamp, identity: curb,
      selectedRules: { rules: [
        { category: 'cleaning', source: 'dot', schedules: [{ side: 'North', days: ['Mon'], startTime: '08:00', endTime: '09:00' }] },
        { category: 'restriction', type: 'noParking', source: 'dot', schedules: [{ side: 'North', days: ['Mon'], anytime: true }] },
      ] },
    });
    const firstVersion = db.docs.get(`streetSegments/${key}`).activeRuleSetVersion;

    await persistCanonicalCurb({
      db, Timestamp, identity: curb,
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
    const curb = identity();
    const key = publicCurbKey(curb);
    await persistCanonicalCurb({
      db, Timestamp, identity: curb,
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
    const north = identity();
    const south = identity({ officialBlockFaceId: '1000000002', csclSide: 'RIGHT', side: { cardinal: 'South' } });
    const northKey = publicCurbKey(north);
    const southKey = publicCurbKey(south);
    const db = memoryDb({
      [`curbIdentities/${northKey}`]: { identity: north },
      [`streetSegments/${northKey}`]: { segmentId: northKey, streetName: 'MARAN PLACE' },
    });

    await expect(readCanonicalCache({ db, publicCurbKey: northKey }))
      .resolves.toMatchObject({ hit: true, identity: north });
    await expect(readCanonicalCache({ db, publicCurbKey: southKey }))
      .resolves.toEqual({ hit: false, reason: 'exact_identity_missing' });
    expect(northKey).not.toBe(southKey);
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
});
