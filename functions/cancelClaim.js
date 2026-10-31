'use strict';

const { HttpsError } = require('firebase-functions/v2/https');
const { userRecordDenies, PRODUCT_ACCESS_DENIED } = require('./productAccess');
const { checkRateLimit } = require('./rateLimiter');
const { sanitizeError } = require('./redactForLog');
const { isClaimGenerationId } = require('./claimGeneration');

// Outcome adjustment from the 29G contract:
// stale_claim is returned only when the authenticated caller is still the
// stored claimant and the supplied claimGenerationId is not the stored id.
// A caller who is not that claimant — missing Ping, cleared claim, another
// claimant, occupied or other terminal history — receives already_resolved
// and no write. The two outcomes are not an existence or handoff probe.
//
// Fail closed. A cancellation write requires the submitted claimGenerationId
// to equal the id stored on the spot. Missing, null, malformed, and wrong
// ids do not authorize a write. A spot with no valid stored id cannot be
// cancelled by this path. Timestamps are not compared. A different user's
// replacement is already_resolved.
//
// Direct-write cancellation does not use this compare. Until Arms 1, 3, and
// 3b are removed together, a client can still release a claim without an id.

const REASONS = Object.freeze({
  found_elsewhere: 'The driver found parking elsewhere — your spot is available again.',
  traffic: 'The driver got stuck in traffic — your spot is available again.',
  changed_mind: 'The driver changed their mind — your spot is available again.',
  unspecified: 'The other driver canceled — your spot is available again.',
});

const CLEAR_FIELDS = Object.freeze({
  interestedUserId: null,
  interestedUserName: null,
  interestedUserVehicleColor: null,
  interestedUserVehicleType: null,
  interestedUserVehicleBrand: null,
  interestedUserTitle: null,
  etaMinutes: null,
  interestExpiresAt: null,
  claimState: null,
  claimStartedAt: null,
  ownerLeavingNow: null,
  ownerLeavingNowAt: null,
  claimReminderAt: null,
  claimReminderSentAt: null,
  claimAutoReleaseAt: null,
  claimAutoReleasedAt: null,
  claimGenerationId: null,
});

const LIVE_CLAIM_STATES = new Set(['committed', 'heading']);
const RATE_LIMIT = Object.freeze({ limit: 10, windowSec: 600 });
const SPOT_ID_MAX = 200;
const FAILURE = 'Cancellation could not be completed.';
const INVALID = 'Invalid cancellation request.';

function timestampMillis(value) {
  if (!value || typeof value.toMillis !== 'function') return null;
  let ms;
  try {
    ms = value.toMillis();
  } catch {
    return null;
  }
  return Number.isSafeInteger(ms) ? ms : null;
}

function parseInput(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new HttpsError('invalid-argument', INVALID);
  }
  const keys = Object.keys(data);
  if (keys.length !== 3 || keys.some((key) => key !== 'spotId' && key !== 'claimGenerationId' && key !== 'reason')) {
    throw new HttpsError('invalid-argument', INVALID);
  }
  const { spotId, claimGenerationId, reason } = data;
  if (typeof spotId !== 'string' || spotId.length < 1 || spotId.length > SPOT_ID_MAX) {
    throw new HttpsError('invalid-argument', INVALID);
  }
  if (spotId.includes('/') || spotId === '.' || spotId === '..') {
    throw new HttpsError('invalid-argument', INVALID);
  }
  if (!isClaimGenerationId(claimGenerationId)) {
    throw new HttpsError('invalid-argument', INVALID);
  }
  if (!Object.prototype.hasOwnProperty.call(REASONS, reason)) {
    throw new HttpsError('invalid-argument', INVALID);
  }
  return { spotId, claimGenerationId, reason };
}

function claimStateOf(spot) {
  if (!Object.prototype.hasOwnProperty.call(spot, 'claimState')) return null;
  return spot.claimState;
}

function isLiveClaim(spot) {
  if (!spot || spot.status !== 'interested') return false;
  const state = claimStateOf(spot);
  return state === null || LIVE_CLAIM_STATES.has(state);
}

function isExpired(spot, now) {
  const expiresAt = spot.expiresAt;
  if (expiresAt == null) return false;
  const ms = timestampMillis(expiresAt);
  if (ms == null) return true;
  return ms <= now.toMillis();
}

function notificationId(spotId, claimGenerationId) {
  return `claimer_cancelled_${spotId}_${claimGenerationId}`;
}

function classify(uid, input, spotSnap) {
  if (!spotSnap.exists) return { action: 'return', outcome: 'already_resolved' };
  const spot = spotSnap.data() || {};
  if (spot.interestedUserId !== uid) return { action: 'return', outcome: 'already_resolved' };
  if (!isLiveClaim(spot)) return { action: 'return', outcome: 'already_resolved' };
  if (!isClaimGenerationId(spot.claimGenerationId) || spot.claimGenerationId !== input.claimGenerationId) {
    return { action: 'return', outcome: 'stale_claim' };
  }
  const finderId = typeof spot.finderId === 'string' ? spot.finderId : '';
  return {
    action: 'cancel',
    outcome: 'cancelled',
    notify: finderId.length > 0 && finderId !== uid,
    finderId,
    notificationId: notificationId(input.spotId, spot.claimGenerationId),
  };
}

function errorCode(error) {
  return error && error.code;
}

function isAlreadyExists(error) {
  return errorCode(error) === 6 || errorCode(error) === 'already-exists';
}

function isRetryable(error) {
  const code = errorCode(error);
  return code === 4 || code === 10 || code === 14
    || code === 'deadline-exceeded' || code === 'aborted' || code === 'unavailable';
}

async function cancelClaim(request, deps = {}) {
  const uid = request && request.auth ? request.auth.uid : undefined;
  if (typeof uid !== 'string' || uid.length === 0) {
    throw new HttpsError('unauthenticated', 'Authentication is required.');
  }
  if (deps.afterReads && deps.allowTestHooks !== true) {
    throw new HttpsError('internal', FAILURE);
  }
  const input = parseInput(request.data);
  const db = deps.db || require('firebase-admin/firestore').getFirestore();
  const limit = deps.checkRateLimit || checkRateLimit;
  const now = deps.now || (() => require('firebase-admin/firestore').Timestamp.now());
  const afterReads = deps.allowTestHooks === true && typeof deps.afterReads === 'function'
    ? deps.afterReads
    : null;
  await limit(uid, 'cancelClaim', RATE_LIMIT);

  let hookUsed = false;
  try {
    return await db.runTransaction(async (tx) => {
      const userRef = db.collection('users').doc(uid);
      const spotRef = db.collection('spots').doc(input.spotId);
      const lockRef = userRef.collection('activeIncomingClaims').doc('current');
      const userSnap = await tx.get(userRef);
      const spotSnap = await tx.get(spotRef);
      const lockSnap = await tx.get(lockRef);
      const decision = classify(uid, input, spotSnap);
      let notifRef = null;
      let notifExists = false;
      if (decision.action === 'cancel' && decision.notify) {
        notifRef = db.collection('spotNotifications').doc(decision.notificationId);
        notifExists = (await tx.get(notifRef)).exists;
      }
      if (afterReads && !hookUsed) {
        hookUsed = true;
        await afterReads();
      }
      if (userSnap.exists && userRecordDenies(userSnap.data())) {
        throw new HttpsError('permission-denied', PRODUCT_ACCESS_DENIED);
      }
      if (decision.action === 'cancel' && notifExists) {
        throw new HttpsError('failed-precondition', FAILURE);
      }
      if (decision.action !== 'cancel') return { outcome: decision.outcome };

      const serverNow = now();
      const spot = spotSnap.data() || {};
      const patch = { ...CLEAR_FIELDS };
      if (!isExpired(spot, serverNow)) patch.status = 'available';
      tx.update(spotRef, patch);
      if (lockSnap.exists && lockSnap.data() && lockSnap.data().spotId === input.spotId) {
        tx.delete(lockRef);
      }
      if (notifRef) {
        tx.create(notifRef, {
          spotId: input.spotId,
          senderId: uid,
          targetUserId: decision.finderId,
          type: 'claimer_cancelled',
          message: REASONS[input.reason],
          createdAt: serverNow,
        });
      }
      return { outcome: 'cancelled' };
    });
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    if (isAlreadyExists(error)) throw new HttpsError('failed-precondition', FAILURE);
    if (errorCode(error) === 7 || errorCode(error) === 'permission-denied') {
      throw new HttpsError('permission-denied', FAILURE);
    }
    if (isRetryable(error)) throw new HttpsError('unavailable', 'Cancellation could not be completed. Try again.');
    console.error('cancelClaim failed:', sanitizeError(error));
    throw new HttpsError('internal', FAILURE);
  }
}

module.exports = {
  cancelClaim,
  CLEAR_FIELDS,
  REASONS,
};
