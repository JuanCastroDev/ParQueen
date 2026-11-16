'use strict';

const { Timestamp } = require('firebase-admin/firestore');
const { HttpsError } = require('firebase-functions/v2/https');
const { prepareClaimIntent, claimSpot, revokeClaimIntent, ATTEMPT_COLLECTION } = require('./claimSpot');
const { cancelClaim } = require('./cancelClaim');
const { finderCancelSpot } = require('./finderCancelSpot');
const { PRODUCT_ACCESS_DENIED } = require('./productAccess');

const UID = 'claimer-fence';
const FINDER = 'finder-fence';
const SPOT = 'spot-fence';
const ATTEMPT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const GEN = 'ab'.repeat(32);
const FIXED = 1_700_000_000_000;

function memoryDb(seed) {
  const docs = new Map(Object.entries(seed));
  function ref(path) {
    return {
      path,
      async get() { return snap(path); },
      collection(name) {
        return { doc(id) { return ref(`${path}/${name}/${id}`); } };
      },
    };
  }
  function snap(path) {
    if (!docs.has(path)) return { exists: false, data: () => undefined, updateTime: null };
    return {
      exists: true,
      data: () => ({ ...docs.get(path) }),
      updateTime: Timestamp.fromMillis(FIXED),
    };
  }
  return {
    docs,
    doc(path) { return ref(path); },
    collection(name) {
      return { doc(id) { return ref(`${name}/${id}`); } };
    },
    async runTransaction(fn) {
      const tx = {
        async get(target) { return snap(target.path); },
        set(target, data) { docs.set(target.path, { ...data }); },
        update(target, patch) { docs.set(target.path, { ...(docs.get(target.path) || {}), ...patch }); },
        delete(target) { docs.delete(target.path); },
        create(target, data) { docs.set(target.path, { ...data }); },
      };
      return fn(tx);
    },
  };
}

function fence() {
  return { decision: 'delete', fenceGeneration: 1 };
}

function available() {
  return {
    status: 'available',
    finderId: FINDER,
    interestedUserId: null,
    expiresAt: Timestamp.fromMillis(FIXED + 3_600_000),
    reportedAt: Timestamp.fromMillis(FIXED + 3_600_000),
  };
}

function deps(db, extra = {}) {
  const calls = { limit: 0 };
  return {
    calls,
    options: {
      db,
      now: () => Timestamp.fromMillis(FIXED),
      checkRateLimit: async () => { calls.limit += 1; },
      allowTestHooks: true,
      randomBytes: () => Buffer.alloc(32, 4),
      ...extra,
    },
  };
}

function prepareRequest() {
  return { auth: { uid: UID }, data: { spotId: SPOT, attemptId: ATTEMPT, mode: 'immediate', etaMinutes: 4 } };
}

describe('parking callable deletion fence', () => {
  it('prepares a first claim when the profile and fence are both absent', async () => {
    const db = memoryDb({ [`spots/${SPOT}`]: available() });
    const harness = deps(db);
    const prepared = await prepareClaimIntent(prepareRequest(), harness.options);
    expect(prepared.state).toBe('prepared');
    expect(harness.calls.limit).toBe(1);
  });

  it('denies prepare, claim, revoke, cancel, and finder cancel when the fence exists and the profile is gone', async () => {
    const db = memoryDb({
      [`accountLifecycle/${UID}`]: fence(),
      [`spots/${SPOT}`]: {
        status: 'interested',
        finderId: FINDER,
        interestedUserId: UID,
        claimState: 'heading',
        claimGenerationId: GEN,
        expiresAt: Timestamp.fromMillis(FIXED + 60_000),
      },
    });
    const harness = deps(db);
    const denied = new HttpsError('permission-denied', PRODUCT_ACCESS_DENIED);
    await expect(prepareClaimIntent(prepareRequest(), harness.options)).rejects.toMatchObject({ code: denied.code, message: denied.message });
    await expect(claimSpot(prepareRequest(), harness.options)).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(revokeClaimIntent(prepareRequest(), harness.options)).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(cancelClaim({
      auth: { uid: UID },
      data: { spotId: SPOT, claimGenerationId: GEN, reason: 'unspecified' },
    }, harness.options)).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(finderCancelSpot({
      auth: { uid: FINDER },
      data: {
        spotId: SPOT,
        status: 'interested',
        interestedUserId: UID,
        claimState: 'heading',
        claimGenerationId: GEN,
      },
    }, deps(memoryDb({
      [`accountLifecycle/${FINDER}`]: fence(),
      [`spots/${SPOT}`]: {
        status: 'interested',
        finderId: FINDER,
        interestedUserId: UID,
        claimState: 'heading',
        claimGenerationId: GEN,
      },
    })).options)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(harness.calls.limit).toBe(0);
    expect(db.docs.has(`${ATTEMPT_COLLECTION}/${ATTEMPT}`)).toBe(false);
    expect(db.docs.has(`claimIntentCounters/${UID}`)).toBe(false);
    expect(db.docs.get(`spots/${SPOT}`).status).toBe('interested');
  });

  it('writes nothing when the fence appears after the preliminary read', async () => {
    const db = memoryDb({
      [`users/${UID}`]: { status: 'Active', username: 'ada' },
      [`spots/${SPOT}`]: available(),
    });
    const harness = deps(db, {
      afterReads: async () => {
        db.docs.set(`accountLifecycle/${UID}`, fence());
      },
    });
    await expect(prepareClaimIntent(prepareRequest(), harness.options)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(db.docs.has(`${ATTEMPT_COLLECTION}/${ATTEMPT}`)).toBe(false);
    expect(db.docs.has(`claimIntentCounters/${UID}`)).toBe(false);
    expect(db.docs.get(`spots/${SPOT}`).status).toBe('available');
  });

  it('does not create a revoked tombstone for a fenced revoke of a missing attempt', async () => {
    const db = memoryDb({ [`accountLifecycle/${UID}`]: fence() });
    await expect(revokeClaimIntent(prepareRequest(), deps(db).options)).rejects.toMatchObject({ code: 'permission-denied' });
    expect(db.docs.has(`${ATTEMPT_COLLECTION}/${ATTEMPT}`)).toBe(false);
  });
});
