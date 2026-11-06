'use strict';

require('./isolatedEmulatorGuard').assertIsolatedEmulator();

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { requireEmulatorProjectId } = require('./emulatorProjectId');
const { assertProductAccess } = require('./productAccess');
const { adminSuspendUser, adminUnsuspendUser } = require('./index.js');
const { hooks, reconcileAuthReplica } = require('./suspensionAccess');

const PROJECT_ID = requireEmulatorProjectId();
const APP_NAME = '__auth_replica_reconcile__';
const testApp = getApps().find((app) => app.name === APP_NAME) ?? initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const adminAuth = getAuth(testApp);
const uidOf = (label) => `recon_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

function req(uid, data) {
  const now = Math.floor(Date.now() / 1000);
  return { data, auth: { uid, token: { uid, auth_time: now, iat: now, exp: now + 3600, role: 'admin' } } };
}

async function runCall(fn, request) {
  try {
    return { result: await fn.run(request) };
  } catch (error) {
    return { error };
  }
}

function installDetachedAuth(auth) {
  const origUpdate = auth.updateUser.bind(auth);
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
    if (effect === 'defer-timeout') {
      queued.push(call);
      const error = new Error('deadline');
      error.code = 'auth/internal-error';
      throw error;
    }
    if (effect === 'throw') {
      const error = new Error('update failed');
      error.code = 'auth/internal-error';
      throw error;
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
    restore() { auth.updateUser = origUpdate; },
  };
}

describe('auth replica reconciliation', () => {
  const cleanup = [];

  afterEach(async () => {
    hooks.beforeRepairDecision = null;
    hooks.afterRepairAuthorized = null;
    for (const uid of cleanup.splice(0)) {
      await adminAuth.deleteUser(uid).catch(() => {});
      await db.recursiveDelete(db.doc(`users/${uid}`)).catch(() => {});
      await db.doc(`accountDeletionJobs/${uid}`).delete().catch(() => {});
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

  function suspendReq(admin, target, reason = 'spam') {
    return req(admin, { userId: target, reason });
  }

  async function projection(uid) {
    const data = (await db.doc(`users/${uid}`).get()).data() || {};
    return {
      status: data.status ?? null,
      productAccessBlocked: Object.prototype.hasOwnProperty.call(data, 'productAccessBlocked')
        ? data.productAccessBlocked
        : null,
    };
  }

  async function intentOf(uid) {
    const snap = await db.doc(`users/${uid}/private/authIntent`).get();
    return snap.exists ? snap.data() : null;
  }

  it('A: a late disable after a confirmed unsuspend is repaired without rewriting product access', async () => {
    const admin = await adminCaller();
    const target = await user('lateD', { status: 'Active', username: 'd' });
    const plane = installDetachedAuth(getAuth());
    plane.rule((call) => call.uid === target && call.disabled === true && plane.calls.filter((item) => item.uid === target).length === 1, 'defer-timeout');
    try {
      const abandoned = await runCall(adminSuspendUser, suspendReq(admin, target));
      expect(abandoned.error.code).toBe('aborted');
      const deferred = plane.queued.filter((call) => call.uid === target && !call.landed);
      expect(deferred).toHaveLength(1);
      plane.clearRules();
      const restored = await runCall(adminUnsuspendUser, req(admin, { userId: target }));
      expect(restored.result).toEqual({ success: true });
      const beforeLand = await projection(target);
      const beforeIntent = await intentOf(target);
      await plane.land(deferred[0].id);
      expect((await adminAuth.getUser(target)).disabled).toBe(true);
      expect(await projection(target)).toEqual({ status: 'Active', productAccessBlocked: null });
      await expect(assertProductAccess(target)).resolves.toBeUndefined();

      const repaired = await reconcileAuthReplica(target);
      expect(repaired.outcome).toBe('repaired');
      expect(repaired.issued).toBe(true);
      expect(repaired.stable).toBe(false);
      expect(repaired.retractable).toBe(false);
      expect((await adminAuth.getUser(target)).disabled).toBe(false);
      expect(await projection(target)).toEqual(beforeLand);
      expect(await intentOf(target)).toEqual(beforeIntent);
      await expect(assertProductAccess(target)).resolves.toBeUndefined();
    } finally {
      plane.restore();
    }
  });

  it('B: a late enable after a confirmed suspend is repaired without clearing the denial', async () => {
    const admin = await adminCaller();
    const target = await user('lateE', { status: 'Active', username: 'e' });
    expect((await runCall(adminSuspendUser, suspendReq(admin, target))).result).toEqual({ success: true });
    const plane = installDetachedAuth(getAuth());
    plane.rule((call) => call.uid === target && call.disabled === false, 'defer-timeout');
    try {
      const abandoned = await runCall(adminUnsuspendUser, req(admin, { userId: target }));
      expect(abandoned.error.code).toBe('aborted');
      const deferred = plane.queued.filter((call) => call.uid === target && call.disabled === false && !call.landed);
      expect(deferred.length).toBeGreaterThan(0);
      plane.clearRules();
      const resuspended = await runCall(adminSuspendUser, suspendReq(admin, target, 'again'));
      expect(resuspended.result).toEqual({ success: true });
      const beforeLand = await projection(target);
      const beforeIntent = await intentOf(target);
      await plane.land(deferred[0].id);
      expect((await adminAuth.getUser(target)).disabled).toBe(false);
      expect(await projection(target)).toEqual({ status: 'Suspended', productAccessBlocked: true });

      const repaired = await reconcileAuthReplica(target);
      expect(repaired.outcome).toBe('repaired');
      expect(repaired.issued).toBe(true);
      expect(repaired.stable).toBe(false);
      expect((await adminAuth.getUser(target)).disabled).toBe(true);
      expect(await projection(target)).toEqual(beforeLand);
      expect(await intentOf(target)).toEqual(beforeIntent);
      await expect(assertProductAccess(target)).rejects.toMatchObject({ code: 'permission-denied' });
    } finally {
      plane.restore();
    }
  });

  it('C: a repair whose generation moves cannot record success or retract its Auth write', async () => {
    const admin = await adminCaller();
    const target = await user('move', { status: 'Active', username: 'm' });
    expect((await runCall(adminSuspendUser, suspendReq(admin, target))).result).toEqual({ success: true });
    await adminAuth.updateUser(target, { disabled: false });
    const starting = await intentOf(target);
    const auth = getAuth();
    const orig = auth.updateUser.bind(auth);
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    let started = () => {};
    const startedP = new Promise((resolve) => { started = resolve; });
    auth.updateUser = async (uid, props) => {
      if (uid === target && props && props.disabled === true) {
        started();
        await gate;
      }
      return orig(uid, props);
    };
    const repairP = reconcileAuthReplica(target);
    try {
      await startedP;
      await db.doc(`users/${target}`).update({
        status: 'Active',
        productAccessBlocked: FieldValue.delete(),
      });
      await db.doc(`users/${target}/private/authIntent`).update({
        generation: starting.generation + 1,
        desiredDisabled: false,
        phase: 'confirmed',
      });
      const newer = await projection(target);
      const newerIntent = await intentOf(target);
      release();
      const repair = await repairP;
      expect(repair.outcome).toBe('superseded');
      expect(repair.issued).toBe(true);
      expect(repair.retractable).toBe(false);
      expect(repair.stable).toBe(false);
      expect((await adminAuth.getUser(target)).disabled).toBe(true);
      expect(await projection(target)).toEqual(newer);
      expect(await intentOf(target)).toEqual(newerIntent);
    } finally {
      release();
      auth.updateUser = orig;
    }
  });

  it('D: a matched repair returns before a stale accepted disable, and a later pass corrects it', async () => {
    const admin = await adminCaller();
    const target = await user('delay', { status: 'Active', username: 'y' });
    expect((await runCall(adminSuspendUser, suspendReq(admin, target))).result).toEqual({ success: true });
    expect((await runCall(adminUnsuspendUser, req(admin, { userId: target }))).result).toEqual({ success: true });
    const before = await projection(target);
    const beforeIntent = await intentOf(target);
    const plane = installDetachedAuth(getAuth());
    plane.rule((call) => call.uid === target && call.disabled === true, 'defer-timeout');
    try {
      await expect(getAuth().updateUser(target, { disabled: true })).rejects.toMatchObject({ code: 'auth/internal-error' });
      const deferred = plane.queued.filter((call) => call.uid === target && !call.landed);
      expect(deferred).toHaveLength(1);
      const matched = await reconcileAuthReplica(target);
      expect(matched.outcome).toBe('matched');
      expect(matched.issued).toBe(false);
      expect(matched.stable).toBe(false);
      expect((await adminAuth.getUser(target)).disabled).toBe(false);
      await plane.land(deferred[0].id);
      expect((await adminAuth.getUser(target)).disabled).toBe(true);
      expect(await projection(target)).toEqual(before);
      plane.clearRules();
      const repaired = await reconcileAuthReplica(target);
      expect(repaired.outcome).toBe('repaired');
      expect(repaired.issued).toBe(true);
      expect(repaired.stable).toBe(false);
      expect((await adminAuth.getUser(target)).disabled).toBe(false);
      expect(await projection(target)).toEqual(before);
      expect(await intentOf(target)).toEqual(beforeIntent);
    } finally {
      plane.restore();
    }
  });

  it('E: malformed, missing, deleting, and leased accounts are not given an invented enable', async () => {
    const admin = await adminCaller();
    const malformed = await user('bad', { status: 'Active', username: 'b' });
    await adminAuth.updateUser(malformed, { disabled: true });
    await db.doc(`users/${malformed}/private/authIntent`).set({
      generation: '1',
      desiredDisabled: true,
      phase: 'pending',
    });
    const malformedResult = await reconcileAuthReplica(malformed);
    expect(malformedResult.outcome).toBe('refused');
    expect(malformedResult.issued).toBe(false);
    expect((await adminAuth.getUser(malformed)).disabled).toBe(true);

    const missingIntent = await user('none', { status: 'Active', username: 'n' });
    await adminAuth.updateUser(missingIntent, { disabled: true });
    const missingResult = await reconcileAuthReplica(missingIntent);
    expect(missingResult.outcome).toBe('refused');
    expect(missingResult.issued).toBe(false);
    expect((await adminAuth.getUser(missingIntent)).disabled).toBe(true);

    const noProfile = uidOf('ghost');
    cleanup.push(noProfile);
    await adminAuth.createUser({ uid: noProfile, disabled: false });
    expect((await reconcileAuthReplica(noProfile)).outcome).toBe('refused');
    expect((await adminAuth.getUser(noProfile)).disabled).toBe(false);

    const deleting = await user('del', { status: 'Suspended', username: 'z' });
    expect((await runCall(adminSuspendUser, suspendReq(admin, deleting))).result).toEqual({ success: true });
    await adminAuth.updateUser(deleting, { disabled: false });
    await db.doc(`accountDeletionJobs/${deleting}`).set({ state: 'running', leaseAt: Timestamp.now() });
    const deletion = await reconcileAuthReplica(deleting);
    expect(deletion.outcome).toBe('deletion');
    expect(deletion.issued).toBe(false);
    expect((await adminAuth.getUser(deleting)).disabled).toBe(false);
    expect((await projection(deleting)).productAccessBlocked).toBe(true);

    const completed = await user('done', { status: 'Active', username: 'c' });
    await db.doc(`users/${completed}/private/authIntent`).set({
      generation: 1,
      desiredDisabled: false,
      phase: 'confirmed',
    });
    await adminAuth.updateUser(completed, { disabled: true });
    await db.doc(`accountDeletionJobs/${completed}`).set({ state: 'completed' });
    const completedResult = await reconcileAuthReplica(completed);
    expect(completedResult.outcome).toBe('deletion');
    expect(completedResult.issued).toBe(false);
    expect((await adminAuth.getUser(completed)).disabled).toBe(true);

    const leased = await user('lease', { status: 'Active', username: 'l' });
    expect((await runCall(adminSuspendUser, suspendReq(admin, leased))).result).toEqual({ success: true });
    await adminAuth.updateUser(leased, { disabled: false });
    const generation = (await intentOf(leased)).generation;
    await db.doc(`users/${leased}/private/suspensionLock`).set({
      ownerOperationId: 'other-owner',
      generation,
      leaseExpiresAt: Timestamp.fromMillis(Date.now() + 60000),
    });
    const held = await reconcileAuthReplica(leased);
    expect(held.outcome).toBe('lease-held');
    expect(held.issued).toBe(false);
    expect((await adminAuth.getUser(leased)).disabled).toBe(false);
    expect((await projection(leased)).status).toBe('Suspended');

    await db.doc(`users/${leased}/private/suspensionLock`).update({
      leaseExpiresAt: Timestamp.fromMillis(Date.now() - 1000),
    });
    const expired = await reconcileAuthReplica(leased);
    expect(expired.outcome).toBe('repaired');
    expect(expired.issued).toBe(true);
    expect(expired.stable).toBe(false);
    expect((await adminAuth.getUser(leased)).disabled).toBe(true);
    expect(await projection(leased)).toEqual({ status: 'Suspended', productAccessBlocked: true });

    const failing = await user('fail', { status: 'Active', username: 'f' });
    expect((await runCall(adminSuspendUser, suspendReq(admin, failing))).result).toEqual({ success: true });
    await adminAuth.updateUser(failing, { disabled: false });
    const savedIntent = await intentOf(failing);
    const auth = getAuth();
    const orig = auth.updateUser.bind(auth);
    auth.updateUser = async () => {
      const error = new Error('update failed');
      error.code = 'auth/internal-error';
      throw error;
    };
    const failed = await reconcileAuthReplica(failing);
    auth.updateUser = orig;
    expect(failed.outcome).toBe('rejected');
    expect(failed.issued).toBe(true);
    expect(failed.stable).toBe(false);
    expect((await adminAuth.getUser(failing)).disabled).toBe(false);
    expect(await intentOf(failing)).toEqual(savedIntent);
    const recovered = await reconcileAuthReplica(failing);
    expect(recovered.outcome).toBe('repaired');
    expect((await adminAuth.getUser(failing)).disabled).toBe(true);
    expect((await projection(failing)).productAccessBlocked).toBe(true);
  });

  async function seedEnableIntent(uid, { phase, status, blocked, generation = 4 }) {
    const profile = { status };
    if (blocked) profile.productAccessBlocked = true;
    await db.doc(`users/${uid}`).set({ id: uid, username: 'gate', ...profile });
    await db.doc(`users/${uid}/private/authIntent`).set({
      generation,
      desiredDisabled: false,
      phase,
      ownerOperationId: 'seed',
    });
    await db.doc(`users/${uid}/private/suspensionLock`).set({
      ownerOperationId: 'expired-owner',
      generation,
      leaseExpiresAt: Timestamp.fromMillis(Date.now() - 1000),
    });
    await adminAuth.updateUser(uid, { disabled: true });
  }

  it('F: a pending unsuspend does not enable Auth', async () => {
    const target = await user('pending', null);
    await seedEnableIntent(target, { phase: 'pending', status: 'Active', blocked: true });
    const before = await projection(target);
    const beforeIntent = await intentOf(target);
    const calls = [];
    const auth = getAuth();
    const orig = auth.updateUser.bind(auth);
    auth.updateUser = async (uid, props) => {
      calls.push(props);
      return orig(uid, props);
    };
    try {
      const result = await reconcileAuthReplica(target);
      expect(result.outcome).toBe('ineligible');
      expect(result.issued).toBe(false);
      expect(calls).toEqual([]);
      expect((await adminAuth.getUser(target)).disabled).toBe(true);
      expect(await projection(target)).toEqual(before);
      expect(await intentOf(target)).toEqual(beforeIntent);
    } finally {
      auth.updateUser = orig;
    }
  });

  it('G: a confirmed enable intent with a denial or a suspended profile does not enable', async () => {
    const flagged = await user('flagged', null);
    await seedEnableIntent(flagged, { phase: 'confirmed', status: 'Active', blocked: true });
    const suspended = await user('held', null);
    await seedEnableIntent(suspended, { phase: 'confirmed', status: 'Suspended', blocked: false });
    const calls = [];
    const auth = getAuth();
    const orig = auth.updateUser.bind(auth);
    auth.updateUser = async (uid, props) => {
      calls.push({ uid, disabled: props && props.disabled });
      return orig(uid, props);
    };
    try {
      const flaggedResult = await reconcileAuthReplica(flagged);
      const suspendedResult = await reconcileAuthReplica(suspended);
      expect(flaggedResult.outcome).toBe('ineligible');
      expect(suspendedResult.outcome).toBe('ineligible');
      expect(flaggedResult.issued).toBe(false);
      expect(suspendedResult.issued).toBe(false);
      expect(calls).toEqual([]);
      expect((await adminAuth.getUser(flagged)).disabled).toBe(true);
      expect((await adminAuth.getUser(suspended)).disabled).toBe(true);
      expect(await projection(flagged)).toEqual({ status: 'Active', productAccessBlocked: true });
      expect(await projection(suspended)).toEqual({ status: 'Suspended', productAccessBlocked: null });
    } finally {
      auth.updateUser = orig;
    }
  });

  it('H: a confirmed Active account with no denial can repair a late disable', async () => {
    const admin = await adminCaller();
    const target = await user('ready', { status: 'Active', username: 'h' });
    const plane = installDetachedAuth(getAuth());
    plane.rule((call) => call.uid === target && call.disabled === true && plane.calls.filter((item) => item.uid === target).length === 1, 'defer-timeout');
    try {
      expect((await runCall(adminSuspendUser, suspendReq(admin, target))).error.code).toBe('aborted');
      const deferred = plane.queued.filter((call) => call.uid === target && !call.landed);
      expect(deferred).toHaveLength(1);
      plane.clearRules();
      expect((await runCall(adminUnsuspendUser, req(admin, { userId: target }))).result).toEqual({ success: true });
      const before = await projection(target);
      const beforeIntent = await intentOf(target);
      expect(before).toEqual({ status: 'Active', productAccessBlocked: null });
      expect(beforeIntent.phase).toBe('confirmed');
      expect(beforeIntent.desiredDisabled).toBe(false);
      await plane.land(deferred[0].id);
      expect((await adminAuth.getUser(target)).disabled).toBe(true);
      const repaired = await reconcileAuthReplica(target);
      expect(repaired.outcome).toBe('repaired');
      expect(repaired.issued).toBe(true);
      expect(repaired.stable).toBe(false);
      expect((await adminAuth.getUser(target)).disabled).toBe(false);
      expect(await projection(target)).toEqual(before);
      expect(await intentOf(target)).toEqual(beforeIntent);
    } finally {
      plane.restore();
    }
  });

  it('I: a deletion job created before the pre-RPC decision prevents the Auth write', async () => {
    const target = await user('gap', { status: 'Active', username: 'i' });
    await seedEnableIntent(target, { phase: 'confirmed', status: 'Active', blocked: false });
    const before = await projection(target);
    const job = { state: 'running', leaseAt: Timestamp.now() };
    hooks.beforeRepairDecision = async ({ userId }) => {
      await db.doc(`accountDeletionJobs/${userId}`).set(job);
    };
    const calls = [];
    const auth = getAuth();
    const orig = auth.updateUser.bind(auth);
    auth.updateUser = async (uid, props) => {
      calls.push(props);
      return orig(uid, props);
    };
    try {
      const result = await reconcileAuthReplica(target);
      expect(result.outcome).toBe('deletion');
      expect(result.issued).toBe(false);
      expect(calls).toEqual([]);
      expect((await adminAuth.getUser(target)).disabled).toBe(true);
      expect((await db.doc(`accountDeletionJobs/${target}`).get()).data()).toMatchObject({ state: 'running' });
      expect(await projection(target)).toEqual(before);
    } finally {
      auth.updateUser = orig;
    }
  });

  it('J: a deletion job created after the final check does not stop an already authorized RPC', async () => {
    const target = await user('lateJob', { status: 'Active', username: 'j' });
    await seedEnableIntent(target, { phase: 'confirmed', status: 'Active', blocked: false });
    const before = await projection(target);
    const job = { state: 'running', marker: 'after-final-check' };
    hooks.afterRepairAuthorized = async ({ userId }) => {
      await db.doc(`accountDeletionJobs/${userId}`).set(job);
    };
    const result = await reconcileAuthReplica(target);
    expect(result.outcome).toBe('repaired');
    expect(result.issued).toBe(true);
    expect(result.stable).toBe(false);
    expect((await adminAuth.getUser(target)).disabled).toBe(false);
    expect((await db.doc(`accountDeletionJobs/${target}`).get()).data()).toEqual(job);
    expect(await projection(target)).toEqual(before);
    expect(await intentOf(target)).toMatchObject({ desiredDisabled: false, phase: 'confirmed' });
  });

  it('K: an older generation does not enable Auth after a newer suspension decision', async () => {
    const target = await user('newer', { status: 'Active', username: 'k' });
    await seedEnableIntent(target, { phase: 'confirmed', status: 'Active', blocked: false, generation: 7 });
    hooks.beforeRepairDecision = async ({ userId }) => {
      await db.doc(`users/${userId}`).update({ status: 'Suspended', productAccessBlocked: true });
      await db.doc(`users/${userId}/private/authIntent`).update({
        generation: 8,
        desiredDisabled: true,
        phase: 'confirmed',
      });
    };
    const calls = [];
    const auth = getAuth();
    const orig = auth.updateUser.bind(auth);
    auth.updateUser = async (uid, props) => {
      calls.push(props);
      return orig(uid, props);
    };
    try {
      const result = await reconcileAuthReplica(target);
      expect(result.outcome).toBe('superseded');
      expect(result.issued).toBe(false);
      expect(calls).toEqual([]);
      expect((await adminAuth.getUser(target)).disabled).toBe(true);
      expect(await projection(target)).toEqual({ status: 'Suspended', productAccessBlocked: true });
      expect(await intentOf(target)).toMatchObject({ generation: 8, desiredDisabled: true, phase: 'confirmed' });
    } finally {
      auth.updateUser = orig;
    }
  });
});
