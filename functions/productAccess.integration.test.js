'use strict';

const { readFileSync } = require('fs');
const { join } = require('path');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc } = require('firebase/firestore');
const { ref, uploadBytes } = require('firebase/storage');

const { requireEmulatorProjectId } = require('./emulatorProjectId');
const { userRecordDenies, assertProductAccess, PRODUCT_ACCESS_DENIED } = require('./productAccess');
const {
  _sendMessageHandler,
  _productAccessHooks,
  _suspensionConcurrencyHooks,
  adminSuspendUser,
  adminUnsuspendUser,
} = require('./index.js');

const PROJECT_ID = requireEmulatorProjectId();
const APP_NAME = '__productAccess_intg__';
const testApp = getApps().find((a) => a.name === APP_NAME) ?? initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const adminAuth = getAuth(testApp);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
const IMAGE = { contentType: 'image/jpeg' };

const uidOf = (label) => `pa_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

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

describe('product access predicate', () => {
  it('allows a legacy active profile and a missing profile', () => {
    expect(userRecordDenies({ status: 'Active' })).toBe(false);
    expect(userRecordDenies({ status: 'Active', productAccessBlocked: false })).toBe(false);
    expect(userRecordDenies(null)).toBe(false);
    expect(userRecordDenies(undefined)).toBe(false);
  });

  it('denies Suspended, true, and malformed values', () => {
    expect(userRecordDenies({ status: 'Suspended', productAccessBlocked: false })).toBe(true);
    expect(userRecordDenies({ status: 'Active', productAccessBlocked: true })).toBe(true);
    for (const productAccessBlocked of ['false', 'true', 0, 1, null]) {
      expect(userRecordDenies({ status: 'Active', productAccessBlocked })).toBe(true);
    }
  });
});

describe('product access enforcement', () => {
  let rulesEnv;
  const cleanup = [];

  beforeAll(async () => {
    rulesEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: readFileSync(join(__dirname, '..', 'firestore.rules'), 'utf8'),
        host: '127.0.0.1',
        port: 8080,
      },
      storage: {
        rules: readFileSync(join(__dirname, '..', 'storage.rules'), 'utf8'),
        host: '127.0.0.1',
        port: 9199,
      },
    });
  });

  afterEach(async () => {
    _productAccessHooks.beforeProtectedWrite = null;
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

  it('1 and 5: a legacy active user and a missing profile pass the callable check', async () => {
    const active = await user('active', { status: 'Active', username: 'legacy' });
    await expect(assertProductAccess(active)).resolves.toBeUndefined();
    const fresh = await user('fresh', null);
    await expect(assertProductAccess(fresh)).resolves.toBeUndefined();
    const chatId = `nochat_${fresh}`;
    const missing = await _sendMessageHandler(req(fresh, {
      chatId, clientRequestId: 'req_fresh_1', text: 'hi',
    })).catch((err) => err);
    expect(missing.code).toBe('not-found');
  });

  it('2, 3, and 4: Suspended, blocked, and malformed callers are denied', async () => {
    const suspended = await user('susp', { status: 'Suspended', productAccessBlocked: false, username: 's' });
    const blocked = await user('block', { status: 'Active', productAccessBlocked: true, username: 'b' });
    const malformed = await user('bad', { status: 'Active', productAccessBlocked: 'false', username: 'm' });
    for (const uid of [suspended, blocked, malformed]) {
      await expect(assertProductAccess(uid)).rejects.toMatchObject({ code: 'permission-denied', message: PRODUCT_ACCESS_DENIED });
      const err = await _sendMessageHandler(req(uid, {
        chatId: `nochat_${uid}`, clientRequestId: `req_${uid.slice(-6)}`, text: 'hi',
      })).catch((e) => e);
      expect(err.code).toBe('permission-denied');
      expect(JSON.stringify(err.message)).not.toMatch(/spam|reason|moderation/i);
    }
  });

  it('6: a non-admin cannot change suspension or the access flag', async () => {
    const plain = await user('plain', { status: 'Active' });
    const target = await user('target', { status: 'Active', username: 't' });
    const denied = await runCall(adminSuspendUser, req(plain, { userId: target, reason: 'x' }));
    expect(denied.error.code).toBe('permission-denied');
    const stored = (await db.doc(`users/${target}`).get()).data();
    expect(stored.status).toBe('Active');
    expect(stored.productAccessBlocked).toBeUndefined();
    expect((await adminAuth.getUser(target)).disabled).toBe(false);
  });

  it('7 and 13: suspend commits the deny flag before Auth disable, and a failed disable keeps it', async () => {
    const admin = await adminCaller();
    const target = await user('denyfirst', { status: 'Active', username: 't' });
    let flagBeforeDisable = null;
    let disabledBeforeRpc = null;
    _suspensionConcurrencyHooks.beforeAuthRpc = async ({ userId }) => {
      flagBeforeDisable = (await db.doc(`users/${userId}`).get()).data().productAccessBlocked;
      disabledBeforeRpc = (await adminAuth.getUser(userId)).disabled;
    };
    const ok = await runCall(adminSuspendUser, req(admin, { userId: target, reason: 'spam' }, 'admin'));
    expect(ok.error).toBeUndefined();
    expect(flagBeforeDisable).toBe(true);
    expect(disabledBeforeRpc).toBe(false);
    expect((await db.doc(`users/${target}`).get()).data().productAccessBlocked).toBe(true);
    expect((await adminAuth.getUser(target)).disabled).toBe(true);

    const retryTarget = await user('retry', { status: 'Active', username: 'r' });
    const auth = getAuth();
    const orig = auth.updateUser.bind(auth);
    let calls = 0;
    auth.updateUser = async (uid, props) => {
      if (uid === retryTarget && props && props.disabled === true) {
        calls += 1;
        if (calls === 1) throw Object.assign(new Error('disable failed'), { code: 'auth/internal-error' });
      }
      return orig(uid, props);
    };
    try {
      const failed = await runCall(adminSuspendUser, req(admin, { userId: retryTarget, reason: 'spam' }, 'admin'));
      expect(failed.error.code).toBe('aborted');
      expect(failed.error.message).not.toMatch(/Nothing was changed/);
      const mid = (await db.doc(`users/${retryTarget}`).get()).data();
      expect(mid.productAccessBlocked).toBe(true);
      expect(mid.status).toBe('Suspended');
      expect((await adminAuth.getUser(retryTarget)).disabled).toBe(false);
      const again = await runCall(adminSuspendUser, req(admin, { userId: retryTarget, reason: 'spam' }, 'admin'));
      expect(again.result).toEqual({ success: true });
      const logs = (await db.collection('adminAuditLog').where('targetUserId', '==', retryTarget).get()).docs.map((d) => d.data());
      expect(logs.filter((row) => row.action === 'user.suspend')).toHaveLength(1);
      expect(logs.some((row) => row.action === 'user.suspend.partial' && row.productAccessBlocked === true)).toBe(true);
      expect(logs.some((row) => row.action === 'user.suspend' && row.outcome === 'partial' && row.recordWritten === false)).toBe(false);
    } finally {
      auth.updateUser = orig;
    }
  });

  it('8, 9, and 10: unsuspend keeps the flag until owned completion, and a stale owner cannot clear it', async () => {
    const admin = await adminCaller();
    const target = await user('unsuspend', { status: 'Active', username: 'u' });
    expect((await runCall(adminSuspendUser, req(admin, { userId: target, reason: 'spam' }, 'admin'))).result).toEqual({ success: true });

    let flagWhilePending = null;
    _suspensionConcurrencyHooks.beforeAuthRpc = async ({ userId, op }) => {
      if (op !== 'unsuspend') return;
      const data = (await db.doc(`users/${userId}`).get()).data();
      flagWhilePending = data.productAccessBlocked;
      expect(data.status).toBe('Active');
      expect((await adminAuth.getUser(userId)).disabled).toBe(true);
    };
    const done = await runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'));
    expect(done.result).toEqual({ success: true });
    expect(flagWhilePending).toBe(true);
    expect((await db.doc(`users/${target}`).get()).data().productAccessBlocked).toBeUndefined();
    const completion = (await db.collection('adminAuditLog').where('targetUserId', '==', target).get()).docs
      .map((d) => d.data()).filter((row) => row.action === 'user.unsuspend');
    expect(completion).toHaveLength(1);

    expect((await runCall(adminSuspendUser, req(admin, { userId: target, reason: 'spam' }, 'admin'))).result).toEqual({ success: true });
    _suspensionConcurrencyHooks.beforeAuthRpc = null;
    _suspensionConcurrencyHooks.afterAuthRpc = async ({ userId, op }) => {
      if (op !== 'unsuspend') return;
      await db.doc(`users/${userId}/private/suspensionLock`).update({ ownerOperationId: 'someone-else' });
    };
    const stale = await runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'));
    expect(stale.error.code).toBe('aborted');
    expect((await db.doc(`users/${target}`).get()).data().productAccessBlocked).toBe(true);
    expect((await adminAuth.getUser(target)).disabled).toBe(true);
    const completions = (await db.collection('adminAuditLog').where('targetUserId', '==', target).get()).docs
      .map((d) => d.data()).filter((row) => row.action === 'user.unsuspend');
    expect(completions).toHaveLength(1);
    _suspensionConcurrencyHooks.afterAuthRpc = null;
    await db.doc(`users/${target}/private/suspensionLock`).delete().catch(() => {});

    const auth = getAuth();
    const orig = auth.updateUser.bind(auth);
    auth.updateUser = async (uid, props) => {
      await orig(uid, props);
      if (uid === target && props && props.disabled === false) {
        throw Object.assign(new Error('ack lost'), { code: 'auth/internal-error' });
      }
      return null;
    };
    try {
      expect((await runCall(adminSuspendUser, req(admin, { userId: target, reason: 'again' }, 'admin'))).result.success).toBe(true);
      const recovered = await runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'));
      expect(recovered.result).toEqual({ success: true });
      expect((await adminAuth.getUser(target)).disabled).toBe(false);
      expect((await db.doc(`users/${target}`).get()).data().productAccessBlocked).toBeUndefined();
    } finally {
      auth.updateUser = orig;
    }
  });

  it('11: a token minted during a held enable is still denied by rules and sendMessage', async () => {
    const admin = await adminCaller();
    const target = await user('held', { status: 'Active', username: 'held' });
    expect((await runCall(adminSuspendUser, req(admin, { userId: target, reason: 'spam' }, 'admin'))).result).toEqual({ success: true });
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
      const custom = await adminAuth.createCustomToken(target);
      const signIn = await fetch(
        'http://localhost:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-key',
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: custom, returnSecureToken: true }) },
      );
      const body = await signIn.json();
      expect(body.idToken).toBeTruthy();
      const client = rulesEnv.authenticatedContext(target);
      await assertFails(setDoc(doc(client.firestore(), 'users', target, 'private', 'preferences'), { lang: 'en' }));
      await assertFails(uploadBytes(ref(client.storage(), `avatarUploads/${target}/held-upload/original`), JPEG, IMAGE));
      const sent = await _sendMessageHandler(req(target, {
        chatId: `held_${target}`, clientRequestId: 'req_held_1', text: 'hi',
      })).catch((err) => err);
      expect(sent.code).toBe('permission-denied');
      expect((await db.doc(`users/${target}`).get()).data().productAccessBlocked).toBe(true);
    } finally {
      release();
    }
    expect((await pending).result).toEqual({ success: true });
    const client = rulesEnv.authenticatedContext(target);
    await assertSucceeds(setDoc(doc(client.firestore(), 'users', target, 'private', 'preferences'), { lang: 'en' }));
  });

  it('12: a send already past the entry check cannot write after the flag flips', async () => {
    const sender = await user('sender', { status: 'Active', username: 'sender' });
    const peer = await user('peer', { status: 'Active', username: 'peer' });
    const participants = [sender, peer].sort();
    const chatId = participants.join('_');
    await db.doc(`chats/${chatId}`).set({ id: chatId, participants });
    _productAccessHooks.beforeProtectedWrite = async () => {
      await db.doc(`users/${sender}`).update({ productAccessBlocked: true });
    };
    const err = await _sendMessageHandler(req(sender, {
      chatId, clientRequestId: 'req_race_1', text: 'hello',
    })).catch((e) => e);
    expect(err.code).toBe('permission-denied');
    const messages = await db.collection(`chats/${chatId}/messages`).get();
    expect(messages.empty).toBe(true);
    await db.doc(`chats/${chatId}`).delete();
  });

  it('does not treat a client-supplied flag as authority on a missing profile', async () => {
    const fresh = await user('clientflag', null);
    await expect(assertProductAccess(fresh)).resolves.toBeUndefined();
    await db.doc(`users/${fresh}`).set({ id: fresh, status: 'Active', productAccessBlocked: true });
    await expect(assertProductAccess(fresh)).rejects.toMatchObject({ code: 'permission-denied' });
    await db.doc(`users/${fresh}`).update({ productAccessBlocked: FieldValue.delete() });
    await expect(assertProductAccess(fresh)).resolves.toBeUndefined();
  });
});
