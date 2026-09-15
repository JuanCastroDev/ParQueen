import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  SHADOW_COMPARISON_CATEGORIES,
  SOURCE_ADAPTER_BOUNDARIES,
  createShadowComparison,
} = require('./contracts');

const CATEGORIES = [
  'exact_agreement',
  'new_adds_meter',
  'old_missing_cleaning',
  'cleaning_schedule_differs',
  'side_uncertain',
  'alternate_name_mismatch',
  'multiple_meter_zones',
  'partial_face_detected',
  'official_face_missing',
  'multilevel_or_roadbed_ambiguity',
  'source_outage',
  'stale_version_mismatch',
];

const validInput = category => ({
  category,
  oldCleaningFingerprint: 'Mon|08:00|09:00',
  newCleaningFingerprint: 'Mon|08:00|09:00',
  meterRulePresent: false,
  blockFaceResolutionState: 'SUPPORTED',
  reasonCodes: category === 'exact_agreement' ? [] : [category],
  sourceVersions: {
    cscl: 'phase-0.5-audit-snapshot-2026-09-14',
    dotSigns: 'phase-0.5-audit-snapshot-2026-09-14',
  },
});

describe('curb source adapter boundaries', () => {
  it('names authoritative roles without implementing live source calls', () => {
    expect(SOURCE_ADAPTER_BOUNDARIES).toMatchObject({
      cscl: { mapAssetId: '3mf9-qshr', resourceId: 'inkn-q76z', role: 'official_curb_identity' },
      nycDotSigns: { resourceId: 'nfid-uabd', role: 'posted_regulations' },
      parkNyc: { resourceId: 'e7yp-wx55', role: 'payment_rules', implementationPhase: 'deferred' },
      sweepNyc: { role: 'optional_operational_evidence', authoritative: false },
    });
  });
});

describe('privacy-safe shadow comparison contract', () => {
  it('accepts every reviewed comparison category, including exact agreement', () => {
    expect(SHADOW_COMPARISON_CATEGORIES).toEqual(CATEGORIES);
    for (const category of CATEGORIES) {
      const result = createShadowComparison(validInput(category));
      expect(result.ok, category).toBe(true);
      expect(result.comparison.category).toBe(category);
    }
  });

  it('retains only derived comparison fields and explicit source versions', () => {
    const result = createShadowComparison(validInput('exact_agreement'));
    expect(result).toEqual({ ok: true, comparison: validInput('exact_agreement') });
    expect(result.comparison).not.toHaveProperty('officialBlockFaceId');
  });

  it.each([
    { latitude: 40.7 },
    { longitude: -74 },
    { lat: 40.7, lng: -74 },
    { coordinate: [-74, 40.7] },
    { nested: { coordinates: [[-74, 40.7]] } },
    { candidate: { geometry: { type: 'LineString' } } },
    { location: { x: 1, y: 2 } },
    { geohash: 'dr5ru' },
    { officialBlockFaceId: '0212261301' },
  ])('rejects raw or reversible fine-location evidence: %o', sensitive => {
    expect(createShadowComparison({ ...validInput('exact_agreement'), ...sensitive }))
      .toMatchObject({ ok: false, reason: 'sensitive_location_field' });
  });

  it('rejects unreviewed categories, hidden fields, and malformed source versions', () => {
    expect(createShadowComparison(validInput('something_else')))
      .toEqual({ ok: false, reason: 'invalid_category' });
    expect(createShadowComparison({ ...validInput('exact_agreement'), notes: 'free text' }))
      .toEqual({ ok: false, reason: 'unexpected_field', field: 'notes' });
    expect(createShadowComparison({ ...validInput('exact_agreement'), sourceVersions: { cscl: '' } }))
      .toEqual({ ok: false, reason: 'invalid_source_versions' });
  });

  it('does not provide arbitrary text fields that could smuggle fine-location evidence', () => {
    expect(createShadowComparison({
      ...validInput('exact_agreement'),
      oldCleaningFingerprint: '40.7000,-74.0000',
    })).toEqual({ ok: false, reason: 'invalid_cleaning_fingerprint' });
    expect(createShadowComparison({
      ...validInput('side_uncertain'),
      reasonCodes: ['latitude=40.7000'],
    })).toEqual({ ok: false, reason: 'invalid_reason_codes' });
  });

  it('rejects syntactically valid but noncanonical cleaning fingerprints', () => {
    expect(createShadowComparison({
      ...validInput('cleaning_schedule_differs'),
      oldCleaningFingerprint: 'Fri,Mon|08:00|09:00',
    })).toEqual({ ok: false, reason: 'invalid_cleaning_fingerprint' });
    expect(createShadowComparison({
      ...validInput('cleaning_schedule_differs'),
      newCleaningFingerprint: 'Thu|11:00|12:00;Mon|08:00|09:00',
    })).toEqual({ ok: false, reason: 'invalid_cleaning_fingerprint' });
  });
});
