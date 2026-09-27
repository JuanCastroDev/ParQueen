import { describe, expect, it, vi } from 'vitest';
import {
  buildCanonicalCurbRequest,
  parseCanonicalCurbResponse,
  resolveCanonicalCurbWithLocation,
} from './canonicalCurbClient';
import type { AggregatedLocation } from './locationBurst';

const key = `curb2_${'a'.repeat(32)}`;
const token = (rank: number) => `candidate2_${'b'.repeat(16)}_${String(rank).repeat(32)}`;
const stroke = (offset = 0) => ({
  type: 'MultiLineString' as const,
  coordinates: [[[-74, 40.7 + offset], [-73.999, 40.7 + offset]]],
});
const location = (override: Partial<AggregatedLocation> = {}): AggregatedLocation => ({
  lat: 40.7,
  lng: -74,
  accuracyMeters: 10,
  sampleCount: 3,
  consistencyMeters: 4,
  ...override,
});

describe('canonical curb V2 client contract', () => {
  it('accepts high-confidence, exactly-two-candidate ambiguous, and unsupported responses', () => {
    expect(parseCanonicalCurbResponse({
      protocolVersion: 2,
      status: 'high_confidence',
      segmentId: key,
      streetName: 'Maran Place',
      sideLabel: 'North',
      ruleSummary: { cleaningAvailable: true },
    }).status).toBe('high_confidence');

    expect(parseCanonicalCurbResponse({
      protocolVersion: 2,
      status: 'ambiguous',
      selector: {
        center: { lat: 40.7, lng: -74 },
        candidates: [
          { token: token(0), streetName: 'Maran Place', stroke: stroke() },
          { token: token(1), streetName: 'White Plains Road', stroke: stroke(0.0001) },
        ],
      },
    }).status).toBe('ambiguous');

    expect(parseCanonicalCurbResponse({
      protocolVersion: 2, status: 'unsupported', reason: 'location_quality',
    })).toEqual({ protocolVersion: 2, status: 'unsupported', reason: 'location_quality' });
  });

  it.each([
    ['bad segment key', { protocolVersion: 2, status: 'high_confidence', segmentId: 'nearby_80m', streetName: 'Maran', sideLabel: 'North', ruleSummary: { cleaningAvailable: true } }],
    ['private field', { protocolVersion: 2, status: 'unsupported', reason: 'location_quality', officialBlockFaceId: '1000000001' }],
    ['one candidate', { protocolVersion: 2, status: 'ambiguous', selector: { center: { lat: 40.7, lng: -74 }, candidates: [{ token: token(0), streetName: 'Maran', stroke: stroke() }] } }],
    ['three candidates', { protocolVersion: 2, status: 'ambiguous', selector: { center: { lat: 40.7, lng: -74 }, candidates: [0, 1, 2].map(i => ({ token: token(i), streetName: `S${i}`, stroke: stroke(i / 10000) })) } }],
    ['malformed geometry', { protocolVersion: 2, status: 'ambiguous', selector: { center: { lat: 40.7, lng: -74 }, candidates: [{ token: token(0), streetName: 'A', stroke: { type: 'LineString', coordinates: [] } }, { token: token(1), streetName: 'B', stroke: stroke() }] } }],
    ['invalid token', { protocolVersion: 2, status: 'ambiguous', selector: { center: { lat: 40.7, lng: -74 }, candidates: [{ token: 'private-id', streetName: 'A', stroke: stroke() }, { token: token(1), streetName: 'B', stroke: stroke() }] } }],
    ['unknown status', { protocolVersion: 2, status: 'maybe' }],
  ])('rejects %s', (_name, value) => {
    expect(() => parseCanonicalCurbResponse(value)).toThrow('Invalid canonical curb response');
  });

  it('builds the one allowed V2 request shape without raw samples', () => {
    expect(buildCanonicalCurbRequest({
      lat: 40.7, lng: -74, accuracyMeters: 5, sampleCount: 4, consistencyMeters: 3,
    })).toEqual({
      protocolVersion: 2,
      location: { lat: 40.7, lng: -74, accuracyMeters: 5, sampleCount: 4, consistencyMeters: 3 },
    });
    expect(buildCanonicalCurbRequest({
      lat: 40.7, lng: -74, accuracyMeters: 5, sampleCount: 4, consistencyMeters: 3,
    }, token(0))).toHaveProperty('candidateToken', token(0));
  });

  it.each([
    ['one sample', { sampleCount: 1 }],
    ['two samples', { sampleCount: 2 }],
    ['poor accuracy', { accuracyMeters: 50.001 }],
    ['inconsistent samples', { consistencyMeters: 12.001 }],
  ])('returns local location_quality for %s without invoking the backend', async (_label, override) => {
    const collectLocation = vi.fn().mockResolvedValue(location(override));
    const invoke = vi.fn();

    await expect(resolveCanonicalCurbWithLocation({ collectLocation, invoke })).resolves.toEqual({
      protocolVersion: 2,
      status: 'unsupported',
      reason: 'location_quality',
    });
    expect(collectLocation).toHaveBeenCalledOnce();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('returns local location_quality when collection produces no usable sample', async () => {
    const collectLocation = vi.fn().mockRejectedValue(new Error('No valid location samples'));
    const invoke = vi.fn();

    await expect(resolveCanonicalCurbWithLocation({ collectLocation, invoke })).resolves.toEqual({
      protocolVersion: 2,
      status: 'unsupported',
      reason: 'location_quality',
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it('invokes the backend exactly once after one valid collection and preserves fail-closed results', async () => {
    const collectLocation = vi.fn().mockResolvedValue(location());
    const invoke = vi.fn().mockResolvedValue({
      protocolVersion: 2,
      status: 'unsupported',
      reason: 'candidate_incomplete',
    });

    await expect(resolveCanonicalCurbWithLocation({ collectLocation, invoke })).resolves.toEqual({
      protocolVersion: 2,
      status: 'unsupported',
      reason: 'candidate_incomplete',
    });
    expect(collectLocation).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke).toHaveBeenCalledWith({
      protocolVersion: 2,
      location: location(),
    });
  });
});
