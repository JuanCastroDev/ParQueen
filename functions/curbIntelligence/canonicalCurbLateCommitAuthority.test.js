import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { persistCanonicalCurb, readCanonicalCache } = require('./canonicalCurbPersistence');
const { createRequestDeadline } = require('./requestDeadline');
const { evaluateWriteAuthority } = require('./writeAuthority');
const { resolveCanonicalCurb } = require('./canonicalCurbResolver');
const { createPrivateBlockfaceResolver } = require('./privateBlockfaceResolver');
const { proveCanonicalCurbIdentity } = require('./canonicalCurbIdentityProof');
const { publicCurbKey } = require('./canonicalCurbIdentity');

const Timestamp = { now: () => ({ toMillis: () => Date.now() }) };
const FieldValue = { serverTimestamp: () => ({ __serverTimestamp: true }) };
const metadata = { id: 'inkn-q76z', rowsUpdatedAt: 1767225600, viewLastModified: 1767225660 };

function resolveValue(value, commitMs) {
  if (value && value.__serverTimestamp) return { toMillis: () => commitMs };
  if (Array.isArray(value)) return value.map(item => resolveValue(item, commitMs));
  if (value && typeof value === 'object') {
    const next = {};
    for (const [key, item] of Object.entries(value)) next[key] = resolveValue(item, commitMs);
    return next;
  }
  return value;
}

function memoryDb({ commitNow } = {}) {
  const docs = new Map();
  const writes = [];
  const now = () => (typeof commitNow === 'function' ? commitNow() : 10_000);
  const db = {
    docs,
    writes,
    beforeApply: null,
    publicWrites() {
      return writes.filter(write => (
        write.path.startsWith('streetSegments/') || write.path.startsWith('streetSegmentsV2/') || write.path.startsWith('curbIdentities/')
      ));
    },
    doc(path) {
      return {
        path,
        async get() {
          const value = docs.get(path);
          return { exists: value !== undefined, data: () => value };
        },
        async set(value) {
          const resolved = resolveValue(value, now());
          docs.set(path, resolved);
          writes.push({ path, value: resolved });
        },
      };
    },
    collection(prefix) {
      return {
        where(field, op, expected) {
          return {
            async get() {
              const docsFound = [];
              for (const [path, value] of docs.entries()) {
                if (!path.startsWith(`${prefix}/`)) continue;
                if (path.slice(prefix.length + 1).includes('/')) continue;
                if (op === '==' && value?.[field] === expected) {
                  docsFound.push({ id: path.slice(prefix.length + 1), data: () => value });
                }
              }
              return { docs: docsFound };
            },
          };
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
      if (typeof db.beforeApply === 'function') await db.beforeApply(pending);
      for (const write of pending) {
        const resolved = resolveValue(write.value, now());
        docs.set(write.path, resolved);
        writes.push({ path: write.path, value: resolved });
      }
    },
  };
  return db;
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
    fetchFn, requestNonce: 'late-commit-authority',
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

function persistInput(db, topologyResult, identityProof, deadline, extra = {}) {
  return {
    db,
    Timestamp,
    FieldValue,
    topologyResult,
    identityProof,
    selectedRules: extra.selectedRules || { rules: [] },
    signal: deadline.signal,
    deadlineAt: deadline.deadlineAt,
    persistToken: extra.persistToken || deadline.persistToken,
    persistAllowed: extra.persistAllowed || deadline.persistAllowed,
  };
}

describe('canonical curb late-commit authority', () => {
  it('1 publishes a commit that finishes just before the deadline', async () => {
    let fsNow = 10_000;
    const db = memoryDb({ commitNow: () => fsNow });
    const topologyResult = await topology();
    const identityProof = await proofFor(topologyResult);
    const deadline = createRequestDeadline({ startedAt: Date.now() });
    let phase = 0;
    db.beforeApply = (pending) => {
      phase += 1;
      if (phase === 1) {
        const generation = pending.find(item => item.path.includes('/generations/'));
        fsNow = generation.value.deadlineAtMs - 1;
      }
    };
    const result = await persistCanonicalCurb(persistInput(db, topologyResult, identityProof, deadline));
    const key = publicCurbKey(topologyResult.identity);
    expect(result.success).toBe(true);
    expect(result.published).toBe(true);
    expect(evaluateWriteAuthority(db.docs.get(`streetSegmentsV2/${key}`).writeAuthority).status).toBe('valid');
    deadline.dispose();
  });

  it('2 does not publish a commit that begins before the deadline and completes after it', async () => {
    let fsNow = 10_000;
    const db = memoryDb({ commitNow: () => fsNow });
    const topologyResult = await topology();
    const identityProof = await proofFor(topologyResult);
    const deadline = createRequestDeadline({ startedAt: Date.now() });
    let phase = 0;
    db.beforeApply = (pending) => {
      phase += 1;
      if (phase === 1) {
        const generation = pending.find(item => item.path.includes('/generations/'));
        fsNow = generation.value.deadlineAtMs + 25;
      }
    };
    const result = await persistCanonicalCurb(persistInput(db, topologyResult, identityProof, deadline));
    const key = publicCurbKey(topologyResult.identity);
    expect(result).toEqual({ success: false, reason: 'request_aborted' });
    expect(db.docs.has(`streetSegmentsV2/${key}`)).toBe(false);
    expect(db.publicWrites()).toEqual([]);
    deadline.dispose();
  });

  it('3 rejects a commit that lands exactly at the deadline', async () => {
    let fsNow = 10_000;
    const db = memoryDb({ commitNow: () => fsNow });
    const topologyResult = await topology();
    const identityProof = await proofFor(topologyResult);
    const deadline = createRequestDeadline({ startedAt: Date.now() });
    let phase = 0;
    db.beforeApply = (pending) => {
      phase += 1;
      if (phase === 1) {
        const generation = pending.find(item => item.path.includes('/generations/'));
        fsNow = generation.value.deadlineAtMs;
      }
    };
    const result = await persistCanonicalCurb(persistInput(db, topologyResult, identityProof, deadline));
    expect(result).toEqual({ success: false, reason: 'request_aborted' });
    expect(db.publicWrites()).toEqual([]);
    deadline.dispose();
  });

  it('4 does not publish when cancellation arrives while the transaction is pending', async () => {
    let fsNow = 10_000;
    const db = memoryDb({ commitNow: () => fsNow });
    const topologyResult = await topology();
    const identityProof = await proofFor(topologyResult);
    const deadline = createRequestDeadline({ startedAt: Date.now() });
    let phase = 0;
    db.beforeApply = (pending) => {
      phase += 1;
      if (phase === 1) {
        const generation = pending.find(item => item.path.includes('/generations/'));
        fsNow = generation.value.deadlineAtMs - 1;
        deadline.expire();
      }
    };
    const result = await persistCanonicalCurb(persistInput(db, topologyResult, identityProof, deadline));
    expect(result).toEqual({ success: false, reason: 'request_aborted' });
    expect(db.publicWrites()).toEqual([]);
    deadline.dispose();
  });

  it('5 does not persist public docs when a Firestore retry starts after the deadline', async () => {
    const db = memoryDb({ commitNow: () => 10_000 });
    const topologyResult = await topology();
    const identityProof = await proofFor(topologyResult);
    const deadline = createRequestDeadline({ startedAt: Date.now() });
    const original = db.runTransaction.bind(db);
    let callbacks = 0;
    db.runTransaction = async (fn) => {
      const wrapped = async (tx) => {
        callbacks += 1;
        return fn(tx);
      };
      const pending = [];
      await wrapped({
        async get(ref) {
          const value = db.docs.get(ref.path);
          return { exists: value !== undefined, data: () => value };
        },
        set(ref, value) { pending.push({ path: ref.path, value }); },
      });
      deadline.expire();
      return original(wrapped);
    };
    const result = await persistCanonicalCurb(persistInput(db, topologyResult, identityProof, deadline));
    expect(result).toEqual({ success: false, reason: 'request_aborted' });
    expect(db.publicWrites()).toEqual([]);
    expect(callbacks).toBe(2);
    deadline.dispose();
  });

  it('6 keeps one authoritative generation when two on-time requests target the same curb', async () => {
    let fsNow = 10_000;
    const db = memoryDb({ commitNow: () => fsNow });
    const topologyResult = await topology();
    const identityProof = await proofFor(topologyResult);
    const first = createRequestDeadline({ startedAt: Date.now() });
    const second = createRequestDeadline({ startedAt: Date.now() });
    let phase = 0;
    db.beforeApply = (pending) => {
      phase += 1;
      const generation = pending.find(item => item.path.includes('/generations/'));
      if (generation && phase === 1) fsNow = generation.value.deadlineAtMs - 20;
      if (generation && phase === 3) fsNow = generation.value.deadlineAtMs - 5;
    };
    const firstResult = await persistCanonicalCurb(persistInput(db, topologyResult, identityProof, first));
    const secondResult = await persistCanonicalCurb(persistInput(db, topologyResult, identityProof, second));
    const key = publicCurbKey(topologyResult.identity);
    expect(firstResult.success).toBe(true);
    expect(secondResult.success).toBe(true);
    const published = db.docs.get(`streetSegmentsV2/${key}`).writeAuthority.generationId;
    expect(typeof published).toBe('string');
    first.dispose();
    second.dispose();
  });

  it('7 refuses to let an expired generation replace a valid published generation', async () => {
    let fsNow = 10_000;
    const db = memoryDb({ commitNow: () => fsNow });
    const topologyResult = await topology();
    const identityProof = await proofFor(topologyResult);
    const first = createRequestDeadline({ startedAt: Date.now() });
    let phase = 0;
    db.beforeApply = (pending) => {
      phase += 1;
      const generation = pending.find(item => item.path.includes('/generations/'));
      if (generation && phase === 1) fsNow = generation.value.deadlineAtMs - 1;
      if (generation && phase === 3) fsNow = generation.value.deadlineAtMs + 40;
    };
    const firstResult = await persistCanonicalCurb(persistInput(db, topologyResult, identityProof, first));
    const key = publicCurbKey(topologyResult.identity);
    const publishedGeneration = db.docs.get(`streetSegmentsV2/${key}`).writeAuthority.generationId;
    const second = createRequestDeadline({ startedAt: Date.now() });
    const secondResult = await persistCanonicalCurb(persistInput(db, topologyResult, identityProof, second));
    expect(firstResult.success).toBe(true);
    expect(secondResult).toEqual({ success: false, reason: 'request_aborted' });
    expect(db.docs.get(`streetSegmentsV2/${key}`).writeAuthority.generationId).toBe(publishedGeneration);
    first.dispose();
    second.dispose();
  });

  it('8 rejects a cache hit when one stored document has inconsistent authority metadata', async () => {
    const topologyResult = await topology();
    const identityProof = await proofFor(topologyResult);
    const key = publicCurbKey(topologyResult.identity);
    const valid = { scheme: 1, generationId: 'c'.repeat(32), deadlineAtMs: 100, committedAt: { toMillis: () => 10 }, promotedAt: { toMillis: () => 11 } };
    const db = memoryDb({ commitNow: () => 10 });
    db.docs.set(`curbIdentities/${key}`, {
      schemaVersion: 2,
      cacheCompatibilityVersion: 'canonical-curb-cache-compatibility-1',
      publicCurbKey: key,
      identity: topologyResult.identity,
      writeAuthority: valid,
    });
    db.docs.set(`streetSegmentsV2/${key}`, {
      ...topologyResult.publicCurb,
      protocolVersion: 2,
      schemaVersion: 2,
      cacheCompatibilityVersion: 'canonical-curb-cache-compatibility-1',
      segmentId: key,
      activeRuleSetVersion: 'curbrules2_aaaaaaaaaaaaaaaaaaaa',
      writeAuthority: { ...valid, generationId: 'd'.repeat(32) },
    });
    const cache = await readCanonicalCache({ db, topologyResult, identityProof });
    expect(cache.hit).toBe(false);
    expect(cache.reason).toBe('inconsistent_authority');
  });

  it('9 still accepts trusted legacy documents that lack the new metadata', async () => {
    const topologyResult = await topology();
    const identityProof = await proofFor(topologyResult);
    const key = publicCurbKey(topologyResult.identity);
    const db = memoryDb({ commitNow: () => 10 });
    db.docs.set(`curbIdentities/${key}`, {
      schemaVersion: 2,
      cacheCompatibilityVersion: 'canonical-curb-cache-compatibility-1',
      publicCurbKey: key,
      identity: topologyResult.identity,
    });
    db.docs.set(`streetSegments/${key}`, {
      ...topologyResult.publicCurb,
      protocolVersion: 2,
      schemaVersion: 2,
      cacheCompatibilityVersion: 'canonical-curb-cache-compatibility-1',
      segmentId: key,
      activeRuleSetVersion: 'curbrules2_aaaaaaaaaaaaaaaaaaaa',
    });
    const cache = await readCanonicalCache({ db, topologyResult, identityProof });
    expect(cache.hit).toBe(true);
  });

  it('10 treats a direct-reader late public record as non-authoritative', async () => {
    const late = { writeAuthority: { scheme: 1, generationId: 'e'.repeat(32), deadlineAtMs: 9, committedAt: { toMillis: () => 9 }, promotedAt: { toMillis: () => 9 } } };
    expect(evaluateWriteAuthority(late.writeAuthority).status).toBe('reject');
    const topologyResult = await topology();
    const identityProof = await proofFor(topologyResult);
    const key = publicCurbKey(topologyResult.identity);
    const db = memoryDb({ commitNow: () => 10 });
    db.docs.set(`curbIdentities/${key}`, {
      schemaVersion: 2,
      cacheCompatibilityVersion: 'canonical-curb-cache-compatibility-1',
      publicCurbKey: key,
      identity: topologyResult.identity,
      writeAuthority: late.writeAuthority,
    });
    db.docs.set(`streetSegmentsV2/${key}`, {
      ...topologyResult.publicCurb,
      protocolVersion: 2,
      schemaVersion: 2,
      cacheCompatibilityVersion: 'canonical-curb-cache-compatibility-1',
      segmentId: key,
      activeRuleSetVersion: 'curbrules2_aaaaaaaaaaaaaaaaaaaa',
      writeAuthority: late.writeAuthority,
    });
    const cache = await readCanonicalCache({ db, topologyResult, identityProof });
    expect(cache).toEqual({ hit: false, reason: 'committed_at_or_after_deadline' });
  });

  it('11 leaves public documents untouched when Firestore fails during persist', async () => {
    const db = memoryDb({ commitNow: () => 10_000 });
    const topologyResult = await topology();
    const identityProof = await proofFor(topologyResult);
    const deadline = createRequestDeadline({ startedAt: Date.now() });
    db.runTransaction = async () => {
      throw new Error('unavailable');
    };
    await expect(persistCanonicalCurb(persistInput(db, topologyResult, identityProof, deadline)))
      .rejects.toThrow('unavailable');
    expect(db.publicWrites()).toEqual([]);
    deadline.dispose();
  });

  it('12 does not let an unpublished expired generation reappear through a later cache lookup', async () => {
    let fsNow = 10_000;
    const db = memoryDb({ commitNow: () => fsNow });
    const topologyResult = await topology();
    const identityProof = await proofFor(topologyResult);
    const deadline = createRequestDeadline({ startedAt: Date.now() });
    let phase = 0;
    db.beforeApply = (pending) => {
      phase += 1;
      if (phase === 1) {
        const generation = pending.find(item => item.path.includes('/generations/'));
        fsNow = generation.value.deadlineAtMs + 80;
      }
    };
    const result = await persistCanonicalCurb(persistInput(db, topologyResult, identityProof, deadline));
    expect(result.success).toBe(false);
    const cache = await readCanonicalCache({ db, topologyResult, identityProof });
    expect(cache.hit).toBe(false);
    deadline.dispose();
  });

  it('13 does not treat a timely staging commit and a late public promotion as authoritative', async () => {
    let fsNow = 10_000;
    const db = memoryDb({ commitNow: () => fsNow });
    const topologyResult = await topology();
    const identityProof = await proofFor(topologyResult);
    const deadline = createRequestDeadline({ startedAt: Date.now() });
    let phase = 0;
    db.beforeApply = (pending) => {
      phase += 1;
      if (phase === 1) {
        const generation = pending.find(item => item.path.includes('/generations/'));
        fsNow = generation.value.deadlineAtMs - 1;
      }
      if (phase === 2) {
        const generation = [...db.docs.values()].find(value => value && Number.isFinite(value.deadlineAtMs));
        fsNow = (generation?.deadlineAtMs ?? fsNow) + 746;
      }
    };
    const result = await persistCanonicalCurb(persistInput(db, topologyResult, identityProof, deadline));
    const key = publicCurbKey(topologyResult.identity);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('request_aborted');
    expect(db.docs.has(`streetSegments/${key}`)).toBe(false);
    const published = db.docs.get(`streetSegmentsV2/${key}`);
    expect(published).toBeTruthy();
    expect(evaluateWriteAuthority(published.writeAuthority).status).toBe('reject');
    expect(evaluateWriteAuthority(published.writeAuthority).reason).toBe('promoted_at_or_after_deadline');
    const cache = await readCanonicalCache({ db, topologyResult, identityProof });
    expect(cache.hit).toBe(false);
    deadline.dispose();
  });
});
