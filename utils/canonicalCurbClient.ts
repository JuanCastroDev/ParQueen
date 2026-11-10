import { isCanonicalLocationReady, type AggregatedLocation } from './locationBurst';
import {
  COMPASS,
  type CurbCardinal,
  obliqueCardinalsMatch,
  OPPOSITE,
} from './curbOrientation';
import {
  SIDE_CONFIRMATION_TOKEN_BODY_MAX,
  SIDE_CONFIRMATION_TOKEN_BODY_MIN,
  SIDE_CONFIRMATION_TOKEN_MAC_LENGTH,
} from './sideConfirmationTokenLimits';

export type CanonicalCurbCandidate = Readonly<{
  token: string;
  streetName: string;
  stroke: Readonly<{
    type: 'MultiLineString';
    coordinates: readonly (readonly (readonly [number, number])[])[];
  }>;
}>;

export type CanonicalCurbSelector = Readonly<{
  center: Readonly<{ lat: number; lng: number }>;
  candidates: readonly [CanonicalCurbCandidate, CanonicalCurbCandidate];
}>;

export type { CurbCardinal };

export type DrivingSide = 'left' | 'right';

export type SideConfirmationCurb = Readonly<{
  token: string;
  cardinal: CurbCardinal;
  drivingSide?: DrivingSide;
}>;

export type SideConfirmation = Readonly<{
  streetName: string;
  orientation: Readonly<
    | { north: 'up'; axis: 'north-south' | 'east-west' }
    | { north: 'up'; axis: 'oblique'; bearingDegrees: number }
  >;
  curbs: readonly [SideConfirmationCurb, SideConfirmationCurb];
}>;

export type CanonicalCurbResponse =
  | Readonly<{
    protocolVersion: 2;
    status: 'high_confidence';
    segmentId: string;
    streetName: string;
    sideLabel: CurbCardinal;
    ruleSummary: Readonly<{ cleaningAvailable: boolean }>;
  }>
  | Readonly<{ protocolVersion: 2; status: 'ambiguous'; selector: CanonicalCurbSelector }>
  | Readonly<{
    protocolVersion: 2;
    status: 'side_confirmation_required';
    confirmation: SideConfirmation;
  }>
  | Readonly<{
    protocolVersion: 2;
    status: 'unsupported';
    reason: 'location_quality' | 'candidate_incomplete' | 'intersection_complex' | 'source_unavailable';
  }>;

export type ResolveCurbRequestV2 = Readonly<{
  protocolVersion: 2;
  location: AggregatedLocation;
  candidateToken?: string;
}>;

const PUBLIC_KEY = /^curb2_[a-f0-9]{32}$/;
const CANDIDATE_TOKEN = /^candidate2_[a-f0-9]{16}_[a-f0-9]{32}$/;
const SIDE_CONFIRMATION_TOKEN = new RegExp(
  `^sidec1\\.[A-Za-z0-9_-]{${SIDE_CONFIRMATION_TOKEN_BODY_MIN},${SIDE_CONFIRMATION_TOKEN_BODY_MAX}}\\.[A-Za-z0-9_-]{${SIDE_CONFIRMATION_TOKEN_MAC_LENGTH}}$`,
);
const SIDES = new Set<string>(COMPASS);
const ALIGNED_AXIS: Readonly<Record<string, string>> = {
  North: 'east-west', South: 'east-west', East: 'north-south', West: 'north-south',
};
const REASONS = new Set(['location_quality', 'candidate_incomplete', 'intersection_complex', 'source_unavailable']);

const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const finitePoint = (value: unknown): value is readonly [number, number] =>
  Array.isArray(value) && value.length === 2
  && Number.isFinite(value[0]) && Number.isFinite(value[1])
  && value[0] >= -180 && value[0] <= 180
  && value[1] >= -90 && value[1] <= 90;

function parseCandidate(value: unknown): CanonicalCurbCandidate | null {
  if (!record(value) || !exactKeys(value, ['token', 'streetName', 'stroke'])
    || typeof value.token !== 'string' || !CANDIDATE_TOKEN.test(value.token)
    || typeof value.streetName !== 'string' || !value.streetName.trim()
    || !record(value.stroke) || !exactKeys(value.stroke, ['type', 'coordinates'])
    || value.stroke.type !== 'MultiLineString' || !Array.isArray(value.stroke.coordinates)
    || value.stroke.coordinates.length === 0) return null;
  const valid = value.stroke.coordinates.every(line =>
    Array.isArray(line) && line.length >= 2 && line.every(finitePoint));
  return valid ? value as CanonicalCurbCandidate : null;
}

function parseSideCurb(value: unknown): SideConfirmationCurb | null {
  if (!record(value)) return null;
  const keys = Object.hasOwn(value, 'drivingSide')
    ? ['token', 'cardinal', 'drivingSide'] : ['token', 'cardinal'];
  if (!exactKeys(value, keys)
    || typeof value.token !== 'string' || !SIDE_CONFIRMATION_TOKEN.test(value.token)
    || typeof value.cardinal !== 'string' || !SIDES.has(value.cardinal)) return null;
  if (Object.hasOwn(value, 'drivingSide')
    && value.drivingSide !== 'left' && value.drivingSide !== 'right') return null;
  return value as SideConfirmationCurb;
}

function invalid(): never {
  throw new Error('Invalid canonical curb response');
}

export function parseCanonicalCurbResponse(value: unknown): CanonicalCurbResponse {
  if (!record(value) || value.protocolVersion !== 2 || typeof value.status !== 'string') invalid();
  if (value.status === 'high_confidence') {
    if (!exactKeys(value, ['protocolVersion', 'status', 'segmentId', 'streetName', 'sideLabel', 'ruleSummary'])
      || typeof value.segmentId !== 'string' || !PUBLIC_KEY.test(value.segmentId)
      || typeof value.streetName !== 'string' || !value.streetName.trim()
      || typeof value.sideLabel !== 'string' || !SIDES.has(value.sideLabel)
      || !record(value.ruleSummary) || !exactKeys(value.ruleSummary, ['cleaningAvailable'])
      || typeof value.ruleSummary.cleaningAvailable !== 'boolean') invalid();
    return value as CanonicalCurbResponse;
  }
  if (value.status === 'unsupported') {
    if (!exactKeys(value, ['protocolVersion', 'status', 'reason'])
      || typeof value.reason !== 'string' || !REASONS.has(value.reason)) invalid();
    return value as CanonicalCurbResponse;
  }
  if (value.status === 'ambiguous') {
    if (!exactKeys(value, ['protocolVersion', 'status', 'selector']) || !record(value.selector)
      || !exactKeys(value.selector, ['center', 'candidates']) || !record(value.selector.center)
      || !exactKeys(value.selector.center, ['lat', 'lng'])
      || !Number.isFinite(value.selector.center.lat) || !Number.isFinite(value.selector.center.lng)
      || !Array.isArray(value.selector.candidates) || value.selector.candidates.length !== 2) invalid();
    const candidates = value.selector.candidates.map(parseCandidate);
    if (candidates.some(candidate => !candidate)
      || candidates[0]?.token === candidates[1]?.token
      || JSON.stringify(candidates[0]?.stroke) === JSON.stringify(candidates[1]?.stroke)) invalid();
    return value as CanonicalCurbResponse;
  }
  if (value.status === 'side_confirmation_required') {
    if (!exactKeys(value, ['protocolVersion', 'status', 'confirmation']) || !record(value.confirmation)
      || !exactKeys(value.confirmation, ['streetName', 'orientation', 'curbs'])
      || typeof value.confirmation.streetName !== 'string' || !value.confirmation.streetName.trim()
      || !record(value.confirmation.orientation)
      || value.confirmation.orientation.north !== 'up'
      || !Array.isArray(value.confirmation.curbs) || value.confirmation.curbs.length !== 2) invalid();
    const axis = value.confirmation.orientation.axis;
    const aligned = axis === 'north-south' || axis === 'east-west';
    if (!aligned && axis !== 'oblique') invalid();
    if (aligned && !exactKeys(value.confirmation.orientation, ['north', 'axis'])) invalid();
    if (axis === 'oblique' && !exactKeys(value.confirmation.orientation, ['north', 'axis', 'bearingDegrees'])) invalid();
    const curbs = value.confirmation.curbs.map(parseSideCurb);
    if (!curbs[0] || !curbs[1] || curbs[0].token === curbs[1].token
      || OPPOSITE[curbs[0].cardinal as CurbCardinal] !== curbs[1].cardinal) invalid();
    const driving = curbs.map(curb => curb?.drivingSide);
    if (driving.some(Boolean) && (driving[0] === driving[1] || driving.some(side => !side))) invalid();
    if (aligned && ALIGNED_AXIS[curbs[0].cardinal] !== axis) invalid();
    if (axis === 'oblique' && !obliqueCardinalsMatch(
      value.confirmation.orientation.bearingDegrees as number,
      curbs[0].cardinal,
      curbs[1].cardinal,
    )) invalid();
    return value as CanonicalCurbResponse;
  }
  return invalid();
}

export function buildCanonicalCurbRequest(
  location: AggregatedLocation,
  candidateToken?: string,
): ResolveCurbRequestV2 {
  const request: ResolveCurbRequestV2 = {
    protocolVersion: 2,
    location: {
      lat: location.lat,
      lng: location.lng,
      accuracyMeters: location.accuracyMeters,
      sampleCount: location.sampleCount,
      consistencyMeters: location.consistencyMeters,
    },
    ...(candidateToken ? { candidateToken } : {}),
  };
  return request;
}

export async function resolveCanonicalCurbWithLocation(input: {
  collectLocation: () => Promise<AggregatedLocation | null>;
  invoke: (request: ResolveCurbRequestV2) => Promise<unknown>;
  candidateToken?: string;
}): Promise<CanonicalCurbResponse> {
  let location: AggregatedLocation | null;
  try {
    location = await input.collectLocation();
  } catch {
    location = null;
  }
  if (!isCanonicalLocationReady(location)) {
    return {
      protocolVersion: 2,
      status: 'unsupported',
      reason: 'location_quality',
    };
  }

  const response = await input.invoke(
    buildCanonicalCurbRequest(location, input.candidateToken),
  );
  return parseCanonicalCurbResponse(response);
}
