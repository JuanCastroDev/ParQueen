'use strict';

const { HttpsError } = require('firebase-functions/v2/https');
const { userRecordDenies, PRODUCT_ACCESS_DENIED } = require('./productAccess');
const { checkRateLimit } = require('./rateLimiter');
const { sanitizeError } = require('./redactForLog');
const { isClaimGenerationId } = require('./claimGeneration');
const { readActiveIncomingClaim, deleteMatchingActiveIncomingClaim } = require('./activeIncomingClaim');
const { RECEIPT_COLLECTION, receiptDocumentId, receiptBody } = require('./finderCancelReceipt');

// Finder cancellation Policy B. The request names the claim the finder
// confirmed. It is not authority for the current document. The transaction
// rereads the spot and deletes only when that stored claim is still the
// confirmed one. A retry sees the latest document and must not adopt it.
// claimStartedAt is ignored. This function does not mint a generation id.
//
// An unclaimed confirmation has no server revision. A later cycle that
// returns the same Ping to available, with no claimant and no generation,
// is indistinguishable and can still be deleted. Live claims are not.

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
  if (keys.length !== CONFIRMATION_KEYS.length || CONFIRMATION_KEYS.some((key) => !keys.includes(key))) {
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
  return {
    spotId,
    status: data.status,
    interestedUserId: nullableText(data.interestedUserId, 'interestedUserId'),
    claimState: nullableText(data.claimState, 'claimState'),
    claimGenerationId: nullableText(data.claimGenerationId, 'claimGenerationId'),
  };
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
  if (deps.afterReads && deps.allowTestHooks !== true) {
    throw new HttpsError('internal', FAILURE);
  }
  const input = parseInput(request.data);
  const confirmed = cancellationIdentity({ ...input, finderId: uid });
  if (confirmed.kind === 'unproven') return { outcome: 'unproven_identity' };

  const db = deps.db || require('firebase-admin/firestore').getFirestore();
  const limit = deps.checkRateLimit || checkRateLimit;
  const afterReads = deps.allowTestHooks === true && typeof deps.afterReads === 'function'
    ? deps.afterReads
    : null;
  await limit(uid, 'finderCancelSpot', RATE_LIMIT);

  let hookUsed = false;
  try {
    return await db.runTransaction(async (tx) => {
      const userRef = db.collection('users').doc(uid);
      const spotRef = db.collection('spots').doc(input.spotId);
      const userSnap = await tx.get(userRef);
      const spotSnap = await tx.get(spotRef);
      const fresh = spotSnap.exists ? cancellationIdentity(spotSnap.data()) : { kind: 'missing' };
      const lockSnap = fresh.kind === 'generation'
        ? await readActiveIncomingClaim(tx, db, fresh.interestedUserId)
        : null;
      if (afterReads && !hookUsed) {
        hookUsed = true;
        await afterReads();
      }
      if (userSnap.exists && userRecordDenies(userSnap.data())) {
        throw new HttpsError('permission-denied', PRODUCT_ACCESS_DENIED);
      }
      if (fresh.kind === 'missing') return { outcome: 'already_deleted' };
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
  parseInput,
};
