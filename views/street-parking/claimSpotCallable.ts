import { getApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { CLAIM_ATTEMPT_ID_RE, isClaimGenerationId } from './claimIdentity';

export const CLAIM_SPOT_OUTCOMES = [
  'claimed',
  'already_held',
  'unavailable',
  'already_claimed',
  'refused_stale_generation',
  'expired',
  'revoked',
  'released',
  'stale_precondition',
] as const;

export const PREPARE_STATES = [
  'prepared',
  ...CLAIM_SPOT_OUTCOMES,
] as const;

export const REVOKE_OUTCOMES = [
  'revoked',
  'released',
  'generation_unchanged',
  'already_resolved',
  'expired',
  'unavailable',
  'already_held',
  'already_claimed',
  'refused_stale_generation',
  'stale_precondition',
  'permission_denied',
] as const;

export type ClaimSpotMode = 'immediate' | 'scheduled';
export type ClaimSpotOutcome = (typeof CLAIM_SPOT_OUTCOMES)[number];
export type PrepareState = (typeof PREPARE_STATES)[number];
export type RevokeOutcome = (typeof REVOKE_OUTCOMES)[number];

export interface PrepareClaimIntentResult {
  state: PrepareState;
  attemptId: string;
  spotId: string;
  mode: ClaimSpotMode;
  expiresAt: number | null;
}

export interface RevokeClaimIntentResult {
  outcome: RevokeOutcome;
  attemptId: string;
  spotId: string;
  mode: ClaimSpotMode;
}

export interface ClaimSpotResult {
  outcome: ClaimSpotOutcome;
  claimGenerationId: string | null;
  spotId: string;
  mode: ClaimSpotMode;
}

const MAX_ETA_MINUTES = 7;

function claimRequest(input: {
  spotId: unknown;
  attemptId: unknown;
  mode: unknown;
  etaMinutes?: unknown;
}): { spotId: string; attemptId: string; mode: ClaimSpotMode; etaMinutes?: number } {
  const { spotId, attemptId, mode } = input;
  if (
    typeof spotId !== 'string'
    || spotId.length < 1
    || spotId.length > 200
    || spotId.includes('/')
    || spotId === '.'
    || spotId === '..'
  ) {
    throw new Error('Invalid claim request.');
  }
  if (typeof attemptId !== 'string' || !CLAIM_ATTEMPT_ID_RE.test(attemptId)) {
    throw new Error('Invalid claim request.');
  }
  if (mode !== 'immediate' && mode !== 'scheduled') {
    throw new Error('Invalid claim request.');
  }
  if (mode === 'scheduled') {
    return { spotId, attemptId, mode };
  }
  const etaMinutes = input.etaMinutes;
  if (!Number.isInteger(etaMinutes) || (etaMinutes as number) < 1 || (etaMinutes as number) > MAX_ETA_MINUTES) {
    throw new Error('Invalid claim request.');
  }
  return { spotId, attemptId, mode, etaMinutes: etaMinutes as number };
}

function resultOf(
  response: { data?: { outcome?: unknown; claimGenerationId?: unknown; spotId?: unknown; mode?: unknown } } | null | undefined,
  request: { spotId: string; mode: ClaimSpotMode },
): ClaimSpotResult {
  const data = response?.data;
  const outcome = data?.outcome;
  if (!CLAIM_SPOT_OUTCOMES.includes(outcome as ClaimSpotOutcome)) {
    throw new Error('Invalid claim response.');
  }
  if (data?.spotId !== request.spotId || data?.mode !== request.mode) {
    throw new Error('Invalid claim response.');
  }
  const claimGenerationId = data?.claimGenerationId ?? null;
  if (claimGenerationId !== null && !isClaimGenerationId(claimGenerationId)) {
    throw new Error('Invalid claim response.');
  }
  if (outcome === 'claimed' && !isClaimGenerationId(claimGenerationId)) {
    throw new Error('Invalid claim response.');
  }
  if (outcome === 'already_held' && claimGenerationId !== null) {
    throw new Error('Invalid claim response.');
  }
  if (outcome !== 'claimed' && outcome !== 'already_held' && claimGenerationId !== null) {
    throw new Error('Invalid claim response.');
  }
  return {
    outcome: outcome as ClaimSpotOutcome,
    claimGenerationId,
    spotId: request.spotId,
    mode: request.mode,
  };
}

/**
 * Acquisition through the us-central1 claimSpot callable.
 * The payload is the spot, the attempt id, the mode, and an immediate ETA.
 * claimGenerationId is never sent.
 */
export async function claimSpotCallable(input: {
  spotId: string;
  attemptId: string;
  mode: ClaimSpotMode;
  etaMinutes?: number;
}): Promise<ClaimSpotResult> {
  const request = claimRequest(input);
  const functions = getFunctions(getApp(), 'us-central1');
  const callable = httpsCallable<typeof request, ClaimSpotResult>(functions, 'claimSpot');
  return resultOf(await callable(request), request);
}

function intentIdentity(data: {
  attemptId?: unknown;
  spotId?: unknown;
  mode?: unknown;
  claimGenerationId?: unknown;
} | null | undefined, request: { spotId: string; attemptId: string; mode: ClaimSpotMode }) {
  if (!data || data.claimGenerationId != null) throw new Error('Invalid claim response.');
  if (data.attemptId !== request.attemptId || data.spotId !== request.spotId || data.mode !== request.mode) {
    throw new Error('Invalid claim response.');
  }
}

export async function prepareClaimIntentCallable(input: {
  spotId: string;
  attemptId: string;
  mode: ClaimSpotMode;
  etaMinutes?: number;
}): Promise<PrepareClaimIntentResult> {
  const request = claimRequest(input);
  const functions = getFunctions(getApp(), 'us-central1');
  const callable = httpsCallable<typeof request, PrepareClaimIntentResult>(functions, 'prepareClaimIntent');
  const data = (await callable(request))?.data;
  intentIdentity(data, request);
  if (!PREPARE_STATES.includes(data?.state as PrepareState)) throw new Error('Invalid claim response.');
  const expiresAt = data?.expiresAt;
  return {
    state: data.state,
    attemptId: request.attemptId,
    spotId: request.spotId,
    mode: request.mode,
    expiresAt: typeof expiresAt === 'number' ? expiresAt : null,
  };
}

export async function revokeClaimIntentCallable(input: {
  spotId: string;
  attemptId: string;
  mode: ClaimSpotMode;
  etaMinutes?: number;
}): Promise<RevokeClaimIntentResult> {
  const request = claimRequest(input);
  const functions = getFunctions(getApp(), 'us-central1');
  const callable = httpsCallable<typeof request, RevokeClaimIntentResult>(functions, 'revokeClaimIntent');
  const data = (await callable(request))?.data;
  intentIdentity(data, request);
  if (!REVOKE_OUTCOMES.includes(data?.outcome as RevokeOutcome)) throw new Error('Invalid claim response.');
  return {
    outcome: data.outcome,
    attemptId: request.attemptId,
    spotId: request.spotId,
    mode: request.mode,
  };
}
