import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { projectPointToMultiLineString, rankRoadwayCandidates } = require('./geometry');

const EASTBOUND = [[[-74.001, 40.7], [-73.999, 40.7]]];

describe('metric CSCL geometry projection', () => {
  it('projects GeoJSON longitude/latitude coordinates in meters and preserves the local tangent', () => {
    const result = projectPointToMultiLineString({ lat: 40.7001, lng: -74 }, EASTBOUND);
    expect(result.distanceMeters).toBeCloseTo(11.12, 1);
    expect(result.projectedPoint.lat).toBeCloseTo(40.7, 6);
    expect(result.projectedPoint.lng).toBeCloseTo(-74, 6);
    expect(result.tangent.eastMeters).toBeGreaterThan(100);
    expect(Math.abs(result.tangent.northMeters)).toBeLessThan(0.01);
  });

  it('maps left and right from digitized geometry rather than traffic direction', () => {
    const north = projectPointToMultiLineString({ lat: 40.7001, lng: -74 }, EASTBOUND);
    const south = projectPointToMultiLineString({ lat: 40.6999, lng: -74 }, EASTBOUND);
    expect(north.csclSide).toBe('LEFT');
    expect(north.signedOffsetMeters).toBeGreaterThan(0);
    expect(south.csclSide).toBe('RIGHT');
    expect(south.signedOffsetMeters).toBeLessThan(0);
  });

  it('handles a vertical and diagonal segment deterministically', () => {
    const vertical = projectPointToMultiLineString(
      { lat: 40.7, lng: -73.9999 },
      [[[-74, 40.699], [-74, 40.701]]],
    );
    expect(vertical.csclSide).toBe('RIGHT');
    expect(vertical.distanceMeters).toBeCloseTo(8.44, 1);

    const diagonal = projectPointToMultiLineString(
      { lat: 40.7001, lng: -74.0001 },
      [[[-74.001, 40.699], [-73.999, 40.701]]],
    );
    expect(diagonal.distanceMeters).toBeGreaterThan(0);
    expect(['LEFT', 'RIGHT']).toContain(diagonal.csclSide);
  });

  it('selects the closest component and returns along-line endpoint evidence', () => {
    const result = projectPointToMultiLineString(
      { lat: 40.7, lng: -74 },
      [
        [[-74.01, 40.71], [-74.009, 40.71]],
        [[-74.001, 40.7], [-73.999, 40.7]],
      ],
    );
    expect(result.lineIndex).toBe(1);
    expect(result.segmentIndex).toBe(0);
    expect(result.distanceMeters).toBeCloseTo(0, 5);
    expect(result.distanceToComponentStartMeters).toBeGreaterThan(80);
    expect(result.distanceToComponentEndMeters).toBeGreaterThan(80);
  });

  it('ranks competing parallel roadways using exact local distance', () => {
    const ranked = rankRoadwayCandidates(
      { lat: 40.7, lng: -74 },
      [
        { id: 'far', coordinates: [[[-74.001, 40.7005], [-73.999, 40.7005]]] },
        { id: 'near', coordinates: EASTBOUND },
      ],
    );
    expect(ranked.map(item => item.id)).toEqual(['near', 'far']);
    expect(ranked[1].projection.distanceMeters).toBeCloseTo(55.6, 0);
  });

  it.each([null, [], [[]], [[[-74, 40.7]]], [[[40.7, -74], [40.8, -74]]]])(
    'fails closed for malformed or reversed-coordinate geometry: %j',
    coordinates => expect(projectPointToMultiLineString({ lat: 40.7, lng: -74 }, coordinates)).toBeNull(),
  );
});
