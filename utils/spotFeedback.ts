const SAFE_FIRESTORE_ID = /^[^/]{1,500}$/;

export const HANDOFF_FAILURE_REASONS = [
  'Someone else got it',
  "Finder hadn't left yet",
  "Couldn't find the location",
  'Other',
] as const;

export type HandoffFailureReason = typeof HANDOFF_FAILURE_REASONS[number];

export function isHandoffFailureReason(value: unknown): value is HandoffFailureReason {
  return typeof value === 'string'
    && (HANDOFF_FAILURE_REASONS as readonly string[]).includes(value);
}

export function spotFeedbackDocId(spotId: string, driverId: string): string {
  if (!SAFE_FIRESTORE_ID.test(spotId) || !SAFE_FIRESTORE_ID.test(driverId)) {
    throw new Error('Invalid feedback identifier');
  }
  return `${spotId}_${driverId}`;
}

export type ParticipantRole = 'claimer' | 'finder';

const ADDRESS_MAX_LENGTH = 500;

export class ArrivalNotDurableError extends Error {
  constructor() {
    super('Handoff is not durably arrived');
    this.name = 'ArrivalNotDurableError';
  }
}

/** Occupied, arrived_pending_outcome, and a real arrivedAt timestamp. */
export function isDurableArrival(spot: {
  status?: unknown;
  claimState?: unknown;
  arrivedAt?: { toMillis?: () => number } | null;
} | null | undefined): boolean {
  if (!spot || spot.status !== 'occupied' || spot.claimState !== 'arrived_pending_outcome') return false;
  const arrivedAt = spot.arrivedAt;
  if (!arrivedAt || typeof arrivedAt.toMillis !== 'function') return false;
  try {
    const millis = arrivedAt.toMillis();
    return typeof millis === 'number' && Number.isFinite(millis);
  } catch {
    return false;
  }
}

/** Claimer doc is `{spotId}_{claimerId}`. Finder doc appends `_finder`. userId stays the claimer. */
export function participantSuccessFeedbackId(
  spotId: string,
  claimerId: string,
  role: ParticipantRole,
): string {
  const claimerDocId = spotFeedbackDocId(spotId, claimerId);
  return role === 'finder' ? `${claimerDocId}_finder` : claimerDocId;
}

export function buildParticipantSuccessAttestation(params: {
  spotId: string;
  claimerId: string;
  finderId: string;
  address: string;
  role: ParticipantRole;
  createdAt: unknown;
}) {
  return {
    spotId: params.spotId,
    userId: params.claimerId,
    finderId: params.finderId,
    outcome: 'participant_success' as const,
    role: params.role,
    failureReason: null,
    address: params.address.slice(0, ADDRESS_MAX_LENGTH),
    createdAt: params.createdAt,
  };
}

export function isMatchingParticipantAttestation(
  existing: Record<string, any> | undefined,
  intended: { spotId: string; userId: string; finderId: string; role: ParticipantRole },
): boolean {
  if (!existing) return false;
  return existing.spotId === intended.spotId
    && existing.userId === intended.userId
    && existing.finderId === intended.finderId
    && existing.outcome === 'participant_success'
    && existing.role === intended.role
    && (existing.failureReason ?? null) === null;
}
