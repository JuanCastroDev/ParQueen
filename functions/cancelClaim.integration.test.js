'use strict';

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { HttpsError } = require('firebase-functions/v2/https');
const { requireEmulatorProjectId } = require('./emulatorProjectId');
const { checkRateLimit } = require('./rateLimiter');
const { cancelClaim } = require('./cancelClaim');

const PROJECT_ID = requireEmulatorProjectId();
if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID });
const db = getFirestore();

const FINDER = 'finder-int';
const FINGERPRINT = 1_700_000_000_000;
const GEN = 'a1'.repeat(32);
const OTHER = 'b2'.repeat(32);
const CLEAR_KEYS = [
  'interestedUserId', 'interestedUserName', 'interestedUserVehicleColor',
  'interestedUserVehicleType', 'interestedUserVehicleBrand', 'interestedUserTitle',
  'etaMinutes', 'interestExpiresAt', 'claimState', 'claimStartedAt',
  'ownerLeavingNow', 'ownerLeavingNowAt', 'claimReminderAt', 'claimReminderSentAt',
  'claimAutoReleaseAt', 'claimAutoReleasedAt', 'claimGenerationId',
];

let sequence = 0;
function ids() {
  sequence += 1;
  const suffix = `${process.pid}_${sequence}`;
  return { uid: `cc_user_${suffix}`, spotId: `cc_spot_${suffix}` };
}

function request(uid, spotId, extra = {}) {
  return {
    auth: { uid },
    data: { spotId, claimGenerationId: GEN, reason: 'found_elsewhere', ...extra },
  };
}

async function seedLive(uid, spotId, extra = {}) {
  const claimStartedAt = Timestamp.fromMillis(FINGERPRINT);
  await db.collection('spots').doc(spotId).set({
    status: 'interested',
    finderId: FINDER,
    interestedUserId: uid,
    claimState: 'heading',
    claimStartedAt,
    claimGenerationId: GEN,
    expiresAt: Timestamp.fromMillis(Date.now() + 60 * 60 * 1000),
    interestedUserName: 'bob',
    interestedUserVehicleColor: 'red',
    interestedUserVehicleType: 'sedan',
    interestedUserVehicleBrand: 'ford',
    interestedUserTitle: 'Newcomer',
    etaMinutes: 5,
    interestExpiresAt: Timestamp.fromMillis(Date.now() + 10 * 60 * 1000),
    ownerLeavingNow: false,
    ownerLeavingNowAt: null,
    claimReminderAt: Timestamp.fromMillis(Date.now() + 60 * 1000),
    claimReminderSentAt: null,
    claimAutoReleaseAt: Timestamp.fromMillis(Date.now() + 20 * 60 * 1000),
    claimAutoReleasedAt: null,
    ...extra,
  });
  await db.collection('users').doc(uid).collection('activeIncomingClaims').doc('current').set({
    spotId, claimStartedAt, claimState: 'heading',
  });
}

async function invoke(uid, spotId, extra = {}, deps = {}) {
  return cancelClaim(request(uid, spotId, extra), {
    db,
    checkRateLimit: async () => {},
    ...deps,
  });
}

// The Firestore emulator locks a document once this transaction reads it.
// An afterReads write to that same document waits on the lock, and the
// transaction waits on afterReads. Production Firestore instead retries the
// callback when a read document changes. These tests roll the first attempt
// back, commit the new state, and then run the callback again. They do not
// claim the in-lock concurrent write was executed.
async function invokeSecondAttempt(uid, spotId, observed, betweenAttempts) {
  const original = db.runTransaction.bind(db);
  let armed = true;
  db.runTransaction = async (updateFunction, transactionOptions) => {
    if (!armed) return original(updateFunction, transactionOptions);
    armed = false;
    const stop = new Error('test-abort-before-commit');
    stop.code = 'test-abort-before-commit';
    try {
      await original(async (tx) => {
        observed.firstPlan = await updateFunction(tx);
        throw stop;
      }, transactionOptions);
      throw new Error('first attempt committed');
    } catch (error) {
      if (error !== stop && (!error || error.code !== 'test-abort-before-commit')) throw error;
    }
    await betweenAttempts();
    return original(updateFunction, transactionOptions);
  };
  try {
    return await invoke(uid, spotId);
  } finally {
    db.runTransaction = original;
  }
}

describe('cancelClaim Admin SDK transaction', () => {
  it('cancels an unexpired claim, deletes the matching lock, and creates one notification', async () => {
    const { uid, spotId } = ids();
    await db.collection('users').doc(uid).set({ status: 'Active', productAccessBlocked: false });
    await seedLive(uid, spotId);
    const result = await invoke(uid, spotId);
    expect(result.outcome).toBe('cancelled');
    const spot = (await db.collection('spots').doc(spotId).get()).data();
    expect(spot.status).toBe('available');
    for (const key of CLEAR_KEYS) expect(spot[key]).toBeNull();
    const lock = await db.collection('users').doc(uid).collection('activeIncomingClaims').doc('current').get();
    expect(lock.exists).toBe(false);
    const notes = await db.collection('spotNotifications').where('spotId', '==', spotId).get();
    expect(notes.size).toBe(1);
    expect(notes.docs[0].id).toBe(`claimer_cancelled_${spotId}_${GEN}`);
    expect(notes.docs[0].data().targetUserId).toBe(FINDER);
  });

  it('allows a missing profile and boolean-false product access', async () => {
    const missing = ids();
    await seedLive(missing.uid, missing.spotId);
    await expect(invoke(missing.uid, missing.spotId)).resolves.toMatchObject({ outcome: 'cancelled' });

    const open = ids();
    await db.collection('users').doc(open.uid).set({ status: 'Active', productAccessBlocked: false });
    await seedLive(open.uid, open.spotId);
    await expect(invoke(open.uid, open.spotId)).resolves.toMatchObject({ outcome: 'cancelled' });
  });

  it('denies suspended, blocked, and malformed profiles without writing', async () => {
    for (const profile of [
      { status: 'Suspended', productAccessBlocked: false },
      { status: 'Active', productAccessBlocked: true },
      { status: 'Active', productAccessBlocked: 'false' },
    ]) {
      const { uid, spotId } = ids();
      await db.collection('users').doc(uid).set(profile);
      await seedLive(uid, spotId);
      await expect(invoke(uid, spotId)).rejects.toMatchObject({ code: 'permission-denied' });
      expect((await db.collection('spots').doc(spotId).get()).data().status).toBe('interested');
    }
  });

  it('sees a suspension committed after the first attempt rolls back', async () => {
    const { uid, spotId } = ids();
    await db.collection('users').doc(uid).set({ status: 'Active', productAccessBlocked: false });
    await seedLive(uid, spotId);
    const observed = { firstPlan: null };
    await expect(invokeSecondAttempt(uid, spotId, observed, async () => {
      const mid = (await db.collection('spots').doc(spotId).get()).data();
      expect(mid.status).toBe('interested');
      expect(mid.interestedUserId).toBe(uid);
      expect(mid.claimGenerationId).toBe(GEN);
      expect((await db.collection('spotNotifications').where('spotId', '==', spotId).get()).size).toBe(0);
      await db.collection('users').doc(uid).update({ status: 'Suspended' });
    })).rejects.toMatchObject({ code: 'permission-denied' });
    expect(observed.firstPlan).toEqual({ outcome: 'cancelled' });
    const spot = (await db.collection('spots').doc(spotId).get()).data();
    expect(spot.status).toBe('interested');
    expect(spot.interestedUserId).toBe(uid);
    expect(spot.claimGenerationId).toBe(GEN);
    const notes = await db.collection('spotNotifications').where('spotId', '==', spotId).get();
    expect(notes.size).toBe(0);
  });

  it('does not reopen a Ping when expiresAt is present but not a timestamp', async () => {
    const { uid, spotId } = ids();
    await seedLive(uid, spotId, { expiresAt: 'not-a-timestamp' });
    await expect(invoke(uid, spotId)).resolves.toMatchObject({ outcome: 'cancelled' });
    const spot = (await db.collection('spots').doc(spotId).get()).data();
    expect(spot.status).toBe('interested');
    expect(spot.interestedUserId).toBeNull();
    expect(spot.claimStartedAt).toBeNull();
  });

  it('does not let an older generation cancel a newer one with the same timestamp', async () => {
    const { uid, spotId } = ids();
    await seedLive(uid, spotId, { claimGenerationId: OTHER });
    await expect(invoke(uid, spotId, { claimGenerationId: GEN })).resolves.toMatchObject({ outcome: 'stale_claim' });
    const spot = (await db.collection('spots').doc(spotId).get()).data();
    expect(spot.status).toBe('interested');
    expect(spot.interestedUserId).toBe(uid);
    expect(spot.claimStartedAt.toMillis()).toBe(FINGERPRINT);
    expect(spot.claimGenerationId).toBe(OTHER);
    const note = await db.collection('spotNotifications').doc(`claimer_cancelled_${spotId}_${GEN}`).get();
    expect(note.exists).toBe(false);
    await expect(invoke(uid, spotId, { claimGenerationId: OTHER })).resolves.toMatchObject({ outcome: 'cancelled' });
    expect((await db.collection('spots').doc(spotId).get()).data().claimGenerationId).toBeNull();
  });

  it('fails closed for an absent or malformed stored generation id', async () => {
    const absent = ids();
    await seedLive(absent.uid, absent.spotId);
    await db.collection('spots').doc(absent.spotId).update({ claimGenerationId: FieldValue.delete() });
    await expect(invoke(absent.uid, absent.spotId)).resolves.toMatchObject({ outcome: 'stale_claim' });
    expect((await db.collection('spots').doc(absent.spotId).get()).data().interestedUserId).toBe(absent.uid);

    const unreadable = ids();
    await seedLive(unreadable.uid, unreadable.spotId, { claimGenerationId: 'not-a-generation' });
    await expect(invoke(unreadable.uid, unreadable.spotId)).resolves.toMatchObject({ outcome: 'stale_claim' });
    const spot = (await db.collection('spots').doc(unreadable.spotId).get()).data();
    expect(spot.interestedUserId).toBe(unreadable.uid);
    expect(spot.status).toBe('interested');
    expect(spot.claimGenerationId).toBe('not-a-generation');
    const notes = await db.collection('spotNotifications').where('spotId', '==', unreadable.spotId).get();
    expect(notes.size).toBe(0);
  });

  it('keeps an expired Ping from reopening and preserves a lock that names another Ping', async () => {
    const { uid, spotId } = ids();
    await seedLive(uid, spotId, { expiresAt: Timestamp.fromMillis(Date.now() - 60_000) });
    await db.collection('users').doc(uid).collection('activeIncomingClaims').doc('current').set({ spotId: 'elsewhere' });
    const other = `other_${uid}`;
    await db.collection('users').doc(other).collection('activeIncomingClaims').doc('current').set({ spotId });
    await expect(invoke(uid, spotId)).resolves.toMatchObject({ outcome: 'cancelled' });
    const spot = (await db.collection('spots').doc(spotId).get()).data();
    expect(spot.status).toBe('interested');
    expect(spot.interestedUserId).toBeNull();
    expect(spot.claimStartedAt).toBeNull();
    const own = await db.collection('users').doc(uid).collection('activeIncomingClaims').doc('current').get();
    expect(own.data().spotId).toBe('elsewhere');
    const foreign = await db.collection('users').doc(other).collection('activeIncomingClaims').doc('current').get();
    expect(foreign.data().spotId).toBe(spotId);
  });

  it('accepts a missing lock', async () => {
    const { uid, spotId } = ids();
    await seedLive(uid, spotId);
    await db.collection('users').doc(uid).collection('activeIncomingClaims').doc('current').delete();
    await expect(invoke(uid, spotId)).resolves.toMatchObject({ outcome: 'cancelled' });
    expect((await db.collection('spots').doc(spotId).get()).data().status).toBe('available');
  });

  it('aborts every write when the deterministic notification already exists', async () => {
    const { uid, spotId } = ids();
    await seedLive(uid, spotId);
    const noteId = `claimer_cancelled_${spotId}_${GEN}`;
    await db.collection('spotNotifications').doc(noteId).set({ spotId, type: 'claimer_cancelled' });
    await expect(invoke(uid, spotId)).rejects.toMatchObject({ code: 'failed-precondition' });
    const spot = (await db.collection('spots').doc(spotId).get()).data();
    expect(spot.status).toBe('interested');
    expect(spot.interestedUserId).toBe(uid);
    const lock = await db.collection('users').doc(uid).collection('activeIncomingClaims').doc('current').get();
    expect(lock.exists).toBe(true);
  });

  it('returns already_resolved for a second call, a swept claim, and a new claimant', async () => {
    const first = ids();
    await seedLive(first.uid, first.spotId);
    await invoke(first.uid, first.spotId);
    await expect(invoke(first.uid, first.spotId)).resolves.toMatchObject({ outcome: 'already_resolved' });
    const notes = await db.collection('spotNotifications').where('spotId', '==', first.spotId).get();
    expect(notes.size).toBe(1);

    const swept = ids();
    await seedLive(swept.uid, swept.spotId, {
      interestedUserId: null, claimState: null, claimStartedAt: null, status: 'interested',
    });
    await expect(invoke(swept.uid, swept.spotId)).resolves.toMatchObject({ outcome: 'already_resolved' });
    expect((await db.collection('spotNotifications').where('spotId', '==', swept.spotId).get()).size).toBe(0);

    const replaced = ids();
    await seedLive(replaced.uid, replaced.spotId, { interestedUserId: 'new-claimer' });
    await expect(invoke(replaced.uid, replaced.spotId)).resolves.toMatchObject({ outcome: 'already_resolved' });
    expect((await db.collection('spots').doc(replaced.spotId).get()).data().interestedUserId).toBe('new-claimer');
  });

  it('does not reopen a Ping that is already occupied when the transaction reads it', async () => {
    const { uid, spotId } = ids();
    await seedLive(uid, spotId, {
      status: 'occupied',
      claimState: 'arrived_pending_outcome',
      arrivedAt: Timestamp.now(),
    });
    await expect(invoke(uid, spotId)).resolves.toMatchObject({ outcome: 'already_resolved' });
    const spot = (await db.collection('spots').doc(spotId).get()).data();
    expect(spot.status).toBe('occupied');
    expect(spot.claimState).toBe('arrived_pending_outcome');
    expect(spot.interestedUserId).toBe(uid);
    expect(spot.claimGenerationId).toBe(GEN);
    expect((await db.collection('spotNotifications').where('spotId', '==', spotId).get()).size).toBe(0);
  });

  it('does not reopen a Ping that arrival commits after the first attempt rolls back', async () => {
    const { uid, spotId } = ids();
    await seedLive(uid, spotId);
    const observed = { firstPlan: null };
    const result = await invokeSecondAttempt(uid, spotId, observed, async () => {
      const mid = (await db.collection('spots').doc(spotId).get()).data();
      expect(mid.status).toBe('interested');
      expect(mid.interestedUserId).toBe(uid);
      expect(mid.claimGenerationId).toBe(GEN);
      expect((await db.collection('spotNotifications').where('spotId', '==', spotId).get()).size).toBe(0);
      await db.collection('spots').doc(spotId).update({
        status: 'occupied',
        claimState: 'arrived_pending_outcome',
        arrivedAt: Timestamp.now(),
      });
    });
    expect(observed.firstPlan).toEqual({ outcome: 'cancelled' });
    expect(result).toMatchObject({ outcome: 'already_resolved' });
    const spot = (await db.collection('spots').doc(spotId).get()).data();
    expect(spot.status).toBe('occupied');
    expect(spot.claimState).toBe('arrived_pending_outcome');
    expect(spot.interestedUserId).toBe(uid);
    expect(spot.claimGenerationId).toBe(GEN);
    expect((await db.collection('spotNotifications').where('spotId', '==', spotId).get()).size).toBe(0);
  });

  it('commits one of two overlapping cancels and resolves the other from the retried read', async () => {
    const { uid, spotId } = ids();
    await seedLive(uid, spotId);
    let arrived = 0;
    let release;
    const gate = new Promise((resolve, reject) => {
      release = resolve;
      setTimeout(() => reject(new Error('cancel barrier timed out')), 8000);
    });
    const afterReads = () => {
      arrived += 1;
      if (arrived === 2) release();
      return gate;
    };
    const deps = { db, checkRateLimit: async () => {}, allowTestHooks: true, afterReads };
    const [a, b] = await Promise.all([
      cancelClaim(request(uid, spotId), deps),
      cancelClaim(request(uid, spotId), deps),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(['already_resolved', 'cancelled']);
    const spot = (await db.collection('spots').doc(spotId).get()).data();
    expect(spot.status).toBe('available');
    for (const key of CLEAR_KEYS) expect(spot[key]).toBeNull();
    expect((await db.collection('spotNotifications').where('spotId', '==', spotId).get()).size).toBe(1);
    const lock = await db.collection('users').doc(uid).collection('activeIncomingClaims').doc('current').get();
    expect(lock.exists).toBe(false);
  });

  it('enforces 10 attempts per 10 minutes', async () => {
    const { uid, spotId } = ids();
    await seedLive(uid, spotId);
    for (let i = 0; i < 10; i += 1) {
      await checkRateLimit(uid, 'cancelClaim', { limit: 10, windowSec: 600 });
    }
    await expect(invoke(uid, spotId, {}, { checkRateLimit })).rejects.toBeInstanceOf(HttpsError);
    await expect(invoke(uid, spotId, {}, { checkRateLimit })).rejects.toMatchObject({ code: 'resource-exhausted' });
    expect((await db.collection('spots').doc(spotId).get()).data().status).toBe('interested');
  });
});
