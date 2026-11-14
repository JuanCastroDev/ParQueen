'use strict';

/**
 * Active-incoming-claim release and 15-minute stale-lock repair.
 * Exercises the real scheduled handlers and the spot-delete trigger against
 * the Firestore emulator. The emulator does not prove the collection-group
 * index is deployed in production.
 */

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const { requireEmulatorProjectId } = require('./emulatorProjectId');
const { receiptDocumentId, receiptBody } = require('./finderCancelReceipt');
const TRUST_GENERATION = 'ab'.repeat(32);
const CONFLICT_GENERATION = 'cd'.repeat(32);
const PROJECT_ID = requireEmulatorProjectId();
const APP_NAME = '__active_incoming_claim_intg__';
const testApp = getApps().find(app => app.name === APP_NAME) ?? initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const indexModule = require('./index.js');
const activeClaimModule = require('./activeIncomingClaim.js');

const RUN = `${process.pid}_${Date.now()}`;
let sequence = 0;
const nextId = (label) => `aic_${label}_${RUN}_${++sequence}`;

const PAST = Timestamp.fromMillis(Date.now() - 60_000);
const FUTURE = Timestamp.fromMillis(Date.now() + 60 * 60_000);
const SIXTEEN_MIN_AGO = Timestamp.fromMillis(Date.now() - 16 * 60_000);
const ONE_MIN_AGO = Timestamp.fromMillis(Date.now() - 60_000);

function lockRef(uid) {
  return db.doc(`users/${uid}/activeIncomingClaims/current`);
}

function lockData(spotId, updatedAt, extra = {}) {
  return {
    spotId,
    claimStartedAt: updatedAt,
    claimState: 'heading',
    updatedAt,
    ...extra,
  };
}

async function captureErrors(fn) {
  const calls = [];
  const original = console.error;
  console.error = (...args) => { calls.push(args); };
  try { await fn(); } finally { console.error = original; }
  return calls;
}

describe('active incoming claim — release paths and 15-minute repair', () => {
  it('clears the matching lock when an expired interest is released, and leaves claimStartedAt cleared', async () => {
    const spotId = nextId('expire');
    const uid = nextId('claimer');
    await db.doc(`spots/${spotId}`).set({
      finderId: 'finder_x',
      finderName: 'Finder',
      address: '1 Test St',
      lat: 40.7,
      lng: -74.0,
      status: 'interested',
      claimState: 'heading',
      interestedUserId: uid,
      interestedUserName: 'Claimant',
      pingMode: 'now',
      reportedAt: PAST,
      expiresAt: FUTURE,
      interestExpiresAt: PAST,
      claimStartedAt: PAST,
    });
    await lockRef(uid).set(lockData(spotId, PAST));

    await indexModule.cleanupExpiredInterests.run();

    const spot = (await db.doc(`spots/${spotId}`).get()).data();
    expect(spot.status).toBe('available');
    expect(spot.interestedUserId).toBeNull();
    expect(spot.claimStartedAt).toBeNull();
    expect((await lockRef(uid).get()).exists).toBe(false);
  });

  it('does not delete a lock that names a different Ping when an interest expires', async () => {
    const spotId = nextId('expire_other');
    const uid = nextId('claimer');
    await db.doc(`spots/${spotId}`).set({
      finderId: 'finder_x',
      status: 'interested',
      claimState: 'heading',
      interestedUserId: uid,
      pingMode: 'now',
      reportedAt: PAST,
      expiresAt: FUTURE,
      interestExpiresAt: PAST,
      claimStartedAt: PAST,
    });
    await lockRef(uid).set(lockData('some-other-spot', PAST));

    await indexModule.cleanupExpiredInterests.run();

    expect((await lockRef(uid).get()).data().spotId).toBe('some-other-spot');
  });

  it('garbage-collects a non-matching lock after 15 minutes and keeps a younger one', async () => {
    const staleUid = nextId('stale_user');
    const freshUid = nextId('fresh_user');
    const staleSpot = nextId('stale_spot');
    await db.doc(`spots/${staleSpot}`).set({
      status: 'available',
      finderId: 'finder_x',
      interestedUserId: null,
      expiresAt: FUTURE,
    });
    await lockRef(staleUid).set(lockData(staleSpot, SIXTEEN_MIN_AGO));
    await lockRef(freshUid).set(lockData('missing-spot', ONE_MIN_AGO));

    await indexModule.cleanupExpiredInterests.run();

    expect((await lockRef(staleUid).get()).exists).toBe(false);
    expect((await lockRef(freshUid).get()).exists).toBe(true);
  });

  it('keeps a lock older than 15 minutes when the Ping is still an active claim', async () => {
    const uid = nextId('long_claim');
    const spotId = nextId('long_spot');
    await db.doc(`spots/${spotId}`).set({
      status: 'interested',
      claimState: 'committed',
      interestedUserId: uid,
      finderId: 'finder_x',
      pingMode: 'later',
      reportedAt: FUTURE,
      expiresAt: FUTURE,
      interestExpiresAt: FUTURE,
      claimStartedAt: SIXTEEN_MIN_AGO,
    });
    await lockRef(uid).set(lockData(spotId, SIXTEEN_MIN_AGO, { claimState: 'committed' }));

    await indexModule.cleanupExpiredInterests.run();

    const lock = await lockRef(uid).get();
    expect(lock.exists).toBe(true);
    expect(lock.data().spotId).toBe(spotId);
    expect((await db.doc(`spots/${spotId}`).get()).data().status).toBe('interested');
  });

  it('backfills a lock when an interested Ping has none (Ping wins)', async () => {
    const uid = nextId('orphan');
    const spotId = nextId('orphan_spot');
    const started = Timestamp.now();
    await db.doc(`spots/${spotId}`).set({
      status: 'interested',
      claimState: 'heading',
      interestedUserId: uid,
      finderId: 'finder_x',
      pingMode: 'now',
      reportedAt: PAST,
      expiresAt: FUTURE,
      interestExpiresAt: FUTURE,
      claimStartedAt: started,
    });

    await indexModule.cleanupExpiredInterests.run();

    const lock = await lockRef(uid).get();
    expect(lock.exists).toBe(true);
    expect(lock.data().spotId).toBe(spotId);
    expect(lock.data().claimState).toBe('heading');
    expect(lock.data().claimStartedAt.toMillis()).toBe(started.toMillis());
  });

  it('A1-R001: reconciles duplicate interested Pings, reports the conflict, and does not reopen an expired loser', async () => {
    const uid = nextId('dual');
    const kept = nextId('dual_kept');
    const extra = nextId('dual_extra');
    const expired = nextId('dual_expired');
    const earlier = Timestamp.fromMillis(Date.now() - 120_000);
    const middle = Timestamp.fromMillis(Date.now() - 60_000);
    const latest = Timestamp.fromMillis(Date.now() - 10_000);
    const spots = [
      [kept, earlier, FUTURE],
      [extra, middle, FUTURE],
      [expired, latest, PAST],
    ];
    for (const [spotId, started, expiresAt] of spots) {
      await db.doc(`spots/${spotId}`).set({
        status: 'interested',
        claimState: 'heading',
        interestedUserId: uid,
        finderId: 'finder_x',
        pingMode: 'now',
        reportedAt: PAST,
        expiresAt,
        interestExpiresAt: FUTURE,
        claimStartedAt: started,
      });
    }

    await indexModule.cleanupExpiredInterests.run();

    expect((await lockRef(uid).get()).data().spotId).toBe(kept);
    expect((await db.doc(`spots/${kept}`).get()).data().status).toBe('interested');
    expect((await db.doc(`spots/${kept}`).get()).data().interestedUserId).toBe(uid);
    const released = (await db.doc(`spots/${extra}`).get()).data();
    expect(released.status).toBe('available');
    expect(released.interestedUserId).toBeNull();
    const expiredLoser = (await db.doc(`spots/${expired}`).get()).data();
    expect(expiredLoser.status).toBe('interested');
    expect(expiredLoser.interestedUserId).toBeNull();
    const conflict = await db.doc(`activeIncomingClaimConflicts/${uid}`).get();
    expect(conflict.exists).toBe(true);
    expect(conflict.data().keptSpotId).toBe(kept);
    expect(conflict.data().releasedSpotIds).toEqual([extra, expired]);
    expect(conflict.data().rule).toBe('earliest_claimStartedAt_then_spotId');
    const status = await db.doc('activeIncomingClaimRollout/status').get();
    expect(status.data().enforced).toBe(false);
    expect(status.data().locklessCount).toBe(0);
    expect(status.data().duplicateUserCount).toBe(0);
    expect(status.data().duplicatePingCount).toBe(0);

    await indexModule.cleanupExpiredInterests.run();
    expect((await db.doc(`spots/${kept}`).get()).data().interestedUserId).toBe(uid);
    const blockedStatus = (await db.doc('activeIncomingClaimRollout/status').get()).data();
    expect(blockedStatus.enforced).toBe(false);
    expect(blockedStatus.malformedInterestedCount).toBe(1);
    await db.doc(`spots/${expired}`).delete();
    const clean = await activeClaimModule.reconcileActiveIncomingClaims(db, Timestamp.now());
    expect(clean.enforced).toBe(true);
  });

  it('F1-REC-01/02/03: detects and repairs a modern same-Ping generation mismatch, then opens only on a later clean scan', async () => {
    const uid = nextId('rec_modern_user');
    const spotId = nextId('rec_modern_spot');
    const started = new Timestamp(1_700_000_000, 123_456_000);
    await db.doc(`users/${uid}`).set({ lang: 'en' });
    await db.doc(`spots/${spotId}`).set({
      status: 'interested', claimState: 'heading', interestedUserId: uid,
      finderId: 'finder_rec_modern', expiresAt: FUTURE, interestExpiresAt: FUTURE,
      claimStartedAt: started, claimGenerationId: TRUST_GENERATION,
    });
    await lockRef(uid).set(lockData(spotId, started, { claimGenerationId: CONFLICT_GENERATION }));

    const first = await activeClaimModule.reconcileActiveIncomingClaims(db, Timestamp.now());
    const repaired = (await lockRef(uid).get()).data();
    const statusAfterRepair = (await db.doc('activeIncomingClaimRollout/status').get()).data();
    expect(first.enforced).toBe(false);
    expect(first.locklessCount).toBe(0);
    expect(repaired.claimGenerationId).toBe(TRUST_GENERATION);
    expect(repaired.claimStartedAt.seconds).toBe(started.seconds);
    expect(repaired.claimStartedAt.nanoseconds).toBe(started.nanoseconds);
    expect(statusAfterRepair.enforced).toBe(false);
    expect((await db.collection('spotNotifications').where('spotId', '==', spotId).get()).empty).toBe(true);
    expect((await db.collection('finderCancelReceipts').where('spotId', '==', spotId).get()).empty).toBe(true);
    expect((await db.doc(`users/${uid}`).get()).data().trustStats).toBeUndefined();

    const repairedUpdatedAt = repaired.updatedAt;
    const second = await activeClaimModule.reconcileActiveIncomingClaims(db, Timestamp.now());
    const cleanLock = (await lockRef(uid).get()).data();
    expect(second.enforced).toBe(true);
    expect((await db.doc('activeIncomingClaimRollout/status').get()).data().enforced).toBe(true);
    expect(cleanLock.updatedAt.isEqual(repairedUpdatedAt)).toBe(true);
  });

  it('F1-REC-04/05: exact legacy nanoseconds drive repair and an exact canonical lock is not rewritten', async () => {
    const uid = nextId('rec_legacy_user');
    const spotId = nextId('rec_legacy_spot');
    // Firestore persists microsecond precision. These values differ by one
    // microsecond while remaining within the same millisecond.
    const pingStarted = new Timestamp(1_700_000_100, 123_456_000);
    const lockStarted = new Timestamp(1_700_000_100, 123_457_000);
    await db.doc(`spots/${spotId}`).set({
      status: 'interested', claimState: 'heading', interestedUserId: uid,
      finderId: 'finder_rec_legacy', expiresAt: FUTURE, interestExpiresAt: FUTURE,
      claimStartedAt: pingStarted,
    });
    await lockRef(uid).set(lockData(spotId, lockStarted));

    const first = await activeClaimModule.reconcileActiveIncomingClaims(db, Timestamp.now());
    const repaired = (await lockRef(uid).get()).data();
    expect(first.enforced).toBe(false);
    expect(repaired.claimStartedAt.seconds).toBe(pingStarted.seconds);
    expect(repaired.claimStartedAt.nanoseconds).toBe(pingStarted.nanoseconds);
    expect(repaired.claimGenerationId).toBeUndefined();

    const repairedUpdatedAt = repaired.updatedAt;
    const second = await activeClaimModule.reconcileActiveIncomingClaims(db, Timestamp.now());
    expect(second.enforced).toBe(true);
    expect((await lockRef(uid).get()).data().updatedAt.isEqual(repairedUpdatedAt)).toBe(true);
  });

  it('F1-REC-06: malformed historical identity is preserved, never reconstructed, and keeps the gate closed', async () => {
    const uid = nextId('rec_malformed_user');
    const spotId = nextId('rec_malformed_spot');
    const malformed = { seconds: 1_700_000_000, nanoseconds: 123_000_000 };
    await db.doc(`spots/${spotId}`).set({
      status: 'interested', claimState: 'heading', interestedUserId: uid,
      finderId: 'finder_rec_malformed', expiresAt: FUTURE, interestExpiresAt: FUTURE,
      claimStartedAt: malformed,
    });
    await lockRef(uid).set({ spotId, claimState: 'heading', claimStartedAt: malformed, updatedAt: PAST });

    const errors = await captureErrors(async () => {
      const result = await activeClaimModule.reconcileActiveIncomingClaims(db, Timestamp.now());
      expect(result.enforced).toBe(false);
      expect(result.reconcileErrors).toBe(1);
    });
    expect((await db.doc(`spots/${spotId}`).get()).data().claimStartedAt).toEqual(malformed);
    expect((await lockRef(uid).get()).data().claimStartedAt).toEqual(malformed);
    expect((await db.doc('activeIncomingClaimRollout/status').get()).data().enforced).toBe(false);
    expect(errors.some(([event, fields]) => event === 'activeClaimReconciliationBlocked'
      && fields?.classification === 'malformed')).toBe(true);
    await db.doc(`spots/${spotId}`).delete();
    await lockRef(uid).delete();
  });

  it('F1-REC-07: transaction retry revalidates a concurrently replaced cycle and never restores the stale generation', async () => {
    const uid = nextId('rec_retry_user');
    const spotId = nextId('rec_retry_spot');
    const startedA = new Timestamp(1_700_000_200, 100_000);
    const startedB = new Timestamp(1_700_000_201, 200_000);
    await db.doc(`spots/${spotId}`).set({
      status: 'interested', claimState: 'heading', interestedUserId: uid,
      finderId: 'finder_rec_retry', expiresAt: FUTURE, interestExpiresAt: FUTURE,
      claimStartedAt: startedA, claimGenerationId: TRUST_GENERATION,
    });
    await lockRef(uid).set(lockData(spotId, startedA, { claimGenerationId: CONFLICT_GENERATION }));

    let replaced = false;
    const realRunTransaction = db.runTransaction.bind(db);
    const retryDb = new Proxy(db, {
      get(target, prop) {
        if (prop === 'runTransaction') {
          return (callback) => realRunTransaction(async (tx) => callback(new Proxy(tx, {
            get(txTarget, txProp) {
              if (txProp === 'get') {
                return async (ref) => {
                  const snap = await txTarget.get(ref);
                  if (!replaced && ref.path === `spots/${spotId}`) {
                    replaced = true;
                    const batch = db.batch();
                    batch.update(db.doc(`spots/${spotId}`), {
                      claimStartedAt: startedB, claimGenerationId: CONFLICT_GENERATION,
                    });
                    batch.set(lockRef(uid), lockData(spotId, startedB, { claimGenerationId: CONFLICT_GENERATION }));
                    await batch.commit();
                  }
                  return snap;
                };
              }
              const value = txTarget[txProp];
              return typeof value === 'function' ? value.bind(txTarget) : value;
            },
          })));
        }
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const result = await activeClaimModule.reconcileActiveIncomingClaims(retryDb, Timestamp.now());
    const finalSpot = (await db.doc(`spots/${spotId}`).get()).data();
    const finalLock = (await lockRef(uid).get()).data();
    expect(replaced).toBe(true);
    expect(result.enforced).toBe(false);
    expect(finalSpot.claimGenerationId).toBe(CONFLICT_GENERATION);
    expect(finalLock.claimGenerationId).toBe(CONFLICT_GENERATION);
    expect(finalLock.claimStartedAt.isEqual(startedB)).toBe(true);
  });

  it('F1-REC-08: a reconciliation error cannot publish the rollout gate as enforced', async () => {
    const uid = nextId('rec_error_user');
    const spotId = nextId('rec_error_spot');
    const started = Timestamp.now();
    await db.doc(`spots/${spotId}`).set({
      status: 'interested', claimState: 'heading', interestedUserId: uid,
      finderId: 'finder_rec_error', expiresAt: FUTURE, interestExpiresAt: FUTURE,
      claimStartedAt: started, claimGenerationId: TRUST_GENERATION,
    });
    const failingDb = new Proxy(db, {
      get(target, prop) {
        if (prop === 'runTransaction') return async () => { throw new Error('injected reconciliation failure'); };
        const value = target[prop];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    let result;
    const errors = await captureErrors(async () => {
      result = await activeClaimModule.reconcileActiveIncomingClaims(failingDb, Timestamp.now());
    });
    const caughtFailures = errors.filter(([message]) => message === 'activeIncomingClaims: reconcile failed');
    expect(result.enforced).toBe(false);
    expect(caughtFailures.length).toBeGreaterThan(0);
    expect(result.reconcileErrors).toBe(caughtFailures.length);
    expect((await db.doc('activeIncomingClaimRollout/status').get()).data().enforced).toBe(false);
    expect((await lockRef(uid).get()).exists).toBe(false);
  });

  it('F1-REC-08: an incomplete initial scan actively closes a previously open gate with nonzero-safe null counters', async () => {
    const statusWrites = [];
    const page = {
      empty: false,
      size: 200,
      docs: Array.from({ length: 200 }, (_, index) => ({ id: `incomplete-${index}` })),
    };
    const query = {
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      startAfter: () => query,
      get: async () => page,
    };
    const incompleteDb = {
      collection: (name) => {
        if (name !== 'spots') throw new Error(`unexpected collection ${name}`);
        return query;
      },
      doc: (path) => ({
        path,
        set: async (data) => { statusWrites.push(data); },
      }),
    };

    const result = await activeClaimModule.reconcileActiveIncomingClaims(incompleteDb, Timestamp.now());
    expect(result).toMatchObject({ scanComplete: false, enforced: false, reconcileErrors: 1 });
    expect(statusWrites).toHaveLength(1);
    expect(statusWrites[0]).toMatchObject({
      enforced: false,
      locklessCount: null,
      duplicateUserCount: null,
      duplicatePingCount: null,
      phase: 'incomplete_pre_scan',
      reconcileErrors: 1,
    });
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['non-string', 42],
    ['path-invalid', 'bad/uid'],
  ])('F1-MAL-01/02/03/08: %s claimant is preserved and closes a previously true gate', async (label, claimant) => {
    const spotId = nextId(`mal_claimant_${label}`);
    const started = Timestamp.now();
    const spot = {
      status: 'interested', claimState: 'heading', finderId: 'finder_malformed',
      expiresAt: FUTURE, interestExpiresAt: FUTURE, claimStartedAt: started,
      claimGenerationId: TRUST_GENERATION,
    };
    if (claimant !== undefined) spot.interestedUserId = claimant;
    await db.doc('activeIncomingClaimRollout/status').set({
      enforced: true, locklessCount: 0, duplicateUserCount: 0,
      duplicatePingCount: 0, malformedInterestedCount: 0,
    });
    await db.doc(`spots/${spotId}`).set(spot);

    const result = await activeClaimModule.reconcileActiveIncomingClaims(db, Timestamp.now());
    const persisted = (await db.doc('activeIncomingClaimRollout/status').get()).data();
    expect(result.enforced).toBe(false);
    expect(result.malformedInterestedCount).toBeGreaterThan(0);
    expect(persisted.enforced).toBe(false);
    expect(persisted.malformedInterestedCount).toBeGreaterThan(0);
    expect((await db.doc(`spots/${spotId}`).get()).data()).toEqual(spot);
    expect((await db.collectionGroup('activeIncomingClaims').where('spotId', '==', spotId).get()).empty).toBe(true);

    await db.doc(`spots/${spotId}`).delete();
  });

  it('F1-MAL-04: a healthy claim remains intact beside a malformed interested Ping while the gate stays closed', async () => {
    const uid = nextId('mal_mixed_user');
    const healthyId = nextId('mal_mixed_healthy');
    const malformedId = nextId('mal_mixed_bad');
    const started = Timestamp.now();
    const healthy = {
      status: 'interested', claimState: 'heading', interestedUserId: uid,
      finderId: 'finder_mixed', expiresAt: FUTURE, interestExpiresAt: FUTURE,
      claimStartedAt: started, claimGenerationId: TRUST_GENERATION,
    };
    await db.doc(`spots/${healthyId}`).set(healthy);
    await lockRef(uid).set(lockData(healthyId, started, { claimGenerationId: TRUST_GENERATION }));
    await db.doc(`spots/${malformedId}`).set({
      status: 'interested', claimState: 'heading', finderId: 'finder_mixed',
      expiresAt: FUTURE, interestExpiresAt: FUTURE, claimStartedAt: started,
      claimGenerationId: TRUST_GENERATION,
    });

    const result = await activeClaimModule.reconcileActiveIncomingClaims(db, Timestamp.now());
    expect(result.enforced).toBe(false);
    expect(result.malformedInterestedCount).toBeGreaterThan(0);
    expect((await db.doc(`spots/${healthyId}`).get()).data()).toEqual(healthy);
    expect((await lockRef(uid).get()).data().claimGenerationId).toBe(TRUST_GENERATION);
    expect((await db.doc(`spots/${malformedId}`).get()).exists).toBe(true);

    await db.doc(`spots/${healthyId}`).delete();
    await db.doc(`spots/${malformedId}`).delete();
    await lockRef(uid).delete();
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', ''],
    ['unknown', 'arrived_pending_outcome'],
    ['non-string', { phase: 'heading' }],
  ])('F1-MAL-05/06: %s claimState cannot become canonical heading or be repaired', async (label, claimState) => {
    const uid = nextId(`mal_state_user_${label}`);
    const spotId = nextId(`mal_state_spot_${label}`);
    const started = Timestamp.now();
    const spot = {
      status: 'interested', interestedUserId: uid, finderId: 'finder_mal_state',
      expiresAt: FUTURE, interestExpiresAt: FUTURE, claimStartedAt: started,
      claimGenerationId: TRUST_GENERATION,
    };
    if (claimState !== undefined) spot.claimState = claimState;
    await db.doc(`spots/${spotId}`).set(spot);
    const originalLock = lockData(spotId, started, { claimGenerationId: TRUST_GENERATION });
    await lockRef(uid).set(originalLock);

    const result = await activeClaimModule.reconcileActiveIncomingClaims(db, Timestamp.now());
    expect(result.enforced).toBe(false);
    expect(result.malformedInterestedCount).toBeGreaterThan(0);
    expect((await db.doc(`spots/${spotId}`).get()).data()).toEqual(spot);
    expect((await lockRef(uid).get()).data()).toEqual(originalLock);

    await db.doc(`spots/${spotId}`).delete();
    await lockRef(uid).delete();
  });

  it.each(['heading', 'committed'])('F1-MAL-07: valid %s remains canonical without a lock rewrite', async (claimState) => {
    const uid = nextId(`mal_valid_user_${claimState}`);
    const spotId = nextId(`mal_valid_spot_${claimState}`);
    const started = Timestamp.now();
    await db.doc(`spots/${spotId}`).set({
      status: 'interested', claimState, interestedUserId: uid, finderId: 'finder_valid_state',
      expiresAt: FUTURE, interestExpiresAt: FUTURE, claimStartedAt: started,
      claimGenerationId: TRUST_GENERATION,
    });
    await lockRef(uid).set(lockData(spotId, started, { claimState, claimGenerationId: TRUST_GENERATION }));
    const before = (await lockRef(uid).get()).data().updatedAt;

    const result = await activeClaimModule.reconcileActiveIncomingClaims(db, Timestamp.now());
    expect(result.enforced).toBe(true);
    expect(result.malformedInterestedCount).toBe(0);
    expect((await lockRef(uid).get()).data().updatedAt.isEqual(before)).toBe(true);

    await db.doc(`spots/${spotId}`).delete();
    await lockRef(uid).delete();
  });

  it('F1-MAL-09: explicit authoritative recovery requires repair then a separate clean activation', async () => {
    const uid = nextId('mal_recovery_user');
    const spotId = nextId('mal_recovery_spot');
    const started = Timestamp.now();
    await db.doc(`spots/${spotId}`).set({
      status: 'interested', interestedUserId: uid, finderId: 'finder_recovery',
      expiresAt: FUTURE, interestExpiresAt: FUTURE, claimStartedAt: started,
      claimGenerationId: TRUST_GENERATION,
    });
    const malformed = await activeClaimModule.reconcileActiveIncomingClaims(db, Timestamp.now());
    expect(malformed.enforced).toBe(false);
    expect((await lockRef(uid).get()).exists).toBe(false);

    await db.doc(`spots/${spotId}`).update({ claimState: 'heading' });
    const repaired = await activeClaimModule.reconcileActiveIncomingClaims(db, Timestamp.now());
    expect(repaired.enforced).toBe(false);
    expect((await lockRef(uid).get()).data().claimState).toBe('heading');
    const clean = await activeClaimModule.reconcileActiveIncomingClaims(db, Timestamp.now());
    expect(clean.enforced).toBe(true);

    await db.doc(`spots/${spotId}`).delete();
    await lockRef(uid).delete();
  });

  it('auto-release clears the matching lock and claimStartedAt', async () => {
    const uid = nextId('release_user');
    const spotId = nextId('release_spot');
    const started = Timestamp.fromMillis(Date.now() - 5 * 60_000);
    await db.doc(`users/${uid}`).set({ lang: 'en' });
    await db.doc(`spots/${spotId}`).set({
      status: 'interested',
      claimState: 'committed',
      interestedUserId: uid,
      finderId: 'finder_release',
      pingMode: 'later',
      reportedAt: PAST,
      expiresAt: FUTURE,
      interestExpiresAt: FUTURE,
      claimStartedAt: started,
      claimAutoReleaseAt: PAST,
      claimReminderAt: null,
    });
    await lockRef(uid).set(lockData(spotId, started, { claimState: 'committed' }));

    await indexModule.processScheduledClaims.run({});

    const spot = (await db.doc(`spots/${spotId}`).get()).data();
    expect(spot.status).toBe('available');
    expect(spot.interestedUserId).toBeNull();
    expect(spot.claimStartedAt).toBeNull();
    expect(spot.claimState).toBeNull();
    expect(typeof spot.claimAutoReleasedAt.toMillis).toBe('function');
    expect((await lockRef(uid).get()).exists).toBe(false);
  });

  it('F1-SCHED-01: phantom cleanup preserves generation A Ping and generation B same-Ping lock and emits a diagnostic', async () => {
    const uid = nextId('phantom_conflict_user');
    const spotId = nextId('phantom_conflict_spot');
    const started = Timestamp.fromMillis(Date.now() - 5 * 60_000);
    const seeded = {
      status: 'available',
      claimState: 'heading',
      interestedUserId: uid,
      interestedUserName: 'Claimant',
      finderId: 'finder_x',
      expiresAt: FUTURE,
      interestExpiresAt: FUTURE,
      claimStartedAt: started,
      claimGenerationId: TRUST_GENERATION,
    };
    await db.doc(`spots/${spotId}`).set(seeded);
    await lockRef(uid).set(lockData(spotId, started, { claimGenerationId: CONFLICT_GENERATION }));
    const claimantBefore = await db.doc(`users/${uid}`).get();
    const finderBefore = await db.doc('users/finder_x').get();

    const errors = await captureErrors(() => indexModule.cleanupExpiredInterests.run());

    expect((await db.doc(`spots/${spotId}`).get()).data()).toEqual(seeded);
    expect((await lockRef(uid).get()).data().claimGenerationId).toBe(CONFLICT_GENERATION);
    expect((await db.collection('spotNotifications').where('spotId', '==', spotId).get()).empty).toBe(true);
    expect((await db.doc(`users/${uid}`).get()).data()).toEqual(claimantBefore.data());
    expect((await db.doc('users/finder_x').get()).data()).toEqual(finderBefore.data());
    expect(errors.some(([event, fields]) => event === 'claimLockRepairRequired'
      && fields?.operation === 'phantom_claim_sweep'
      && fields?.classification === 'same_spot_conflict')).toBe(true);
  });

  it('F1-SCHED-02: expired-interest release fails closed, then server reconciliation repairs the same-Ping lock without notification', async () => {
    const uid = nextId('expired_conflict_user');
    const spotId = nextId('expired_conflict_spot');
    const started = Timestamp.fromMillis(Date.now() - 5 * 60_000);
    const seeded = {
      status: 'interested',
      claimState: 'heading',
      interestedUserId: uid,
      finderId: 'finder_x',
      pingMode: 'now',
      reportedAt: PAST,
      expiresAt: FUTURE,
      interestExpiresAt: PAST,
      claimStartedAt: started,
      claimGenerationId: TRUST_GENERATION,
    };
    await db.doc(`spots/${spotId}`).set(seeded);
    await lockRef(uid).set(lockData(spotId, started, { claimGenerationId: CONFLICT_GENERATION }));

    const errors = await captureErrors(() => indexModule.cleanupExpiredInterests.run());

    expect((await db.doc(`spots/${spotId}`).get()).data()).toEqual(seeded);
    const repairedLock = (await lockRef(uid).get()).data();
    expect(repairedLock.claimGenerationId).toBe(TRUST_GENERATION);
    expect(repairedLock.claimStartedAt.isEqual(started)).toBe(true);
    expect((await db.collection('spotNotifications').where('spotId', '==', spotId).get()).empty).toBe(true);
    expect(errors.some(([event, fields]) => event === 'claimLockRepairRequired'
      && fields?.operation === 'expired_interest_cleanup'
      && fields?.classification === 'same_spot_conflict')).toBe(true);
  });

  it('F1-SCHED-03: auto-release isolates a generation conflict while releasing a healthy unrelated candidate', async () => {
    const uid = nextId('scheduled_conflict_user');
    const finderId = nextId('scheduled_conflict_finder');
    const spotId = nextId('scheduled_conflict_spot');
    const healthyUid = nextId('scheduled_healthy_user');
    const healthySpotId = nextId('scheduled_healthy_spot');
    const started = Timestamp.fromMillis(Date.now() - 5 * 60_000);
    await db.doc(`users/${uid}`).set({ lang: 'en' });
    await db.doc(`users/${finderId}`).set({ lang: 'en' });
    const seeded = {
      status: 'interested', claimState: 'committed', interestedUserId: uid, finderId,
      pingMode: 'later', reportedAt: PAST, expiresAt: FUTURE, interestExpiresAt: FUTURE,
      claimStartedAt: started, claimGenerationId: TRUST_GENERATION,
      claimAutoReleaseAt: PAST, claimReminderAt: null,
    };
    await db.doc(`spots/${spotId}`).set(seeded);
    await lockRef(uid).set(lockData(spotId, started, {
      claimState: 'committed', claimGenerationId: CONFLICT_GENERATION,
    }));
    await db.doc(`spots/${healthySpotId}`).set({
      ...seeded, interestedUserId: healthyUid, finderId: 'finder_healthy',
      claimGenerationId: TRUST_GENERATION,
    });
    await lockRef(healthyUid).set(lockData(healthySpotId, started, {
      claimState: 'committed', claimGenerationId: TRUST_GENERATION,
    }));

    const errors = await captureErrors(() => indexModule.processScheduledClaims.run({}));

    expect((await db.doc(`spots/${spotId}`).get()).data()).toEqual(seeded);
    expect((await lockRef(uid).get()).data().claimGenerationId).toBe(CONFLICT_GENERATION);
    expect((await db.collection('spotNotifications').where('spotId', '==', spotId).get()).empty).toBe(true);
    expect((await db.doc(`users/${uid}`).get()).data().trustStats).toBeUndefined();
    expect((await db.doc(`users/${finderId}`).get()).data().trustStats).toBeUndefined();
    expect((await db.doc(`spots/${healthySpotId}`).get()).data().interestedUserId).toBeNull();
    expect((await lockRef(healthyUid).get()).exists).toBe(false);
    expect(errors.some(([event, fields]) => event === 'claimLockRepairRequired'
      && fields?.operation === 'scheduled_claim_release'
      && fields?.classification === 'same_spot_conflict')).toBe(true);
  });

  it('spot delete clears a lock that names the deleted Ping and still applies the finder penalty', async () => {
    const finderId = nextId('finder');
    const claimerId = nextId('claimer');
    const spotId = nextId('deleted');
    await db.doc(`users/${finderId}`).set({ crowns: 0 });
    await lockRef(claimerId).set(lockData(spotId, Timestamp.now(), { claimGenerationId: TRUST_GENERATION }));
    const deleted = {
      status: 'interested',
      finderId,
      interestedUserId: claimerId,
      claimState: 'heading',
      claimGenerationId: TRUST_GENERATION,
      expiresAt: FUTURE,
      source: 'user',
    };
    const identity = {
      kind: 'generation',
      finderId,
      status: 'interested',
      interestedUserId: claimerId,
      claimState: 'heading',
      claimGenerationId: TRUST_GENERATION,
    };
    await db.collection('finderCancelReceipts').doc(receiptDocumentId(spotId, identity)).set(receiptBody(spotId, identity));

    await indexModule.updateTrustOnSpotDelete.run({
      id: nextId('event'),
      params: { spotId },
      time: new Date().toISOString(),
      data: {
        data: () => deleted,
      },
    });

    expect((await lockRef(claimerId).get()).exists).toBe(false);
    expect((await db.doc(`users/${finderId}`).get()).data().trustStats.handoffsCancelledByFinder).toBe(1);
  });

  it('spot delete does not clear a lock that already names a newer Ping', async () => {
    const finderId = nextId('finder');
    const claimerId = nextId('claimer');
    const spotId = nextId('old_deleted');
    await db.doc(`users/${finderId}`).set({ crowns: 0 });
    await lockRef(claimerId).set(lockData('newer-spot', Timestamp.now()));

    await indexModule.updateTrustOnSpotDelete.run({
      id: nextId('event'),
      params: { spotId },
      time: new Date().toISOString(),
      data: {
        data: () => ({
          status: 'interested',
          finderId,
          interestedUserId: claimerId,
          source: 'admin',
          expiresAt: FUTURE,
        }),
      },
    });

    expect((await lockRef(claimerId).get()).data().spotId).toBe('newer-spot');
    expect((await db.doc(`users/${finderId}`).get()).data().trustStats).toBeUndefined();
  });

  it('F1-03: spot delete preserves a same-Ping legacy lock when the deleted Ping is modern', async () => {
    const claimerId = nextId('mixed_claimer');
    const finderId = nextId('mixed_finder');
    const spotId = nextId('mixed_deleted');
    const legacyStarted = Timestamp.now();
    await db.doc(`users/${finderId}`).set({ crowns: 0 });
    await lockRef(claimerId).set(lockData(spotId, legacyStarted));
    const identity = {
      kind: 'generation',
      finderId,
      status: 'interested',
      interestedUserId: claimerId,
      claimState: 'heading',
      claimGenerationId: TRUST_GENERATION,
    };
    await db.collection('finderCancelReceipts').doc(receiptDocumentId(spotId, identity)).set(
      receiptBody(spotId, identity),
    );

    await indexModule.updateTrustOnSpotDelete.run({
      id: nextId('mixed_event'),
      params: { spotId },
      time: new Date().toISOString(),
      data: {
        data: () => ({
          status: 'interested',
          finderId,
          interestedUserId: claimerId,
          claimState: 'heading',
          claimStartedAt: legacyStarted,
          claimGenerationId: TRUST_GENERATION,
          source: 'user',
          expiresAt: FUTURE,
        }),
      },
    });

    expect((await lockRef(claimerId).get()).exists).toBe(true);
    expect((await db.doc(`users/${finderId}`).get()).data().trustStats).toBeUndefined();
  });

  it('F1-10: a post-release external lock insertion remains a residual and later reconciliation detects it', async () => {
    const claimerId = nextId('post_commit_claimer');
    const spotId = nextId('post_commit_spot');
    await lockRef(claimerId).set(lockData(spotId, Timestamp.now(), { claimGenerationId: TRUST_GENERATION }));

    await indexModule.updateTrustOnSpotDelete.run({
      id: nextId('post_commit_event'),
      params: { spotId },
      time: new Date().toISOString(),
      data: {
        data: () => ({
          status: 'interested',
          finderId: 'finder_x',
          interestedUserId: claimerId,
          claimState: 'heading',
          claimStartedAt: Timestamp.now(),
          claimGenerationId: TRUST_GENERATION,
          source: 'admin',
          expiresAt: FUTURE,
        }),
      },
    });
    expect((await lockRef(claimerId).get()).exists).toBe(false);

    // Characterizes the residual: a writer acting after commit can recreate
    // state that the completed release transaction cannot possibly prevent.
    await lockRef(claimerId).set(lockData(spotId, SIXTEEN_MIN_AGO, { claimGenerationId: TRUST_GENERATION }));
    expect((await lockRef(claimerId).get()).exists).toBe(true);

    await indexModule.cleanupExpiredInterests.run();
    expect((await lockRef(claimerId).get()).exists).toBe(false);
  });
});
