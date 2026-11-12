'use strict';

// S7 mixed-version compatibility (t674u): the DEPLOYED production
// deleteAccount and updateTrustOnSpotDelete, combined with the merged
// main-branch parking callables.
//
// Deployed-source identity (evidence: t660u hash reproduction, t661u tsv):
//   deleteAccount and updateTrustOnSpotDelete carry firebase-functions-hash
//   821238b0138f958a111f1bee89b0b32feaa10947, reproduced exactly from the
//   functions/ tree fb660e63b275f9437dd1d64c86151eed731b5333 (CRLF), first
//   reachable at 9d338ba86ff055d0da81f288c11c5a911465a1d1 on main.
// This test materializes that tree from the local git object database into a
// temporary directory, verifies every blob byte-for-byte against the tree
// listing, and loads the deployed index.js from there. Repository source at
// main is never substituted for the deployed source. Runtime dependencies
// resolve to this checkout's functions/node_modules (not the deployed image).
// This is a test fixture only; it is NOT an approved rollback target.
//
// T3: deployed deleteAccount vs the candidate (candidate side in
//     s7MixedVersion.candidateDeletion.emulator.integration.test.js).
// T4: finder cancel through finderCancelSpot with the deployed trigger.
//
// CHARACTERIZATION tests document behavior. SECURITY tests are release
// contracts. A contract the deployed/mixed combination does not meet is an
// it.fails tagged BLOCKER[...] or GAP[...]; the assertion is the expected safe
// behavior, unchanged.

const guard = require('./isolatedEmulatorGuard');

guard.assertIsolatedEmulator({ services: ['firestore', 'auth', 'storage'] });

const ISOLATED = 'demo-parkqueen-parking-fence-iso';
const PROJECT = 'demo-parkqueen-s7-mixed-version';
if (process.env.GCLOUD_PROJECT !== ISOLATED) throw new Error('Refusing outside the isolated emulator project');

const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEPLOYED_TREE = 'fb660e63b275f9437dd1d64c86151eed731b5333';
const DEPLOYED_LABEL = '821238b0138f958a111f1bee89b0b32feaa10947';
const DEPLOYED_INDEX_BLOB = 'aba4e63e0401856c7863ed0970493413718cba09';

function git(args, input) {
  return execFileSync('git', args, {
    cwd: path.resolve(__dirname, '..'),
    input,
    maxBuffer: 256 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function blobSha(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

function materializeDeployedTree() {
  let type;
  try {
    type = git(['cat-file', '-t', DEPLOYED_TREE]).toString().trim();
  } catch (error) {
    throw new Error(`DEPLOYED_SOURCE_UNAVAILABLE: tree ${DEPLOYED_TREE} is not in this clone (fetch full history)`);
  }
  if (type !== 'tree') throw new Error(`DEPLOYED_SOURCE_UNAVAILABLE: ${DEPLOYED_TREE} is a ${type}`);
  const listing = git(['ls-tree', '-r', '-z', '--full-tree', DEPLOYED_TREE]).toString('utf8')
    .split('\0').filter(Boolean).map((line) => {
      const tab = line.indexOf('\t');
      const [mode, kind, sha] = line.slice(0, tab).split(' ');
      return { mode, kind, sha, file: line.slice(tab + 1) };
    });
  const index = listing.find((entry) => entry.file === 'index.js');
  if (!index || index.sha !== DEPLOYED_INDEX_BLOB) throw new Error('DEPLOYED_SOURCE_MISMATCH: index.js blob');
  const blobs = listing.filter((entry) => entry.kind === 'blob');
  const batch = git(['cat-file', '--batch'], `${blobs.map((entry) => entry.sha).join('\n')}\n`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'parqueen-deployed-fb660e63-'));
  let offset = 0;
  for (const entry of blobs) {
    const headerEnd = batch.indexOf(0x0a, offset);
    const [sha, kind, size] = batch.slice(offset, headerEnd).toString('utf8').split(' ');
    const length = Number(size);
    const bytes = batch.subarray(headerEnd + 1, headerEnd + 1 + length);
    offset = headerEnd + 1 + length + 1;
    if (sha !== entry.sha || kind !== 'blob' || blobSha(bytes) !== entry.sha) {
      throw new Error(`DEPLOYED_SOURCE_MISMATCH: ${entry.file}`);
    }
    if (entry.file.split('/').some((part) => part === '..' || part === '')) throw new Error('unsafe path');
    const target = path.join(root, ...entry.file.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
  }
  for (const entry of blobs) {
    if (blobSha(fs.readFileSync(path.join(root, ...entry.file.split('/')))) !== entry.sha) {
      throw new Error(`DEPLOYED_SOURCE_MISMATCH after write: ${entry.file}`);
    }
  }
  fs.symlinkSync(path.join(__dirname, 'node_modules'), path.join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  return { root, files: blobs.length };
}

const deployedTree = materializeDeployedTree();
process.env.GCLOUD_PROJECT = PROJECT;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT;
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT, storageBucket: `${PROJECT}.appspot.com` });

const deployed = require(path.join(deployedTree.root, 'index.js'));
const { getApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { prepareClaimIntent, claimSpot } = require('./claimSpot');
const { finderCancelSpot } = require('./finderCancelSpot');
const { checkRateLimit } = require('./rateLimiter');

if (getApp().options.projectId !== PROJECT) throw new Error('Deployed module is not bound to the mixed-version namespace');
const db = getFirestore();

const G1 = '4d'.repeat(32);
const G2 = '5e'.repeat(32);
let sequence = 0;

function ids(label) {
  sequence += 1;
  const n = String(sequence).padStart(12, '0');
  return {
    del: `dpDel_${label}_${n}`,
    a: `dpA_${label}_${n}`,
    b: `dpB_${label}_${n}`,
    finder: `dpF_${label}_${n}`,
    s1: `dpS1_${label}_${n}`,
    s2: `dpS2_${label}_${n}`,
    s9: `dpS9_${label}_${n}`,
    attempt: `abababab-abab-4bab-8bab-${n}`,
    attempt2: `cdcdcdcd-cdcd-4dcd-8dcd-${n}`,
  };
}

function deps() {
  return { db, checkRateLimit, randomBytes: () => Buffer.alloc(32, 6) };
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
  const data = available(finder, {
    status: 'interested',
    claimState: 'heading',
    interestedUserId: uid,
    interestedUserName: 'someone',
    claimStartedAt: Timestamp.now(),
    etaMinutes: 4,
    interestExpiresAt: future(540_000),
  });
  if (generation !== undefined) data.claimGenerationId = generation;
  return data;
}

function profile(name, extra = {}) {
  return { status: 'Active', productAccessBlocked: false, username: name, ...extra };
}

async function lock(uid, spotId, generation) {
  const body = { spotId, claimStartedAt: Timestamp.now(), claimState: 'heading', updatedAt: Timestamp.now() };
  if (generation) body.claimGenerationId = generation;
  await db.collection('users').doc(uid).collection('activeIncomingClaims').doc('current').set(body);
}

async function lockData(uid) {
  const snap = await db.collection('users').doc(uid).collection('activeIncomingClaims').doc('current').get();
  return snap.exists ? snap.data() : null;
}

async function spotData(id) {
  const snap = await db.collection('spots').doc(id).get();
  return snap.exists ? snap.data() : null;
}

function claimReq(uid, spotId, attemptId) {
  return { auth: { uid }, data: { spotId, attemptId, mode: 'immediate', etaMinutes: 4 } };
}

async function claimThroughCallables(uid, spotId, attemptId) {
  const prepared = await prepareClaimIntent(claimReq(uid, spotId, attemptId), deps());
  if (prepared.state !== 'prepared') return { outcome: `prepare:${prepared.state}` };
  return claimSpot(claimReq(uid, spotId, attemptId), deps());
}

function deletionRequest(uid) {
  return { auth: { uid, token: { auth_time: Math.floor(Date.now() / 1000) } }, data: {} };
}

function deletedEvent(spotId, data, eventId) {
  return { id: eventId, params: { spotId }, data: { id: spotId, data: () => data }, time: new Date().toISOString() };
}

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

function watchFirstDestructiveStep(uid, record) {
  const originalDoc = db.doc.bind(db);
  db.doc = (p) => {
    const ref = originalDoc(p);
    if (p === `userLocations/${uid}`) {
      const originalDelete = ref.delete.bind(ref);
      ref.delete = async (...args) => {
        const fence = await originalDoc(`accountLifecycle/${uid}`).get();
        record.push({ step: 'userLocations', fence: fence.exists });
        return originalDelete(...args);
      };
    }
    return ref;
  };
  return () => { db.doc = originalDoc; };
}

async function seedDeletion(row) {
  await getAuth().createUser({ uid: row.del }).catch(() => {});
  await db.collection('users').doc(row.del).set(profile('del'));
  await db.collection('users').doc(row.b).set(profile('bob'));
  await db.collection('users').doc(row.finder).set(profile('bea'));
  await db.collection('spots').doc(row.s1).set(claimedBy(row.finder, row.del, G1));
  await lock(row.del, row.s1, G1);
  await db.collection('spots').doc(row.s2).set(available(row.finder));
  await db.doc(`userLocations/${row.del}`).set({ lat: 40.7, lng: -74 });
}

async function penaltyOf(uid) {
  const snap = await db.collection('users').doc(uid).get();
  return snap.exists ? ((snap.data().trustStats || {}).handoffsCancelledByFinder || 0) : null;
}

async function noticesFor(spotId) {
  const snap = await db.collection('spotNotifications').where('spotId', '==', spotId).get();
  return snap.docs.map((doc) => ({ id: doc.id, type: doc.data().type, target: doc.data().targetUserId }));
}

beforeAll(async () => {
  await db.collection('spots').doc('dpConnectionProbe').get();
});

afterAll(() => {
  // Remove only the temporary directory this file created.
  try {
    fs.unlinkSync(path.join(deployedTree.root, 'node_modules'));
  } catch {
    // junction removal is best-effort; rmSync below handles the rest
  }
  fs.rmSync(deployedTree.root, { recursive: true, force: true });
});


// An expected failure counts only when the safe-behavior assertion itself fails.
// A setup, seeding or emulator error is logged and swallowed, so it.fails reports
// the case as broken instead of counting it as the reproduced BLOCKER/GAP.
function assertionOnly(fn) {
  return async () => {
    try {
      await fn();
    } catch (error) {
      if (error && error.name === 'AssertionError') throw error;
      console.error('expected-failure case failed for an unexpected reason:', error);
    }
  };
}
const itExpectedUnsafe = (title, fn) => it.fails(title, assertionOnly(fn));

describe('deployed-source pinning', () => {
  it('materializes tree fb660e63 byte-exactly and exports the deployed handlers', () => {
    expect(deployedTree.files).toBeGreaterThan(50);
    expect(typeof deployed.deleteAccount.run).toBe('function');
    expect(typeof deployed.updateTrustOnSpotDelete.run).toBe('function');
    expect(DEPLOYED_LABEL).toMatch(/^[0-9a-f]{40}$/);
  });

  it('isolation sentinel: deleting a claimed Ping in this namespace fires no emulator trigger', async () => {
    const row = ids('sentinel');
    await db.collection('users').doc(row.finder).set(profile('bea', { trustStats: { handoffsCancelledByFinder: 0 } }));
    await db.collection('spots').doc(row.s1).set(claimedBy(row.finder, row.a, G1));
    await lock(row.a, row.s1, G1);
    await db.collection('spots').doc(row.s1).delete();
    await new Promise((resolve) => { setTimeout(resolve, 3000); });
    expect(await penaltyOf(row.finder)).toBe(0);
    expect(await lockData(row.a)).not.toBeNull();
    expect(await noticesFor(row.s1)).toEqual([]);
  });
});

describe('T3 deployed deleteAccount (fb660e63) with head parking callables', () => {
  const scenario = {};

  it('CHARACTERIZATION T3-DEP-C1: deployed deletion releases the claim but keeps claimGenerationId and writes no fence', async () => {
    const row = ids('release');
    await seedDeletion(row);
    const seen = [];
    const restore = watchFirstDestructiveStep(row.del, seen);
    let result;
    try {
      result = await deployed.deleteAccount.run(deletionRequest(row.del));
    } finally {
      restore();
    }
    expect(result).toMatchObject({ success: true });
    const spot = await spotData(row.s1);
    expect(spot.status).toBe('available');
    expect(spot.interestedUserId).toBeUndefined();
    expect(spot.claimGenerationId).toBe(G1);
    expect(spot.claimState).toBe('heading');
    expect(await lockData(row.del)).toBeNull();
    expect((await db.doc(`accountLifecycle/${row.del}`).get()).exists).toBe(false);
    const next = await claimThroughCallables(row.b, row.s1, row.attempt);
    scenario.release = { firstStep: seen, nextClaim: next.outcome };
    expect(next.outcome).toBe('refused_stale_generation');
  });

  itExpectedUnsafe('BLOCKER[T3-DEP-B1] the deployed deleteAccount commits a lifecycle fence before destructive cleanup', () => {
    expect(scenario.release.firstStep).toEqual([{ step: 'userLocations', fence: true }]);
  });

  itExpectedUnsafe('BLOCKER[T3-DEP-B2] after deployed deletion releases a callable claim, a legitimate new claimant can claim the Ping', () => {
    expect(scenario.release.nextClaim).toBe('claimed');
  });

  it('CHARACTERIZATION T3-DEP-C2: interrupted deployed deletion lets the deleted user reacquire through head callables, and the retry leaves that claim behind', async () => {
    const row = ids('retry');
    await seedDeletion(row);
    const restore = interruptAtChats();
    let firstError = null;
    try {
      await deployed.deleteAccount.run(deletionRequest(row.del));
    } catch (error) {
      firstError = error;
    } finally {
      restore();
    }
    expect(firstError && firstError.code).toBe('internal');
    const job = (await db.doc(`accountDeletionJobs/${row.del}`).get()).data();
    expect(job.state).toBe('failed');
    expect(job.steps.spotsAsClaimer).toBe('done');
    expect((await db.collection('users').doc(row.del).get()).exists).toBe(false);
    const reacquire = await claimThroughCallables(row.del, row.s2, row.attempt)
      .then((r) => r.outcome).catch((error) => `error:${error.code}`);
    const retry = await deployed.deleteAccount.run(deletionRequest(row.del));
    const leftover = await db.collection('spots').where('interestedUserId', '==', row.del).get();
    const authGone = await getAuth().getUser(row.del).then(() => false).catch((e) => e.code === 'auth/user-not-found');
    scenario.retry = { reacquire, leftover: leftover.size, retry, authGone };
    expect(reacquire).toBe('claimed');
    expect(retry).toMatchObject({ success: true });
    expect(authGone).toBe(true);
    expect(leftover.size).toBe(1);
  });

  itExpectedUnsafe('BLOCKER[T3-DEP-B3] a deleted user cannot reacquire a Ping while deployed deletion is interrupted', () => {
    expect(scenario.retry.reacquire).toBe('error:permission-denied');
  });

  itExpectedUnsafe('BLOCKER[T3-DEP-B4] no Ping remains claimed by a deleted account after deletion completes', () => {
    expect(scenario.retry.leftover).toBe(0);
  });
});

describe('T4 finder cancel (head finderCancelSpot) with the DEPLOYED updateTrustOnSpotDelete', () => {
  const t4 = {};

  async function seedT4(row, spotData0) {
    await db.collection('users').doc(row.finder).set(profile('bea', { trustStats: { handoffsCancelledByFinder: 0, handoffsCompleted: 0 } }));
    await db.collection('users').doc(row.a).set(profile('ada'));
    await db.collection('users').doc(row.b).set(profile('bob'));
    await db.collection('spots').doc(row.s1).set(spotData0);
  }

  function finderReq(row, claimant, generation, status = 'interested', claimState = 'heading') {
    return {
      auth: { uid: row.finder },
      data: { spotId: row.s1, status, interestedUserId: claimant, claimState, claimGenerationId: generation },
    };
  }

  it('CHARACTERIZATION T4-C1: generation claim — callable deletes once, deployed trigger penalizes once across retries, clears the lock, writes no notice', async () => {
    const row = ids('gen');
    const before = claimedBy(row.finder, row.a, G1);
    await seedT4(row, before);
    await lock(row.a, row.s1, G1);
    const first = await finderCancelSpot(finderReq(row, row.a, G1), deps());
    const again = await finderCancelSpot(finderReq(row, row.a, G1), deps());
    await deployed.updateTrustOnSpotDelete.run(deletedEvent(row.s1, before, `ev1_${row.s1}`));
    await deployed.updateTrustOnSpotDelete.run(deletedEvent(row.s1, before, `ev1_${row.s1}`));
    await deployed.updateTrustOnSpotDelete.run(deletedEvent(row.s1, before, `ev2_${row.s1}`));
    const receipts = await db.collection('finderCancelReceipts').where('spotId', '==', row.s1).get();
    t4.gen = {
      first: first.outcome,
      again: again.outcome,
      penalty: await penaltyOf(row.finder),
      lock: await lockData(row.a),
      notices: await noticesFor(row.s1),
      receipts: receipts.size,
      claimant: row.a,
    };
    expect(t4.gen.first).toBe('deleted');
    expect(t4.gen.again).toBe('already_deleted');
    expect(t4.gen.receipts).toBe(1);
    expect(t4.gen.notices).toEqual([]);
  });

  it('SECURITY T4-S1: no duplicated trust penalty across callable retry and trigger redelivery', () => {
    expect(t4.gen.penalty).toBe(1);
  });

  it('SECURITY T4-S2: no stale active-claim lock after a generation finder cancel', () => {
    expect(t4.gen.lock).toBeNull();
  });

  it('SECURITY T4-S3: no duplicate notice', () => {
    expect(t4.gen.notices.length).toBeLessThanOrEqual(1);
  });

  itExpectedUnsafe('GAP[T4-G1] the claimant receives exactly one finder-cancel notice when a new client cancels through finderCancelSpot under the deployed trigger', () => {
    expect(t4.gen.notices.filter((n) => n.target === t4.gen.claimant).length).toBe(1);
  });

  it('SECURITY T4-S4: a competing newer generation is not deleted, keeps its lock, and causes no penalty', async () => {
    const row = ids('compete');
    await seedT4(row, claimedBy(row.finder, row.b, G2));
    await lock(row.b, row.s1, G2);
    const result = await finderCancelSpot(finderReq(row, row.a, G1), deps());
    expect(result.outcome).toBe('stale');
    const spot = await spotData(row.s1);
    expect(spot.interestedUserId).toBe(row.b);
    expect(spot.claimGenerationId).toBe(G2);
    expect((await lockData(row.b)).spotId).toBe(row.s1);
    expect(await penaltyOf(row.finder)).toBe(0);
    expect(await noticesFor(row.s1)).toEqual([]);
  });

  it('SECURITY T4-S5: the deployed trigger leaves a lock that already names a newer claim on another Ping', async () => {
    const row = ids('relock');
    const before = claimedBy(row.finder, row.a, G1);
    await seedT4(row, before);
    await lock(row.a, row.s9, G2);
    const result = await finderCancelSpot(finderReq(row, row.a, G1), deps());
    expect(result.outcome).toBe('deleted');
    await deployed.updateTrustOnSpotDelete.run(deletedEvent(row.s1, before, `ev_${row.s1}`));
    expect((await lockData(row.a)).spotId).toBe(row.s9);
    expect(await penaltyOf(row.finder)).toBe(1);
  });

  it('CHARACTERIZATION T4-C2: legacy claim — finderCancelSpot refuses (unproven_identity); the old-client direct delete path is penalized once by the deployed trigger and clears the lock', async () => {
    const row = ids('legacy');
    const before = claimedBy(row.finder, row.a);
    await seedT4(row, before);
    await lock(row.a, row.s1);
    const result = await finderCancelSpot(finderReq(row, row.a, null), deps());
    expect(result.outcome).toBe('unproven_identity');
    expect(await spotData(row.s1)).not.toBeNull();
    // Old client (1ffeba94 handleCancelByFinder): its own 'cancelled' notice,
    // then a direct delete. Simulated with Admin writes; rules acceptance of
    // the same writes is covered by firestore.rules.test.mixed-version-deployed.ts.
    await db.collection('spotNotifications').add({
      spotId: row.s1, senderId: row.finder, targetUserId: row.a, type: 'cancelled',
      message: 'The driver had to cancel.', createdAt: Timestamp.now(),
    });
    await db.collection('spots').doc(row.s1).delete();
    await deployed.updateTrustOnSpotDelete.run(deletedEvent(row.s1, before, `ev_${row.s1}`));
    await deployed.updateTrustOnSpotDelete.run(deletedEvent(row.s1, before, `ev_${row.s1}`));
    expect(await penaltyOf(row.finder)).toBe(1);
    expect(await lockData(row.a)).toBeNull();
    expect((await noticesFor(row.s1)).length).toBe(1);
  });

  it('CHARACTERIZATION T4-C3: the deployed trigger penalizes a callable generation delete without consulting finderCancelReceipts', async () => {
    const row = ids('noreceipt');
    const before = claimedBy(row.finder, row.a, G1);
    await seedT4(row, before);
    await db.collection('spots').doc(row.s1).delete();
    await deployed.updateTrustOnSpotDelete.run(deletedEvent(row.s1, before, `ev_${row.s1}`));
    expect(await penaltyOf(row.finder)).toBe(1);
    const receipts = await db.collection('finderCancelReceipts').where('spotId', '==', row.s1).get();
    expect(receipts.size).toBe(0);
  });
});
