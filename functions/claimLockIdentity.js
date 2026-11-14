'use strict';

const { isClaimGenerationId } = require('./claimGeneration');
const {
  isGenerationless,
  parseLegacyFingerprint,
  timestampFingerprint,
  sameFingerprint,
} = require('./legacyClaimIdentity');

const LOCK_MATCH = Object.freeze({
  EXACT: 'exact_match',
  MISSING: 'missing',
  UNRELATED_SPOT: 'unrelated_spot',
  SAME_SPOT_CONFLICT: 'same_spot_conflict',
  MALFORMED: 'malformed',
});

function expectedClaimFromSpot(spotId, spot) {
  if (typeof spotId !== 'string' || !spotId || !spot || typeof spot !== 'object') return null;
  if (isClaimGenerationId(spot.claimGenerationId)) {
    return { kind: 'generation', spotId, claimGenerationId: spot.claimGenerationId };
  }
  if (!isGenerationless(spot)) return null;
  const claimStartedAt = timestampFingerprint(spot.claimStartedAt);
  return claimStartedAt ? { kind: 'legacy', spotId, claimStartedAt } : null;
}

function classifyLockForExpectedClaim(lock, expectedClaim) {
  if (!lock) return LOCK_MATCH.MISSING;
  if (!expectedClaim || typeof expectedClaim !== 'object'
    || typeof expectedClaim.spotId !== 'string' || !expectedClaim.spotId) return LOCK_MATCH.MALFORMED;
  if (typeof lock.spotId !== 'string' || !lock.spotId) return LOCK_MATCH.MALFORMED;
  if (lock.spotId !== expectedClaim.spotId) return LOCK_MATCH.UNRELATED_SPOT;

  if (expectedClaim.kind === 'generation') {
    if (!isClaimGenerationId(expectedClaim.claimGenerationId)) return LOCK_MATCH.MALFORMED;
    if (lock.claimGenerationId === undefined || lock.claimGenerationId === null) {
      return lock.claimStartedAt === undefined || lock.claimStartedAt === null
        ? LOCK_MATCH.MALFORMED : LOCK_MATCH.SAME_SPOT_CONFLICT;
    }
    if (!isClaimGenerationId(lock.claimGenerationId)) return LOCK_MATCH.MALFORMED;
    return lock.claimGenerationId === expectedClaim.claimGenerationId
      ? LOCK_MATCH.EXACT : LOCK_MATCH.SAME_SPOT_CONFLICT;
  }

  if (expectedClaim.kind === 'legacy') {
    if (expectedClaim.claimGenerationId !== undefined && expectedClaim.claimGenerationId !== null) {
      return LOCK_MATCH.MALFORMED;
    }
    const expectedFingerprint = parseLegacyFingerprint(expectedClaim.claimStartedAt);
    if (!expectedFingerprint) return LOCK_MATCH.MALFORMED;
    if (lock.claimGenerationId !== undefined && lock.claimGenerationId !== null) {
      return isClaimGenerationId(lock.claimGenerationId)
        ? LOCK_MATCH.SAME_SPOT_CONFLICT : LOCK_MATCH.MALFORMED;
    }
    const lockFingerprint = timestampFingerprint(lock.claimStartedAt);
    if (!lockFingerprint) return LOCK_MATCH.MALFORMED;
    return sameFingerprint(lockFingerprint, expectedFingerprint)
      ? LOCK_MATCH.EXACT : LOCK_MATCH.SAME_SPOT_CONFLICT;
  }

  return LOCK_MATCH.MALFORMED;
}

function classifyLockSnapshot(lockSnap, expectedClaim) {
  if (!lockSnap || !lockSnap.exists) return LOCK_MATCH.MISSING;
  return classifyLockForExpectedClaim(lockSnap.data() || {}, expectedClaim);
}

function deleteExactClaimLock(tx, lockSnap, expectedClaim) {
  const result = classifyLockSnapshot(lockSnap, expectedClaim);
  if (result === LOCK_MATCH.EXACT) tx.delete(lockSnap.ref);
  return result;
}

function lockConflict(result) {
  return result === LOCK_MATCH.SAME_SPOT_CONFLICT || result === LOCK_MATCH.MALFORMED;
}

module.exports = {
  LOCK_MATCH,
  expectedClaimFromSpot,
  classifyLockForExpectedClaim,
  classifyLockSnapshot,
  deleteExactClaimLock,
  lockConflict,
};
