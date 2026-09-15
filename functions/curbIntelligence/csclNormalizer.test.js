import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { normalizeCsclRow } = require('./csclNormalizer');

const version = { resourceId: 'inkn-q76z', version: '2026-09-12T15:37:00Z' };
const row = {
  the_geom: { type: 'MultiLineString', coordinates: [[[-74.001, 40.71], [-74.0005, 40.711]]] },
  globalid: 'abc-123', physicalid: '189761', l_blockfaceid: '212261301', r_blockfaceid: '212260958',
  boroughcode: '1', b5sc: '11234', rw_type: '1', full_street_name: 'GOLD STREET',
  street_name: 'GOLD', stname_label: 'GOLD ST', trafdir: 'TW', nominaldir: 'N', streetwidth: '30',
  from_level_code: 'M', to_level_code: 'M', accessible: 'Y', nonped: 'N', status: '2',
  modified_date: '2026-09-12T00:00:00.000', created_date: '2010-01-01T00:00:00.000',
  objectid: '999',
};

describe('CSCL source normalization', () => {
  it('preserves reviewed native evidence while separating source version and durable identity', () => {
    const result = normalizeCsclRow(row, version);
    expect(result.ok).toBe(true);
    expect(result.sourceVersion).toEqual(version);
    expect(result.record.geometry).toEqual(row.the_geom);
    expect(result.record.leftBlockFaceId).toBe('0212261301');
    expect(result.record.rightBlockFaceId).toBe('0212260958');
    expect(result.record.sourceNative).toMatchObject({
      globalid: 'abc-123', physicalid: '189761', boroughcode: '1', b5sc: '11234', rw_type: '1',
      full_street_name: 'GOLD STREET', street_name: 'GOLD', stname_label: 'GOLD ST',
      trafdir: 'TW', nominaldir: 'N', streetwidth: '30', from_level_code: 'M', to_level_code: 'M',
      accessible: 'Y', nonped: 'N', status: '2', modified_date: '2026-09-12T00:00:00.000',
      created_date: '2010-01-01T00:00:00.000',
    });
    expect(result.record.sourceNative).not.toHaveProperty('objectid');
  });

  it('retains an explicit missing face without inventing identity', () => {
    const result = normalizeCsclRow({ ...row, l_blockfaceid: '', r_blockfaceid: null }, version);
    expect(result.ok).toBe(true);
    expect(result.record.leftBlockFaceId).toBeNull();
    expect(result.record.rightBlockFaceId).toBeNull();
  });

  it.each([
    [null, 'invalid_source_row'],
    [{ ...row, globalid: '' }, 'missing_globalid'],
    [{ ...row, the_geom: { type: 'LineString', coordinates: row.the_geom.coordinates[0] } }, 'invalid_geometry'],
    [{ ...row, the_geom: { type: 'MultiLineString', coordinates: [[[40.71, -74.001], [40.711, -74.0005]]] } }, 'invalid_geometry'],
    [{ ...row, l_blockfaceid: 212261301 }, 'invalid_block_face_id'],
  ])('fails closed for malformed source evidence', (candidate, reason) => {
    expect(normalizeCsclRow(candidate, version)).toEqual({ ok: false, reason });
  });

  it('requires a separately supplied current CSCL source version', () => {
    expect(normalizeCsclRow(row, null)).toEqual({ ok: false, reason: 'invalid_source_version' });
  });
});
