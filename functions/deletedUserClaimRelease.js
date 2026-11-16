'use strict';

// deleteAccount step 'spotsAsClaimer': remove a deleted user's claimer
// identity from every Ping that still names them.
//
// The page query is only a candidate list. Each candidate is re-read inside
// its own transaction and is changed only if it still names the deleting
// uid. Between the query and the write the claim can be released (sweeper,
// finder) and a different user can legitimately claim the Ping. Such a
// replacement claim, its claimGenerationId and that user's lock are never
// touched. The previous implementation committed the stale page as one
// unconditional batch and wiped the replacement claim.
//
// Lock handling goes through the shared helpers in ./activeIncomingClaim
// (read before any write, delete only when the lock names this Ping), the
// same pattern finderCancelSpot and the index.js sweepers use. This module
// never creates or updates a lock.
//
// Approved policy N (t699u): an active claim on a Ping whose expiresAt is
// missing or not a Firestore Timestamp is released without reopening, and
// expiresAt is set to the commit's server time with expiryRepairedAt and
// expiryRepairReason, so the existing hourly expiry cleanup removes it and
// the delete trigger's natural-expiry exemption applies.

const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const { readActiveIncomingClaim, deleteMatchingActiveIncomingClaim } = require('./activeIncomingClaim');
const {
  LOCK_MATCH,
  expectedClaimFromSpot,
  classifyLockSnapshot,
  lockConflict,
} = require('./claimLockIdentity');
const { isClaimGenerationId } = require('./claimGeneration');
const { timestampFingerprint } = require('./legacyClaimIdentity');

const RELEASE_PAGE_SIZE = 200;
const RELEASE_CONCURRENCY = 10;
const MAX_RELEASE_PAGES = 1000;
const EXPIRY_REPAIR_REASON = 'deleted_claimer_malformed_expiry';
const DELETION_JOB_LEASE_MS = 10 * 60 * 1000;
const H1_ACTIVE_STATES = new Set([undefined, null, 'heading', 'committed', 'en_route']);

const ACTIVE_CLAIM_CLEAR = Object.freeze({
  claimState: null,
  claimStartedAt: null,
  etaMinutes: null,
  interestExpiresAt: null,
  ownerLeavingNow: null,
  ownerLeavingNowAt: null,
  claimReminderAt: null,
  claimReminderSentAt: null,
  claimAutoReleaseAt: null,
  claimAutoReleasedAt: null,
  claimGenerationId: null,
});

function identityScrub() {
  return {
    interestedUserId: FieldValue.delete(),
    interestedUserName: FieldValue.delete(),
    interestedUserVehicleColor: FieldValue.delete(),
    interestedUserVehicleType: FieldValue.delete(),
    interestedUserVehicleBrand: FieldValue.delete(),
    interestedUserTitle: FieldValue.delete(),
    claimGenerationId: FieldValue.delete(),
  };
}

function validExpiry(value) {
  return value instanceof Timestamp && Number.isFinite(value.toMillis());
}

// Policy N: one server time for both fields, written in the same commit.
function expiryRepair() {
  const at = FieldValue.serverTimestamp();
  return { expiresAt: at, expiryRepairedAt: at, expiryRepairReason: EXPIRY_REPAIR_REASON };
}

function validUid(uid) {
  return typeof uid === 'string' && uid.length > 0 && !uid.includes('/');
}

function reportLockClassification(level, classification, claimKind) {
  const event = level === 'error'
    ? 'activeClaimLockRepairRequired'
    : 'activeClaimLockReconciliationNeeded';
  console[level](event, {
    operation: 'deleted_user_claim_release',
    classification,
    claimKind: claimKind || 'unprovable',
  });
}

function lockIdentityError(classification) {
  const error = new Error(`spotsAsClaimer: claim-lock ${classification}`);
  error.code = 'claim-lock-conflict';
  return error;
}

function historicalIdentityAbsent(spot) {
  if (!spot || (spot.claimGenerationId !== undefined && spot.claimGenerationId !== null)) return false;
  return spot.claimStartedAt === undefined || spot.claimStartedAt === null;
}

function h1StateEligible(spot) {
  if (!spot || typeof spot !== 'object') return false;
  if (spot.status === 'interested' && H1_ACTIVE_STATES.has(spot.claimState)) return true;
  if (spot.status === 'interested' && spot.claimState === 'arrived_pending_outcome') return true;
  if (spot.status === 'occupied'
    && ['arrived_pending_outcome', 'unconfirmed', 'completed_success'].includes(spot.claimState)) return true;
  if (spot.status === 'completed' && spot.claimState === 'completed') return true;
  return spot.status === 'expired'
    && (spot.claimState === undefined || spot.claimState === null);
}

function classifyHistoricalLock(lockSnap, spotId) {
  if (!lockSnap || !lockSnap.exists) return LOCK_MATCH.MISSING;
  const lock = lockSnap.data() || {};
  if (typeof lock.spotId !== 'string' || !lock.spotId) return LOCK_MATCH.MALFORMED;
  if (lock.spotId === spotId) return LOCK_MATCH.SAME_SPOT_CONFLICT;
  if (isClaimGenerationId(lock.claimGenerationId)) return LOCK_MATCH.UNRELATED_SPOT;
  if (lock.claimGenerationId !== undefined && lock.claimGenerationId !== null) {
    return LOCK_MATCH.MALFORMED;
  }
  return timestampFingerprint(lock.claimStartedAt)
    ? LOCK_MATCH.UNRELATED_SPOT
    : LOCK_MATCH.MALFORMED;
}

function validDeletionContext(lifecycleSnap, jobSnap, nowMs) {
  if (!lifecycleSnap || !lifecycleSnap.exists || !jobSnap || !jobSnap.exists) return false;
  const lifecycle = lifecycleSnap.data() || {};
  const job = jobSnap.data() || {};
  const leaseMs = job.leaseAt && typeof job.leaseAt.toMillis === 'function'
    ? job.leaseAt.toMillis()
    : Number.NaN;
  return lifecycle.decision === 'delete'
    && lifecycle.source === 'deleteAccount'
    && lifecycle.fenceGeneration === 1
    && lifecycle.fencedAt
    && typeof lifecycle.fencedAt.toMillis === 'function'
    && job.state === 'running'
    && job.currentStep === 'spotsAsClaimer'
    && !!job.steps
    && job.steps.userDoc === 'done'
    && Number.isFinite(nowMs)
    && Number.isFinite(leaseMs)
    && nowMs - leaseMs >= 0
    && nowMs - leaseMs < DELETION_JOB_LEASE_MS;
}

/**
 * Pure decision for one freshly read Ping.
 * - skip: the Ping no longer names the deleting user (released, replaced,
 *   or malformed claimer). Nothing is written.
 * - scrub: terminal or handoff history (anything but an active claim).
 *   Identity is removed; status and claimState are kept.
 * - reopen: active claim on a Ping whose expiresAt is a valid future time.
 * - release: active claim on an expired Ping, or one whose expiry cannot be
 *   read. The claim is cleared but the Ping is never reopened. When expiresAt
 *   is missing or not a Timestamp, repair is true and the patch also sets
 *   expiresAt to server time with the policy N audit markers.
 */
function planDeletedClaimerPatch(spot, claimerUid, nowMs) {
  if (!spot || typeof spot !== 'object' || spot.interestedUserId !== claimerUid) {
    return { action: 'skip', patch: null };
  }
  const identity = identityScrub();
  const active = spot.status === 'interested' && spot.claimState !== 'arrived_pending_outcome';
  if (!active) return { action: 'scrub', patch: identity };
  const expiresAt = spot.expiresAt;
  if (!validExpiry(expiresAt)) {
    return { action: 'release', repair: true, patch: { ...identity, ...ACTIVE_CLAIM_CLEAR, ...expiryRepair() } };
  }
  if (Number.isFinite(nowMs) && expiresAt.toMillis() > nowMs) {
    return { action: 'reopen', patch: { ...identity, ...ACTIVE_CLAIM_CLEAR, status: 'available' } };
  }
  return { action: 'release', patch: { ...identity, ...ACTIVE_CLAIM_CLEAR } };
}

async function releaseOneDeletedClaim(db, spotRef, claimerUid, nowFn) {
  return db.runTransaction(async (tx) => {
    // Both reads before any write. Only the deleting user's own lock is read.
    const spotSnap = await tx.get(spotRef);
    const lockSnap = await readActiveIncomingClaim(tx, db, claimerUid);
    if (!spotSnap.exists) return 'gone';
    const spot = spotSnap.data();
    const plan = planDeletedClaimerPatch(spot, claimerUid, nowFn());
    if (plan.action === 'skip') return 'skip';
    const expectedClaim = expectedClaimFromSpot(spotRef.id, spot);
    if (!expectedClaim) {
      if (!historicalIdentityAbsent(spot) || !h1StateEligible(spot)) {
        reportLockClassification('error', LOCK_MATCH.MALFORMED, null);
        throw lockIdentityError(LOCK_MATCH.MALFORMED);
      }
      const lifecycleSnap = await tx.get(db.doc(`accountLifecycle/${claimerUid}`));
      const jobSnap = await tx.get(db.doc(`accountDeletionJobs/${claimerUid}`));
      if (!validDeletionContext(lifecycleSnap, jobSnap, nowFn())) {
        reportLockClassification('error', LOCK_MATCH.MALFORMED, 'historical_absent');
        throw lockIdentityError('deletion_context_unverified');
      }
      const historicalLock = classifyHistoricalLock(lockSnap, spotRef.id);
      if (historicalLock !== LOCK_MATCH.MISSING
        && historicalLock !== LOCK_MATCH.UNRELATED_SPOT) {
        reportLockClassification('error', historicalLock, 'historical_absent');
        throw lockIdentityError(historicalLock);
      }
      reportLockClassification('warn', historicalLock, 'historical_absent');
      tx.update(spotRef, plan.patch);
      return plan.action;
    }
    const lockClassification = classifyLockSnapshot(lockSnap, expectedClaim);
    if (lockConflict(lockClassification)) {
      reportLockClassification('error', lockClassification, expectedClaim.kind);
      throw lockIdentityError(lockClassification);
    }
    if (lockClassification === LOCK_MATCH.MISSING
      || lockClassification === LOCK_MATCH.UNRELATED_SPOT) {
      reportLockClassification('warn', lockClassification, expectedClaim.kind);
    }
    tx.update(spotRef, plan.patch);
    if (lockClassification === LOCK_MATCH.EXACT) {
      deleteMatchingActiveIncomingClaim(tx, lockSnap, expectedClaim);
    }
    return plan.action;
  });
}

/**
 * Drains every Ping whose interestedUserId is claimerUid. Changed Pings drop
 * out of the query, so no cursor is needed. Every candidate in a page is
 * attempted; if any fails, the call throws after the page so deleteAccount
 * marks the step failed and Auth is not deleted. A retry is idempotent.
 */
async function releaseClaimsOfDeletedUser(db, claimerUid, options = {}) {
  if (!validUid(claimerUid)) throw new Error('spotsAsClaimer: invalid claimer id');
  const pageSize = options.pageSize || RELEASE_PAGE_SIZE;
  const concurrency = options.concurrency || RELEASE_CONCURRENCY;
  const maxPages = options.maxPages || MAX_RELEASE_PAGES;
  const nowFn = options.nowMs || (() => Date.now());
  const counts = { reopen: 0, release: 0, scrub: 0, skip: 0, gone: 0 };
  for (let page = 0; page < maxPages; page++) {
    const snap = await db.collection('spots').where('interestedUserId', '==', claimerUid).limit(pageSize).get();
    if (snap.empty) return counts;
    let failed = 0;
    for (let i = 0; i < snap.docs.length; i += concurrency) {
      const slice = snap.docs.slice(i, i + concurrency);
      const settled = await Promise.allSettled(
        slice.map((d) => releaseOneDeletedClaim(db, d.ref, claimerUid, nowFn)),
      );
      for (const outcome of settled) {
        if (outcome.status === 'fulfilled') {
          counts[outcome.value] += 1;
        } else {
          failed += 1;
        }
      }
    }
    if (failed > 0) {
      throw new Error(`spotsAsClaimer: ${failed} of ${snap.size} claim releases failed; retry`);
    }
  }
  throw new Error('spotsAsClaimer: release did not converge');
}

module.exports = {
  releaseClaimsOfDeletedUser,
  planDeletedClaimerPatch,
  EXPIRY_REPAIR_REASON,
  RELEASE_PAGE_SIZE,
  MAX_RELEASE_PAGES,
};
