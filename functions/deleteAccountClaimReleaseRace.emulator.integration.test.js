'use strict';

// S4 deletion claim-release race, end to end on the isolated emulator.
// Real deleteAccount, real cleanupExpiredInterests sweeper and real
// prepareClaimIntent/claimSpot. The only test seam is a pause after
// deleteAccount's spotsAsClaimer page query returns the claimer's Ping.
require('./isolatedEmulatorGuard').assertIsolatedEmulator({ services: ['firestore', 'auth', 'storage'] });

const PROJECT = 'demo-parkqueen-parking-fence-iso';
const host = process.env.FIRESTORE_EMULATOR_HOST || '';
if (process.env.GCLOUD_PROJECT !== PROJECT || host === '' || host.endsWith(':8080')) {
  throw new Error('Refusing deletion race proof outside the isolated project and port');
}

const { randomUUID } = require('crypto');
const { Query } = require('@google-cloud/firestore');
const { deleteAccount, cleanupExpiredInterests } = require('./index.js');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { prepareClaimIntent, claimSpot } = require('./claimSpot');
const { checkRateLimit } = require('./rateLimiter');

const db = getFirestore();
const GEN_A = 'a1'.repeat(32);
let seq = 0;

function row(label) {
  seq += 1;
  const n = `${Date.now().toString(36)}${String(seq).padStart(4, '0')}`;
  return {
    a: `delA_${label}_${n}`,
    b: `claimB_${label}_${n}`,
    finder: `finder_${label}_${n}`,
    spotId: `spot_${label}_${n}`,
    // Random v4 id: a sequence-based id collided with parkingCallablePostReadRace's
    // first attempt id in the shared emulator and made its prepare case fail (t697u).
    attemptId: randomUUID(),
  };
}

function profile(name) {
  return { status: 'Active', productAccessBlocked: false, username: name.slice(0, 20), fullName: 'Test' };
}

function lockRef(uid) {
  return db.doc(`users/${uid}/activeIncomingClaims/current`);
}

async function seedClaimedByA(r, { interestExpired }) {
  const nowMs = Date.now();
  await getAuth().createUser({ uid: r.a }).catch(() => {});
  await db.doc(`users/${r.a}`).set(profile(r.a));
  await db.doc(`users/${r.b}`).set(profile(r.b));
  await db.doc(`users/${r.finder}`).set(profile(r.finder));
  const started = Timestamp.fromMillis(nowMs - 10 * 60_000);
  await db.doc(`spots/${r.spotId}`).set({
    status: 'interested',
    finderId: r.finder,
    interestedUserId: r.a,
    interestedUserName: 'Alice',
    interestedUserVehicleColor: 'red',
    interestedUserVehicleType: 'sedan',
    interestedUserVehicleBrand: 'Honda',
    interestedUserTitle: 'Newcomer',
    claimState: 'heading',
    claimStartedAt: started,
    etaMinutes: 4,
    claimGenerationId: GEN_A,
    interestExpiresAt: Timestamp.fromMillis(interestExpired ? nowMs - 60_000 : nowMs + 30 * 60_000),
    expiresAt: Timestamp.fromMillis(nowMs + 60 * 60_000),
    reportedAt: Timestamp.fromMillis(nowMs + 60 * 60_000),
  });
  await lockRef(r.a).set({
    spotId: r.spotId, claimStartedAt: started, claimState: 'heading', updatedAt: started, claimGenerationId: GEN_A,
  });
}

function deleteRequest(uid) {
  return { auth: { uid, token: { auth_time: Math.floor(Date.now() / 1000) } }, data: {}, rawRequest: {} };
}

// Pause the first page query that returns this Ping still naming the deleting user.
function pauseAfterClaimerQuery(spotId, deletingUid, hook) {
  const original = Query.prototype.get;
  const state = { fired: false, error: null };
  Query.prototype.get = async function pausedGet(...args) {
    const snap = await original.apply(this, args);
    if (!state.fired && snap.docs.some((d) => d.id === spotId && (d.data() || {}).interestedUserId === deletingUid)) {
      state.fired = true;
      try { await hook(); } catch (e) { state.error = e; }
    }
    return snap;
  };
  state.restore = () => { Query.prototype.get = original; };
  return state;
}

async function bClaims(r) {
  const deps = { db, now: () => Timestamp.now(), checkRateLimit };
  const req = { auth: { uid: r.b }, data: { spotId: r.spotId, attemptId: r.attemptId, mode: 'immediate', etaMinutes: 4 } };
  const prepared = await prepareClaimIntent(req, deps);
  if (prepared.state !== 'prepared') throw new Error(`B prepare: ${JSON.stringify(prepared)}`);
  const claimed = await claimSpot(req, deps);
  if (claimed.outcome !== 'claimed') throw new Error(`B claim: ${JSON.stringify(claimed)}`);
  return claimed.claimGenerationId;
}

async function cleanup(r) {
  await getAuth().deleteUser(r.a).catch(() => {});
  for (const uid of [r.a, r.b, r.finder]) {
    await db.recursiveDelete(db.doc(`users/${uid}`)).catch(() => {});
    await db.doc(`accountLifecycle/${uid}`).delete().catch(() => {});
    await db.doc(`accountDeletionJobs/${uid}`).delete().catch(() => {});
  }
  await db.doc(`spots/${r.spotId}`).delete().catch(() => {});
}

describe('deleteAccount spotsAsClaimer vs a legitimate replacement claim', () => {
  it('RACE-E2E: keeps B\'s replacement claim when A\'s claim is released and B reclaims mid-cleanup', async () => {
    const r = row('race');
    await seedClaimedByA(r, { interestExpired: true });
    const observed = {};
    let genB = null;
    const pause = pauseAfterClaimerQuery(r.spotId, r.a, async () => {
      // Step 3: A's interest window lapsed; the real one-minute sweeper releases it.
      await cleanupExpiredInterests.run({});
      const mid = (await db.doc(`spots/${r.spotId}`).get()).data();
      observed.afterRelease = { status: mid.status, interestedUserId: mid.interestedUserId, gen: mid.claimGenerationId };
      // Step 4: B legitimately acquires the reopened Ping through the claim callables.
      genB = await bClaims(r);
      const afterB = (await db.doc(`spots/${r.spotId}`).get()).data();
      observed.afterB = { status: afterB.status, interestedUserId: afterB.interestedUserId, gen: afterB.claimGenerationId };
    });
    let result;
    try {
      // Steps 2 and 5: deleteAccount's page query, then its cleanup commit.
      result = await deleteAccount.run(deleteRequest(r.a));
    } finally {
      pause.restore();
    }
    expect(pause.error).toBeNull();
    expect(pause.fired).toBe(true);
    expect(observed.afterRelease).toEqual({ status: 'available', interestedUserId: null, gen: null });
    expect(observed.afterB).toEqual({ status: 'interested', interestedUserId: r.b, gen: genB });
    expect(result).toEqual({ success: true });

    const spot = (await db.doc(`spots/${r.spotId}`).get()).data();
    const bLock = await lockRef(r.b).get();
    const finalState = {
      status: spot.status,
      interestedUserId: spot.interestedUserId,
      claimGenerationId: spot.claimGenerationId,
      claimState: spot.claimState,
      bLockSpot: bLock.exists ? bLock.data().spotId : null,
      bLockGen: bLock.exists ? bLock.data().claimGenerationId : null,
    };
    console.log('[RACE-E2E] final', JSON.stringify({ ...finalState, interestedUserId: finalState.interestedUserId === r.b ? 'B' : finalState.interestedUserId }));
    // Replacement-claim invariant: B's claim, generation and lock survive A's deletion.
    expect(finalState).toEqual({
      status: 'interested',
      interestedUserId: r.b,
      claimGenerationId: genB,
      claimState: 'heading',
      bLockSpot: r.spotId,
      bLockGen: genB,
    });
    expect(spot.interestedUserName).not.toBe('Alice');
    expect((await db.doc(`accountDeletionJobs/${r.a}`).get()).data().state).toBe('completed');
    expect((await db.doc(`accountLifecycle/${r.a}`).get()).exists).toBe(true);
    await cleanup(r);
  });

  it('E2E-LIVE: a live claim with no race is released, reopened and its lock removed', async () => {
    const r = row('live');
    await seedClaimedByA(r, { interestExpired: false });
    const result = await deleteAccount.run(deleteRequest(r.a));
    expect(result).toEqual({ success: true });
    const spot = (await db.doc(`spots/${r.spotId}`).get()).data();
    expect(spot.status).toBe('available');
    for (const k of ['interestedUserId', 'interestedUserName', 'interestedUserVehicleColor',
      'interestedUserVehicleType', 'interestedUserVehicleBrand', 'interestedUserTitle']) {
      expect(spot[k]).toBeUndefined();
    }
    expect(spot.claimGenerationId).toBeNull();
    expect(spot.claimState).toBeNull();
    expect((await lockRef(r.a).get()).exists).toBe(false);
    expect((await db.doc(`accountDeletionJobs/${r.a}`).get()).data().steps.spotsAsClaimer).toBe('done');
    await cleanup(r);
  });

  it('E2E-PARTIAL: a failed claim release pauses deletion, keeps Auth, and a retry completes', async () => {
    const r = row('partial');
    await seedClaimedByA(r, { interestExpired: false });
    const originalTx = db.runTransaction.bind(db);
    db.runTransaction = (fn, opts) => originalTx((tx) => fn(new Proxy(tx, {
      get(target, prop) {
        if (prop === 'get') {
          return (ref, ...rest) => (ref && ref.path === `spots/${r.spotId}`
            ? Promise.reject(new Error('injected')) : target.get(ref, ...rest));
        }
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    })), opts);
    try {
      await expect(deleteAccount.run(deleteRequest(r.a))).rejects.toMatchObject({ code: 'internal' });
    } finally {
      db.runTransaction = originalTx;
    }
    const job = (await db.doc(`accountDeletionJobs/${r.a}`).get()).data();
    expect(job.state).toBe('failed');
    expect(job.steps.spotsAsClaimer).toBe('error');
    expect(job.lastError).toMatch(/^spotsAsClaimer: /);
    expect((await getAuth().getUser(r.a)).uid).toBe(r.a);
    expect((await db.doc(`spots/${r.spotId}`).get()).data().interestedUserId).toBe(r.a);
    expect(await deleteAccount.run(deleteRequest(r.a))).toEqual({ success: true });
    const spot = (await db.doc(`spots/${r.spotId}`).get()).data();
    expect(spot.interestedUserId).toBeUndefined();
    expect(spot.status).toBe('available');
    await expect(getAuth().getUser(r.a)).rejects.toMatchObject({ code: 'auth/user-not-found' });
    await cleanup(r);
  });
});
