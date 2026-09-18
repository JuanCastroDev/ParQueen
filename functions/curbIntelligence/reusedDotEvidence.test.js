'use strict';

const { createReusedDotCandidateSource } = require('./reusedDotEvidence');

const version = Object.freeze({
  resourceId: 'nfid-uabd',
  rowsUpdatedAt: '2026-01-01T00:00:00.000Z',
  viewLastModified: '2026-01-02T00:00:00.000Z',
});

const row = Object.freeze({
  order_number: 'P-100', record_type: 'Current', order_type: 'P-', borough: 'MANHATTAN',
  on_street: 'GOLD STREET', from_street: 'BEEKMAN STREET', to_street: 'ANN STREET',
  side_of_street: 'E', sign_code: 'PS-1',
  sign_description: 'NO PARKING TUESDAY 8:30AM-10AM STREET CLEANING',
});

describe('reused selected DOT evidence boundary', () => {
  it('normalizes already-fetched selected rows without performing any DOT network call', async () => {
    const network = vi.fn();
    const source = createReusedDotCandidateSource({ selectedRows: [row], sourceVersion: version, complete: true }, { network });

    const snapshot = await source.query();

    expect(network).not.toHaveBeenCalled();
    expect(snapshot.completeness).toEqual({ state: 'COMPLETE', reason: null });
    expect(snapshot.candidates).toEqual([expect.objectContaining({ orderNumber: 'P-100', side: 'E' })]);
  });

  it.each([
    ['zero orders', [], 'dot_order_count_invalid'],
    ['multiple orders', [row, { ...row, order_number: 'P-200' }], 'dot_order_count_invalid'],
    ['incomplete evidence', [row], 'dot_evidence_incomplete', false],
    ['malformed evidence', [{ ...row, sign_code: '' }], 'dot_evidence_malformed'],
  ])('fails closed for %s', async (_label, selectedRows, reason, complete = true) => {
    const snapshot = await createReusedDotCandidateSource({ selectedRows, sourceVersion: version, complete }).query();
    expect(snapshot).toEqual(expect.objectContaining({
      candidates: [],
      completeness: { state: 'INCOMPLETE', reason },
    }));
  });
});
