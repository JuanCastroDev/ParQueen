'use strict';

require('./isolatedEmulatorGuard').assertIsolatedEmulator();
const { emulatorEndpoint } = require('./isolatedEmulatorGuard');

const { readFileSync } = require('fs');
const { join } = require('path');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc, deleteDoc } = require('firebase/firestore');
const { ref, uploadBytes, getBytes, deleteObject, updateMetadata } = require('firebase/storage');

const { requireEmulatorProjectId } = require('./emulatorProjectId');
const { assertProductAccess } = require('./productAccess');
const { hooks, reconcileAuthReplica } = require('./suspensionAccess');
const { adminSuspendUser, adminUnsuspendUser, claimUsername, deleteAccount } = require('./index.js');

const PROJECT_ID = requireEmulatorProjectId();
const APP_NAME = '__account_deletion_fence__';
const testApp = getApps().find((app) => app.name === APP_NAME) ?? initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const adminAuth = getAuth(testApp);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const uidOf = (label) => `fence_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

function req(uid, data, role) {
  const now = Math.floor(Date.now() / 1000);
  return {
    data,
    auth: { uid, token: { uid, auth_time: now - 30, iat: now - 30, exp: now + 3600, ...(role ? { role } : {}) } },
  };
}

async function runCall(fn, request) {
  try {
    return { result: await fn.run(request) };
  } catch (error) {
    return { error };
  }
}

function fenceBody() {
  return {
    decision: 'delete',
    fenceGeneration: 1,
    fencedAt: Timestamp.now(),
    source: 'deleteAccount',
  };
}

describe('account deletion fence', () => {
  let rulesEnv;
  const cleanup = [];

  beforeAll(async () => {
    rulesEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: readFileSync(join(__dirname, '..', 'firestore.rules'), 'utf8'),
        host: '127.0.0.1',
        port: emulatorEndpoint('firestore').port,
      },
      storage: {
        rules: readFileSync(join(__dirname, '..', 'storage.rules'), 'utf8'),
        host: '127.0.0.1',
        port: emulatorEndpoint('storage').port,
      },
    });
  });

  afterAll(async () => {
    if (rulesEnv) await rulesEnv.cleanup();
  });

  afterEach(async () => {
    hooks.beforeRepairDecision = null;
    hooks.afterRepairAuthorized = null;
    for (const uid of cleanup.splice(0)) {
      await adminAuth.deleteUser(uid).catch(() => {});
      await db.recursiveDelete(db.doc(`users/${uid}`)).catch(() => {});
      await db.doc(`accountDeletionJobs/${uid}`).delete().catch(() => {});
      await db.doc(`accountLifecycle/${uid}`).delete().catch(() => {});
    }
    await db.doc('adminRoleLock/singleton').delete().catch(() => {});
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

  it('allows onboarding without a fence and denies a missing, active, or suspended fenced profile', async () => {
    const fresh = await user('fresh', null);
    await expect(assertProductAccess(fresh)).resolves.toBeUndefined();
    const claimed = await runCall(claimUsername, req(fresh, { username: `Fen${fresh.slice(-6)}` }));
    expect(claimed.result).toMatchObject({ success: true });

    const missing = await user('gone', null);
    const active = await user('act', { status: 'Active', username: 'a' });
    const suspended = await user('sus', { status: 'Suspended', productAccessBlocked: true, username: 's' });
    for (const uid of [missing, active, suspended]) {
      await db.doc(`accountLifecycle/${uid}`).set(fenceBody());
      await expect(assertProductAccess(uid)).rejects.toMatchObject({ code: 'permission-denied' });
    }
    await db.doc(`users/${missing}`).delete().catch(() => {});
    const again = await runCall(claimUsername, req(missing, { username: `New${missing.slice(-6)}` }));
    expect(again.error.code).toBe('permission-denied');
    expect((await db.doc(`users/${missing}`).get()).exists).toBe(false);
  });

  it('denies client access to the tombstone and denies fenced product reads', async () => {
    const uid = await user('rules', { status: 'Active', username: 'r' });
    const peer = await user('peer', { status: 'Active', username: 'p' });
    const firestore = rulesEnv.authenticatedContext(uid).firestore();
    await assertFails(setDoc(doc(firestore, `accountLifecycle/${uid}`), {
      decision: 'delete',
      fenceGeneration: 1,
      source: 'deleteAccount',
    }));
    await assertFails(deleteDoc(doc(firestore, `accountLifecycle/${uid}`)));
    await assertSucceeds(getDoc(doc(firestore, `users/${peer}`)));
    await db.doc(`accountLifecycle/${uid}`).set(fenceBody());
    await assertFails(getDoc(doc(firestore, `users/${peer}`)));
    await assertFails(getDoc(doc(firestore, `accountLifecycle/${uid}`)));
  });

  it('requires an eligible profile for quarantine upload and still fences published reads', async () => {
    const rules = readFileSync(join(__dirname, '..', 'storage.rules'), 'utf8');
    expect(rules.match(/firestore\.exists\(/g)).toHaveLength(1);
    expect(rules.match(/firestore\.get\(/g)).toHaveLength(1);

    const openUid = await user('open', { status: 'Active', username: 'open' });
    const openStorage = rulesEnv.authenticatedContext(openUid).storage();
    await assertSucceeds(uploadBytes(ref(openStorage, `avatarUploads/${openUid}/ok/original`), JPEG, { contentType: 'image/jpeg' }));
    await assertFails(deleteObject(ref(openStorage, `avatarUploads/${openUid}/ok/original`)));
    await assertFails(updateMetadata(ref(openStorage, `avatarUploads/${openUid}/ok/original`), { contentType: 'image/jpeg' }));
    await assertFails(uploadBytes(ref(openStorage, `avatarUploads/${openUid}/bad/original`), JPEG, { contentType: 'image/svg+xml' }));
    await assertFails(uploadBytes(ref(openStorage, `avatarUploads/${openUid}/big/original`), Buffer.alloc(5 * 1024 * 1024 + 1), { contentType: 'image/jpeg' }));

    const missing = await user('missing', null);
    let missingError;
    try {
      await uploadBytes(ref(rulesEnv.authenticatedContext(missing).storage(), `avatarUploads/${missing}/nope/original`), JPEG, { contentType: 'image/jpeg' });
    } catch (error) {
      missingError = error;
    }
    expect(missingError.code).toBe('storage/unauthorized');
    await expect(assertProductAccess(missing)).resolves.toBeUndefined();
    await expect(runCall(claimUsername, req(missing, { username: `name${missing.slice(-6)}` }))).resolves.toMatchObject({ result: { success: true } });

    const suspended = await user('sus', { status: 'Suspended', username: 'sus' });
    await assertFails(uploadBytes(ref(rulesEnv.authenticatedContext(suspended).storage(), `avatarUploads/${suspended}/s/original`), JPEG, { contentType: 'image/jpeg' }));
    for (const blocked of [false, true, 'false', 1, null]) {
      const uid = await user(`blk${blocked}`, { status: 'Active', username: `b${blocked}`, productAccessBlocked: blocked });
      const attempt = uploadBytes(ref(rulesEnv.authenticatedContext(uid).storage(), `avatarUploads/${uid}/b/original`), JPEG, { contentType: 'image/jpeg' });
      if (blocked === false) await assertSucceeds(attempt);
      else await assertFails(attempt);
    }

    const fencedMissing = await user('fm', null);
    await db.doc(`accountLifecycle/${fencedMissing}`).set(fenceBody());
    await assertFails(uploadBytes(ref(rulesEnv.authenticatedContext(fencedMissing).storage(), `avatarUploads/${fencedMissing}/f/original`), JPEG, { contentType: 'image/jpeg' }));
    const fencedActive = await user('fa', { status: 'Active', username: 'fa' });
    await db.doc(`accountLifecycle/${fencedActive}`).set(fenceBody());
    await assertFails(uploadBytes(ref(rulesEnv.authenticatedContext(fencedActive).storage(), `avatarUploads/${fencedActive}/f/original`), JPEG, { contentType: 'image/jpeg' }));

    const reader = await user('reader', { status: 'Active', username: 'reader' });
    const readerStorage = rulesEnv.authenticatedContext(reader).storage();
    await rulesEnv.withSecurityRulesDisabled(async (context) => {
      await uploadBytes(ref(context.storage(), `avatars/${reader}`), JPEG, { contentType: 'image/jpeg' });
    });
    await assertSucceeds(getBytes(ref(readerStorage, `avatars/${reader}`)));
    await db.doc(`accountLifecycle/${reader}`).set(fenceBody());
    await assertFails(getBytes(ref(readerStorage, `avatars/${reader}`)));
  });

  it('does not fence a rejected last-admin deletion or a lock held by another role change', async () => {
    let pageToken;
    do {
      const page = await adminAuth.listUsers(1000, pageToken);
      for (const existing of page.users) {
        if (existing.customClaims && existing.customClaims.role === 'admin') {
          await adminAuth.deleteUser(existing.uid).catch(() => {});
        }
      }
      pageToken = page.pageToken;
    } while (pageToken);
    const sole = await user('sole', { status: 'Active', username: 'solo' });
    await adminAuth.setCustomUserClaims(sole, { role: 'admin' });
    const rejected = await runCall(deleteAccount, req(sole, {}));
    expect(rejected.error.code).toBe('failed-precondition');
    expect((await db.doc(`accountLifecycle/${sole}`).get()).exists).toBe(false);
    expect((await db.doc(`accountDeletionJobs/${sole}`).get()).exists).toBe(false);
    expect((await db.doc(`users/${sole}`).get()).exists).toBe(true);
    await expect(assertProductAccess(sole)).resolves.toBeUndefined();

    const other = await user('otheradmin', null);
    await adminAuth.setCustomUserClaims(other, { role: 'admin' });
    await db.doc('adminRoleLock/singleton').set({
      ownerOperationId: 'setStaffRole_other',
      acquiredAt: Timestamp.now(),
      leaseExpiresAt: Timestamp.fromMillis(Date.now() + 60000),
    });
    const blocked = await runCall(deleteAccount, req(sole, {}));
    expect(blocked.error.code).toBe('aborted');
    expect((await db.doc(`accountLifecycle/${sole}`).get()).exists).toBe(false);
    await adminAuth.deleteUser(other).catch(() => {});
  });

  it('writes one fence and one job, and a second caller does not write another decision', async () => {
    const uid = await user('once', { status: 'Active', username: 'once' });
    const first = await runCall(deleteAccount, req(uid, {}));
    const fence = (await db.doc(`accountLifecycle/${uid}`).get()).data();
    expect(fence).toMatchObject({ decision: 'delete', fenceGeneration: 1, source: 'deleteAccount' });
    const job = (await db.doc(`accountDeletionJobs/${uid}`).get()).data();
    expect(['completed', 'failed']).toContain(job.state);
    if (first.error) expect(first.error.code).toBe('internal');
    const second = await runCall(deleteAccount, req(uid, {}));
    if (job.state === 'completed') expect(second.result).toMatchObject({ alreadyCompleted: true });
    expect((await db.doc(`accountLifecycle/${uid}`).get()).data().fenceGeneration).toBe(1);
  });

  it('refuses reconciliation and an expired lease when the fence exists', async () => {
    const uid = await user('repair', { status: 'Suspended', productAccessBlocked: true, username: 'rep' });
    await db.doc(`users/${uid}/private/authIntent`).set({
      generation: 3,
      desiredDisabled: true,
      phase: 'confirmed',
    });
    await db.doc(`users/${uid}/private/suspensionLock`).set({
      ownerOperationId: 'expired',
      generation: 3,
      leaseExpiresAt: Timestamp.fromMillis(Date.now() - 1000),
    });
    await adminAuth.updateUser(uid, { disabled: false });
    await db.doc(`accountLifecycle/${uid}`).set(fenceBody());
    const result = await reconcileAuthReplica(uid);
    expect(result.outcome).toBe('deletion');
    expect(result.issued).toBe(false);
    expect((await adminAuth.getUser(uid)).disabled).toBe(false);
  });

  it('stops a reconciler when the fence appears before its final decision', async () => {
    const uid = await user('before', { status: 'Active', username: 'b' });
    await db.doc(`users/${uid}/private/authIntent`).set({
      generation: 4,
      desiredDisabled: false,
      phase: 'confirmed',
    });
    await adminAuth.updateUser(uid, { disabled: true });
    hooks.beforeRepairDecision = async ({ userId }) => {
      await db.doc(`accountLifecycle/${userId}`).set(fenceBody());
    };
    const calls = [];
    const auth = getAuth();
    const orig = auth.updateUser.bind(auth);
    auth.updateUser = async (id, props) => {
      calls.push(props);
      return orig(id, props);
    };
    try {
      const result = await reconcileAuthReplica(uid);
      expect(result.outcome).toBe('deletion');
      expect(result.issued).toBe(false);
      expect(calls).toEqual([]);
      expect((await adminAuth.getUser(uid)).disabled).toBe(true);
    } finally {
      auth.updateUser = orig;
    }
  });

  it('does not retract an enable authorized before the fence or one already accepted', async () => {
    const late = await user('late', { status: 'Active', username: 'l' });
    await db.doc(`users/${late}/private/authIntent`).set({
      generation: 5,
      desiredDisabled: false,
      phase: 'confirmed',
    });
    await adminAuth.updateUser(late, { disabled: true });
    hooks.afterRepairAuthorized = async ({ userId }) => {
      await db.doc(`accountLifecycle/${userId}`).set(fenceBody());
    };
    const lateResult = await reconcileAuthReplica(late);
    expect(lateResult.outcome).toBe('repaired');
    expect(lateResult.issued).toBe(true);
    expect((await adminAuth.getUser(late)).disabled).toBe(false);
    await expect(assertProductAccess(late)).rejects.toMatchObject({ code: 'permission-denied' });

    const held = await user('held', { status: 'Active', username: 'h' });
    await db.doc(`users/${held}/private/authIntent`).set({
      generation: 6,
      desiredDisabled: false,
      phase: 'confirmed',
    });
    await adminAuth.updateUser(held, { disabled: true });
    const auth = getAuth();
    const orig = auth.updateUser.bind(auth);
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    let started = () => {};
    const startedP = new Promise((resolve) => { started = resolve; });
    auth.updateUser = async (id, props) => {
      if (id === held && props && props.disabled === false) {
        started();
        await gate;
      }
      return orig(id, props);
    };
    const repairP = reconcileAuthReplica(held);
    try {
      await startedP;
      await db.doc(`accountLifecycle/${held}`).set(fenceBody());
      release();
      const repair = await repairP;
      expect(repair.issued).toBe(true);
      expect(repair.retractable).toBe(false);
      expect((await adminAuth.getUser(held)).disabled).toBe(false);
      await expect(assertProductAccess(held)).rejects.toMatchObject({ code: 'permission-denied' });
    } finally {
      release();
      auth.updateUser = orig;
    }
  });

  it('does not let unsuspend clear a denial after the fence, including a pending unsuspend', async () => {
    const admin = await adminCaller();
    const uid = await user('pend', { status: 'Active', username: 'pend' });
    expect((await runCall(adminSuspendUser, req(admin, { userId: uid, reason: 'spam' }, 'admin'))).result).toEqual({ success: true });
    await db.doc(`users/${uid}`).update({ status: 'Active', productAccessBlocked: true });
    const intent = (await db.doc(`users/${uid}/private/authIntent`).get()).data();
    await db.doc(`users/${uid}/private/authIntent`).set({
      generation: intent.generation,
      desiredDisabled: false,
      phase: 'pending',
      ownerOperationId: intent.ownerOperationId,
    });
    const deleted = await runCall(deleteAccount, req(uid, {}));
    expect((await db.doc(`accountLifecycle/${uid}`).get()).exists).toBe(true);
    if (deleted.error) expect(deleted.error.code).toBe('internal');
    const unsuspend = await runCall(adminUnsuspendUser, req(admin, { userId: uid }, 'admin'));
    expect(unsuspend.error.code).toBe('failed-precondition');
    expect((await db.doc(`accountLifecycle/${uid}`).get()).data().fenceGeneration).toBe(1);
  });

  it('keeps the fence when a fenced cleanup is retried after the Auth user is gone', async () => {
    const uid = await user('retry', { status: 'Active', username: 'retry' });
    await runCall(deleteAccount, req(uid, {}));
    const before = (await db.doc(`accountLifecycle/${uid}`).get()).data();
    expect(before).toMatchObject({ decision: 'delete', fenceGeneration: 1, source: 'deleteAccount' });
    await adminAuth.deleteUser(uid).catch(() => {});
    await db.doc(`accountDeletionJobs/${uid}`).update({
      state: 'failed',
      leaseAt: Timestamp.fromMillis(Date.now() - 700000),
      lastError: 'userDoc: injected',
    });
    const second = await runCall(deleteAccount, req(uid, {}));
    expect(second.result?.success === true || second.error?.code === 'internal').toBe(true);
    expect((await db.doc(`accountLifecycle/${uid}`).get()).data()).toMatchObject({
      decision: before.decision,
      fenceGeneration: before.fenceGeneration,
      source: before.source,
    });
  });

  it('leaves an unfenced missing Auth user blocked instead of reporting completion', async () => {
    const uid = await user('nofence', { status: 'Active', username: 'nf' });
    await adminAuth.deleteUser(uid);
    const result = await runCall(deleteAccount, req(uid, {}));
    expect(result.error.code).toBe('failed-precondition');
    expect((await db.doc(`accountLifecycle/${uid}`).get()).exists).toBe(false);
    expect((await db.doc(`users/${uid}`).get()).exists).toBe(true);
  });
});
