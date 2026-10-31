import { getApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { doc } from 'firebase/firestore';
import { isClaimGenerationId } from './claimIdentity';

type FirestoreDb = Parameters<typeof doc>[0];

export type FinderCancelOutcome =
  | 'deleted'
  | 'already_deleted'
  | 'stale'
  | 'unproven_identity'
  | 'not_owner';

type GenerationIdentity = {
  kind: 'generation';
  finderId: string;
  status: string;
  interestedUserId: string;
  claimState: string | null;
  claimGenerationId: string;
};

type UnclaimedIdentity = {
  kind: 'unclaimed';
  finderId: string;
  status: string;
  claimState: string | null;
};

type StoredValueIdentity = {
  kind: 'stored_value';
  finderId: string;
  status: string;
  claimState: string | null;
  claimGenerationId: string;
};

export type CancellationIdentity = GenerationIdentity | UnclaimedIdentity | StoredValueIdentity | { kind: 'unproven' };

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}

// The confirmed view is sent to finderCancelSpot. The callable rereads the
// spot. A client snapshot time is not a generation.
export function cancellationIdentity(spot: Record<string, unknown> | undefined): CancellationIdentity {
  if (!spot) return { kind: 'unproven' };
  const finderId = textOrNull(spot.finderId);
  const status = textOrNull(spot.status);
  if (!finderId || !status) return { kind: 'unproven' };
  const claimState = textOrNull(spot.claimState);
  const claimant = textOrNull(spot.interestedUserId);
  if (claimant) {
    if (!isClaimGenerationId(spot.claimGenerationId)) return { kind: 'unproven' };
    return {
      kind: 'generation',
      finderId,
      status,
      interestedUserId: claimant,
      claimState,
      claimGenerationId: spot.claimGenerationId,
    };
  }
  if (spot.claimGenerationId === undefined || spot.claimGenerationId === null) {
    return { kind: 'unclaimed', finderId, status, claimState };
  }
  if (
    typeof spot.claimGenerationId === 'string'
    && spot.claimGenerationId.length > 0
    && spot.claimGenerationId.length <= 128
    && !spot.claimGenerationId.includes('/')
  ) {
    return {
      kind: 'stored_value',
      finderId,
      status,
      claimState,
      claimGenerationId: spot.claimGenerationId,
    };
  }
  return { kind: 'unproven' };
}

const OUTCOMES: readonly FinderCancelOutcome[] = [
  'deleted',
  'already_deleted',
  'stale',
  'unproven_identity',
  'not_owner',
];

function requestFor(spotId: string, confirmed: Exclude<CancellationIdentity, { kind: 'unproven' }>) {
  return {
    spotId,
    status: confirmed.status,
    interestedUserId: confirmed.kind === 'generation' ? confirmed.interestedUserId : null,
    claimState: confirmed.claimState,
    claimGenerationId: confirmed.kind === 'unclaimed' ? null : confirmed.claimGenerationId,
  };
}

export async function finderCancelSpot(input: {
  db: FirestoreDb;
  spotId: string;
  finderId: string;
  confirmedSpot: Record<string, unknown>;
}): Promise<FinderCancelOutcome> {
  const confirmed = cancellationIdentity({ ...input.confirmedSpot, finderId: input.finderId });
  if (confirmed.kind === 'unproven') return 'unproven_identity';
  if (confirmed.finderId !== input.finderId) return 'not_owner';
  const functions = getFunctions(getApp(), 'us-central1');
  const callable = httpsCallable<ReturnType<typeof requestFor>, { outcome?: unknown }>(functions, 'finderCancelSpot');
  const response = await callable(requestFor(input.spotId, confirmed));
  const outcome = response.data?.outcome;
  if (!OUTCOMES.includes(outcome as FinderCancelOutcome)) {
    throw new Error('Invalid cancellation response.');
  }
  return outcome as FinderCancelOutcome;
}
