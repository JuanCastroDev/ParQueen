'use strict';

/** Approved stale-lock repair TTL (Batch A §8). Sweeper GC only — not a claim duration. */
const STALE_ACTIVE_CLAIM_LOCK_MS = 15 * 60 * 1000;

const ACTIVE_INCOMING_CLAIM_COLLECTION = 'activeIncomingClaims';
const ACTIVE_INCOMING_CLAIM_DOC_ID = 'current';

/**
 * Active incoming claim: status is interested AND this user is the claimer.
 * Occupied, available, missing, and terminal Pings are not active.
 */
function pingHoldsActiveClaim(spot, uid) {
  return !!spot
    && typeof uid === 'string'
    && uid.length > 0
    && spot.status === 'interested'
    && spot.interestedUserId === uid;
}

/**
 * Delete a lock only after the approved TTL and only when its Ping no longer
 * shows this user as the active claimer. A matching claim is kept even if the
 * lock is older than the TTL (scheduled claims can outlive 15 minutes).
 * Equality at the TTL boundary is stale: "after 15 minutes" includes the instant
 * the window elapses.
 */
function shouldGarbageCollectLock(lockUpdatedAtMs, nowMs, spot, uid, ttlMs = STALE_ACTIVE_CLAIM_LOCK_MS) {
  if (!Number.isFinite(lockUpdatedAtMs) || !Number.isFinite(nowMs)) return false;
  if (nowMs - lockUpdatedAtMs < ttlMs) return false;
  return !pingHoldsActiveClaim(spot, uid);
}

function lockNamesSpot(lock, spotId) {
  return !!lock && typeof spotId === 'string' && lock.spotId === spotId;
}

module.exports = {
  STALE_ACTIVE_CLAIM_LOCK_MS,
  ACTIVE_INCOMING_CLAIM_COLLECTION,
  ACTIVE_INCOMING_CLAIM_DOC_ID,
  pingHoldsActiveClaim,
  shouldGarbageCollectLock,
  lockNamesSpot,
};
