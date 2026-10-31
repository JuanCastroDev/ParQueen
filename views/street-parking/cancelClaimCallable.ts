import { getApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { isClaimGenerationId } from './claimIdentity';

export const CANCEL_CLAIM_REASONS = [
  'found_elsewhere',
  'traffic',
  'changed_mind',
  'unspecified',
] as const;

export type CancelClaimReason = (typeof CANCEL_CLAIM_REASONS)[number];
export type CancelClaimOutcome = 'cancelled' | 'already_resolved' | 'stale_claim';

const UI_REASON_TO_ENUM: Record<string, CancelClaimReason> = {
  'Found parking elsewhere': 'found_elsewhere',
  'Traffic is too heavy': 'traffic',
  'Changed my mind': 'changed_mind',
};

export function cancelClaimReasonForUi(reason: string): CancelClaimReason {
  if (Object.prototype.hasOwnProperty.call(UI_REASON_TO_ENUM, reason)) {
    return UI_REASON_TO_ENUM[reason];
  }
  if ((CANCEL_CLAIM_REASONS as readonly string[]).includes(reason)) {
    return reason as CancelClaimReason;
  }
  return 'unspecified';
}

function cancellationRequest(input: {
  spotId: unknown;
  claimGenerationId: unknown;
  reason: unknown;
}): { spotId: string; claimGenerationId: string; reason: CancelClaimReason } {
  const { spotId, claimGenerationId } = input;
  if (
    typeof spotId !== 'string'
    || spotId.length < 1
    || spotId.length > 200
    || spotId.includes('/')
    || spotId === '.'
    || spotId === '..'
  ) {
    throw new Error('Invalid cancellation request.');
  }
  if (!isClaimGenerationId(claimGenerationId)) {
    throw new Error('Invalid cancellation request.');
  }
  return {
    spotId,
    claimGenerationId,
    reason: cancelClaimReasonForUi(typeof input.reason === 'string' ? input.reason : ''),
  };
}

function outcomeOf(response: { data?: { outcome?: unknown } } | null | undefined): CancelClaimOutcome {
  const outcome = response?.data?.outcome;
  if (outcome !== 'cancelled' && outcome !== 'already_resolved' && outcome !== 'stale_claim') {
    throw new Error('Invalid cancellation response.');
  }
  return outcome;
}

/**
 * Claimer cancellation through the us-central1 cancelClaim callable.
 * The payload is only spotId, claimGenerationId, and an allowlisted reason.
 */
export async function cancelClaimCallable(input: {
  spotId: string;
  claimGenerationId: string;
  reason: string;
}): Promise<CancelClaimOutcome> {
  const request = cancellationRequest(input);
  const functions = getFunctions(getApp(), 'us-central1');
  const callable = httpsCallable<typeof request, { outcome?: unknown }>(functions, 'cancelClaim');
  return outcomeOf(await callable(request));
}
