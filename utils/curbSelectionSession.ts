import type { CanonicalCurbResponse } from './canonicalCurbClient';
import {
  CURB_SIDE_CONFIRMATION_LOCAL_MAX_AGE_MS,
  sideConfirmationChallengeFresh,
  withoutCurbAuthority,
  type SavedSpot,
} from './savedSpot';

export type CurbSelectionMode = 'side' | 'ambiguous';
export type CurbSelectionResult = 'ignored' | 'expired' | 'committed' | 'dropped';

const SOURCE_UNAVAILABLE: CanonicalCurbResponse = {
  protocolVersion: 2,
  status: 'unsupported',
  reason: 'source_unavailable',
};

export function savedSpotFieldsFromCanonicalResponse(
  response: CanonicalCurbResponse,
  checkedAt: string = new Date().toISOString(),
): Pick<SavedSpot,
  'segmentId' | 'parkingSide' | 'restrictionVersionId' | 'segmentStreetName'
  | 'streetIntelStatus' | 'streetIntelReason' | 'streetIntelCheckedAt'
  | 'curbProtocolVersion' | 'curbResolutionStatus' | 'curbSelector' | 'curbSideConfirmation'
  | 'sideConfidence' | 'confirmedParkingSide' | 'drivingSide'
  | 'publicRules' | 'publicSchedules' | 'regulationStatus'
> {
  if (response.status === 'high_confidence') {
    return {
      segmentId: response.segmentId,
      parkingSide: response.sideLabel,
      restrictionVersionId: null,
      segmentStreetName: response.streetName,
      streetIntelStatus: 'found',
      streetIntelReason: null,
      streetIntelCheckedAt: checkedAt,
      curbProtocolVersion: 2,
      curbResolutionStatus: 'high_confidence',
      curbSelector: null,
      curbSideConfirmation: null,
      sideConfidence: 'high',
      confirmedParkingSide: null,
      drivingSide: null,
      publicRules: response.publicRules ? [...response.publicRules] : null,
      publicSchedules: response.publicSchedules ? { ...response.publicSchedules } : null,
      regulationStatus: response.regulationStatus ?? null,
    };
  }
  if (response.status === 'ambiguous') {
    return {
      segmentId: null,
      parkingSide: null,
      restrictionVersionId: null,
      segmentStreetName: null,
      streetIntelStatus: null,
      streetIntelReason: 'intersection_complex',
      streetIntelCheckedAt: checkedAt,
      curbProtocolVersion: 2,
      curbResolutionStatus: 'ambiguous',
      curbSelector: response.selector,
      curbSideConfirmation: null,
      sideConfidence: 'unknown',
      confirmedParkingSide: null,
      drivingSide: null,
      publicRules: null,
      publicSchedules: null,
      regulationStatus: null,
    };
  }
  if (response.status === 'side_confirmation_required') {
    return {
      segmentId: null,
      parkingSide: null,
      restrictionVersionId: null,
      segmentStreetName: null,
      streetIntelStatus: null,
      streetIntelReason: null,
      streetIntelCheckedAt: checkedAt,
      curbProtocolVersion: 2,
      curbResolutionStatus: 'side_confirmation_required',
      curbSelector: null,
      curbSideConfirmation: response.confirmation,
      sideConfidence: 'unknown',
      confirmedParkingSide: null,
      drivingSide: null,
      publicRules: null,
      publicSchedules: null,
      regulationStatus: null,
    };
  }
  return {
    segmentId: null,
    parkingSide: null,
    restrictionVersionId: null,
    segmentStreetName: null,
    streetIntelStatus: 'unavailable',
    streetIntelReason: response.reason,
    streetIntelCheckedAt: checkedAt,
    curbProtocolVersion: 2,
    curbResolutionStatus: 'unsupported',
    curbSelector: null,
    curbSideConfirmation: null,
    sideConfidence: 'unknown',
    confirmedParkingSide: null,
    drivingSide: null,
    publicRules: null,
    publicSchedules: null,
    regulationStatus: null,
  };
}

export function spotAfterSelectionResponse(
  spot: SavedSpot,
  response: CanonicalCurbResponse,
  mode: CurbSelectionMode,
  candidateToken: string,
  checkedAt?: string,
): SavedSpot {
  const chosen = mode === 'side'
    ? spot.curbSideConfirmation?.curbs.find(curb => curb.token === candidateToken)
    : undefined;
  return {
    ...spot,
    ...savedSpotFieldsFromCanonicalResponse(response, checkedAt),
    curbRefreshAttempted: true,
    ...(mode === 'side' ? {
      confirmedParkingSide: null,
      drivingSide: response.status === 'high_confidence' ? chosen?.drivingSide ?? null : null,
    } : {}),
  };
}

/** A challenge the driver can still submit. Null means leave the spot alone. */
export function expiredSideConfirmationReplacement(spot: SavedSpot, now: number): SavedSpot | null {
  if (spot.curbResolutionStatus !== 'side_confirmation_required') return null;
  if (sideConfirmationChallengeFresh(spot.streetIntelCheckedAt, now)) return null;
  return { ...withoutCurbAuthority(spot), curbRefreshAttempted: true };
}

export function sideConfirmationMillisRemaining(
  checkedAt: string | null | undefined,
  now: number,
): number {
  if (!sideConfirmationChallengeFresh(checkedAt, now)) return 0;
  const checkedAtMs = Date.parse(checkedAt as string);
  return CURB_SIDE_CONFIRMATION_LOCAL_MAX_AGE_MS - (now - checkedAtMs);
}

export function shouldRefreshSavedSpotOnForeground(input: {
  hidden: boolean;
  selectionInFlight: boolean;
  retryInFlight: boolean;
  saveInFlight: boolean;
}): boolean {
  return !input.hidden && !input.selectionInFlight && !input.retryInFlight && !input.saveInFlight;
}

export function selectionMayCommit(input: {
  startedEpoch: number;
  currentEpoch: number;
  sessionId: string;
  stored: { sessionId: string; curbResolutionStatus: string | null } | null;
  nextStatus: string | null;
}): boolean {
  if (input.startedEpoch !== input.currentEpoch) return false;
  if (input.stored && input.stored.sessionId !== input.sessionId) return false;
  if (input.stored?.curbResolutionStatus === 'high_confidence' && input.nextStatus !== 'high_confidence') return false;
  return true;
}

function claimSelection(gate: { current: boolean }): boolean {
  if (gate.current) return false;
  gate.current = true;
  return true;
}

function releaseSelection(gate: { current: boolean }): void {
  gate.current = false;
}

/**
 * One driver selection. A second call while the first is in flight is ignored.
 * An expired local challenge is cleared and never sent. A response that loses
 * the epoch race, including cancel and end-session, is not written.
 */
export async function runCurbSelectionAttempt(input: {
  spot: SavedSpot;
  candidateToken: string;
  mode: CurbSelectionMode;
  now: number;
  gate: { current: boolean };
  currentEpoch: () => number;
  bumpEpoch: () => number;
  commit: (epoch: number, sessionId: string, spot: SavedSpot) => boolean;
  request: (candidateToken: string) => Promise<CanonicalCurbResponse>;
}): Promise<CurbSelectionResult> {
  const { spot, mode } = input;
  if (mode === 'side') {
    if (spot.curbResolutionStatus !== 'side_confirmation_required' || !spot.curbSideConfirmation) return 'ignored';
  } else if (spot.curbResolutionStatus !== 'ambiguous' || !spot.curbSelector) return 'ignored';
  if (!claimSelection(input.gate)) return 'ignored';
  try {
    const expired = mode === 'side' ? expiredSideConfirmationReplacement(spot, input.now) : null;
    if (expired) {
      const epoch = input.bumpEpoch();
      input.commit(epoch, spot.sessionId, expired);
      return 'expired';
    }
    const epoch = input.bumpEpoch();
    const checkedAt = new Date(input.now).toISOString();
    let response: CanonicalCurbResponse;
    try {
      response = await input.request(input.candidateToken);
    } catch {
      response = SOURCE_UNAVAILABLE;
    }
    if (input.currentEpoch() !== epoch) return 'dropped';
    const next = spotAfterSelectionResponse(spot, response, mode, input.candidateToken, checkedAt);
    return input.commit(epoch, spot.sessionId, next) ? 'committed' : 'dropped';
  } finally {
    releaseSelection(input.gate);
  }
}
