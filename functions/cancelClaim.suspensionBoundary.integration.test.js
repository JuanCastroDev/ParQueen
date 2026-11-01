'use strict';

// Cross-boundary checks for the S7 suspension workflow and cancelClaim.
// Callable HTTP is intentionally not used. The Auth emulator's verifyIdToken
// rejects a disabled user when the Admin app is in emulator mode, which
// returns unauthenticated before the handler. Production firebase-functions
// 7.3.2 calls verifyIdToken(idToken) without checkRevoked, so a verified
// request can still reach the handler. These tests pass that request shape
// to the production handlers and require the Firestore flag to deny it.

const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { requireEmulatorProjectId } = require('./emulatorProjectId');
const { cancelClaim } = require('./cancelClaim');
const { PRODUCT_ACCESS_DENIED } = require('./productAccess');
const {
  adminSuspendUser,
  adminUnsuspendUser,
  _suspensionConcurrencyHooks: hooks,
} = require('./index.js');

const PROJECT_ID = requireEmulatorProjectId();
if (PROJECT_ID !== 'demo-parkqueen-functions-test') {
  throw new Error('These tests run only against demo-parkqueen-functions-test');
}
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  throw new Error('Firestore and Auth emulators must be set');
}

const db = getFirestore();
const adminAuth = getAuth();
const FINGERPRINT = 1_700_000_000_000;
const users = [];
const spots = [];

function uidOf(label) {
  return `xb_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function adminRequest(adminUid, data) {
  const now = Math.floor(Date.now() / 1000);
  return {
    data,
    auth: {
      uid: adminUid,
      token: { uid: adminUid, role: 'admin', auth_time: now, iat: now, exp: now + 3600 },
    },
  };
}

function claimantRequest(uid, spotId, extra = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    auth: {
      uid,
      token: { uid, auth_time: now - 120, iat: now - 120, exp: now + 3600 },
    },
    data: { spotId, claimGenerationId: 'a1'.repeat(32), reason: 'found_elsewhere', ...extra },
  };
}

async function runCall(fn, request) {
  try {
    return { result: await fn.run(request) };
  } catch (error) {
    return { error };
  }
}

async function createAdmin() {
  const uid = uidOf('admin');
  users.push(uid);
  await adminAuth.createUser({ uid });
  await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
  return uid;
}

async function createClaimant(profile) {
  const uid = uidOf('claimer');
  users.push(uid);
  await adminAuth.createUser({ uid });
  if (profile !== null) await db.doc(`users/${uid}`).set({ id: uid, ...profile });
  return uid;
}

async function seedClaim(uid, spotExtra = {}) {
  const spotId = uidOf('spot');
  spots.push(spotId);
  const claimStartedAt = Timestamp.fromMillis(FINGERPRINT);
  const finderId = `finder_secret_${spotId}`;
  await db.collection('spots').doc(spotId).set({
    status: 'interested',
    finderId,
    interestedUserId: uid,
    interestedUserName: `claimant_secret_${uid}`,
    claimState: 'heading',
    claimStartedAt,
    claimGenerationId: 'a1'.repeat(32),
    expiresAt: Timestamp.fromMillis(Date.now() + 60 * 60 * 1000),
    interestedUserVehicleColor: 'red',
    interestedUserVehicleType: 'sedan',
    interestedUserVehicleBrand: 'ford',
    interestedUserTitle: 'Newcomer',
    etaMinutes: 4,
    ...spotExtra,
  });
  await db.doc(`users/${uid}/activeIncomingClaims/current`).set({ spotId, claimStartedAt, claimState: 'heading' });
  return { spotId, finderId };
}

async function spotData(spotId) {
  return (await db.collection('spots').doc(spotId).get()).data();
}

async function notesFor(spotId) {
  const snap = await db.collection('spotNotifications').where('spotId', '==', spotId).get();
  return snap.docs.map((docSnap) => docSnap.data());
}

async function assertUntouched(uid, spotId) {
  const spot = await spotData(spotId);
  expect(spot.status).toBe('interested');
  expect(spot.interestedUserId).toBe(uid);
  expect(spot.claimState).toBe('heading');
  const lock = await db.doc(`users/${uid}/activeIncomingClaims/current`).get();
  expect(lock.exists).toBe(true);
  expect(lock.data().spotId).toBe(spotId);
  expect(await notesFor(spotId)).toEqual([]);
}

function assertPublicDenial(error, secrets) {
  expect(error).toMatchObject({
    code: 'permission-denied',
    message: PRODUCT_ACCESS_DENIED,
  });
  expect(error.details).toBeUndefined();
  const published = `${error.message} ${JSON.stringify(error.details ?? null)}`;
  for (const secret of secrets) expect(published).not.toContain(secret);
}

async function expectDenied(uid, spotId, secrets) {
  let error = null;
  try {
    await cancelClaim(claimantRequest(uid, spotId));
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeTruthy();
  assertPublicDenial(error, secrets);
}

function clearHooks() {
  hooks.beforeAuthRpc = null;
  hooks.afterAuthRpc = null;
  hooks.afterLockAcquired = null;
  hooks.acquireAttempts = null;
}

function waitWithBound(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function settled(promise) {
  return promise.then((result) => ({ result }), (error) => ({ error }));
}

describe('cancelClaim suspension boundary', () => {
  afterEach(async () => {
    clearHooks();
    for (const spotId of spots.splice(0)) {
      const notes = await db.collection('spotNotifications').where('spotId', '==', spotId).get();
      await Promise.all(notes.docs.map((docSnap) => docSnap.ref.delete()));
      await db.collection('spots').doc(spotId).delete().catch(() => {});
    }
    for (const uid of users.splice(0)) {
      await adminAuth.deleteUser(uid).catch(() => {});
      await db.recursiveDelete(db.doc(`users/${uid}`)).catch(() => {});
      const logs = await db.collection('adminAuditLog').where('targetUserId', '==', uid).get();
      await Promise.all(logs.docs.map((docSnap) => docSnap.ref.delete()));
    }
  });

  it('A and H: a completed suspend denies cancelClaim and leaves the Ping unchanged', async () => {
    const admin = await createAdmin();
    const reason = `private-reason-${uidOf('why')}`;
    const uid = await createClaimant({ status: 'Active', username: 'claimer' });
    const { spotId, finderId } = await seedClaim(uid);
    const suspended = await runCall(adminSuspendUser, adminRequest(admin, { userId: uid, reason }));
    expect(suspended.error).toBeUndefined();
    expect(suspended.result).toEqual({ success: true });

    const profile = (await db.doc(`users/${uid}`).get()).data();
    expect(profile.status).toBe('Suspended');
    expect(profile.productAccessBlocked).toBe(true);
    expect((await adminAuth.getUser(uid)).disabled).toBe(true);

    await expectDenied(uid, spotId, [reason, finderId, `claimant_secret_${uid}`, admin]);
    await assertUntouched(uid, spotId);
  });

  it('B: the recorded pre-enable unsuspend state still denies cancellation', async () => {
    const admin = await createAdmin();
    const uid = await createClaimant({ status: 'Active', username: 'pending' });
    const { spotId, finderId } = await seedClaim(uid);
    expect((await runCall(adminSuspendUser, adminRequest(admin, { userId: uid, reason: 'spam' }))).result)
      .toEqual({ success: true });

    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    let holding = () => {};
    const holdingP = new Promise((resolve) => { holding = resolve; });
    hooks.beforeAuthRpc = async ({ userId, op }) => {
      if (op !== 'unsuspend' || userId !== uid) return;
      holding();
      await gate;
    };

    const pending = runCall(adminUnsuspendUser, adminRequest(admin, { userId: uid }));
    try {
      await holdingP;
      const profile = (await db.doc(`users/${uid}`).get()).data();
      expect(profile.status).toBe('Active');
      expect(profile.productAccessBlocked).toBe(true);
      expect((await adminAuth.getUser(uid)).disabled).toBe(true);
      const audits = (await db.collection('adminAuditLog').where('targetUserId', '==', uid).get()).docs
        .map((docSnap) => docSnap.data());
      expect(audits.some((row) => row.action === 'user.unsuspend.pending' && row.productAccessBlocked === true)).toBe(true);
      await expectDenied(uid, spotId, [finderId, `claimant_secret_${uid}`]);
      await assertUntouched(uid, spotId);
    } finally {
      release();
    }

    expect((await pending).result).toEqual({ success: true });
    expect((await db.doc(`users/${uid}`).get()).data().productAccessBlocked).toBeUndefined();
    await assertUntouched(uid, spotId);
  });

  it('C: a failed Auth enable keeps the blocking flag and cancelClaim denies', async () => {
    const admin = await createAdmin();
    const uid = await createClaimant({ status: 'Active', username: 'enablefail' });
    const { spotId, finderId } = await seedClaim(uid);
    expect((await runCall(adminSuspendUser, adminRequest(admin, { userId: uid, reason: 'spam' }))).result)
      .toEqual({ success: true });

    const auth = getAuth();
    const original = auth.updateUser.bind(auth);
    auth.updateUser = async (userId, props) => {
      if (userId === uid && props && props.disabled === false) {
        throw Object.assign(new Error('enable failed'), { code: 'auth/internal-error' });
      }
      return original(userId, props);
    };
    try {
      const failed = await runCall(adminUnsuspendUser, adminRequest(admin, { userId: uid }));
      expect(failed.error.code).toBe('aborted');
      const profile = (await db.doc(`users/${uid}`).get()).data();
      expect(profile.status).toBe('Active');
      expect(profile.productAccessBlocked).toBe(true);
      expect((await adminAuth.getUser(uid)).disabled).toBe(true);
      const audits = (await db.collection('adminAuditLog').where('targetUserId', '==', uid).get()).docs
        .map((docSnap) => docSnap.data());
      expect(audits.some((row) => row.action === 'user.unsuspend.partial' && row.productAccessBlocked === true)).toBe(true);
      expect(audits.some((row) => row.action === 'user.unsuspend')).toBe(false);
      await expectDenied(uid, spotId, [finderId, uid]);
      await assertUntouched(uid, spotId);
    } finally {
      auth.updateUser = original;
    }
  });

  it('D: a completed unsuspend lets the claimant cancel once', async () => {
    const admin = await createAdmin();
    const uid = await createClaimant({ status: 'Active', username: 'restored' });
    const { spotId, finderId } = await seedClaim(uid);
    expect((await runCall(adminSuspendUser, adminRequest(admin, { userId: uid, reason: 'spam' }))).result)
      .toEqual({ success: true });
    expect((await runCall(adminUnsuspendUser, adminRequest(admin, { userId: uid }))).result)
      .toEqual({ success: true });

    const profile = (await db.doc(`users/${uid}`).get()).data();
    expect(profile.status).toBe('Active');
    expect(profile.productAccessBlocked).toBeUndefined();
    expect((await adminAuth.getUser(uid)).disabled).toBe(false);

    await expect(cancelClaim(claimantRequest(uid, spotId))).resolves.toEqual({ outcome: 'cancelled' });
    const spot = await spotData(spotId);
    expect(spot.status).toBe('available');
    expect(spot.interestedUserId).toBeNull();
    expect(spot.claimState).toBeNull();
    expect(spot.claimStartedAt).toBeNull();
    expect((await db.doc(`users/${uid}/activeIncomingClaims/current`).get()).exists).toBe(false);
    const notes = await notesFor(spotId);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({
      spotId,
      senderId: uid,
      targetUserId: finderId,
      type: 'claimer_cancelled',
    });
  });

  it('E: a verified request for a disabled user is denied by the Firestore flag', async () => {
    const admin = await createAdmin();
    const uid = await createClaimant({ status: 'Active', username: 'token' });
    const { spotId } = await seedClaim(uid);
    expect((await runCall(adminSuspendUser, adminRequest(admin, { userId: uid, reason: 'spam' }))).result)
      .toEqual({ success: true });
    expect((await adminAuth.getUser(uid)).disabled).toBe(true);

    const request = claimantRequest(uid, spotId);
    expect(request.auth.uid).toBe(uid);
    await expect(cancelClaim(request)).rejects.toMatchObject({
      code: 'permission-denied',
      message: PRODUCT_ACCESS_DENIED,
    });
    await assertUntouched(uid, spotId);
  });

  it('F1: a committed suspension block denies cancel before Auth disable', async () => {
    const admin = await createAdmin();
    const uid = await createClaimant({ status: 'Active', username: 'f1' });
    const { spotId, finderId } = await seedClaim(uid);
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    let holding = () => {};
    const holdingP = new Promise((resolve) => { holding = resolve; });
    let observed = null;
    hooks.beforeAuthRpc = async ({ userId, op }) => {
      if (op !== 'suspend' || userId !== uid) return;
      observed = {
        profile: (await db.doc(`users/${userId}`).get()).data(),
        disabled: (await adminAuth.getUser(userId)).disabled,
      };
      holding();
      await gate;
    };
    const suspendSettled = runCall(adminSuspendUser, adminRequest(admin, { userId: uid, reason: 'spam' }));
    let suspended = null;
    try {
      await waitWithBound(holdingP, 10000, 'suspension did not reach the pre-disable hook');
      expect(observed.profile.status).toBe('Suspended');
      expect(observed.profile.productAccessBlocked).toBe(true);
      expect(observed.disabled).toBe(false);
      await expectDenied(uid, spotId, [finderId, admin]);
      await assertUntouched(uid, spotId);
    } finally {
      release();
      suspended = await suspendSettled;
    }
    expect(suspended.result).toEqual({ success: true });
    expect((await adminAuth.getUser(uid)).disabled).toBe(true);
    await expectDenied(uid, spotId, [finderId, admin]);
    await assertUntouched(uid, spotId);
  });

  it('F2: a held cancellation is released without waiting on the suspension lock', async () => {
    const admin = await createAdmin();
    const uid = await createClaimant({ status: 'Active', username: 'f2' });
    const { spotId } = await seedClaim(uid);
    let readsDone = () => {};
    const readsDoneP = new Promise((resolve) => { readsDone = resolve; });
    let release = () => {};
    const releaseP = new Promise((resolve) => { release = resolve; });
    let released = false;
    const safeRelease = () => {
      if (released) return;
      released = true;
      release();
    };
    let hookSeenWhilePaused = false;
    hooks.beforeAuthRpc = async ({ userId, op }) => {
      if (op !== 'suspend' || userId !== uid) return;
      hookSeenWhilePaused = true;
    };
    const cancelSettled = settled(cancelClaim(claimantRequest(uid, spotId), {
      allowTestHooks: true,
      afterReads: async () => {
        readsDone();
        await waitWithBound(releaseP, 10000, 'cancel barrier was not released');
      },
    }));
    let suspendSettled = null;
    try {
      await waitWithBound(readsDoneP, 10000, 'cancel reads did not finish');
      suspendSettled = runCall(adminSuspendUser, adminRequest(admin, { userId: uid, reason: 'spam' }));
      safeRelease();
      expect(hookSeenWhilePaused).toBe(false);
      const cancelOutcome = await cancelSettled;
      const suspendOutcome = await suspendSettled;
      expect(suspendOutcome.result).toEqual({ success: true });
      const profile = (await db.doc(`users/${uid}`).get()).data();
      expect(profile.status).toBe('Suspended');
      expect(profile.productAccessBlocked).toBe(true);
      expect((await db.doc(`users/${uid}/private/suspensionLock`).get()).exists).toBe(false);

      const spotBefore = await spotData(spotId);
      const notesBefore = await notesFor(spotId);
      const lockBefore = await db.doc(`users/${uid}/activeIncomingClaims/current`).get();
      if (cancelOutcome.result) {
        expect(cancelOutcome.result.outcome).toBe('cancelled');
        expect(spotBefore.status).toBe('available');
        expect(spotBefore.interestedUserId).toBeNull();
        expect(lockBefore.exists).toBe(false);
        expect(notesBefore).toHaveLength(1);
        expect(notesBefore[0].type).toBe('claimer_cancelled');
      } else {
        expect(cancelOutcome.error.code).toBe('permission-denied');
        expect(cancelOutcome.error.message).toBe(PRODUCT_ACCESS_DENIED);
        expect(spotBefore.status).toBe('interested');
        expect(spotBefore.interestedUserId).toBe(uid);
        expect(lockBefore.exists).toBe(true);
        expect(notesBefore).toEqual([]);
      }

      await expectDenied(uid, spotId, []);
      const spotAfter = await spotData(spotId);
      expect(spotAfter.status).toBe(spotBefore.status);
      expect(spotAfter.interestedUserId ?? null).toBe(spotBefore.interestedUserId ?? null);
      expect(spotAfter.claimState ?? null).toBe(spotBefore.claimState ?? null);
      const notesAfter = await notesFor(spotId);
      expect(notesAfter.map((note) => note.type)).toEqual(notesBefore.map((note) => note.type));
      expect(notesAfter.map((note) => note.senderId ?? null)).toEqual(notesBefore.map((note) => note.senderId ?? null));
      expect((await db.doc(`users/${uid}/activeIncomingClaims/current`).get()).exists).toBe(lockBefore.exists);
    } finally {
      safeRelease();
      await cancelSettled;
      if (suspendSettled) await suspendSettled;
    }
  });

  it('F3: a test-controlled callback replay denies the block on the second read', async () => {
    const uid = 'f3-claimer';
    const spotId = 'f3-spot';
    const finderId = 'f3-finder';
    const liveSpot = {
      status: 'interested',
      finderId,
      interestedUserId: uid,
      claimState: 'heading',
      claimStartedAt: { toMillis: () => FINGERPRINT },
      claimGenerationId: 'a1'.repeat(32),
    };
    const committedSpot = { ...liveSpot };
    function view(user) {
      return new Map([
        [`users/${uid}`, { ...user }],
        [`spots/${spotId}`, { ...liveSpot, claimStartedAt: { toMillis: () => FINGERPRINT } }],
      ]);
    }
    function ref(path) {
      return {
        path,
        collection(name) {
          return { doc(id) { return ref(`${path}/${name}/${id}`); } };
        },
      };
    }
    function txFor(docs) {
      return {
        async get(target) {
          if (!docs.has(target.path)) return { exists: false, data: () => undefined };
          return { exists: true, data: () => ({ ...docs.get(target.path) }) };
        },
        update(target, patch) {
          docs.set(target.path, { ...docs.get(target.path), ...patch });
        },
        delete(target) { docs.delete(target.path); },
        create(target, data) { docs.set(target.path, { ...data }); },
      };
    }
    let attempts = 0;
    let hooksRun = 0;
    let firstOutcome = null;
    let scratchStatus = null;
    const replayDb = {
      collection(name) {
        return { doc(id) { return ref(`${name}/${id}`); } };
      },
      async runTransaction(fn) {
        attempts += 1;
        const firstView = view({ status: 'Active', productAccessBlocked: false });
        firstOutcome = await fn(txFor(firstView));
        scratchStatus = firstView.get(`spots/${spotId}`).status;
        attempts += 1;
        return fn(txFor(view({ status: 'Suspended', productAccessBlocked: true })));
      },
    };
    let error = null;
    try {
      await cancelClaim(claimantRequest(uid, spotId), {
        db: replayDb,
        checkRateLimit: async () => {},
        now: () => ({ toMillis: () => FINGERPRINT + 1000 }),
        allowTestHooks: true,
        afterReads: async () => { hooksRun += 1; },
      });
    } catch (caught) {
      error = caught;
    }
    expect(firstOutcome).toEqual({ outcome: 'cancelled' });
    expect(scratchStatus).toBe('available');
    expect(attempts).toBe(2);
    expect(hooksRun).toBe(1);
    assertPublicDenial(error, [finderId, uid]);
    expect(committedSpot.status).toBe('interested');
    expect(committedSpot.interestedUserId).toBe(uid);
  });

  it('G: a missing profile follows the allow contract and a non-false flag denies', async () => {
    const missingUid = await createClaimant(null);
    const missingSpot = await seedClaim(missingUid);
    await expect(cancelClaim(claimantRequest(missingUid, missingSpot.spotId))).resolves.toEqual({ outcome: 'cancelled' });
    expect((await spotData(missingSpot.spotId)).status).toBe('available');

    for (const productAccessBlocked of ['false', 'true', 0, 1, null, '']) {
      const uid = await createClaimant({ status: 'Active', productAccessBlocked, username: 'malformed' });
      const { spotId } = await seedClaim(uid);
      await expect(cancelClaim(claimantRequest(uid, spotId))).rejects.toMatchObject({
        code: 'permission-denied',
        message: PRODUCT_ACCESS_DENIED,
      });
      await assertUntouched(uid, spotId);
    }
  });

  it('H: a suspended caller cannot learn another claimant from the public error', async () => {
    const admin = await createAdmin();
    const reason = `private-reason-${uidOf('hidden')}`;
    const caller = await createClaimant({ status: 'Active', username: 'outsider' });
    const other = uidOf('other');
    const { spotId, finderId } = await seedClaim(caller, { interestedUserId: other, interestedUserName: `other_secret_${other}` });
    expect((await runCall(adminSuspendUser, adminRequest(admin, { userId: caller, reason }))).result)
      .toEqual({ success: true });

    await expectDenied(caller, spotId, [reason, finderId, other, `other_secret_${other}`, admin]);
    const spot = await spotData(spotId);
    expect(spot.interestedUserId).toBe(other);
    expect(await notesFor(spotId)).toEqual([]);
  });
});
