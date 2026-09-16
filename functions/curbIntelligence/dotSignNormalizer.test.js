import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { normalizeDotSignRow } = require('./dotSignNormalizer');

const VERSION = {
  resourceId: 'nfid-uabd',
  rowsUpdatedAt: '2026-09-15T10:04:47Z',
  viewLastModified: '2026-09-15T10:00:16Z',
};
const ROW = {
  order_number: 'P-01775228', record_type: 'Current', order_type: 'P-', borough: 'Manhattan',
  on_street: 'GOLD STREET', on_street_suffix: null, from_street: 'BEEKMAN STREET',
  from_street_suffix: null, to_street: 'ANN STREET', to_street_suffix: null,
  side_of_street: 'W', order_completed_on_date: '2025-02-11T00:00:00',
  sign_code: 'PS-246B', sign_description: 'NO PARKING (SANITATION BROOM SYMBOL) MONDAY TUESDAY THURSDAY FRIDAY 6:30AM-7:30AM <->',
  sign_size: '12X18', sign_design_voided_on_date: null, sign_location: null,
  distance_from_intersection: '36', arrow_direction: null, facing_direction: null,
  sheeting_type: null, support: null, sign_notes: null, sign_x_coord: '982905', sign_y_coord: '197775',
};

describe('official DOT sign normalization', () => {
  it('retains all verified source-native fields and version evidence', () => {
    const result = normalizeDotSignRow(ROW, VERSION);
    expect(result.ok).toBe(true);
    expect(result.record).toMatchObject({
      orderNumber: 'P-01775228', recordType: 'Current', borough: 'MANHATTAN',
      onStreet: 'GOLD STREET', fromStreet: 'BEEKMAN STREET', toStreet: 'ANN STREET',
      onStreetSuffix: null, fromStreetSuffix: null, toStreetSuffix: null,
      side: 'W', signCode: 'PS-246B', distanceFromIntersection: 36,
      projectedSignCoordinate: { x: 982905, y: 197775, crs: null },
      sourceVersion: VERSION,
    });
    expect(result.record.sourceNative).toEqual(ROW);
  });

  it('exposes but does not discard all official roadbed/intersection suffix evidence', () => {
    const result = normalizeDotSignRow({
      ...ROW,
      on_street_suffix: 'W RDWY',
      from_street_suffix: 'N S/R',
      to_street_suffix: 'E RDWY',
    }, VERSION);
    expect(result.record).toMatchObject({
      onStreetSuffix: 'W RDWY',
      fromStreetSuffix: 'N S/R',
      toStreetSuffix: 'E RDWY',
    });
  });

  it.each([
    [{ ...ROW, record_type: 'Historical' }, 'not_current'],
    [{ ...ROW, sign_code: '' }, 'invalid_sign_identity'],
    [{ ...ROW, order_number: null }, 'invalid_sign_identity'],
    [{ ...ROW, borough: null }, 'invalid_placement_evidence'],
    [{ ...ROW, side_of_street: 'SIDEWAYS' }, 'invalid_placement_evidence'],
  ])('fails closed for invalid official row %#', (row, reason) => {
    expect(normalizeDotSignRow(row, VERSION)).toEqual({ ok: false, reason });
  });

  it('rejects missing or wrong source identity', () => {
    expect(normalizeDotSignRow(ROW, { ...VERSION, resourceId: 'other' }))
      .toEqual({ ok: false, reason: 'invalid_source_version' });
    expect(normalizeDotSignRow(ROW, { ...VERSION, rowsUpdatedAt: 'not-a-time' }))
      .toEqual({ ok: false, reason: 'invalid_source_version' });
  });
});
