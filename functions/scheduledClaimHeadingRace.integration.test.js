'use strict';

/**
 * A3 / HO-009 — committed → heading vs processScheduledClaims auto-release.
 * The commit side uses the same decision and Arm 2b field set as the client
 * transaction. The release side is the real scheduler.
 */

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const { requireEmulatorProjectId } = require('./emulatorProjectId');
const { decideCommitToHeading, buildHeadingUpdate } = require('../utils/commitToHeadingDecision');

const PROJECT_ID = requireEmulatorProjectId();
const APP_NAME = '__scheduled_claim_heading_race__';
const testApp = getApps().find((app) => app.name === APP_NAME) ?? initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const indexModule = require('./index.js');

const RUN = `${process.pid}_${Date.now()}`;
let sequence = 0;
const nextId = (label) => `a3_${label}_${RUN}_${++sequence}`;

const PAST = Timestamp.fromMillis(Date.now() - 60_000);
const FUTURE = Timestamp.fromMillis(Date.now() + 60 * 60_000);

function lockRef(uid) {
  return db.doc(`users/${uid}/activeIncomingClaims/current`);
}

async function seedCommitted({
  spotId,
  uid,
  finderId,
  claimStartedAt,
  claimAutoReleaseAt,
  claimReminderAt = null,
  expiresAt = FUTURE,
  claimState = 'committed',
}) {
  await db.doc(`spots/${spotId}`).set({
    status: 'interested',
    claimState,
    interestedUserId: uid,
    interestedUserName: 'Claimant',
    finderId,
    finderName: 'Owner',
    pingMode: 'later',
    reportedAt: PAST,
    expiresAt,
    interestExpiresAt: FUTURE,
    claimStartedAt,
    claimAutoReleaseAt,
    claimReminderAt,
    claimReminderSentAt: null,
    etaMinutes: 4,
    ownerLeavingNow: null,
    ownerLeavingNowAt: null,
  });
  await lockRef(uid).set({
    spotId,
    claimStartedAt,
    claimState,
    updatedAt: claimStartedAt,
  });
}

/** Admin stand-in for commitClaimToHeading. Same predicate and field set. */
async function commitToHeadingAdmin({ spotId, uid, etaMinutes, claimMinutes, nowMs }) {
  const ref = db.doc(`spots/${spotId}`);
  return db.runTransaction(async (tx) => {
    const fresh = await tx.get(ref);
    if (!fresh.exists) return 'rejected';
    const decision = decideCommitToHeading(fresh.data(), uid);
    if (decision !== 'commit') return decision;
    const at = nowMs ?? Date.now();
    tx.update(ref, buildHeadingUpdate(
      etaMinutes,
      Timestamp.fromMillis(at + claimMinutes * 60_000),
    ));
    return 'committed';
  });
}

async function ownerLeaveNow(spotId, nowMs) {
  await db.doc(`spots/${spotId}`).update({
    ownerLeavingNow: true,
    ownerLeavingNowAt: Timestamp.fromMillis(nowMs),
    claimAutoReleaseAt: Timestamp.fromMillis(nowMs + 10 * 60_000),
  });
}

async function readSpot(spotId) {
  return (await db.doc(`spots/${spotId}`).get()).data();
}

function assertHeading(spot, lockSnap, uid, spotId, started) {
  expect(spot.status).toBe('interested');
  expect(spot.claimState).toBe('heading');
  expect(spot.interestedUserId).toBe(uid);
  expect(spot.claimStartedAt.toMillis()).toBe(started.toMillis());
  expect(spot.claimAutoReleaseAt).toBeNull();
  expect(lockSnap.exists).toBe(true);
  expect(lockSnap.data().spotId).toBe(spotId);
}

function assertReleased(spot, lockSnap, { status = 'available' } = {}) {
  expect(spot.status).toBe(status);
  expect(spot.claimState).toBeNull();
  expect(spot.interestedUserId).toBeNull();
  expect(spot.claimStartedAt).toBeNull();
  expect(spot.claimAutoReleaseAt).toBeNull();
  expect(lockSnap.exists).toBe(false);
}

describe('A3 — scheduled claim heading vs auto-release', () => {
  it('runs commit and auto-release together and leaves one consistent winner', async () => {
    const uid = nextId('race_user');
    const spotId = nextId('race_spot');
    const finderId = nextId('race_owner');
    const started = Timestamp.fromMillis(Date.now() - 5 * 60_000);
    await seedCommitted({
      spotId,
      uid,
      finderId,
      claimStartedAt: started,
      claimAutoReleaseAt: PAST,
    });

    const commitResult = await Promise.all([
      commitToHeadingAdmin({ spotId, uid, etaMinutes: 5, claimMinutes: 10 }),
      indexModule.processScheduledClaims.run({}),
    ]).then(([result]) => result);

    const spot = await readSpot(spotId);
    const lockSnap = await lockRef(uid).get();
    if (commitResult === 'committed') {
      assertHeading(spot, lockSnap, uid, spotId, started);
    } else {
      expect(commitResult).toBe('rejected');
      assertReleased(spot, lockSnap);
    }
    expect(spot.claimState === 'heading' && spot.interestedUserId == null).toBe(false);
  });

  it('does not resurrect a claim when commit runs after auto-release', async () => {
    const uid = nextId('stale_user');
    const spotId = nextId('stale_spot');
    const finderId = nextId('stale_owner');
    const started = Timestamp.fromMillis(Date.now() - 5 * 60_000);
    await seedCommitted({
      spotId,
      uid,
      finderId,
      claimStartedAt: started,
      claimAutoReleaseAt: PAST,
    });

    await indexModule.processScheduledClaims.run({});
    const outcome = await commitToHeadingAdmin({
      spotId, uid, etaMinutes: 5, claimMinutes: 10,
    });

    expect(outcome).toBe('rejected');
    assertReleased(await readSpot(spotId), await lockRef(uid).get());
    expect(await commitToHeadingAdmin({
      spotId, uid, etaMinutes: 8, claimMinutes: 13,
    })).toBe('rejected');
    expect((await readSpot(spotId)).claimState).toBeNull();
  });

  it('keeps a heading claim when auto-release runs after commit succeeds', async () => {
    const uid = nextId('heading_user');
    const spotId = nextId('heading_spot');
    const finderId = nextId('heading_owner');
    const started = Timestamp.fromMillis(Date.now() - 5 * 60_000);
    await seedCommitted({
      spotId,
      uid,
      finderId,
      claimStartedAt: started,
      claimAutoReleaseAt: PAST,
      claimReminderAt: PAST,
    });

    expect(await commitToHeadingAdmin({
      spotId, uid, etaMinutes: 5, claimMinutes: 10, nowMs: 1_700_000_000_000,
    })).toBe('committed');
    await indexModule.processScheduledClaims.run({});

    const spot = await readSpot(spotId);
    assertHeading(spot, await lockRef(uid).get(), uid, spotId, started);
    expect(spot.etaMinutes).toBe(5);
    const notifications = await db.collection('spotNotifications').where('spotId', '==', spotId).get();
    expect(notifications.empty).toBe(true);
  });

  it('does not select an already-heading claim for reminder or auto-release', async () => {
    const uid = nextId('skip_user');
    const spotId = nextId('skip_spot');
    const finderId = nextId('skip_owner');
    const started = Timestamp.fromMillis(Date.now() - 5 * 60_000);
    await seedCommitted({
      spotId,
      uid,
      finderId,
      claimStartedAt: started,
      claimAutoReleaseAt: PAST,
      claimReminderAt: PAST,
      claimState: 'heading',
    });

    await indexModule.processScheduledClaims.run({});

    const spot = await readSpot(spotId);
    expect(spot.claimState).toBe('heading');
    expect(spot.interestedUserId).toBe(uid);
    expect(spot.claimStartedAt.toMillis()).toBe(started.toMillis());
    expect(spot.claimReminderAt.toMillis()).toBe(PAST.toMillis());
    expect(spot.status).toBe('interested');
    expect((await lockRef(uid).get()).data().spotId).toBe(spotId);
    const notifications = await db.collection('spotNotifications').where('spotId', '==', spotId).get();
    expect(notifications.empty).toBe(true);
  });

  it('still sends the reminder pass for a committed claim and leaves the claim in place', async () => {
    const uid = nextId('remind_user');
    const spotId = nextId('remind_spot');
    const finderId = nextId('remind_owner');
    const started = Timestamp.fromMillis(Date.now() - 5 * 60_000);
    await db.doc(`users/${uid}/private/preferences`).set({ lang: 'en' });
    await seedCommitted({
      spotId,
      uid,
      finderId,
      claimStartedAt: started,
      claimAutoReleaseAt: FUTURE,
      claimReminderAt: PAST,
    });

    await indexModule.processScheduledClaims.run({});

    const spot = await readSpot(spotId);
    expect(spot.status).toBe('interested');
    expect(spot.claimState).toBe('committed');
    expect(spot.interestedUserId).toBe(uid);
    expect(spot.claimStartedAt.toMillis()).toBe(started.toMillis());
    expect(spot.claimReminderAt).toBeNull();
    expect(spot.claimReminderSentAt).toBeTruthy();
    expect((await lockRef(uid).get()).data().spotId).toBe(spotId);
    const notifications = await db.collection('spotNotifications').where('spotId', '==', spotId).get();
    expect(notifications.docs.map((doc) => doc.data().type)).toEqual(['scheduled_claim_reminder']);
  });

  it('lets owner leave-now extend claimAutoReleaseAt without resurrecting or dropping a heading claim', async () => {
    const uid = nextId('leave_user');
    const spotId = nextId('leave_spot');
    const finderId = nextId('leave_owner');
    const started = Timestamp.fromMillis(Date.now() - 5 * 60_000);
    await seedCommitted({
      spotId,
      uid,
      finderId,
      claimStartedAt: started,
      claimAutoReleaseAt: PAST,
    });

    const nowMs = Date.now();
    await Promise.all([
      commitToHeadingAdmin({ spotId, uid, etaMinutes: 6, claimMinutes: 11, nowMs }),
      ownerLeaveNow(spotId, nowMs),
      indexModule.processScheduledClaims.run({}),
    ]);

    const spot = await readSpot(spotId);
    const lockSnap = await lockRef(uid).get();
    if (spot.claimState === 'heading') {
      expect(spot.status).toBe('interested');
      expect(spot.interestedUserId).toBe(uid);
      expect(spot.claimStartedAt.toMillis()).toBe(started.toMillis());
      expect(lockSnap.exists).toBe(true);
      expect(lockSnap.data().spotId).toBe(spotId);
    } else {
      expect(spot.claimState).toBeNull();
      expect(spot.interestedUserId).toBeNull();
      expect(spot.claimStartedAt).toBeNull();
      expect(lockSnap.exists).toBe(false);
    }

    const followId = nextId('leave_follow');
    const followUid = nextId('leave_follow_user');
    await seedCommitted({
      spotId: followId,
      uid: followUid,
      finderId,
      claimStartedAt: started,
      claimAutoReleaseAt: PAST,
    });
    await ownerLeaveNow(followId, Date.now());
    expect(await commitToHeadingAdmin({
      spotId: followId, uid: followUid, etaMinutes: 5, claimMinutes: 10,
    })).toBe('committed');
    await indexModule.processScheduledClaims.run({});
    const follow = await readSpot(followId);
    expect(follow.claimState).toBe('heading');
    expect(follow.interestedUserId).toBe(followUid);
    expect(follow.claimStartedAt.toMillis()).toBe(started.toMillis());
    expect(follow.claimAutoReleaseAt).toBeNull();
    expect((await lockRef(followUid).get()).data().spotId).toBe(followId);
  });

  it('treats a second commit as already heading and does not rewrite the first ETA', async () => {
    const uid = nextId('dual_user');
    const spotId = nextId('dual_spot');
    const finderId = nextId('dual_owner');
    const started = Timestamp.fromMillis(Date.now() - 5 * 60_000);
    await seedCommitted({
      spotId,
      uid,
      finderId,
      claimStartedAt: started,
      claimAutoReleaseAt: FUTURE,
    });

    const [first, second] = await Promise.all([
      commitToHeadingAdmin({ spotId, uid, etaMinutes: 5, claimMinutes: 10, nowMs: 1_700_000_000_000 }),
      commitToHeadingAdmin({ spotId, uid, etaMinutes: 9, claimMinutes: 14, nowMs: 1_700_000_000_000 }),
    ]);
    expect([first, second].sort()).toEqual(['already_heading', 'committed']);

    const spot = await readSpot(spotId);
    expect([5, 9]).toContain(spot.etaMinutes);
    const eta = spot.etaMinutes;
    expect(await commitToHeadingAdmin({
      spotId, uid, etaMinutes: 3, claimMinutes: 8, nowMs: 1_700_000_000_000,
    })).toBe('already_heading');
    const after = await readSpot(spotId);
    expect(after.etaMinutes).toBe(eta);
    expect(after.claimState).toBe('heading');
    expect(after.claimStartedAt.toMillis()).toBe(started.toMillis());
    expect((await lockRef(uid).get()).exists).toBe(true);
  });

  it('clears claimStartedAt and only the matching lock when auto-release wins', async () => {
    const uid = nextId('clear_user');
    const spotId = nextId('clear_spot');
    const finderId = nextId('clear_owner');
    const started = Timestamp.fromMillis(Date.now() - 5 * 60_000);
    await seedCommitted({
      spotId,
      uid,
      finderId,
      claimStartedAt: started,
      claimAutoReleaseAt: PAST,
    });
    await lockRef(uid).set({
      spotId: 'some-other-spot',
      claimStartedAt: started,
      claimState: 'committed',
      updatedAt: started,
    });

    await indexModule.processScheduledClaims.run({});

    const spot = await readSpot(spotId);
    expect(spot.status).toBe('available');
    expect(spot.claimStartedAt).toBeNull();
    expect(spot.interestedUserId).toBeNull();
    expect(spot.claimState).toBeNull();
    expect((await lockRef(uid).get()).data().spotId).toBe('some-other-spot');
  });

  it('clears claimStartedAt on an already-expired Ping without reopening it', async () => {
    const uid = nextId('expired_user');
    const spotId = nextId('expired_spot');
    const finderId = nextId('expired_owner');
    const started = Timestamp.fromMillis(Date.now() - 5 * 60_000);
    await seedCommitted({
      spotId,
      uid,
      finderId,
      claimStartedAt: started,
      claimAutoReleaseAt: PAST,
      expiresAt: PAST,
    });

    await indexModule.processScheduledClaims.run({});

    const spot = await readSpot(spotId);
    assertReleased(spot, await lockRef(uid).get(), { status: 'interested' });
    expect(typeof spot.claimAutoReleasedAt.toMillis).toBe('function');
  });
});
