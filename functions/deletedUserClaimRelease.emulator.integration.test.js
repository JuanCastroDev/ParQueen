'use strict';

// Matrix for deletedUserClaimRelease on the isolated emulator.
require('./isolatedEmulatorGuard').assertIsolatedEmulator({ services: ['firestore'] });

const PROJECT = 'demo-parkqueen-parking-fence-iso';
const host = process.env.FIRESTORE_EMULATOR_HOST || '';
if (process.env.GCLOUD_PROJECT !== PROJECT || host === '' || host.endsWith(':8080')) {
  throw new Error('Refusing deletion release matrix outside the isolated project and port');
}

const { Query } = require('@google-cloud/firestore');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { releasedInterestPatch } = require('./activeIncomingClaimLogic');
const { releaseClaimsOfDeletedUser, planDeletedClaimerPatch } = require('./deletedUserClaimRelease');

if (getApps().length === 0) initializeApp({ projectId: PROJECT });
const db = getFirestore();

const GEN_A = 'a2'.repeat(32);
const IDENTITY_KEYS = ['interestedUserId', 'interestedUserName', 'interestedUserVehicleColor',
  'interestedUserVehicleType', 'interestedUserVehicleBrand', 'interestedUserTitle'];
const CLAIM_KEYS = ['claimState', 'claimStartedAt', 'etaMinutes', 'interestExpiresAt', 'ownerLeavingNow',
  'ownerLeavingNowAt', 'claimReminderAt', 'claimReminderSentAt', 'claimAutoReleaseAt',
  'claimAutoReleasedAt', 'claimGenerationId'];
let seq = 0;

function tag(label) {
  seq += 1;
  return `${label}_${Date.now().toString(36)}${String(seq).padStart(4, '0')}`;
}
const future = () => Timestamp.fromMillis(Date.now() + 3_600_000);
const past = () => Timestamp.fromMillis(Date.now() - 3_600_000);
const spotRef = (id) => db.doc(`spots/${id}`);
const lockRef = (uid) => db.doc(`users/${uid}/activeIncomingClaims/current`);

function claimedBy(uid, extra = {}) {
  return {
    finderId: 'finder_matrix',
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

// Pause after the first page query that returns `spotId` naming `uid`.
function pauseAfterQuery(spotId, uid, hook) {
  const original = Query.prototype.get;
  const state = { fired: false, error: null };
  Query.prototype.get = async function pausedGet(...args) {
    const snap = await original.apply(this, args);
    if (!state.fired && snap.docs.some((d) => d.id === spotId && (d.data() || {}).interestedUserId === uid)) {
      state.fired = true;
      try { await hook(); } catch (e) { state.error = e; }
    }
    return snap;
  };
  state.restore = () => { Query.prototype.get = original; };
  return state;
}

// A legitimate release of A (same patch the expired-interest sweeper applies).
async function sweeperRelease(id, uid) {
  return db.runTransaction(async (tx) => {
    const s = await tx.get(spotRef(id));
    const l = await tx.get(lockRef(uid));
    if (!s.exists || s.data().interestedUserId !== uid) return false;
    tx.update(spotRef(id), releasedInterestPatch(s.data().expiresAt.toMillis(), Date.now()));
    if (l.exists && l.data().spotId === id) tx.delete(lockRef(uid));
    return true;
  });
}

// B claims a reopened Ping and writes the matching lock (claimSpot's writes).
async function bClaim(id, b, gen) {
  return db.runTransaction(async (tx) => {
    const s = await tx.get(spotRef(id));
    const d = s.data();
    if (d.status !== 'available' || d.interestedUserId != null || d.claimGenerationId != null) return false;
    const now = Timestamp.now();
    tx.update(spotRef(id), {
      status: 'interested', interestedUserId: b, interestedUserName: 'Bob', claimState: 'heading',
      claimStartedAt: now, etaMinutes: 3, interestExpiresAt: d.expiresAt, claimGenerationId: gen,
    });
    tx.set(lockRef(b), { spotId: id, claimStartedAt: now, claimState: 'heading', updatedAt: now, claimGenerationId: gen });
    return true;
  });
}

async function seedMany(uid, n, make) {
  const ids = [];
  for (let i = 0; i < n; i += 450) {
    const batch = db.batch();
    for (let j = i; j < Math.min(n, i + 450); j++) {
      const id = tag(`bulk${j}`);
      ids.push(id);
      batch.set(spotRef(id), make(j));
    }
    await batch.commit();
  }
  return ids;
}

async function remaining(uid) {
  return (await db.collection('spots').where('interestedUserId', '==', uid).get()).size;
}

describe('planDeletedClaimerPatch (pure)', () => {
  const uid = 'u1';
  it('skips a Ping that names someone else, null, or a malformed claimer', () => {
    expect(planDeletedClaimerPatch({ interestedUserId: 'u2', status: 'interested' }, uid, 0).action).toBe('skip');
    expect(planDeletedClaimerPatch({ interestedUserId: null, status: 'available' }, uid, 0).action).toBe('skip');
    expect(planDeletedClaimerPatch({ interestedUserId: 42 }, uid, 0).action).toBe('skip');
    expect(planDeletedClaimerPatch(null, uid, 0).action).toBe('skip');
  });
  it('never reopens without a valid future expiresAt', () => {
    const now = Date.now();
    expect(planDeletedClaimerPatch({ interestedUserId: uid, status: 'interested', expiresAt: Timestamp.fromMillis(now + 1) }, uid, now).action).toBe('reopen');
    expect(planDeletedClaimerPatch({ interestedUserId: uid, status: 'interested', expiresAt: Timestamp.fromMillis(now) }, uid, now).action).toBe('release');
    expect(planDeletedClaimerPatch({ interestedUserId: uid, status: 'interested' }, uid, now).action).toBe('release');
    expect(planDeletedClaimerPatch({ interestedUserId: uid, status: 'interested', expiresAt: '2099-01-01' }, uid, now).action).toBe('release');
    expect(planDeletedClaimerPatch({ interestedUserId: uid, status: 'interested', expiresAt: Timestamp.fromMillis(now + 1) }, uid, Number.NaN).action).toBe('release');
  });
});

describe('releaseClaimsOfDeletedUser on the isolated emulator', () => {
  it('M01 live claim with a generation: reopened, identity and claim cleared, own matching lock removed', async () => {
    const a = tag('a'); const id = tag('live');
    await spotRef(id).set(claimedBy(a));
    await lockRef(a).set({ spotId: id, claimGenerationId: GEN_A, claimState: 'heading' });
    const counts = await releaseClaimsOfDeletedUser(db, a);
    expect(counts).toEqual({ reopen: 1, release: 0, scrub: 0, skip: 0, gone: 0 });
    const d = await data(id);
    expect(d.status).toBe('available'); expectNoIdentity(d); expectClaimCleared(d);
    expect(d.address).toBe('kept'); expect(d.finderId).toBe('finder_matrix');
    expect((await lockRef(a).get()).exists).toBe(false);
  });

  it('M02 generationless (legacy) live claim: reopened with claimGenerationId null', async () => {
    const a = tag('a'); const id = tag('legacy');
    const seed = claimedBy(a); delete seed.claimGenerationId;
    await spotRef(id).set(seed);
    await releaseClaimsOfDeletedUser(db, a);
    const d = await data(id);
    expect(d.status).toBe('available'); expectNoIdentity(d); expect(d.claimGenerationId).toBeNull();
  });

  it('M03 an already released claim is not written', async () => {
    const a = tag('a'); const id = tag('released');
    await spotRef(id).set({ ...claimedBy(a), ...releasedInterestPatch(future().toMillis(), Date.now()) });
    const before = await spotRef(id).get();
    const counts = await releaseClaimsOfDeletedUser(db, a);
    expect(counts).toEqual({ reopen: 0, release: 0, scrub: 0, skip: 0, gone: 0 });
    const after = await spotRef(id).get();
    expect(after.updateTime.isEqual(before.updateTime)).toBe(true);
  });

  it('M04 claim released and replaced by B between page query and write: B claim, generation and lock preserved exactly', async () => {
    const a = tag('a'); const b = tag('b'); const id = tag('replaced'); const genB = 'b4'.repeat(32);
    await spotRef(id).set(claimedBy(a));
    const pause = pauseAfterQuery(id, a, async () => {
      expect(await sweeperRelease(id, a)).toBe(true);
      expect(await bClaim(id, b, genB)).toBe(true);
    });
    let counts;
    let bSpotBefore;
    let bLockBefore;
    try {
      counts = await releaseClaimsOfDeletedUser(db, a);
    } finally { pause.restore(); }
    expect(pause.fired).toBe(true); expect(pause.error).toBeNull();
    expect(counts).toEqual({ reopen: 0, release: 0, scrub: 0, skip: 1, gone: 0 });
    const d = await data(id);
    expect(d.status).toBe('interested'); expect(d.interestedUserId).toBe(b);
    expect(d.interestedUserName).toBe('Bob'); expect(d.claimGenerationId).toBe(genB); expect(d.claimState).toBe('heading');
    const l = (await lockRef(b).get()).data();
    expect(l).toMatchObject({ spotId: id, claimGenerationId: genB });
    // A second pass (deletion retry) leaves B untouched byte for byte.
    bSpotBefore = await spotRef(id).get(); bLockBefore = await lockRef(b).get();
    expect(await releaseClaimsOfDeletedUser(db, a)).toEqual({ reopen: 0, release: 0, scrub: 0, skip: 0, gone: 0 });
    expect((await spotRef(id).get()).updateTime.isEqual(bSpotBefore.updateTime)).toBe(true);
    expect((await lockRef(b).get()).updateTime.isEqual(bLockBefore.updateTime)).toBe(true);
  });

  it('M05 concurrent release-and-reclaim racers never leave a cleared spot under a live B lock', async () => {
    for (let i = 0; i < 8; i++) {
      const a = tag('a'); const b = tag('b'); const id = tag(`conc${i}`); const genB = `${(i % 10)}c`.repeat(32);
      await spotRef(id).set(claimedBy(a));
      const racer = async () => {
        if (await sweeperRelease(id, a)) await bClaim(id, b, genB);
      };
      await Promise.all([releaseClaimsOfDeletedUser(db, a), racer()]);
      const d = await data(id);
      const bl = await lockRef(b).get();
      expect(d.interestedUserId === a).toBe(false);
      expect(d.interestedUserName === 'Alice').toBe(false);
      if (bl.exists) {
        expect(d).toMatchObject({ status: 'interested', interestedUserId: b, claimGenerationId: genB });
        expect(bl.data()).toMatchObject({ spotId: id, claimGenerationId: genB });
      } else {
        expect(d.status).toBe('available'); expect(d.interestedUserId == null).toBe(true);
      }
      expect(await remaining(a)).toBe(0);
    }
  });

  it('M06 expired Ping: claim cleared, never reopened', async () => {
    const a = tag('a'); const id = tag('expired');
    await spotRef(id).set(claimedBy(a, { expiresAt: past() }));
    expect(await releaseClaimsOfDeletedUser(db, a)).toMatchObject({ release: 1, reopen: 0 });
    const d = await data(id);
    expect(d.status).toBe('interested'); expectNoIdentity(d); expectClaimCleared(d);
  });

  it('M07 arrived and terminal Pings: identity scrubbed, status and handoff state kept', async () => {
    const a = tag('a');
    const rows = {
      arrived: claimedBy(a, { claimState: 'arrived_pending_outcome' }),
      occupied: claimedBy(a, { status: 'occupied', claimState: 'arrived_pending_outcome' }),
      completed: claimedBy(a, { status: 'completed', claimState: 'completed' }),
      expiredStatus: claimedBy(a, { status: 'expired', expiresAt: past() }),
    };
    const ids = {};
    for (const [k, v] of Object.entries(rows)) { ids[k] = tag(k); await spotRef(ids[k]).set(v); }
    expect(await releaseClaimsOfDeletedUser(db, a)).toMatchObject({ scrub: 4, reopen: 0, release: 0 });
    for (const [k, v] of Object.entries(rows)) {
      const d = await data(ids[k]);
      expectNoIdentity(d);
      expect(d.claimGenerationId).toBeUndefined();
      expect(d.status).toBe(v.status); expect(d.claimState).toBe(v.claimState);
      expect(d.claimStartedAt.isEqual(v.claimStartedAt)).toBe(true);
    }
  });

  it('M08 missing or malformed fields fail closed', async () => {
    const a = tag('a');
    const noExpiry = claimedBy(a); delete noExpiry.expiresAt;
    const noStatus = claimedBy(a); delete noStatus.status;
    const rows = {
      noExpiry: [noExpiry, (d) => { expect(d.status).toBe('interested'); expectClaimCleared(d); }],
      stringExpiry: [claimedBy(a, { expiresAt: '2099-01-01T00:00:00Z' }), (d) => { expect(d.status).toBe('interested'); expectClaimCleared(d); }],
      noStatus: [noStatus, (d) => { expect(d.status).toBeUndefined(); expect(d.claimState).toBe('heading'); }],
      weirdState: [claimedBy(a, { claimState: 42 }), (d) => { expect(d.status).toBe('available'); expectClaimCleared(d); }],
    };
    const ids = {};
    for (const [k, [v]] of Object.entries(rows)) { ids[k] = tag(k); await spotRef(ids[k]).set(v); }
    const numericClaimer = tag('numeric');
    await spotRef(numericClaimer).set(claimedBy(a, { interestedUserId: 12345 }));
    await releaseClaimsOfDeletedUser(db, a);
    for (const [k, [, check]] of Object.entries(rows)) { const d = await data(ids[k]); expectNoIdentity(d); check(d); }
    expect((await data(numericClaimer)).interestedUserId).toBe(12345);
    for (const bad of ['', null, undefined, 7, 'a/b']) {
      await expect(releaseClaimsOfDeletedUser(db, bad)).rejects.toThrow('invalid claimer id');
    }
  });

  it('M09 concurrent sweepers: every Ping is changed exactly once', async () => {
    const a = tag('a');
    const ids = await seedMany(a, 12, () => claimedBy(a));
    const [r1, r2, r3] = await Promise.all([
      releaseClaimsOfDeletedUser(db, a, { concurrency: 4 }),
      releaseClaimsOfDeletedUser(db, a, { concurrency: 4 }),
      Promise.all(ids.slice(0, 4).map((id) => sweeperRelease(id, a))),
    ]);
    const sweeperWins = r3.filter(Boolean).length;
    expect(r1.reopen + r2.reopen + sweeperWins).toBe(12);
    expect(await remaining(a)).toBe(0);
    for (const id of ids) { const d = await data(id); expect(d.status).toBe('available'); expect(d.interestedUserId == null).toBe(true); }
  });

  it('M10 retry is idempotent: the second run writes nothing', async () => {
    const a = tag('a');
    const ids = await seedMany(a, 5, (j) => claimedBy(a, j % 2 ? { status: 'occupied', claimState: 'arrived_pending_outcome' } : {}));
    await releaseClaimsOfDeletedUser(db, a);
    const before = await Promise.all(ids.map((id) => spotRef(id).get()));
    expect(await releaseClaimsOfDeletedUser(db, a)).toEqual({ reopen: 0, release: 0, scrub: 0, skip: 0, gone: 0 });
    const after = await Promise.all(ids.map((id) => spotRef(id).get()));
    after.forEach((s, i) => expect(s.updateTime.isEqual(before[i].updateTime)).toBe(true));
  });

  it('M11 a partial page failure is surfaced, other Pings commit, retry completes', async () => {
    const a = tag('a');
    const ids = await seedMany(a, 5, () => claimedBy(a));
    const poisoned = ids[2];
    const failing = {
      collection: (p) => db.collection(p),
      doc: (p) => db.doc(p),
      runTransaction: (fn, o) => db.runTransaction((tx) => fn({
        get: (ref) => (ref.path === `spots/${poisoned}` ? Promise.reject(new Error('injected')) : tx.get(ref)),
        update: (...x) => tx.update(...x),
        delete: (...x) => tx.delete(...x),
      }), o),
    };
    await expect(releaseClaimsOfDeletedUser(failing, a)).rejects.toThrow('1 of 5 claim releases failed');
    expect((await data(poisoned)).interestedUserId).toBe(a);
    for (const id of ids.filter((x) => x !== poisoned)) expect((await data(id)).status).toBe('available');
    expect(await releaseClaimsOfDeletedUser(db, a)).toMatchObject({ reopen: 1 });
    expect(await remaining(a)).toBe(0);
  });

  // M12 (1,050-Ping pagination) lives in deletedUserClaimRelease.pagination.emulator.integration.test.js.
  // It runs in its own vitest pass after this suite so its onCreate trigger backlog cannot overlap
  // timing-sensitive emulator suites (vite.functions.isolated.pagination.config.ts).

  it('M13 exact claim-lock consistency: only the deleting user\'s lock naming the released Ping is removed', async () => {
    const a = tag('a'); const b = tag('b');
    const y = tag('y'); const z = tag('z');
    await spotRef(y).set(claimedBy(a));
    await lockRef(a).set({ spotId: z, claimGenerationId: GEN_A });           // names another Ping
    await lockRef(b).set({ spotId: y, claimGenerationId: 'd'.repeat(64) }); // someone else's lock naming y
    const bBefore = await lockRef(b).get();
    await releaseClaimsOfDeletedUser(db, a);
    expect((await lockRef(a).get()).data().spotId).toBe(z);
    expect((await lockRef(b).get()).updateTime.isEqual(bBefore.updateTime)).toBe(true);
    await spotRef(z).set(claimedBy(a));
    await releaseClaimsOfDeletedUser(db, a);
    expect((await lockRef(a).get()).exists).toBe(false);
  });

  it('M14 no trust events, receipts or notifications are written', async () => {
    const a = tag('a');
    const sizes = async () => Promise.all(['spotNotifications', 'finderCancelReceipts', 'trustEvents', 'processedTrustEvents']
      .map(async (c) => (await db.collection(c).get()).size).concat([(await db.collectionGroup('processedTrustEvents').get()).size]));
    const before = await sizes();
    await seedMany(a, 4, (j) => claimedBy(a, j === 3 ? { expiresAt: past() } : {}));
    await releaseClaimsOfDeletedUser(db, a);
    expect(await sizes()).toEqual(before);
  });
});
