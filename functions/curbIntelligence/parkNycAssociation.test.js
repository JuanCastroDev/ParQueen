import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { associateParkNycRules } = require('./parkNycAssociation');

const version = { resourceId: 'e7yp-wx55', rowsUpdatedAt: '2026-09-01T10:21:51Z', viewLastModified: '2026-09-01T10:20:59Z' };
const point = { lat: 40.70958, lng: -74.00504 };
const meter = (overrides = {}) => ({
  zoneId: '100124', vehicleClass: 'ALL_VEHICLES', passengerApplicable: true,
  commercialApplicable: true, borough: 'MANHATTAN', side: 'W', onStreet: 'GOLD STREET',
  fromStreet: 'BEEKMAN STREET', toStreet: 'ANN STREET', rateZone: 'Zone M1',
  geometry: { type: 'MultiLineString', coordinates: [[[-74.00515, 40.70949], [-74.00494, 40.70968]]] },
  branches: { passenger: { complete: true, rateComplete: true, maximumMinutes: 120 }, commercial: null },
  sourceVersion: version, sourceNative: {}, ...overrides,
});
const curb = (state = 'SUPPORTED') => ({ state, officialIdentity: { officialBlockFaceId: '1234567890' } });
const snapshot = (candidates, state = 'COMPLETE') => ({ candidates, completeness: { state, reason: state === 'COMPLETE' ? null : 'coverage_gap' }, sourceVersion: version });
const input = (candidates, extra = {}) => ({
  curbIdentity: curb(), resolvedPoint: point, officialNames: ['GOLD STREET'],
  officialBounds: ['BEEKMAN STREET', 'ANN STREET'], borough: 'MANHATTAN', side: 'W', candidateSnapshot: snapshot(candidates), ...extra,
});

describe('official ParkNYC geometry association', () => {
  it('supports a unique passenger-applicable row with exact official semantics', () => {
    const result = associateParkNycRules(input([meter()]));
    expect(result).toMatchObject({ state: 'SUPPORTED', reasonCodes: [], rules: [{ zoneId: '100124', state: 'SUPPORTED' }] });
    expect(result.rules[0]).toMatchObject({
      type: 'METER', source: 'park_nyc', associationState: 'SUPPORTED', applicability: 'WHOLE_FACE',
      vehicleApplicability: { passenger: true }, meterTerms: { maximumMinutes: 120 },
    });
    expect(result.rules[0].distanceMeters).toBeLessThan(2);
  });

  it.each([
    ['borough', meter({ borough: 'BROOKLYN' })],
    ['side', meter({ side: 'E' })],
    ['bounds', meter({ fromStreet: 'PEARL STREET' })],
    ['name', meter({ onStreet: 'WILLIAM STREET' })],
  ])('rejects wrong official %s evidence', (_label, candidate) => {
    expect(associateParkNycRules(input([candidate]))).toMatchObject({ state: 'UNKNOWN', reasonCodes: ['official_meter_face_mismatch'] });
  });

  it('does not treat a matching zone identifier as curb identity', () => {
    const result = associateParkNycRules(input([meter({ onStreet: 'WILLIAM STREET' })], { zoneId: '100124' }));
    expect(result.state).toBe('UNKNOWN');
  });

  it('fails closed for incomplete coverage, off-network geometry, and mixed source versions', () => {
    expect(associateParkNycRules(input([meter()], { candidateSnapshot: snapshot([meter()], 'INCOMPLETE') }))).toMatchObject({ state: 'UNKNOWN', reasonCodes: ['candidate_coverage_incomplete'] });
    expect(associateParkNycRules(input([meter({ geometry: { type: 'MultiLineString', coordinates: [[[-73.99, 40.72], [-73.989, 40.721]]] } })]))).toMatchObject({ state: 'UNKNOWN', reasonCodes: ['meter_geometry_off_network'] });
    expect(associateParkNycRules(input([meter({ sourceVersion: { ...version, rowsUpdatedAt: '2025-01-01T00:00:00Z' } })]))).toMatchObject({ state: 'UNKNOWN', reasonCodes: ['source_version_mismatch'] });
  });

  it('deduplicates semantically identical corroboration', () => {
    const result = associateParkNycRules(input([meter(), meter({ sourceNative: { duplicate: true } })]));
    expect(result).toMatchObject({ state: 'SUPPORTED' });
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].corroboratingRecordCount).toBe(2);
  });

  it('preserves explainable multiple zones deterministically as CAUTION', () => {
    const result = associateParkNycRules(input([meter({ zoneId: '100125' }), meter({ zoneId: '100124' })]));
    expect(result).toMatchObject({ state: 'CAUTION', reasonCodes: ['multiple_meter_zones'] });
    expect(result.rules.map(rule => rule.zoneId)).toEqual(['100124', '100125']);
  });

  it('fails UNKNOWN for competing geometries at comparable distance', () => {
    const competing = meter({ zoneId: '100126', side: 'W', geometry: { type: 'MultiLineString', coordinates: [[[-74.00514, 40.70968], [-74.00494, 40.70949]]] } });
    const result = associateParkNycRules(input([meter(), competing]));
    expect(result).toMatchObject({ state: 'UNKNOWN', reasonCodes: ['competing_meter_faces'] });
    expect(result.rules.map(rule => rule.zoneId)).toEqual(['100124', '100126']);
    expect(result.rules.every(rule => rule.state === 'UNKNOWN')).toBe(true);
  });

  it('makes incomplete essential terms UNKNOWN and incomplete rate/cap detail CAUTION', () => {
    const essential = meter({ branches: { passenger: { complete: false, essentialReason: 'unsupported_schedule_format', rateComplete: true }, commercial: null } });
    expect(associateParkNycRules(input([essential]))).toMatchObject({ state: 'UNKNOWN', reasonCodes: ['essential_meter_terms_incomplete'] });
    const noncritical = meter({ branches: { passenger: { complete: true, maximumMinutes: 120, schedule: { ok: true, windows: [] }, rateComplete: false }, commercial: null } });
    expect(associateParkNycRules(input([noncritical]))).toMatchObject({ state: 'CAUTION', reasonCodes: ['meter_rate_incomplete'] });
  });

  it('does not create a passenger rule from Commercial Only evidence', () => {
    const result = associateParkNycRules(input([meter({ vehicleClass: 'COMMERCIAL_ONLY', passengerApplicable: false, branches: { passenger: null, commercial: { complete: true } } })]));
    expect(result).toMatchObject({ state: 'UNKNOWN', reasonCodes: ['no_passenger_meter_rule'] });
  });

  it.each(['CAUTION', 'UNKNOWN'])('never exceeds %s curb identity', state => {
    const result = associateParkNycRules(input([meter()], { curbIdentity: curb(state) }));
    expect(result.state).toBe(state);
    expect(result.rules.every(rule => rule.state === state)).toBe(true);
    expect(result.reasonCodes).toContain(`curb_identity_${state.toLowerCase()}`);
  });
});
