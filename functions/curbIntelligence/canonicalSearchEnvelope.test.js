'use strict';

const { buildCanonicalSearchEnvelope, isCanonicalSearchEnvelope } = require('./canonicalSearchEnvelope');

describe('canonical search envelope', () => {
  it('builds one deterministic deeply immutable 24-vertex closed envelope', () => {
    const first = buildCanonicalSearchEnvelope({ lat: 40.75, lng: -73.98 }, 65);
    const second = buildCanonicalSearchEnvelope({ lat: 40.75, lng: -73.98 }, 65);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      schemaVersion: 'canonical-cscl-envelope-1', coordinateSystem: 'EPSG:4326',
      coordinateOrder: 'longitude-latitude', center: [-73.98, 40.75], vertexCount: 24,
      coordinatePrecision: 12, algorithmVersion: 'geodesic-bearing-ring-1',
    });
    expect(first.vertices).toHaveLength(25);
    expect(first.vertices[0]).toEqual(first.vertices[24]);
    expect(first.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.wkt).toBe(`POLYGON((${first.vertices.map(point => `${point[0]} ${point[1]}`).join(',')}))`);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.center)).toBe(true);
    expect(first.vertices.every(Object.isFrozen)).toBe(true);
    expect(isCanonicalSearchEnvelope(first)).toBe(true);
  });

  it('normalizes negative zero and rejects invalid inputs or altered envelopes', () => {
    const value = buildCanonicalSearchEnvelope({ lat: 40.75, lng: -73.98 }, 50);
    const alteredVertices = value.vertices.map(point => [...point]);
    alteredVertices[1][0] = 0;
    expect(JSON.stringify(value)).not.toContain('-0');
    expect(isCanonicalSearchEnvelope({ ...value, digest: '0'.repeat(64) })).toBe(false);
    expect(isCanonicalSearchEnvelope({ ...value, vertices: alteredVertices })).toBe(false);
    expect(() => buildCanonicalSearchEnvelope({ lat: 0, lng: 0 }, 50)).toThrow();
    expect(() => buildCanonicalSearchEnvelope({ lat: 40.75, lng: -73.98 }, 501)).toThrow();
  });
});
