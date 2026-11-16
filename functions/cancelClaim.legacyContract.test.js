'use strict';

// 29G cancellation contract: behavior assertions (t683u).
//
// Founder-approved amendment (t683u, Nov 12 2026). The 29G contract made
// cancelClaim generation-only and pinned that with a source-text check in
// orphanGenerationCleanup.test.js: cancelClaim.js must not contain the word
// "fingerprint". The founder approved a narrowly scoped legacy-only exception:
// a generationless claim (stored claimGenerationId null or absent) may be
// released when the transaction proves ownership (interestedUserId == caller)
// and the exact claim cycle (stored claimStartedAt, seconds and nanoseconds).
// That exception needs a claim-cycle fingerprint in cancelClaim.js, so the
// word check can no longer tell a legitimate legacy path from a regression.
// It is replaced by the behavior below, which is stronger: it fails if the
// generation path accepts anything but the stored generation, if any
// timestamp authorizes a generation-bearing claim, if the two identity modes
// can be combined, if a missing generation acts as a wildcard, or if the
// legacy path loses any of its own fail-closed checks. The generation path's
// rule "Timestamps are not compared" is unchanged.

const { cancelClaim, CLEAR_FIELDS } = require('./cancelClaim');
const { parseInput: parseFinderInput, finderCancelSpot } = require('./finderCancelSpot');
const {
  parseLegacyFingerprint,
  timestampFingerprint,
} = require('./legacyClaimIdentity');
const { Timestamp } = require('firebase-admin/firestore');

const UID = 'claimer-29g';
const OTHER_UID = 'other-29g';
const FINDER = 'finder-29g';
const SPOT = 'spot-29g';
const GEN = 'a1'.repeat(32);
const GEN2 = 'b2'.repeat(32);
const NOW_MS = 1_700_000_100_000;
// Stored values are real Firestore Timestamps (microsecond aligned, as the
// emulator and production keep them).
const T1 = new Timestamp(1_700_000_000, 123_456_000);
const T2 = new Timestamp(1_700_000_030, 654_321_000);
const fp = (ts) => ({ seconds: ts.seconds, nanoseconds: ts.nanoseconds });

function memoryDb(seed) {
  const docs = new Map(Object.entries(seed));
  const writes = [];
  function ref(path) {
    return {
      path,
      collection(name) { return { doc(id) { return ref(`${path}/${name}/${id}`); } }; },
      async get() { return snap(path); },
    };
  }
  function snap(path) {
    if (!docs.has(path)) return { exists: false, data: () => undefined };
    const data = docs.get(path);
    return { exists: true, data: () => ({ ...data }) };
  }
  return {
    docs,
    writes,
    doc(path) { return ref(path); },
    collection(name) { return { doc(id) { return ref(`${name}/${id}`); } }; },
    async runTransaction(fn) {
      const tx = {
        async get(target) { return snap(target.path); },
        update(target, patch) { writes.push(['update', target.path]); docs.set(target.path, { ...docs.get(target.path), ...patch }); },
        delete(target) { writes.push(['delete', target.path]); docs.delete(target.path); },
        set(target, data) { writes.push(['set', target.path]); docs.set(target.path, { ...data }); },
        create(target, data) {
          if (docs.has(target.path)) {
            const error = new Error('already exists');
            error.code = 6;
            throw error;
          }
          writes.push(['create', target.path]);
          docs.set(target.path, { ...data });
        },
      };
      return fn(tx);
    },
  };
}

// Firestore has no stored undefined: an undefined override means the field is absent.
function liveSpot(extra = {}) {
  const spot = {
    status: 'interested',
    finderId: FINDER,
    interestedUserId: UID,
    interestedUserName: 'ada',
    claimState: 'heading',
    claimStartedAt: T1,
    expiresAt: Timestamp.fromMillis(NOW_MS + 600_000),
    ...extra,
  };
  for (const key of Object.keys(spot)) if (spot[key] === undefined) delete spot[key];
  return spot;
}

const lockPath = (uid) => `users/${uid}/activeIncomingClaims/current`;

function world(spot, lock, extra = {}) {
  const seed = {
    [`users/${UID}`]: { status: 'Active', productAccessBlocked: false },
    [`users/${OTHER_UID}`]: { status: 'Active', productAccessBlocked: false },
    [`users/${FINDER}`]: { status: 'Active', productAccessBlocked: false },
    ...extra,
  };
  if (spot) seed[`spots/${SPOT}`] = spot;
  if (lock) seed[lockPath(spot && spot.interestedUserId ? spot.interestedUserId : UID)] = lock;
  return memoryDb(seed);
}

function run(db, data, uid = UID) {
  return cancelClaim({ auth: { uid }, data }, {
    db,
    now: () => Timestamp.fromMillis(NOW_MS),
    checkRateLimit: async () => {},
  });
}

const generationReq = (extra = {}) => ({ spotId: SPOT, claimGenerationId: GEN, reason: 'traffic', ...extra });
const legacyReq = (ts = T1, extra = {}) => ({ spotId: SPOT, legacyClaimStartedAt: fp(ts), reason: 'traffic', ...extra });

function snapshotOf(db) { return JSON.stringify([...db.docs.entries()]); }

async function expectNoWrite(db, promise, expected) {
  const before = snapshotOf(db);
  if (expected && expected.rejects) await expect(promise).rejects.toMatchObject({ code: expected.rejects });
  else await expect(promise).resolves.toEqual(expected);
  expect(db.writes).toEqual([]);
  expect(snapshotOf(db)).toBe(before);
}

describe('29G contract (t683u amendment): generation-only mode is unchanged', () => {
  it('29G-A1: the stored generation, and only it, releases a generation claim; no timestamp is consulted', async () => {
    for (const submitted of [GEN2, 'a1'.repeat(31) + 'a2']) {
      const db = world(liveSpot({ claimGenerationId: GEN }), { spotId: SPOT, claimGenerationId: GEN, claimStartedAt: T1 });
      await expectNoWrite(db, run(db, generationReq({ claimGenerationId: submitted })), { outcome: 'stale_claim' });
    }
    // claimStartedAt changes (or disappears) do not matter to the generation path.
    for (const claimStartedAt of [T1, T2, null, undefined, 1_700_000_000_000, '2023-11-14T22:13:20.123Z']) {
      const db = world(liveSpot({ claimGenerationId: GEN, claimStartedAt }), { spotId: SPOT, claimGenerationId: GEN });
      await expect(run(db, generationReq())).resolves.toEqual({ outcome: 'cancelled' });
      expect(db.docs.get(`spots/${SPOT}`).claimGenerationId).toBeNull();
      expect(db.docs.has(lockPath(UID))).toBe(false);
    }
  });

  it('29G-A2: a generation request never releases a generationless legacy claim', async () => {
    for (const stored of [undefined, null]) {
      const db = world(liveSpot({ claimGenerationId: stored }), { spotId: SPOT, claimStartedAt: T1 });
      await expectNoWrite(db, run(db, generationReq()), { outcome: 'stale_claim' });
    }
  });
});

describe('29G contract (t683u amendment): no timestamp authorizes a generation-bearing claim', () => {
  it('29G-B1: the legacy shape with the exact stored claimStartedAt is refused for every generation-bearing claim', async () => {
    const storedValues = [GEN, 'not-a-generation', '', 0, false, { g: 1 }, ['x']];
    for (const stored of storedValues) {
      for (const claimState of [undefined, null, 'committed', 'heading']) {
        for (const lock of [null, { spotId: SPOT, claimStartedAt: T1 }, { spotId: SPOT, claimStartedAt: T1, claimGenerationId: GEN }]) {
          const db = world(liveSpot({ claimGenerationId: stored, claimState }), lock);
          await expectNoWrite(db, run(db, legacyReq(T1)), { outcome: 'stale_claim' });
        }
      }
    }
  });

  it('29G-B2: timestamp-like values in the generation field are invalid, not compared', async () => {
    const db = world(liveSpot({ claimGenerationId: GEN }));
    for (const value of [fp(T1), T1, T1.toMillis(), String(T1.toMillis()), T1.toDate().toISOString(), { seconds: T1.seconds }]) {
      await expectNoWrite(db, run(db, generationReq({ claimGenerationId: value })), { rejects: 'invalid-argument' });
    }
  });
});

describe('29G contract (t683u amendment): the two identity modes are mutually exclusive', () => {
  it('29G-C1: cancelClaim rejects any request that carries both identities, or mixes their keys', async () => {
    const db = world(liveSpot({ claimGenerationId: null }), { spotId: SPOT, claimStartedAt: T1 });
    const mixed = [
      { spotId: SPOT, claimGenerationId: GEN, legacyClaimStartedAt: fp(T1), reason: 'traffic' },
      { spotId: SPOT, claimGenerationId: null, legacyClaimStartedAt: fp(T1), reason: 'traffic' },
      { spotId: SPOT, claimGenerationId: GEN, legacyClaimStartedAt: fp(T1) },
      { spotId: SPOT, claimGenerationId: null, legacyClaimStartedAt: fp(T1) },
      { spotId: SPOT, legacyClaimStartedAt: fp(T1), reason: 'traffic', claimStartedAt: fp(T1) },
      { spotId: SPOT, claimGenerationId: GEN, reason: 'traffic', claimStartedAt: fp(T1) },
      { spotId: SPOT, claimGenerationId: GEN, reason: 'traffic', fingerprint: T1.toMillis() },
    ];
    for (const data of mixed) await expectNoWrite(db, run(db, data), { rejects: 'invalid-argument' });
  });

  it('29G-C2: finderCancelSpot accepts the legacy key only with claimGenerationId null and a named claimant', () => {
    const base = { spotId: SPOT, status: 'interested', interestedUserId: UID, claimState: 'heading' };
    expect(() => parseFinderInput({ ...base, claimGenerationId: GEN, legacyClaimStartedAt: fp(T1) })).toThrow();
    expect(() => parseFinderInput({ ...base, interestedUserId: null, claimGenerationId: null, legacyClaimStartedAt: fp(T1) })).toThrow();
    expect(() => parseFinderInput({ ...base, claimGenerationId: null, legacyClaimStartedAt: T1.toMillis() })).toThrow();
    expect(() => parseFinderInput({ ...base, claimGenerationId: null, legacyClaimStartedAt: fp(T1), extra: 1 })).toThrow();
    expect(parseFinderInput({ ...base, claimGenerationId: null, legacyClaimStartedAt: fp(T1) }).legacyClaimStartedAt).toEqual(fp(T1));
    // Without the key the generation contract is unchanged (no legacyClaimStartedAt in the result).
    expect(parseFinderInput({ ...base, claimGenerationId: GEN })).not.toHaveProperty('legacyClaimStartedAt');
  });

  it('29G-C3: a finder legacy confirmation never deletes a generation-bearing claim', async () => {
    const db = world(liveSpot({ claimGenerationId: GEN }), { spotId: SPOT, claimStartedAt: T1, claimGenerationId: GEN });
    const data = { spotId: SPOT, status: 'interested', interestedUserId: UID, claimState: 'heading', claimGenerationId: null, legacyClaimStartedAt: fp(T1) };
    await expectNoWrite(db, finderCancelSpot({ auth: { uid: FINDER }, data }, {
      db, now: () => Timestamp.fromMillis(NOW_MS), checkRateLimit: async () => {},
    }), { outcome: 'stale' });
  });
});

describe('29G contract (t683u amendment): a missing generation is never a wildcard', () => {
  it('29G-D1: absent, null, empty or malformed identities are invalid-argument with no write', async () => {
    for (const stored of [GEN, null, undefined]) {
      const db = world(liveSpot({ claimGenerationId: stored }), { spotId: SPOT, claimStartedAt: T1 });
      const requests = [
        { spotId: SPOT, reason: 'traffic' },
        generationReq({ claimGenerationId: null }),
        generationReq({ claimGenerationId: undefined }),
        generationReq({ claimGenerationId: '' }),
        legacyReq(T1, { legacyClaimStartedAt: null }),
        legacyReq(T1, { legacyClaimStartedAt: undefined }),
        legacyReq(T1, { legacyClaimStartedAt: {} }),
        legacyReq(T1, { legacyClaimStartedAt: { seconds: T1.seconds } }),
      ];
      for (const data of requests) await expectNoWrite(db, run(db, data), { rejects: 'invalid-argument' });
    }
  });
});

describe('29G contract (t683u amendment): stale retries and other users', () => {
  it('29G-E1: a stale legacy retry cannot release the same user\'s replacement claim', async () => {
    const replacements = [
      liveSpot({ claimStartedAt: T2 }),
      liveSpot({ claimStartedAt: T2, claimGenerationId: GEN }),
      liveSpot({ claimStartedAt: T1, claimGenerationId: GEN }),
      // 1 microsecond later than T1: still another cycle.
      liveSpot({ claimStartedAt: new Timestamp(T1.seconds, T1.nanoseconds + 1_000) }),
    ];
    for (const spot of replacements) {
      const db = world(spot, { spotId: SPOT, claimStartedAt: spot.claimStartedAt });
      await expectNoWrite(db, run(db, legacyReq(T1)), { outcome: 'stale_claim' });
    }
  });

  it('29G-E2: precision loss in the echo does not match (millisecond or second truncation)', async () => {
    const stored = new Timestamp(1_700_000_000, 123_456_000);
    const db = world(liveSpot({ claimStartedAt: stored }), { spotId: SPOT, claimStartedAt: stored });
    for (const echo of [{ seconds: stored.seconds, nanoseconds: 123_000_000 }, { seconds: stored.seconds, nanoseconds: 0 }, { seconds: stored.seconds + 1, nanoseconds: 123_456_000 }]) {
      await expectNoWrite(db, run(db, { spotId: SPOT, legacyClaimStartedAt: echo, reason: 'traffic' }), { outcome: 'stale_claim' });
    }
    await expect(run(db, { spotId: SPOT, legacyClaimStartedAt: fp(stored), reason: 'traffic' })).resolves.toEqual({ outcome: 'cancelled' });
  });

  it('29G-E3: another user cannot release a claim with its exact identity, in either mode', async () => {
    for (const stored of [GEN, null]) {
      const db = world(liveSpot({ claimGenerationId: stored }), { spotId: SPOT, claimStartedAt: T1, ...(stored ? { claimGenerationId: stored } : {}) });
      const data = stored ? generationReq() : legacyReq(T1);
      await expectNoWrite(db, run(db, data, OTHER_UID), { outcome: 'already_resolved' });
      await expectNoWrite(db, run(db, data, FINDER), { outcome: 'already_resolved' });
    }
  });
});

describe('29G contract (t683u amendment): the legacy path is independently fail-closed', () => {
  it('29G-F1: unusable stored claimStartedAt representations refuse the legacy shape', async () => {
    const stored = [undefined, null, T1.toMillis(), T1.toDate().toISOString(), fp(T1), { _seconds: T1.seconds, _nanoseconds: T1.nanoseconds }, T1.toDate()];
    for (const claimStartedAt of stored) {
      const db = world(liveSpot({ claimStartedAt }), null);
      await expectNoWrite(db, run(db, legacyReq(T1)), { outcome: 'stale_claim' });
    }
  });

  it('29G-F2: non-live claim states and conflicting locks refuse the legacy shape', async () => {
    for (const spot of [liveSpot({ status: 'occupied' }), liveSpot({ claimState: 'arrived_pending_outcome' }), liveSpot({ status: 'available' })]) {
      const db = world(spot, null);
      await expectNoWrite(db, run(db, legacyReq(T1)), { outcome: 'already_resolved' });
    }
    for (const lock of [
      { spotId: SPOT, claimStartedAt: T1, claimGenerationId: GEN },
      { spotId: SPOT, claimStartedAt: T2 },
      { spotId: SPOT, claimStartedAt: T1.toMillis() },
    ]) {
      const db = world(liveSpot(), lock);
      await expectNoWrite(db, run(db, legacyReq(T1)), { outcome: 'stale_claim' });
    }
  });

  it('29G-F3: request representations other than exact integer { seconds, nanoseconds } are invalid', () => {
    const bad = [T1.toMillis(), String(T1.toMillis()), T1.toDate().toISOString(), T1.toDate(),
      { seconds: T1.seconds }, { seconds: T1.seconds, nanoseconds: 1.5 }, { seconds: 1.5, nanoseconds: 0 },
      { seconds: T1.seconds, nanoseconds: -1 }, { seconds: T1.seconds, nanoseconds: 1_000_000_000 },
      { seconds: Number.MAX_SAFE_INTEGER + 1, nanoseconds: 0 }, { seconds: NaN, nanoseconds: 0 },
      { seconds: T1.seconds, nanoseconds: '123456000' }, { seconds: T1.seconds, nanoseconds: 0, extra: 1 },
      { _seconds: T1.seconds, _nanoseconds: T1.nanoseconds }, [T1.seconds, T1.nanoseconds], null, 'x'];
    for (const value of bad) expect(parseLegacyFingerprint(value)).toBeNull();
    // A plain map is not a stored Timestamp; only a Timestamp yields a stored fingerprint.
    expect(timestampFingerprint(fp(T1))).toBeNull();
    expect(timestampFingerprint(T1.toMillis())).toBeNull();
    expect(timestampFingerprint(T1)).toEqual(fp(T1));
  });

  it('29G-F4: a fenced or restricted caller is denied before any legacy write; an existing notice fails closed', async () => {
    const fenced = world(liveSpot(), { spotId: SPOT, claimStartedAt: T1 }, { [`accountLifecycle/${UID}`]: { decision: 'delete' } });
    await expectNoWrite(fenced, run(fenced, legacyReq(T1)), { rejects: 'permission-denied' });
    for (const profile of [{ status: 'Suspended' }, { status: 'Active', productAccessBlocked: true }]) {
      const db = world(liveSpot(), { spotId: SPOT, claimStartedAt: T1 }, { [`users/${UID}`]: profile });
      await expectNoWrite(db, run(db, legacyReq(T1)), { rejects: 'permission-denied' });
    }
    const noticeId = `spotNotifications/claimer_cancelled_${SPOT}_legacy_${UID}_${T1.seconds}_${T1.nanoseconds}`;
    const noticed = world(liveSpot(), { spotId: SPOT, claimStartedAt: T1 }, { [noticeId]: { type: 'claimer_cancelled' } });
    await expectNoWrite(noticed, run(noticed, legacyReq(T1)), { rejects: 'failed-precondition' });
  });

  it('29G-F5: a successful legacy release clears exactly the generation path fields and is idempotent', async () => {
    const db = world(liveSpot(), { spotId: SPOT, claimStartedAt: T1 });
    await expect(run(db, legacyReq(T1))).resolves.toEqual({ outcome: 'cancelled' });
    const spot = db.docs.get(`spots/${SPOT}`);
    for (const key of Object.keys(CLEAR_FIELDS)) expect(spot[key]).toBeNull();
    expect(spot.status).toBe('available');
    expect(db.docs.has(lockPath(UID))).toBe(false);
    const writes = db.writes.length;
    await expect(run(db, legacyReq(T1))).resolves.toEqual({ outcome: 'already_resolved' });
    expect(db.writes.length).toBe(writes);
  });
});
