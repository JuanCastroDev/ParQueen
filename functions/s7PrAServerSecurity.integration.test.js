'use strict';

// S7 PR-A server security corrections (t721u). Regression contracts for:
//   D5a  revokeClaimIntent applies cancelClaim's suspension denial
//        (status Suspended / productAccessBlocked) to every outcome, with no
//        write, and is serialized against a suspension committed after the
//        transactional profile read.
//   DR-2 finderCancelSpot writes the claimant notice in the deleting
//        transaction, with the delete trigger's id, body and candidate rules;
//        a callable retry, an overlapping call and the head trigger's later
//        writeFinderCancelNotice cannot add a second notice; receipt and
//        trust-penalty behavior are unchanged.
//   Q8   adminSuspendUser refuses an administrator target before any write.
//
// Runs in the main Functions emulator suite (vite.functions.config.ts): the
// handlers are called in-process against the Firestore emulator, the
// admin-suspension cases go through the Functions and Auth emulators. The
// historical t674u harnesses (s7MixedVersion.*) keep their own records.

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { requireEmulatorProjectId } = require('./emulatorProjectId');

const PROJECT_ID = requireEmulatorProjectId();
const indexModule = require('./index.js');
if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID });
const db = getFirestore();
const adminAuth = getAuth();

const { prepareClaimIntent, claimSpot, revokeClaimIntent, ATTEMPT_COLLECTION, COUNTER_COLLECTION } = require('./claimSpot');
const { finderCancelSpot } = require('./finderCancelSpot');
const { NOTICE_MESSAGE, noticeId, writeFinderCancelNotice } = require('./finderCancelNotice');
const { receiptDocumentId } = require('./finderCancelReceipt');

const FUNCTIONS_BASE = `http://localhost:5001/${PROJECT_ID}/us-central1`;
const AUTH_EMULATOR = process.env.FIREBASE_AUTH_EMULATOR_HOST
  ? `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}`
  : 'http://localhost:9099';
const G1 = '7a'.repeat(32);
const G2 = '8b'.repeat(32);
const PAUSE_MS = 2000;
const RESTRICTED = [
  ['Suspended', { status: 'Suspended' }],
  ['productAccessBlocked', { productAccessBlocked: true }],
];
let sequence = 0;

function ids(label) {
  sequence += 1;
  const n = String(sequence).padStart(12, '0');
  const tag = `${process.pid}_${label}_${n}`;
  return {
    a: `praA_${tag}`,
    finder: `praF_${tag}`,
    s1: `praS1_${tag}`,
    attempt: `eeeeeeee-eeee-4eee-8eee-${n}`,
  };
}

function deps(extra = {}) {
  return { db, checkRateLimit: async () => {}, randomBytes: () => Buffer.alloc(32, 5), ...extra };
}

function future(ms) { return Timestamp.fromMillis(Date.now() + ms); }

function profile(name, extra = {}) {
  return { status: 'Active', productAccessBlocked: false, username: name, ...extra };
}

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

function claimedBy(finder, uid, generation, extra = {}) {
  return available(finder, {
    status: 'interested',
    claimState: 'heading',
    interestedUserId: uid,
    interestedUserName: 'ada',
    claimStartedAt: Timestamp.now(),
    etaMinutes: 4,
    interestExpiresAt: future(540_000),
    claimGenerationId: generation,
    ...extra,
  });
}

async function seedUsers(row) {
  await db.collection('users').doc(row.a).set(profile('ada'));
  await db.collection('users').doc(row.finder).set(profile('bea', { trustStats: { handoffsCancelledByFinder: 0 } }));
}

async function setLock(uid, spotId, generation) {
  await db.collection('users').doc(uid).collection('activeIncomingClaims').doc('current').set({
    spotId, claimGenerationId: generation, claimState: 'heading', claimStartedAt: Timestamp.now(), updatedAt: Timestamp.now(),
  });
}

async function spotData(id) {
  const snap = await db.collection('spots').doc(id).get();
  return snap.exists ? snap.data() : null;
}

async function lockData(uid) {
  const snap = await db.collection('users').doc(uid).collection('activeIncomingClaims').doc('current').get();
  return snap.exists ? snap.data() : null;
}

async function attemptData(attemptId) {
  const snap = await db.collection(ATTEMPT_COLLECTION).doc(attemptId).get();
  return snap.exists ? snap.data() : null;
}

async function notices(spotId) {
  const snap = await db.collection('spotNotifications').where('spotId', '==', spotId).get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function penaltyOf(uid) {
  const snap = await db.collection('users').doc(uid).get();
  return snap.exists ? ((snap.data().trustStats || {}).handoffsCancelledByFinder || 0) : null;
}

function claimReq(uid, spotId, attemptId) {
  return { auth: { uid }, data: { spotId, attemptId, mode: 'immediate', etaMinutes: 4 } };
}

async function claimThroughCallables(row) {
  const prepared = await prepareClaimIntent(claimReq(row.a, row.s1, row.attempt), deps());
  expect(prepared.state).toBe('prepared');
  const claimed = await claimSpot(claimReq(row.a, row.s1, row.attempt), deps());
  expect(claimed.outcome).toBe('claimed');
  return claimed;
}

function finderReq(row, claimant, generation, status = 'interested', claimState = 'heading') {
  return {
    auth: { uid: row.finder },
    data: { spotId: row.s1, status, interestedUserId: claimant, claimState, claimGenerationId: generation },
  };
}

function deletedEvent(spotId, data, eventId) {
  return { id: eventId, params: { spotId }, data: { id: spotId, data: () => data }, time: new Date().toISOString() };
}

// ─── D5a: revokeClaimIntent suspension denial ───────────────────────────────
describe('S7 PR-A D5a: revokeClaimIntent applies the cancelClaim suspension boundary', () => {
  for (const [label, patch] of RESTRICTED) {
    it(`PRA-R1-${label}: a restricted claimant cannot revoke a committed claim; spot, lock, attempt unchanged, no notice`, async () => {
      const row = ids(`r1${label}`);
      await seedUsers(row);
      await db.collection('spots').doc(row.s1).set(available(row.finder));
      const claimed = await claimThroughCallables(row);
      await db.collection('users').doc(row.a).set(profile('ada', patch));
      const before = { spot: await spotData(row.s1), lock: await lockData(row.a), attempt: await attemptData(row.attempt) };
      await expect(revokeClaimIntent(claimReq(row.a, row.s1, row.attempt), deps()))
        .rejects.toMatchObject({ code: 'permission-denied', message: 'Product access is not available.' });
      expect(await spotData(row.s1)).toEqual(before.spot);
      expect((await spotData(row.s1)).claimGenerationId).toBe(claimed.claimGenerationId);
      expect(await lockData(row.a)).toEqual(before.lock);
      expect(await attemptData(row.attempt)).toEqual(before.attempt);
      expect(await notices(row.s1)).toEqual([]);
    });

    it(`PRA-R2-${label}: a restricted caller cannot revoke a prepared intent; attempt and counter unchanged`, async () => {
      const row = ids(`r2${label}`);
      await seedUsers(row);
      await db.collection('spots').doc(row.s1).set(available(row.finder));
      expect((await prepareClaimIntent(claimReq(row.a, row.s1, row.attempt), deps())).state).toBe('prepared');
      await db.collection('users').doc(row.a).set(profile('ada', patch));
      const counterBefore = (await db.collection(COUNTER_COLLECTION).doc(row.a).get()).data();
      await expect(revokeClaimIntent(claimReq(row.a, row.s1, row.attempt), deps()))
        .rejects.toMatchObject({ code: 'permission-denied' });
      expect((await attemptData(row.attempt)).state).toBe('prepared');
      expect((await db.collection(COUNTER_COLLECTION).doc(row.a).get()).data()).toEqual(counterBefore);
    });

    it(`PRA-R3-${label}: a restricted caller cannot write a revoked tombstone for an absent attempt`, async () => {
      const row = ids(`r3${label}`);
      await seedUsers(row);
      await db.collection('users').doc(row.a).set(profile('ada', patch));
      await db.collection('spots').doc(row.s1).set(available(row.finder));
      await expect(revokeClaimIntent(claimReq(row.a, row.s1, row.attempt), deps()))
        .rejects.toMatchObject({ code: 'permission-denied' });
      expect(await attemptData(row.attempt)).toBeNull();
    });
  }

  it('PRA-R4: an Active claimant still revokes: release, lock cleared, one finder notice (no regression)', async () => {
    const row = ids('r4');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(available(row.finder));
    const claimed = await claimThroughCallables(row);
    const result = await revokeClaimIntent(claimReq(row.a, row.s1, row.attempt), deps());
    expect(result.outcome).toBe('released');
    const spot = await spotData(row.s1);
    expect(spot.status).toBe('available');
    expect(spot.interestedUserId).toBeNull();
    expect(await lockData(row.a)).toBeNull();
    const notes = await notices(row.s1);
    expect(notes.map((n) => n.id)).toEqual([`claimer_cancelled_${row.s1}_${claimed.claimGenerationId}`]);
    expect((await revokeClaimIntent(claimReq(row.a, row.s1, row.attempt), deps())).outcome).toBe('released');
    expect(await notices(row.s1)).toHaveLength(1);
  });

  it('PRA-R5: a suspension committed after the transactional profile read cannot be followed by a release', async () => {
    const row = ids('r5');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(available(row.finder));
    await claimThroughCallables(row);
    const before = await spotData(row.s1);
    const events = [];
    const writers = [];
    let reads = 0;
    const hook = async () => {
      reads += 1;
      if (reads > 1) {
        events.push(`lifecycle-reread:${reads}`);
        return;
      }
      events.push('product-read-active');
      const writer = db.runTransaction(async (tx) => {
        tx.set(db.collection('users').doc(row.a), profile('ada', { status: 'Suspended' }));
      }).then(() => { events.push('suspension-committed'); return 'committed'; })
        .catch((error) => { events.push(`suspension-writer-failed:${error.code || 'error'}`); return 'failed'; });
      writers.push(writer);
      const paused = await Promise.race([writer, new Promise((resolve) => { setTimeout(() => resolve('blocked'), PAUSE_MS); })]);
      events.push(paused === 'committed' ? 'suspension-committed-while-paused' : 'suspension-blocked-while-product-held');
    };
    let failure = null;
    try {
      const result = await revokeClaimIntent(claimReq(row.a, row.s1, row.attempt), deps({ allowTestHooks: true, afterLifecycleRead: hook }));
      events.push(`product-returned:${result.outcome}`);
    } catch (error) {
      failure = error;
      events.push(`product-failed:${error.code}`);
    }
    await Promise.race([
      Promise.all(writers),
      new Promise((_, reject) => { setTimeout(() => reject(new Error('suspension writer did not settle')), 8000); }),
    ]);
    const after = await spotData(row.s1);
    const released = after.interestedUserId !== before.interestedUserId;
    console.log(JSON.stringify({ t721u: 'PRA-R5', events, released, reads }));
    expect(events[0]).toBe('product-read-active');
    expect(events).toContain('suspension-committed');
    const pausedCommit = events.includes('suspension-committed-while-paused');
    const blocked = events.includes('suspension-blocked-while-product-held');
    const returnedAt = events.findIndex((e) => e.startsWith('product-returned:'));
    const failedAt = events.findIndex((e) => e.startsWith('product-failed:'));
    const reread = events.findIndex((e) => e.startsWith('lifecycle-reread:'));
    if (blocked && !pausedCommit && reread === -1 && returnedAt !== -1) {
      // Serialized before the suspension: the release may complete.
      expect(failure).toBeNull();
      expect(released).toBe(true);
    } else if (pausedCommit && failedAt !== -1) {
      // The suspension committed while paused; the retried transaction
      // reread the profile and denied with no release.
      expect(failure && failure.code).toBe('permission-denied');
      expect(released).toBe(false);
      expect(await notices(row.s1)).toEqual([]);
    } else {
      throw new Error(`Unclassified suspension order: ${JSON.stringify(events)}`);
    }
    expect((await db.collection('users').doc(row.a).get()).data().status).toBe('Suspended');
  });
});

// ─── DR-2: finderCancelSpot claimant notice ─────────────────────────────────
describe('S7 PR-A DR-2: finderCancelSpot writes the claimant notice in its transaction', () => {
  it('PRA-N1: a generation finder cancel writes exactly one notice with the trigger id and body, plus the receipt; the lock is cleared', async () => {
    const row = ids('n1');
    await seedUsers(row);
    const before = claimedBy(row.finder, row.a, G1);
    await db.collection('spots').doc(row.s1).set(before);
    await setLock(row.a, row.s1, G1);
    expect(await finderCancelSpot(finderReq(row, row.a, G1), deps())).toEqual({ outcome: 'deleted' });
    expect(await spotData(row.s1)).toBeNull();
    expect(await lockData(row.a)).toBeNull();
    const notes = await notices(row.s1);
    expect(notes).toHaveLength(1);
    expect(notes[0].id).toBe(noticeId(row.s1, row.a, G1));
    expect(notes[0].id).toBe(`finder_cancelled_${row.s1}_${row.a}_${G1}`);
    expect(notes[0]).toMatchObject({
      spotId: row.s1, senderId: row.finder, targetUserId: row.a, type: 'cancelled', message: NOTICE_MESSAGE,
    });
    expect(Object.keys(notes[0]).sort()).toEqual(['createdAt', 'id', 'message', 'senderId', 'spotId', 'targetUserId', 'type']);
    const receiptId = receiptDocumentId(row.s1, { kind: 'generation', claimGenerationId: G1 });
    expect((await db.collection('finderCancelReceipts').doc(receiptId).get()).data()).toMatchObject({
      kind: 'generation', finderId: row.finder, interestedUserId: row.a, claimGenerationId: G1,
    });
  });

  it('PRA-N2: callable retry and head-trigger redelivery add no second notice; the receipt-gated penalty applies once', async () => {
    const row = ids('n2');
    await seedUsers(row);
    const before = claimedBy(row.finder, row.a, G1);
    await db.collection('spots').doc(row.s1).set(before);
    await setLock(row.a, row.s1, G1);
    expect((await finderCancelSpot(finderReq(row, row.a, G1), deps())).outcome).toBe('deleted');
    expect((await finderCancelSpot(finderReq(row, row.a, G1), deps())).outcome).toBe('already_deleted');
    const deliveryTime = Date.now();
    const direct = await writeFinderCancelNotice(db, row.s1, before, `direct_${row.s1}`, deliveryTime);
    expect(direct).toEqual({ wrote: false, reason: 'already_recorded', id: noticeId(row.s1, row.a, G1) });
    await indexModule.updateTrustOnSpotDelete.run(deletedEvent(row.s1, before, `ev1_${row.s1}`));
    await indexModule.updateTrustOnSpotDelete.run(deletedEvent(row.s1, before, `ev1_${row.s1}`));
    await indexModule.updateTrustOnSpotDelete.run(deletedEvent(row.s1, before, `ev2_${row.s1}`));
    const notes = await notices(row.s1);
    expect(notes.map((n) => n.id)).toEqual([noticeId(row.s1, row.a, G1)]);
    expect(await penaltyOf(row.finder)).toBe(1);
  });

  it('PRA-N3: two overlapping finder cancels delete once and write one notice', async () => {
    const row = ids('n3');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(claimedBy(row.finder, row.a, G1));
    await setLock(row.a, row.s1, G1);
    const [first, second] = await Promise.all([
      finderCancelSpot(finderReq(row, row.a, G1), deps()),
      finderCancelSpot(finderReq(row, row.a, G1), deps()),
    ]);
    expect([first.outcome, second.outcome].sort()).toEqual(['already_deleted', 'deleted']);
    expect((await notices(row.s1)).map((n) => n.id)).toEqual([noticeId(row.s1, row.a, G1)]);
  });

  it('PRA-N4: an existing notice with the same id is not overwritten', async () => {
    const row = ids('n4');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(claimedBy(row.finder, row.a, G1));
    const earlier = Timestamp.fromMillis(Date.now() - 60_000);
    await db.collection('spotNotifications').doc(noticeId(row.s1, row.a, G1)).set({
      spotId: row.s1, senderId: row.finder, targetUserId: row.a, type: 'cancelled', message: NOTICE_MESSAGE, createdAt: earlier,
    });
    expect((await finderCancelSpot(finderReq(row, row.a, G1), deps())).outcome).toBe('deleted');
    const notes = await notices(row.s1);
    expect(notes).toHaveLength(1);
    expect(notes[0].createdAt.toMillis()).toBe(earlier.toMillis());
  });

  it('PRA-N5: no notice for an expired Ping or an admin-sourced Ping (trigger candidate rules); receipt still written', async () => {
    const row = ids('n5');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(claimedBy(row.finder, row.a, G1, { expiresAt: Timestamp.fromMillis(Date.now() - 60_000) }));
    expect((await finderCancelSpot(finderReq(row, row.a, G1), deps())).outcome).toBe('deleted');
    expect(await notices(row.s1)).toEqual([]);
    const receiptId = receiptDocumentId(row.s1, { kind: 'generation', claimGenerationId: G1 });
    expect((await db.collection('finderCancelReceipts').doc(receiptId).get()).exists).toBe(true);

    const row2 = ids('n5admin');
    await seedUsers(row2);
    await db.collection('spots').doc(row2.s1).set(claimedBy(row2.finder, row2.a, G1, { source: 'admin' }));
    expect((await finderCancelSpot(finderReq(row2, row2.a, G1), deps())).outcome).toBe('deleted');
    expect(await notices(row2.s1)).toEqual([]);
  });

  it('PRA-N6: a stale confirmation (newer generation stored) deletes nothing and writes no notice', async () => {
    const row = ids('n6');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(claimedBy(row.finder, row.a, G2));
    await setLock(row.a, row.s1, G2);
    expect((await finderCancelSpot(finderReq(row, row.a, G1), deps())).outcome).toBe('stale');
    expect((await spotData(row.s1)).claimGenerationId).toBe(G2);
    expect(await notices(row.s1)).toEqual([]);
  });

  for (const [label, patch] of RESTRICTED) {
    it(`PRA-N7-${label}: a restricted finder is denied with no delete, receipt or notice`, async () => {
      const row = ids(`n7${label}`);
      await seedUsers(row);
      await db.collection('users').doc(row.finder).set(profile('bea', patch));
      await db.collection('spots').doc(row.s1).set(claimedBy(row.finder, row.a, G1));
      await expect(finderCancelSpot(finderReq(row, row.a, G1), deps())).rejects.toMatchObject({ code: 'permission-denied' });
      expect((await spotData(row.s1)).claimGenerationId).toBe(G1);
      expect(await notices(row.s1)).toEqual([]);
      const receiptId = receiptDocumentId(row.s1, { kind: 'generation', claimGenerationId: G1 });
      expect((await db.collection('finderCancelReceipts').doc(receiptId).get()).exists).toBe(false);
    });
  }
});

// ─── Q8: admin-on-admin suspension guard ───────────────────────────────────
async function callFn(name, idToken, data = {}) {
  const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
    body: JSON.stringify({ data }),
  });
  return res.json();
}

async function signIn(uid) {
  const customToken = await adminAuth.createCustomToken(uid);
  const res = await fetch(`${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-key`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  });
  const body = await res.json();
  if (!body.idToken) throw new Error('sign-in failed');
  return body.idToken;
}

async function makeUser(uid, role) {
  try { await adminAuth.createUser({ uid }); } catch { /* exists */ }
  await adminAuth.setCustomUserClaims(uid, role ? { role } : null);
  await db.doc(`users/${uid}`).set({ id: uid, username: uid.slice(0, 12), status: 'Active' });
}

describe('S7 PR-A Q8: adminSuspendUser refuses an administrator target', () => {
  const made = [];
  const uidOf = (label) => {
    const uid = `praQ8_${label}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    made.push(uid);
    return uid;
  };

  afterAll(async () => {
    for (const uid of made) {
      await adminAuth.deleteUser(uid).catch(() => {});
      await db.recursiveDelete(db.doc(`users/${uid}`)).catch(() => {});
      const logs = await db.collection('adminAuditLog').where('targetUserId', '==', uid).get();
      await Promise.all(logs.docs.map((d) => d.ref.delete()));
    }
  });

  it('PRA-Q1: an admin cannot suspend another admin; no Auth, profile, private, intent, lock or audit write', async () => {
    const caller = uidOf('caller');
    const target = uidOf('target');
    await makeUser(caller, 'admin');
    await makeUser(target, 'admin');
    const token = await signIn(caller);
    const resp = await callFn('adminSuspendUser', token, { userId: target, reason: 'q8' });
    expect(resp.error?.status).toBe('PERMISSION_DENIED');
    const user = await adminAuth.getUser(target);
    expect(user.disabled).toBe(false);
    expect(user.customClaims?.role).toBe('admin');
    const profileDoc = (await db.doc(`users/${target}`).get()).data();
    expect(profileDoc.status).toBe('Active');
    expect(profileDoc.productAccessBlocked).toBeUndefined();
    for (const doc of ['moderation', 'authIntent', 'suspensionLock']) {
      expect((await db.doc(`users/${target}/private/${doc}`).get()).exists).toBe(false);
    }
    expect((await db.collection('adminAuditLog').where('targetUserId', '==', target).get()).size).toBe(0);
  });

  it('PRA-Q2: the guard is admin-only: a staff target is suspended, and so is a former admin after the role is removed', async () => {
    const caller = uidOf('caller2');
    const staff = uidOf('staff');
    const former = uidOf('former');
    await makeUser(caller, 'admin');
    await makeUser(staff, 'staff');
    await makeUser(former, 'admin');
    const token = await signIn(caller);
    const staffResp = await callFn('adminSuspendUser', token, { userId: staff, reason: 'q8 staff' });
    expect(staffResp.error).toBeUndefined();
    expect(staffResp.result?.success).toBe(true);
    expect((await adminAuth.getUser(staff)).disabled).toBe(true);
    expect((await db.doc(`users/${staff}`).get()).data().status).toBe('Suspended');

    expect((await callFn('adminSuspendUser', token, { userId: former, reason: 'q8 former' })).error?.status).toBe('PERMISSION_DENIED');
    await adminAuth.setCustomUserClaims(former, null);
    const formerResp = await callFn('adminSuspendUser', token, { userId: former, reason: 'q8 former' });
    expect(formerResp.error).toBeUndefined();
    expect(formerResp.result?.success).toBe(true);
    expect((await adminAuth.getUser(former)).disabled).toBe(true);
  });
});
