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

/** Server-only rollout gate. Rules Arm 1 reads this and fails closed until it is clean. */
const ACTIVE_INCOMING_CLAIM_ROLLOUT_COLLECTION = 'activeIncomingClaimRollout';
const ACTIVE_INCOMING_CLAIM_ROLLOUT_DOC_ID = 'status';

/** One doc per uid when reconciliation releases extra interested Pings. Server-only. */
const ACTIVE_INCOMING_CLAIM_CONFLICT_COLLECTION = 'activeIncomingClaimConflicts';

/**
 * Earliest claimStartedAt wins. A missing timestamp sorts after every real one.
 * Equal timestamps break ties by lexicographic spot id.
 */
const CANONICAL_ACTIVE_CLAIM_RULE = 'earliest_claimStartedAt_then_spotId';

const RELEASED_INTEREST_CLEAR = Object.freeze({
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
});

function compareActiveClaims(a, b) {
  const aMs = Number.isFinite(a.claimStartedAtMs) ? a.claimStartedAtMs : Number.POSITIVE_INFINITY;
  const bMs = Number.isFinite(b.claimStartedAtMs) ? b.claimStartedAtMs : Number.POSITIVE_INFINITY;
  if (aMs !== bMs) return aMs < bMs ? -1 : 1;
  if (a.spotId < b.spotId) return -1;
  if (a.spotId > b.spotId) return 1;
  return 0;
}

function planUserReconciliation(claims) {
  const sorted = [...claims].sort(compareActiveClaims);
  return {
    keep: sorted[0] || null,
    release: sorted.slice(1),
  };
}

function auditActiveClaimGroups(groups) {
  let locklessCount = 0;
  let duplicateUserCount = 0;
  let duplicatePingCount = 0;
  let interestedWithClaimerCount = 0;
  for (const group of groups) {
    const spotIds = Array.isArray(group.spotIds) ? group.spotIds : [];
    interestedWithClaimerCount += spotIds.length;
    if (spotIds.length > 1) {
      duplicateUserCount += 1;
      duplicatePingCount += spotIds.length - 1;
    }
    for (const spotId of spotIds) {
      if (group.lockSpotId !== spotId) locklessCount += 1;
    }
  }
  return {
    locklessCount,
    duplicateUserCount,
    duplicatePingCount,
    interestedWithClaimerCount,
  };
}

/** The hard invariant may be turned on only after a complete scan shows both counts at zero. */
function invariantMayBeEnforced(audit) {
  return !!audit
    && audit.scanComplete === true
    && audit.locklessCount === 0
    && audit.duplicateUserCount === 0
    && audit.duplicatePingCount === 0;
}

/**
 * Same clear set as cleanupExpiredInterests. An already-expired Ping is not
 * reopened; a still-valid Ping goes back to available so it is not left claimed.
 */
function releasedInterestPatch(expiresAtMs, nowMs) {
  const pingExpired = Number.isFinite(expiresAtMs) && expiresAtMs <= nowMs;
  if (pingExpired) return { ...RELEASED_INTEREST_CLEAR };
  return { ...RELEASED_INTEREST_CLEAR, status: 'available' };
}

module.exports = {
  STALE_ACTIVE_CLAIM_LOCK_MS,
  ACTIVE_INCOMING_CLAIM_COLLECTION,
  ACTIVE_INCOMING_CLAIM_DOC_ID,
  ACTIVE_INCOMING_CLAIM_ROLLOUT_COLLECTION,
  ACTIVE_INCOMING_CLAIM_ROLLOUT_DOC_ID,
  ACTIVE_INCOMING_CLAIM_CONFLICT_COLLECTION,
  CANONICAL_ACTIVE_CLAIM_RULE,
  pingHoldsActiveClaim,
  shouldGarbageCollectLock,
  lockNamesSpot,
  compareActiveClaims,
  planUserReconciliation,
  auditActiveClaimGroups,
  invariantMayBeEnforced,
  releasedInterestPatch,
};
