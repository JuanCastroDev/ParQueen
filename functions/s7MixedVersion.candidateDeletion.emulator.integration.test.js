'use strict';

// S7 mixed-version compatibility (t674u): T3 ACCOUNT-DELETION CLEANUP with
// the MERGED CANDIDATE deleteAccount (functions/index.js at main) and the
// head parking callables. The deployed deleteAccount (tree fb660e63) is
// exercised by s7MixedVersion.deployedBaseline.emulator.integration.test.js.
//
// Runs on the isolated emulators (Firestore, Auth, Storage). The Admin app is
// pointed at a separate demo project namespace so the functions emulator's
// head triggers do not fire on these documents.

const guard = require('./isolatedEmulatorGuard');

guard.assertIsolatedEmulator({ services: ['firestore', 'auth', 'storage'] });

const ISOLATED = 'demo-parkqueen-parking-fence-iso';
const PROJECT = 'demo-parkqueen-s7-mixed-version';
if (process.env.GCLOUD_PROJECT !== ISOLATED) throw new Error('Refusing outside the isolated emulator project');
process.env.GCLOUD_PROJECT = PROJECT;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT;
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT, storageBucket: `${PROJECT}.appspot.com` });

const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const candidate = require('./index.js');
const { prepareClaimIntent, claimSpot } = require('./claimSpot');
const { checkRateLimit } = require('./rateLimiter');

const db = getFirestore();
if (require('firebase-admin/app').getApp().options.projectId !== PROJECT) {
  throw new Error('Candidate module is not bound to the mixed-version namespace');
}

const G1 = '3c'.repeat(32);
let sequence = 0;

function ids(label) {
  sequence += 1;
  const n = String(sequence).padStart(12, '0');
  return {
    del: `cdDel_${label}_${n}`,
    b: `cdB_${label}_${n}`,
    finder: `cdF_${label}_${n}`,
    s1: `cdS1_${label}_${n}`,
    s2: `cdS2_${label}_${n}`,
    attempt: `eeeeeeee-eeee-4eee-8eee-${n}`,
    attempt2: `ffffffff-ffff-4fff-8fff-${n}`,
  };
}

function deps() {
  return { db, checkRateLimit, randomBytes: () => Buffer.alloc(32, 5) };
}

function future(ms) { return Timestamp.fromMillis(Date.now() + ms); }

function available(finder, extra = {}) {
  return {
    status: 'available',
    finderId: finder,
    interestedUserId: null,
    expiresAt: future(3_600_000),
    reportedAt: future(3_600_000),
    ...extra,
  };
}

function claimedBy(finder, uid, generation) {
  return available(finder, {
    status: 'interested',
    claimState: 'heading',
    interestedUserId: uid,
    interestedUserName: 'del',
    claimStartedAt: Timestamp.now(),
    etaMinutes: 4,
    interestExpiresAt: future(540_000),
    claimGenerationId: generation,
  });
}

function profile(name) {
  return { status: 'Active', productAccessBlocked: false, username: name };
}

async function seed(row) {
  await getAuth().createUser({ uid: row.del }).catch(() => {});
  await db.collection('users').doc(row.del).set(profile('del'));
  await db.collection('users').doc(row.b).set(profile('bob'));
  await db.collection('users').doc(row.finder).set(profile('bea'));
  await db.collection('spots').doc(row.s1).set(claimedBy(row.finder, row.del, G1));
  await db.collection('users').doc(row.del).collection('activeIncomingClaims').doc('current').set({
    spotId: row.s1,
    claimStartedAt: Timestamp.now(),
    claimState: 'heading',
    updatedAt: Timestamp.now(),
    claimGenerationId: G1,
  });
  await db.collection('spots').doc(row.s2).set(available(row.finder));
}

function deletionRequest(uid) {
  return { auth: { uid, token: { auth_time: Math.floor(Date.now() / 1000) } }, data: {} };
}

function claimReq(uid, spotId, attemptId) {
  return { auth: { uid }, data: { spotId, attemptId, mode: 'immediate', etaMinutes: 4 } };
}

async function claimThroughCallables(uid, spotId, attemptId) {
  const prepared = await prepareClaimIntent(claimReq(uid, spotId, attemptId), deps());
  if (prepared.state !== 'prepared') return { outcome: `prepare:${prepared.state}` };
  return claimSpot(claimReq(uid, spotId, attemptId), deps());
}

async function spotData(id) {
  const snap = await db.collection('spots').doc(id).get();
  return snap.exists ? snap.data() : null;
}

// Interrupt the candidate after spotsAsClaimer by failing the next step
// (chats) once. The step executor records failed and Auth is not deleted.
function interruptAtChats() {
  const original = db.collection.bind(db);
  let armed = true;
  db.collection = (name) => {
    if (armed && name === 'chats') {
      armed = false;
      throw new Error('t674u injected interruption');
    }
    return original(name);
  };
  return () => { db.collection = original; };
}

// Record whether the fence exists when the first destructive step runs.
function watchFirstDestructiveStep(uid, record) {
  const originalDoc = db.doc.bind(db);
  db.doc = (path) => {
    const ref = originalDoc(path);
    if (path === `userLocations/${uid}`) {
      const originalDelete = ref.delete.bind(ref);
      ref.delete = async (...args) => {
        const fence = await originalDoc(`accountLifecycle/${uid}`).get();
        const user = await originalDoc(`users/${uid}`).get();
        record.push({ step: 'userLocations', fence: fence.exists, profile: user.exists });
        return originalDelete(...args);
      };
    }
    return ref;
  };
  return () => { db.doc = originalDoc; };
}

beforeAll(async () => {
  await db.collection('spots').doc('cdConnectionProbe').get();
});

describe('T3 account-deletion cleanup with the merged candidate deleteAccount', () => {
  it('SECURITY T3-CAND-S1: the fence commits before the first destructive cleanup step', async () => {
    const row = ids('order');
    await seed(row);
    await db.doc(`userLocations/${row.del}`).set({ lat: 40.7, lng: -74 });
    const seen = [];
    const restore = watchFirstDestructiveStep(row.del, seen);
    try {
      const result = await candidate.deleteAccount.run(deletionRequest(row.del));
      expect(result).toMatchObject({ success: true });
    } finally {
      restore();
    }
    expect(seen).toEqual([{ step: 'userLocations', fence: true, profile: true }]);
  });

  it('SECURITY T3-CAND-S2: release clears the claim and generation id, removes the lock, and a new claimant can claim', async () => {
    const row = ids('release');
    await seed(row);
    const result = await candidate.deleteAccount.run(deletionRequest(row.del));
    expect(result).toMatchObject({ success: true });
    const spot = await spotData(row.s1);
    expect(spot.status).toBe('available');
    expect(spot.interestedUserId ?? null).toBeNull();
    expect(spot.claimGenerationId ?? null).toBeNull();
    expect((await db.collection('users').doc(row.del).collection('activeIncomingClaims').doc('current').get()).exists).toBe(false);
    expect((await db.doc(`accountLifecycle/${row.del}`).get()).exists).toBe(true);
    const next = await claimThroughCallables(row.b, row.s1, row.attempt);
    expect(next.outcome).toBe('claimed');
    expect((await spotData(row.s1)).interestedUserId).toBe(row.b);
  });

  it('SECURITY T3-CAND-S3: interrupted deletion denies reacquisition by the deleted user, retry completes, and the Ping stays claimable by others', async () => {
    const row = ids('retry');
    await seed(row);
    const restore = interruptAtChats();
    let firstError = null;
    try {
      await candidate.deleteAccount.run(deletionRequest(row.del));
    } catch (error) {
      firstError = error;
    } finally {
      restore();
    }
    expect(firstError && firstError.code).toBe('internal');
    const job = (await db.doc(`accountDeletionJobs/${row.del}`).get()).data();
    expect(job.state).toBe('failed');
    expect(job.steps.spotsAsClaimer).toBe('done');
    expect((await db.doc(`accountLifecycle/${row.del}`).get()).exists).toBe(true);
    expect((await getAuth().getUser(row.del)).uid).toBe(row.del);

    // The deleted user's still-valid session tries to reacquire.
    await expect(prepareClaimIntent(claimReq(row.del, row.s2, row.attempt), deps())).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(claimThroughCallables(row.del, row.s1, row.attempt2)).rejects.toMatchObject({ code: 'permission-denied' });
    expect((await spotData(row.s2)).interestedUserId ?? null).toBeNull();

    // Lease is still fresh after a failed step only if state is running; a
    // failed job is resumable immediately.
    const retry = await candidate.deleteAccount.run(deletionRequest(row.del));
    expect(retry).toMatchObject({ success: true });
    expect((await db.doc(`accountDeletionJobs/${row.del}`).get()).data().state).toBe('completed');
    const left = await db.collection('spots').where('interestedUserId', '==', row.del).get();
    expect(left.size).toBe(0);
    expect((await claimThroughCallables(row.b, row.s1, row.attempt)).outcome).toBe('claimed');
    expect((await db.doc(`accountLifecycle/${row.del}`).get()).exists).toBe(true);
  });
});
