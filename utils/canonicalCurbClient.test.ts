import { describe, expect, it, vi } from 'vitest';
import {
  buildCanonicalCurbRequest,
  parseCanonicalCurbResponse,
  resolveCanonicalCurbWithLocation,
} from './canonicalCurbClient';
import type { AggregatedLocation } from './locationBurst';
import { sampleSideConfirmationToken } from './sideConfirmationTokenFixture';
import {
  SIDE_CONFIRMATION_TOKEN_BODY_MAX,
  SIDE_CONFIRMATION_TOKEN_MAC_LENGTH,
  SIDE_CONFIRMATION_TOKEN_MAX_LENGTH,
} from './sideConfirmationTokenLimits';

const key = `curb2_${'a'.repeat(32)}`;

const token = (rank: number) => `candidate2_${'b'.repeat(16)}_${String(rank).repeat(32)}`;
const sideToken = (mark: string) => sampleSideConfirmationToken(mark);
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

  it('accepts a two-curb confirmation and rejects a client-chosen side or private face', () => {
    const confirmation = {
      streetName: 'Maran Place',
      orientation: { north: 'up' as const, axis: 'east-west' as const },
      curbs: [
        { token: sideToken('N'), cardinal: 'North' as const },
        { token: sideToken('S'), cardinal: 'South' as const },
      ],
    };
    expect(parseCanonicalCurbResponse({
      protocolVersion: 2,
      status: 'side_confirmation_required',
      confirmation,
    })).toEqual({ protocolVersion: 2, status: 'side_confirmation_required', confirmation });
    expect(buildCanonicalCurbRequest(location(), sideToken('N'))).toEqual({
      protocolVersion: 2,
      location: location(),
      candidateToken: sideToken('N'),
    });
    expect(() => parseCanonicalCurbResponse({
      protocolVersion: 2,
      status: 'side_confirmation_required',
      confirmation: {
        ...confirmation,
        curbs: [
          { token: token(1), cardinal: 'North' },
          { token: token(2), cardinal: 'South' },
        ],
      },
    })).toThrow('Invalid canonical curb response');
    expect(() => parseCanonicalCurbResponse({
      protocolVersion: 2,
      status: 'side_confirmation_required',
      confirmation: { ...confirmation, officialBlockFaceId: '1000000001' },
    })).toThrow('Invalid canonical curb response');
    expect(() => parseCanonicalCurbResponse({
      protocolVersion: 2,
      status: 'side_confirmation_required',
      confirmation: {
        ...confirmation,
        curbs: [
          { token: token(1), cardinal: 'North' },
          { token: token(1), cardinal: 'South' },
        ],
      },
    })).toThrow('Invalid canonical curb response');
    expect(() => parseCanonicalCurbResponse({
      protocolVersion: 2,
      status: 'side_confirmation_required',
      confirmation: {
        ...confirmation,
        curbs: [
          { token: token(1), cardinal: 'North' },
          { token: token(2), cardinal: 'East' },
        ],
      },
    })).toThrow('Invalid canonical curb response');
    const oversized = `sidec1.${'A'.repeat(SIDE_CONFIRMATION_TOKEN_BODY_MAX + 1)}.${'B'.repeat(SIDE_CONFIRMATION_TOKEN_MAC_LENGTH)}`;
    expect(oversized.length).toBeGreaterThan(SIDE_CONFIRMATION_TOKEN_MAX_LENGTH);
    expect(() => parseCanonicalCurbResponse({
      protocolVersion: 2,
      status: 'side_confirmation_required',
      confirmation: {
        ...confirmation,
        curbs: [
          { token: oversized, cardinal: 'North' },
          { token: sideToken('S'), cardinal: 'South' },
        ],
      },
    })).toThrow('Invalid canonical curb response');
  });

  it('accepts the staged oblique response and rejects a malformed bearing', () => {
    const oblique = {
      streetName: 'Maran Place',
      orientation: { north: 'up' as const, axis: 'oblique' as const, bearingDegrees: 45 },
      curbs: [
        { token: sideToken('NW'), cardinal: 'Northwest' as const },
        { token: sideToken('SE'), cardinal: 'Southeast' as const },
      ],
    };
    expect(parseCanonicalCurbResponse({
      protocolVersion: 2, status: 'side_confirmation_required', confirmation: oblique,
    })).toMatchObject({
      status: 'side_confirmation_required',
      confirmation: { orientation: { axis: 'oblique', bearingDegrees: 45 } },
    });
    const oneWay = {
      ...oblique,
      orientation: { north: 'up' as const, axis: 'oblique' as const, bearingDegrees: 321 },
      curbs: [
        { token: sideToken('SW'), cardinal: 'Southwest' as const, drivingSide: 'left' as const },
        { token: sideToken('NE'), cardinal: 'Northeast' as const, drivingSide: 'right' as const },
      ],
    };
    expect(parseCanonicalCurbResponse({
      protocolVersion: 2, status: 'side_confirmation_required', confirmation: oneWay,
    }).status).toBe('side_confirmation_required');
    expect(() => parseCanonicalCurbResponse({
      protocolVersion: 2,
      status: 'side_confirmation_required',
      confirmation: {
        ...oneWay,
        curbs: oneWay.curbs.map(curb => ({ ...curb, drivingSide: 'right' as const })),
      },
    })).toThrow('Invalid canonical curb response');
    expect(parseCanonicalCurbResponse({
      protocolVersion: 2,
      status: 'high_confidence',
      segmentId: key,
      streetName: 'Maran Place',
      sideLabel: 'Northwest',
      ruleSummary: { cleaningAvailable: false },
    })).toMatchObject({ sideLabel: 'Northwest' });
    expect(() => parseCanonicalCurbResponse({
      protocolVersion: 2,
      status: 'side_confirmation_required',
      confirmation: {
        ...oblique,
        curbs: [
          { token: sideToken('N'), cardinal: 'North' },
          { token: sideToken('S'), cardinal: 'South' },
        ],
      },
    })).toThrow('Invalid canonical curb response');
    expect(() => parseCanonicalCurbResponse({
      protocolVersion: 2,
      status: 'side_confirmation_required',
      confirmation: {
        ...oblique,
        orientation: { north: 'up', axis: 'oblique', bearingDegrees: 80 },
      },
    })).toThrow('Invalid canonical curb response');
    expect(() => parseCanonicalCurbResponse({
      protocolVersion: 2,
      status: 'side_confirmation_required',
      confirmation: {
        ...oblique,
        orientation: { north: 'up', axis: 'oblique' },
      },
    })).toThrow('Invalid canonical curb response');
    expect(() => parseCanonicalCurbResponse({
      protocolVersion: 2,
      status: 'high_confidence',
      segmentId: key,
      streetName: 'Maran Place',
      sideLabel: 'Left',
      ruleSummary: { cleaningAvailable: false },
    })).toThrow('Invalid canonical curb response');
    for (const sideLabel of ['Northwest', 'Southeast', 'Northeast', 'Southwest']) {
      expect(parseCanonicalCurbResponse({
        protocolVersion: 2,
        status: 'high_confidence',
        segmentId: key,
        streetName: 'Maran Place',
        sideLabel,
        ruleSummary: { cleaningAvailable: false },
      })).toMatchObject({ status: 'high_confidence', segmentId: key, sideLabel });
    }
    expect(() => parseCanonicalCurbResponse({
      protocolVersion: 2,
      status: 'high_confidence',
      segmentId: key,
      streetName: 'Maran Place',
      sideLabel: 'NW',
      ruleSummary: { cleaningAvailable: false },
    })).toThrow('Invalid canonical curb response');
  });

  it('ignores a late backend response after the caller aborts', async () => {
    const controller = new AbortController();
    const collectLocation = vi.fn().mockResolvedValue({
      lat: 40.7, lng: -74, accuracyMeters: 5, sampleCount: 4, consistencyMeters: 3,
    });
    const invoke = vi.fn().mockImplementation(async () => {
      controller.abort();
      return {
        protocolVersion: 2,
        status: 'high_confidence',
        segmentId: 'curb2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        streetName: 'Late Street',
        sideLabel: 'North',
        ruleSummary: { cleaningAvailable: true },
      };
    });
    await expect(resolveCanonicalCurbWithLocation({
      collectLocation,
      invoke,
      signal: controller.signal,
    })).resolves.toEqual({
      protocolVersion: 2,
      status: 'unsupported',
      reason: 'source_unavailable',
    });
    expect(invoke).toHaveBeenCalledOnce();
  });
});
