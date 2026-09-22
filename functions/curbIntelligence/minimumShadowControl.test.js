'use strict';

const {
  MAX_SHADOW_ACCURACY_METERS,
  validateShadowAccuracy,
  evaluatePreSourceEligibility,
  evaluateProductPathEligibility,
  deterministicSampleSelected,
} = require('./minimumShadowControl');

const eligible = Object.freeze({
  mode: 'shadow',
  samplePermille: 0,
  operatorAuthorized: true,
  accuracyMeters: 12,
  productionPath: 'nyc_open_data_fallback',
  dotEvidence: {
    complete: true,
    sourceVersion: {
      resourceId: 'nfid-uabd', rowsUpdatedAt: '2026-01-01T00:00:00.000Z',
      viewLastModified: '2026-01-02T00:00:00.000Z',
    },
    selectedRows: [{
      order_number: 'P-100', record_type: 'Current', order_type: 'P-', borough: 'MANHATTAN',
      on_street: 'GOLD STREET', from_street: 'BEEKMAN STREET', to_street: 'ANN STREET',
      side_of_street: 'E', sign_code: 'PS-1',
      sign_description: 'NO PARKING (SANITATION BROOM SYMBOL) TUESDAY 8:30AM-10AM',
    }],
  },
  legacyEvidence: {
    segment: {
      source: 'nyc_open_data', provenance: { provider: 'nyc_open_data' }, status: 'active',
      confidenceScore: 1, confidence: { level: 'verified' },
      blockFaceEvidence: { blockDecisive: true, sideResolved: true, parseComplete: true },
    },
    activeRules: [{
      type: 'streetCleaning', source: 'nyc_open_data', status: 'active',
      schedules: [{ side: 'East', days: ['Tue'], startTime: '08:30', endTime: '10:00' }],
    }],
  },
});

describe('minimum cleaning shadow controls', () => {
  it.each([
    [0, true], [12.5, true], [MAX_SHADOW_ACCURACY_METERS, true],
    [undefined, false], [null, false], [-1, false], [NaN, false], [Infinity, false],
    [MAX_SHADOW_ACCURACY_METERS + 0.01, false],
  ])('validates accuracy %s strictly for the shadow path', (value, accepted) => {
    expect(validateShadowAccuracy(value).ok).toBe(accepted);
  });

  it('requires every pre-source eligibility condition independently', () => {
    const mutations = [
      ['mode', 'off', 'mode_off'],
      ['operatorAuthorized', false, 'sample_not_authorized'],
      ['accuracyMeters', undefined, 'accuracy_missing'],
      ['accuracyMeters', -1, 'accuracy_invalid'],
      ['productionPath', 'sweepnyc', 'production_path_ineligible'],
      ['dotEvidence', { ...eligible.dotEvidence, complete: false }, 'dot_evidence_incomplete'],
      ['dotEvidence', { ...eligible.dotEvidence, selectedRows: [] }, 'dot_order_count_invalid'],
      ['dotEvidence', { ...eligible.dotEvidence, selectedRows: [{ order_number: 'A' }, { order_number: 'B' }] }, 'dot_order_count_invalid'],
      ['legacyEvidence', null, 'legacy_evidence_missing'],
      ['legacyEvidence', { segment: {}, activeRules: [] }, 'legacy_evidence_malformed'],
      ['dotEvidence', { ...eligible.dotEvidence, selectedRows: [{ ...eligible.dotEvidence.selectedRows[0], sign_code: '' }] }, 'dot_evidence_malformed'],
    ];

    expect(evaluatePreSourceEligibility(eligible)).toEqual({ eligible: true });
    for (const [field, value, reason] of mutations) {
      expect(evaluatePreSourceEligibility({ ...eligible, [field]: value })).toEqual({ eligible: false, reason });
    }
  });

  it('makes positive sampling deterministic from a non-persisted segment basis', () => {
    const first = deterministicSampleSelected('nyc-od:public-segment', 321);
    expect(deterministicSampleSelected('nyc-od:public-segment', 321)).toBe(first);
    expect(deterministicSampleSelected('nyc-od:public-segment', 0)).toBe(false);
    expect(deterministicSampleSelected('nyc-od:public-segment', 1000)).toBe(true);
    expect(deterministicSampleSelected('', 1000)).toBe(false);
  });

  it('does not allow a client-shaped operator flag to authorize sample zero', () => {
    expect(evaluatePreSourceEligibility({
      ...eligible,
      operatorAuthorized: false,
      requestData: { operator: true, operatorAuthorized: true },
    })).toEqual({ eligible: false, reason: 'sample_not_authorized' });
  });

  it('authorizes the product path without sampling or operator flags', () => {
    expect(evaluateProductPathEligibility({
      ...eligible,
      productPath: 'on',
      samplePermille: 100,
      operatorAuthorized: false,
      sampleSelected: false,
      requestData: { operator: true, curbProduct: true },
    })).toEqual({ eligible: true });
    expect(evaluateProductPathEligibility({ ...eligible, productPath: 'off' }))
      .toEqual({ eligible: false, reason: 'product_path_off' });
    expect(evaluateProductPathEligibility({
      ...eligible, productPath: 'on', productionPath: 'sweepnyc',
    })).toEqual({ eligible: true });
    expect(evaluateProductPathEligibility({
      ...eligible,
      productPath: 'on',
      productionPath: 'sweepnyc',
      legacyEvidence: {
        segment: {
          source: 'sweepnyc', provenance: { provider: 'sweepnyc' }, status: 'active',
          confidenceScore: 0.95, confidence: { level: 'community' },
        },
        activeRules: [{
          type: 'streetCleaning', source: 'sweepnyc', status: 'active',
          schedules: [
            { side: 'East', days: ['Tue'], startTime: '08:30', endTime: '10:00' },
            { side: 'West', days: ['Wed'], startTime: '08:30', endTime: '10:00' },
          ],
        }],
      },
    })).toEqual({ eligible: true });
    expect(evaluatePreSourceEligibility({
      ...eligible, productionPath: 'sweepnyc',
    })).toEqual({ eligible: false, reason: 'production_path_ineligible' });
  });
});
