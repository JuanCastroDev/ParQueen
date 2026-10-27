'use strict';

const { randomUUID } = require('crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { requireCurrentAdmin } = require('./adminAuth');

// Per-user suspension guard. adminSuspendUser and adminUnsuspendUser set
// timeoutSeconds to 60. The lease is 120s, renewed on acquire, immediately
// before the Auth RPC, and inside each record transaction. A live instance
// is stopped at 60s, so it cannot still be running 120s after its last
// renewal unless clocks differ by more than 60s. That margin is not a
// continuous Auth-state guarantee.
//
// productAccessBlocked is the product deny flag. Suspend commits it, with
// status Suspended, BEFORE Auth disable, and never clears it because disable
// failed. Unsuspend keeps it true through the pending enable. Only the
// completion transaction, which also writes user.unsuspend and still owns
// the lock, deletes the flag.
//
// Unavoidable residual: updateUser cannot join the Firestore transaction.
// A holder that loses the lock after an enable re-disables Auth and does
// not clear the flag. An RPC that is applied only after this 120s lease
// has expired, and after a successor has finished, can still change Auth
// with no holder left to compensate. While the flag is present and not
// boolean false, or status is Suspended, product access stays denied.
// The lease does not make Auth and Firestore one atomic state.
const SUSPENSION_LOCK_LEASE_MS = 120000;
const SUSPENSION_CALL_TIMEOUT_SEC = 60;
const SUSPENSION_PUBLIC_LEGACY_FIELDS = [
  'suspendedAt', 'suspendedBy', 'suspensionReason', 'unsuspendedAt', 'unsuspendedBy',
];

const hooks = {
  afterLockAcquired: null,
  beforeAuthRpc: null,
  afterAuthRpc: null,
  acquireAttempts: null,
};

function db() {
  return getFirestore();
}

function legacySuspensionFieldDeletes() {
  const out = {};
  for (const f of SUSPENSION_PUBLIC_LEGACY_FIELDS) out[f] = FieldValue.delete();
  return out;
}

function mapSuspensionAuthError(err) {
  if (err && err.code === 'auth/user-not-found') {
    return new HttpsError('not-found', 'User not found.');
  }
  return new HttpsError('internal', 'Could not update the account sign-in state. Nothing was changed; please retry.');
}

async function writeSuspensionPartialAudit(entry) {
  try {
    await db().collection('adminAuditLog').doc().set({ ...entry, outcome: 'partial', createdAt: Timestamp.now() });
    return true;
  } catch {
    return false;
  }
}

function suspensionLockRef(userId) {
  return db().doc(`users/${userId}/private/suspensionLock`);
}

function suspensionLockBody(existing, ownerOperationId, now, authInFlight) {
  return {
    ownerOperationId,
    acquiredAt: existing && existing.acquiredAt ? existing.acquiredAt : now,
    leaseExpiresAt: Timestamp.fromMillis(now.toMillis() + SUSPENSION_LOCK_LEASE_MS),
    authInFlight: authInFlight === undefined
      ? (existing && existing.authInFlight ? existing.authInFlight : null)
      : authInFlight,
  };
}

async function withUserSuspensionLock(userId, fn) {
  const lockRef = suspensionLockRef(userId);
  const ownerOperationId = randomUUID();
  const hookAttempts = hooks.acquireAttempts;
  const attempts = Number.isInteger(hookAttempts) ? hookAttempts : 6;
  let acquired = false;
  for (let attempt = 0; attempt < attempts && !acquired; attempt++) {
    if (attempt > 0 && !Number.isInteger(hookAttempts)) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(400 * attempt, 2000)));
    }
    acquired = await db().runTransaction(async (tx) => {
      const snap = await tx.get(lockRef);
      const now = Timestamp.now();
      if (snap.exists) {
        const data = snap.data() || {};
        const expires = data.leaseExpiresAt && typeof data.leaseExpiresAt.toMillis === 'function'
          ? data.leaseExpiresAt.toMillis() : 0;
        if (expires > now.toMillis() && data.ownerOperationId !== ownerOperationId) return false;
      }
      tx.set(lockRef, suspensionLockBody(snap.exists ? snap.data() : null, ownerOperationId, now, null));
      return true;
    });
  }
  if (!acquired) {
    throw new HttpsError('aborted', 'Another suspension change is in progress for this user; please retry.');
  }
  try {
    if (typeof hooks.afterLockAcquired === 'function') await hooks.afterLockAcquired({ userId, ownerOperationId });
    return await fn(ownerOperationId);
  } finally {
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(lockRef);
      if (!snap.exists) return;
      if ((snap.data() || {}).ownerOperationId !== ownerOperationId) return;
      tx.delete(lockRef);
    }).catch(() => {});
  }
}

async function renewSuspensionLock(userId, ownerOperationId, authInFlight) {
  const lockRef = suspensionLockRef(userId);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(lockRef);
    if (!snap.exists || (snap.data() || {}).ownerOperationId !== ownerOperationId) return false;
    const now = Timestamp.now();
    const nextInFlight = authInFlight === undefined
      ? ((snap.data() || {}).authInFlight || null)
      : authInFlight;
    tx.set(lockRef, suspensionLockBody(snap.data(), ownerOperationId, now, nextInFlight));
    return true;
  });
}

async function commitOwnedSuspensionRecords(userId, ownerOperationId, write) {
  const lockRef = suspensionLockRef(userId);
  try {
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(lockRef);
      const data = snap.exists ? (snap.data() || {}) : null;
      if (!data || data.ownerOperationId !== ownerOperationId) {
        const lost = new Error('suspension lock lost');
        lost.code = 'suspension/lock-lost';
        throw lost;
      }
      const now = Timestamp.now();
      tx.set(lockRef, suspensionLockBody(data, ownerOperationId, now));
      write(tx, now);
    });
    return { outcome: 'committed' };
  } catch (err) {
    if (err && (err.code === 'suspension/lock-lost' || err.message === 'suspension lock lost')) {
      return { outcome: 'lost' };
    }
    return { outcome: 'error', error: err };
  }
}

async function observeAuthDisabled(userId, desiredDisabled) {
  try {
    await getAuth().updateUser(userId, { disabled: desiredDisabled });
    return { outcome: 'applied' };
  } catch (err) {
    if (err && err.code === 'auth/user-not-found') return { outcome: 'not-found', error: err };
    const code = err && err.code ? String(err.code) : 'unknown';
    try {
      const user = await getAuth().getUser(userId);
      if (user.disabled === desiredDisabled) return { outcome: 'applied', recovered: true, code };
      return { outcome: 'rejected', error: err, code, disabled: user.disabled };
    } catch {
      return { outcome: 'unconfirmed', error: err, code };
    }
  }
}

async function disableAuthAfterLostOwnership(userId) {
  try {
    await getAuth().updateUser(userId, { disabled: true });
    return true;
  } catch (err) {
    try {
      const user = await getAuth().getUser(userId);
      return user.disabled === true;
    } catch {
      console.error('adminUnsuspendUser: partial outcome', {
        step: 'enable', code: err && err.code ? String(err.code) : 'unknown', confirmed: false,
      });
      return null;
    }
  }
}

function auditBase(request, userId, now) {
  return {
    targetType: 'user',
    targetId: userId,
    targetUserId: userId,
    adminId: request.auth.uid,
    createdAt: now,
  };
}

async function adminSuspendUser(request) {
  await requireCurrentAdmin(request);
  const { userId, reason } = request.data || {};
  if (!userId || typeof userId !== 'string') throw new HttpsError('invalid-argument', 'userId required.');
  if (!reason || typeof reason !== 'string' || !reason.trim()) throw new HttpsError('invalid-argument', 'reason required.');
  if (userId === request.auth.uid) throw new HttpsError('failed-precondition', 'You cannot suspend your own account.');

  const userRef = db().doc(`users/${userId}`);
  if (!(await userRef.get()).exists) throw new HttpsError('not-found', 'User not found.');
  try {
    await getAuth().getUser(userId);
  } catch (err) {
    console.error('adminSuspendUser: auth step failed', { step: 'lookup', code: err && err.code ? String(err.code) : 'unknown' });
    throw mapSuspensionAuthError(err);
  }

  return withUserSuspensionLock(userId, async (ownerOperationId) => {
    const trimmedReason = reason.trim();
    const pendingRef = db().collection('adminAuditLog').doc();
    const wrote = await commitOwnedSuspensionRecords(userId, ownerOperationId, (tx, now) => {
      tx.update(userRef, {
        status: 'Suspended',
        productAccessBlocked: true,
        updatedAt: now,
        ...legacySuspensionFieldDeletes(),
      });
      tx.set(db().doc(`users/${userId}/private/moderation`), {
        status: 'Suspended',
        suspendedAt: now,
        suspendedBy: request.auth.uid,
        suspensionReason: trimmedReason,
        unsuspendedAt: null,
        unsuspendedBy: null,
        updatedAt: now,
      }, { merge: true });
      tx.set(pendingRef, {
        action: 'user.suspend.pending',
        ...auditBase(request, userId, now),
        reason: trimmedReason,
        outcome: 'pending',
        pendingStep: 'disable',
        authDisabled: false,
        productAccessBlocked: true,
        recordWritten: true,
      });
    });
    if (wrote.outcome === 'lost') {
      throw new HttpsError('aborted', 'Lock ownership lost before the access block was saved. Sign-in was not changed. Retry.');
    }
    if (wrote.outcome === 'error') {
      const pub = await userRef.get().catch(() => null);
      const data = pub && pub.exists ? pub.data() : null;
      const blocked = !!(data && data.productAccessBlocked === true && data.status === 'Suspended');
      const pendingLanded = await pendingRef.get().then((snap) => snap.exists).catch(() => false);
      if (!blocked) {
        throw new HttpsError('internal', 'Could not save the access block. Sign-in was not changed. Please retry.');
      }
      if (!pendingLanded) {
        throw new HttpsError('aborted', 'Could not confirm that this attempt saved the access block. Sign-in was not changed. The access block was not cleared. Retry.');
      }
    }
    if (!(await renewSuspensionLock(userId, ownerOperationId, ownerOperationId))) {
      throw new HttpsError('aborted', 'Lock ownership lost before the account was disabled. The access block was kept. Retry.');
    }
    if (typeof hooks.beforeAuthRpc === 'function') await hooks.beforeAuthRpc({ userId, ownerOperationId, op: 'suspend' });
    const disabledState = await observeAuthDisabled(userId, true);
    if (typeof hooks.afterAuthRpc === 'function') await hooks.afterAuthRpc({ userId, ownerOperationId, op: 'suspend', outcome: disabledState.outcome });
    if (disabledState.outcome === 'not-found') {
      throw new HttpsError('not-found', 'User not found. The access block was kept.');
    }
    if (disabledState.outcome !== 'applied') {
      const code = disabledState.code || 'unknown';
      const unconfirmed = disabledState.outcome === 'unconfirmed';
      const auditWritten = await writeSuspensionPartialAudit({
        action: 'user.suspend.partial',
        ...auditBase(request, userId, Timestamp.now()),
        reason: trimmedReason,
        failedStep: 'disable',
        errorCode: code,
        authDisabled: unconfirmed ? null : false,
        productAccessBlocked: true,
        recordWritten: true,
      });
      console.error('adminSuspendUser: partial outcome', {
        step: 'disable', code, confirmed: !unconfirmed, authDisabled: unconfirmed ? null : false,
        productAccessBlocked: true, recordWritten: true, auditWritten,
      });
      throw new HttpsError(
        'aborted',
        unconfirmed
          ? 'The access block is saved, but the account disable could not be confirmed. The access block was not cleared. Retry.'
          : 'The access block is saved, but disabling sign-in failed. The access block was not cleared. Retry.',
        { partial: true, authDisabled: unconfirmed ? null : false, productAccessBlocked: true, recordWritten: true, auditWritten },
      );
    }
    if (!(await renewSuspensionLock(userId, ownerOperationId))) {
      throw new HttpsError('aborted', 'Lock ownership lost after the account was disabled. The access block was kept. Retry.');
    }

    let revoked = true;
    let revokeCode = null;
    try {
      await getAuth().revokeRefreshTokens(userId);
    } catch (err) {
      revoked = false;
      revokeCode = err && err.code ? String(err.code) : 'unknown';
    }

    const completionRef = db().collection('adminAuditLog').doc();
    const completed = await commitOwnedSuspensionRecords(userId, ownerOperationId, (tx, now) => {
      const base = { ...auditBase(request, userId, now), reason: trimmedReason };
      tx.set(completionRef, revoked
        ? { action: 'user.suspend', ...base }
        : {
          action: 'user.suspend.partial',
          ...base,
          outcome: 'partial',
          failedStep: 'revoke',
          errorCode: revokeCode,
          authDisabled: true,
          revoked: false,
          productAccessBlocked: true,
          recordWritten: true,
        });
    });
    if (completed.outcome === 'lost') {
      throw new HttpsError('aborted', 'Lock ownership lost before the suspension audit was kept. The access block was kept. Retry.');
    }
    if (completed.outcome === 'error') {
      const landed = await completionRef.get().then((snap) => snap.exists).catch(() => false);
      if (!landed) {
        const auditWritten = await writeSuspensionPartialAudit({
          action: 'user.suspend.partial',
          ...auditBase(request, userId, Timestamp.now()),
          reason: trimmedReason,
          failedStep: 'audit',
          errorCode: completed.error && completed.error.code ? String(completed.error.code) : 'unknown',
          authDisabled: true,
          revoked,
          productAccessBlocked: true,
          recordWritten: true,
        });
        console.error('adminSuspendUser: partial outcome', {
          step: 'audit', authDisabled: true, revoked, productAccessBlocked: true, recordWritten: true, auditWritten,
        });
        throw new HttpsError(
          'aborted',
          'The account is disabled and the access block is saved, but the completion audit could not be written. The access block was not cleared. Retry.',
          { partial: true, authDisabled: true, revoked, productAccessBlocked: true, recordWritten: true, auditWritten },
        );
      }
    }
    if (!revoked) {
      console.error('adminSuspendUser: partial outcome', {
        step: 'revoke', code: revokeCode, authDisabled: true, revoked: false, productAccessBlocked: true, recordWritten: true, auditWritten: true,
      });
      throw new HttpsError(
        'aborted',
        'The account is disabled and the access block is saved, but revoking its existing sessions failed. Retry to finish.',
        { partial: true, authDisabled: true, revoked: false, productAccessBlocked: true, recordWritten: true, auditWritten: true },
      );
    }
    return { success: true };
  });
}

async function adminUnsuspendUser(request) {
  await requireCurrentAdmin(request);
  const { userId } = request.data || {};
  if (!userId || typeof userId !== 'string') throw new HttpsError('invalid-argument', 'userId required.');

  const userRef = db().doc(`users/${userId}`);
  if (!(await userRef.get()).exists) throw new HttpsError('not-found', 'User not found.');
  try {
    await getAuth().getUser(userId);
  } catch (err) {
    console.error('adminUnsuspendUser: auth step failed', { step: 'lookup', code: err && err.code ? String(err.code) : 'unknown' });
    throw mapSuspensionAuthError(err);
  }

  return withUserSuspensionLock(userId, async (ownerOperationId) => {
    const pendingRef = db().collection('adminAuditLog').doc();
    const wrote = await commitOwnedSuspensionRecords(userId, ownerOperationId, (tx, now) => {
      tx.update(userRef, {
        status: 'Active',
        productAccessBlocked: true,
        updatedAt: now,
        ...legacySuspensionFieldDeletes(),
      });
      tx.set(pendingRef, {
        action: 'user.unsuspend.pending',
        ...auditBase(request, userId, now),
        outcome: 'pending',
        pendingStep: 'enable',
        authDisabled: true,
        productAccessBlocked: true,
        recordWritten: true,
      });
    });
    if (wrote.outcome !== 'committed') {
      const pub = await userRef.get().catch(() => null);
      const data = pub && pub.exists ? pub.data() : null;
      const pendingKept = !!(data && data.productAccessBlocked === true);
      const pendingLanded = await pendingRef.get().then((snap) => snap.exists).catch(() => false);
      if (wrote.outcome === 'lost' || !pendingKept || !pendingLanded) {
        throw new HttpsError('aborted', 'Could not save the unsuspend attempt. The access block was not cleared and sign-in was not re-enabled. Retry.');
      }
    }
    if (!(await renewSuspensionLock(userId, ownerOperationId, ownerOperationId))) {
      throw new HttpsError('aborted', 'Lock ownership lost before sign-in was re-enabled. The access block was kept. Retry.');
    }
    if (typeof hooks.beforeAuthRpc === 'function') await hooks.beforeAuthRpc({ userId, ownerOperationId, op: 'unsuspend' });
    const enabledState = await observeAuthDisabled(userId, false);
    if (typeof hooks.afterAuthRpc === 'function') await hooks.afterAuthRpc({ userId, ownerOperationId, op: 'unsuspend', outcome: enabledState.outcome });
    if (enabledState.outcome === 'not-found') {
      throw new HttpsError('not-found', 'User not found. The access block was kept.');
    }
    if (enabledState.outcome !== 'applied') {
      const code = enabledState.code || 'unknown';
      const unconfirmed = enabledState.outcome === 'unconfirmed';
      const auditWritten = await writeSuspensionPartialAudit({
        action: 'user.unsuspend.partial',
        ...auditBase(request, userId, Timestamp.now()),
        failedStep: 'enable',
        errorCode: code,
        authDisabled: unconfirmed ? null : true,
        productAccessBlocked: true,
        recordWritten: true,
        ...(unconfirmed ? { authState: 'unconfirmed' } : {}),
      });
      console.error('adminUnsuspendUser: partial outcome', {
        step: 'enable', code, confirmed: !unconfirmed, productAccessBlocked: true, recordWritten: true, auditWritten,
      });
      throw new HttpsError(
        'aborted',
        unconfirmed
          ? 'The access block is still in place, but sign-in could not be confirmed. The access block was not cleared. Retry.'
          : 'The access block is still in place, and re-enabling sign-in failed. The access block was not cleared. Retry.',
        { partial: true, authDisabled: unconfirmed ? null : true, productAccessBlocked: true, recordWritten: true, auditWritten },
      );
    }
    if (!(await renewSuspensionLock(userId, ownerOperationId))) {
      const disabledAgain = await disableAuthAfterLostOwnership(userId);
      console.error('adminUnsuspendUser: partial outcome', {
        step: 'enable', code: 'suspension/lock-lost', authDisabled: disabledAgain === true,
        confirmed: disabledAgain !== null, productAccessBlocked: true,
      });
      throw new HttpsError(
        'aborted',
        'Lock ownership lost after sign-in was changed. The access block was kept. Retry.',
        { partial: true, authDisabled: disabledAgain === true, productAccessBlocked: true, recordWritten: true, auditWritten: false },
      );
    }

    const completionRef = db().collection('adminAuditLog').doc();
    const completed = await commitOwnedSuspensionRecords(userId, ownerOperationId, (tx, now) => {
      tx.update(userRef, {
        productAccessBlocked: FieldValue.delete(),
        updatedAt: now,
      });
      tx.set(db().doc(`users/${userId}/private/moderation`), {
        status: 'Active',
        unsuspendedAt: now,
        unsuspendedBy: request.auth.uid,
        suspendedAt: null,
        suspendedBy: null,
        suspensionReason: null,
        updatedAt: now,
      }, { merge: true });
      tx.set(completionRef, {
        action: 'user.unsuspend',
        ...auditBase(request, userId, now),
      });
    });
    if (completed.outcome === 'lost') {
      const disabledAgain = await disableAuthAfterLostOwnership(userId);
      throw new HttpsError(
        'aborted',
        'Lock ownership lost before the access block could be cleared. The completion was not kept. Retry.',
        { partial: true, authDisabled: disabledAgain === true, productAccessBlocked: true, recordWritten: true, auditWritten: false },
      );
    }
    if (completed.outcome === 'error') {
      const landed = await completionRef.get().then((snap) => snap.exists).catch(() => false);
      if (!landed) {
        const auditWritten = await writeSuspensionPartialAudit({
          action: 'user.unsuspend.partial',
          ...auditBase(request, userId, Timestamp.now()),
          failedStep: 'audit',
          errorCode: completed.error && completed.error.code ? String(completed.error.code) : 'unknown',
          authDisabled: false,
          productAccessBlocked: true,
          recordWritten: true,
        });
        console.error('adminUnsuspendUser: partial outcome', {
          step: 'audit', authDisabled: false, productAccessBlocked: true, recordWritten: true, auditWritten,
        });
        throw new HttpsError(
          'aborted',
          'Sign-in was re-enabled, but the access block is still in place because the completion could not be saved. Retry.',
          { partial: true, authDisabled: false, productAccessBlocked: true, recordWritten: true, auditWritten },
        );
      }
    }
    return { success: true };
  });
}

module.exports = {
  hooks,
  SUSPENSION_CALL_TIMEOUT_SEC,
  adminSuspendUser,
  adminUnsuspendUser,
};
