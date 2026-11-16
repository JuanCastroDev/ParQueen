'use strict';

// Combined WP1 + S4 exact-identity contract for deleted-account claim release.
require('./isolatedEmulatorGuard').assertIsolatedEmulator({ services: ['firestore'] });

const PROJECT = 'demo-parkqueen-parking-fence-iso';
const host = process.env.FIRESTORE_EMULATOR_HOST || '';
if (process.env.GCLOUD_PROJECT !== PROJECT || host === '' || host.endsWith(':8080')) {
  throw new Error('Refusing identity-contract proof outside the isolated project and port');
}

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const {
  releaseClaimsOfDeletedUser,
  EXPIRY_REPAIR_REASON,
} = require('./deletedUserClaimRelease');

if (getApps().length === 0) initializeApp({ projectId: PROJECT });
const db = getFirestore();

const GEN_1 = 'a7'.repeat(32);
const GEN_2 = 'b8'.repeat(32);
let seq = 0;

function tag(label) {
  seq += 1;
  return `${label}_${Date.now().toString(36)}${String(seq).padStart(4, '0')}`;
}

const spotRef = (id) => db.doc(`spots/${id}`);
const lockRef = (uid) => db.doc(`users/${uid}/activeIncomingClaims/current`);
const future = () => Timestamp.fromMillis(Date.now() + 3_600_000);

async function seedDeletionContext(uid, job = {}) {
  const now = Timestamp.now();
  await db.doc(`accountLifecycle/${uid}`).set({
    decision: 'delete', fenceGeneration: 1, fencedAt: now, source: 'deleteAccount',
  });
  await db.doc(`accountDeletionJobs/${uid}`).set({
    state: 'running', currentStep: 'spotsAsClaimer', leaseAt: now,
    steps: { userDoc: 'done' }, ...job,
  });
}

function modernClaim(uid, generation = GEN_1, extra = {}) {
  const started = Timestamp.fromMillis(Date.now() - 60_000);
  return {
    finderId: tag('finder'),
    interestedUserId: uid,
    interestedUserName: 'deleted user',
    status: 'interested',
    claimState: 'heading',
    claimStartedAt: started,
    claimGenerationId: generation,
    expiresAt: future(),
    ...extra,
  };
}

async function snapshotPair(id, uid) {
  const [spot, lock] = await Promise.all([spotRef(id).get(), lockRef(uid).get()]);
  return {
    spotData: spot.exists ? spot.data() : null,
    spotUpdateTime: spot.updateTime,
    lockData: lock.exists ? lock.data() : null,
    lockUpdateTime: lock.updateTime,
  };
}

function expectPairUnchanged(before, after) {
  expect(after.spotData).toEqual(before.spotData);
  expect(after.lockData).toEqual(before.lockData);
  expect(after.spotUpdateTime.isEqual(before.spotUpdateTime)).toBe(true);
  expect(after.lockUpdateTime.isEqual(before.lockUpdateTime)).toBe(true);
}

describe('deleted-user release exact WP1 lock identity', () => {
  it('I01 exact modern generation updates the Ping and deletes the lock atomically', async () => {
    const uid = tag('modern'); const id = tag('spot');
    const spot = modernClaim(uid);
    await spotRef(id).set(spot);
    await lockRef(uid).set({ spotId: id, claimGenerationId: GEN_1, claimStartedAt: spot.claimStartedAt });
    await expect(releaseClaimsOfDeletedUser(db, uid)).resolves.toMatchObject({ reopen: 1 });
    expect((await spotRef(id).get()).data()).toMatchObject({ status: 'available', claimGenerationId: null });
    expect((await lockRef(uid).get()).exists).toBe(false);
  });

  it('I02 exact legacy seconds/nanoseconds identity deletes only the matching lock', async () => {
    const uid = tag('legacy'); const id = tag('spot');
    const started = new Timestamp(1_700_000_000, 123_456_789);
    const spot = modernClaim(uid, undefined, { claimStartedAt: started });
    delete spot.claimGenerationId;
    await spotRef(id).set(spot);
    await lockRef(uid).set({ spotId: id, claimStartedAt: new Timestamp(1_700_000_000, 123_456_789) });
    await expect(releaseClaimsOfDeletedUser(db, uid)).resolves.toMatchObject({ reopen: 1 });
    expect((await lockRef(uid).get()).exists).toBe(false);
  });

  it.each([
    ['modern generation', (spot) => ({ spotId: spot.id, claimGenerationId: GEN_2 })],
    ['legacy timestamp', (spot) => ({ spotId: spot.id, claimStartedAt: new Timestamp(1_700_000_001, 9) })],
  ])('I03 conflict on the same Ping (%s) leaves Ping and lock unchanged', async (_label, makeLock) => {
    const uid = tag('conflict'); const id = tag('spot');
    const started = new Timestamp(1_700_000_000, 8);
    const data = modernClaim(uid, GEN_1, { claimStartedAt: started });
    if (_label === 'legacy timestamp') delete data.claimGenerationId;
    await spotRef(id).set(data);
    await lockRef(uid).set(makeLock({ id }));
    const before = await snapshotPair(id, uid);
    await expect(releaseClaimsOfDeletedUser(db, uid)).rejects.toThrow('claim releases failed');
    expectPairUnchanged(before, await snapshotPair(id, uid));
  });

  it('I04 malformed lock and malformed expected Ping identity both fail closed', async () => {
    const uid1 = tag('badlock'); const id1 = tag('spot');
    await spotRef(id1).set(modernClaim(uid1));
    await lockRef(uid1).set({ spotId: id1, claimGenerationId: 'not-a-generation' });
    const before1 = await snapshotPair(id1, uid1);
    await expect(releaseClaimsOfDeletedUser(db, uid1)).rejects.toThrow('claim releases failed');
    expectPairUnchanged(before1, await snapshotPair(id1, uid1));

    const uid2 = tag('badspot'); const id2 = tag('spot');
    const malformed = modernClaim(uid2); delete malformed.claimGenerationId; delete malformed.claimStartedAt;
    await spotRef(id2).set(malformed);
    const before2 = await spotRef(id2).get();
    await expect(releaseClaimsOfDeletedUser(db, uid2)).rejects.toThrow('claim releases failed');
    const after2 = await spotRef(id2).get();
    expect(after2.data()).toEqual(before2.data());
    expect(after2.updateTime.isEqual(before2.updateTime)).toBe(true);
  });

  it('I05 missing lock permits a provable update; unrelated lock remains byte-for-byte', async () => {
    const missingUid = tag('missing'); const missingId = tag('spot');
    await spotRef(missingId).set(modernClaim(missingUid));
    await expect(releaseClaimsOfDeletedUser(db, missingUid)).resolves.toMatchObject({ reopen: 1 });

    const uid = tag('unrelated'); const id = tag('spot'); const other = tag('other');
    await spotRef(id).set(modernClaim(uid));
    await lockRef(uid).set({ spotId: other, claimGenerationId: GEN_2, opaque: { keep: true } });
    const lockBefore = await lockRef(uid).get();
    await expect(releaseClaimsOfDeletedUser(db, uid)).resolves.toMatchObject({ reopen: 1 });
    const lockAfter = await lockRef(uid).get();
    expect(lockAfter.data()).toEqual(lockBefore.data());
    expect(lockAfter.updateTime.isEqual(lockBefore.updateTime)).toBe(true);
  });

  it('I06 Option N obeys exact, missing, and conflicting lock authorization', async () => {
    const exactUid = tag('nexact'); const exactId = tag('spot');
    const exact = modernClaim(exactUid); delete exact.expiresAt;
    await spotRef(exactId).set(exact);
    await lockRef(exactUid).set({ spotId: exactId, claimGenerationId: GEN_1 });
    await releaseClaimsOfDeletedUser(db, exactUid);
    const repaired = (await spotRef(exactId).get()).data();
    expect(repaired).toMatchObject({ status: 'interested', expiryRepairReason: EXPIRY_REPAIR_REASON });
    expect(repaired.expiresAt.isEqual(repaired.expiryRepairedAt)).toBe(true);
    expect((await lockRef(exactUid).get()).exists).toBe(false);

    const missingUid = tag('nmissing'); const missingId = tag('spot');
    const missing = modernClaim(missingUid, GEN_1, { expiresAt: 'bad' });
    await spotRef(missingId).set(missing);
    await releaseClaimsOfDeletedUser(db, missingUid);
    expect((await spotRef(missingId).get()).data().expiryRepairReason).toBe(EXPIRY_REPAIR_REASON);

    const conflictUid = tag('nconflict'); const conflictId = tag('spot');
    const conflict = modernClaim(conflictUid); delete conflict.expiresAt;
    await spotRef(conflictId).set(conflict);
    await lockRef(conflictUid).set({ spotId: conflictId, claimGenerationId: GEN_2 });
    const before = await snapshotPair(conflictId, conflictUid);
    await expect(releaseClaimsOfDeletedUser(db, conflictUid)).rejects.toThrow('claim releases failed');
    expectPairUnchanged(before, await snapshotPair(conflictId, conflictUid));
  });

  it('I07 arrived and terminal records scrub only when identity remains provable', async () => {
    const uid = tag('terminal');
    const arrivedId = tag('arrived'); const completedId = tag('completed');
    await spotRef(arrivedId).set(modernClaim(uid, GEN_1, { claimState: 'arrived_pending_outcome' }));
    const legacy = modernClaim(uid, undefined, { status: 'completed', claimState: 'completed' });
    delete legacy.claimGenerationId;
    await spotRef(completedId).set(legacy);
    await expect(releaseClaimsOfDeletedUser(db, uid)).resolves.toMatchObject({ scrub: 2 });
    expect((await spotRef(arrivedId).get()).data()).toMatchObject({ status: 'interested', claimState: 'arrived_pending_outcome' });
    expect((await spotRef(completedId).get()).data()).toMatchObject({ status: 'completed', claimState: 'completed' });
  });

  it('I08 H1 scrubs unidentifiable terminal history only under a verified deletion context', async () => {
    const uid = tag('historical'); const id = tag('completed');
    await seedDeletionContext(uid);
    await spotRef(id).set({
      finderId: 'finder-kept', interestedUserId: uid, interestedUserName: 'remove-me',
      status: 'completed', claimState: 'completed', historical: true, outcome: 'success',
    });
    await expect(releaseClaimsOfDeletedUser(db, uid)).resolves.toMatchObject({ scrub: 1 });
    expect((await spotRef(id).get()).data()).toEqual({
      finderId: 'finder-kept', status: 'completed', claimState: 'completed',
      historical: true, outcome: 'success',
    });
  });

  it('I09 retry re-reads a same-user G1/G2 transition and fails closed on the inconsistent pair', async () => {
    const uid = tag('retry'); const id = tag('spot');
    const g1 = modernClaim(uid, GEN_1);
    await spotRef(id).set(g1);
    await lockRef(uid).set({ spotId: id, claimGenerationId: GEN_1 });
    let injected = false;
    const retryingDb = {
      collection: (path) => db.collection(path),
      doc: (path) => db.doc(path),
      runTransaction: (fn, options) => db.runTransaction(async (tx) => fn({
        get: async (ref) => {
          const snap = await tx.get(ref);
          if (!injected && ref.path === `users/${uid}/activeIncomingClaims/current`) {
            injected = true;
            await spotRef(id).update({ claimGenerationId: GEN_2 });
          }
          return snap;
        },
        update: (...args) => tx.update(...args),
        delete: (...args) => tx.delete(...args),
      }), options),
    };
    await expect(releaseClaimsOfDeletedUser(retryingDb, uid)).rejects.toThrow('claim releases failed');
    expect(injected).toBe(true);
    const after = await snapshotPair(id, uid);
    expect(after.spotData).toMatchObject({ interestedUserId: uid, claimGenerationId: GEN_2 });
    expect(after.lockData).toMatchObject({ spotId: id, claimGenerationId: GEN_1 });
  });

  it('H1-01 terminal history permits missing/unrelated locks but preserves an unrelated lock byte-for-byte', async () => {
    const missingUid = tag('h1tm'); const missingId = tag('expired');
    await seedDeletionContext(missingUid);
    await spotRef(missingId).set({ interestedUserId: missingUid, interestedUserName: 'remove', status: 'expired' });
    await expect(releaseClaimsOfDeletedUser(db, missingUid)).resolves.toMatchObject({ scrub: 1 });
    expect((await spotRef(missingId).get()).data()).toEqual({ status: 'expired' });

    const uid = tag('h1tu'); const id = tag('arrived'); const other = tag('other');
    await seedDeletionContext(uid);
    await spotRef(id).set({
      finderId: 'finder-kept', interestedUserId: uid, interestedUserName: 'remove',
      status: 'occupied', claimState: 'arrived_pending_outcome', arrivedAt: Timestamp.now(),
    });
    await lockRef(uid).set({ spotId: other, claimGenerationId: GEN_2, opaque: 'kept' });
    const before = await lockRef(uid).get();
    await expect(releaseClaimsOfDeletedUser(db, uid)).resolves.toMatchObject({ scrub: 1 });
    const after = await lockRef(uid).get();
    expect(after.data()).toEqual(before.data());
    expect(after.updateTime.isEqual(before.updateTime)).toBe(true);
    expect((await spotRef(id).get()).data()).toMatchObject({
      finderId: 'finder-kept', status: 'occupied', claimState: 'arrived_pending_outcome',
    });
  });

  it.each([
    ['same-Ping', (id) => ({ spotId: id, claimGenerationId: GEN_1 })],
    ['missing spotId', () => ({ claimGenerationId: GEN_1 })],
    ['invalid generation', () => ({ spotId: 'other', claimGenerationId: 'bad' })],
  ])('H1-02 terminal history with %s lock fails closed', async (_label, lock) => {
    const uid = tag('h1block'); const id = tag('completed');
    await seedDeletionContext(uid);
    await spotRef(id).set({ interestedUserId: uid, interestedUserName: 'kept-on-failure', status: 'completed', claimState: 'completed' });
    await lockRef(uid).set(lock(id));
    const before = await snapshotPair(id, uid);
    await expect(releaseClaimsOfDeletedUser(db, uid)).rejects.toThrow('claim releases failed');
    expectPairUnchanged(before, await snapshotPair(id, uid));
  });

  it('H1-03 active historical claims use normal expiry and Option N plans without inventing identity', async () => {
    const uid = tag('h1active');
    await seedDeletionContext(uid);
    const futureId = tag('future'); const malformedId = tag('malformed');
    await spotRef(futureId).set({
      interestedUserId: uid, interestedUserName: 'remove', status: 'interested',
      claimState: 'en_route', expiresAt: future(),
    });
    await spotRef(malformedId).set({
      interestedUserId: uid, interestedUserName: 'remove', status: 'interested', claimState: 'heading',
    });
    await expect(releaseClaimsOfDeletedUser(db, uid)).resolves.toMatchObject({ reopen: 1, release: 1 });
    expect((await spotRef(futureId).get()).data()).toMatchObject({ status: 'available', claimState: null });
    const repaired = (await spotRef(malformedId).get()).data();
    expect(repaired).toMatchObject({ status: 'interested', claimState: null, expiryRepairReason: EXPIRY_REPAIR_REASON });
    expect(repaired.expiresAt.isEqual(repaired.expiryRepairedAt)).toBe(true);
  });

  it('H1-04 active history permits a valid unrelated lock and blocks a same-Ping lock', async () => {
    const uid = tag('h1au'); const id = tag('active');
    await seedDeletionContext(uid);
    await spotRef(id).set({ interestedUserId: uid, status: 'interested', expiresAt: future() });
    await lockRef(uid).set({ spotId: tag('other'), claimStartedAt: new Timestamp(1_700_000_000, 123_000_000) });
    const lockBefore = await lockRef(uid).get();
    await expect(releaseClaimsOfDeletedUser(db, uid)).resolves.toMatchObject({ reopen: 1 });
    const lockAfter = await lockRef(uid).get();
    expect(lockAfter.data()).toEqual(lockBefore.data());
    expect(lockAfter.updateTime.isEqual(lockBefore.updateTime)).toBe(true);

    const blockedUid = tag('h1as'); const blockedId = tag('active');
    await seedDeletionContext(blockedUid);
    await spotRef(blockedId).set({ interestedUserId: blockedUid, status: 'interested', expiresAt: future() });
    await lockRef(blockedUid).set({ spotId: blockedId, claimGenerationId: GEN_1 });
    const before = await snapshotPair(blockedId, blockedUid);
    await expect(releaseClaimsOfDeletedUser(db, blockedUid)).rejects.toThrow('claim releases failed');
    expectPairUnchanged(before, await snapshotPair(blockedId, blockedUid));
  });

  it('H1-05 malformed identity and unrecognized states never downgrade into H1', async () => {
    for (const data of [
      { status: 'interested', claimState: 'heading', claimGenerationId: 'malformed' },
      { status: 'interested', claimState: 'heading', claimStartedAt: 'malformed' },
      { status: 'mystery', claimState: 'completed' },
    ]) {
      const uid = tag('h1mal'); const id = tag('spot');
      await seedDeletionContext(uid);
      await spotRef(id).set({ interestedUserId: uid, interestedUserName: 'preserve', expiresAt: future(), ...data });
      const before = await spotRef(id).get();
      await expect(releaseClaimsOfDeletedUser(db, uid)).rejects.toThrow('claim releases failed');
      const after = await spotRef(id).get();
      expect(after.data()).toEqual(before.data());
      expect(after.updateTime.isEqual(before.updateTime)).toBe(true);
    }
  });

  it.each([
    ['missing fence', async (uid) => seedDeletionContext(uid).then(() => db.doc(`accountLifecycle/${uid}`).delete())],
    ['invalid fence', async (uid) => seedDeletionContext(uid).then(() => db.doc(`accountLifecycle/${uid}`).update({ source: 'caller' }))],
    ['generation 2', async (uid) => seedDeletionContext(uid).then(() => db.doc(`accountLifecycle/${uid}`).update({ fenceGeneration: 2 }))],
    ['generation 0', async (uid) => seedDeletionContext(uid).then(() => db.doc(`accountLifecycle/${uid}`).update({ fenceGeneration: 0 }))],
    ['missing generation', async (uid) => seedDeletionContext(uid).then(() => db.doc(`accountLifecycle/${uid}`).update({ fenceGeneration: FieldValue.delete() }))],
    ['string generation', async (uid) => seedDeletionContext(uid).then(() => db.doc(`accountLifecycle/${uid}`).update({ fenceGeneration: '1' }))],
    ['fractional generation', async (uid) => seedDeletionContext(uid).then(() => db.doc(`accountLifecycle/${uid}`).update({ fenceGeneration: 1.5 }))],
    ['malformed generation', async (uid) => seedDeletionContext(uid).then(() => db.doc(`accountLifecycle/${uid}`).update({ fenceGeneration: { value: 1 } }))],
    ['failed job', async (uid) => seedDeletionContext(uid, { state: 'failed' })],
    ['wrong step', async (uid) => seedDeletionContext(uid, { currentStep: 'userDoc' })],
    ['incomplete job', async (uid) => seedDeletionContext(uid, { steps: {} })],
  ])('H1-06 %s cannot authorize historical cleanup', async (_label, prepare) => {
    const uid = tag('h1ctx'); const id = tag('active');
    await prepare(uid);
    await spotRef(id).set({ interestedUserId: uid, interestedUserName: 'preserve', status: 'interested', expiresAt: future() });
    const before = await spotRef(id).get();
    await expect(releaseClaimsOfDeletedUser(db, uid)).rejects.toThrow('claim releases failed');
    const after = await spotRef(id).get();
    expect(after.data()).toEqual(before.data());
    expect(after.updateTime.isEqual(before.updateTime)).toBe(true);
  });

  it('H1-07 transaction retry re-reads a newly created same-Ping lock and fails closed', async () => {
    const uid = tag('h1retry'); const id = tag('active');
    await seedDeletionContext(uid);
    await spotRef(id).set({ interestedUserId: uid, interestedUserName: 'preserve', status: 'interested', expiresAt: future() });
    let injected = false;
    const retryingDb = {
      collection: (path) => db.collection(path),
      doc: (path) => db.doc(path),
      runTransaction: (fn, options) => db.runTransaction(async (tx) => fn({
        get: async (ref) => {
          const snap = await tx.get(ref);
          if (!injected && ref.path === `users/${uid}/activeIncomingClaims/current`) {
            injected = true;
            await lockRef(uid).set({ spotId: id, claimGenerationId: GEN_2 });
          }
          return snap;
        },
        update: (...args) => tx.update(...args),
        delete: (...args) => tx.delete(...args),
      }), options),
    };
    const before = await spotRef(id).get();
    await expect(releaseClaimsOfDeletedUser(retryingDb, uid)).rejects.toThrow('claim releases failed');
    expect(injected).toBe(true);
    const after = await spotRef(id).get();
    expect(after.data()).toEqual(before.data());
    expect(after.updateTime.isEqual(before.updateTime)).toBe(true);
    expect((await lockRef(uid).get()).data()).toMatchObject({ spotId: id, claimGenerationId: GEN_2 });
  });
});
