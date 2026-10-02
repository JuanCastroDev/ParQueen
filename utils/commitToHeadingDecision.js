'use strict';

/**
 * Shared decision for committed → heading.
 * The client transaction and the scheduler-race tests both use this so a
 * released Ping cannot be turned back into a heading claim.
 *
 * @returns {'commit' | 'already_heading' | 'rejected'}
 */
function decideCommitToHeading(spot, uid) {
  if (!spot || typeof uid !== 'string' || uid.length === 0) return 'rejected';
  const isThisClaimer = spot.status === 'interested' && spot.interestedUserId === uid;
  if (!isThisClaimer) return 'rejected';
  if (spot.claimState === 'heading') return 'already_heading';
  if (spot.claimState === 'committed') return 'commit';
  return 'rejected';
}

/**
 * Fields Arm 2b already allows the claimer to change. Does not touch
 * status, interestedUserId, claimStartedAt, or the active-claim lock.
 * interestExpiresAt is a Firestore Timestamp built by the caller.
 */
function buildHeadingUpdate(etaMinutes, interestExpiresAt) {
  return {
    claimState: 'heading',
    ownerLeavingNow: null,
    ownerLeavingNowAt: null,
    etaMinutes,
    interestExpiresAt,
    claimReminderAt: null,
    claimReminderSentAt: null,
    claimAutoReleaseAt: null,
  };
}

module.exports = {
  decideCommitToHeading,
  buildHeadingUpdate,
};
