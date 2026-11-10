'use strict';

require('./isolatedEmulatorGuard').assertIsolatedEmulator({ services: ['firestore', 'auth', 'storage'] });

const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { deleteAccount } = require('./index');
const { prepareClaimIntent, revokeClaimIntent, claimSpot, ATTEMPT_COLLECTION } = require('./claimSpot');
const { Timestamp } = require('firebase-admin/firestore');

const PROJECT = 'demo-parkqueen-parking-fence-iso';
if (process.env.GCLOUD_PROJECT !== PROJECT) {
  throw new Error('Refusing deletion-fence reconciliation outside the isolated project');
}
const db = getFirestore();
const auth = getAuth();
const FIXED = 1_700_000_000_000;
let sequence = 0;

function requestFor(uid) {
  const now = Math.floor(Date.now() / 1000);
  return {
    data: {},
    auth: { uid, token: { uid, auth_time: now, aud: PROJECT, sub: uid } },
  };
}

function attemptId() {
  sequence += 1;
  return `dddddddd-dddd-4ddd-8ddd-${String(sequence).padStart(12, '0')}`;
}

async function createAuth(uid, claims) {
  await auth.createUser({ uid });
  if (claims) await auth.setCustomUserClaims(uid, claims);
}

describe('deletion fence reconciliation', () => {
  it('lets an unfenced account prepare without a profile', async () => {
    const uid = `onboard_${Date.now()}`;
    const spotId = `spot_${uid}`;
    const id = attemptId();
    await db.collection('spots').doc(spotId).set({
      status: 'available',
      finderId: 'finder-onboard',
      interestedUserId: null,
      expiresAt: Timestamp.fromMillis(FIXED + 3_600_000),
      reportedAt: Timestamp.fromMillis(FIXED + 3_600_000),
    });
    const prepared = await prepareClaimIntent({
      auth: { uid },
      data: { spotId, attemptId: id, mode: 'immediate', etaMinutes: 4 },
    }, { db, now: () => Timestamp.fromMillis(FIXED), checkRateLimit: async () => {} });
    expect(prepared.state).toBe('prepared');
    expect((await db.doc(`accountLifecycle/${uid}`).get()).exists).toBe(false);
    await db.collection('spots').doc(spotId).delete();
    await db.collection(ATTEMPT_COLLECTION).doc(id).delete();
  });

  it('does not fence a rejected last-administrator deletion', async () => {
    const uid = `lastadmin_${Date.now()}`;
    await createAuth(uid, { role: 'admin' });
    await expect(deleteAccount.run(requestFor(uid))).rejects.toMatchObject({ code: 'failed-precondition' });
    expect((await db.doc(`accountLifecycle/${uid}`).get()).exists).toBe(false);
    expect((await db.doc(`accountDeletionJobs/${uid}`).get()).exists).toBe(false);
    expect((await auth.getUser(uid)).uid).toBe(uid);
    await auth.deleteUser(uid);
  });

  it('keeps the fence when cleanup fails and denies parking while Auth remains', async () => {
    const uid = `retry_${Date.now()}`;
    const spotId = `spot_${uid}`;
    const id = attemptId();
    await createAuth(uid);
    await db.collection('users').doc(uid).set({ status: 'Active', username: 'ada' });
    await db.collection('spots').doc(spotId).set({
      status: 'available',
      finderId: 'finder-retry',
      interestedUserId: null,
      expiresAt: Timestamp.fromMillis(FIXED + 3_600_000),
      reportedAt: Timestamp.fromMillis(FIXED + 3_600_000),
    });
    const original = db.collection.bind(db);
    db.collection = (name) => {
      if (name === 'usernames') throw new Error('usernames unavailable');
      return original(name);
    };
    await expect(deleteAccount.run(requestFor(uid))).rejects.toMatchObject({ code: 'internal' });
    db.collection = original;
    const fence = await db.doc(`accountLifecycle/${uid}`).get();
    expect(fence.exists).toBe(true);
    expect(fence.data().decision).toBe('delete');
    expect((await db.collection('users').doc(uid).get()).exists).toBe(false);
    expect((await auth.getUser(uid)).uid).toBe(uid);
    await expect(prepareClaimIntent({
      auth: { uid },
      data: { spotId, attemptId: id, mode: 'immediate', etaMinutes: 4 },
    }, { db, now: () => Timestamp.fromMillis(FIXED), checkRateLimit: async () => {} })).rejects.toMatchObject({ code: 'permission-denied' });
    expect((await db.collection(ATTEMPT_COLLECTION).doc(id).get()).exists).toBe(false);
    await expect(revokeClaimIntent({
      auth: { uid },
      data: { spotId, attemptId: id, mode: 'immediate', etaMinutes: 4 },
    }, { db, now: () => Timestamp.fromMillis(FIXED), checkRateLimit: async () => {} })).rejects.toMatchObject({ code: 'permission-denied' });
    expect((await db.collection(ATTEMPT_COLLECTION).doc(id).get()).exists).toBe(false);

    const result = await deleteAccount.run(requestFor(uid));
    expect(result.success).toBe(true);
    expect((await db.doc(`accountLifecycle/${uid}`).get()).exists).toBe(true);
    expect((await db.doc(`accountDeletionJobs/${uid}`).get()).data().state).toBe('completed');
    await expect(auth.getUser(uid)).rejects.toMatchObject({ code: 'auth/user-not-found' });
    await db.collection('spots').doc(spotId).delete();
  });

  it('deletes a suspended account and leaves the fence in place', async () => {
    const uid = `suspended_${Date.now()}`;
    await createAuth(uid);
    await db.collection('users').doc(uid).set({ status: 'Suspended', productAccessBlocked: false, username: 'bea' });
    const result = await deleteAccount.run(requestFor(uid));
    expect(result.success).toBe(true);
    expect((await db.doc(`accountLifecycle/${uid}`).get()).data().decision).toBe('delete');
    expect((await db.collection('users').doc(uid).get()).exists).toBe(false);
    await expect(auth.getUser(uid)).rejects.toMatchObject({ code: 'auth/user-not-found' });
    await expect(claimSpot({
      auth: { uid },
      data: { spotId: `spot_${uid}`, attemptId: attemptId(), mode: 'immediate', etaMinutes: 4 },
    }, { db, now: () => Timestamp.fromMillis(FIXED), checkRateLimit: async () => {} })).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
