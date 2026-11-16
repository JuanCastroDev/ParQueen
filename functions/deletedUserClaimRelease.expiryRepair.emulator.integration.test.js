'use strict';

// Approved malformed-expiry policy N (t699u) for deleteAccount spotsAsClaimer
// on the isolated emulator. An active claim held by the deleting user on a
// Ping whose expiresAt is missing or not a Firestore Timestamp is released
// without reopening; expiresAt becomes the commit's server time and the
// audit markers are written, so the existing hourly expiry cleanup deletes it
// and the delete trigger's natural-expiry exemption applies.
require('./isolatedEmulatorGuard').assertIsolatedEmulator({ services: ['firestore', 'auth', 'storage'] });

const PROJECT = 'demo-parkqueen-parking-fence-iso';
const host = process.env.FIRESTORE_EMULATOR_HOST || '';
if (process.env.GCLOUD_PROJECT !== PROJECT || host === '' || host.endsWith(':8080')) {
  throw new Error('Refusing expiry repair proof outside the isolated project and port');
}

const { randomUUID } = require('crypto');
const { Query } = require('@google-cloud/firestore');
const indexModule = require('./index.js');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { prepareClaimIntent, claimSpot } = require('./claimSpot');
const { checkRateLimit } = require('./rateLimiter');
const {
  releaseClaimsOfDeletedUser, planDeletedClaimerPatch, EXPIRY_REPAIR_REASON,
} = require('./deletedUserClaimRelease');

const db = getFirestore();
const GEN_A = 'a3'.repeat(32);
const IDENTITY_KEYS = ['interestedUserId', 'interestedUserName', 'interestedUserVehicleColor',
  'interestedUserVehicleType', 'interestedUserVehicleBrand', 'interestedUserTitle'];
const CLAIM_KEYS = ['claimState', 'claimStartedAt', 'etaMinutes', 'interestExpiresAt', 'ownerLeavingNow',
  'ownerLeavingNowAt', 'claimReminderAt', 'claimReminderSentAt', 'claimAutoReleaseAt',
  'claimAutoReleasedAt', 'claimGenerationId'];
// Server and test process share this machine's clock; allow small skew only.
const SKEW_MS = 5_000;
let seq = 0;

function tag(label) {
  seq += 1;
  return `xr_${label}_${Date.now().toString(36)}${String(seq).padStart(4, '0')}`;
}
const future = () => Timestamp.fromMillis(Date.now() + 3_600_000);
const past = () => Timestamp.fromMillis(Date.now() - 3_600_000);
const spotRef = (id) => db.doc(`spots/${id}`);
const lockRef = (uid) => db.doc(`users/${uid}/activeIncomingClaims/current`);

function claimedBy(uid, finder, extra = {}) {
  return {
    finderId: finder,
    status: 'interested',
    interestedUserId: uid,
    interestedUserName: 'Alice',
    interestedUserVehicleColor: 'red',
    interestedUserVehicleType: 'sedan',
    interestedUserVehicleBrand: 'Honda',
    interestedUserTitle: 'Newcomer',
    claimState: 'heading',
    claimStartedAt: Timestamp.fromMillis(Date.now() - 60_000),
    etaMinutes: 4,
    interestExpiresAt: future(),
    claimGenerationId: GEN_A,
    expiresAt: future(),
    reportedAt: future(),
    address: 'kept',
    ...extra,
  };
}
function withoutExpiry(uid, finder, extra = {}) {
  const seed = claimedBy(uid, finder, extra);
  delete seed.expiresAt;
  return seed;
}

async function data(id) {
  const s = await spotRef(id).get();
  return s.exists ? s.data() : null;
}
function expectNoIdentity(d) {
  for (const k of IDENTITY_KEYS) expect(d[k]).toBeUndefined();
}
function expectClaimCleared(d) {
  for (const k of CLAIM_KEYS) expect(d[k]).toBeNull();
}
function expectRepaired(d, t0, t1) {
  expect(d.status).toBe('interested');
  expectNoIdentity(d); expectClaimCleared(d);
  expect(d.expiresAt).toBeInstanceOf(Timestamp);
  expect(d.expiryRepairedAt).toBeInstanceOf(Timestamp);
  expect(d.expiresAt.isEqual(d.expiryRepairedAt)).toBe(true);
  expect(d.expiryRepairReason).toBe(EXPIRY_REPAIR_REASON);
  expect(d.expiresAt.toMillis()).toBeGreaterThanOrEqual(t0 - SKEW_MS);
  expect(d.expiresAt.toMillis()).toBeLessThanOrEqual(t1 + SKEW_MS);
}
function expectNotRepaired(d) {
  expect(d.expiryRepairedAt).toBeUndefined();
  expect(d.expiryRepairReason).toBeUndefined();
}
async function seedFinder(finder) {
  await db.doc(`users/${finder}`).set({ status: 'Active', productAccessBlocked: false, username: finder.slice(0, 20), fullName: 'Finder' });
}
async function sideEffects(spotId, finder) {
  const user = await db.doc(`users/${finder}`).get();
  const processed = await db.collection(`users/${finder}/processedTrustEvents`).get();
  const notices = await db.collection('spotNotifications').where('spotId', '==', spotId).get();
  const receipts = await db.collection('finderCancelReceipts').where('spotId', '==', spotId).get();
  return {
    trustStats: user.exists ? (user.data().trustStats || null) : 'missing',
    processed: processed.size,
    notices: notices.size,
    receipts: receipts.size,
  };
}
function deletedEvent(spotId, snapshotData, eventId) {
  return { id: eventId, params: { spotId }, data: { id: spotId, data: () => snapshotData }, time: new Date().toISOString() };
}

describe('policy N plan (pure)', () => {
  const uid = 'u1';
  it('N-P1 missing or non-Timestamp expiresAt: release with repair, never reopen', () => {
    const now = Date.now();
    for (const expiresAt of [undefined, null, '2099-01-01', 4102444800000, true, { seconds: 4102444800, nanoseconds: 0 }, { toMillis: () => now + 1e9 }]) {
      const spot = { interestedUserId: uid, status: 'interested', claimState: 'heading' };
      if (expiresAt !== undefined) spot.expiresAt = expiresAt;
      const plan = planDeletedClaimerPatch(spot, uid, now);
      expect(plan.action).toBe('release');
      expect(plan.repair).toBe(true);
      expect(plan.patch.status).toBeUndefined();
      expect(plan.patch.expiryRepairReason).toBe('deleted_claimer_malformed_expiry');
      expect(plan.patch.expiresAt.isEqual(FieldValue.serverTimestamp())).toBe(true);
      expect(plan.patch.expiryRepairedAt.isEqual(FieldValue.serverTimestamp())).toBe(true);
      expect(plan.patch.interestedUserId.isEqual(FieldValue.delete())).toBe(true);
    }
  });
  it('N-P2 valid Timestamp expiry keeps the reviewed reopen/release split with no repair markers', () => {
    const now = Date.now();
    const reopen = planDeletedClaimerPatch({ interestedUserId: uid, status: 'interested', expiresAt: Timestamp.fromMillis(now + 1) }, uid, now);
    expect(reopen.action).toBe('reopen'); expect(reopen.repair).toBeUndefined(); expect(reopen.patch.expiresAt).toBeUndefined();
    const expired = planDeletedClaimerPatch({ interestedUserId: uid, status: 'interested', expiresAt: Timestamp.fromMillis(now) }, uid, now);
    expect(expired.action).toBe('release'); expect(expired.repair).toBeUndefined(); expect(expired.patch.expiresAt).toBeUndefined();
    expect(expired.patch.status).toBeUndefined();
  });
  it('N-P3 arrived, terminal and other-claimant rows never get a repair patch', () => {
    for (const spot of [
      { interestedUserId: uid, status: 'interested', claimState: 'arrived_pending_outcome' },
      { interestedUserId: uid, status: 'occupied', claimState: 'arrived_pending_outcome' },
      { interestedUserId: uid, status: 'completed', claimState: 'completed' },
      { interestedUserId: uid, status: 'expired' },
    ]) {
      const plan = planDeletedClaimerPatch(spot, uid, Date.now());
      expect(plan.action).toBe('scrub'); expect(plan.patch.expiresAt).toBeUndefined(); expect(plan.patch.expiryRepairReason).toBeUndefined();
    }
    expect(planDeletedClaimerPatch({ interestedUserId: 'u2', status: 'interested' }, uid, Date.now())).toEqual({ action: 'skip', patch: null });
  });
});

describe('policy N on the isolated emulator', () => {
  it('N01 missing and malformed expiry: released in place, server-time expiry and audit markers, own matching lock removed', async () => {
    const a = tag('a'); const finder = tag('f');
    const rows = {
      missing: withoutExpiry(a, finder),
      nullExpiry: claimedBy(a, finder, { expiresAt: null }),
      stringExpiry: claimedBy(a, finder, { expiresAt: '2099-01-01T00:00:00Z' }),
      numberExpiry: claimedBy(a, finder, { expiresAt: 4102444800000 }),
      mapExpiry: claimedBy(a, finder, { expiresAt: { seconds: 4102444800, nanoseconds: 0 } }),
      boolExpiry: claimedBy(a, finder, { expiresAt: true }),
    };
    const ids = {};
    for (const [k, v] of Object.entries(rows)) { ids[k] = tag(k); await spotRef(ids[k]).set(v); }
    await lockRef(a).set({ spotId: ids.missing, claimGenerationId: GEN_A, claimState: 'heading' });
    const t0 = Date.now();
    const counts = await releaseClaimsOfDeletedUser(db, a);
    const t1 = Date.now();
    expect(counts).toEqual({ reopen: 0, release: 6, scrub: 0, skip: 0, gone: 0 });
    for (const k of Object.keys(rows)) {
      const d = await data(ids[k]);
      expectRepaired(d, t0, t1);
      expect(d.address).toBe('kept'); expect(d.finderId).toBe(finder);
    }
    expect((await lockRef(a).get()).exists).toBe(false);
  });

  it('N02 valid expiry is unchanged by policy N: future reopens, past releases with expiresAt untouched', async () => {
    const a = tag('a'); const finder = tag('f');
    const fut = future(); const pst = past();
    const live = tag('live'); const old = tag('old');
    await spotRef(live).set(claimedBy(a, finder, { expiresAt: fut }));
    await spotRef(old).set(claimedBy(a, finder, { expiresAt: pst }));
    expect(await releaseClaimsOfDeletedUser(db, a)).toEqual({ reopen: 1, release: 1, scrub: 0, skip: 0, gone: 0 });
    const l = await data(live); const o = await data(old);
    expect(l.status).toBe('available'); expect(l.expiresAt.isEqual(fut)).toBe(true); expectNotRepaired(l);
    expect(o.status).toBe('interested'); expect(o.expiresAt.isEqual(pst)).toBe(true); expectNotRepaired(o);
    expectNoIdentity(o); expectClaimCleared(o);
  });

  it('N03 arrived and terminal rows with malformed expiry: identity scrub only, no repair, expiry left as is', async () => {
    const a = tag('a'); const finder = tag('f');
    const rows = {
      arrived: withoutExpiry(a, finder, { claimState: 'arrived_pending_outcome' }),
      occupied: claimedBy(a, finder, { status: 'occupied', claimState: 'arrived_pending_outcome', expiresAt: 'bad' }),
      completed: withoutExpiry(a, finder, { status: 'completed', claimState: 'completed' }),
    };
    const ids = {};
    for (const [k, v] of Object.entries(rows)) { ids[k] = tag(k); await spotRef(ids[k]).set(v); }
    expect(await releaseClaimsOfDeletedUser(db, a)).toMatchObject({ scrub: 3, reopen: 0, release: 0 });
    for (const [k, v] of Object.entries(rows)) {
      const d = await data(ids[k]);
      expectNoIdentity(d); expectNotRepaired(d);
      expect(d.status).toBe(v.status); expect(d.claimState).toBe(v.claimState);
      expect(d.expiresAt).toEqual(v.expiresAt);
    }
  });

  it('N04 a replacement claimant on a malformed-expiry Ping is never touched (direct and mid-run replacement)', async () => {
    const a = tag('a'); const b = tag('b'); const finder = tag('f');
    const direct = tag('direct');
    await spotRef(direct).set(withoutExpiry(b, finder, { interestedUserName: 'Bob', claimGenerationId: 'b5'.repeat(32) }));
    await lockRef(b).set({ spotId: direct, claimGenerationId: 'b5'.repeat(32), claimState: 'heading' });
    const directBefore = await spotRef(direct).get(); const bLockBefore = await lockRef(b).get();

    const swapped = tag('swapped');
    await spotRef(swapped).set(withoutExpiry(a, finder));
    const original = Query.prototype.get;
    const state = { fired: false };
    Query.prototype.get = async function pausedGet(...args) {
      const snap = await original.apply(this, args);
      if (!state.fired && snap.docs.some((d) => d.id === swapped && (d.data() || {}).interestedUserId === a)) {
        state.fired = true;
        // A legacy replacement by B lands between the page query and A's transaction.
        await spotRef(swapped).set(withoutExpiry(b, finder, { interestedUserName: 'Bob', claimGenerationId: null }));
      }
      return snap;
    };
    let counts;
    try { counts = await releaseClaimsOfDeletedUser(db, a); } finally { Query.prototype.get = original; }
    expect(state.fired).toBe(true);
    expect(counts).toEqual({ reopen: 0, release: 0, scrub: 0, skip: 1, gone: 0 });
    const s = await data(swapped);
    expect(s.interestedUserId).toBe(b); expect(s.interestedUserName).toBe('Bob'); expect(s.claimState).toBe('heading');
    expect(s.expiresAt).toBeUndefined(); expectNotRepaired(s);
    expect((await spotRef(direct).get()).updateTime.isEqual(directBefore.updateTime)).toBe(true);
    expect((await lockRef(b).get()).updateTime.isEqual(bLockBefore.updateTime)).toBe(true);
  });

  it('N05 a repaired Ping never becomes available or claimable (retry, phantom sweep, interest sweep, claim attempt)', async () => {
    const a = tag('a'); const b = tag('b'); const finder = tag('f');
    await seedFinder(finder);
    await db.doc(`users/${b}`).set({ status: 'Active', productAccessBlocked: false, username: b.slice(0, 20), fullName: 'Test' });
    const id = tag('ghost');
    await spotRef(id).set(withoutExpiry(a, finder));
    await releaseClaimsOfDeletedUser(db, a);
    const repaired = await spotRef(id).get();
    expect(await releaseClaimsOfDeletedUser(db, a)).toEqual({ reopen: 0, release: 0, scrub: 0, skip: 0, gone: 0 });
    await indexModule._sweepPhantomClaims(db, Timestamp.now());
    await indexModule.cleanupExpiredInterests.run({});
    expect((await spotRef(id).get()).updateTime.isEqual(repaired.updateTime)).toBe(true);
    const deps = { db, now: () => Timestamp.now(), checkRateLimit };
    const req = { auth: { uid: b }, data: { spotId: id, attemptId: randomUUID(), mode: 'immediate', etaMinutes: 4 } };
    let claimed = null;
    try {
      const prepared = await prepareClaimIntent(req, deps);
      if (prepared && prepared.state === 'prepared') claimed = await claimSpot(req, deps);
    } catch (e) { claimed = { error: e.code || e.message }; }
    expect(claimed === null || claimed.outcome !== 'claimed').toBe(true);
    const d = await data(id);
    expect(d.status).toBe('interested'); expect(d.interestedUserId).toBeUndefined();
    const bl = await lockRef(b).get();
    expect(bl.exists && bl.data().spotId === id).toBe(false);
  });

  it('N06 the repaired Ping is selected and deleted by the existing hourly expiry cleanup; delete trigger attributes no penalty or notice', async () => {
    const a = tag('a'); const finder = tag('f');
    await seedFinder(finder);
    const id = tag('sweep');
    await spotRef(id).set(withoutExpiry(a, finder));
    const before = await sideEffects(id, finder);
    await releaseClaimsOfDeletedUser(db, a);
    const repaired = (await spotRef(id).get()).data();
    // Exactly the hourly cleanup's selector.
    const selected = await db.collection('spots').where('expiresAt', '<=', Timestamp.now()).orderBy('expiresAt', 'asc').get();
    expect(selected.docs.some((d) => d.id === id)).toBe(true);
    await indexModule.cleanupExpiredSpotsHourly.run({});
    expect((await spotRef(id).get()).exists).toBe(false);
    // The deleted snapshot reaches the natural-expiry exemption: a Timestamp expiresAt at or before the deletion time.
    const event = deletedEvent(id, repaired, `t699u_evt_${id}`);
    expect(repaired.expiresAt).toBeInstanceOf(Timestamp);
    expect(repaired.expiresAt.toMillis()).toBeLessThanOrEqual(Date.parse(event.time));
    await indexModule.updateTrustOnSpotDelete.run(event);
    await indexModule.updateTrustOnSpotDelete.run(event);
    expect(await sideEffects(id, finder)).toEqual(before);
    expect(before).toEqual({ trustStats: null, processed: 0, notices: 0, receipts: 0 });
  });

  it('N07 a failed repair transaction is surfaced, leaves the Ping unchanged, and the retry repairs it', async () => {
    const a = tag('a'); const finder = tag('f');
    const id = tag('fail'); const ok = tag('ok');
    await spotRef(id).set(withoutExpiry(a, finder));
    await spotRef(ok).set(withoutExpiry(a, finder));
    const failing = {
      collection: (p) => db.collection(p),
      doc: (p) => db.doc(p),
      runTransaction: (fn, o) => db.runTransaction((tx) => fn({
        get: (ref) => (ref.path === `spots/${id}` ? Promise.reject(new Error('injected')) : tx.get(ref)),
        update: (...x) => tx.update(...x),
        delete: (...x) => tx.delete(...x),
      }), o),
    };
    await expect(releaseClaimsOfDeletedUser(failing, a)).rejects.toThrow('1 of 2 claim releases failed');
    const stuck = await data(id);
    expect(stuck.interestedUserId).toBe(a); expect(stuck.expiresAt).toBeUndefined(); expectNotRepaired(stuck);
    expect((await data(ok)).expiryRepairReason).toBe(EXPIRY_REPAIR_REASON);
    const t0 = Date.now();
    expect(await releaseClaimsOfDeletedUser(db, a)).toEqual({ reopen: 0, release: 1, scrub: 0, skip: 0, gone: 0 });
    expectRepaired(await data(id), t0, Date.now());
  });

  it('N08 repair writes no trust events, receipts or notifications', async () => {
    const a = tag('a'); const finder = tag('f');
    await seedFinder(finder);
    const sizes = async () => Promise.all(['spotNotifications', 'finderCancelReceipts', 'trustEvents', 'processedTrustEvents']
      .map(async (c) => (await db.collection(c).get()).size).concat([(await db.collectionGroup('processedTrustEvents').get()).size]));
    const ids = [tag('n1'), tag('n2')];
    await spotRef(ids[0]).set(withoutExpiry(a, finder));
    await spotRef(ids[1]).set(claimedBy(a, finder, { expiresAt: 'bad' }));
    const before = await sizes();
    await releaseClaimsOfDeletedUser(db, a);
    expect(await sizes()).toEqual(before);
    expect((await db.doc(`users/${finder}`).get()).data().trustStats).toBeUndefined();
  });
});