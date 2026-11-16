import { getApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { isClaimGenerationId, parseLegacyClaimStartedAt, type LegacyClaimStartedAt } from './claimIdentity';

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

type LegacyCancellation = { spotId: string; legacyClaimStartedAt: LegacyClaimStartedAt; reason: CancelClaimReason };

function validSpotId(spotId: unknown): spotId is string {
  return typeof spotId === 'string'
    && spotId.length >= 1
    && spotId.length <= 200
    && !spotId.includes('/')
    && spotId !== '.'
    && spotId !== '..';
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

// S7 T2-G1 legacy shape: exactly { spotId, legacyClaimStartedAt, reason }.
// It never carries a claimGenerationId and is never a fallback for one.
function legacyCancellationRequest(input: {
  spotId: unknown;
  legacyClaimStartedAt: unknown;
  reason: unknown;
}): LegacyCancellation {
  const { spotId } = input;
  if (!validSpotId(spotId)) {
    throw new Error('Invalid cancellation request.');
  }
  const fingerprint = parseLegacyClaimStartedAt(input.legacyClaimStartedAt);
  if (!fingerprint) {
    throw new Error('Invalid cancellation request.');
  }
  return {
    spotId,
    legacyClaimStartedAt: fingerprint,
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

/**
 * Release of a generationless legacy claim through the same cancelClaim
 * callable. The payload is only spotId, the exact stored claimStartedAt as
 * { seconds, nanoseconds }, and an allowlisted reason. The server rereads the
 * claim and releases it only for the caller with that exact value.
 */
export async function cancelLegacyClaimCallable(input: {
  spotId: string;
  legacyClaimStartedAt: LegacyClaimStartedAt;
  reason: string;
}): Promise<CancelClaimOutcome> {
  const request = legacyCancellationRequest(input);
  const functions = getFunctions(getApp(), 'us-central1');
  const callable = httpsCallable<typeof request, { outcome?: unknown }>(functions, 'cancelClaim');
  return outcomeOf(await callable(request));
}
