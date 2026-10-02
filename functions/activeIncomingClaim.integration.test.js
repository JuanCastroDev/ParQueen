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
const PROJECT_ID = requireEmulatorProjectId();
const APP_NAME = '__active_incoming_claim_intg__';
const testApp = getApps().find(app => app.name === APP_NAME) ?? initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const indexModule = require('./index.js');

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
    expect((await db.doc('activeIncomingClaimRollout/status').get()).data().enforced).toBe(true);
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

  it('spot delete clears a lock that names the deleted Ping and still applies the finder penalty', async () => {
    const finderId = nextId('finder');
    const claimerId = nextId('claimer');
    const spotId = nextId('deleted');
    await db.doc(`users/${finderId}`).set({ crowns: 0 });
    await lockRef(claimerId).set(lockData(spotId, Timestamp.now()));

    await indexModule.updateTrustOnSpotDelete.run({
      id: nextId('event'),
      params: { spotId },
      time: new Date().toISOString(),
      data: {
        data: () => ({
          status: 'interested',
          finderId,
          interestedUserId: claimerId,
          expiresAt: FUTURE,
          source: 'user',
        }),
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
});
