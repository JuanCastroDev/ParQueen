import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const fixtures = require('./fixtures/public-official-records.json');

describe('official source normalizers', () => {
  it('normalizes a real CSCL service feature without inventing fields', () => {
    const { normalizeCsclCenterline } = require('./lib/normalizers');
    const result = normalizeCsclCenterline(fixtures.centerlines[0], '1790406804292');

    expect(result).toEqual({
      physicalId: '3',
      leftBfi: '0212262587',
      rightBfi: '1222601917',
      boroughCode: '1',
      borough: 'Manhattan',
      displayName: 'BATTERY PL',
      b5sc: '112670',
      b7sc: null,
      status: '2',
      roadwayType: 1,
      segmentType: null,
      fromLevel: 13,
      toLevel: 13,
      roadbedEvidence: null,
      geometry: {
        type: 'MultiLineString',
        coordinates: [[[-74.0179319168746, 40.7061831036515], [-74.0175756745458, 40.7068481053071]]],
      },
      sourceVersion: '1790406804292',
    });
  });

  it('preserves a source-supported segment-local B7SC when present', () => {
    const { normalizeCsclCenterline } = require('./lib/normalizers');
    const row = structuredClone(fixtures.centerlines[0]);
    row.properties.B7SC = '11267001';
    expect(normalizeCsclCenterline(row, 'release').b7sc).toBe('11267001');
  });

  it('normalizes official Node and StreetName evidence', () => {
    const { normalizeCsclNode, normalizeStreetName } = require('./lib/normalizers');
    expect(normalizeCsclNode(fixtures.nodes[0], 'node-release')).toEqual({
      nodeId: '9054611',
      masterFlag: 'N',
      safType: null,
      groundElevation: null,
      geometry: { type: 'Point', coordinates: [-73.795869952238, 40.7813573687836] },
      sourceVersion: 'node-release',
    });
    expect(normalizeStreetName(fixtures.streetNames[0], 'name-release')).toMatchObject({
      objectId: '15802217',
      basicName: "CUS D'AMATO",
      postType: 'WAY',
      fullName: null,
      b7sc: null,
      sourceVersion: 'name-release',
    });
  });

  it('accepts the CSCL Pub StreetName table when its file export omits OBJECTID', () => {
    const { normalizeStreetName } = require('./lib/normalizers');
    const row = structuredClone(fixtures.streetNames[0]);
    delete row.OBJECTID;

    expect(normalizeStreetName(row, 'name-release').objectId).toBeNull();
  });

  it('marks malformed StreetName B7SC evidence unusable without synthesizing padding', () => {
    const { normalizeStreetName } = require('./lib/normalizers');
    const row = structuredClone(fixtures.streetNames[0]);
    row.B7SC = '500635';

    expect(normalizeStreetName(row, 'name-release')).toMatchObject({
      b7sc: null,
      b7scStatus: 'invalid',
    });
  });

  it.each([[0, false], [1, true], ['0', false], ['1', true]])(
    'parses observed CONFLATED encoding %j',
    (value, expected) => {
      const { parseConflated } = require('./lib/normalizers');
      expect(parseConflated(value)).toBe(expected);
    },
  );

  it.each([null, undefined, true, false, '1.0', '01', 2, -1, 'yes'])(
    'rejects unobserved CONFLATED encoding %j',
    value => {
      const { parseConflated } = require('./lib/normalizers');
      expect(() => parseConflated(value)).toThrow(/CONFLATED/);
    },
  );

  it('normalizes real non-conflated Pavement Edge evidence and preserves source fields', () => {
    const { normalizePavementEdge } = require('./lib/normalizers');
    expect(normalizePavementEdge(fixtures.pavementEdges[0], '1714164498')).toEqual({
      sourceId: '0.0',
      featureCode: '2260',
      subCode: '226000',
      status: 'New',
      blockFaceId: null,
      conflated: false,
      geometry: fixtures.pavementEdges[0].the_geom,
      sourceVersion: '1714164498',
    });
  });

  it('rejects malformed geometries and missing source versions', () => {
    const { normalizeCsclCenterline, normalizePavementEdge } = require('./lib/normalizers');
    const row = structuredClone(fixtures.centerlines[0]);
    row.geometry.coordinates[0][0] = Number.NaN;
    expect(() => normalizeCsclCenterline(row, 'release')).toThrow(/geometry/);
    expect(() => normalizePavementEdge(fixtures.pavementEdges[0], '')).toThrow(/source version/);
  });
});
