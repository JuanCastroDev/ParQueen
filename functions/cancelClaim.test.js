'use strict';

const { HttpsError } = require('firebase-functions/v2/https');
const { cancelClaim, CLEAR_FIELDS, REASONS } = require('./cancelClaim');

const UID = 'claimer-1';
const FINDER = 'finder-1';
const SPOT = 'spot-1';
const FINGERPRINT = 1_700_000_000_000;

function request(data, uid = UID) {
  return { auth: uid ? { uid } : null, data };
}

function ts(ms) {
  return { toMillis: () => ms };
}

function memoryDb(seed) {
  const docs = new Map(Object.entries(seed));
  function ref(path) {
    return {
      path,
      collection(name) {
        return { doc(id) { return ref(`${path}/${name}/${id}`); } };
      },
    };
  }
  function snap(path) {
    if (!docs.has(path)) return { exists: false, data: () => undefined };
    const data = docs.get(path);
    return { exists: true, data: () => ({ ...data }) };
  }
  return {
    docs,
    collection(name) {
      return { doc(id) { return ref(`${name}/${id}`); } };
    },
    async runTransaction(fn) {
      const tx = {
        async get(target) { return snap(target.path); },
        update(target, patch) { docs.set(target.path, { ...docs.get(target.path), ...patch }); },
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

function liveSpot(extra = {}) {
  return {
    status: 'interested',
    finderId: FINDER,
    interestedUserId: UID,
    claimState: 'heading',
    claimStartedAt: ts(FINGERPRINT),
    expiresAt: ts(FINGERPRINT + 60_000),
    interestedUserName: 'bob',
    ...extra,
  };
}

function harness(seed, deps = {}) {
  const db = memoryDb(seed);
  const calls = { limit: 0, hook: 0 };
  return {
    db,
    calls,
    run(data, uid = UID, extra = {}) {
      return cancelClaim(request(data, uid), {
        db,
        now: () => ts(FINGERPRINT + 1_000),
        checkRateLimit: async () => { calls.limit += 1; },
        ...deps,
        ...extra,
      });
    },
  };
}

const input = (extra = {}) => ({ spotId: SPOT, fingerprint: FINGERPRINT, reason: 'unspecified', ...extra });

describe('cancelClaim handler', () => {
  it('rejects a missing caller', async () => {
    const { run } = harness({});
    await expect(run(input(), null)).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  it('rejects unknown fields, malformed fingerprints, and unknown reasons', async () => {
    const { run } = harness({});
    await expect(run({ ...input(), claimantId: UID })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(run({ ...input(), finderId: FINDER })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(run({ spotId: SPOT, reason: 'unspecified' })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(run(input({ fingerprint: 1.5 }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(run(input({ fingerprint: '1700000000000' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(run(input({ fingerprint: -1 }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(run(input({ reason: 'because' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(run(input({ spotId: 'a/b' }))).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(run(null)).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('rejects a missing fingerprint property and unknown field maps', async () => {
    const { run, db } = harness({ [`spots/${SPOT}`]: liveSpot() });
    const denied = [
      { spotId: SPOT, reason: 'unspecified' },
      { ...input(), claimantId: UID },
      { ...input(), finderId: FINDER },
      { ...input(), notificationId: 'claimer_cancelled_spot-1_x' },
      { ...input(), updates: { status: 'available' } },
      input({ reason: 'Because' }),
      input({ reason: '' }),
      input({ reason: null }),
    ];
    for (const data of denied) {
      await expect(run(data)).rejects.toMatchObject({
        code: 'invalid-argument',
        message: 'Invalid cancellation request.',
      });
    }
    expect(db.docs.get(`spots/${SPOT}`).status).toBe('interested');
    expect(db.docs.get(`spots/${SPOT}`).interestedUserId).toBe(UID);
  });

  it('does not run a test hook unless the test flag is set', async () => {
    const { run } = harness({ [`spots/${SPOT}`]: liveSpot() });
    let called = false;
    await expect(run(input(), UID, { afterReads: async () => { called = true; } }))
      .rejects.toMatchObject({ code: 'internal' });
    expect(called).toBe(false);
  });

  it('does not enable test hooks from the payload, a string flag, or the environment', async () => {
    const priorAllow = process.env.ALLOW_TEST_HOOKS;
    const priorNamed = process.env.PARQUEEN_ALLOW_TEST_HOOKS;
    process.env.ALLOW_TEST_HOOKS = 'true';
    process.env.PARQUEEN_ALLOW_TEST_HOOKS = '1';
    const called = { value: false };
    const hook = async () => { called.value = true; };
    const db = memoryDb({ [`spots/${SPOT}`]: liveSpot() });
    const trusted = {
      db,
      checkRateLimit: async () => {},
      now: () => ts(FINGERPRINT + 1_000),
    };
    try {
      await expect(cancelClaim(request({ ...input(), allowTestHooks: true, afterReads: hook }), trusted))
        .rejects.toMatchObject({ code: 'invalid-argument' });
      const forwarded = { ...input(), allowTestHooks: true, afterReads: 'not-a-function' };
      await expect(cancelClaim({ auth: { uid: UID }, data: forwarded }, forwarded))
        .rejects.toMatchObject({ code: 'invalid-argument' });
      await expect(cancelClaim(request(input()), { ...trusted, allowTestHooks: 'true', afterReads: hook }))
        .rejects.toMatchObject({ code: 'internal' });
      await expect(cancelClaim(request(input()), { ...trusted, allowTestHooks: 1, afterReads: hook }))
        .rejects.toMatchObject({ code: 'internal' });
      await expect(cancelClaim(request(input()), { ...trusted, allowTestHooks: true, afterReads: 'not-a-function' }))
        .resolves.toEqual({ outcome: 'cancelled' });
      expect(called.value).toBe(false);
    } finally {
      if (priorAllow === undefined) delete process.env.ALLOW_TEST_HOOKS;
      else process.env.ALLOW_TEST_HOOKS = priorAllow;
      if (priorNamed === undefined) delete process.env.PARQUEEN_ALLOW_TEST_HOOKS;
      else process.env.PARQUEEN_ALLOW_TEST_HOOKS = priorNamed;
    }
  });

  it('runs a test hook once across a retried callback', async () => {
    const db = memoryDb({ [`spots/${SPOT}`]: liveSpot() });
    let attempts = 0;
    let hooks = 0;
    db.runTransaction = async (fn) => {
      const tx = {
        async get(target) {
          const data = db.docs.get(target.path);
          return data ? { exists: true, data: () => ({ ...data }) } : { exists: false, data: () => undefined };
        },
        update(target, patch) { db.docs.set(target.path, { ...db.docs.get(target.path), ...patch }); },
        delete(target) { db.docs.delete(target.path); },
        create(target, data) { db.docs.set(target.path, { ...data }); },
      };
      attempts += 1;
      await fn(tx);
      attempts += 1;
      return fn(tx);
    };
    const result = await cancelClaim(request(input()), {
      db,
      now: () => ts(FINGERPRINT + 1_000),
      checkRateLimit: async () => {},
      allowTestHooks: true,
      afterReads: async () => { hooks += 1; },
    });
    expect(result.outcome).toBe('already_resolved');
    expect(attempts).toBe(2);
    expect(hooks).toBe(1);
  });

  it('allows a missing profile and denies suspended, blocked, and malformed access inside the transaction', async () => {
    const missing = harness({ [`spots/${SPOT}`]: liveSpot() });
    await expect(missing.run(input())).resolves.toEqual({ outcome: 'cancelled' });

    const suspended = harness({
      [`users/${UID}`]: { status: 'Suspended', productAccessBlocked: false },
      [`spots/${SPOT}`]: liveSpot(),
    });
    await expect(suspended.run(input())).rejects.toMatchObject({
      code: 'permission-denied',
      message: 'Product access is not available.',
    });
    expect(suspended.db.docs.get(`spots/${SPOT}`).status).toBe('interested');

    const blocked = harness({
      [`users/${UID}`]: { status: 'Active', productAccessBlocked: true },
      [`spots/${SPOT}`]: liveSpot(),
    });
    await expect(blocked.run(input())).rejects.toMatchObject({ code: 'permission-denied' });

    const malformed = harness({
      [`users/${UID}`]: { status: 'Active', productAccessBlocked: 'false' },
      [`spots/${SPOT}`]: liveSpot(),
    });
    await expect(malformed.run(input())).rejects.toMatchObject({ code: 'permission-denied' });

    const open = harness({
      [`users/${UID}`]: { status: 'Active', productAccessBlocked: false },
      [`spots/${SPOT}`]: liveSpot(),
    });
    await expect(open.run(input())).resolves.toEqual({ outcome: 'cancelled' });
  });

  it('returns the same already_resolved result for probes that are not the stored claimant', async () => {
    const cases = [
      {},
      { [`spots/${SPOT}`]: liveSpot({ interestedUserId: 'someone-else' }) },
      { [`spots/${SPOT}`]: liveSpot({ status: 'occupied', claimState: 'arrived_pending_outcome' }) },
      { [`spots/${SPOT}`]: liveSpot({ status: 'occupied', claimState: 'completed_success', interestedUserId: 'someone-else' }) },
    ];
    for (const seed of cases) {
      const { run, db } = harness(seed);
      await expect(run(input())).resolves.toEqual({ outcome: 'already_resolved' });
      expect(db.docs.get(`spots/${SPOT}`)?.status).toBe(seed[`spots/${SPOT}`]?.status);
    }
  });

  it('returns stale_claim only for the current claimant with another generation', async () => {
    const { run, db } = harness({ [`spots/${SPOT}`]: liveSpot() });
    await expect(run(input({ fingerprint: FINGERPRINT - 1 }))).resolves.toEqual({ outcome: 'stale_claim' });
    expect(db.docs.get(`spots/${SPOT}`).interestedUserId).toBe(UID);
    expect(db.docs.get(`spots/${SPOT}`).status).toBe('interested');
  });

  it('cancels the current claim when a legacy null fingerprint is explicit', async () => {
    const { run, db } = harness({ [`spots/${SPOT}`]: liveSpot() });
    await expect(run(input({ fingerprint: null }))).resolves.toEqual({ outcome: 'cancelled' });
    expect(db.docs.get(`spots/${SPOT}`).interestedUserId).toBeNull();
    expect(db.docs.get(`spots/${SPOT}`).status).toBe('available');
  });

  it('lets an explicit null fingerprint cancel a newer claim of the same user', async () => {
    const newer = FINGERPRINT + 50_000;
    const { run, db } = harness({
      [`spots/${SPOT}`]: liveSpot({ claimStartedAt: ts(newer) }),
    });
    await expect(run(input({ fingerprint: FINGERPRINT }))).resolves.toEqual({ outcome: 'stale_claim' });
    expect(db.docs.get(`spots/${SPOT}`).interestedUserId).toBe(UID);
    expect(db.docs.get(`spots/${SPOT}`).claimStartedAt.toMillis()).toBe(newer);
    await expect(run(input({ fingerprint: null }))).resolves.toEqual({ outcome: 'cancelled' });
    expect(db.docs.get(`spots/${SPOT}`).interestedUserId).toBeNull();
    expect(db.docs.get(`spots/${SPOT}`).status).toBe('available');
    expect(db.docs.has(`spotNotifications/claimer_cancelled_${SPOT}_${newer}`)).toBe(true);
  });

  it('does not reopen a Ping whose expiresAt is present but unusable', async () => {
    const malformed = [
      { toMillis() { throw new Error('bad timestamp'); } },
      { toMillis() { return 1.5; } },
      { toMillis() { return Number.NaN; } },
      '2026-01-01',
      {},
    ];
    for (const expiresAt of malformed) {
      const { run, db } = harness({ [`spots/${SPOT}`]: liveSpot({ expiresAt }) });
      await expect(run(input())).resolves.toEqual({ outcome: 'cancelled' });
      const spot = db.docs.get(`spots/${SPOT}`);
      expect(spot.status).toBe('interested');
      expect(spot.interestedUserId).toBeNull();
    }
  });

  it('gives outsiders one identical already_resolved result for private Ping states', async () => {
    const seeds = [
      {},
      { [`spots/${SPOT}`]: liveSpot({ interestedUserId: null, claimState: null, claimStartedAt: null }) },
      { [`spots/${SPOT}`]: liveSpot({ interestedUserId: 'other-claimer' }) },
      { [`spots/${SPOT}`]: liveSpot({ status: 'occupied', claimState: 'arrived_pending_outcome', interestedUserId: 'other-claimer' }) },
      { [`spots/${SPOT}`]: liveSpot({ status: 'occupied', claimState: 'completed_success', interestedUserId: 'other-claimer' }) },
      { [`spots/${SPOT}`]: liveSpot({ status: 'occupied', claimState: 'unconfirmed', interestedUserId: 'other-claimer' }) },
      { [`spots/${SPOT}`]: liveSpot({ status: 'available', interestedUserId: 'other-claimer' }) },
      { [`spots/${SPOT}`]: liveSpot({ status: 'claimed', claimState: 'heading', interestedUserId: 'other-claimer' }) },
    ];
    const results = [];
    for (const seed of seeds) {
      const { run, db } = harness(seed);
      results.push(await run(input()));
      results.push(await run(input({ fingerprint: null })));
      results.push(await run(input({ fingerprint: FINGERPRINT + 99 })));
      expect(db.docs.get(`spots/${SPOT}`)?.status).toBe(seed[`spots/${SPOT}`]?.status);
      expect(db.docs.get(`spots/${SPOT}`)?.interestedUserId).toBe(seed[`spots/${SPOT}`]?.interestedUserId);
    }
    expect(results).toEqual(results.map(() => ({ outcome: 'already_resolved' })));
  });

  it('does not reopen occupied, completed, unconfirmed, or available history', async () => {
    const states = [
      liveSpot({ status: 'occupied', claimState: 'arrived_pending_outcome' }),
      liveSpot({ status: 'occupied', claimState: 'completed_success' }),
      liveSpot({ status: 'occupied', claimState: 'unconfirmed' }),
      liveSpot({ status: 'interested', claimState: 'completed_success' }),
      liveSpot({ status: 'available', claimState: 'heading' }),
      liveSpot({ status: 'claimed', claimState: 'heading' }),
    ];
    for (const spot of states) {
      const { run, db } = harness({ [`spots/${SPOT}`]: spot });
      await expect(run(input({ fingerprint: null }))).resolves.toEqual({ outcome: 'already_resolved' });
      expect(db.docs.get(`spots/${SPOT}`).status).toBe(spot.status);
      expect(db.docs.get(`spots/${SPOT}`).interestedUserId).toBe(UID);
    }
  });

  it('clears all 16 claimer fields and reopens only an unexpired Ping', async () => {
    const seeded = {};
    for (const key of Object.keys(CLEAR_FIELDS)) seeded[key] = key === 'claimStartedAt' ? ts(FINGERPRINT) : 'kept';
    seeded.claimState = 'heading';
    seeded.interestedUserId = UID;
    const { run, db } = harness({
      [`spots/${SPOT}`]: { ...liveSpot(), ...seeded },
      [`users/${UID}/activeIncomingClaims/current`]: { spotId: SPOT },
    });
    await expect(run(input())).resolves.toEqual({ outcome: 'cancelled' });
    const spot = db.docs.get(`spots/${SPOT}`);
    expect(spot.status).toBe('available');
    for (const key of Object.keys(CLEAR_FIELDS)) expect(spot[key]).toBeNull();
    expect(db.docs.has(`users/${UID}/activeIncomingClaims/current`)).toBe(false);
    const note = db.docs.get(`spotNotifications/claimer_cancelled_${SPOT}_${FINGERPRINT}`);
    expect(note.targetUserId).toBe(FINDER);
    expect(note.senderId).toBe(UID);
    expect(note.message).toBe(REASONS.unspecified);
  });

  it('leaves an expired Ping interested and preserves a lock for another Ping', async () => {
    const { run, db } = harness({
      [`spots/${SPOT}`]: liveSpot({ expiresAt: ts(FINGERPRINT - 1) }),
      [`users/${UID}/activeIncomingClaims/current`]: { spotId: 'other-spot' },
      [`users/other-user/activeIncomingClaims/current`]: { spotId: SPOT },
    });
    await expect(run(input())).resolves.toEqual({ outcome: 'cancelled' });
    expect(db.docs.get(`spots/${SPOT}`).status).toBe('interested');
    expect(db.docs.get(`spots/${SPOT}`).interestedUserId).toBeNull();
    expect(db.docs.get(`users/${UID}/activeIncomingClaims/current`).spotId).toBe('other-spot');
    expect(db.docs.get(`users/other-user/activeIncomingClaims/current`).spotId).toBe(SPOT);
  });

  it('accepts a missing lock and fails closed when the notification already exists', async () => {
    const open = harness({ [`spots/${SPOT}`]: liveSpot() });
    await expect(open.run(input())).resolves.toEqual({ outcome: 'cancelled' });

    const id = `claimer_cancelled_${SPOT}_${FINGERPRINT}`;
    const conflict = harness({
      [`spots/${SPOT}`]: liveSpot(),
      [`spotNotifications/${id}`]: { spotId: SPOT, type: 'claimer_cancelled' },
      [`users/${UID}/activeIncomingClaims/current`]: { spotId: SPOT },
    });
    await expect(conflict.run(input())).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(conflict.db.docs.get(`spots/${SPOT}`).status).toBe('interested');
    expect(conflict.db.docs.get(`spots/${SPOT}`).interestedUserId).toBe(UID);
    expect(conflict.db.docs.has(`users/${UID}/activeIncomingClaims/current`)).toBe(true);
  });

  it('does not notify the finder when the caller is the finder', async () => {
    const { run, db } = harness({ [`spots/${SPOT}`]: liveSpot({ finderId: UID }) });
    await expect(run(input())).resolves.toEqual({ outcome: 'cancelled' });
    expect([...db.docs.keys()].some((key) => key.startsWith('spotNotifications/'))).toBe(false);
  });

  it('keeps a lost-response retry and a scheduler-cleared Ping from writing again', async () => {
    const { run, db } = harness({ [`spots/${SPOT}`]: liveSpot() });
    await expect(run(input())).resolves.toEqual({ outcome: 'cancelled' });
    await expect(run(input())).resolves.toEqual({ outcome: 'already_resolved' });
    expect([...db.docs.keys()].filter((key) => key.startsWith('spotNotifications/'))).toHaveLength(1);

    const swept = harness({
      [`spots/${SPOT}`]: liveSpot({ interestedUserId: null, claimState: null, claimStartedAt: null }),
    });
    await expect(swept.run(input({ fingerprint: null }))).resolves.toEqual({ outcome: 'already_resolved' });
    expect([...swept.db.docs.keys()].some((key) => key.startsWith('spotNotifications/'))).toBe(false);
  });

  it('reports a replaced claimant as already_resolved and does not clear that claim', async () => {
    const { run, db } = harness({
      [`spots/${SPOT}`]: liveSpot({ interestedUserId: 'new-claimer', claimStartedAt: ts(FINGERPRINT + 50) }),
    });
    await expect(run(input())).resolves.toEqual({ outcome: 'already_resolved' });
    expect(db.docs.get(`spots/${SPOT}`).interestedUserId).toBe('new-claimer');
  });

  it('surfaces rate-limit and transient Firestore failures without a success outcome', async () => {
    const limited = harness({ [`spots/${SPOT}`]: liveSpot() }, {
      checkRateLimit: async () => { throw new HttpsError('resource-exhausted', 'Too many requests. Try again later.'); },
    });
    await expect(limited.run(input())).rejects.toMatchObject({ code: 'resource-exhausted' });
    expect(limited.db.docs.get(`spots/${SPOT}`).status).toBe('interested');

    const down = memoryDb({ [`spots/${SPOT}`]: liveSpot() });
    down.runTransaction = async () => {
      const error = new Error('unavailable');
      error.code = 'unavailable';
      throw error;
    };
    await expect(cancelClaim(request(input()), {
      db: down,
      checkRateLimit: async () => {},
      now: () => ts(FINGERPRINT),
    })).rejects.toMatchObject({ code: 'unavailable' });

    const denied = memoryDb({ [`spots/${SPOT}`]: liveSpot() });
    denied.runTransaction = async () => {
      const error = new Error('permission-denied');
      error.code = 'permission-denied';
      throw error;
    };
    await expect(cancelClaim(request(input()), {
      db: denied,
      checkRateLimit: async () => {},
      now: () => ts(FINGERPRINT),
    })).rejects.toMatchObject({ code: 'permission-denied' });

    const unexpected = memoryDb({ [`spots/${SPOT}`]: liveSpot() });
    unexpected.runTransaction = async () => { throw new Error('backend exploded'); };
    await expect(cancelClaim(request(input()), {
      db: unexpected,
      checkRateLimit: async () => {},
      now: () => ts(FINGERPRINT),
    })).rejects.toMatchObject({ code: 'internal', message: 'Cancellation could not be completed.' });

    const precondition = memoryDb({ [`spots/${SPOT}`]: liveSpot() });
    precondition.runTransaction = async () => {
      throw new HttpsError('failed-precondition', 'Cancellation could not be completed.');
    };
    await expect(cancelClaim(request(input()), {
      db: precondition,
      checkRateLimit: async () => {},
      now: () => ts(FINGERPRINT),
    })).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});
