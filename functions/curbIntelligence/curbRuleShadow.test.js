import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { toPersistableCurbRuleComparison } = require('./curbRuleShadow');

const internal = () => ({
  states: { curb: 'CAUTION', cleaning: 'SUPPORTED', meter: 'CAUTION' },
  curbIdentity: { state: 'CAUTION', officialIdentity: { officialBlockFaceId: '0212261301' }, rawUserLocation: { lat: 40.7, lng: -74 } },
  cleaning: { confidence: 'SUPPORTED', fingerprint: 'Mon|08:00|09:00', rules: [{ provenance: { orderNumber: 'P-1', signCoordinates: [1, 2] } }] },
  meter: { state: 'CAUTION', reasonCodes: ['multiple_meter_zones'], rules: [{ zoneId: '100124', geometry: { coordinates: [] } }, { zoneId: '100125' }] },
  sourceVersions: { cscl: 'v1', dotSigns: 'v2', parkNyc: 'v3' },
  diagnostics: { address: 'private', candidates: [{ location: [1, 2] }] },
});

describe('Phase 1B.2 shadow privacy projection', () => {
  it('retains only non-reversible derived states, counts, fingerprints, categories, and versions', () => {
    const result = toPersistableCurbRuleComparison(internal());
    expect(result).toEqual({
      ok: true,
      comparison: {
        curbState: 'CAUTION', cleaningState: 'CAUTION', meterState: 'CAUTION',
        cleaningRuleCount: 1, meterRuleCount: 2, cleaningFingerprint: 'Mon|08:00|09:00',
        categories: ['multiple_meter_zones'], sourceVersions: { cscl: 'v1', dotSigns: 'v2', parkNyc: 'v3' },
      },
    });
    const encoded = JSON.stringify(result.comparison).toLowerCase();
    for (const forbidden of ['latitude', 'longitude', 'lat', 'lng', 'geometry', 'geohash', 'address', 'blockface', 'zoneid', 'ordernumber', 'coordinates']) {
      expect(encoded).not.toContain(forbidden);
    }
  });

  it('fails closed for malformed states, fingerprints, categories, and source versions', () => {
    expect(toPersistableCurbRuleComparison({ ...internal(), states: { curb: 'BROKEN', cleaning: 'SUPPORTED', meter: 'SUPPORTED' } })).toMatchObject({ ok: false });
    expect(toPersistableCurbRuleComparison({ ...internal(), cleaning: { fingerprint: '40.7,-74', rules: [] } })).toMatchObject({ ok: false });
    expect(toPersistableCurbRuleComparison({ ...internal(), meter: { state: 'CAUTION', reasonCodes: ['secret=40.7'], rules: [] } })).toMatchObject({ ok: false });
    expect(toPersistableCurbRuleComparison({ ...internal(), sourceVersions: { cscl: '' } })).toMatchObject({ ok: false });
    expect(toPersistableCurbRuleComparison({ ...internal(), sourceVersions: { cscl: 'v1', preciseLocation: 'v2' } })).toMatchObject({ ok: false });
  });

  it.each([
    'candidate_source_incomplete', 'source_version_mismatch', 'partial_face_detected',
    'incomplete_cleaning_rule', 'official_meter_face_mismatch',
    'essential_meter_terms_incomplete', 'meter_rate_incomplete', 'competing_meter_faces',
  ])('accepts reviewed fail-closed category %s without retaining its raw evidence', category => {
    const value = internal();
    value.cleaning.reasons = [];
    value.meter.reasonCodes = [category];
    expect(toPersistableCurbRuleComparison(value)).toMatchObject({ ok: true, comparison: { categories: [category] } });
  });
});
