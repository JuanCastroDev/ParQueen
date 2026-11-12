'use strict';

// S7 T2 legacy generationless claim recovery (t682u). Release contracts for:
//   T2-G1  cancelClaim legacy shape  { spotId, legacyClaimStartedAt, reason }
//   T2-G2  finderCancelSpot legacy confirmation (sixth key legacyClaimStartedAt)
//   T2-G3  claimSpot recoverLeftoverGeneration: true
// against the merged main-branch handlers plus the t682u change, and the head
// updateTrustOnSpotDelete trigger for trust attribution.
//
// Ownership is the authenticated uid reread inside the transaction. The
// legacy claimStartedAt echo is only a claim-cycle discriminator.
//
// Writes go to the demo-parkqueen-s7-mixed-version namespace on the isolated
// Firestore emulator (same isolation as the t674u s7MixedVersion files), so
// the functions emulator's triggers for demo-parkqueen-parking-fence-iso do
// not fire on these documents. Every test here is a plain `it`: these are the
// new contracts, and a failure is a real failure. The historical t674u
// GAP[T2-G1..G3] records in s7MixedVersion.legacyClaims are not modified; they
// exercise the request shapes that remain unsupported (a fabricated
// generation, a finder confirmation without the legacy key, claimSpot without
// the recovery opt-in) and still fail as recorded.

require('./isolatedEmulatorGuard').assertIsolatedEmulator({ services: ['firestore'] });

const ISOLATED = 'demo-parkqueen-parking-fence-iso';
const PROJECT = 'demo-parkqueen-s7-mixed-version';
const host = process.env.FIRESTORE_EMULATOR_HOST || '';
if (process.env.GCLOUD_PROJECT !== ISOLATED || host === '' || host.endsWith(':8080')) {
  throw new Error('Refusing T2 legacy recovery proof outside the isolated emulator');
}
process.env.GCLOUD_PROJECT = PROJECT;
process.env.GOOGLE_CLOUD_PROJECT = PROJECT;
process.env.FIREBASE_CONFIG = JSON.stringify({ projectId: PROJECT, storageBucket: `${PROJECT}.appspot.com` });

const indexModule = require('./index.js');
const { getApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { prepareClaimIntent, claimSpot, revokeClaimIntent } = require('./claimSpot');
const { cancelClaim } = require('./cancelClaim');
const { finderCancelSpot } = require('./finderCancelSpot');
const { checkRateLimit } = require('./rateLimiter');

if (getApp().options.projectId !== PROJECT) throw new Error('Head index.js is not bound to the mixed-version namespace');
const db = getFirestore();

const FIXED = 1_700_000_000_000;
const G1 = '3c'.repeat(32);
const G2 = '4d'.repeat(32);
// Firestore stores microsecond precision; the echo is the stored value as read.
const T1 = new Timestamp(1_699_999_940, 123_456_000);
const T2 = new Timestamp(1_699_999_970, 987_654_000);
let sequence = 0;

function ids(label) {
  sequence += 1;
  const n = String(sequence).padStart(12, '0');
  return {
    a: `trA_${label}_${n}`,
    b: `trB_${label}_${n}`,
    c: `trC_${label}_${n}`,
    finder: `trF_${label}_${n}`,
    s1: `trS1_${label}_${n}`,
    s2: `trS2_${label}_${n}`,
    attempt: `eeeeeeee-eeee-4eee-8eee-${n}`,
    attempt2: `ffffffff-ffff-4fff-8fff-${n}`,
    attempt3: `abcdabcd-abcd-4bcd-8bcd-${n}`,
  };
}

function fp(ts) { return { seconds: ts.seconds, nanoseconds: ts.nanoseconds }; }
function token(uid, ts) { return `legacy_${uid}_${ts.seconds}_${ts.nanoseconds}`; }

let mint = 0;
function deps(extra = {}) {
  return {
    db,
    now: () => Timestamp.fromMillis(FIXED),
    checkRateLimit,
    // Fill bytes 0x80..0xe3: never equal to the G1/G2 fixtures (0x3c, 0x4d).
    randomBytes: () => { mint += 1; return Buffer.alloc(32, 0x80 + (mint % 100)); },
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

// A legitimate pre-callable claim: no claimGenerationId field at all.
function legacyClaimed(finder, claimant, extra = {}) {
  return available(finder, {
    status: 'interested',
    claimState: 'heading',
    interestedUserId: claimant,
    interestedUserName: 'ada',
    claimStartedAt: T1,
    etaMinutes: 4,
    interestExpiresAt: Timestamp.fromMillis(FIXED + 540_000),
    ...extra,
  });
}

function profile(extra = {}) {
  return { status: 'Active', productAccessBlocked: false, username: 'ada', ...extra };
}

async function seedUsers(row, overrides = {}) {
  await db.collection('users').doc(row.a).set(profile(overrides.a || {}));
  await db.collection('users').doc(row.b).set(profile({ username: 'bob', ...(overrides.b || {}) }));
  await db.collection('users').doc(row.c).set(profile({ username: 'cy' }));
  await db.collection('users').doc(row.finder).set(profile({ username: 'bea', ...(overrides.finder || {}) }));
}

function lockRef(uid) { return db.collection('users').doc(uid).collection('activeIncomingClaims').doc('current'); }

async function lockFor(uid, spotId, extra = {}) {
  await lockRef(uid).set({
    spotId,
    claimStartedAt: T1,
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
  const snap = await lockRef(uid).get();
  return snap.exists ? snap.data() : null;
}

async function notices(spotId) {
  const snap = await db.collection('spotNotifications').where('spotId', '==', spotId).get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}

async function trustOf(uid) {
  const snap = await db.collection('users').doc(uid).get();
  return snap.exists ? (snap.data().trustStats || null) : null;
}

function legacyCancel(uid, spotId, ts, extra = {}) {
  return cancelClaim({
    auth: { uid },
    data: { spotId, legacyClaimStartedAt: ts && typeof ts.toMillis === 'function' ? fp(ts) : ts, reason: 'traffic', ...extra },
  }, deps());
}

function finderLegacy(finder, spotId, claimant, ts, extra = {}, d = deps()) {
  return finderCancelSpot({
    auth: { uid: finder },
    data: {
      spotId,
      status: 'interested',
      interestedUserId: claimant,
      claimState: 'heading',
      claimGenerationId: null,
      legacyClaimStartedAt: ts && typeof ts.toMillis === 'function' ? fp(ts) : ts,
      ...extra,
    },
  }, d);
}

function claimReq(uid, spotId, attemptId, extra = {}) {
  return { auth: { uid }, data: { spotId, attemptId, mode: 'immediate', etaMinutes: 4, ...extra } };
}

async function claimThroughCallables(uid, spotId, attemptId, extra = {}) {
  const prepared = await prepareClaimIntent(claimReq(uid, spotId, attemptId, extra), deps());
  if (prepared.state !== 'prepared') return { outcome: `prepare:${prepared.state}` };
  return claimSpot(claimReq(uid, spotId, attemptId, extra), deps());
}

function deletedEvent(spotId, data, eventId) {
  return {
    id: eventId,
    params: { spotId },
    data: { id: spotId, data: () => data },
    time: new Date(FIXED + 1_000).toISOString(),
  };
}

beforeAll(async () => {
  await db.collection('spots').doc('trConnectionProbe').get();
});

// ─── T2-G1: claimant legacy release ─────────────────────────────────────────
describe('T2-G1 claimant release of a generationless legacy claim (cancelClaim legacy shape)', () => {
  it('SECURITY T2R-G1-1: the claimant releases their own legacy claim once; lock cleared; one finder notice; retry is a no-op; no trust change', async () => {
    const row = ids('g1a');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
    await lockFor(row.a, row.s1);
    expect(await legacyCancel(row.a, row.s1, T1)).toEqual({ outcome: 'cancelled' });
    const spot = await spotData(row.s1);
    expect(spot.status).toBe('available');
    for (const field of ['interestedUserId', 'interestedUserName', 'claimState', 'claimStartedAt', 'etaMinutes', 'interestExpiresAt', 'claimGenerationId']) {
      expect(spot[field]).toBeNull();
    }
    expect(await lockData(row.a)).toBeNull();
    const notes = await notices(row.s1);
    expect(notes.map((n) => n.id)).toEqual([`claimer_cancelled_${row.s1}_${token(row.a, T1)}`]);
    expect(notes[0]).toMatchObject({ type: 'claimer_cancelled', senderId: row.a, targetUserId: row.finder });
    expect(await legacyCancel(row.a, row.s1, T1)).toEqual({ outcome: 'already_resolved' });
    expect(await notices(row.s1)).toHaveLength(1);
    expect(await trustOf(row.a)).toBeNull();
    expect(await trustOf(row.finder)).toBeNull();
  });

  it('COMPAT T2R-G1-2: a lockless legacy claim releases; a lock naming another Ping is left untouched', async () => {
    const row = ids('g1b');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
    await lockFor(row.a, row.s2);
    expect(await legacyCancel(row.a, row.s1, T1)).toEqual({ outcome: 'cancelled' });
    expect((await spotData(row.s1)).status).toBe('available');
    expect((await lockData(row.a)).spotId).toBe(row.s2);
  });

  it('COMPAT T2R-G1-3: an explicit claimGenerationId null is generationless; an expired Ping is cleared but not reopened', async () => {
    const row = ids('g1c');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a, { claimGenerationId: null }));
    await db.collection('spots').doc(row.s2).set(legacyClaimed(row.finder, row.a, { expiresAt: Timestamp.fromMillis(FIXED - 1) }));
    expect(await legacyCancel(row.a, row.s1, T1)).toEqual({ outcome: 'cancelled' });
    expect((await spotData(row.s1)).status).toBe('available');
    expect(await legacyCancel(row.a, row.s2, T1)).toEqual({ outcome: 'cancelled' });
    const expired = await spotData(row.s2);
    expect(expired.status).toBe('interested');
    expect(expired.interestedUserId).toBeNull();
  });
});

// ─── case 3: missing, malformed and fabricated ─────────────────────────────
describe('T2 legacy recovery: missing, malformed and fabricated identities', () => {
  it('SECURITY T2R-S1: malformed legacy payloads and a missing generation are invalid-argument with no write', async () => {
    const row = ids('s1');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
    await lockFor(row.a, row.s1);
    const before = await spotData(row.s1);
    const badFingerprints = [
      null, undefined, {}, { seconds: T1.seconds }, { nanoseconds: T1.nanoseconds },
      { seconds: T1.seconds, nanoseconds: T1.nanoseconds, extra: 1 },
      { seconds: String(T1.seconds), nanoseconds: T1.nanoseconds },
      { seconds: T1.seconds + 0.5, nanoseconds: T1.nanoseconds },
      { seconds: T1.seconds, nanoseconds: -1 }, { seconds: T1.seconds, nanoseconds: 1_000_000_000 },
      { seconds: T1.seconds, nanoseconds: 1.5 }, [T1.seconds, T1.nanoseconds], T1.toMillis(), 'T1',
      { _seconds: T1.seconds, _nanoseconds: T1.nanoseconds },
    ];
    for (const bad of badFingerprints) {
      await expect(legacyCancel(row.a, row.s1, bad)).rejects.toMatchObject({ code: 'invalid-argument' });
    }
    // Both identities at once, and the generation shape with the id missing.
    await expect(cancelClaim({ auth: { uid: row.a }, data: { spotId: row.s1, claimGenerationId: G1, legacyClaimStartedAt: fp(T1), reason: 'traffic' } }, deps()))
      .rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(cancelClaim({ auth: { uid: row.a }, data: { spotId: row.s1, reason: 'traffic' } }, deps()))
      .rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(cancelClaim({ auth: { uid: row.a }, data: { spotId: row.s1, legacyClaimStartedAt: fp(T1), reason: 'nope' } }, deps()))
      .rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(cancelClaim({ auth: { uid: row.a }, data: { spotId: 'a/b', legacyClaimStartedAt: fp(T1), reason: 'traffic' } }, deps()))
      .rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(cancelClaim({ auth: null, data: { spotId: row.s1, legacyClaimStartedAt: fp(T1), reason: 'traffic' } }, deps()))
      .rejects.toMatchObject({ code: 'unauthenticated' });
    // Finder: legacy key only with a claimant and a null generation.
    await expect(finderLegacy(row.finder, row.s1, row.a, T1, { claimGenerationId: G1 })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(finderLegacy(row.finder, row.s1, null, T1)).rejects.toMatchObject({ code: 'invalid-argument' });
    for (const bad of [null, {}, { seconds: T1.seconds }, T1.toMillis()]) {
      await expect(finderLegacy(row.finder, row.s1, row.a, bad)).rejects.toMatchObject({ code: 'invalid-argument' });
    }
    expect(await spotData(row.s1)).toEqual(before);
    expect(await lockData(row.a)).not.toBeNull();
    expect(await notices(row.s1)).toHaveLength(0);
  });

  it('SECURITY T2R-S2: a fabricated claimStartedAt (1 ns, 1 µs or 1 s off) does not release; no write, no notice', async () => {
    const row = ids('s2');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
    await lockFor(row.a, row.s1);
    const before = await spotData(row.s1);
    for (const wrong of [
      { seconds: T1.seconds, nanoseconds: T1.nanoseconds + 1 },
      { seconds: T1.seconds, nanoseconds: T1.nanoseconds + 1000 },
      { seconds: T1.seconds - 1, nanoseconds: T1.nanoseconds },
      { seconds: T1.seconds, nanoseconds: 0 },
    ]) {
      expect(await legacyCancel(row.a, row.s1, wrong)).toEqual({ outcome: 'stale_claim' });
      expect(await finderLegacy(row.finder, row.s1, row.a, wrong)).toEqual({ outcome: 'stale' });
    }
    // A fabricated generation on the generation shape is still stale_claim.
    expect(await cancelClaim({ auth: { uid: row.a }, data: { spotId: row.s1, claimGenerationId: 'ee'.repeat(32), reason: 'traffic' } }, deps()))
      .toEqual({ outcome: 'stale_claim' });
    expect(await spotData(row.s1)).toEqual(before);
    expect(await lockData(row.a)).not.toBeNull();
    expect(await notices(row.s1)).toHaveLength(0);
  });

  it('SECURITY T2R-S3: a malformed stored generation is never treated as legacy (claimant stale_claim, finder unproven_identity)', async () => {
    const row = ids('s3');
    await seedUsers(row);
    for (const stored of ['not-a-generation', '', 7, false, { g: 1 }]) {
      const spotId = `${row.s1}_${String(typeof stored)}_${String(stored).length}`;
      await db.collection('spots').doc(spotId).set(legacyClaimed(row.finder, row.a, { claimGenerationId: stored }));
      const before = await spotData(spotId);
      expect(await legacyCancel(row.a, spotId, T1)).toEqual({ outcome: 'stale_claim' });
      expect(await finderLegacy(row.finder, spotId, row.a, T1)).toEqual({ outcome: 'unproven_identity' });
      expect(await spotData(spotId)).toEqual(before);
      expect(await notices(spotId)).toHaveLength(0);
    }
  });

  it('SECURITY T2R-S6: a legacy claim without a usable claimStartedAt fails closed for both paths', async () => {
    const row = ids('s6');
    await seedUsers(row);
    const missing = legacyClaimed(row.finder, row.a);
    delete missing.claimStartedAt;
    await db.collection('spots').doc(row.s1).set(missing);
    await db.collection('spots').doc(row.s2).set(legacyClaimed(row.finder, row.a, { claimStartedAt: T1.toMillis() }));
    for (const spotId of [row.s1, row.s2]) {
      const before = await spotData(spotId);
      expect(await legacyCancel(row.a, spotId, T1)).toEqual({ outcome: 'stale_claim' });
      expect(await finderLegacy(row.finder, spotId, row.a, T1)).toEqual({ outcome: 'unproven_identity' });
      expect(await spotData(spotId)).toEqual(before);
    }
  });

  it('SECURITY T2R-S7: a lock naming the Ping with a generation or another claimStartedAt is conflicting state (no write)', async () => {
    const row = ids('s7');
    await seedUsers(row);
    for (const [label, lockExtra] of [['gen', { claimGenerationId: G1 }], ['ts', { claimStartedAt: T2 }]]) {
      const spotId = `${row.s1}_${label}`;
      await db.collection('spots').doc(spotId).set(legacyClaimed(row.finder, row.a));
      await lockFor(row.a, spotId, lockExtra);
      const before = await spotData(spotId);
      expect(await legacyCancel(row.a, spotId, T1)).toEqual({ outcome: 'stale_claim' });
      expect(await finderLegacy(row.finder, spotId, row.a, T1)).toEqual({ outcome: 'unproven_identity' });
      expect(await spotData(spotId)).toEqual(before);
      expect((await lockData(row.a)).spotId).toBe(spotId);
      expect(await notices(spotId)).toHaveLength(0);
    }
  });
});

// ─── case 4/5/6/7: newer generation, same-user replacement, takeover ───────
describe('T2 legacy recovery: generations, replacements and takeover', () => {
  it('SECURITY T2R-S4: a valid stored generation is never released by the legacy shape, even with the exact claimStartedAt', async () => {
    const row = ids('s4');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a, { claimGenerationId: G2 }));
    await lockFor(row.a, row.s1, { claimGenerationId: G2 });
    const before = await spotData(row.s1);
    expect(await legacyCancel(row.a, row.s1, T1)).toEqual({ outcome: 'stale_claim' });
    expect(await finderLegacy(row.finder, row.s1, row.a, T1)).toEqual({ outcome: 'stale' });
    expect(await spotData(row.s1)).toEqual(before);
    expect(await notices(row.s1)).toHaveLength(0);
    // The generation path still owns it.
    expect(await cancelClaim({ auth: { uid: row.a }, data: { spotId: row.s1, claimGenerationId: G2, reason: 'traffic' } }, deps()))
      .toEqual({ outcome: 'cancelled' });
    expect((await spotData(row.s1)).claimGenerationId).toBeNull();
    // Lockless variant: the stored generation alone must refuse the legacy shape
    // (no reliance on the lock-conflict check as a second barrier).
    const lockless = `${row.s1}_lockless`;
    await db.collection('spots').doc(lockless).set(legacyClaimed(row.finder, row.a, { claimGenerationId: G2 }));
    const locklessBefore = await spotData(lockless);
    expect(await legacyCancel(row.a, lockless, T1)).toEqual({ outcome: 'stale_claim' });
    expect(await finderLegacy(row.finder, lockless, row.a, T1)).toEqual({ outcome: 'stale' });
    expect(await spotData(lockless)).toEqual(locklessBefore);
    expect(await notices(lockless)).toHaveLength(0);
  });

  it('SECURITY T2R-S5: another user cannot release or finder-cancel someone else\'s legacy claim', async () => {
    const row = ids('s5');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
    await lockFor(row.a, row.s1);
    const before = await spotData(row.s1);
    expect(await legacyCancel(row.b, row.s1, T1)).toEqual({ outcome: 'already_resolved' });
    expect(await legacyCancel(row.finder, row.s1, T1)).toEqual({ outcome: 'already_resolved' });
    expect(await finderLegacy(row.b, row.s1, row.a, T1)).toEqual({ outcome: 'not_owner' });
    expect(await finderLegacy(row.a, row.s1, row.a, T1)).toEqual({ outcome: 'not_owner' });
    // The finder must name the actual claimant, state and status.
    expect(await finderLegacy(row.finder, row.s1, row.b, T1)).toEqual({ outcome: 'stale' });
    expect(await finderLegacy(row.finder, row.s1, row.a, T1, { claimState: 'committed' })).toEqual({ outcome: 'stale' });
    expect(await finderLegacy(row.finder, row.s1, row.a, T1, { status: 'available' })).toEqual({ outcome: 'unproven_identity' });
    // Takeover through the claim callables is still refused.
    expect((await claimThroughCallables(row.b, row.s1, row.attempt, { recoverLeftoverGeneration: true })).outcome).toBe('prepare:unavailable');
    expect(await spotData(row.s1)).toEqual(before);
    expect(await lockData(row.a)).not.toBeNull();
    expect(await notices(row.s1)).toHaveLength(0);
  });

  it('SECURITY T2R-R1: same-user replacement (legacy T1 → legacy T2): a stale T1 retry cannot release T2; the finder needs T2', async () => {
    const row = ids('r1');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
    expect(await legacyCancel(row.a, row.s1, T1)).toEqual({ outcome: 'cancelled' });
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a, { claimStartedAt: T2 }));
    await lockFor(row.a, row.s1, { claimStartedAt: T2 });
    expect(await legacyCancel(row.a, row.s1, T1)).toEqual({ outcome: 'stale_claim' });
    expect(await finderLegacy(row.finder, row.s1, row.a, T1)).toEqual({ outcome: 'stale' });
    const live = await spotData(row.s1);
    expect(live.interestedUserId).toBe(row.a);
    expect(live.claimStartedAt.isEqual(T2)).toBe(true);
    expect(await notices(row.s1)).toHaveLength(1);
    expect(await finderLegacy(row.finder, row.s1, row.a, T2)).toEqual({ outcome: 'deleted' });
    expect(await spotData(row.s1)).toBeNull();
    expect(await lockData(row.a)).toBeNull();
  });

  it('SECURITY T2R-R2: same-user replacement (legacy → callable G): the legacy shape never falls back on the new generation', async () => {
    const row = ids('r2');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
    expect(await legacyCancel(row.a, row.s1, T1)).toEqual({ outcome: 'cancelled' });
    const claimed = await claimThroughCallables(row.a, row.s1, row.attempt);
    expect(claimed.outcome).toBe('claimed');
    const spot = await spotData(row.s1);
    // Even an exact echo of the callable claim's claimStartedAt is refused.
    expect(await legacyCancel(row.a, row.s1, spot.claimStartedAt)).toEqual({ outcome: 'stale_claim' });
    expect(await legacyCancel(row.a, row.s1, T1)).toEqual({ outcome: 'stale_claim' });
    expect(await finderLegacy(row.finder, row.s1, row.a, spot.claimStartedAt)).toEqual({ outcome: 'stale' });
    expect((await spotData(row.s1)).claimGenerationId).toBe(claimed.claimGenerationId);
    expect((await lockData(row.a)).claimGenerationId).toBe(claimed.claimGenerationId);
  });

  it('SECURITY T2R-R3: after release, another user\'s replacement claim is never cancelled by a stale legacy retry or finder confirmation', async () => {
    const row = ids('r3');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
    expect(await legacyCancel(row.a, row.s1, T1)).toEqual({ outcome: 'cancelled' });
    const claimed = await claimThroughCallables(row.b, row.s1, row.attempt);
    expect(claimed.outcome).toBe('claimed');
    expect(await legacyCancel(row.a, row.s1, T1)).toEqual({ outcome: 'already_resolved' });
    expect(await finderLegacy(row.finder, row.s1, row.a, T1)).toEqual({ outcome: 'stale' });
    const spot = await spotData(row.s1);
    expect(spot.interestedUserId).toBe(row.b);
    expect(spot.claimGenerationId).toBe(claimed.claimGenerationId);
    expect((await lockData(row.b)).spotId).toBe(row.s1);
    expect(await notices(row.s1)).toHaveLength(1);
  });

  it('SECURITY T2R-R4: an old-client release that strands the generation (t674u T1-C4) is not a legacy claim and is not releasable twice', async () => {
    const row = ids('r4');
    await seedUsers(row);
    // Stranded: available, no claimant, leftover G1 (the old client cancelled a callable claim).
    await db.collection('spots').doc(row.s1).set(available(row.finder, { claimGenerationId: G1 }));
    expect(await legacyCancel(row.a, row.s1, T1)).toEqual({ outcome: 'already_resolved' });
    expect(await cancelClaim({ auth: { uid: row.a }, data: { spotId: row.s1, claimGenerationId: G1, reason: 'traffic' } }, deps()))
      .toEqual({ outcome: 'already_resolved' });
    expect((await spotData(row.s1)).claimGenerationId).toBe(G1);
    expect(await notices(row.s1)).toHaveLength(0);
  });
});

// ─── T2-G2: finder legacy cancellation, trust and notices ──────────────────
describe('T2-G2 finder cancellation of a generationless legacy claim', () => {
  it('SECURITY T2R-G2-1: the finder deletes the Ping once; legacy receipt; claimant lock cleared; one claimant notice; retry is a no-op', async () => {
    const row = ids('g2a');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
    await lockFor(row.a, row.s1);
    expect(await finderLegacy(row.finder, row.s1, row.a, T1)).toEqual({ outcome: 'deleted' });
    expect(await spotData(row.s1)).toBeNull();
    expect(await lockData(row.a)).toBeNull();
    const receipt = await db.collection('finderCancelReceipts').doc(`${row.s1}_${token(row.a, T1)}`).get();
    expect(receipt.data()).toEqual({
      spotId: row.s1,
      finderId: row.finder,
      status: 'interested',
      interestedUserId: row.a,
      claimState: 'heading',
      claimGenerationId: null,
      claimStartedAtSeconds: T1.seconds,
      claimStartedAtNanos: T1.nanoseconds,
      kind: 'legacy',
    });
    const notes = await notices(row.s1);
    expect(notes.map((n) => n.id)).toEqual([`finder_cancelled_${row.s1}_${token(row.a, T1)}`]);
    expect(notes[0]).toMatchObject({ type: 'cancelled', senderId: row.finder, targetUserId: row.a });
    expect(await finderLegacy(row.finder, row.s1, row.a, T1)).toEqual({ outcome: 'already_deleted' });
    expect(await notices(row.s1)).toHaveLength(1);
  });

  it('SECURITY T2R-G2-2: head delete trigger penalizes the finder exactly once from the legacy receipt and writes no second notice; no receipt → no penalty', async () => {
    const row = ids('g2b');
    await seedUsers(row);
    const data = legacyClaimed(row.finder, row.a);
    await db.collection('spots').doc(row.s1).set(data);
    await lockFor(row.a, row.s1);
    const snapshot = await spotData(row.s1);
    expect(await finderLegacy(row.finder, row.s1, row.a, T1)).toEqual({ outcome: 'deleted' });
    const event = deletedEvent(row.s1, snapshot, `t682u_evt_${row.s1}`);
    await indexModule.updateTrustOnSpotDelete.run(event);
    await indexModule.updateTrustOnSpotDelete.run(event);
    await indexModule.updateTrustOnSpotDelete.run(deletedEvent(row.s1, snapshot, `t682u_evt2_${row.s1}`));
    expect((await trustOf(row.finder)).handoffsCancelledByFinder).toBe(1);
    const processed = await db.collection('users').doc(row.finder).collection('processedTrustEvents')
      .doc(`${row.s1}:finder-cancel:${token(row.a, T1)}`).get();
    expect(processed.exists).toBe(true);
    expect(await notices(row.s1)).toHaveLength(1);
    expect(await trustOf(row.a)).toBeNull();

    // Characterization: an old-client direct delete (no receipt) of a legacy claim.
    const other = legacyClaimed(row.finder, row.b, { claimStartedAt: T2 });
    await db.collection('spots').doc(row.s2).set(other);
    const otherSnap = await spotData(row.s2);
    await db.collection('spots').doc(row.s2).delete();
    await indexModule.updateTrustOnSpotDelete.run(deletedEvent(row.s2, otherSnap, `t682u_evt_${row.s2}`));
    expect((await trustOf(row.finder)).handoffsCancelledByFinder).toBe(1);
    expect(await notices(row.s2)).toHaveLength(0);
  });

  it('SECURITY T2R-G2-3: a receipt for another claim cycle or claimant does not attribute a penalty', async () => {
    const row = ids('g2c');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
    expect(await finderLegacy(row.finder, row.s1, row.a, T1)).toEqual({ outcome: 'deleted' });
    for (const [label, snap] of [
      ['T2', legacyClaimed(row.finder, row.a, { claimStartedAt: T2 })],
      ['B', legacyClaimed(row.finder, row.b)],
      ['gen', legacyClaimed(row.finder, row.a, { claimGenerationId: G1 })],
      ['committed', legacyClaimed(row.finder, row.a, { claimState: 'committed' })],
    ]) {
      await indexModule.updateTrustOnSpotDelete.run(deletedEvent(row.s1, snap, `t682u_mis_${label}_${row.s1}`));
    }
    expect(await trustOf(row.finder)).toBeNull();
  });

  it('COMPAT T2R-G2-4: an expired legacy Ping is deleted with no notice; non-live legacy states are unproven', async () => {
    const row = ids('g2d');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a, { expiresAt: Timestamp.fromMillis(FIXED - 1) }));
    expect(await finderLegacy(row.finder, row.s1, row.a, T1)).toEqual({ outcome: 'deleted' });
    expect(await notices(row.s1)).toHaveLength(0);
    await db.collection('spots').doc(row.s2).set(legacyClaimed(row.finder, row.a, { claimState: 'arrived_pending_outcome' }));
    expect(await finderLegacy(row.finder, row.s2, row.a, T1, { claimState: 'arrived_pending_outcome' })).toEqual({ outcome: 'unproven_identity' });
    expect(await spotData(row.s2)).not.toBeNull();
  });

  it('CHARACTERIZATION T2R-G2-5: the confirmation without the legacy key keeps the t674u contract (unproven_identity)', async () => {
    const row = ids('g2e');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
    expect(await finderCancelSpot({
      auth: { uid: row.finder },
      data: { spotId: row.s1, status: 'interested', interestedUserId: row.a, claimState: 'heading', claimGenerationId: null },
    }, deps())).toEqual({ outcome: 'unproven_identity' });
    expect(await spotData(row.s1)).not.toBeNull();
  });
});

// ─── T2-G3: leftover generation recovery in claimSpot ──────────────────────
describe('T2-G3 recovery of an available Ping with a leftover claimGenerationId', () => {
  it('SECURITY T2R-G3-1: with the opt-in, a new claimant gets a fresh generation; the stale G1 holder cannot cancel or revoke it', async () => {
    const row = ids('g3a');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(available(row.finder));
    // A claims through callables (G minted), then an old client strands it.
    const first = await claimThroughCallables(row.a, row.s1, row.attempt);
    expect(first.outcome).toBe('claimed');
    const leftover = first.claimGenerationId;
    await db.collection('spots').doc(row.s1).set(available(row.finder, { claimGenerationId: leftover }));
    await lockRef(row.a).delete();
    const recovered = await claimThroughCallables(row.b, row.s1, row.attempt2, { recoverLeftoverGeneration: true });
    expect(recovered.outcome).toBe('claimed');
    expect(recovered.claimGenerationId).not.toBe(leftover);
    const spot = await spotData(row.s1);
    expect(spot.interestedUserId).toBe(row.b);
    expect(spot.claimGenerationId).toBe(recovered.claimGenerationId);
    expect((await lockData(row.b)).claimGenerationId).toBe(recovered.claimGenerationId);
    expect(await cancelClaim({ auth: { uid: row.a }, data: { spotId: row.s1, claimGenerationId: leftover, reason: 'traffic' } }, deps()))
      .toEqual({ outcome: 'already_resolved' });
    expect((await revokeClaimIntent(claimReq(row.a, row.s1, row.attempt), deps())).outcome).toBe('generation_unchanged');
    expect(await legacyCancel(row.a, row.s1, T1)).toEqual({ outcome: 'already_resolved' });
    const after = await spotData(row.s1);
    expect(after.interestedUserId).toBe(row.b);
    expect(after.claimGenerationId).toBe(recovered.claimGenerationId);
    expect(await notices(row.s1)).toHaveLength(0);
  });

  it('SECURITY T2R-G3-2: without the opt-in claimSpot still refuses (refused_stale_generation, leftover kept)', async () => {
    const row = ids('g3b');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(available(row.finder, { claimGenerationId: G1 }));
    expect((await claimThroughCallables(row.b, row.s1, row.attempt)).outcome).toBe('refused_stale_generation');
    expect((await spotData(row.s1)).claimGenerationId).toBe(G1);
    expect(await lockData(row.b)).toBeNull();
  });

  it('SECURITY T2R-G3-3: a lock anywhere that names the Ping blocks recovery (fail closed); leftover and lock kept', async () => {
    const row = ids('g3c');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(available(row.finder, { claimGenerationId: G1 }));
    await lockFor(row.a, row.s1, { claimGenerationId: G1 });
    expect((await claimThroughCallables(row.b, row.s1, row.attempt, { recoverLeftoverGeneration: true })).outcome).toBe('refused_stale_generation');
    expect((await spotData(row.s1)).claimGenerationId).toBe(G1);
    expect((await lockData(row.a)).spotId).toBe(row.s1);
    expect(await lockData(row.b)).toBeNull();
  });

  it('SECURITY T2R-G3-4: leftover with residual claim state, or on an unavailable Ping, is not recoverable', async () => {
    const row = ids('g3d');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(available(row.finder, { claimGenerationId: G1, claimState: 'heading' }));
    expect((await claimThroughCallables(row.b, row.s1, row.attempt, { recoverLeftoverGeneration: true })).outcome).toBe('refused_stale_generation');
    await db.collection('spots').doc(row.s2).set(available(row.finder, { claimGenerationId: G1, status: 'occupied' }));
    expect((await claimThroughCallables(row.b, row.s2, row.attempt2, { recoverLeftoverGeneration: true })).outcome).toBe('prepare:unavailable');
    expect((await spotData(row.s1)).claimGenerationId).toBe(G1);
    expect((await spotData(row.s2)).claimGenerationId).toBe(G1);
  });

  it('SECURITY T2R-G3-5: the opt-in accepts only true; a malformed leftover is replaced by a fresh valid generation', async () => {
    const row = ids('g3e');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(available(row.finder, { claimGenerationId: 'junk' }));
    for (const bad of [false, 'true', 1, null]) {
      await expect(prepareClaimIntent(claimReq(row.b, row.s1, row.attempt, { recoverLeftoverGeneration: bad }), deps()))
        .rejects.toMatchObject({ code: 'invalid-argument' });
      await expect(claimSpot(claimReq(row.b, row.s1, row.attempt, { recoverLeftoverGeneration: bad }), deps()))
        .rejects.toMatchObject({ code: 'invalid-argument' });
    }
    const recovered = await claimThroughCallables(row.b, row.s1, row.attempt, { recoverLeftoverGeneration: true });
    expect(recovered.outcome).toBe('claimed');
    expect(recovered.claimGenerationId).toMatch(/^[0-9a-f]{64}$/);
    expect((await spotData(row.s1)).claimGenerationId).toBe(recovered.claimGenerationId);
  });

  it('SECURITY T2R-G3-6: two competing recoveries: exactly one claims; the loser holds no lock', async () => {
    const row = ids('g3f');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(available(row.finder, { claimGenerationId: G1 }));
    const opt = { recoverLeftoverGeneration: true };
    expect((await prepareClaimIntent(claimReq(row.b, row.s1, row.attempt, opt), deps())).state).toBe('prepared');
    expect((await prepareClaimIntent(claimReq(row.c, row.s1, row.attempt2, opt), deps())).state).toBe('prepared');
    const results = await Promise.all([
      claimSpot(claimReq(row.b, row.s1, row.attempt, opt), deps()),
      claimSpot(claimReq(row.c, row.s1, row.attempt2, opt), deps()),
    ]);
    const outcomes = results.map((r) => r.outcome).sort();
    expect(outcomes.filter((o) => o === 'claimed')).toHaveLength(1);
    expect(['stale_precondition', 'unavailable']).toContain(outcomes.find((o) => o !== 'claimed'));
    const winner = results[0].outcome === 'claimed' ? row.b : row.c;
    const loser = winner === row.b ? row.c : row.b;
    const spot = await spotData(row.s1);
    expect(spot.interestedUserId).toBe(winner);
    expect(spot.claimGenerationId).not.toBe(G1);
    expect(await lockData(loser)).toBeNull();
    console.log(JSON.stringify({ t682u: 'T2R-G3-6', outcomes }));
  });
});

// ─── case 8: concurrency ───────────────────────────────────────────────────
describe('T2 legacy recovery: concurrent release, reclaim and cancellation', () => {
  it('SECURITY T2R-C1: two concurrent claimant releases: one cancelled, one already_resolved, one notice', async () => {
    const row = ids('c1');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
    await lockFor(row.a, row.s1);
    const results = await Promise.all([legacyCancel(row.a, row.s1, T1), legacyCancel(row.a, row.s1, T1)]);
    const outcomes = results.map((r) => r.outcome).sort();
    console.log(JSON.stringify({ t682u: 'T2R-C1', outcomes }));
    expect(outcomes[0]).toBe('already_resolved');
    expect(outcomes[1]).toBe('cancelled');
    expect(await notices(row.s1)).toHaveLength(1);
    expect(await lockData(row.a)).toBeNull();
  });

  it('SECURITY T2R-C2: concurrent claimant release and finder cancellation: exactly one takes effect; one notice; lock cleared', async () => {
    const outcomesSeen = [];
    for (let i = 0; i < 4; i += 1) {
      const row = ids(`c2_${i}`);
      await seedUsers(row);
      await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
      await lockFor(row.a, row.s1);
      const [claimant, finder] = await Promise.all([
        legacyCancel(row.a, row.s1, T1),
        finderLegacy(row.finder, row.s1, row.a, T1),
      ]);
      outcomesSeen.push(`${claimant.outcome}/${finder.outcome}`);
      const spot = await spotData(row.s1);
      if (claimant.outcome === 'cancelled') {
        expect(['stale', 'unproven_identity']).toContain(finder.outcome);
        expect(spot.status).toBe('available');
        expect(spot.interestedUserId).toBeNull();
      } else {
        expect(claimant.outcome).toBe('already_resolved');
        expect(finder.outcome).toBe('deleted');
        expect(spot).toBeNull();
      }
      expect(await notices(row.s1)).toHaveLength(1);
      expect(await lockData(row.a)).toBeNull();
    }
    console.log(JSON.stringify({ t682u: 'T2R-C2', outcomesSeen }));
  });

  it('SECURITY T2R-C3: a stale legacy retry racing a new claimant never releases the new claim', async () => {
    const row = ids('c3');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
    expect(await legacyCancel(row.a, row.s1, T1)).toEqual({ outcome: 'cancelled' });
    expect((await prepareClaimIntent(claimReq(row.b, row.s1, row.attempt), deps())).state).toBe('prepared');
    const [retry, claim] = await Promise.all([
      legacyCancel(row.a, row.s1, T1),
      claimSpot(claimReq(row.b, row.s1, row.attempt), deps()),
    ]);
    expect(retry.outcome).toBe('already_resolved');
    expect(claim.outcome).toBe('claimed');
    const spot = await spotData(row.s1);
    expect(spot.interestedUserId).toBe(row.b);
    expect(spot.claimGenerationId).toBe(claim.claimGenerationId);
    expect(await notices(row.s1)).toHaveLength(1);
  });
});

// ─── case 9: deletion fence and suspension boundaries ──────────────────────
describe('T2 legacy recovery: deletion fence and suspension', () => {
  async function fence(uid) {
    await db.collection('accountLifecycle').doc(uid).set({ state: 'deleting', startedAt: Timestamp.fromMillis(FIXED) });
  }

  it('SECURITY T2R-F1: a deletion-fenced claimant or finder is denied with no write', async () => {
    const row = ids('f1');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
    await db.collection('spots').doc(row.s2).set(available(row.finder, { claimGenerationId: G1 }));
    await lockFor(row.a, row.s1);
    await fence(row.a);
    await fence(row.finder);
    const before = await spotData(row.s1);
    await expect(legacyCancel(row.a, row.s1, T1)).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(finderLegacy(row.finder, row.s1, row.a, T1)).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(prepareClaimIntent(claimReq(row.a, row.s2, row.attempt, { recoverLeftoverGeneration: true }), deps()))
      .rejects.toMatchObject({ code: 'permission-denied' });
    expect(await spotData(row.s1)).toEqual(before);
    expect((await spotData(row.s2)).claimGenerationId).toBe(G1);
    expect(await notices(row.s1)).toHaveLength(0);
    expect(await lockData(row.a)).not.toBeNull();
  });

  it('SECURITY T2R-F2: a fence committed after the pre-check is caught by the in-transaction lifecycle read (claimant, finder, recovery claim)', async () => {
    const row = ids('f2');
    await seedUsers(row);
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
    await lockFor(row.a, row.s1);
    await db.collection('spots').doc(row.s2).set(available(row.finder, { claimGenerationId: G1 }));
    const before = await spotData(row.s1);
    const hookFor = (uid) => deps({ allowTestHooks: true, afterReads: async () => { await fence(uid); } });
    await expect(cancelClaim({ auth: { uid: row.a }, data: { spotId: row.s1, legacyClaimStartedAt: fp(T1), reason: 'traffic' } }, hookFor(row.a)))
      .rejects.toMatchObject({ code: 'permission-denied' });
    await expect(finderLegacy(row.finder, row.s1, row.a, T1, {}, hookFor(row.finder)))
      .rejects.toMatchObject({ code: 'permission-denied' });
    expect((await prepareClaimIntent(claimReq(row.b, row.s2, row.attempt, { recoverLeftoverGeneration: true }), deps())).state).toBe('prepared');
    await expect(claimSpot(claimReq(row.b, row.s2, row.attempt, { recoverLeftoverGeneration: true }), hookFor(row.b)))
      .rejects.toMatchObject({ code: 'permission-denied' });
    expect(await spotData(row.s1)).toEqual(before);
    expect(await lockData(row.a)).not.toBeNull();
    expect(await notices(row.s1)).toHaveLength(0);
    expect((await spotData(row.s2)).claimGenerationId).toBe(G1);
    expect(await lockData(row.b)).toBeNull();
  });

  for (const [label, patch] of [['Suspended', { status: 'Suspended' }], ['productAccessBlocked', { productAccessBlocked: true }]]) {
    it(`SECURITY T2R-F3-${label}: a restricted claimant, finder or recovering claimant is denied with no write (suspension behavior unchanged)`, async () => {
      const row = ids(`f3${label}`);
      await seedUsers(row, { a: patch, finder: patch, b: patch });
      await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
      await lockFor(row.a, row.s1);
      await db.collection('spots').doc(row.s2).set(available(row.c, { claimGenerationId: G1 }));
      const before = await spotData(row.s1);
      await expect(legacyCancel(row.a, row.s1, T1)).rejects.toMatchObject({ code: 'permission-denied' });
      await expect(finderLegacy(row.finder, row.s1, row.a, T1)).rejects.toMatchObject({ code: 'permission-denied' });
      await expect(claimThroughCallables(row.b, row.s2, row.attempt, { recoverLeftoverGeneration: true }))
        .rejects.toMatchObject({ code: 'permission-denied' });
      expect(await spotData(row.s1)).toEqual(before);
      expect(await lockData(row.a)).not.toBeNull();
      expect(await notices(row.s1)).toHaveLength(0);
      expect((await spotData(row.s2)).claimGenerationId).toBe(G1);
    });
  }

  it('CHARACTERIZATION T2R-F4: a restricted counterpart does not block the Active party (same as the generation paths)', async () => {
    const row = ids('f4');
    await seedUsers(row, { a: { status: 'Suspended' } });
    await db.collection('spots').doc(row.s1).set(legacyClaimed(row.finder, row.a));
    expect(await finderLegacy(row.finder, row.s1, row.a, T1)).toEqual({ outcome: 'deleted' });
    const row2 = ids('f4b');
    await seedUsers(row2, { finder: { status: 'Suspended' } });
    await db.collection('spots').doc(row2.s1).set(legacyClaimed(row2.finder, row2.a));
    expect(await legacyCancel(row2.a, row2.s1, T1)).toEqual({ outcome: 'cancelled' });
  });
});
