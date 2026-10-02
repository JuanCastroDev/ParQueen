export type CommitToHeadingDecision = 'commit' | 'already_heading' | 'rejected';

export function decideCommitToHeading(
  spot: {
    status?: string;
    interestedUserId?: string | null;
    claimState?: string | null;
  } | null | undefined,
  uid: string,
): CommitToHeadingDecision;

export function buildHeadingUpdate(
  etaMinutes: number,
  interestExpiresAt: unknown,
): {
  claimState: 'heading';
  ownerLeavingNow: null;
  ownerLeavingNowAt: null;
  etaMinutes: number;
  interestExpiresAt: unknown;
  claimReminderAt: null;
  claimReminderSentAt: null;
  claimAutoReleaseAt: null;
};
