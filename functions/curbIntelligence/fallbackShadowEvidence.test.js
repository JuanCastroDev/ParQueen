'use strict';

const { createFallbackShadowEvidence } = require('./fallbackShadowEvidence');

const version = Object.freeze({
  resourceId: 'nfid-uabd', rowsUpdatedAt: '2026-01-02T00:00:00.000Z',
  viewLastModified: '2026-01-02T00:00:00.000Z',
});

describe('NYC Open Data fallback shadow capture', () => {
  it('reuses the selected rows and newly built segment/rule objects by reference', () => {
    const selectedRows = [{ order_number: 'P-100' }];
    const segment = { source: 'nyc_open_data' };
    const rule = { type: 'streetCleaning' };
    const evidence = createFallbackShadowEvidence({
      selectedRows,
      queryEvidence: { rows: selectedRows, complete: true, sourceVersion: version },
      segment,
      rule,
    });

    expect(evidence.productionPath).toBe('nyc_open_data_fallback');
    expect(evidence.dotEvidence.selectedRows).toBe(selectedRows);
    expect(evidence.legacyEvidence.segment).toBe(segment);
    expect(evidence.legacyEvidence.activeRules[0]).toBe(rule);
    expect(evidence.dotEvidence.complete).toBe(true);
  });

  it('fails closed when selected rows are not a subset of the completed query evidence', () => {
    const selectedRows = [{ order_number: 'P-100' }];
    const evidence = createFallbackShadowEvidence({
      selectedRows,
      queryEvidence: { rows: [{ order_number: 'P-200' }], complete: true, sourceVersion: version },
      segment: {},
      rule: {},
    });
    expect(evidence.dotEvidence).toEqual({ selectedRows, complete: false, sourceVersion: null });
  });

  it('does no network or Firestore work and returns no evidence for existing dedup results', () => {
    const network = vi.fn();
    const firestore = vi.fn();
    expect(createFallbackShadowEvidence({ existingDedup: true, network, firestore })).toBe(null);
    expect(network).not.toHaveBeenCalled();
    expect(firestore).not.toHaveBeenCalled();
  });
});
