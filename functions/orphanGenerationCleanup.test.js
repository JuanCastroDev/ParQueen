'use strict';

const { Timestamp } = require('firebase-admin/firestore');
const { clearOrphanGeneration, sweepOrphanGenerations } = require('./orphanGenerationCleanup');

const G1 = 'a'.repeat(64);
const G2 = 'b'.repeat(64);
const NOW = 1_700_000_000_000;

function millisOf(value) {
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  return value;
}

function createMemoryDb(seed) {
  const docs = new Map();
  const versions = new Map();
  for (const [path, data] of Object.entries(seed)) {
    docs.set(path, structuredClone(data));
    versions.set(path, 1);
  }
  const updates = [];
  const db = {
    updates,
    failLockQuery: false,
    lockQueryCode: 'failed-precondition',
    failPageQuery: false,
    bumpOnRead: false,
    lockGate: null,
    collection(name) {
      return chain(name);
    },
    collectionGroup(name) {
      return {
        where(field, op, value) {
          return {
            limit() {
              return { kind: 'group', name, field, op, value };
            },
          };
        },
      };
    },
    async runTransaction(fn) {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const readVersions = new Map();
        const writes = [];
        const tx = {
          async get(target) {
            if (target && target.kind === 'group') {
              if (db.lockGate) await db.lockGate();
              if (db.failLockQuery) {
                const error = new Error('collection group index missing');
                error.code = db.lockQueryCode;
                throw error;
              }
              const hits = [];
              for (const [path, data] of docs) {
                if (!path.includes(`/${target.name}/`) && !path.startsWith(`${target.name}/`)) continue;
                if (target.op === '==' && data[target.field] === target.value) hits.push(path);
              }
              return { empty: hits.length === 0, size: hits.length, docs: hits };
            }
            readVersions.set(target.path, versions.get(target.path) || 0);
            if (db.bumpOnRead) versions.set(target.path, (versions.get(target.path) || 0) + 1);
            const data = docs.get(target.path);
            return {
              exists: data != null,
              data: () => (data == null ? undefined : structuredClone(data)),
            };
          },
          update(ref, patch) {
            writes.push({ path: ref.path, patch: structuredClone(patch) });
          },
        };
        const result = await fn(tx);
        let conflict = false;
        for (const [path, version] of readVersions) {
          if ((versions.get(path) || 0) !== version) conflict = true;
        }
        if (conflict) continue;
        for (const write of writes) {
          const current = docs.get(write.path) || {};
          docs.set(write.path, { ...current, ...write.patch });
          versions.set(write.path, (versions.get(write.path) || 0) + 1);
          updates.push(write);
        }
        return result;
      }
      throw new Error('transaction retries exhausted');
    },
  };

  function chain(collectionName) {
    const filters = [];
    let cap = Infinity;
    const api = {
      doc(id) {
        return { path: `${collectionName}/${id}`, id };
      },
      where(field, op, value) {
        filters.push({ field, op, value });
        return api;
      },
      orderBy() {
        return api;
      },
      limit(n) {
        cap = n;
        return api;
      },
      async get() {
        if (db.failPageQuery) {
          const error = new Error('spots query denied');
          error.code = 'permission-denied';
          throw error;
        }
        const rows = [];
        for (const [path, data] of docs) {
          if (!path.startsWith(`${collectionName}/`)) continue;
          const id = path.slice(collectionName.length + 1);
          if (id.includes('/')) continue;
          let ok = true;
          for (const filter of filters) {
            const left = millisOf(data[filter.field]);
            const right = millisOf(filter.value);
            if (filter.op === '==' && data[filter.field] !== filter.value) ok = false;
            if (filter.op === '>' && !(left > right)) ok = false;
          }
          if (ok) rows.push({ id, data });
        }
        rows.sort((a, b) => millisOf(a.data.expiresAt) - millisOf(b.data.expiresAt));
        const page = rows.slice(0, cap);
        return {
          size: page.length,
          docs: page.map((row) => ({
            id: row.id,
            data: () => structuredClone(row.data),
          })),
        };
      },
    };
    return api;
  }

  db.read = (path) => structuredClone(docs.get(path));
  return db;
}

function orphanSpot(extra = {}) {
  return {
    finderId: 'finder-1',
    status: 'available',
    interestedUserId: null,
    claimState: null,
    claimGenerationId: G1,
    address: 'Main St',
    expiresAt: NOW + 60_000,
    ...extra,
  };
}

describe('orphan generation cleanup', () => {
  it('clears a leftover generation on an available spot with no claimant and no lock', async () => {
    const db = createMemoryDb({ 'spots/spot-1': orphanSpot() });
    const before = db.read('spots/spot-1');
    const result = await clearOrphanGeneration(db, 'spot-1', G1);
    const after = db.read('spots/spot-1');
    expect(result).toEqual({ outcome: 'cleared', changed: true, generation: 'valid' });
    expect(after.claimGenerationId).toBeNull();
    const { claimGenerationId: _before, ...restBefore } = before;
    const { claimGenerationId: _after, ...restAfter } = after;
    expect(restAfter).toEqual(restBefore);
    expect(db.updates).toEqual([{ path: 'spots/spot-1', patch: { claimGenerationId: null } }]);
  });

  it('leaves a live claim and its generation unchanged', async () => {
    const live = orphanSpot({
      status: 'interested',
      interestedUserId: 'claimer-1',
      claimState: 'heading',
    });
    const db = createMemoryDb({ 'spots/spot-1': live });
    const result = await clearOrphanGeneration(db, 'spot-1', G1);
    expect(result.outcome).toBe('not_available');
    expect(result.changed).toBe(false);
    expect(db.read('spots/spot-1')).toEqual(live);
    expect(db.updates).toEqual([]);
  });

  it('does not clear G2 when a delayed G1 cleanup loses the race', async () => {
    const db = createMemoryDb({ 'spots/spot-1': orphanSpot() });
    let release;
    const seen = {};
    const opened = new Promise((resolve) => { seen.resolve = resolve; });
    db.lockGate = () => {
      seen.resolve();
      return new Promise((resolve) => { release = resolve; });
    };
    const cleanup = clearOrphanGeneration(db, 'spot-1', G1);
    await opened;
    await db.runTransaction(async (tx) => {
      tx.update(db.collection('spots').doc('spot-1'), {
        status: 'interested',
        interestedUserId: 'claimer-2',
        claimState: 'heading',
        claimGenerationId: G2,
      });
    });
    release();
    const result = await cleanup;
    expect(result.outcome).not.toBe('cleared');
    expect(result.changed).toBe(false);
    expect(db.read('spots/spot-1').claimGenerationId).toBe(G2);
    expect(db.read('spots/spot-1').status).toBe('interested');
    expect(db.updates.map((write) => write.patch.claimGenerationId)).not.toContain(null);
  });

  it('fails closed when an interested spot has no claimant metadata', async () => {
    const spot = orphanSpot({ status: 'interested', interestedUserId: null, claimState: null });
    const db = createMemoryDb({ 'spots/spot-1': spot });
    const result = await clearOrphanGeneration(db, 'spot-1', G1);
    expect(result).toMatchObject({ outcome: 'incomplete_interest', changed: false, generation: 'valid' });
    expect(db.read('spots/spot-1')).toEqual(spot);
  });

  it('fails closed when a lock appears before the cleanup commits', async () => {
    const db = createMemoryDb({ 'spots/spot-1': orphanSpot() });
    let release;
    const opened = {};
    const ready = new Promise((resolve) => { opened.resolve = resolve; });
    db.lockGate = () => {
      opened.resolve();
      return new Promise((resolve) => { release = resolve; });
    };
    const cleanup = clearOrphanGeneration(db, 'spot-1', G1);
    await ready;
    const lockPath = 'users/claimer-1/activeIncomingClaims/current';
    await db.runTransaction(async (tx) => {
      tx.update({ path: lockPath }, { spotId: 'spot-1', updatedAt: NOW });
    });
    release();
    const result = await cleanup;
    expect(result).toMatchObject({ outcome: 'locked', changed: false });
    expect(db.read('spots/spot-1').claimGenerationId).toBe(G1);
  });

  it('fails closed when an available spot still has an active lock', async () => {
    const db = createMemoryDb({
      'spots/spot-1': orphanSpot(),
      'users/claimer-1/activeIncomingClaims/current': { spotId: 'spot-1', updatedAt: NOW },
    });
    const result = await clearOrphanGeneration(db, 'spot-1', G1);
    expect(result).toMatchObject({ outcome: 'locked', changed: false, generation: 'valid' });
    expect(db.read('spots/spot-1').claimGenerationId).toBe(G1);
    expect(db.read('users/claimer-1/activeIncomingClaims/current').spotId).toBe('spot-1');
  });

  it('classifies a missing generation and a malformed leftover', async () => {
    const missing = createMemoryDb({ 'spots/spot-1': orphanSpot({ claimGenerationId: null }) });
    const absent = await clearOrphanGeneration(missing, 'spot-1', null);
    expect(absent).toMatchObject({ outcome: 'absent', changed: false, generation: 'absent' });
    expect(missing.updates).toEqual([]);

    const malformed = createMemoryDb({ 'spots/spot-1': orphanSpot({ claimGenerationId: 'not-a-generation' }) });
    const cleared = await clearOrphanGeneration(malformed, 'spot-1', 'not-a-generation');
    expect(cleared).toEqual({ outcome: 'cleared', changed: true, generation: 'malformed' });
    expect(malformed.read('spots/spot-1').claimGenerationId).toBeNull();

    const wrongShape = createMemoryDb({ 'spots/spot-1': orphanSpot({ claimGenerationId: 64 }) });
    const numeric = await clearOrphanGeneration(wrongShape, 'spot-1', 64);
    expect(numeric.generation).toBe('malformed');
    expect(numeric.outcome).toBe('cleared');
    expect(wrongShape.read('spots/spot-1').claimGenerationId).toBeNull();
  });

  it('does not touch a prepared claim attempt while clearing the orphan', async () => {
    const db = createMemoryDb({
      'spots/spot-1': orphanSpot(),
      'claimSpotAttempts/attempt-1': { uid: 'claimer-1', spotId: 'spot-1', state: 'prepared' },
    });
    let release;
    const opened = {};
    const ready = new Promise((resolve) => { opened.resolve = resolve; });
    db.lockGate = () => {
      opened.resolve();
      return new Promise((resolve) => { release = resolve; });
    };
    const cleanup = clearOrphanGeneration(db, 'spot-1', G1);
    await ready;
    await db.runTransaction(async (tx) => {
      tx.update(db.collection('claimSpotAttempts').doc('attempt-1'), { state: 'prepared', note: 'still-prepared' });
    });
    release();
    const result = await cleanup;
    expect(result.outcome).toBe('cleared');
    expect(db.read('claimSpotAttempts/attempt-1')).toEqual({
      uid: 'claimer-1',
      spotId: 'spot-1',
      state: 'prepared',
      note: 'still-prepared',
    });
    expect(db.read('spots/spot-1').claimGenerationId).toBeNull();
  });

  it('does not let cleanup erase a redemption that commits first', async () => {
    const db = createMemoryDb({ 'spots/spot-1': orphanSpot() });
    let release;
    const opened = {};
    const ready = new Promise((resolve) => { opened.resolve = resolve; });
    db.lockGate = () => {
      opened.resolve();
      return new Promise((resolve) => { release = resolve; });
    };
    const cleanup = clearOrphanGeneration(db, 'spot-1', G1);
    await ready;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(db.collection('spots').doc('spot-1'));
      const spot = snap.data();
      expect(spot.claimGenerationId).toBe(G1);
      tx.update(db.collection('spots').doc('spot-1'), {
        status: 'interested',
        interestedUserId: 'claimer-9',
        claimState: 'heading',
        claimGenerationId: G2,
      });
    });
    release();
    const result = await cleanup;
    expect(result.changed).toBe(false);
    const spot = db.read('spots/spot-1');
    expect(spot.claimGenerationId).toBe(G2);
    expect(spot.interestedUserId).toBe('claimer-9');
    expect(spot.status).toBe('interested');
  });

  it('treats a second cleanup as a no-op', async () => {
    const db = createMemoryDb({ 'spots/spot-1': orphanSpot({ address: 'Kept' }) });
    const first = clearOrphanGeneration(db, 'spot-1', G1);
    const second = clearOrphanGeneration(db, 'spot-1', G1);
    const results = await Promise.all([first, second]);
    expect(results.map((result) => result.outcome).sort()).toEqual(['absent', 'cleared']);
    expect(db.read('spots/spot-1').claimGenerationId).toBeNull();
    expect(db.read('spots/spot-1').address).toBe('Kept');
    expect(db.updates.filter((write) => write.path === 'spots/spot-1')).toHaveLength(1);
  });

  it('selects only current available leftovers and leaves every other field alone', async () => {
    const db = createMemoryDb({
      'spots/orphan': orphanSpot(),
      'spots/plain': orphanSpot({ claimGenerationId: null, address: 'Open' }),
      'spots/live': orphanSpot({ status: 'interested', interestedUserId: 'claimer-1', claimGenerationId: G2 }),
      'spots/expired': orphanSpot({ expiresAt: NOW - 1, claimGenerationId: G2, address: 'Old' }),
    });
    const counts = await sweepOrphanGenerations(db, Timestamp.fromMillis(NOW));
    expect(counts.cleared).toBe(1);
    expect(counts.examined).toBe(1);
    expect(db.read('spots/orphan').claimGenerationId).toBeNull();
    expect(db.read('spots/orphan').address).toBe('Main St');
    expect(db.read('spots/plain').claimGenerationId).toBeNull();
    expect(db.read('spots/live').claimGenerationId).toBe(G2);
    expect(db.read('spots/expired').claimGenerationId).toBe(G2);
    expect(db.updates).toEqual([{ path: 'spots/orphan', patch: { claimGenerationId: null } }]);
  });

  it('does not clear when the lock lookup cannot prove the spot is unowned', async () => {
    const db = createMemoryDb({ 'spots/spot-1': orphanSpot() });
    db.failLockQuery = true;
    await expect(clearOrphanGeneration(db, 'spot-1', G1)).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(db.read('spots/spot-1').claimGenerationId).toBe(G1);
    expect(db.updates).toEqual([]);
    const counts = await sweepOrphanGenerations(db, NOW);
    expect(counts.cleared).toBe(0);
    expect(counts.unproven).toBe(1);
    expect(db.read('spots/spot-1').claimGenerationId).toBe(G1);
  });

  it('does not assign a generation to a historical claim that has none', async () => {
    const historical = orphanSpot({
      status: 'interested',
      interestedUserId: 'claimer-1',
      claimState: 'heading',
      claimGenerationId: null,
    });
    const db = createMemoryDb({ 'spots/spot-1': historical });
    const result = await clearOrphanGeneration(db, 'spot-1', null);
    expect(result.changed).toBe(false);
    expect(db.read('spots/spot-1').claimGenerationId).toBeNull();
    expect(db.updates).toEqual([]);
  });
});

describe('orphan sweep wiring', () => {
  it('runs from the existing cleanup schedule and does not widen the generation cancel contract', () => {
    const fs = require('fs');
    const path = require('path');
    const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    const cleanup = indexSrc.slice(
      indexSrc.indexOf('exports.cleanupExpiredInterests'),
      indexSrc.indexOf('exports.cleanupExpiredHolds'),
    );
    expect(cleanup).toContain('sweepOrphanGenerations(db, now)');
    expect(cleanup).toContain('releasedInterestPatch');
    const holds = indexSrc.slice(
      indexSrc.indexOf('exports.cleanupExpiredHolds'),
      indexSrc.indexOf('exports.cleanupAbandonedArrivedHandoffs'),
    );
    expect(holds.match(/claimGenerationId: null/g)).toHaveLength(2);
    const cancel = fs.readFileSync(path.join(__dirname, 'cancelClaim.js'), 'utf8');
    expect(cancel).toContain('claimGenerationId');
    // Founder-approved 29G amendment (t683u). This line was
    // expect(cancel).not.toContain('fingerprint'). The approved legacy-only
    // exception releases a generationless claim by the exact stored
    // claimStartedAt (a claim-cycle fingerprint), so the word check can no
    // longer separate that path from a regression. It is replaced by behavior
    // assertions in cancelClaim.legacyContract.test.js (29G-A..F): the
    // generation path stays generation-only, no timestamp authorizes a
    // generation-bearing claim, the identity modes are exclusive, a missing
    // generation is never a wildcard, stale retries and other users are
    // refused, and the legacy path fails closed on its own checks.
    const contract = fs.readFileSync(path.join(__dirname, 'cancelClaim.legacyContract.test.js'), 'utf8');
    for (const id of ['29G-A1', '29G-A2', '29G-B1', '29G-B2', '29G-C1', '29G-C2', '29G-C3', '29G-D1', '29G-E1', '29G-E2', '29G-E3', '29G-F1', '29G-F2', '29G-F3', '29G-F4', '29G-F5']) {
      expect(contract).toContain(`it('${id}:`);
    }
    const rules = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');
    const notification = rules.slice(rules.indexOf('match /spotNotifications/'), rules.indexOf('// Design A attestations'));
    expect(notification).toContain('request.resource.data.createdAt <= request.time');
    expect(notification).not.toContain("duration.value(1, 'm')");
    const releaseAt = cleanup.indexOf('releasedInterestPatch');
    const sweepAt = cleanup.indexOf('await sweepOrphanGenerations(db, now)');
    expect(sweepAt).toBeGreaterThan(releaseAt);
    const tryAt = cleanup.lastIndexOf('try {', sweepAt);
    expect(tryAt).toBeGreaterThan(releaseAt);
    const tail = cleanup.slice(tryAt, cleanup.indexOf('repairActiveIncomingClaims'));
    expect(tail).toContain('orphan generation sweep failed');
    expect(tail).not.toContain('throw ');
    const indexes = fs.readFileSync(path.join(__dirname, '..', 'firestore.indexes.json'), 'utf8');
    expect(indexes).toContain('"fieldPath": "spotId"');
    expect(indexes).toContain('"queryScope": "COLLECTION_GROUP"');
  });
});

describe('scheduled cleanup isolation', () => {
  function spot(id, expiresAt, generation) {
    return [`spots/${id}`, orphanSpot({ expiresAt, claimGenerationId: generation, address: id })];
  }

  async function releaseThenSweep(db, now, sweep) {
    const released = ['expired-interest'];
    let sweepError = null;
    try {
      await sweep();
    } catch (error) {
      sweepError = error;
    }
    return { released, sweepError };
  }

  it('still records the expiry release when the orphan page query fails', async () => {
    const db = createMemoryDb({ 'spots/orphan': orphanSpot() });
    db.failPageQuery = true;
    const outcome = await releaseThenSweep(db, NOW, () => sweepOrphanGenerations(db, NOW));
    expect(outcome.released).toEqual(['expired-interest']);
    expect(outcome.sweepError).toMatchObject({ code: 'permission-denied' });
    expect(db.read('spots/orphan').claimGenerationId).toBe(G1);
  });

  it('leaves a candidate unchanged on a permission failure and continues the page', async () => {
    const db = createMemoryDb(Object.fromEntries([
      spot('bad', NOW + 1, G1),
      spot('good', NOW + 2, G2),
    ]));
    let calls = 0;
    const original = db.runTransaction.bind(db);
    db.runTransaction = async (fn) => {
      calls += 1;
      if (calls === 1) {
        const error = new Error('cleanup identity denied');
        error.code = 'permission-denied';
        throw error;
      }
      return original(fn);
    };
    const counts = await sweepOrphanGenerations(db, NOW);
    expect(counts.errors).toBe(1);
    expect(counts.unproven).toBe(1);
    expect(counts.cleared).toBe(1);
    expect(db.read('spots/bad').claimGenerationId).toBe(G1);
    expect(db.read('spots/good').claimGenerationId).toBeNull();
  });

  it('exhausts transaction retries without writing and without failing the sweep', async () => {
    const db = createMemoryDb({ 'spots/spot-1': orphanSpot() });
    db.bumpOnRead = true;
    const counts = await sweepOrphanGenerations(db, NOW);
    expect(counts.cleared).toBe(0);
    expect(counts.unproven).toBe(1);
    expect(db.read('spots/spot-1').claimGenerationId).toBe(G1);
    expect(db.updates).toEqual([]);
  });

  it('clears a valid leftover beside a malformed one', async () => {
    const db = createMemoryDb(Object.fromEntries([
      spot('bad', NOW + 1, 'not-a-generation'),
      spot('good', NOW + 2, G1),
      ['spots/plain', orphanSpot({ claimGenerationId: null, address: 'plain', expiresAt: NOW + 3 })],
      ['spots/live', orphanSpot({ status: 'interested', interestedUserId: 'claimer-1', claimGenerationId: G2, address: 'live', expiresAt: NOW + 4 })],
    ]));
    const counts = await sweepOrphanGenerations(db, NOW);
    expect(counts.cleared).toBe(2);
    expect(db.read('spots/bad').claimGenerationId).toBeNull();
    expect(db.read('spots/good').claimGenerationId).toBeNull();
    expect(db.read('spots/plain').address).toBe('plain');
    expect(db.read('spots/live').claimGenerationId).toBe(G2);
  });

  it('stops at 200 available leftovers and leaves the later spot', async () => {
    const seed = {};
    for (let i = 0; i < 201; i += 1) {
      seed[`spots/s${String(i).padStart(3, '0')}`] = orphanSpot({
        expiresAt: NOW + i + 1,
        claimGenerationId: i === 200 ? G2 : G1,
        address: `s${i}`,
      });
    }
    const db = createMemoryDb(seed);
    const counts = await sweepOrphanGenerations(db, NOW);
    expect(counts.pageSize).toBe(200);
    expect(counts.cleared).toBe(200);
    expect(db.read('spots/s200').claimGenerationId).toBe(G2);
    expect(db.read('spots/s000').claimGenerationId).toBeNull();
  });

  it('lets two overlapping sweeps clear one generation once', async () => {
    const db = createMemoryDb({ 'spots/spot-1': orphanSpot({ address: 'Once' }) });
    const [first, second] = await Promise.all([
      sweepOrphanGenerations(db, NOW),
      sweepOrphanGenerations(db, NOW),
    ]);
    expect(first.cleared + second.cleared).toBe(1);
    expect(db.read('spots/spot-1').claimGenerationId).toBeNull();
    expect(db.read('spots/spot-1').address).toBe('Once');
    expect(db.updates.filter((write) => write.patch.claimGenerationId === null)).toHaveLength(1);
  });
});
