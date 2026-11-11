'use strict';

// S7 mixed-version compatibility (t674u): T2 LEGACY GENERATIONLESS CLAIMS and
// T5 SUSPENSION / IN-FLIGHT RACES against the merged main-branch parking
// callables. Head modules only; no deployed source is involved here.
//
// CHARACTERIZATION tests document behavior. SECURITY tests are release
// contracts. A contract the current code does not meet is an it.fails tagged
// BLOCKER[...] (security) or GAP[...] (compatibility / product decision). The
// assertion inside an it.fails is the expected safe behavior, unchanged; the
// test turns red when the code is fixed and must then become a plain it.
//
// Writes go to a separate demo project namespace on the isolated Firestore
// emulator so the functions emulator's head triggers (registered for
// demo-parkqueen-parking-fence-iso) do not fire on these documents.

require('./isolatedEmulatorGuard').assertIsolatedEmulator({ services: ['firestore'] });

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { prepareClaimIntent, claimSpot, revokeClaimIntent, ATTEMPT_COLLECTION } = require('./claimSpot');
const { cancelClaim } = require('./cancelClaim');
const { finderCancelSpot } = require('./finderCancelSpot');
const { checkRateLimit } = require('./rateLimiter');

const ISOLATED = 'demo-parkqueen-parking-fence-iso';
const PROJECT = 'demo-parkqueen-s7-mixed-version';
const host = process.env.FIRESTORE_EMULATOR_HOST || '';
if (process.env.GCLOUD_PROJECT !== ISOLATED || host === '' || host.endsWith(':8080')) {
  throw new Error('Refusing mixed-version proof outside the isolated emulator');
}
if (getApps().length !== 0) throw new Error('Unexpected pre-initialized Admin app');
initializeApp({ projectId: PROJECT });
const db = getFirestore();

const FIXED = 1_700_000_000_000;
const G1 = '1a'.repeat(32);
const G2 = '2b'.repeat(32);
const FABRICATED = 'ff'.repeat(32);
const PAUSE_MS = 2000;
let sequence = 0;

function ids(label) {
  sequence += 1;
  const n = String(sequence).padStart(12, '0');
  return {
    a: `mvA_${label}_${n}`,
    b: `mvB_${label}_${n}`,
    finder: `mvF_${label}_${n}`,
    s1: `mvS1_${label}_${n}`,
    s2: `mvS2_${label}_${n}`,
    attempt: `cccccccc-cccc-4ccc-8ccc-${n}`,
    attempt2: `dddddddd-dddd-4ddd-8ddd-${n}`,
  };
}

function deps(extra = {}) {
  return {
    db,
    now: () => Timestamp.fromMillis(FIXED),
    checkRateLimit,
    randomBytes: () => Buffer.alloc(32, 9),
    ...extra,
  };
}

function available(finder, extra = {}) {
  return {
    status: 'available',
    finderId: finder,
    interestedUserId: null,
    expiresAt: Timestamp.fromMillis(FIXED + 3_600_000),
    reportedAt: Timestamp.fromMillis(FIXED + 3_600_000),
    ...extra,
  };
}

// A valid historical (pre-callable) claim: written by the Oct 16 client, so it
// has no claimGenerationId field at all.
function legacyClaimed(finder, claimant, extra = {}) {
  return available(finder, {
    status: 'interested',
    claimState: 'heading',
    interestedUserId: claimant,
    interestedUserName: 'ada',
    claimStartedAt: Timestamp.fromMillis(FIXED - 60_000),
    etaMinutes: 4,
    interestExpiresAt: Timestamp.fromMillis(FIXED + 540_000),
    ...extra,
  });
}

function profile(extra = {}) {
  return { status: 'Active', productAccessBlocked: false, username: 'ada', ...extra };
}

async function seedUsers(row, aProfile = profile()) {
  if (aProfile) await db.collection('users').doc(row.a).set(aProfile);
  await db.collection('users').doc(row.b).set(profile({ username: 'bob' }));
  await db.collection('users').doc(row.finder).set(profile({ username: 'bea' }));
}

async function lockFor(uid, spotId, extra = {}) {
  await db.collection('users').doc(uid).collection('activeIncomingClaims').doc('current').set({
    spotId,
    claimStartedAt: Timestamp.fromMillis(FIXED - 60_000),
    claimState: 'heading',
    updatedAt: Timestamp.fromMillis(FIXED - 60_000),
    ...extra,
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

async function noticeCount(spotId) {
  const snap = await db.collection('spotNotifications').where('spotId', '==', spotId).get();
  return snap.size;
}

function claimReq(uid, spotId, attemptId) {
  return { auth: { uid }, data: { spotId, attemptId, mode: 'immediate', etaMinutes: 4 } };
}

function cancelReq(uid, spotId, claimGenerationId) {
  return { auth: { uid }, data: { spotId, claimGenerationId, reason: 'unspecified' } };
}

async function claimThroughCallables(uid, spotId, attemptId) {
  const prepared = await prepareClaimIntent(claimReq(uid, spotId, attemptId), deps());
  if (prepared.state !== 'prepared') return { outcome: `prepare:${prepared.state}` };
  return claimSpot(claimReq(uid, spotId, attemptId), deps());
}

beforeAll(async () => {
  await db.collection('spots').doc('mvConnectionProbe').get();
});

// ─── T2 ─────────────────────────────────────────────────────────────────────

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

describe('T2 legacy generationless claims vs head callables', () => {
  it('SECURITY T2-S1: a fabricated or wrong generation id cannot cancel a legacy claim (no write, no notice)', async () => {
    const row = ids('t2s1');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
    await lockFor(row.a, row.s1);
    const before = await spotData(row.s1);
    for (const caller of [row.a, row.b, row.finder]) {
      const result = await cancelClaim(cancelReq(caller, row.s1, FABRICATED), deps());
      expect(['stale_claim', 'already_resolved']).toContain(result.outcome);
    }
    expect(await spotData(row.s1)).toEqual(before);
    expect(await lockData(row.a)).not.toBeNull();
    expect(await noticeCount(row.s1)).toBe(0);
  });

  it('SECURITY T2-S2: missing, null, and malformed generation ids are rejected before any read or write', async () => {
    const row = ids('t2s2');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
    for (const bad of [undefined, null, '', 'not-a-generation', 'AB'.repeat(32), G1.slice(2)]) {
      const data = { spotId: row.s1, reason: 'unspecified', claimGenerationId: bad };
      if (bad === undefined) delete data.claimGenerationId;
      await expect(cancelClaim({ auth: { uid: row.a }, data }, deps())).rejects.toMatchObject({ code: 'invalid-argument' });
    }
    expect((await spotData(row.s1)).interestedUserId).toBe(row.a);
  });

  it('SECURITY T2-S3: a newer generation is preserved against the same user\'s older id and against another user', async () => {
    const row = ids('t2s3');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a, { claimGenerationId: G2 }));
    await lockFor(row.a, row.s1, { claimGenerationId: G2 });
    expect((await cancelClaim(cancelReq(row.a, row.s1, G1), deps())).outcome).toBe('stale_claim');
    expect((await cancelClaim(cancelReq(row.b, row.s1, G2), deps())).outcome).toBe('already_resolved');
    const spot = await spotData(row.s1);
    expect(spot.interestedUserId).toBe(row.a);
    expect(spot.claimGenerationId).toBe(G2);
    expect(await noticeCount(row.s1)).toBe(0);
  });

  it('SECURITY T2-S4: another user cannot take over a legacy claim through prepareClaimIntent/claimSpot', async () => {
    const row = ids('t2s4');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
    const result = await claimThroughCallables(row.b, row.s1, row.attempt);
    // Refused at the prepare stage; claimSpot is never reached.
    expect(result.outcome).toBe('prepare:unavailable');
    // claimSpot called directly, without a prepared intent, must not claim either.
    const direct = await claimSpot(claimReq(row.b, row.s1, row.attempt2), deps())
      .catch((error) => ({ outcome: `error:${error.code}` }));
    expect(direct.outcome).toBe('error:failed-precondition');
    expect((await spotData(row.s1)).interestedUserId).toBe(row.a);
  });

  it('CHARACTERIZATION T2-C1: the legacy claimant\'s own cancelClaim gets stale_claim and the live claim stays', async () => {
    const row = ids('t2c1');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
    await lockFor(row.a, row.s1);
    const result = await cancelClaim(cancelReq(row.a, row.s1, FABRICATED), deps());
    expect(result.outcome).toBe('stale_claim');
    expect((await spotData(row.s1)).status).toBe('interested');
  });

  it('CHARACTERIZATION T2-C2: prepareClaimIntent on the legacy claimant\'s own Ping returns already_held and issues no generation id', async () => {
    const row = ids('t2c2');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
    const result = await claimThroughCallables(row.a, row.s1, row.attempt);
    // prepareClaimIntent answers already_held (no intent, no generation issued).
    expect(result.outcome).toBe('prepare:already_held');
    expect(result.claimGenerationId).toBeUndefined();
    const spot = await spotData(row.s1);
    expect(spot.interestedUserId).toBe(row.a);
    expect(spot.claimGenerationId ?? null).toBeNull();
  });

  it('CHARACTERIZATION T2-C3: a legacy claim plus its lock blocks the claimant from claiming any other Ping (already_claimed)', async () => {
    const row = ids('t2c3');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
    await lockFor(row.a, row.s1);
    await db.collection('spots').doc(row.s2).set(available(row.finder));
    const result = await claimThroughCallables(row.a, row.s2, row.attempt);
    expect(result.outcome).toBe('already_claimed');
    expect((await spotData(row.s2)).status).toBe('available');
  });

  it('CHARACTERIZATION T2-C4: finderCancelSpot returns unproven_identity for a legacy claim and does not delete it', async () => {
    const row = ids('t2c4');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
    const result = await finderCancelSpot({
      auth: { uid: row.finder },
      data: { spotId: row.s1, status: 'interested', interestedUserId: row.a, claimState: 'heading', claimGenerationId: null },
    }, deps());
    expect(result.outcome).toBe('unproven_identity');
    expect(await spotData(row.s1)).not.toBeNull();
  });

  it('CHARACTERIZATION T2-C5: a Ping released by an old client (generation left behind) is refused by claimSpot', async () => {
    const row = ids('t2c5');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(available(row.finder, { claimGenerationId: G1 }));
    const result = await claimThroughCallables(row.b, row.s1, row.attempt);
    expect(result.outcome).toBe('refused_stale_generation');
  });

  itExpectedUnsafe('GAP[T2-G1] the legacy claimant can release a legitimate legacy claim through a supported new-client path', async () => {
    const row = ids('t2g1');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
    await lockFor(row.a, row.s1);
    // The head client has no generation to send (cancelClaimCallable.ts
    // rejects a missing id). The only server path is cancelClaim, which needs
    // the stored id. Expected safe: the claimant's own live claim is released.
    await cancelClaim(cancelReq(row.a, row.s1, FABRICATED), deps()).catch(() => null);
    const spot = await spotData(row.s1);
    expect(spot.status).toBe('available');
    expect(spot.interestedUserId ?? null).toBeNull();
  });

  itExpectedUnsafe('GAP[T2-G2] the finder can release a Ping held by a legitimate legacy claimant through finderCancelSpot', async () => {
    const row = ids('t2g2');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
    const result = await finderCancelSpot({
      auth: { uid: row.finder },
      data: { spotId: row.s1, status: 'interested', interestedUserId: row.a, claimState: 'heading', claimGenerationId: null },
    }, deps());
    expect(result.outcome).toBe('deleted');
  });

  itExpectedUnsafe('GAP[T2-G3] a Ping released by an old client becomes claimable again through claimSpot', async () => {
    const row = ids('t2g3');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(available(row.finder, { claimGenerationId: G1 }));
    const result = await claimThroughCallables(row.b, row.s1, row.attempt);
    expect(result.outcome).toBe('claimed');
  });
});

// ─── T5 ─────────────────────────────────────────────────────────────────────
describe('T5 suspension and in-flight races vs head callables', () => {
  const SUSPENDED = [
    ['Suspended', { status: 'Suspended' }],
    ['productAccessBlocked', { productAccessBlocked: true }],
  ];

  for (const [label, patch] of SUSPENDED) {
    it(`SECURITY T5-S1-${label}: prepare, claim, cancel and finder cancel are denied with no product write`, async () => {
      const row = ids(`t5s1${label}`);
      await seedUsers(row);
      await db.collection('spots').doc(row.s1).set(available(row.finder));
      await db.collection('spots').doc(row.s2).set(legacyClaimed(row.finder, row.a, { claimGenerationId: G1 }));
      const prepared = await prepareClaimIntent(claimReq(row.a, row.s1, row.attempt), deps());
      expect(prepared.state).toBe('prepared');
      await db.collection('users').doc(row.a).set(profile(patch));
      await db.collection('users').doc(row.finder).set(profile({ username: 'bea', ...patch }));
      await expect(prepareClaimIntent(claimReq(row.a, row.s1, row.attempt2), deps())).rejects.toMatchObject({ code: 'permission-denied' });
      await expect(claimSpot(claimReq(row.a, row.s1, row.attempt), deps())).rejects.toMatchObject({ code: 'permission-denied' });
      await expect(cancelClaim(cancelReq(row.a, row.s2, G1), deps())).rejects.toMatchObject({ code: 'permission-denied' });
      await expect(finderCancelSpot({
        auth: { uid: row.finder },
        data: { spotId: row.s1, status: 'available', interestedUserId: null, claimState: null, claimGenerationId: null },
      }, deps())).rejects.toMatchObject({ code: 'permission-denied' });
      expect((await spotData(row.s1)).status).toBe('available');
      expect((await spotData(row.s2)).interestedUserId).toBe(row.a);
      expect(await noticeCount(row.s2)).toBe(0);
    });

    it(`CHARACTERIZATION T5-C1-${label}: revokeClaimIntent releases a live callable claim and notifies the finder`, async () => {
      const row = ids(`t5c1${label}`);
      await seedUsers(row);
      await db.collection('spots').doc(row.s1).set(available(row.finder));
      const claimed = await claimThroughCallables(row.a, row.s1, row.attempt);
      expect(claimed.outcome).toBe('claimed');
      await db.collection('users').doc(row.a).set(profile(patch));
      const result = await revokeClaimIntent(claimReq(row.a, row.s1, row.attempt), deps());
      expect(result.outcome).toBe('released');
      expect((await spotData(row.s1)).status).toBe('available');
      expect(await noticeCount(row.s1)).toBe(1);
    });

    it(`CHARACTERIZATION T5-C2-${label}: revokeClaimIntent writes a revoked tombstone for an absent attempt`, async () => {
      const row = ids(`t5c2${label}`);
      await seedUsers(row, profile(patch));
      await db.collection('spots').doc(row.s1).set(available(row.finder));
      const result = await revokeClaimIntent(claimReq(row.a, row.s1, row.attempt), deps());
      expect(result.outcome).toBe('revoked');
      expect((await db.collection(ATTEMPT_COLLECTION).doc(row.attempt).get()).data().state).toBe('revoked');
    });

    itExpectedUnsafe(`GAP[T5-G1-${label}] revokeClaimIntent applies the same suspension denial as cancelClaim (founder policy decision pending)`, async () => {
      const row = ids(`t5g1${label}`);
      await seedUsers(row);
      await db.collection('spots').doc(row.s1).set(available(row.finder));
      const claimed = await claimThroughCallables(row.a, row.s1, row.attempt);
      expect(claimed.outcome).toBe('claimed');
      await db.collection('users').doc(row.a).set(profile(patch));
      await expect(revokeClaimIntent(claimReq(row.a, row.s1, row.attempt), deps())).rejects.toMatchObject({ code: 'permission-denied' });
      expect(await noticeCount(row.s1)).toBe(0);
    });
  }

  // Suspension committed after the transactional user read. Same pause and
  // classification method as parkingCallablePostReadRace (fence writer),
  // applied to users/{uid}.status. An operation may finish only if it is
  // serialized before the suspension; it must not commit product state after
  // a suspension that committed while it was paused.
  function holdForSuspension(actor, events) {
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
        tx.set(db.collection('users').doc(actor), profile({ status: 'Suspended' }));
      }).then(() => {
        events.push('suspension-committed');
        return 'committed';
      }).catch((error) => {
        events.push(`suspension-writer-failed:${error.code || 'error'}`);
        return 'failed';
      });
      writers.push(writer);
      const paused = await Promise.race([
        writer,
        new Promise((resolve) => { setTimeout(() => resolve('blocked'), PAUSE_MS); }),
      ]);
      events.push(paused === 'committed' ? 'suspension-committed-while-paused' : 'suspension-blocked-while-product-held');
    };
    return { hook, writers, readCount: () => reads };
  }

  const raceCases = [
    {
      name: 'prepare',
      actor: (row) => row.a,
      run: (row, d) => prepareClaimIntent(claimReq(row.a, row.s1, row.attempt), d),
      // Product state for prepare is a live prepared intent; a permission_denied
      // tombstone is the denial record, not product state.
      changed: (b, a) => a.attempt === 'prepared' && b.attempt !== 'prepared',
    },
    {
      name: 'claim',
      actor: (row) => row.a,
      prepare: true,
      run: (row, d) => claimSpot(claimReq(row.a, row.s1, row.attempt), d),
      changed: (b, a) => b.claimant !== a.claimant,
    },
    {
      name: 'cancel',
      actor: (row) => row.a,
      seedClaimed: true,
      run: (row, d) => cancelClaim(cancelReq(row.a, row.s1, G1), d),
      changed: (b, a) => b.claimant !== a.claimant,
    },
    {
      name: 'finder',
      actor: (row) => row.finder,
      run: (row, d) => finderCancelSpot({
        auth: { uid: row.finder },
        data: { spotId: row.s1, status: 'available', interestedUserId: null, claimState: null, claimGenerationId: null },
      }, d),
      changed: (b, a) => b.exists !== a.exists,
    },
  ];

  async function observe(row) {
    const spot = await spotData(row.s1);
    const attempt = await db.collection(ATTEMPT_COLLECTION).doc(row.attempt).get();
    return {
      exists: !!spot,
      claimant: spot ? spot.interestedUserId || null : null,
      attempt: attempt.exists ? attempt.data().state : null,
    };
  }

  for (const spec of raceCases) {
    it(`SECURITY T5-S2-${spec.name}: a suspension committed after the transactional user read cannot be followed by product state`, async () => {
      const row = ids(`t5s2${spec.name}`);
      await seedUsers(row);
      await db.collection('spots').doc(row.s1).set(spec.seedClaimed
        ? legacyClaimed(row.finder, row.a, { claimGenerationId: G1 })
        : available(row.finder));
      if (spec.prepare) {
        expect((await prepareClaimIntent(claimReq(row.a, row.s1, row.attempt), deps())).state).toBe('prepared');
      }
      const before = await observe(row);
      const events = [];
      const held = holdForSuspension(spec.actor(row), events);
      let failure = null;
      try {
        const result = await spec.run(row, deps({ allowTestHooks: true, afterLifecycleRead: held.hook }));
        events.push(`product-returned:${result.outcome || result.state}`);
      } catch (error) {
        failure = error;
        events.push(`product-failed:${error.code}`);
      }
      await Promise.race([
        Promise.all(held.writers),
        new Promise((_, reject) => { setTimeout(() => reject(new Error('suspension writer did not settle')), 8000); }),
      ]);
      const after = await observe(row);
      const changed = spec.changed(before, after);
      const pausedCommit = events.includes('suspension-committed-while-paused');
      const blocked = events.includes('suspension-blocked-while-product-held');
      console.log(JSON.stringify({ t674u: 'T5-S2', handler: spec.name, events, changed, reads: held.readCount() }));
      expect(events[0]).toBe('product-read-active');
      expect(events).toContain('suspension-committed');
      const returnedAt = events.findIndex((e) => e.startsWith('product-returned:'));
      const failedAt = events.findIndex((e) => e.startsWith('product-failed:'));
      const reread = events.findIndex((e) => e.startsWith('lifecycle-reread:'));
      if (blocked && !pausedCommit && reread === -1 && returnedAt !== -1) {
        // The product transaction held users/{uid} through commit, so the
        // suspension writer could not commit while the product was paused: the
        // operation is serialized before the suspension and may complete.
        expect(held.readCount()).toBe(1);
        expect(failure).toBeNull();
        expect(changed).toBe(true);
      } else if (pausedCommit && reread !== -1 && failedAt > reread) {
        // The suspension committed while the product was paused; the retried
        // transaction re-read the profile and must deny with no product state.
        expect(held.readCount()).toBeGreaterThan(1);
        expect(failure && failure.code).toBe('permission-denied');
        expect(changed).toBe(false);
      } else {
        throw new Error(`Unclassified suspension order: ${JSON.stringify(events)}`);
      }
      const final = (await db.collection('users').doc(spec.actor(row)).get()).data();
      expect(final.status).toBe('Suspended');
    });
  }
});
