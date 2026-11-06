'use strict';

require('./isolatedEmulatorGuard').assertIsolatedEmulator();
const { emulatorOrigin } = require('./isolatedEmulatorGuard');

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { requireEmulatorProjectId } = require('./emulatorProjectId');
const { assertProductAccess, PRODUCT_ACCESS_DENIED } = require('./productAccess');
const { isTokenRevokedForUser, requireCurrentAuthenticatedUser } = require('./adminAuth');
const {
  _suspensionConcurrencyHooks,
  adminSuspendUser,
  adminUnsuspendUser,
} = require('./index.js');

const PROJECT_ID = requireEmulatorProjectId();
const APP_NAME = '__suspension_lease_race__';
const testApp = getApps().find((a) => a.name === APP_NAME) ?? initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const adminAuth = getAuth(testApp);

const uidOf = (label) => `slr_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

function req(uid, data, role) {
  const now = Math.floor(Date.now() / 1000);
  return {
    data,
    auth: { uid, token: { uid, auth_time: now, iat: now, exp: now + 3600, ...(role ? { role } : {}) } },
  };
}

async function runCall(fn, request) {
  try {
    return { result: await fn.run(request) };
  } catch (err) {
    return { error: err };
  }
}

// The caller-visible Auth promise and the server-side disabled bit are
// separate. land() applies a queued mutation after the callable has returned.
function installDetachedAuth(auth) {
  const origUpdate = auth.updateUser.bind(auth);
  const origGet = auth.getUser.bind(auth);
  const calls = [];
  const queued = [];
  let seq = 0;
  const rules = [];
  function effectFor(call) {
    for (let i = rules.length - 1; i >= 0; i -= 1) {
      if (rules[i].match(call)) return rules[i].effect;
    }
    return 'apply';
  }
  auth.updateUser = async (uid, props) => {
    const call = { id: ++seq, uid, disabled: !!(props && props.disabled), landed: false };
    calls.push(call);
    const effect = effectFor(call);
    if (effect === 'apply') {
      call.landed = true;
      return origUpdate(uid, props);
    }
    if (effect === 'apply-then-throw') {
      await origUpdate(uid, props);
      call.landed = true;
      const err = new Error('ack lost');
      err.code = 'auth/internal-error';
      throw err;
    }
    if (effect === 'defer-resolve' || effect === 'defer-timeout') {
      queued.push(call);
      if (effect === 'defer-timeout') {
        const err = new Error('deadline');
        err.code = 'auth/internal-error';
        throw err;
      }
      return { uid };
    }
    if (effect === 'throw') {
      const err = new Error('update failed');
      err.code = 'auth/internal-error';
      throw err;
    }
    if (effect === 'ambiguous') {
      auth.getUser = async (id) => {
        if (id === uid) {
          const err = new Error('readback failed');
          err.code = 'auth/internal-error';
          throw err;
        }
        return origGet(id);
      };
      const err = new Error('ambiguous');
      err.code = 'auth/internal-error';
      throw err;
    }
    throw new Error(`unknown auth effect ${effect}`);
  };
  return {
    calls,
    queued,
    rule(match, effect) { rules.push({ match, effect }); },
    clearRules() { rules.length = 0; },
    async land(id) {
      const call = queued.find((item) => item.id === id);
      if (!call || call.landed) throw new Error(`no deferred auth effect ${id}`);
      await origUpdate(call.uid, { disabled: call.disabled });
      call.landed = true;
    },
    restore() {
      auth.updateUser = origUpdate;
      auth.getUser = origGet;
    },
  };
}

describe('suspension generation fence', () => {
  const cleanup = [];

  afterEach(async () => {
    _suspensionConcurrencyHooks.beforeAuthRpc = null;
    _suspensionConcurrencyHooks.afterAuthRpc = null;
    _suspensionConcurrencyHooks.afterLockAcquired = null;
    _suspensionConcurrencyHooks.acquireAttempts = null;
    for (const uid of cleanup.splice(0)) {
      await adminAuth.deleteUser(uid).catch(() => {});
      await db.recursiveDelete(db.doc(`users/${uid}`)).catch(() => {});
      const logs = await db.collection('adminAuditLog').where('targetUserId', '==', uid).get();
      await Promise.all(logs.docs.map((d) => d.ref.delete()));
    }
  });

  async function user(label, profile) {
    const uid = uidOf(label);
    cleanup.push(uid);
    await adminAuth.createUser({ uid });
    if (profile !== null) await db.doc(`users/${uid}`).set({ id: uid, ...profile });
    return uid;
  }

  async function adminCaller() {
    const uid = await user('admin', null);
    await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
    return uid;
  }

  async function flagDenied(uid) {
    await expect(assertProductAccess(uid)).rejects.toMatchObject({
      code: 'permission-denied',
      message: PRODUCT_ACCESS_DENIED,
    });
  }

  function suspendReq(admin, target, reason = 'spam') {
    return req(admin, { userId: target, reason }, 'admin');
  }

  it('two simultaneous suspends: the live lease rejects the second before Auth', async () => {
    const admin = await adminCaller();
    const target = await user('two', { status: 'Active', username: 't' });
    const auth = getAuth();
    const orig = auth.updateUser.bind(auth);
    const disables = [];
    auth.updateUser = async (uid, props) => {
      if (uid === target && props && props.disabled === true) disables.push(uid);
      return orig(uid, props);
    };
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    let holding = () => {};
    const holdingP = new Promise((resolve) => { holding = resolve; });
    _suspensionConcurrencyHooks.acquireAttempts = 1;
    _suspensionConcurrencyHooks.afterLockAcquired = async () => {
      holding();
      await gate;
    };
    const first = runCall(adminSuspendUser, suspendReq(admin, target));
    try {
      await holdingP;
      const second = await runCall(adminSuspendUser, suspendReq(admin, target, 'other'));
      expect(second.error.code).toBe('aborted');
      expect(second.error.message).toMatch(/in progress/);
      expect(disables).toEqual([]);
      release();
      expect((await first).result).toEqual({ success: true });
      expect(disables).toEqual([target]);
    } finally {
      release();
      auth.updateUser = orig;
    }
    expect((await adminAuth.getUser(target)).disabled).toBe(true);
    expect((await db.doc(`users/${target}`).get()).data().productAccessBlocked).toBe(true);
  });

  it('a live suspend lease rejects unsuspend, and a live unsuspend lease rejects suspend', async () => {
    const admin = await adminCaller();
    const target = await user('race', { status: 'Active', username: 'r' });
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    let holding = () => {};
    const holdingP = new Promise((resolve) => { holding = resolve; });
    _suspensionConcurrencyHooks.acquireAttempts = 1;
    _suspensionConcurrencyHooks.beforeAuthRpc = async () => {
      holding();
      await gate;
    };
    const suspendP = runCall(adminSuspendUser, suspendReq(admin, target));
    await holdingP;
    const unsuspend = await runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'));
    expect(unsuspend.error.code).toBe('aborted');
    expect(unsuspend.error.message).toMatch(/in progress/);
    const mid = (await db.doc(`users/${target}`).get()).data();
    expect(mid.productAccessBlocked).toBe(true);
    expect(mid.status).toBe('Suspended');
    await flagDenied(target);
    release();
    expect((await suspendP).result).toEqual({ success: true });

    _suspensionConcurrencyHooks.beforeAuthRpc = null;
    let release2 = () => {};
    const gate2 = new Promise((resolve) => { release2 = resolve; });
    let holding2 = () => {};
    const holding2P = new Promise((resolve) => { holding2 = resolve; });
    _suspensionConcurrencyHooks.beforeAuthRpc = async ({ op }) => {
      if (op !== 'unsuspend') return;
      holding2();
      await gate2;
    };
    const unsuspendP = runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'));
    await holding2P;
    const again = await runCall(adminSuspendUser, suspendReq(admin, target, 'later'));
    expect(again.error.code).toBe('aborted');
    expect(again.error.message).toMatch(/in progress/);
    expect((await db.doc(`users/${target}`).get()).data().productAccessBlocked).toBe(true);
    await flagDenied(target);
    release2();
    expect((await unsuspendP).result).toEqual({ success: true });
    expect((await db.doc(`users/${target}`).get()).data().productAccessBlocked).toBeUndefined();
  });

  it('an expired lock is taken by a successor at a new generation, and a live lock is not', async () => {
    const admin = await adminCaller();
    const target = await user('gen', { status: 'Active', username: 'g' });
    expect((await runCall(adminSuspendUser, suspendReq(admin, target))).result).toEqual({ success: true });
    const before = (await db.doc(`users/${target}/private/authIntent`).get()).data().generation;
    await db.doc(`users/${target}/private/suspensionLock`).set({
      ownerOperationId: 'stale-owner',
      generation: before,
      authInFlight: 'stale-owner',
      leaseExpiresAt: Timestamp.fromMillis(Date.now() + 60000),
    });
    const blocked = await runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'));
    expect(blocked.error.code).toBe('aborted');
    expect(blocked.error.message).toMatch(/in progress/);
    expect((await db.doc(`users/${target}/private/authIntent`).get()).data().generation).toBe(before);
    expect((await db.doc(`users/${target}`).get()).data().productAccessBlocked).toBe(true);

    await db.doc(`users/${target}/private/suspensionLock`).update({
      leaseExpiresAt: Timestamp.fromMillis(Date.now() - 1000),
    });
    const taken = await runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'));
    expect(taken.result).toEqual({ success: true });
    const intent = (await db.doc(`users/${target}/private/authIntent`).get()).data();
    expect(intent.generation).toBe(before + 1);
    expect(intent.desiredDisabled).toBe(false);
    expect(intent.phase).toBe('confirmed');
    expect((await db.doc(`users/${target}`).get()).data().productAccessBlocked).toBeUndefined();
    expect((await adminAuth.getUser(target)).disabled).toBe(false);
  });

  it('does not clear the flag when the generation changes before completion', async () => {
    const admin = await adminCaller();
    const target = await user('fence', { status: 'Active', username: 'f' });
    expect((await runCall(adminSuspendUser, suspendReq(admin, target))).result).toEqual({ success: true });
    _suspensionConcurrencyHooks.afterAuthRpc = async ({ userId, op }) => {
      if (op !== 'unsuspend') return;
      await db.doc(`users/${userId}/private/suspensionLock`).update({
        generation: 999,
        ownerOperationId: 'successor',
      });
      await db.doc(`users/${userId}/private/authIntent`).update({
        generation: 999,
        desiredDisabled: true,
        phase: 'pending',
      });
    };
    const stale = await runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'));
    expect(stale.error.code).toBe('aborted');
    expect(stale.error.message).toMatch(/ownership lost/i);
    const doc = (await db.doc(`users/${target}`).get()).data();
    expect(doc.productAccessBlocked).toBe(true);
    expect((await adminAuth.getUser(target)).disabled).toBe(true);
    await flagDenied(target);
    const rows = (await db.collection('adminAuditLog').where('targetUserId', '==', target).get()).docs.map((d) => d.data());
    expect(rows.filter((row) => row.action === 'user.unsuspend')).toHaveLength(0);
  });

  it('keeps the flag when Auth update is rejected or the confirm read is ambiguous', async () => {
    const admin = await adminCaller();
    const rejected = await user('rej', { status: 'Active', username: 'j' });
    const auth = getAuth();
    const plane = installDetachedAuth(auth);
    plane.rule((call) => call.uid === rejected && call.disabled === true, 'throw');
    try {
      const failed = await runCall(adminSuspendUser, suspendReq(admin, rejected));
      expect(failed.error.code).toBe('aborted');
      expect(failed.error.message).toMatch(/disabling sign-in failed/i);
      expect(failed.error.message).not.toMatch(/Nothing was changed/);
      expect(failed.error.details.productAccessBlocked).toBe(true);
      const doc = (await db.doc(`users/${rejected}`).get()).data();
      expect(doc.status).toBe('Suspended');
      expect(doc.productAccessBlocked).toBe(true);
      expect((await adminAuth.getUser(rejected)).disabled).toBe(false);
      await flagDenied(rejected);
      plane.clearRules();
      const again = await runCall(adminSuspendUser, suspendReq(admin, rejected));
      expect(again.result).toEqual({ success: true });
      expect((await adminAuth.getUser(rejected)).disabled).toBe(true);
    } finally {
      plane.restore();
    }

    const ambiguous = await user('amb', { status: 'Active', username: 'a' });
    const plane2 = installDetachedAuth(getAuth());
    plane2.rule((call) => call.uid === ambiguous, 'ambiguous');
    try {
      const failed = await runCall(adminSuspendUser, suspendReq(admin, ambiguous));
      expect(failed.error.code).toBe('aborted');
      expect(failed.error.message).toMatch(/could not be confirmed/i);
      expect(failed.error.details.authDisabled).toBeNull();
      expect(failed.error.details.productAccessBlocked).toBe(true);
      expect((await db.doc(`users/${ambiguous}`).get()).data().productAccessBlocked).toBe(true);
      expect((await adminAuth.getUser(ambiguous)).disabled).toBe(false);
      await flagDenied(ambiguous);
    } finally {
      plane2.restore();
    }
  });

  it('retries the same suspend and unsuspend without a second Auth write when state already matches', async () => {
    const admin = await adminCaller();
    const target = await user('idem', { status: 'Active', username: 'i' });
    const auth = getAuth();
    const plane = installDetachedAuth(auth);
    try {
      expect((await runCall(adminSuspendUser, suspendReq(admin, target))).result).toEqual({ success: true });
      const afterFirst = plane.calls.filter((call) => call.uid === target).length;
      expect(afterFirst).toBe(1);
      expect((await runCall(adminSuspendUser, suspendReq(admin, target, 'again'))).result).toEqual({ success: true });
      expect(plane.calls.filter((call) => call.uid === target).length).toBe(afterFirst);
      expect((await db.doc(`users/${target}`).get()).data().productAccessBlocked).toBe(true);
      const suspendAudits = (await db.collection('adminAuditLog').where('targetUserId', '==', target).get()).docs
        .map((d) => d.data())
        .filter((row) => row.action === 'user.suspend');
      expect(suspendAudits).toHaveLength(1);

      expect((await runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'))).result).toEqual({ success: true });
      const afterEnable = plane.calls.filter((call) => call.uid === target).length;
      expect(afterEnable).toBe(afterFirst + 1);
      expect((await runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'))).result).toEqual({ success: true });
      expect(plane.calls.filter((call) => call.uid === target).length).toBe(afterEnable);
      expect((await db.doc(`users/${target}`).get()).data().productAccessBlocked).toBeUndefined();
      expect((await adminAuth.getUser(target)).disabled).toBe(false);
    } finally {
      plane.restore();
    }
  });

  it('denies product access while unsuspend has enabled Auth but not cleared the flag', async () => {
    const admin = await adminCaller();
    const target = await user('pend', { status: 'Active', username: 'p' });
    expect((await runCall(adminSuspendUser, suspendReq(admin, target))).result).toEqual({ success: true });
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    let holding = () => {};
    const holdingP = new Promise((resolve) => { holding = resolve; });
    _suspensionConcurrencyHooks.afterAuthRpc = async ({ op }) => {
      if (op !== 'unsuspend') return;
      holding();
      await gate;
    };
    const pending = runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'));
    await holdingP;
    try {
      expect((await adminAuth.getUser(target)).disabled).toBe(false);
      expect((await db.doc(`users/${target}`).get()).data().productAccessBlocked).toBe(true);
      await flagDenied(target);
    } finally {
      release();
    }
    expect((await pending).result).toEqual({ success: true });
    await expect(assertProductAccess(target)).resolves.toBeUndefined();
  });

  it('C/E residual: a disable accepted before the caller stopped lands after unsuspend', async () => {
    const admin = await adminCaller();
    const target = await user('lateD', { status: 'Active', username: 'd' });
    const auth = getAuth();
    const plane = installDetachedAuth(auth);
    plane.rule((call) => call.uid === target && call.disabled === true && plane.calls.filter((c) => c.uid === target).length === 1, 'defer-timeout');
    try {
      const abandoned = await runCall(adminSuspendUser, suspendReq(admin, target));
      expect(abandoned.error.code).toBe('aborted');
      expect((await adminAuth.getUser(target)).disabled).toBe(false);
      expect((await db.doc(`users/${target}`).get()).data().productAccessBlocked).toBe(true);
      await flagDenied(target);
      const deferred = plane.queued.filter((call) => call.uid === target && !call.landed);
      expect(deferred).toHaveLength(1);

      plane.clearRules();
      const restored = await runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'));
      expect(restored.result).toEqual({ success: true });
      expect((await adminAuth.getUser(target)).disabled).toBe(false);
      expect((await db.doc(`users/${target}`).get()).data().productAccessBlocked).toBeUndefined();

      await plane.land(deferred[0].id);
      expect((await adminAuth.getUser(target)).disabled).toBe(true);
      const defeated = (await db.doc(`users/${target}`).get()).data();
      expect(defeated.productAccessBlocked).toBeUndefined();
      expect(defeated.status).toBe('Active');
      await expect(assertProductAccess(target)).resolves.toBeUndefined();
      const signIn = await fetch(
        `${emulatorOrigin('auth')}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-key`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: await adminAuth.createCustomToken(target), returnSecureToken: true }),
        },
      );
      const body = await signIn.json();
      expect(body.idToken).toBeUndefined();
      expect(JSON.stringify(body)).toMatch(/USER_DISABLED/);

      const repair = await runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'));
      expect(repair.result).toEqual({ success: true });
      expect((await adminAuth.getUser(target)).disabled).toBe(false);
      expect((await db.doc(`users/${target}`).get()).data().productAccessBlocked).toBeUndefined();
    } finally {
      plane.restore();
    }
  });

  it('a late enable after suspend defeats Auth and still denies product until retry', async () => {
    const admin = await adminCaller();
    const target = await user('lateE', { status: 'Active', username: 'e' });
    expect((await runCall(adminSuspendUser, suspendReq(admin, target))).result).toEqual({ success: true });
    const auth = getAuth();
    const plane = installDetachedAuth(auth);
    plane.rule((call) => call.uid === target && call.disabled === false, 'defer-timeout');
    try {
      const abandoned = await runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'));
      expect(abandoned.error.code).toBe('aborted');
      expect((await db.doc(`users/${target}`).get()).data().productAccessBlocked).toBe(true);
      const deferred = plane.queued.filter((call) => call.uid === target && call.disabled === false && !call.landed);
      expect(deferred.length).toBeGreaterThan(0);
      plane.clearRules();
      const resuspended = await runCall(adminSuspendUser, suspendReq(admin, target, 'again'));
      expect(resuspended.result).toEqual({ success: true });
      expect((await adminAuth.getUser(target)).disabled).toBe(true);
      await plane.land(deferred[0].id);
      expect((await adminAuth.getUser(target)).disabled).toBe(false);
      const doc = (await db.doc(`users/${target}`).get()).data();
      expect(doc.status).toBe('Suspended');
      expect(doc.productAccessBlocked).toBe(true);
      await flagDenied(target);
      const repair = await runCall(adminSuspendUser, suspendReq(admin, target, 'repair'));
      expect(repair.result).toEqual({ success: true });
      expect((await adminAuth.getUser(target)).disabled).toBe(true);
      expect((await db.doc(`users/${target}`).get()).data().productAccessBlocked).toBe(true);
      await flagDenied(target);
    } finally {
      plane.restore();
    }
  });

  it('a compensation enable accepted but not applied can land after a later suspend', async () => {
    const admin = await adminCaller();
    const target = await user('comp', { status: 'Active', username: 'c' });
    expect((await runCall(adminSuspendUser, suspendReq(admin, target))).result).toEqual({ success: true });
    const auth = getAuth();
    const plane = installDetachedAuth(auth);
    plane.rule((call) => call.uid === target && call.disabled === false, 'defer-resolve');
    try {
      const unsuspend = await runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'));
      expect(unsuspend.error.code).toBe('aborted');
      expect((await db.doc(`users/${target}`).get()).data().productAccessBlocked).toBe(true);
      expect((await adminAuth.getUser(target)).disabled).toBe(true);
      const deferred = plane.queued.filter((call) => call.uid === target && !call.landed);
      expect(deferred.length).toBeGreaterThan(0);
      plane.clearRules();
      expect((await runCall(adminSuspendUser, suspendReq(admin, target, 'stay'))).result).toEqual({ success: true });
      expect((await adminAuth.getUser(target)).disabled).toBe(true);
      await plane.land(deferred[0].id);
      expect((await adminAuth.getUser(target)).disabled).toBe(false);
      expect((await db.doc(`users/${target}`).get()).data().productAccessBlocked).toBe(true);
      expect((await db.doc(`users/${target}`).get()).data().status).toBe('Suspended');
      await flagDenied(target);
    } finally {
      plane.restore();
    }
  });

  it('A: unsuspend does not issue a repair disable for the suspend intent it replaces', async () => {
    const admin = await adminCaller();
    const target = await user('skipA', { status: 'Active', username: 'a' });
    expect((await runCall(adminSuspendUser, suspendReq(admin, target))).result).toEqual({ success: true });
    await adminAuth.updateUser(target, { disabled: false });
    const plane = installDetachedAuth(getAuth());
    plane.rule((call) => call.uid === target && call.disabled === true, 'defer-timeout');
    try {
      const restored = await runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'));
      expect(restored.result).toEqual({ success: true });
      expect(plane.calls.filter((call) => call.uid === target && call.disabled === true)).toEqual([]);
      expect(plane.queued.filter((call) => call.uid === target && call.disabled === true)).toEqual([]);
      expect(plane.calls.some((call) => call.uid === target && call.disabled === false)).toBe(true);
      expect((await adminAuth.getUser(target)).disabled).toBe(false);
      expect((await db.doc(`users/${target}`).get()).data().productAccessBlocked).toBeUndefined();
      expect((await db.doc(`users/${target}`).get()).data().status).toBe('Active');
    } finally {
      plane.restore();
    }
  });

  it('B: a stale suspend cannot put the flag back after a successor unsuspend', async () => {
    const admin = await adminCaller();
    const target = await user('staleB', { status: 'Active', username: 'b' });
    const auth = getAuth();
    const orig = auth.updateUser.bind(auth);
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    let started = () => {};
    const startedP = new Promise((resolve) => { started = resolve; });
    let held = false;
    let released = false;
    auth.updateUser = async (uid, props) => {
      if (uid === target && props && props.disabled === true && !held) {
        held = true;
        started();
        await gate;
        released = true;
        return orig(uid, props);
      }
      if (released && uid === target && props && props.disabled === false) {
        throw Object.assign(new Error('stale compensate'), { code: 'auth/internal-error' });
      }
      return orig(uid, props);
    };
    const staleP = runCall(adminSuspendUser, suspendReq(admin, target));
    try {
      await startedP;
      const lock = await db.doc(`users/${target}/private/suspensionLock`).get();
      expect(lock.exists).toBe(true);
      await lock.ref.update({ leaseExpiresAt: Timestamp.fromMillis(Date.now() - 1000) });
      const successor = await runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'));
      expect(successor.result).toEqual({ success: true });
      const mid = (await db.doc(`users/${target}`).get()).data();
      expect(mid.status).toBe('Active');
      expect(mid.productAccessBlocked).toBeUndefined();
      const successorGen = (await db.doc(`users/${target}/private/authIntent`).get()).data().generation;
      release();
      const stale = await staleP;
      expect(stale.error.code).toBe('aborted');
      expect(stale.error.message).toMatch(/ownership lost/i);
      const finalDoc = (await db.doc(`users/${target}`).get()).data();
      expect(finalDoc.status).toBe('Active');
      expect(finalDoc.productAccessBlocked).toBeUndefined();
      const intent = (await db.doc(`users/${target}/private/authIntent`).get()).data();
      expect(intent.generation).toBe(successorGen);
      expect(intent.desiredDisabled).toBe(false);
      expect(intent.phase).toBe('confirmed');
      await expect(assertProductAccess(target)).resolves.toBeUndefined();
    } finally {
      release();
      auth.updateUser = orig;
    }
  });

  it('C: a same-direction suspend retry repairs Auth and does not enable', async () => {
    const admin = await adminCaller();
    const target = await user('retryC', { status: 'Active', username: 'c' });
    expect((await runCall(adminSuspendUser, suspendReq(admin, target))).result).toEqual({ success: true });
    await adminAuth.updateUser(target, { disabled: false });
    expect((await db.doc(`users/${target}/private/authIntent`).get()).data().desiredDisabled).toBe(true);
    const plane = installDetachedAuth(getAuth());
    plane.rule((call) => call.uid === target && call.disabled === false, 'defer-timeout');
    try {
      const repair = await runCall(adminSuspendUser, suspendReq(admin, target, 'repair'));
      expect(repair.result).toEqual({ success: true });
      const calls = plane.calls.filter((call) => call.uid === target);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((call) => call.disabled === true)).toBe(true);
      expect(plane.queued.filter((call) => call.uid === target && call.disabled === false)).toEqual([]);
      expect((await adminAuth.getUser(target)).disabled).toBe(true);
      const doc = (await db.doc(`users/${target}`).get()).data();
      expect(doc.status).toBe('Suspended');
      expect(doc.productAccessBlocked).toBe(true);
      await flagDenied(target);
    } finally {
      plane.restore();
    }
  });

  function authTimeFromIdToken(idToken) {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    if (typeof payload.auth_time !== 'number') throw new Error('id token has no auth_time');
    return payload.auth_time;
  }

  async function signIn(uid) {
    const resp = await fetch(
      `${emulatorOrigin('auth')}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-key`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: await adminAuth.createCustomToken(uid), returnSecureToken: true }),
      },
    );
    return resp.json();
  }

  it('live repair: a held same-direction disable blocks unsuspend and does not leave a split', async () => {
    const admin = await adminCaller();
    const target = await user('liveRepair', { status: 'Active', username: 'lr' });
    expect((await runCall(adminSuspendUser, suspendReq(admin, target))).result).toEqual({ success: true });
    await adminAuth.updateUser(target, { disabled: false });
    const auth = getAuth();
    const orig = auth.updateUser.bind(auth);
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    let started = () => {};
    const startedP = new Promise((resolve) => { started = resolve; });
    const seen = [];
    auth.updateUser = async (uid, props) => {
      if (uid === target) seen.push(!!(props && props.disabled));
      if (uid === target && props && props.disabled === true) {
        started();
        await gate;
      }
      return orig(uid, props);
    };
    const repairP = runCall(adminSuspendUser, suspendReq(admin, target, 'repair'));
    try {
      await startedP;
      const lock = await db.doc(`users/${target}/private/suspensionLock`).get();
      expect(lock.exists).toBe(true);
      expect((await adminAuth.getUser(target)).disabled).toBe(false);
      const successor = await runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'));
      expect(successor.error.code).toBe('aborted');
      expect(successor.error.message).toMatch(/in progress/);
      const during = (await db.doc(`users/${target}`).get()).data();
      expect(during.status).toBe('Suspended');
      expect(during.productAccessBlocked).toBe(true);
      release();
      const repair = await repairP;
      expect(repair.result).toEqual({ success: true });
      expect(seen.includes(false)).toBe(false);
      expect((await adminAuth.getUser(target)).disabled).toBe(true);
      const doc = (await db.doc(`users/${target}`).get()).data();
      expect(doc.status).toBe('Suspended');
      expect(doc.productAccessBlocked).toBe(true);
      const intent = (await db.doc(`users/${target}/private/authIntent`).get()).data();
      expect(intent.desiredDisabled).toBe(true);
      expect(intent.phase).toBe('confirmed');
      await flagDenied(target);
      const body = await signIn(target);
      expect(body.idToken).toBeUndefined();
      expect(JSON.stringify(body)).toMatch(/USER_DISABLED/);
    } finally {
      release();
      auth.updateUser = orig;
    }
  });

  it('live repair: a stolen lease is compensated once and is not reported as success', async () => {
    const admin = await adminCaller();
    const target = await user('stolenRepair', { status: 'Active', username: 'sr' });
    expect((await runCall(adminSuspendUser, suspendReq(admin, target))).result).toEqual({ success: true });
    await adminAuth.updateUser(target, { disabled: false });
    const auth = getAuth();
    const orig = auth.updateUser.bind(auth);
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    let started = () => {};
    const startedP = new Promise((resolve) => { started = resolve; });
    let held = false;
    auth.updateUser = async (uid, props) => {
      if (uid === target && props && props.disabled === true && !held) {
        held = true;
        started();
        await gate;
      }
      return orig(uid, props);
    };
    const repairP = runCall(adminSuspendUser, suspendReq(admin, target, 'repair'));
    try {
      await startedP;
      const lock = await db.doc(`users/${target}/private/suspensionLock`).get();
      expect(lock.exists).toBe(true);
      await lock.ref.update({ leaseExpiresAt: Timestamp.fromMillis(Date.now() - 1000) });
      const successor = await runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'));
      expect(successor.result).toEqual({ success: true });
      const mid = (await db.doc(`users/${target}`).get()).data();
      expect(mid.status).toBe('Active');
      expect(mid.productAccessBlocked).toBeUndefined();
      release();
      const repair = await repairP;
      expect(repair.result).toBeUndefined();
      expect(repair.error.code).toBe('aborted');
      expect(repair.error.message).toMatch(/ownership lost/i);
      expect(repair.error.message).not.toMatch(/access block was kept/i);
      expect((await adminAuth.getUser(target)).disabled).toBe(false);
      const doc = (await db.doc(`users/${target}`).get()).data();
      expect(doc.status).toBe('Active');
      expect(doc.productAccessBlocked).toBeUndefined();
      const intent = (await db.doc(`users/${target}/private/authIntent`).get()).data();
      expect(intent.desiredDisabled).toBe(false);
      expect(intent.phase).toBe('confirmed');
      await expect(assertProductAccess(target)).resolves.toBeUndefined();
      const body = await signIn(target);
      expect(body.idToken).toBeTruthy();
      expect(JSON.stringify(body)).not.toMatch(/USER_DISABLED/);
    } finally {
      release();
      auth.updateUser = orig;
    }
  });

  it('residual: a detached repair disable lands after a successor unsuspend', async () => {
    const admin = await adminCaller();
    const target = await user('detachD', { status: 'Active', username: 'dd' });
    expect((await runCall(adminSuspendUser, suspendReq(admin, target))).result).toEqual({ success: true });
    await adminAuth.updateUser(target, { disabled: false });
    const plane = installDetachedAuth(getAuth());
    plane.rule((call) => call.uid === target && call.disabled === true, 'defer-timeout');
    try {
      const repair = await runCall(adminSuspendUser, suspendReq(admin, target, 'repair'));
      expect(repair.error.code).toBe('aborted');
      expect(repair.result).toBeUndefined();
      const deferred = plane.queued.filter((call) => call.uid === target && call.disabled === true && !call.landed);
      expect(deferred).toHaveLength(1);
      plane.clearRules();
      const restored = await runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'));
      expect(restored.result).toEqual({ success: true });
      expect((await adminAuth.getUser(target)).disabled).toBe(false);
      expect((await db.doc(`users/${target}`).get()).data().productAccessBlocked).toBeUndefined();
      await plane.land(deferred[0].id);
      expect((await adminAuth.getUser(target)).disabled).toBe(true);
      const defeated = (await db.doc(`users/${target}`).get()).data();
      expect(defeated.status).toBe('Active');
      expect(defeated.productAccessBlocked).toBeUndefined();
      await expect(assertProductAccess(target)).resolves.toBeUndefined();
      const body = await signIn(target);
      expect(body.idToken).toBeUndefined();
      expect(JSON.stringify(body)).toMatch(/USER_DISABLED/);
    } finally {
      plane.restore();
    }
  });

  it('residual: a detached repair enable lands after a successor suspend', async () => {
    const admin = await adminCaller();
    const target = await user('detachE', { status: 'Active', username: 'de' });
    expect((await runCall(adminSuspendUser, suspendReq(admin, target))).result).toEqual({ success: true });
    expect((await runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'))).result).toEqual({ success: true });
    await adminAuth.updateUser(target, { disabled: true });
    const plane = installDetachedAuth(getAuth());
    plane.rule((call) => call.uid === target && call.disabled === false, 'defer-timeout');
    try {
      const repair = await runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'));
      expect(repair.error.code).toBe('aborted');
      expect(repair.result).toBeUndefined();
      const deferred = plane.queued.filter((call) => call.uid === target && call.disabled === false && !call.landed);
      expect(deferred).toHaveLength(1);
      plane.clearRules();
      const resuspended = await runCall(adminSuspendUser, suspendReq(admin, target, 'again'));
      expect(resuspended.result).toEqual({ success: true });
      expect((await adminAuth.getUser(target)).disabled).toBe(true);
      await plane.land(deferred[0].id);
      expect((await adminAuth.getUser(target)).disabled).toBe(false);
      const doc = (await db.doc(`users/${target}`).get()).data();
      expect(doc.status).toBe('Suspended');
      expect(doc.productAccessBlocked).toBe(true);
      await flagDenied(target);
    } finally {
      plane.restore();
    }
  });

  it('repair suspend revokes the session minted while Auth was enabled', async () => {
    const admin = await adminCaller();
    const target = await user('revokeR', { status: 'Active', username: 'rv' });
    expect((await runCall(adminSuspendUser, suspendReq(admin, target))).result).toEqual({ success: true });
    await adminAuth.updateUser(target, { disabled: false });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const session = await signIn(target);
    expect(session.idToken).toBeTruthy();
    const authTime = authTimeFromIdToken(session.idToken);
    const during = await adminAuth.getUser(target);
    expect(isTokenRevokedForUser({ auth_time: authTime }, during)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const repair = await runCall(adminSuspendUser, suspendReq(admin, target, 'repair'));
    expect(repair.result).toEqual({ success: true });
    const after = await adminAuth.getUser(target);
    expect(after.disabled).toBe(true);
    expect(Date.parse(after.tokensValidAfterTime)).toBeGreaterThan(Date.parse(during.tokensValidAfterTime));
    expect(isTokenRevokedForUser({ auth_time: authTime }, after)).toBe(true);
    const doc = (await db.doc(`users/${target}`).get()).data();
    expect(doc.status).toBe('Suspended');
    expect(doc.productAccessBlocked).toBe(true);
    await flagDenied(target);
    // The disabled check rejects before the revocation check. Re-enable through
    // the named test app so requireCurrentAuthenticatedUser reaches the
    // application's tokensValidAfterTime comparison.
    await adminAuth.updateUser(target, { disabled: false });
    const rejected = await requireCurrentAuthenticatedUser({
      auth: { uid: target, token: { uid: target, auth_time: authTime } },
    }).then(() => null, (err) => err);
    expect(rejected).toMatchObject({ code: 'permission-denied', message: 'Session no longer valid.' });
    expect(isTokenRevokedForUser({ auth_time: authTime }, await adminAuth.getUser(target))).toBe(true);
  });
});
