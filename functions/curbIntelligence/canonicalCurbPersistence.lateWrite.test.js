import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { persistCanonicalCurb } = require('./canonicalCurbPersistence');
const { resolveCanonicalCurb } = require('./canonicalCurbResolver');
const { createPrivateBlockfaceResolver } = require('./privateBlockfaceResolver');
const { proveCanonicalCurbIdentity } = require('./canonicalCurbIdentityProof');
const { createRequestDeadline, childBudgetMs, OVERALL_DEADLINE_MS } = require('./requestDeadline');
const { runCanonicalCurbOrchestrator } = require('./canonicalCurbOrchestrator');

const Timestamp = { now: () => 'timestamp-now' };
const FieldValue = { serverTimestamp: () => ({ toMillis: () => Date.now() }) };
const metadata = { id: 'inkn-q76z', rowsUpdatedAt: 1767225600, viewLastModified: 1767225660 };

function memoryDb() {
  const docs = new Map();
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
        async set(value) {
          docs.set(path, value);
          writes.push({ path, value });
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
    async runTransaction(fn) {
      const pending = [];
      const tx = {
        async get(ref) {
          const value = docs.get(ref.path);
          return { exists: value !== undefined, data: () => value };
        },
        set(ref, value) { pending.push({ path: ref.path, value }); },
      };
      await fn(tx);
      for (const write of pending) {
        docs.set(write.path, write.value);
        writes.push(write);
      }
    },
  };
}

async function topology() {
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
  return resolveCanonicalCurb({ lat: 40.70005, lng: -73.9999, accuracyMeters: 1, sampleCount: 3, consistencyMeters: 1 }, {
    fetchFn, requestNonce: 'late-write-authority',
  });
}

async function proofFor(topologyResult) {
  const body = {
    ok: true,
    officialBlockFaceId: topologyResult.identity.officialBlockFaceId,
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

describe('cancelled and expired persistence', () => {
  it('refuses a transaction after the request-scoped persist token is invalidated', async () => {
    const db = memoryDb();
    const topologyResult = await topology();
    const identityProof = await proofFor(topologyResult);
    const deadline = createRequestDeadline({ startedAt: Date.now() });
    deadline.expire();
    const result = await persistCanonicalCurb({
      db,
      Timestamp,
      FieldValue,
      topologyResult,
      identityProof,
      selectedRules: { rules: [] },
      signal: deadline.signal,
      deadlineAt: deadline.deadlineAt,
      persistToken: deadline.persistToken,
      persistAllowed: deadline.persistAllowed,
    });
    expect(result).toEqual({ success: false, reason: 'request_aborted' });
    expect(db.writes).toEqual([]);
    deadline.dispose();
  });

  it('re-checks the token inside the transaction after a delayed start', async () => {
    const db = memoryDb();
    const topologyResult = await topology();
    const identityProof = await proofFor(topologyResult);
    const deadline = createRequestDeadline({ startedAt: Date.now() });
    const original = db.runTransaction.bind(db);
    db.runTransaction = async (fn) => {
      deadline.expire();
      return original(fn);
    };
    const result = await persistCanonicalCurb({
      db,
      Timestamp,
      FieldValue,
      topologyResult,
      identityProof,
      selectedRules: { rules: [] },
      signal: deadline.signal,
      deadlineAt: deadline.deadlineAt,
      persistToken: deadline.persistToken,
      persistAllowed: deadline.persistAllowed,
    });
    expect(result).toEqual({ success: false, reason: 'request_aborted' });
    expect(db.writes.filter((write) => (
      write.path.startsWith('streetSegments/') || write.path.startsWith('curbIdentities/')
    ))).toEqual([]);
    deadline.dispose();
  });

  it('does not hand an expired in-flight success to a new caller', async () => {
    const location = {
      lat: 40.7, lng: -73.9999, accuracyMeters: 5, sampleCount: 4, consistencyMeters: 4,
    };
    const request = { protocolVersion: 2, location };
    const inFlight = new Map();
    const expired = Promise.resolve({
      protocolVersion: 2,
      status: 'high_confidence',
      segmentId: 'curb2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      streetName: 'EXPIRED',
      sideLabel: 'North',
      ruleSummary: { cleaningAvailable: false },
    });
    expired.deadlineAt = Date.now() - 1;
    expired.signal = { aborted: true };
    const { createHash } = require('node:crypto');
    const key = createHash('sha256').update(JSON.stringify({
      protocolVersion: 2,
      location,
      candidateToken: null,
    })).digest('hex');
    inFlight.set(key, expired);

    const result = await runCanonicalCurbOrchestrator(request, {
      fetchFn: vi.fn(async () => new Promise(() => {})),
      persistCanonicalCurb: vi.fn(async () => ({ success: true })),
      loadCanonicalRules: vi.fn(async () => ({ state: 'complete', selected: {} })),
      inFlight,
      initializationStartedAt: Date.now() - OVERALL_DEADLINE_MS,
      telemetry: { emit: vi.fn() },
    });
    expect(result).toEqual({ protocolVersion: 2, status: 'unsupported', reason: 'source_unavailable' });
    expect(result.status).not.toBe('high_confidence');
  });

  it('caps a child source budget to remaining time', () => {
    expect(childBudgetMs(2500, { remainingMs: 400 })).toBe(400);
    expect(childBudgetMs(2500, { deadlineAt: Date.now() - 1 })).toBe(0);
    expect(childBudgetMs(2500, { signal: { aborted: true } })).toBe(0);
    expect(childBudgetMs(2500, { remainingMs: 4000 })).toBe(2500);
  });
});
