'use strict';

const { randomUUID } = require('crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { requireCurrentAdmin } = require('./adminAuth');

// Per-user suspension guard. adminSuspendUser and adminUnsuspendUser set
// timeoutSeconds to 60. The lease is 120s from this process clock, renewed
// on acquire and inside each record transaction. That margin does not make
// Auth and Firestore one state. updateUser cannot join the Firestore
// transaction.
//
// productAccessBlocked is the product deny flag. Suspend commits it, with
// status Suspended, BEFORE Auth disable, and never clears it because disable
// failed. Unsuspend keeps it true until a completion transaction still owns
// the lock, still holds the current authIntent generation, and has just
// observed getUser().disabled === false. Only that transaction deletes the flag.
//
// authIntent at users/{uid}/private/authIntent is the durable desired Auth
// bit. generation increments when a successor acquires an expired lock.
// authInFlight is not a lock. A live lease still rejects a second owner.
//
// Bounded compensation: one follow-up updateUser when a call's own
// updateUser resolved but getUser does not match, or when the generation
// changed and Auth does not match the latest intent. A thrown or
// unconfirmed Auth response is not retried inside the call. The admin
// retry is the retry.
//
// Reconcile repairs Auth only when this call's desired state is the stored
// intent. A call that supersedes the stored intent does not send a repair
// RPC for the old desire. A same-direction repair holds the resume lease
// for that generation across its one updateUser. After that RPC, a moved
// generation is compensated once toward the latest intent and this call
// stops without success and without starting another generation. That
// compensation is another updateUser and can still land after this process
// stops. The new generation for an opposite request is written in the
// ownership transaction, and that call's Auth write is for the new desire.
//
// setProductBlockedIfCurrent refuses the write when the intent generation
// has moved, and when this generation is already a confirmed unsuspend.
// A stale caller cannot put the flag back after a newer completion.
//
// RESIDUAL, not closed: an updateUser Identity Toolkit has already accepted
// can still be applied after the confirming getUser and after this process
// has stopped. Nothing here can cancel that RPC. The 120s lease and the
// 60s timeout do not cancel it. After it lands, Auth can disagree with the
// latest intent until a later admin call observes it. That is not proof of
// safety.
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
  beforeRepairDecision: null,
  afterRepairAuthorized: null,
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

function authIntentRef(userId) {
  return db().doc(`users/${userId}/private/authIntent`);
}

function userRef(userId) {
  return db().doc(`users/${userId}`);
}

function suspensionLockBody(existing, ownerOperationId, now, generation) {
  const kept = existing && Number.isInteger(existing.generation) ? existing.generation : 0;
  return {
    ownerOperationId,
    acquiredAt: existing && existing.acquiredAt ? existing.acquiredAt : now,
    leaseExpiresAt: Timestamp.fromMillis(now.toMillis() + SUSPENSION_LOCK_LEASE_MS),
    generation: Number.isInteger(generation) ? generation : kept,
  };
}

function leaseIsLive(data, nowMs) {
  const expires = data && data.leaseExpiresAt && typeof data.leaseExpiresAt.toMillis === 'function'
    ? data.leaseExpiresAt.toMillis() : 0;
  return expires > nowMs;
}

async function rejectIfLockedByOther(userId) {
  const snap = await suspensionLockRef(userId).get();
  if (!snap.exists) return;
  const data = snap.data() || {};
  if (leaseIsLive(data, Timestamp.now().toMillis())) {
    throw new HttpsError('aborted', 'Another suspension change is in progress for this user; please retry.');
  }
}

async function readIntent(userId) {
  const snap = await authIntentRef(userId).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  if (!Number.isInteger(data.generation) || typeof data.desiredDisabled !== 'boolean') return null;
  return data;
}

async function readDisabled(userId) {
  try {
    const user = await getAuth().getUser(userId);
    return { ok: true, disabled: user.disabled === true };
  } catch (err) {
    if (err && err.code === 'auth/user-not-found') return { ok: false, notFound: true, err };
    return { ok: false, err };
  }
}

async function setProductBlockedIfCurrent(userId, expectedGeneration) {
  if (!Number.isInteger(expectedGeneration)) return false;
  const intentRef = authIntentRef(userId);
  const ref = userRef(userId);
  let wrote = false;
  await db().runTransaction(async (tx) => {
    const intentSnap = await tx.get(intentRef);
    const intent = intentSnap.exists ? (intentSnap.data() || {}) : null;
    if (!intent || intent.generation !== expectedGeneration) {
      wrote = false;
      return;
    }
    if (intent.phase === 'confirmed' && intent.desiredDisabled === false) {
      wrote = false;
      return;
    }
    wrote = true;
    tx.update(ref, {
      productAccessBlocked: true,
      updatedAt: Timestamp.now(),
    });
  });
  return wrote;
}

async function withUserSuspensionLock(userId, fn, mode, resumeGeneration) {
  const lockRef = suspensionLockRef(userId);
  const intentRef = authIntentRef(userId);
  const ownerOperationId = randomUUID();
  const hookAttempts = hooks.acquireAttempts;
  const attempts = Number.isInteger(hookAttempts) ? hookAttempts : 6;
  let generation = null;
  for (let attempt = 0; attempt < attempts && generation === null; attempt++) {
    if (attempt > 0 && !Number.isInteger(hookAttempts)) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(400 * attempt, 2000)));
    }
    generation = await db().runTransaction(async (tx) => {
      const snap = await tx.get(lockRef);
      const intentSnap = await tx.get(intentRef);
      const now = Timestamp.now();
      const data = snap.exists ? (snap.data() || {}) : null;
      if (data && leaseIsLive(data, now.toMillis()) && data.ownerOperationId !== ownerOperationId) return null;
      const fromLock = data && Number.isInteger(data.generation) ? data.generation : null;
      const fromIntent = intentSnap.exists && Number.isInteger((intentSnap.data() || {}).generation)
        ? intentSnap.data().generation : 0;
      const currentGen = fromLock === null ? fromIntent : fromLock;
      if (mode === 'resume') {
        if (!Number.isInteger(resumeGeneration) || currentGen !== resumeGeneration) return null;
      }
      const nextGen = mode === 'resume' ? resumeGeneration : currentGen + 1;
      tx.set(lockRef, suspensionLockBody(data, ownerOperationId, now, nextGen));
      return nextGen;
    });
  }
  if (generation === null) {
    throw new HttpsError('aborted', 'Another suspension change is in progress for this user; please retry.');
  }
  try {
    if (typeof hooks.afterLockAcquired === 'function') {
      await hooks.afterLockAcquired({ userId, ownerOperationId, generation });
    }
    return await fn(ownerOperationId, generation);
  } finally {
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(lockRef);
      if (!snap.exists) return;
      if ((snap.data() || {}).ownerOperationId !== ownerOperationId) return;
      tx.delete(lockRef);
    }).catch(() => {});
  }
}

async function renewSuspensionLock(userId, ownerOperationId, generation) {
  const lockRef = suspensionLockRef(userId);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(lockRef);
    if (!snap.exists) return false;
    const data = snap.data() || {};
    if (data.ownerOperationId !== ownerOperationId) return false;
    if (Number.isInteger(generation) && data.generation !== generation) return false;
    tx.set(lockRef, suspensionLockBody(data, ownerOperationId, Timestamp.now(), data.generation));
    return true;
  });
}

async function commitOwnedSuspensionRecords(userId, ownerOperationId, generation, write, expectIntent) {
  const lockRef = suspensionLockRef(userId);
  const intentRef = authIntentRef(userId);
  try {
    await db().runTransaction(async (tx) => {
      const snap = await tx.get(lockRef);
      const intentSnap = await tx.get(intentRef);
      const data = snap.exists ? (snap.data() || {}) : null;
      const intent = intentSnap.exists ? (intentSnap.data() || {}) : null;
      if (!data || data.ownerOperationId !== ownerOperationId || data.generation !== generation) {
        const lost = new Error('suspension lock lost');
        lost.code = 'suspension/lock-lost';
        throw lost;
      }
      if (expectIntent && (!intent || intent.generation !== generation)) {
        const lost = new Error('suspension lock lost');
        lost.code = 'suspension/lock-lost';
        throw lost;
      }
      const now = Timestamp.now();
      tx.set(lockRef, suspensionLockBody(data, ownerOperationId, now, generation));
      write(tx, now, intent);
    });
    return { outcome: 'committed' };
  } catch (err) {
    if (err && (err.code === 'suspension/lock-lost' || err.message === 'suspension lock lost')) {
      return { outcome: 'lost' };
    }
    return { outcome: 'error', error: err };
  }
}

// One Auth write, then a confirming read. A resolved promise is not treated
// as applied until getUser shows the bit. A throw plus a matching getUser
// is applied. A throw plus a failed getUser stays unconfirmed.
async function sendAndConfirm(userId, desiredDisabled) {
  let rpcError = null;
  try {
    await getAuth().updateUser(userId, { disabled: desiredDisabled });
  } catch (err) {
    if (err && err.code === 'auth/user-not-found') return { outcome: 'not-found', err };
    rpcError = err;
  }
  try {
    const user = await getAuth().getUser(userId);
    if (user.disabled === desiredDisabled) return { outcome: 'applied', recovered: !!rpcError };
    return { outcome: 'rejected', disabled: user.disabled === true, rpcError };
  } catch (err) {
    return { outcome: 'unconfirmed', rpcError: rpcError || err };
  }
}

async function compensateTowardLatest(userId) {
  const intent = await readIntent(userId);
  if (!intent) return { matched: false, missing: true };
  const observed = await readDisabled(userId);
  if (!observed.ok) return { matched: false, unconfirmed: true, intent };
  if (observed.disabled === intent.desiredDisabled) return { matched: true, intent };
  const again = await readIntent(userId);
  if (!again || again.generation !== intent.generation) return { matched: false, superseded: true };
  const sent = await sendAndConfirm(userId, again.desiredDisabled);
  const after = await readIntent(userId);
  if (!after || after.generation !== again.generation) return { matched: false, superseded: true };
  if (sent.outcome !== 'applied') return { matched: false, failed: true, sent };
  return { matched: true, intent: after };
}

const SUSPENSION_LOCK_BUSY = 'Another suspension change is in progress for this user; please retry.';

function suspensionLockBusy(err) {
  return !!(err && err.code === 'aborted' && err.message === SUSPENSION_LOCK_BUSY);
}

function repairNotApplied(requestedDesiredDisabled, sent, flagKept) {
  const unconfirmed = !sent || sent.outcome === 'unconfirmed';
  const disabling = requestedDesiredDisabled === true;
  let message;
  if (unconfirmed) {
    message = flagKept
      ? (disabling
        ? 'The access block is saved, but the account disable could not be confirmed. The access block was not cleared. Retry.'
        : 'The access block is still in place, but sign-in could not be confirmed. The access block was not cleared. Retry.')
      : 'Sign-in could not be confirmed. This attempt was not kept. Retry.';
  } else if (disabling) {
    message = flagKept
      ? 'The access block is saved, but disabling sign-in failed. The access block was not cleared. Retry.'
      : 'Disabling sign-in failed. This attempt was not kept. Retry.';
  } else {
    message = flagKept
      ? 'The access block is still in place, and re-enabling sign-in failed. The access block was not cleared. Retry.'
      : 'Re-enabling sign-in failed. This attempt was not kept. Retry.';
  }
  return new HttpsError('aborted', message, {
    partial: true,
    authDisabled: unconfirmed ? null : sent.disabled === true,
    productAccessBlocked: flagKept === true,
    recordWritten: flagKept === true,
  });
}

// Returns true only when this call applied a same-direction repair and the
// generation was still the repaired generation afterwards. The caller must
// not treat that as suspension success until revokeRefreshTokens runs.
async function reconcileStoredIntent(userId, requestedDesiredDisabled) {
  const intent = await readIntent(userId);
  if (!intent) return false;
  // This invocation is about to write a new generation for the opposite
  // desire. Do not send updateUser for the stored intent first.
  if (intent.desiredDisabled !== requestedDesiredDisabled) return false;
  const observed = await readDisabled(userId);
  if (observed.notFound) throw mapSuspensionAuthError(observed.err);
  if (!observed.ok) {
    const kept = await setProductBlockedIfCurrent(userId, intent.generation);
    throw repairNotApplied(requestedDesiredDisabled, { outcome: 'unconfirmed' }, kept);
  }
  if (observed.disabled === intent.desiredDisabled) return false;

  try {
    return await withUserSuspensionLock(userId, async (ownerOperationId, heldGeneration) => {
      const again = await readIntent(userId);
      if (!again || again.generation !== intent.generation || again.desiredDisabled !== requestedDesiredDisabled || heldGeneration !== intent.generation) {
        throw new HttpsError('aborted', 'Lock ownership lost before sign-in was changed. This attempt was not kept. Retry.');
      }
      if (!(await renewSuspensionLock(userId, ownerOperationId, heldGeneration))) {
        throw new HttpsError('aborted', 'Lock ownership lost before sign-in was changed. This attempt was not kept. Retry.');
      }
      const still = await readDisabled(userId);
      if (still.notFound) throw mapSuspensionAuthError(still.err);
      if (!still.ok) {
        const kept = await setProductBlockedIfCurrent(userId, intent.generation);
        throw repairNotApplied(requestedDesiredDisabled, { outcome: 'unconfirmed' }, kept);
      }
      if (still.disabled === again.desiredDisabled) return false;
      await setProductBlockedIfCurrent(userId, intent.generation);
      const sent = await sendAndConfirm(userId, again.desiredDisabled);
      const latest = await readIntent(userId);
      if (!latest || latest.generation !== intent.generation) {
        // One follower RPC toward whatever generation won. It can still
        // land after this call stops. Do not start another generation.
        await compensateTowardLatest(userId);
        throw new HttpsError('aborted', 'Lock ownership lost after sign-in was changed. This attempt was not kept. Retry.');
      }
      if (sent.outcome !== 'applied') {
        const kept = await setProductBlockedIfCurrent(userId, intent.generation);
        throw repairNotApplied(requestedDesiredDisabled, sent, kept);
      }
      return true;
    }, 'resume', intent.generation);
  } catch (err) {
    if (!suspensionLockBusy(err)) throw err;
    const latest = await readIntent(userId);
    // The repair RPC was not sent. A finished successor may be handled by
    // the caller's own generation increment. A still-live lease must not be.
    if (!latest || latest.generation !== intent.generation || latest.desiredDisabled !== requestedDesiredDisabled) return false;
    throw err;
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

async function finishSuspend(request, userId, generation, reason, requireRevoke) {
  const intent = await readIntent(userId);
  const pub = await userRef(userId).get();
  const data = pub.exists ? pub.data() || {} : {};
  // A confirmed record already revoked when it was confirmed. A same-direction
  // repair that has just re-disabled Auth must not take this return: sessions
  // minted while Auth was enabled are still live until revokeRefreshTokens.
  if (!requireRevoke && intent && intent.phase === 'confirmed' && data.status === 'Suspended' && data.productAccessBlocked === true) {
    return { success: true };
  }
  return withUserSuspensionLock(userId, async (ownerOperationId, heldGeneration) => {
    const observed = await readDisabled(userId);
    if (!observed.ok || observed.disabled !== true || heldGeneration !== generation) {
      await setProductBlockedIfCurrent(userId, heldGeneration);
      throw new HttpsError('aborted', 'The access block is saved, but disabling sign-in failed. The access block was not cleared. Retry.', {
        partial: true, authDisabled: observed.ok ? observed.disabled : null, productAccessBlocked: true, recordWritten: true,
      });
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
    const completed = await commitOwnedSuspensionRecords(userId, ownerOperationId, heldGeneration, (tx, now, currentIntent) => {
      if (!currentIntent || currentIntent.desiredDisabled !== true) {
        const lost = new Error('suspension lock lost');
        lost.code = 'suspension/lock-lost';
        throw lost;
      }
      tx.update(userRef(userId), {
        status: 'Suspended',
        productAccessBlocked: true,
        updatedAt: now,
        ...legacySuspensionFieldDeletes(),
      });
      tx.set(authIntentRef(userId), {
        generation: heldGeneration,
        desiredDisabled: true,
        ownerOperationId,
        phase: revoked ? 'confirmed' : 'pending',
      });
      const base = { ...auditBase(request, userId, now), reason };
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
    }, true);
    if (completed.outcome !== 'committed' || !revoked) {
      throw new HttpsError(
        'aborted',
        revoked
          ? 'Lock ownership lost before the suspension audit was kept. The access block was kept. Retry.'
          : 'The account is disabled and the access block is saved, but revoking its existing sessions failed. Retry to finish.',
        { partial: true, authDisabled: true, revoked, productAccessBlocked: true, recordWritten: true, auditWritten: completed.outcome === 'committed' },
      );
    }
    return { success: true };
  }, 'resume', generation);
}

async function finishUnsuspend(request, userId, generation) {
  const intent = await readIntent(userId);
  const pub = await userRef(userId).get();
  const data = pub.exists ? pub.data() || {} : {};
  const flagPresent = data.productAccessBlocked !== undefined;
  if (intent && intent.phase === 'confirmed' && !flagPresent && data.status === 'Active') {
    const observed = await readDisabled(userId);
    if (observed.ok && observed.disabled === false) return { success: true };
  }
  return withUserSuspensionLock(userId, async (ownerOperationId, heldGeneration) => {
    const observed = await readDisabled(userId);
    if (!observed.ok || observed.disabled !== false || heldGeneration !== generation) {
      await setProductBlockedIfCurrent(userId, heldGeneration);
      throw new HttpsError(
        'aborted',
        'The access block is still in place, and re-enabling sign-in failed. The access block was not cleared. Retry.',
        { partial: true, authDisabled: observed.ok ? observed.disabled : null, productAccessBlocked: true, recordWritten: true },
      );
    }
    const completionRef = db().collection('adminAuditLog').doc();
    const completed = await commitOwnedSuspensionRecords(userId, ownerOperationId, heldGeneration, (tx, now, currentIntent) => {
      if (!currentIntent || currentIntent.desiredDisabled !== false || currentIntent.generation !== heldGeneration) {
        const lost = new Error('suspension lock lost');
        lost.code = 'suspension/lock-lost';
        throw lost;
      }
      tx.update(userRef(userId), {
        status: 'Active',
        productAccessBlocked: FieldValue.delete(),
        updatedAt: now,
        ...legacySuspensionFieldDeletes(),
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
      tx.set(authIntentRef(userId), {
        generation: heldGeneration,
        desiredDisabled: false,
        ownerOperationId,
        phase: 'confirmed',
      });
      tx.set(completionRef, {
        action: 'user.unsuspend',
        ...auditBase(request, userId, now),
      });
    }, true);
    if (completed.outcome !== 'committed') {
      await setProductBlockedIfCurrent(userId, heldGeneration);
      throw new HttpsError(
        'aborted',
        'Lock ownership lost before the access block could be cleared. The completion was not kept. Retry.',
        { partial: true, authDisabled: false, productAccessBlocked: true, recordWritten: true, auditWritten: false },
      );
    }
    return { success: true };
  }, 'resume', generation);
}

async function onAuthSettled(userId, generation, desiredDisabled, sent) {
  if (sent.outcome === 'not-found') {
    throw new HttpsError('not-found', 'User not found. The access block was kept.');
  }
  const intentAfter = await readIntent(userId);
  const generationMoved = !intentAfter || intentAfter.generation !== generation;
  const acceptedButInvisible = sent.outcome === 'rejected' && !sent.rpcError;
  if (generationMoved || acceptedButInvisible) {
    const comp = await compensateTowardLatest(userId);
    if (generationMoved) {
      throw new HttpsError('aborted', 'Lock ownership lost. This attempt was not kept. Retry.');
    }
    if (!comp.matched) {
      await setProductBlockedIfCurrent(userId, generation).catch(() => {});
      const unconfirmed = sent.outcome === 'unconfirmed' || (comp.sent && comp.sent.outcome === 'unconfirmed');
      throw new HttpsError(
        'aborted',
        unconfirmed
          ? 'The access block is saved, but the account disable could not be confirmed. The access block was not cleared. Retry.'
          : 'The access block is saved, but disabling sign-in failed. The access block was not cleared. Retry.',
        { partial: true, authDisabled: unconfirmed ? null : !desiredDisabled, productAccessBlocked: true, recordWritten: true },
      );
    }
    return;
  }
  if (sent.outcome !== 'applied') {
    const unconfirmed = sent.outcome === 'unconfirmed';
    throw new HttpsError(
      'aborted',
      desiredDisabled
        ? (unconfirmed
          ? 'The access block is saved, but the account disable could not be confirmed. The access block was not cleared. Retry.'
          : 'The access block is saved, but disabling sign-in failed. The access block was not cleared. Retry.')
        : (unconfirmed
          ? 'The access block is still in place, but sign-in could not be confirmed. The access block was not cleared. Retry.'
          : 'The access block is still in place, and re-enabling sign-in failed. The access block was not cleared. Retry.'),
      {
        partial: true,
        authDisabled: unconfirmed ? null : !desiredDisabled,
        productAccessBlocked: true,
        recordWritten: true,
      },
    );
  }
}

async function adminSuspendUser(request) {
  await requireCurrentAdmin(request);
  const { userId, reason } = request.data || {};
  if (!userId || typeof userId !== 'string') throw new HttpsError('invalid-argument', 'userId required.');
  if (!reason || typeof reason !== 'string' || !reason.trim()) throw new HttpsError('invalid-argument', 'reason required.');
  if (userId === request.auth.uid) throw new HttpsError('failed-precondition', 'You cannot suspend your own account.');

  if (!(await userRef(userId).get()).exists) throw new HttpsError('not-found', 'User not found.');
  try {
    await getAuth().getUser(userId);
  } catch (err) {
    console.error('adminSuspendUser: auth step failed', { step: 'lookup', code: err && err.code ? String(err.code) : 'unknown' });
    throw mapSuspensionAuthError(err);
  }

  await rejectIfLockedByOther(userId);
  const repairedSuspend = await reconcileStoredIntent(userId, true) === true;
  const stored = await readIntent(userId);
  if (stored && stored.desiredDisabled === true) {
    const observed = await readDisabled(userId);
    if (observed.ok && observed.disabled === true) {
      return finishSuspend(request, userId, stored.generation, reason.trim(), repairedSuspend);
    }
  }

  const trimmedReason = reason.trim();
  return withUserSuspensionLock(userId, async (ownerOperationId, generation) => {
    const pendingRef = db().collection('adminAuditLog').doc();
    const wrote = await commitOwnedSuspensionRecords(userId, ownerOperationId, generation, (tx, now) => {
      tx.update(userRef(userId), {
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
      tx.set(authIntentRef(userId), {
        generation,
        desiredDisabled: true,
        ownerOperationId,
        phase: 'pending',
      });
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
      const pub = await userRef(userId).get().catch(() => null);
      const data = pub && pub.exists ? pub.data() : null;
      const blocked = !!(data && data.productAccessBlocked === true && data.status === 'Suspended');
      if (!blocked) {
        throw new HttpsError('internal', 'Could not save the access block. Sign-in was not changed. Please retry.');
      }
    }
    if (!(await renewSuspensionLock(userId, ownerOperationId, generation))) {
      throw new HttpsError('aborted', 'Lock ownership lost before the account was disabled. The access block was kept. Retry.');
    }
    if (typeof hooks.beforeAuthRpc === 'function') await hooks.beforeAuthRpc({ userId, ownerOperationId, op: 'suspend', generation });
    const sent = await sendAndConfirm(userId, true);
    if (typeof hooks.afterAuthRpc === 'function') await hooks.afterAuthRpc({ userId, ownerOperationId, op: 'suspend', outcome: sent.outcome, generation });
    try {
      await onAuthSettled(userId, generation, true, sent);
    } catch (err) {
      if (sent.outcome !== 'applied' && sent.outcome !== 'not-found') {
        const unconfirmed = sent.outcome === 'unconfirmed';
        await writeSuspensionPartialAudit({
          action: 'user.suspend.partial',
          ...auditBase(request, userId, Timestamp.now()),
          reason: trimmedReason,
          failedStep: 'disable',
          errorCode: sent.rpcError && sent.rpcError.code ? String(sent.rpcError.code) : 'unknown',
          authDisabled: unconfirmed ? null : false,
          productAccessBlocked: true,
          recordWritten: true,
          ...(unconfirmed ? { authState: 'unconfirmed' } : {}),
        });
      }
      throw err;
    }
    if (!(await renewSuspensionLock(userId, ownerOperationId, generation))) {
      const latest = await readIntent(userId);
      if (latest && latest.generation === generation) {
        const comp = await compensateTowardLatest(userId);
        if (!comp.matched) await setProductBlockedIfCurrent(userId, generation).catch(() => {});
      }
      throw new HttpsError('aborted', 'Lock ownership lost after the account was disabled. The access block was kept. Retry.');
    }
    const confirm = await readDisabled(userId);
    if (!confirm.ok || confirm.disabled !== true) {
      await setProductBlockedIfCurrent(userId, generation).catch(() => {});
      throw new HttpsError('aborted', 'The access block is saved, but disabling sign-in failed. The access block was not cleared. Retry.', {
        partial: true, authDisabled: confirm.ok ? confirm.disabled : null, productAccessBlocked: true, recordWritten: true,
      });
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
    const completed = await commitOwnedSuspensionRecords(userId, ownerOperationId, generation, (tx, now, intent) => {
      if (!intent || intent.desiredDisabled !== true || intent.generation !== generation) {
        const lost = new Error('suspension lock lost');
        lost.code = 'suspension/lock-lost';
        throw lost;
      }
      tx.set(authIntentRef(userId), {
        generation,
        desiredDisabled: true,
        ownerOperationId,
        phase: revoked ? 'confirmed' : 'pending',
      });
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
    }, true);
    if (completed.outcome === 'lost') {
      throw new HttpsError('aborted', 'Lock ownership lost before the suspension audit was kept. The access block was kept. Retry.');
    }
    if (!revoked) {
      throw new HttpsError(
        'aborted',
        'The account is disabled and the access block is saved, but revoking its existing sessions failed. Retry to finish.',
        { partial: true, authDisabled: true, revoked: false, productAccessBlocked: true, recordWritten: true, auditWritten: true },
      );
    }
    return { success: true };
  }, 'increment');
}

async function adminUnsuspendUser(request) {
  await requireCurrentAdmin(request);
  const { userId } = request.data || {};
  if (!userId || typeof userId !== 'string') throw new HttpsError('invalid-argument', 'userId required.');

  if (!(await userRef(userId).get()).exists) throw new HttpsError('not-found', 'User not found.');
  try {
    await getAuth().getUser(userId);
  } catch (err) {
    console.error('adminUnsuspendUser: auth step failed', { step: 'lookup', code: err && err.code ? String(err.code) : 'unknown' });
    throw mapSuspensionAuthError(err);
  }

  await rejectIfLockedByOther(userId);
  await reconcileStoredIntent(userId, false);
  const stored = await readIntent(userId);
  if (stored && stored.desiredDisabled === false) {
    const observed = await readDisabled(userId);
    if (observed.ok && observed.disabled === false) {
      return finishUnsuspend(request, userId, stored.generation);
    }
  }

  return withUserSuspensionLock(userId, async (ownerOperationId, generation) => {
    const pendingRef = db().collection('adminAuditLog').doc();
    const wrote = await commitOwnedSuspensionRecords(userId, ownerOperationId, generation, (tx, now) => {
      tx.update(userRef(userId), {
        status: 'Active',
        productAccessBlocked: true,
        updatedAt: now,
        ...legacySuspensionFieldDeletes(),
      });
      tx.set(authIntentRef(userId), {
        generation,
        desiredDisabled: false,
        ownerOperationId,
        phase: 'pending',
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
      const pub = await userRef(userId).get().catch(() => null);
      const data = pub && pub.exists ? pub.data() : null;
      const pendingKept = !!(data && data.productAccessBlocked === true);
      if (wrote.outcome === 'lost' || !pendingKept) {
        throw new HttpsError('aborted', 'Could not save the unsuspend attempt. The access block was not cleared and sign-in was not re-enabled. Retry.');
      }
    }
    if (!(await renewSuspensionLock(userId, ownerOperationId, generation))) {
      throw new HttpsError('aborted', 'Lock ownership lost before sign-in was re-enabled. The access block was kept. Retry.');
    }
    if (typeof hooks.beforeAuthRpc === 'function') await hooks.beforeAuthRpc({ userId, ownerOperationId, op: 'unsuspend', generation });
    const sent = await sendAndConfirm(userId, false);
    if (typeof hooks.afterAuthRpc === 'function') await hooks.afterAuthRpc({ userId, ownerOperationId, op: 'unsuspend', outcome: sent.outcome, generation });
    try {
      await onAuthSettled(userId, generation, false, sent);
    } catch (err) {
      if (sent.outcome !== 'applied' && sent.outcome !== 'not-found') {
        const unconfirmed = sent.outcome === 'unconfirmed';
        await writeSuspensionPartialAudit({
          action: 'user.unsuspend.partial',
          ...auditBase(request, userId, Timestamp.now()),
          failedStep: 'enable',
          errorCode: sent.rpcError && sent.rpcError.code ? String(sent.rpcError.code) : 'unknown',
          authDisabled: unconfirmed ? null : true,
          productAccessBlocked: true,
          recordWritten: true,
          ...(unconfirmed ? { authState: 'unconfirmed' } : {}),
        });
      }
      throw err;
    }
    if (!(await renewSuspensionLock(userId, ownerOperationId, generation))) {
      const latest = await readIntent(userId);
      if (latest && latest.generation === generation) {
        const comp = await compensateTowardLatest(userId);
        if (!comp.matched) await setProductBlockedIfCurrent(userId, generation).catch(() => {});
      }
      throw new HttpsError('aborted', 'Lock ownership lost after sign-in was changed. The access block was kept. Retry.');
    }
    const confirm = await readDisabled(userId);
    if (!confirm.ok || confirm.disabled !== false) {
      await setProductBlockedIfCurrent(userId, generation).catch(() => {});
      throw new HttpsError(
        'aborted',
        'The access block is still in place, and re-enabling sign-in failed. The access block was not cleared. Retry.',
        { partial: true, authDisabled: confirm.ok ? confirm.disabled : null, productAccessBlocked: true, recordWritten: true },
      );
    }
    const completionRef = db().collection('adminAuditLog').doc();
    const completed = await commitOwnedSuspensionRecords(userId, ownerOperationId, generation, (tx, now, intent) => {
      if (!intent || intent.desiredDisabled !== false || intent.generation !== generation) {
        const lost = new Error('suspension lock lost');
        lost.code = 'suspension/lock-lost';
        throw lost;
      }
      tx.update(userRef(userId), {
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
      tx.set(authIntentRef(userId), {
        generation,
        desiredDisabled: false,
        ownerOperationId,
        phase: 'confirmed',
      });
      tx.set(completionRef, {
        action: 'user.unsuspend',
        ...auditBase(request, userId, now),
      });
    }, true);
    if (completed.outcome !== 'committed') {
      await setProductBlockedIfCurrent(userId, generation).catch(() => {});
      throw new HttpsError(
        'aborted',
        'Lock ownership lost before the access block could be cleared. The completion was not kept. Retry.',
        { partial: true, authDisabled: false, productAccessBlocked: true, recordWritten: true, auditWritten: false },
      );
    }
    return { success: true };
  }, 'increment');
}

function parseAuthIntent(data) {
  if (!data || typeof data !== 'object') return null;
  if (!Number.isInteger(data.generation) || data.generation < 0) return null;
  if (typeof data.desiredDisabled !== 'boolean') return null;
  if (data.phase !== 'pending' && data.phase !== 'confirmed') return null;
  return data;
}

function repairResult(outcome, extra) {
  return {
    outcome,
    issued: false,
    retractable: false,
    stable: false,
    generation: null,
    desiredDisabled: null,
    observedDisabled: null,
    ...extra,
    retractable: false,
    stable: false,
  };
}

async function deletionBlocksRepair(userId) {
  const snap = await db().doc(`accountDeletionJobs/${userId}`).get();
  return snap.exists;
}

function denialAbsent(profile) {
  return !!profile && !Object.prototype.hasOwnProperty.call(profile, 'productAccessBlocked');
}

function enableEligible(intent, profile) {
  return !!intent
    && intent.desiredDisabled === false
    && intent.phase === 'confirmed'
    && !!profile
    && profile.status === 'Active'
    && denialAbsent(profile);
}

async function readRepairSnapshot(userId) {
  const intentRef = authIntentRef(userId);
  const profileRef = userRef(userId);
  const jobRef = db().doc(`accountDeletionJobs/${userId}`);
  return db().runTransaction(async (tx) => {
    const [intentSnap, profileSnap, jobSnap] = await Promise.all([
      tx.get(intentRef),
      tx.get(profileRef),
      tx.get(jobRef),
    ]);
    return {
      intent: intentSnap.exists ? parseAuthIntent(intentSnap.data()) : null,
      profile: profileSnap.exists ? (profileSnap.data() || {}) : null,
      deletion: jobSnap.exists,
    };
  });
}

// One pass toward the current authIntent. It does not write the public
// profile, the denial flag, or a success record. A matching getUser is not
// a promise that an already-accepted updateUser will stay at that bit.
//
// An enable is issued only for a confirmed generation whose profile is
// Active and whose denial flag is absent. The deletion job is read again
// in that same transaction immediately before updateUser. A job created
// after that transaction, or an Auth RPC accepted before it returns, can
// still overlap deletion. This pass cannot close that gap.
async function reconcileAuthReplica(userId) {
  if (typeof userId !== 'string' || userId.length === 0) return repairResult('refused');
  const profile = await userRef(userId).get();
  if (!profile.exists) return repairResult('refused');
  if (await deletionBlocksRepair(userId)) return repairResult('deletion');

  const intentSnap = await authIntentRef(userId).get();
  if (!intentSnap.exists) return repairResult('refused');
  const intent = parseAuthIntent(intentSnap.data());
  if (!intent) return repairResult('refused');

  const lockSnap = await suspensionLockRef(userId).get();
  if (lockSnap.exists && leaseIsLive(lockSnap.data(), Timestamp.now().toMillis())) {
    return repairResult('lease-held', {
      generation: intent.generation,
      desiredDisabled: intent.desiredDisabled,
    });
  }

  try {
    return await withUserSuspensionLock(userId, async (ownerOperationId, heldGeneration) => {
      if (typeof hooks.beforeRepairDecision === 'function') {
        await hooks.beforeRepairDecision({ userId, generation: intent.generation });
      }
      const snap = await readRepairSnapshot(userId);
      const base = { generation: intent.generation, desiredDisabled: intent.desiredDisabled };
      if (snap.deletion) return repairResult('deletion', base);
      if (!snap.profile) return repairResult('refused', base);
      if (!snap.intent || snap.intent.generation !== intent.generation || snap.intent.desiredDisabled !== intent.desiredDisabled || heldGeneration !== intent.generation) {
        return repairResult('superseded', base);
      }
      if (snap.intent.desiredDisabled === false && !enableEligible(snap.intent, snap.profile)) {
        return repairResult('ineligible', base);
      }
      if (!(await renewSuspensionLock(userId, ownerOperationId, heldGeneration))) {
        return repairResult('lease-held', base);
      }
      const observed = await readDisabled(userId);
      if (observed.notFound) return repairResult('not-found', base);
      if (!observed.ok) return repairResult('unconfirmed', base);
      if (observed.disabled === snap.intent.desiredDisabled) {
        return repairResult('matched', { ...base, observedDisabled: observed.disabled });
      }
      const gate = await readRepairSnapshot(userId);
      if (gate.deletion) return repairResult('deletion', base);
      if (!gate.intent || gate.intent.generation !== intent.generation || gate.intent.desiredDisabled !== intent.desiredDisabled) {
        return repairResult('superseded', base);
      }
      if (gate.intent.desiredDisabled === false && !enableEligible(gate.intent, gate.profile)) {
        return repairResult('ineligible', base);
      }
      if (typeof hooks.afterRepairAuthorized === 'function') {
        await hooks.afterRepairAuthorized({ userId, generation: intent.generation });
      }
      const sent = await sendAndConfirm(userId, intent.desiredDisabled);
      const afterSnap = await authIntentRef(userId).get();
      const after = afterSnap.exists ? parseAuthIntent(afterSnap.data()) : null;
      const moved = !after || after.generation !== intent.generation || after.desiredDisabled !== intent.desiredDisabled;
      if (moved) {
        return repairResult('superseded', {
          ...base,
          issued: true,
          observedDisabled: sent.outcome === 'applied' ? intent.desiredDisabled : sent.disabled === true,
        });
      }
      if (sent.outcome === 'not-found') return repairResult('not-found', { ...base, issued: true });
      if (sent.outcome !== 'applied') {
        return repairResult(sent.outcome === 'unconfirmed' ? 'unconfirmed' : 'rejected', {
          ...base,
          issued: true,
          observedDisabled: typeof sent.disabled === 'boolean' ? sent.disabled : null,
        });
      }
      return repairResult('repaired', { ...base, issued: true, observedDisabled: intent.desiredDisabled });
    }, 'resume', intent.generation);
  } catch (err) {
    if (!suspensionLockBusy(err)) throw err;
    const latestSnap = await authIntentRef(userId).get();
    const latest = latestSnap.exists ? parseAuthIntent(latestSnap.data()) : null;
    if (!latest || latest.generation !== intent.generation || latest.desiredDisabled !== intent.desiredDisabled) {
      return repairResult('superseded', { generation: intent.generation, desiredDisabled: intent.desiredDisabled });
    }
    return repairResult('lease-held', { generation: intent.generation, desiredDisabled: intent.desiredDisabled });
  }
}

module.exports = {
  hooks,
  SUSPENSION_CALL_TIMEOUT_SEC,
  adminSuspendUser,
  adminUnsuspendUser,
  reconcileAuthReplica,
};
