'use strict';

const { readFileSync } = require('fs');
const { join } = require('path');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { doc, setDoc } = require('firebase/firestore');
const { ref, uploadBytes } = require('firebase/storage');

const { requireEmulatorProjectId } = require('./emulatorProjectId');
const { userRecordDenies, assertProductAccess, PRODUCT_ACCESS_DENIED } = require('./productAccess');
const {
  _sendMessageHandler,
  _deleteChatHandler,
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

  async function chatFor(uid) {
    const chatId = `chat_${uid}`;
    await db.doc(`chats/${chatId}`).set({ id: chatId, participants: [uid] });
    await db.doc(`chats/${chatId}/messages/m1`).set({ text: 'hi', senderId: uid });
    return chatId;
  }

  it('deleteChat succeeds for an active caller and removes messages', async () => {
    const uid = await user('delok', { status: 'Active', username: 'd' });
    const chatId = await chatFor(uid);
    await expect(_deleteChatHandler(req(uid, { chatId }))).resolves.toEqual({ success: true });
    expect((await db.doc(`chats/${chatId}`).get()).exists).toBe(false);
    expect((await db.collection(`chats/${chatId}/messages`).get()).empty).toBe(true);
  });

  it('deleteChat denies a blocked caller and does not mark the chat', async () => {
    const uid = await user('delblock', { status: 'Active', productAccessBlocked: true, username: 'd' });
    const chatId = await chatFor(uid);
    const err = await _deleteChatHandler(req(uid, { chatId })).catch((e) => e);
    expect(err.code).toBe('permission-denied');
    const chat = await db.doc(`chats/${chatId}`).get();
    expect(chat.exists).toBe(true);
    expect(chat.data().deleting).toBeUndefined();
    expect((await db.collection(`chats/${chatId}/messages`).get()).size).toBe(1);
    await db.recursiveDelete(db.doc(`chats/${chatId}`));
  });

  it('deleteChat does not start when suspension commits before the deleting transaction', async () => {
    const uid = await user('delrace', { status: 'Active', username: 'd' });
    const chatId = await chatFor(uid);
    _productAccessHooks.beforeProtectedWrite = async () => {
      await db.doc(`users/${uid}`).update({ status: 'Suspended', productAccessBlocked: true });
    };
    const err = await _deleteChatHandler(req(uid, { chatId })).catch((e) => e);
    expect(err.code).toBe('permission-denied');
    const chat = await db.doc(`chats/${chatId}`).get();
    expect(chat.exists).toBe(true);
    expect(chat.data().deleting).toBeUndefined();
    expect((await db.collection(`chats/${chatId}/messages`).get()).size).toBe(1);
    await db.recursiveDelete(db.doc(`chats/${chatId}`));
  });

  it('deleteChat finishes cleanup after an authorized deleting mark', async () => {
    const uid = await user('delclean', { status: 'Active', username: 'd' });
    const chatId = await chatFor(uid);
    await db.doc(`chats/${chatId}`).update({ deleting: true });
    await db.doc(`users/${uid}`).update({ status: 'Suspended', productAccessBlocked: true });
    await expect(_deleteChatHandler(req(uid, { chatId }))).resolves.toEqual({ success: true });
    expect((await db.doc(`chats/${chatId}`).get()).exists).toBe(false);
    expect((await db.collection(`chats/${chatId}/messages`).get()).empty).toBe(true);
  });

  it('does not treat a client-supplied flag as authority on a missing profile', async () => {
    const fresh = await user('clientflag', null);
    await expect(assertProductAccess(fresh)).resolves.toBeUndefined();
    await db.doc(`users/${fresh}`).set({ id: fresh, status: 'Active', productAccessBlocked: true });
    await expect(assertProductAccess(fresh)).rejects.toMatchObject({ code: 'permission-denied' });
    await db.doc(`users/${fresh}`).update({ productAccessBlocked: FieldValue.delete() });
    await expect(assertProductAccess(fresh)).resolves.toBeUndefined();
  });

  async function audits(uid) {
    const snap = await db.collection('adminAuditLog').where('targetUserId', '==', uid).get();
    return snap.docs.map((docSnap) => docSnap.data());
  }

  function named(rows, action) {
    return rows.filter((row) => row.action === action);
  }

  async function expectCallableDenied(uid) {
    const sent = await _sendMessageHandler(req(uid, {
      chatId: `race_${uid}`, clientRequestId: `req_${uid.slice(-12)}`, text: 'hi',
    })).catch((err) => err);
    expect(sent.code).toBe('permission-denied');
    expect(sent.message).toBe(PRODUCT_ACCESS_DENIED);
  }

  async function expectRulesDenied(uid) {
    const client = rulesEnv.authenticatedContext(uid);
    await assertFails(setDoc(doc(client.firestore(), 'users', uid, 'private', 'preferences'), { lang: 'en' }));
    await assertFails(uploadBytes(ref(client.storage(), `avatarUploads/${uid}/race/original`), JPEG, IMAGE));
  }

  async function expectRulesAllowed(uid) {
    const client = rulesEnv.authenticatedContext(uid);
    await assertSucceeds(setDoc(doc(client.firestore(), 'users', uid, 'private', 'preferences'), { lang: 'en' }));
  }

  function holdBeforeAuth(opName) {
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    let holding = () => {};
    const holdingP = new Promise((resolve) => { holding = resolve; });
    _suspensionConcurrencyHooks.acquireAttempts = 1;
    _suspensionConcurrencyHooks.beforeAuthRpc = async ({ op }) => {
      if (op !== opName) return;
      holding();
      await gate;
    };
    return { release, holdingP };
  }

  async function expireLease(uid) {
    const ref = db.doc(`users/${uid}/private/suspensionLock`);
    const snap = await ref.get();
    expect(snap.exists).toBe(true);
    await ref.update({ leaseExpiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    return snap.data().ownerOperationId;
  }

  it('A: an in-flight suspend rejects unsuspend and denies access before Auth is disabled', async () => {
    const admin = await adminCaller();
    const target = await user('overlapA', { status: 'Active', username: 'a' });
    const authCalls = [];
    const auth = getAuth();
    const orig = auth.updateUser.bind(auth);
    auth.updateUser = async (uid, props) => {
      if (uid === target) authCalls.push(props && props.disabled);
      return orig(uid, props);
    };
    const held = holdBeforeAuth('suspend');
    const suspendP = runCall(adminSuspendUser, req(admin, { userId: target, reason: 'spam' }, 'admin'));
    try {
      await held.holdingP;
      const mid = (await db.doc(`users/${target}`).get()).data();
      expect(mid.status).toBe('Suspended');
      expect(mid.productAccessBlocked).toBe(true);
      expect((await adminAuth.getUser(target)).disabled).toBe(false);
      await expectCallableDenied(target);
      await expectRulesDenied(target);
      const raced = await runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'));
      expect(raced.error.code).toBe('aborted');
      expect(raced.error.message).toMatch(/in progress/);
      expect(authCalls).toEqual([]);
    } finally {
      held.release();
      auth.updateUser = orig;
    }
    expect((await suspendP).result).toEqual({ success: true });
    expect((await adminAuth.getUser(target)).disabled).toBe(true);
    const rows = await audits(target);
    expect(named(rows, 'user.suspend')).toHaveLength(1);
    expect(named(rows, 'user.unsuspend')).toHaveLength(0);
    expect((await db.doc(`users/${target}/private/suspensionLock`).get()).exists).toBe(false);

    _suspensionConcurrencyHooks.beforeAuthRpc = null;
    _suspensionConcurrencyHooks.acquireAttempts = null;
    expect((await runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'))).result).toEqual({ success: true });
    const after = await audits(target);
    expect(named(after, 'user.suspend')).toHaveLength(1);
    expect(named(after, 'user.unsuspend')).toHaveLength(1);
  });

  it('B: an in-flight unsuspend rejects suspend, and a later suspend appends its own audit', async () => {
    const admin = await adminCaller();
    const target = await user('overlapB', { status: 'Active', username: 'b' });
    expect((await runCall(adminSuspendUser, req(admin, { userId: target, reason: 'spam' }, 'admin'))).result).toEqual({ success: true });
    const held = holdBeforeAuth('unsuspend');
    const unsuspendP = runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'));
    try {
      await held.holdingP;
      const mid = (await db.doc(`users/${target}`).get()).data();
      expect(mid.status).toBe('Active');
      expect(mid.productAccessBlocked).toBe(true);
      expect((await adminAuth.getUser(target)).disabled).toBe(true);
      await expectCallableDenied(target);
      const raced = await runCall(adminSuspendUser, req(admin, { userId: target, reason: 'again' }, 'admin'));
      expect(raced.error.code).toBe('aborted');
      expect(raced.error.message).toMatch(/in progress/);
      expect(named(await audits(target), 'user.suspend')).toHaveLength(1);
    } finally {
      held.release();
    }
    expect((await unsuspendP).result).toEqual({ success: true });
    expect((await db.doc(`users/${target}`).get()).data().productAccessBlocked).toBeUndefined();
    expect((await adminAuth.getUser(target)).disabled).toBe(false);

    _suspensionConcurrencyHooks.beforeAuthRpc = null;
    _suspensionConcurrencyHooks.acquireAttempts = null;
    expect((await runCall(adminSuspendUser, req(admin, { userId: target, reason: 'later' }, 'admin'))).result).toEqual({ success: true });
    const rows = await audits(target);
    expect(named(rows, 'user.suspend')).toHaveLength(2);
    expect(named(rows, 'user.unsuspend')).toHaveLength(1);
    expect(named(rows, 'user.suspend').every((row) => row.outcome !== 'partial')).toBe(true);
  });

  it('C, D, and H: a successor suspend replaces an expired unsuspend lease and the stale enable cannot clear it', async () => {
    const admin = await adminCaller();
    const target = await user('leaseD', { status: 'Active', username: 'd' });
    expect((await runCall(adminSuspendUser, req(admin, { userId: target, reason: 'spam' }, 'admin'))).result).toEqual({ success: true });
    const auth = getAuth();
    const orig = auth.updateUser.bind(auth);
    let releaseEnable = () => {};
    const enableGate = new Promise((resolve) => { releaseEnable = resolve; });
    let enableStarted = () => {};
    const enableStartedP = new Promise((resolve) => { enableStarted = resolve; });
    let sawEnabledAfterSuccessor = false;
    auth.updateUser = async (uid, props) => {
      if (uid === target && props && props.disabled === false && !sawEnabledAfterSuccessor) {
        enableStarted();
        await enableGate;
        const result = await orig(uid, props);
        sawEnabledAfterSuccessor = (await adminAuth.getUser(uid)).disabled === false;
        return result;
      }
      return orig(uid, props);
    };
    const unsuspendP = runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'));
    try {
      await enableStartedP;
      const during = (await db.doc(`users/${target}`).get()).data();
      expect(during.status).toBe('Active');
      expect(during.productAccessBlocked).toBe(true);
      expect((await adminAuth.getUser(target)).disabled).toBe(true);
      await expectCallableDenied(target);
      const staleOwner = await expireLease(target);
      let replaced = () => {};
      const replacedP = new Promise((resolve) => { replaced = resolve; });
      let successorOwner = null;
      _suspensionConcurrencyHooks.afterLockAcquired = async ({ ownerOperationId }) => {
        successorOwner = ownerOperationId;
        replaced();
      };
      const suspendP = runCall(adminSuspendUser, req(admin, { userId: target, reason: 'successor' }, 'admin'));
      await replacedP;
      expect(successorOwner).toBeTruthy();
      expect(successorOwner).not.toBe(staleOwner);
      expect((await suspendP).result).toEqual({ success: true });
      const successor = (await db.doc(`users/${target}`).get()).data();
      expect(successor.status).toBe('Suspended');
      expect(successor.productAccessBlocked).toBe(true);
      expect((await adminAuth.getUser(target)).disabled).toBe(true);
      await expectCallableDenied(target);
      releaseEnable();
      const stale = await unsuspendP;
      expect(stale.error.code).toBe('aborted');
      expect(stale.error.message).toMatch(/ownership lost/i);
      expect(sawEnabledAfterSuccessor).toBe(true);
      const finalDoc = (await db.doc(`users/${target}`).get()).data();
      expect(finalDoc.status).toBe('Suspended');
      expect(finalDoc.productAccessBlocked).toBe(true);
      expect((await adminAuth.getUser(target)).disabled).toBe(true);
      const rows = await audits(target);
      expect(named(rows, 'user.unsuspend')).toHaveLength(0);
      expect(named(rows, 'user.unsuspend.pending')).toHaveLength(1);
      expect(named(rows, 'user.suspend').length).toBeGreaterThanOrEqual(2);
      await expectCallableDenied(target);
    } finally {
      releaseEnable();
      auth.updateUser = orig;
      _suspensionConcurrencyHooks.afterLockAcquired = null;
    }
  });

  it('C and E: a successor unsuspend replaces an expired suspend lease, then the late disable leaves Active with Auth disabled', async () => {
    const admin = await adminCaller();
    const target = await user('leaseE', { status: 'Active', username: 'e' });
    const auth = getAuth();
    const orig = auth.updateUser.bind(auth);
    let releaseDisable = () => {};
    const disableGate = new Promise((resolve) => { releaseDisable = resolve; });
    let disableStarted = () => {};
    const disableStartedP = new Promise((resolve) => { disableStarted = resolve; });
    let sawLateDisable = false;
    let disableEntered = false;
    auth.updateUser = async (uid, props) => {
      if (uid === target && props && props.disabled === true && !disableEntered) {
        disableEntered = true;
        disableStarted();
        await disableGate;
        const result = await orig(uid, props);
        sawLateDisable = (await adminAuth.getUser(uid)).disabled === true;
        return result;
      }
      return orig(uid, props);
    };
    const suspendP = runCall(adminSuspendUser, req(admin, { userId: target, reason: 'spam' }, 'admin'));
    try {
      await disableStartedP;
      const during = (await db.doc(`users/${target}`).get()).data();
      expect(during.status).toBe('Suspended');
      expect(during.productAccessBlocked).toBe(true);
      expect((await adminAuth.getUser(target)).disabled).toBe(false);
      await expectCallableDenied(target);
      await expectRulesDenied(target);
      const staleOwner = await expireLease(target);
      let replaced = () => {};
      const replacedP = new Promise((resolve) => { replaced = resolve; });
      let successorOwner = null;
      _suspensionConcurrencyHooks.afterLockAcquired = async ({ ownerOperationId }) => {
        successorOwner = ownerOperationId;
        replaced();
      };
      const unsuspendP = runCall(adminUnsuspendUser, req(admin, { userId: target }, 'admin'));
      await replacedP;
      expect(successorOwner).not.toBe(staleOwner);
      expect((await unsuspendP).result).toEqual({ success: true });
      const recovered = (await db.doc(`users/${target}`).get()).data();
      expect(recovered.status).toBe('Active');
      expect(recovered.productAccessBlocked).toBeUndefined();
      expect((await adminAuth.getUser(target)).disabled).toBe(false);
      releaseDisable();
      const stale = await suspendP;
      expect(stale.error.code).toBe('aborted');
      expect(stale.error.message).toMatch(/ownership lost/i);
      expect(sawLateDisable).toBe(true);
      const finalDoc = (await db.doc(`users/${target}`).get()).data();
      expect(finalDoc.status).toBe('Active');
      expect(finalDoc.productAccessBlocked).toBeUndefined();
      expect((await adminAuth.getUser(target)).disabled).toBe(true);
      await expect(assertProductAccess(target)).resolves.toBeUndefined();
      const sent = await _sendMessageHandler(req(target, {
        chatId: `open_${target}`, clientRequestId: 'req_late_disable', text: 'hi',
      })).catch((err) => err);
      expect(sent.code).toBe('not-found');
      await expectRulesAllowed(target);
      const signIn = await fetch(
        'http://localhost:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-key',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: await adminAuth.createCustomToken(target), returnSecureToken: true }),
        },
      );
      const body = await signIn.json();
      expect(body.idToken).toBeUndefined();
      expect(JSON.stringify(body)).toMatch(/USER_DISABLED/);
      const rows = await audits(target);
      expect(named(rows, 'user.suspend')).toHaveLength(0);
      expect(named(rows, 'user.suspend.pending')).toHaveLength(1);
      expect(named(rows, 'user.unsuspend')).toHaveLength(1);
    } finally {
      releaseDisable();
      auth.updateUser = orig;
      _suspensionConcurrencyHooks.afterLockAcquired = null;
    }
  });

  it('F: a disable that applies and then reports failure is confirmed from getUser', async () => {
    const admin = await adminCaller();
    const target = await user('ackF', { status: 'Active', username: 'f' });
    const auth = getAuth();
    const orig = auth.updateUser.bind(auth);
    auth.updateUser = async (uid, props) => {
      const result = await orig(uid, props);
      if (uid === target && props && props.disabled === true) {
        throw Object.assign(new Error('ack lost'), { code: 'auth/internal-error' });
      }
      return result;
    };
    try {
      const result = await runCall(adminSuspendUser, req(admin, { userId: target, reason: 'spam' }, 'admin'));
      expect(result.error).toBeUndefined();
      expect(result.result).toEqual({ success: true });
      expect((await adminAuth.getUser(target)).disabled).toBe(true);
      const docData = (await db.doc(`users/${target}`).get()).data();
      expect(docData.status).toBe('Suspended');
      expect(docData.productAccessBlocked).toBe(true);
      const rows = await audits(target);
      expect(named(rows, 'user.suspend')).toHaveLength(1);
      expect(named(rows, 'user.suspend.partial')).toHaveLength(0);
      await expectCallableDenied(target);
    } finally {
      auth.updateUser = orig;
    }
  });

  it('G: an unconfirmed Auth update stays unconfirmed and keeps the deny flag', async () => {
    const admin = await adminCaller();
    const suspendTarget = await user('ackG', { status: 'Active', username: 'g' });
    const auth = getAuth();
    const origUpdate = auth.updateUser.bind(auth);
    const origGet = auth.getUser.bind(auth);
    const reads = new Map();
    auth.getUser = async (uid) => {
      if (uid !== suspendTarget) return origGet(uid);
      const seen = (reads.get(uid) || 0) + 1;
      reads.set(uid, seen);
      if (seen === 1) return origGet(uid);
      throw Object.assign(new Error('readback failed'), { code: 'auth/internal-error' });
    };
    auth.updateUser = async (uid, props) => {
      if (uid === suspendTarget) throw Object.assign(new Error('update failed'), { code: 'auth/internal-error' });
      return origUpdate(uid, props);
    };
    try {
      const failed = await runCall(adminSuspendUser, req(admin, { userId: suspendTarget, reason: 'spam' }, 'admin'));
      expect(failed.error.code).toBe('aborted');
      expect(failed.error.message).toMatch(/could not be confirmed/i);
      expect(failed.error.message).not.toMatch(/Nothing was changed/);
      expect(failed.error.details).toMatchObject({ partial: true, authDisabled: null, productAccessBlocked: true, recordWritten: true });
      expect((await adminAuth.getUser(suspendTarget)).disabled).toBe(false);
      const suspended = (await db.doc(`users/${suspendTarget}`).get()).data();
      expect(suspended.status).toBe('Suspended');
      expect(suspended.productAccessBlocked).toBe(true);
      await expectCallableDenied(suspendTarget);
      const suspendRows = await audits(suspendTarget);
      expect(named(suspendRows, 'user.suspend')).toHaveLength(0);
      expect(named(suspendRows, 'user.suspend.partial').some((row) => row.authDisabled === null && row.failedStep === 'disable')).toBe(true);
    } finally {
      auth.updateUser = origUpdate;
      auth.getUser = origGet;
    }

    const unsuspendTarget = await user('ackG2', { status: 'Active', username: 'g2' });
    expect((await runCall(adminSuspendUser, req(admin, { userId: unsuspendTarget, reason: 'spam' }, 'admin'))).result).toEqual({ success: true });
    const readsAfter = new Map();
    auth.getUser = async (uid) => {
      if (uid !== unsuspendTarget) return origGet(uid);
      const seen = (readsAfter.get(uid) || 0) + 1;
      readsAfter.set(uid, seen);
      if (seen === 1) return origGet(uid);
      throw Object.assign(new Error('readback failed'), { code: 'auth/internal-error' });
    };
    auth.updateUser = async (uid, props) => {
      if (uid === unsuspendTarget && props && props.disabled === false) {
        throw Object.assign(new Error('enable failed'), { code: 'auth/internal-error' });
      }
      return origUpdate(uid, props);
    };
    try {
      const failed = await runCall(adminUnsuspendUser, req(admin, { userId: unsuspendTarget }, 'admin'));
      expect(failed.error.code).toBe('aborted');
      expect(failed.error.message).toMatch(/could not be confirmed/i);
      expect(failed.error.message).not.toMatch(/Nothing was changed/);
      expect(failed.error.details).toMatchObject({
        partial: true, authDisabled: null, productAccessBlocked: true, recordWritten: true,
      });
      expect(failed.error.details.authState).toBeUndefined();
      const pending = (await db.doc(`users/${unsuspendTarget}`).get()).data();
      expect(pending.status).toBe('Active');
      expect(pending.productAccessBlocked).toBe(true);
      expect((await adminAuth.getUser(unsuspendTarget)).disabled).toBe(true);
      await expectCallableDenied(unsuspendTarget);
      const rows = await audits(unsuspendTarget);
      expect(named(rows, 'user.unsuspend')).toHaveLength(0);
      expect(named(rows, 'user.unsuspend.partial').some((row) => row.authState === 'unconfirmed' && row.authDisabled === null)).toBe(true);
    } finally {
      auth.updateUser = origUpdate;
      auth.getUser = origGet;
    }
  });

  it('I: a completed suspension still denies product access after a delayed Auth enable', async () => {
    const admin = await adminCaller();
    const target = await user('lateI', { status: 'Active', username: 'i' });
    expect((await runCall(adminSuspendUser, req(admin, { userId: target, reason: 'spam' }, 'admin'))).result).toEqual({ success: true });
    await adminAuth.updateUser(target, { disabled: false });
    expect((await adminAuth.getUser(target)).disabled).toBe(false);
    const stored = (await db.doc(`users/${target}`).get()).data();
    expect(stored.status).toBe('Suspended');
    expect(stored.productAccessBlocked).toBe(true);
    await expectCallableDenied(target);
    await expectRulesDenied(target);
    const rows = await audits(target);
    expect(named(rows, 'user.suspend')).toHaveLength(1);
    expect(named(rows, 'user.unsuspend')).toHaveLength(0);
  });
});
