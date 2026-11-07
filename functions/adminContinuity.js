'use strict';

const { randomUUID } = require('crypto');
const { HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

// adminContinuity/{uid} records removal uncertainty. It does not grant a role.
// Auth custom claims remain the grant. Any persisted removal row excludes the
// uid from the reserved-usable count, including phase confirmed. A matching
// getUser, a newer generation, an unsuspend, a role grant, a lease expiry, and
// elapsed time do not clear that exclusion. Nothing here writes
// resolutionAuthorized. Restoring survivor eligibility needs a future protocol
// that is not implemented. Until then, a previously removed administrator may
// hold the role again but cannot be the survivor that makes another removal safe.
const LEASE_MS = 120000;
const ACQUIRE_ATTEMPTS = 6;

function db() {
  return getFirestore();
}

function continuityRef(uid) {
  return db().doc(`adminContinuity/${uid}`);
}

function profileBlocks(data) {
  if (!data) return false;
  if (data.status === 'Suspended') return true;
  if (!Object.prototype.hasOwnProperty.call(data, 'productAccessBlocked')) return false;
  return data.productAccessBlocked !== false;
}

function removalUnresolved(data) {
  // Confirmed is an observation, not proof that every accepted Auth write finished.
  return !!data && data.resolutionAuthorized !== true;
}

async function reservedUsable(user) {
  if (!user || user.disabled || user.customClaims?.role !== 'admin') return false;
  const uid = user.uid;
  const [life, profile, continuity, intent] = await Promise.all([
    db().doc(`accountLifecycle/${uid}`).get(),
    db().doc(`users/${uid}`).get(),
    continuityRef(uid).get(),
    db().doc(`users/${uid}/private/authIntent`).get(),
  ]);
  if (life.exists) return false;
  if (profileBlocks(profile.exists ? profile.data() : null)) return false;
  if (removalUnresolved(continuity.exists ? continuity.data() : null)) return false;
  const intentData = intent.exists ? intent.data() || {} : null;
  if (intentData && intentData.desiredDisabled === true && intentData.phase !== 'confirmed') return false;
  return true;
}

async function listReservedUsableAdminUids(excludeUid) {
  const uids = [];
  let pageToken;
  do {
    const page = await getAuth().listUsers(1000, pageToken);
    for (const user of page.users) {
      if (user.uid === excludeUid) continue;
      if (await reservedUsable(user)) uids.push(user.uid);
    }
    pageToken = page.pageToken;
  } while (pageToken);
  return uids;
}

async function countOtherReservedUsableAdmins(excludeUid) {
  const uids = await listReservedUsableAdminUids(excludeUid);
  return uids.length;
}

const PHASE_RANK = { intent: 1, 'rpc-issued': 2, confirmed: 3 };

// A new intent allocates generation inside this transaction as stored+1.
// The clock is not a generation. A later phase must name that generation and
// the same ownerOperationId. A rejected result is not a successful write.
async function recordRemoval(uid, fields) {
  const phase = fields && fields.phase;
  const owner = fields && fields.ownerOperationId;
  const kind = fields && fields.kind;
  if (!uid || !PHASE_RANK[phase] || !owner || (kind !== 'suspend' && kind !== 'demote')) {
    return { committed: false, reason: 'invalid' };
  }
  const ref = continuityRef(uid);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? (snap.data() || {}) : null;
    const updatedAt = Timestamp.now();
    if (phase === 'intent') {
      const priorGen = current && typeof current.generation === 'number' ? current.generation : 0;
      const generation = priorGen + 1;
      if (!Number.isSafeInteger(generation) || generation <= priorGen) {
        return { committed: false, reason: 'generation' };
      }
      tx.set(ref, {
        generation,
        kind,
        phase: 'intent',
        roleLockGeneration: fields.roleLockGeneration == null ? null : fields.roleLockGeneration,
        ownerOperationId: owner,
        priorGeneration: current && typeof current.generation === 'number' ? current.generation : null,
        priorPhase: current && current.phase ? current.phase : null,
        priorOwnerOperationId: current && current.ownerOperationId ? current.ownerOperationId : null,
        updatedAt,
      });
      return { committed: true, generation };
    }
    if (!current || typeof current.generation !== 'number') {
      return { committed: false, reason: 'missing' };
    }
    if (fields.generation !== current.generation) return { committed: false, reason: 'generation' };
    if (current.ownerOperationId !== owner) return { committed: false, reason: 'owner' };
    if (!PHASE_RANK[current.phase] || PHASE_RANK[phase] < PHASE_RANK[current.phase]) {
      return { committed: false, reason: 'phase' };
    }
    tx.set(ref, {
      generation: current.generation,
      kind: current.kind,
      phase,
      roleLockGeneration: current.roleLockGeneration == null ? null : current.roleLockGeneration,
      ownerOperationId: current.ownerOperationId,
      priorGeneration: current.priorGeneration == null ? null : current.priorGeneration,
      priorPhase: current.priorPhase == null ? null : current.priorPhase,
      priorOwnerOperationId: current.priorOwnerOperationId == null ? null : current.priorOwnerOperationId,
      updatedAt,
    });
    return { committed: true, generation: current.generation };
  });
}

async function acquireRoleLock(ownerOperationId = `continuity_${randomUUID()}`) {
  const lockRef = db().doc('adminRoleLock/singleton');
  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(400 * attempt, 2000)));
    }
    const generation = await db().runTransaction(async (tx) => {
      const snap = await tx.get(lockRef);
      const now = Timestamp.now();
      if (snap.exists) {
        const data = snap.data() || {};
        const expired = !data.leaseExpiresAt || data.leaseExpiresAt.toMillis() <= now.toMillis();
        if (!expired && data.ownerOperationId !== ownerOperationId) return null;
      }
      const nextGeneration = Date.now();
      tx.set(lockRef, {
        ownerOperationId,
        roleLockGeneration: nextGeneration,
        acquiredAt: now,
        leaseExpiresAt: Timestamp.fromMillis(now.toMillis() + LEASE_MS),
      });
      return nextGeneration;
    });
    if (generation) return { ownerOperationId, generation };
  }
  throw new HttpsError('aborted', 'Another role operation is in progress; please retry.');
}

async function releaseRoleLock(lock) {
  if (!lock) return;
  const lockRef = db().doc('adminRoleLock/singleton');
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(lockRef);
    if (!snap.exists) return;
    const data = snap.data() || {};
    if (data.ownerOperationId !== lock.ownerOperationId) return;
    if (data.roleLockGeneration !== lock.generation) return;
    tx.delete(lockRef);
  }).catch(() => {});
}

module.exports = {
  acquireRoleLock,
  releaseRoleLock,
  recordRemoval,
  countOtherReservedUsableAdmins,
  listReservedUsableAdminUids,
  removalUnresolved,
};
