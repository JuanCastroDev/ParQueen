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

const RELEASE_PAGE_SIZE = 200;
const RELEASE_CONCURRENCY = 10;
const MAX_RELEASE_PAGES = 1000;
const EXPIRY_REPAIR_REASON = 'deleted_claimer_malformed_expiry';

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
    const plan = planDeletedClaimerPatch(spotSnap.data(), claimerUid, nowFn());
    if (plan.action === 'skip') return 'skip';
    tx.update(spotRef, plan.patch);
    // Deleted only when it names this Ping; another Ping's lock is kept.
    deleteMatchingActiveIncomingClaim(tx, lockSnap, spotRef.id);
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
