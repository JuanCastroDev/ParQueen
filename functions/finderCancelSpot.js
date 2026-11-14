'use strict';

const { HttpsError } = require('firebase-functions/v2/https');
const { userRecordDenies, deletionFencePresent, throwIfDeleting, PRODUCT_ACCESS_DENIED } = require('./productAccess');
const { checkRateLimit } = require('./rateLimiter');
const { sanitizeError } = require('./redactForLog');
const { isClaimGenerationId } = require('./claimGeneration');
const { readActiveIncomingClaim, deleteMatchingActiveIncomingClaim } = require('./activeIncomingClaim');
const { NOTICE_MESSAGE } = require('./finderCancelNotice');
const { RECEIPT_COLLECTION, receiptDocumentId, receiptBody } = require('./finderCancelReceipt');
const {
  isGenerationless,
  parseLegacyFingerprint,
  timestampFingerprint,
  sameFingerprint,
  legacyToken,
} = require('./legacyClaimIdentity');

// Finder cancellation Policy B. The request names the claim the finder
// confirmed. It is not authority for the current document. The transaction
// rereads the spot and deletes only when that stored claim is still the
// confirmed one. A retry sees the latest document and must not adopt it.
// claimStartedAt is ignored. This function does not mint a generation id.
//
// An unclaimed confirmation has no server revision. A later cycle that
// returns the same Ping to available, with no claimant and no generation,
// is indistinguishable and can still be deleted. Live claims are not.
//
// S7 T2-G2 legacy cancellation (t682u). A sixth confirmation key,
// legacyClaimStartedAt { seconds, nanoseconds }, is accepted only with a
// non-null interestedUserId and claimGenerationId null. That request is
// compared against legacyCancellationIdentity of the reread spot, never
// against cancellationIdentity, and is never satisfied by a spot that stores
// any claimGenerationId. The identity is the finder (finderId == caller), the
// live status and claimState, the claimant uid, and the exact claimStartedAt.
// A lock that names the Ping with a generation or a different claimStartedAt
// is unproven. A legacy receipt is written for the delete trigger's trust
// attribution, and the claimant notice is written here, in the same
// transaction, because the delete trigger writes notices only for
// generations. Requests without the sixth key keep the existing contract.

const SPOT_ID_MAX = 200;
const TEXT_MAX = 128;
const RATE_LIMIT = Object.freeze({ limit: 10, windowSec: 600 });
const FAILURE = 'Cancellation could not be completed.';
const INVALID = 'Invalid cancellation request.';
const CONFIRMATION_KEYS = Object.freeze([
  'spotId',
  'status',
  'interestedUserId',
  'claimState',
  'claimGenerationId',
]);

function textOrNull(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}

function nullableText(value, label) {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > TEXT_MAX || value.includes('/')) {
    throw new HttpsError('invalid-argument', INVALID);
  }
  return value;
}

function parseInput(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new HttpsError('invalid-argument', INVALID);
  }
  const keys = Object.keys(data);
  const legacy = keys.includes('legacyClaimStartedAt');
  const expected = legacy ? CONFIRMATION_KEYS.length + 1 : CONFIRMATION_KEYS.length;
  if (keys.length !== expected || CONFIRMATION_KEYS.some((key) => !keys.includes(key))) {
    throw new HttpsError('invalid-argument', INVALID);
  }
  const spotId = data.spotId;
  if (typeof spotId !== 'string' || spotId.length < 1 || spotId.length > SPOT_ID_MAX) {
    throw new HttpsError('invalid-argument', INVALID);
  }
  if (spotId.includes('/') || spotId === '.' || spotId === '..') {
    throw new HttpsError('invalid-argument', INVALID);
  }
  if (typeof data.status !== 'string' || data.status.length < 1 || data.status.length > 40 || data.status.includes('/')) {
    throw new HttpsError('invalid-argument', INVALID);
  }
  const parsed = {
    spotId,
    status: data.status,
    interestedUserId: nullableText(data.interestedUserId, 'interestedUserId'),
    claimState: nullableText(data.claimState, 'claimState'),
    claimGenerationId: nullableText(data.claimGenerationId, 'claimGenerationId'),
  };
  if (!legacy) return parsed;
  const fingerprint = parseLegacyFingerprint(data.legacyClaimStartedAt);
  if (!fingerprint || parsed.interestedUserId === null || parsed.claimGenerationId !== null) {
    throw new HttpsError('invalid-argument', INVALID);
  }
  return { ...parsed, legacyClaimStartedAt: fingerprint };
}

const LEGACY_LIVE_CLAIM_STATES = new Set(['committed', 'heading']);

// Identity of a generationless legacy claim, or unproven. Never derived from a
// spot that stores any claimGenerationId value.
function legacyCancellationIdentity(spot) {
  if (!spot) return { kind: 'unproven' };
  const finderId = textOrNull(spot.finderId);
  const claimant = textOrNull(spot.interestedUserId);
  if (!finderId || !claimant || spot.status !== 'interested') return { kind: 'unproven' };
  if (!isGenerationless(spot)) {
    return isClaimGenerationId(spot.claimGenerationId) ? { kind: 'generation_present', finderId } : { kind: 'unproven' };
  }
  const claimState = spot.claimState === undefined ? null : spot.claimState;
  if (claimState !== null && !LEGACY_LIVE_CLAIM_STATES.has(claimState)) return { kind: 'unproven' };
  const fingerprint = timestampFingerprint(spot.claimStartedAt);
  if (!fingerprint || !legacyToken(claimant, fingerprint)) return { kind: 'unproven' };
  return {
    kind: 'legacy',
    finderId,
    status: 'interested',
    interestedUserId: claimant,
    claimState,
    claimStartedAt: fingerprint,
  };
}

function confirmedLegacyIdentity(input, uid) {
  if (input.status !== 'interested') return { kind: 'unproven' };
  if (input.claimState !== null && !LEGACY_LIVE_CLAIM_STATES.has(input.claimState)) return { kind: 'unproven' };
  if (!legacyToken(input.interestedUserId, input.legacyClaimStartedAt)) return { kind: 'unproven' };
  return {
    kind: 'legacy',
    finderId: uid,
    status: 'interested',
    interestedUserId: input.interestedUserId,
    claimState: input.claimState,
    claimStartedAt: input.legacyClaimStartedAt,
  };
}

function sameLegacyIdentity(current, confirmed) {
  return current.kind === 'legacy' && confirmed.kind === 'legacy'
    && current.finderId === confirmed.finderId
    && current.status === confirmed.status
    && current.claimState === confirmed.claimState
    && current.interestedUserId === confirmed.interestedUserId
    && sameFingerprint(current.claimStartedAt, confirmed.claimStartedAt);
}

function legacyLockConflicts(lockSnap, spotId, fingerprint) {
  if (!lockSnap || !lockSnap.exists) return false;
  const lock = lockSnap.data() || {};
  if (lock.spotId !== spotId) return false;
  if (lock.claimGenerationId !== undefined && lock.claimGenerationId !== null) return true;
  if (lock.claimStartedAt === undefined || lock.claimStartedAt === null) return false;
  return !sameFingerprint(timestampFingerprint(lock.claimStartedAt), fingerprint);
}

function legacyNoticeId(spotId, identity) {
  const token = legacyToken(identity.interestedUserId, identity.claimStartedAt);
  if (!token) return null;
  const id = `finder_cancelled_${spotId}_${token}`;
  return id.length <= 700 ? id : null;
}

function spotExpired(spot, nowMs) {
  const expiresAt = spot && spot.expiresAt;
  if (!expiresAt || typeof expiresAt.toMillis !== 'function') return false;
  return expiresAt.toMillis() <= nowMs;
}

function cancellationIdentity(spot) {
  if (!spot) return { kind: 'unproven' };
  const finderId = textOrNull(spot.finderId);
  const status = textOrNull(spot.status);
  if (!finderId || !status) return { kind: 'unproven' };
  const claimState = textOrNull(spot.claimState);
  const claimant = textOrNull(spot.interestedUserId);
  if (claimant) {
    if (!isClaimGenerationId(spot.claimGenerationId)) return { kind: 'unproven' };
    return {
      kind: 'generation',
      finderId,
      status,
      interestedUserId: claimant,
      claimState,
      claimGenerationId: spot.claimGenerationId,
    };
  }
  if (spot.claimGenerationId === undefined || spot.claimGenerationId === null) {
    return { kind: 'unclaimed', finderId, status, claimState };
  }
  if (
    typeof spot.claimGenerationId === 'string'
    && spot.claimGenerationId.length > 0
    && spot.claimGenerationId.length <= TEXT_MAX
    && !spot.claimGenerationId.includes('/')
  ) {
    return {
      kind: 'stored_value',
      finderId,
      status,
      claimState,
      claimGenerationId: spot.claimGenerationId,
    };
  }
  return { kind: 'unproven' };
}

function sameIdentity(current, confirmed) {
  if (current.kind === 'unproven' || confirmed.kind === 'unproven' || current.kind !== confirmed.kind) return false;
  if (current.finderId !== confirmed.finderId || current.status !== confirmed.status || current.claimState !== confirmed.claimState) {
    return false;
  }
  if (current.kind === 'generation') {
    return current.interestedUserId === confirmed.interestedUserId
      && current.claimGenerationId === confirmed.claimGenerationId;
  }
  if (current.kind === 'stored_value') return current.claimGenerationId === confirmed.claimGenerationId;
  return current.kind === 'unclaimed';
}

function errorCode(error) {
  return error && error.code;
}

function isRetryable(error) {
  const code = errorCode(error);
  return code === 4 || code === 10 || code === 14
    || code === 'deadline-exceeded' || code === 'aborted' || code === 'unavailable';
}

async function finderCancelSpot(request, deps = {}) {
  const uid = request && request.auth ? request.auth.uid : undefined;
  if (typeof uid !== 'string' || uid.length === 0) {
    throw new HttpsError('unauthenticated', 'Authentication is required.');
  }
  if ((deps.afterReads || deps.afterLifecycleRead) && deps.allowTestHooks !== true) {
    throw new HttpsError('internal', FAILURE);
  }
  const input = parseInput(request.data);
  const legacy = Object.prototype.hasOwnProperty.call(input, 'legacyClaimStartedAt');
  const confirmed = legacy ? confirmedLegacyIdentity(input, uid) : cancellationIdentity({ ...input, finderId: uid });
  if (confirmed.kind === 'unproven') return { outcome: 'unproven_identity' };
  const now = deps.now || (() => require('firebase-admin/firestore').Timestamp.now());

  const db = deps.db || require('firebase-admin/firestore').getFirestore();
  const limit = deps.checkRateLimit || checkRateLimit;
  const afterReads = deps.allowTestHooks === true && typeof deps.afterReads === 'function'
    ? deps.afterReads
    : null;
  const afterLifecycleRead = deps.allowTestHooks === true && typeof deps.afterLifecycleRead === 'function'
    ? deps.afterLifecycleRead
    : null;
  if (await deletionFencePresent(uid, db)) {
    throw new HttpsError('permission-denied', PRODUCT_ACCESS_DENIED);
  }
  await limit(uid, 'finderCancelSpot', RATE_LIMIT);

  let hookUsed = false;
  try {
    return await db.runTransaction(async (tx) => {
      const userRef = db.collection('users').doc(uid);
      const spotRef = db.collection('spots').doc(input.spotId);
      const userSnap = await tx.get(userRef);
      const spotSnap = await tx.get(spotRef);
      const identityOf = legacy ? legacyCancellationIdentity : cancellationIdentity;
      const fresh = spotSnap.exists ? identityOf(spotSnap.data()) : { kind: 'missing' };
      const lockSnap = fresh.kind === 'generation' || fresh.kind === 'legacy'
        ? await readActiveIncomingClaim(tx, db, fresh.interestedUserId)
        : null;
      const legacyNoticeRef = fresh.kind === 'legacy' && legacyNoticeId(input.spotId, fresh)
        ? db.collection('spotNotifications').doc(legacyNoticeId(input.spotId, fresh))
        : null;
      const legacyNoticeSnap = legacyNoticeRef ? await tx.get(legacyNoticeRef) : null;
      if (afterReads && !hookUsed) {
        hookUsed = true;
        await afterReads();
      }
      const lifeSnap = await tx.get(db.collection('accountLifecycle').doc(uid));
      if (afterLifecycleRead) await afterLifecycleRead(lifeSnap);
      throwIfDeleting(lifeSnap);
      if (userSnap.exists && userRecordDenies(userSnap.data())) {
        throw new HttpsError('permission-denied', PRODUCT_ACCESS_DENIED);
      }
      if (fresh.kind === 'missing') return { outcome: 'already_deleted' };
      if (legacy) {
        const owner = textOrNull(spotSnap.data() && spotSnap.data().finderId);
        if (owner !== uid) return { outcome: 'not_owner' };
        if (fresh.kind === 'generation_present') return { outcome: 'stale' };
        if (fresh.kind !== 'legacy' || !legacyNoticeRef) return { outcome: 'unproven_identity' };
        if (!sameLegacyIdentity(fresh, confirmed)) return { outcome: 'stale' };
        if (legacyLockConflicts(lockSnap, input.spotId, fresh.claimStartedAt)) return { outcome: 'unproven_identity' };
        const legacyReceiptId = receiptDocumentId(input.spotId, fresh);
        if (!legacyReceiptId) return { outcome: 'unproven_identity' };
        const nowTs = now();
        tx.set(db.collection(RECEIPT_COLLECTION).doc(legacyReceiptId), receiptBody(input.spotId, fresh));
        tx.delete(spotRef);
        if (lockSnap) deleteMatchingActiveIncomingClaim(tx, lockSnap, input.spotId);
        if (!legacyNoticeSnap.exists && fresh.interestedUserId !== uid && !spotExpired(spotSnap.data(), nowTs.toMillis())) {
          tx.set(legacyNoticeRef, {
            spotId: input.spotId,
            senderId: uid,
            targetUserId: fresh.interestedUserId,
            type: 'cancelled',
            message: NOTICE_MESSAGE,
            createdAt: nowTs,
          });
        }
        return { outcome: 'deleted' };
      }
      if (fresh.finderId !== uid) return { outcome: 'not_owner' };
      if (fresh.kind === 'unproven' || !sameIdentity(fresh, confirmed)) {
        return { outcome: fresh.kind === 'unproven' ? 'unproven_identity' : 'stale' };
      }
      const receiptId = receiptDocumentId(input.spotId, fresh);
      if (!receiptId) return { outcome: 'unproven_identity' };
      tx.set(db.collection(RECEIPT_COLLECTION).doc(receiptId), receiptBody(input.spotId, fresh));
      tx.delete(spotRef);
      if (lockSnap) deleteMatchingActiveIncomingClaim(tx, lockSnap, input.spotId);
      return { outcome: 'deleted' };
    });
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    if (errorCode(error) === 7 || errorCode(error) === 'permission-denied') {
      throw new HttpsError('permission-denied', FAILURE);
    }
    if (isRetryable(error)) throw new HttpsError('unavailable', 'Cancellation could not be completed. Try again.');
    console.error('finderCancelSpot failed:', sanitizeError(error));
    throw new HttpsError('internal', FAILURE);
  }
}

module.exports = {
  finderCancelSpot,
  cancellationIdentity,
  legacyCancellationIdentity,
  parseInput,
};
