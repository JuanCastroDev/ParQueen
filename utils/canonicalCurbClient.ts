import type { AggregatedLocation } from './locationBurst';

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

export type CanonicalCurbResponse =
  | Readonly<{
    protocolVersion: 2;
    status: 'high_confidence';
    segmentId: string;
    streetName: string;
    sideLabel: 'North' | 'South' | 'East' | 'West';
    ruleSummary: Readonly<{ cleaningAvailable: boolean }>;
  }>
  | Readonly<{ protocolVersion: 2; status: 'ambiguous'; selector: CanonicalCurbSelector }>
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
const SIDES = new Set(['North', 'South', 'East', 'West']);
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
