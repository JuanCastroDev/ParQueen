'use strict';

const fs = require('fs');
const path = require('path');
const { Timestamp } = require('firebase-admin/firestore');
const { HttpsError } = require('firebase-functions/v2/https');
const {
  claimSpot,
  prepareClaimIntent,
  revokeClaimIntent,
  ATTEMPT_COLLECTION,
  COUNTER_COLLECTION,
  INTENT_TTL_MS,
  MAX_PREPARED,
} = require('./claimSpot');
const { cancelClaim, CLEAR_FIELDS } = require('./cancelClaim');
const { releasedInterestPatch } = require('./activeIncomingClaimLogic');

const UID = 'claimer-1';
const OTHER_UID = 'claimer-2';
const FINDER = 'finder-1';
const SPOT = 'spot-1';
const OTHER_SPOT = 'spot-2';
const FIXED = 1_700_000_000_000;
const ATTEMPT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ATTEMPT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ATTEMPT_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ATTEMPT_D = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function request(data, uid = UID) {
  return { auth: uid ? { uid } : null, data };
}

function memoryDb(seed) {
  const docs = new Map(Object.entries(seed));
  const times = new Map();
  function ref(docPath) {
    return {
      path: docPath,
      async get() { return snap(docPath); },
      collection(name) {
        return { doc(id) { return ref(`${docPath}/${name}/${id}`); } };
      },
    };
  }
  function snap(docPath) {
    if (!docs.has(docPath)) return { exists: false, data: () => undefined, updateTime: null };
    return {
      exists: true,
      data: () => ({ ...docs.get(docPath) }),
      updateTime: times.get(docPath) || Timestamp.fromMillis(FIXED),
    };
  }
  return {
    docs,
    times,
    collection(name) {
      return { doc(id) { return ref(`${name}/${id}`); } };
    },
    async runTransaction(fn) {
      const tx = {
        async get(target) { return snap(target.path); },
        set(target, data) { docs.set(target.path, { ...data }); },
        update(target, patch) {
          docs.set(target.path, { ...(docs.get(target.path) || {}), ...patch });
          const prev = times.get(target.path) || Timestamp.fromMillis(FIXED);
          times.set(target.path, Timestamp.fromMillis(prev.toMillis() + 1));
        },
        delete(target) { docs.delete(target.path); },
        create(target, data) {
          if (docs.has(target.path)) {
            const error = new Error('already exists');
            error.code = 6;
            throw error;
          }
          docs.set(target.path, { ...data });
        },
      };
      return fn(tx);
    },
  };
}

function availableSpot(extra = {}) {
  return {
    status: 'available',
    finderId: FINDER,
    interestedUserId: null,
    expiresAt: Timestamp.fromMillis(FIXED + 3_600_000),
    reportedAt: Timestamp.fromMillis(FIXED + 3_600_000),
    ...extra,
  };
}

function profile(extra = {}) {
  return {
    username: '  ada ',
    fullName: 'Ada Lovelace',
    vehicleColor: 'red',
    vehicleType: 'sedan',
    vehicleBrand: 'ford',
    crowns: 50,
    status: 'Active',
    productAccessBlocked: false,
    ...extra,
  };
}

function harness(seed, deps = {}) {
  const db = memoryDb(seed);
  const calls = { mints: 0, limit: 0 };
  const bytes = [];
  const intentDeps = (extra = {}) => ({
    db,
    now: () => Timestamp.fromMillis(FIXED),
    checkRateLimit: async () => { calls.limit += 1; },
    randomBytes: (size) => {
      calls.mints += 1;
      const value = Buffer.alloc(size, calls.mints);
      bytes.push(value.toString('hex'));
      return value;
    },
    ...deps,
    ...extra,
  });
  const runPrepare = (data, uid = UID, extra = {}) => prepareClaimIntent(request(data, uid), intentDeps(extra));
  const runRevoke = (data, uid = UID, extra = {}) => revokeClaimIntent(request(data, uid), intentDeps(extra));
  const runClaim = async (data, uid = UID, extra = {}) => {
    const prepared = await runPrepare(data, uid, extra);
    if (prepared && prepared.state && prepared.state !== 'prepared' && prepared.state !== 'claimed') {
      return {
        outcome: prepared.state,
        claimGenerationId: null,
        spotId: data.spotId,
        mode: data.mode,
      };
    }
    return claimSpot(request(data, uid), intentDeps(extra));
  };
  const runCancel = (claimGenerationId, uid = UID) => cancelClaim(request({
    spotId: SPOT,
    claimGenerationId,
    reason: 'unspecified',
  }, uid), {
    db,
    now: () => Timestamp.fromMillis(FIXED + 1_000),
    checkRateLimit: async () => {},
  });
  return { db, calls, bytes, runClaim, runPrepare, runRevoke, runCancel, intentDeps };
}

const immediate = (attemptId, extra = {}) => ({
  spotId: SPOT, attemptId, mode: 'immediate', etaMinutes: 4, ...extra,
});

describe('claimSpot generation identity', () => {
  const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const rulesSrc = fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8');

  it('exports claimSpot with App Check and does not add a service account', () => {
    const starts = [...indexSrc.matchAll(/exports\.claimSpot\s*=\s*onCall\(/g)];
    expect(starts).toHaveLength(1);
    const slice = indexSrc.slice(starts[0].index, starts[0].index + 450);
    expect(slice).toMatch(/region:\s*'us-central1'/);
    expect(slice).toMatch(/enforceAppCheck:\s*true/);
    expect(slice).toContain('claimSpotHandler(request)');
    expect(slice).not.toContain('request.data');
    expect(indexSrc.match(/parqueen-cancel@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com/g)).toHaveLength(1);
    for (const name of ['prepareClaimIntent', 'revokeClaimIntent']) {
      const found = [...indexSrc.matchAll(new RegExp(`exports\\.${name}\\s*=\\s*onCall\\(`, 'g'))];
      expect(found).toHaveLength(1);
      const body = indexSrc.slice(found[0].index, found[0].index + 450);
      expect(body).toMatch(/region:\s*'us-central1'/);
      expect(body).toMatch(/enforceAppCheck:\s*true/);
      expect(body).toContain(`${name}Handler(request)`);
      expect(body).not.toContain('request.data');
      expect(body).not.toContain('serviceAccount');
    }
    expect(rulesSrc.includes('claimSpotAttempts')).toBe(false);
    expect(rulesSrc.includes('claimIntentCounters')).toBe(false);
    expect(rulesSrc.includes('allow read, write: if true')).toBe(false);
  });

  it('clears the generation id on every server release helper that drops claimant metadata', () => {
    expect(CLEAR_FIELDS.claimGenerationId).toBeNull();
    expect(releasedInterestPatch(FIXED + 1, FIXED).claimGenerationId).toBeNull();
    expect(releasedInterestPatch(FIXED - 1, FIXED).claimGenerationId).toBeNull();
    const phantom = indexSrc.slice(indexSrc.indexOf('PHANTOM_CLAIM_CLEAR_FIELDS'), indexSrc.indexOf('function isPhantomClaim'));
    expect(phantom).toContain('claimGenerationId: null');
    const cleanup = indexSrc.slice(indexSrc.indexOf('exports.cleanupExpiredInterests'), indexSrc.indexOf('exports.cleanupExpiredHolds'));
    expect(cleanup).toContain('releasedInterestPatch');
    const deleted = indexSrc.slice(indexSrc.indexOf('function releaseClaimsOfDeletedUser'), indexSrc.indexOf('async function paginatedUpdate'));
    expect(deleted).toContain('claimGenerationId: FieldValue.delete()');
    expect(deleted).toContain('claimGenerationId: null');
    const holds = indexSrc.slice(indexSrc.indexOf('exports.cleanupExpiredHolds'), indexSrc.indexOf('exports.cleanupAbandonedArrivedHandoffs'));
    expect(holds.match(/claimGenerationId: null/g)).toHaveLength(2);
    const reconcile = fs.readFileSync(path.join(__dirname, 'activeIncomingClaim.js'), 'utf8');
    expect(reconcile).toContain('claimGenerationId: keptGeneration');
  });

  it('rejects a missing caller, a client-selected generation id, and a non-uuid attempt', async () => {
    const { runClaim, db, calls } = harness({ [`spots/${SPOT}`]: availableSpot() });
    await expect(runClaim(immediate(ATTEMPT_A), null)).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(runClaim({ ...immediate(ATTEMPT_A), claimGenerationId: 'ab'.repeat(32) }))
      .rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(runClaim(immediate('not-a-uuid'))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(runClaim({ ...immediate(ATTEMPT_A), fingerprint: 1 })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(runClaim({ spotId: SPOT, attemptId: ATTEMPT_A, mode: 'immediate' }))
      .rejects.toMatchObject({ code: 'invalid-argument' });
    expect(db.docs.get(`spots/${SPOT}`).status).toBe('available');
    expect(db.docs.has(`${ATTEMPT_COLLECTION}/${ATTEMPT_A}`)).toBe(false);
    expect(calls.mints).toBe(0);
  });

  it('mints one server id onto the spot and the lock, from the profile', async () => {
    const { runClaim, db, calls, bytes } = harness({
      [`users/${UID}`]: profile(),
      [`spots/${SPOT}`]: availableSpot(),
    });
    const result = await runClaim(immediate(ATTEMPT_A));
    expect(result.outcome).toBe('claimed');
    expect(result.claimGenerationId).toBe(bytes[0]);
    expect(result.claimGenerationId).toHaveLength(64);
    expect(result.claimGenerationId).not.toBe(ATTEMPT_A);
    expect(calls.mints).toBe(1);
    const spot = db.docs.get(`spots/${SPOT}`);
    const lock = db.docs.get(`users/${UID}/activeIncomingClaims/current`);
    expect(spot.claimGenerationId).toBe(result.claimGenerationId);
    expect(lock.claimGenerationId).toBe(result.claimGenerationId);
    expect(lock.spotId).toBe(SPOT);
    expect(spot.interestedUserId).toBe(UID);
    expect(spot.interestedUserName).toBe('ada');
    expect(spot.interestedUserTitle).toBe('Street Scout');
    expect(spot.claimState).toBe('heading');
    expect(spot.claimStartedAt.toMillis()).toBe(FIXED);
    expect(spot.etaMinutes).toBe(4);
    const attempt = db.docs.get(`${ATTEMPT_COLLECTION}/${ATTEMPT_A}`);
    expect(attempt.outcome).toBe('claimed');
    expect(attempt.claimGenerationId).toBe(result.claimGenerationId);
    expect(attempt.uid).toBe(UID);
  });

  it('replays a lost response and does not mint again after the claim is released', async () => {
    const box = harness({
      [`users/${UID}`]: profile(),
      [`spots/${SPOT}`]: availableSpot(),
    });
    const first = await box.runClaim(immediate(ATTEMPT_A));
    const replay = await box.runClaim(immediate(ATTEMPT_A));
    expect(replay).toEqual(first);
    expect(box.calls.mints).toBe(1);

    await expect(box.runCancel(first.claimGenerationId)).resolves.toEqual({ outcome: 'cancelled' });
    expect(box.db.docs.get(`spots/${SPOT}`).status).toBe('available');
    expect(box.db.docs.get(`spots/${SPOT}`).claimGenerationId).toBeNull();
    const afterRelease = await box.runClaim(immediate(ATTEMPT_A));
    expect(afterRelease).toEqual(first);
    expect(box.db.docs.get(`spots/${SPOT}`).status).toBe('available');
    expect(box.db.docs.get(`spots/${SPOT}`).interestedUserId).toBeNull();
    expect(box.calls.mints).toBe(1);

    const second = await box.runClaim(immediate(ATTEMPT_B));
    expect(second.outcome).toBe('claimed');
    expect(second.claimGenerationId).not.toBe(first.claimGenerationId);
    expect(box.db.docs.get(`spots/${SPOT}`).claimStartedAt.toMillis()).toBe(FIXED);
    expect(box.calls.mints).toBe(2);

    const stale = await box.runClaim(immediate(ATTEMPT_A));
    expect(stale).toEqual(first);
    expect(box.db.docs.get(`spots/${SPOT}`).claimGenerationId).toBe(second.claimGenerationId);
    await expect(box.runCancel(first.claimGenerationId)).resolves.toEqual({ outcome: 'stale_claim' });
    expect(box.db.docs.get(`spots/${SPOT}`).claimGenerationId).toBe(second.claimGenerationId);
    expect([...box.db.docs.keys()].filter((key) => key.startsWith('spotNotifications/'))).toHaveLength(1);
    await expect(box.runCancel(second.claimGenerationId)).resolves.toEqual({ outcome: 'cancelled' });
    await expect(box.runCancel(second.claimGenerationId)).resolves.toEqual({ outcome: 'already_resolved' });
    expect([...box.db.docs.keys()].filter((key) => key.startsWith('spotNotifications/'))).toHaveLength(2);
  });

  it('gives a second device the current hold without minting a second generation', async () => {
    const box = harness({
      [`users/${UID}`]: profile(),
      [`spots/${SPOT}`]: availableSpot(),
    });
    const first = await box.runClaim(immediate(ATTEMPT_A));
    const secondDevice = await box.runClaim(immediate(ATTEMPT_B));
    expect(secondDevice.outcome).toBe('already_held');
    expect(secondDevice.claimGenerationId).toBeNull();
    expect(box.calls.mints).toBe(1);
    expect(box.db.docs.get(`${ATTEMPT_COLLECTION}/${ATTEMPT_B}`).claimGenerationId).toBeNull();
    const again = await box.runClaim(immediate(ATTEMPT_B));
    expect(again).toEqual(secondDevice);
    expect(box.db.docs.get(`spots/${SPOT}`).claimGenerationId).toBe(first.claimGenerationId);
  });

  it('does not give a never-recorded attempt the live generation id', async () => {
    const box = harness({
      [`users/${UID}`]: profile(),
      [`spots/${SPOT}`]: availableSpot(),
    });
    const live = await box.runClaim(immediate(ATTEMPT_B));
    const late = await box.runClaim(immediate(ATTEMPT_A));
    expect(late).toEqual({
      outcome: 'already_held',
      claimGenerationId: null,
      spotId: SPOT,
      mode: 'immediate',
    });
    expect(JSON.stringify(late)).not.toContain(live.claimGenerationId);
    expect(box.db.docs.get(`${ATTEMPT_COLLECTION}/${ATTEMPT_A}`)).toMatchObject({
      uid: UID,
      spotId: SPOT,
      mode: 'immediate',
      etaMinutes: 4,
      outcome: 'already_held',
      claimGenerationId: null,
    });
    expect(box.db.docs.get(`spots/${SPOT}`).claimGenerationId).toBe(live.claimGenerationId);
    expect(box.calls.mints).toBe(1);
    expect(box.calls.limit).toBe(2);
  });

  it('rejects a replay whose spot, mode, or eta differs and does not disclose the stored generation', async () => {
    const box = harness({
      [`users/${UID}`]: profile(),
      [`spots/${SPOT}`]: availableSpot(),
      [`spots/${OTHER_SPOT}`]: availableSpot(),
    });
    const first = await box.runClaim(immediate(ATTEMPT_A));
    const mismatches = [
      immediate(ATTEMPT_A, { spotId: OTHER_SPOT }),
      { spotId: SPOT, attemptId: ATTEMPT_A, mode: 'scheduled' },
      immediate(ATTEMPT_A, { etaMinutes: 5 }),
    ];
    for (const data of mismatches) {
      let thrown = null;
      try {
        await box.runClaim(data);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({ code: 'invalid-argument', message: 'Invalid claim request.' });
      expect(String(thrown && thrown.message)).not.toContain(first.claimGenerationId);
    }
    expect(await box.runClaim(immediate(ATTEMPT_A))).toEqual(first);
    expect(box.db.docs.get(`spots/${SPOT}`).claimGenerationId).toBe(first.claimGenerationId);
    expect(box.db.docs.get(`${ATTEMPT_COLLECTION}/${ATTEMPT_A}`).claimGenerationId).toBe(first.claimGenerationId);
    expect(box.calls.mints).toBe(1);
    // One new prepared intent plus three identity mismatches. The matching
    // replay is not charged again.
    expect(box.calls.limit).toBe(4);
  });

  it('does not let a never-prepared attempt claim after an earlier generation is released', async () => {
    const box = harness({
      [`users/${UID}`]: profile(),
      [`spots/${SPOT}`]: availableSpot(),
    });
    const earlier = await box.runClaim(immediate(ATTEMPT_B));
    await expect(box.runCancel(earlier.claimGenerationId)).resolves.toEqual({ outcome: 'cancelled' });
    await expect(claimSpot(request(immediate(ATTEMPT_A)), box.intentDeps())).rejects.toMatchObject({
      code: 'failed-precondition',
      message: 'Claim could not be completed.',
    });
    expect(box.db.docs.has(`${ATTEMPT_COLLECTION}/${ATTEMPT_A}`)).toBe(false);
    expect(box.db.docs.get(`spots/${SPOT}`).status).toBe('available');
    expect(box.db.docs.get(`spots/${SPOT}`).claimGenerationId).toBeNull();
    expect(box.calls.mints).toBe(1);
    const fresh = await box.runClaim(immediate(ATTEMPT_A));
    expect(fresh.outcome).toBe('claimed');
    expect(fresh.claimGenerationId).not.toBe(earlier.claimGenerationId);
    expect(box.calls.mints).toBe(2);
  });

  it('does not claim over a leftover generation id or another live lock', async () => {
    const stale = harness({
      [`spots/${SPOT}`]: availableSpot({ claimGenerationId: 'cd'.repeat(32) }),
    });
    const refused = await stale.runClaim(immediate(ATTEMPT_A));
    expect(refused.outcome).toBe('refused_stale_generation');
    expect(refused.claimGenerationId).toBeNull();
    expect(stale.calls.mints).toBe(0);
    expect(stale.db.docs.get(`spots/${SPOT}`).claimGenerationId).toBe('cd'.repeat(32));
    expect(stale.db.docs.get(`spots/${SPOT}`).interestedUserId).toBeNull();
    await expect(stale.runClaim(immediate(ATTEMPT_A))).resolves.toEqual(refused);

    const busy = harness({
      [`users/${UID}`]: profile(),
      [`spots/${SPOT}`]: availableSpot(),
      [`spots/${OTHER_SPOT}`]: {
        status: 'interested',
        finderId: FINDER,
        interestedUserId: UID,
        claimState: 'heading',
        claimGenerationId: 'ef'.repeat(32),
      },
      [`users/${UID}/activeIncomingClaims/current`]: { spotId: OTHER_SPOT },
    });
    const blocked = await busy.runClaim(immediate(ATTEMPT_A));
    expect(blocked.outcome).toBe('already_claimed');
    expect(blocked.claimGenerationId).toBeNull();
    expect(busy.db.docs.get(`spots/${SPOT}`).status).toBe('available');
    expect(busy.db.docs.get(`spots/${OTHER_SPOT}`).claimGenerationId).toBe('ef'.repeat(32));
    expect(busy.calls.mints).toBe(0);
  });

  it('denies suspension and malformed product access without minting', async () => {
    for (const user of [
      { status: 'Suspended', productAccessBlocked: false },
      { status: 'Active', productAccessBlocked: true },
      { status: 'Active', productAccessBlocked: 'false' },
    ]) {
      const box = harness({
        [`users/${UID}`]: user,
        [`spots/${SPOT}`]: availableSpot(),
      });
      await expect(box.runClaim(immediate(ATTEMPT_A))).rejects.toMatchObject({
        code: 'permission-denied',
        message: 'Product access is not available.',
      });
      expect(box.db.docs.get(`spots/${SPOT}`).status).toBe('available');
      expect(box.db.docs.get(`${ATTEMPT_COLLECTION}/${ATTEMPT_A}`).outcome).toBe('permission_denied');
      expect(box.calls.mints).toBe(0);
      await expect(box.runClaim(immediate(ATTEMPT_A))).rejects.toMatchObject({ code: 'permission-denied' });
      expect(box.calls.mints).toBe(0);
    }
  });

  it('does not reveal another user attempt, and a discarded transaction retry commits one id', async () => {
    const owner = harness({
      [`users/${UID}`]: profile(),
      [`users/${OTHER_UID}`]: profile(),
      [`spots/${SPOT}`]: availableSpot(),
    });
    const claimed = await owner.runClaim(immediate(ATTEMPT_A));
    await expect(owner.runClaim(immediate(ATTEMPT_A), OTHER_UID)).rejects.toMatchObject({
      code: 'permission-denied',
      message: 'Claim could not be completed.',
    });
    expect(owner.db.docs.get(`spots/${SPOT}`).claimGenerationId).toBe(claimed.claimGenerationId);
    expect(owner.db.docs.get(`spots/${SPOT}`).interestedUserId).toBe(UID);

    const db = memoryDb({
      [`users/${UID}`]: profile(),
      [`spots/${SPOT}`]: availableSpot(),
    });
    await prepareClaimIntent(request(immediate(ATTEMPT_C)), {
      db,
      now: () => Timestamp.fromMillis(FIXED),
      checkRateLimit: async () => {},
      randomBytes: () => { throw new Error('prepare must not mint'); },
    });
    let attempts = 0;
    const minted = [];
    db.runTransaction = async (fn) => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const staged = new Map();
        const tx = {
          async get(target) {
            const data = db.docs.get(target.path);
            return data
              ? { exists: true, data: () => ({ ...data }), updateTime: Timestamp.fromMillis(FIXED) }
              : { exists: false, data: () => undefined, updateTime: null };
          },
          set(target, data) { staged.set(target.path, { op: 'set', data: { ...data } }); },
          update(target, patch) { staged.set(target.path, { op: 'update', patch: { ...patch } }); },
          delete(target) { staged.set(target.path, { op: 'delete' }); },
          create(target, data) { staged.set(target.path, { op: 'set', data: { ...data } }); },
        };
        const result = await fn(tx);
        attempts += 1;
        if (attempt === 0) continue;
        for (const [docPath, op] of staged) {
          if (op.op === 'set') db.docs.set(docPath, op.data);
          else if (op.op === 'delete') db.docs.delete(docPath);
          else db.docs.set(docPath, { ...db.docs.get(docPath), ...op.patch });
        }
        return result;
      }
      throw new Error('retry did not commit');
    };
    let mint = 0;
    let thrown = null;
    let result = null;
    try {
      result = await claimSpot(request(immediate(ATTEMPT_C)), {
        db,
        now: () => Timestamp.fromMillis(FIXED),
        checkRateLimit: async () => {},
        randomBytes: (size) => {
          mint += 1;
          const value = Buffer.alloc(size, 20 + mint);
          minted.push(value.toString('hex'));
          return value;
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeNull();
    expect(attempts).toBe(2);
    expect(mint).toBe(2);
    expect(minted[0]).not.toBe(minted[1]);
    expect(result.claimGenerationId).toBe(minted[1]);
    expect(db.docs.get(`spots/${SPOT}`).claimGenerationId).toBe(minted[1]);
    expect(db.docs.get(`users/${UID}/activeIncomingClaims/current`).claimGenerationId).toBe(minted[1]);
    expect(db.docs.get(`${ATTEMPT_COLLECTION}/${ATTEMPT_C}`).claimGenerationId).toBe(minted[1]);
  });

  it('keeps a scheduled claim on the spot lifetime and preserves an unexpired immediate window', async () => {
    const box = harness({
      [`users/${UID}`]: profile({ username: '', fullName: '' }),
      [`spots/${SPOT}`]: availableSpot(),
    });
    const scheduled = await box.runClaim({ spotId: SPOT, attemptId: ATTEMPT_A, mode: 'scheduled' });
    expect(scheduled.outcome).toBe('claimed');
    const spot = box.db.docs.get(`spots/${SPOT}`);
    expect(spot.claimState).toBe('committed');
    expect(spot.interestedUserName).toBe('Someone');
    expect(spot.etaMinutes).toBeNull();
    expect(spot.interestExpiresAt.toMillis()).toBe(FIXED + 3_600_000);
    expect(spot.claimAutoReleaseAt.toMillis()).toBe(FIXED + 3_600_000 + (10 * 60 * 1000));
    expect(spot.claimReminderAt.toMillis()).toBe(FIXED + 3_600_000 - (20 * 60 * 1000));
  });

  it('surfaces rate-limit denial without a claim write', async () => {
    const box = harness({ [`spots/${SPOT}`]: availableSpot() }, {
      checkRateLimit: async () => { throw new HttpsError('resource-exhausted', 'Too many requests. Try again later.'); },
    });
    await expect(box.runClaim(immediate(ATTEMPT_A))).rejects.toMatchObject({ code: 'resource-exhausted' });
    expect(box.db.docs.get(`spots/${SPOT}`).status).toBe('available');
    expect(box.db.docs.has(`${ATTEMPT_COLLECTION}/${ATTEMPT_A}`)).toBe(false);
  });
});

describe('claim intent protocol', () => {
  it('redeems a prepared intent once and replays the generation without another charge', async () => {
    const box = harness({
      [`users/${UID}`]: profile(),
      [`spots/${SPOT}`]: availableSpot(),
    });
    const prepared = await box.runPrepare(immediate(ATTEMPT_A));
    expect(prepared).toMatchObject({ state: 'prepared', attemptId: ATTEMPT_A, spotId: SPOT, mode: 'immediate' });
    expect(prepared.expiresAt).toBe(FIXED + INTENT_TTL_MS);
    expect(JSON.stringify(prepared)).not.toMatch(/[0-9a-f]{64}/);
    const claimed = await claimSpot(request(immediate(ATTEMPT_A)), box.intentDeps());
    const replay = await claimSpot(request(immediate(ATTEMPT_A)), box.intentDeps());
    expect(replay).toEqual(claimed);
    expect(box.calls.mints).toBe(1);
    expect(box.calls.limit).toBe(1);
    expect(box.db.docs.get(`${ATTEMPT_COLLECTION}/${ATTEMPT_A}`).state).toBe('claimed');
    const again = await box.runPrepare(immediate(ATTEMPT_A));
    expect(again.state).toBe('claimed');
    expect(JSON.stringify(again)).not.toContain(claimed.claimGenerationId);
    expect(box.calls.limit).toBe(1);
  });

  it('rejects an unprepared redeem and an expired intent without minting or deleting', async () => {
    const box = harness({
      [`users/${UID}`]: profile(),
      [`spots/${SPOT}`]: availableSpot(),
    });
    await expect(claimSpot(request(immediate(ATTEMPT_A)), box.intentDeps())).rejects.toMatchObject({
      code: 'failed-precondition',
    });
    expect(box.calls.mints).toBe(0);
    await box.runPrepare(immediate(ATTEMPT_A));
    const expired = await claimSpot(request(immediate(ATTEMPT_A)), box.intentDeps({
      now: () => Timestamp.fromMillis(FIXED + INTENT_TTL_MS),
    }));
    expect(expired.outcome).toBe('expired');
    expect(expired.claimGenerationId).toBeNull();
    expect(box.db.docs.get(`${ATTEMPT_COLLECTION}/${ATTEMPT_A}`).state).toBe('expired');
    expect(box.db.docs.get(`spots/${SPOT}`).status).toBe('available');
    expect(box.calls.mints).toBe(0);
    const kept = await claimSpot(request(immediate(ATTEMPT_A)), box.intentDeps({
      now: () => Timestamp.fromMillis(FIXED + INTENT_TTL_MS + 1),
    }));
    expect(kept).toEqual(expired);
  });

  it('keeps a revocation tombstone ahead of prepare and redeem', async () => {
    const box = harness({
      [`users/${UID}`]: profile(),
      [`spots/${SPOT}`]: availableSpot(),
    });
    const first = await box.runRevoke(immediate(ATTEMPT_A));
    const second = await box.runRevoke(immediate(ATTEMPT_A));
    expect(first).toMatchObject({ outcome: 'revoked', attemptId: ATTEMPT_A });
    expect(second).toEqual(first);
    expect(box.calls.limit).toBe(1);
    const prepared = await box.runPrepare(immediate(ATTEMPT_A));
    expect(prepared.state).toBe('revoked');
    expect(box.db.docs.get(`${ATTEMPT_COLLECTION}/${ATTEMPT_A}`).state).toBe('revoked');
    const redeemed = await claimSpot(request(immediate(ATTEMPT_A)), box.intentDeps());
    expect(redeemed.outcome).toBe('revoked');
    expect(redeemed.claimGenerationId).toBeNull();
    expect(box.db.docs.get(`spots/${SPOT}`).status).toBe('available');
    expect(box.calls.mints).toBe(0);
    await expect(box.runPrepare(immediate(ATTEMPT_A, { etaMinutes: 5 }))).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    await expect(box.runRevoke(immediate(ATTEMPT_A), OTHER_UID)).rejects.toMatchObject({
      code: 'permission-denied',
      message: 'Claim could not be completed.',
    });
    expect(box.db.docs.get(`${ATTEMPT_COLLECTION}/${ATTEMPT_A}`).uid).toBe(UID);
    expect(box.calls.mints).toBe(0);
  });

  it('releases only the generation named by a committed intent', async () => {
    const box = harness({
      [`users/${UID}`]: profile(),
      [`spots/${SPOT}`]: availableSpot(),
    });
    const g1 = await box.runClaim(immediate(ATTEMPT_A));
    const released = await box.runRevoke(immediate(ATTEMPT_A));
    expect(released.outcome).toBe('released');
    expect(released).not.toHaveProperty('claimGenerationId');
    expect(box.db.docs.get(`spots/${SPOT}`).claimGenerationId).toBeNull();
    expect(box.db.docs.get(`spots/${SPOT}`).status).toBe('available');
    expect(box.db.docs.has(`users/${UID}/activeIncomingClaims/current`)).toBe(false);
    expect(box.db.docs.get(`${ATTEMPT_COLLECTION}/${ATTEMPT_A}`).state).toBe('released');
    expect(box.db.docs.get(`${ATTEMPT_COLLECTION}/${ATTEMPT_A}`).claimGenerationId).toBe(g1.claimGenerationId);
    const duplicate = await box.runRevoke(immediate(ATTEMPT_A));
    expect(duplicate.outcome).toBe('released');
    expect([...box.db.docs.keys()].filter((key) => key.startsWith('spotNotifications/'))).toHaveLength(1);

    const g2 = await box.runClaim(immediate(ATTEMPT_B));
    const unchanged = await box.runRevoke(immediate(ATTEMPT_A));
    expect(unchanged.outcome).toBe('released');
    expect(box.db.docs.get(`spots/${SPOT}`).claimGenerationId).toBe(g2.claimGenerationId);
    const before = [...box.db.docs.keys()].filter((key) => key.startsWith('spotNotifications/')).length;
    await expect(box.runCancel(g1.claimGenerationId)).resolves.toEqual({ outcome: 'stale_claim' });
    expect([...box.db.docs.keys()].filter((key) => key.startsWith('spotNotifications/'))).toHaveLength(before);
    expect(box.db.docs.get(`spots/${SPOT}`).claimGenerationId).toBe(g2.claimGenerationId);
  });

  it('returns a released replay without the stored generation and does not touch G2', async () => {
    const box = harness({
      [`users/${UID}`]: profile(),
      [`spots/${SPOT}`]: availableSpot(),
    });
    const g1 = await box.runClaim(immediate(ATTEMPT_A));
    await box.runRevoke(immediate(ATTEMPT_A));
    const replay = await claimSpot(request(immediate(ATTEMPT_A)), box.intentDeps());
    expect(replay).toEqual({
      outcome: 'released',
      claimGenerationId: null,
      spotId: SPOT,
      mode: 'immediate',
    });
    const stored = box.db.docs.get(`${ATTEMPT_COLLECTION}/${ATTEMPT_A}`);
    expect(stored.state).toBe('released');
    expect(stored.outcome).toBe('claimed');
    expect(stored.claimGenerationId).toBe(g1.claimGenerationId);
    expect(box.calls.mints).toBe(1);

    const g2 = await box.runClaim(immediate(ATTEMPT_B));
    const again = await claimSpot(request(immediate(ATTEMPT_A)), box.intentDeps());
    expect(again).toEqual({
      outcome: 'released',
      claimGenerationId: null,
      spotId: SPOT,
      mode: 'immediate',
    });
    expect(box.db.docs.get(`spots/${SPOT}`).claimGenerationId).toBe(g2.claimGenerationId);
    expect(box.db.docs.get(`${ATTEMPT_COLLECTION}/${ATTEMPT_A}`).claimGenerationId).toBe(g1.claimGenerationId);
    expect(box.calls.mints).toBe(2);
  });

  it('does not release G2 when G1 is revoked after G2 is live', async () => {
    const box = harness({
      [`users/${UID}`]: profile(),
      [`spots/${SPOT}`]: availableSpot(),
    });
    const g1 = await box.runClaim(immediate(ATTEMPT_A));
    await box.runCancel(g1.claimGenerationId);
    const g2 = await box.runClaim(immediate(ATTEMPT_B));
    expect(g2.claimGenerationId).not.toBe(g1.claimGenerationId);
    expect(box.db.docs.get(`spots/${SPOT}`).claimStartedAt.toMillis()).toBe(FIXED);
    const result = await box.runRevoke(immediate(ATTEMPT_A));
    expect(result.outcome).toBe('generation_unchanged');
    expect(box.db.docs.get(`spots/${SPOT}`).claimGenerationId).toBe(g2.claimGenerationId);
    expect(box.db.docs.get(`spots/${SPOT}`).interestedUserId).toBe(UID);
    expect([...box.db.docs.keys()].filter((key) => key.startsWith('spotNotifications/'))).toHaveLength(1);
  });

  it('fails a redeem closed when the spot updateTime changes', async () => {
    const box = harness({
      [`users/${UID}`]: profile(),
      [`spots/${SPOT}`]: availableSpot(),
    });
    await box.runPrepare(immediate(ATTEMPT_A));
    box.db.docs.set(`spots/${SPOT}`, { ...box.db.docs.get(`spots/${SPOT}`), note: 'edited' });
    box.db.times.set(`spots/${SPOT}`, Timestamp.fromMillis(FIXED + 5));
    const closed = await claimSpot(request(immediate(ATTEMPT_A)), box.intentDeps());
    expect(closed).toMatchObject({ outcome: 'stale_precondition', claimGenerationId: null });
    expect(box.db.docs.get(`spots/${SPOT}`).interestedUserId).toBeNull();
    expect(box.db.docs.get(`${ATTEMPT_COLLECTION}/${ATTEMPT_A}`).state).toBe('stale_precondition');
    expect(box.calls.mints).toBe(0);
    expect([...box.db.docs.keys()].filter((key) => key.startsWith('spotNotifications/'))).toHaveLength(0);
  });

  it('bounds simultaneous prepared intents and reclaims expired slots without deleting them', async () => {
    const box = harness({
      [`users/${UID}`]: profile(),
      [`spots/${SPOT}`]: availableSpot(),
    });
    await box.runPrepare(immediate(ATTEMPT_A));
    await box.runPrepare(immediate(ATTEMPT_B));
    await box.runPrepare(immediate(ATTEMPT_C));
    await expect(box.runPrepare(immediate(ATTEMPT_D))).rejects.toMatchObject({ code: 'resource-exhausted' });
    expect(box.db.docs.has(`${ATTEMPT_COLLECTION}/${ATTEMPT_D}`)).toBe(false);
    const opened = await box.runPrepare(immediate(ATTEMPT_D), UID, {
      now: () => Timestamp.fromMillis(FIXED + INTENT_TTL_MS),
    });
    expect(opened.state).toBe('prepared');
    expect(box.db.docs.get(`${ATTEMPT_COLLECTION}/${ATTEMPT_A}`).state).toBe('expired');
    expect(box.db.docs.get(`${COUNTER_COLLECTION}/${UID}`).preparedIds).toEqual([ATTEMPT_D]);
    expect(MAX_PREPARED).toBe(3);
  });

  it('lets a suspended owner release an already committed generation', async () => {
    const box = harness({
      [`users/${UID}`]: profile(),
      [`spots/${SPOT}`]: availableSpot(),
    });
    const claimed = await box.runClaim(immediate(ATTEMPT_A));
    box.db.docs.set(`users/${UID}`, { ...profile(), status: 'Suspended' });
    await expect(box.runPrepare(immediate(ATTEMPT_B))).rejects.toMatchObject({
      code: 'permission-denied',
      message: 'Product access is not available.',
    });
    expect(box.calls.mints).toBe(1);
    const released = await box.runRevoke(immediate(ATTEMPT_A));
    expect(released.outcome).toBe('released');
    expect(box.db.docs.get(`spots/${SPOT}`).claimGenerationId).toBeNull();
    await expect(box.runCancel(claimed.claimGenerationId)).rejects.toMatchObject({
      code: 'permission-denied',
      message: 'Product access is not available.',
    });
  });

  it('aborts a redeem that loses to revocation and commits no generation', async () => {
    const db = memoryDb({
      [`users/${UID}`]: profile(),
      [`spots/${SPOT}`]: availableSpot(),
    });
    const quiet = { db, now: () => Timestamp.fromMillis(FIXED), checkRateLimit: async () => {}, randomBytes: () => Buffer.alloc(32, 7) };
    await prepareClaimIntent(request(immediate(ATTEMPT_A)), quiet);
    const original = db.runTransaction.bind(db);
    let depth = 0;
    db.runTransaction = async (fn) => {
      depth += 1;
      try {
        if (depth > 1) return original(fn);
        let lastError = null;
        for (let pass = 0; pass < 2; pass += 1) {
          try {
            return await original(async (tx) => {
              const result = await fn(tx);
              return result;
            });
          } catch (error) {
            lastError = error;
            if (pass === 0 && (error.code === 10 || error.code === 'aborted')) continue;
            throw error;
          }
        }
        throw lastError;
      } finally {
        depth -= 1;
      }
    };
    let mints = 0;
    const redeemed = await claimSpot(request(immediate(ATTEMPT_A)), {
      ...quiet,
      allowTestHooks: true,
      randomBytes: (size) => {
        mints += 1;
        return Buffer.alloc(size, 9);
      },
      afterReads: async () => {
        await revokeClaimIntent(request(immediate(ATTEMPT_A)), quiet);
        const aborted = new Error('aborted');
        aborted.code = 10;
        throw aborted;
      },
    });
    expect(redeemed.outcome).toBe('revoked');
    expect(mints).toBe(0);
    expect(db.docs.get(`spots/${SPOT}`).status).toBe('available');
    expect(db.docs.get(`${ATTEMPT_COLLECTION}/${ATTEMPT_A}`).state).toBe('revoked');
  });
});
