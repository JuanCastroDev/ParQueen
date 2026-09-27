import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const topology = (overrides = {}) => ({
  topologySchemaVersion: 1,
  bfi: '0000000001',
  csclSide: 'LEFT',
  onStreet: 'BROADWAY',
  onStreetB5sc: '113260',
  onStreetB7sc: '11326001',
  supportingSegments: ['1'],
  fromNode: 'A',
  toNode: 'B',
  fromStreet: 'SPRING ST',
  toStreet: 'BROOME ST',
  topologyState: 'complete',
  ...overrides,
});

const edge = (overrides = {}) => ({
  sourceId: '100',
  blockFaceId: '0000000001',
  conflated: true,
  status: 'Unchanged',
  sourceVersion: 'pavement-release',
  geometry: { type: 'MultiLineString', coordinates: [[[0, 0], [1, 0]]] },
  ...overrides,
});

describe('offline Pavement Edge reconciliation', () => {
  it('maps one conflated BFI to one complete roadway side and topology context', () => {
    const { reconcilePavementBfi } = require('./lib/reconcile');
    expect(reconcilePavementBfi(edge(), [topology()])).toEqual({
      ok: true,
      bfi: '0000000001',
      csclSide: 'LEFT',
      materialRoadway: { b5sc: '113260', displayName: 'BROADWAY' },
      topology: topology(),
    });
  });

  it.each([
    ['non_conflated', edge({ conflated: false }), [topology()]],
    ['invalid_bfi', edge({ blockFaceId: null }), [topology()]],
    ['bfi_not_found', edge({ blockFaceId: '0000000002' }), [topology()]],
    ['topology_incomplete', edge(), [topology({ topologyState: 'incomplete' })]],
    ['side_conflict', edge(), [topology({ csclSide: null })]],
    ['multiple_material_roadways', edge(), [topology(), topology({ onStreet: 'FIFTH AVE', onStreetB5sc: '125110' })]],
  ])('fails closed as %s', (reason, inputEdge, records) => {
    const { reconcilePavementBfi } = require('./lib/reconcile');
    expect(reconcilePavementBfi(inputEdge, records)).toEqual({ ok: false, reason });
  });
});

describe('segment-local B5SC/B7SC bridge assessment', () => {
  it('classifies complete direct B7SC coverage as YES', () => {
    const { assessB5scB7scCoverage } = require('./lib/reconcile');
    expect(assessB5scB7scCoverage([topology(), topology({ bfi: '0000000002', onStreetB7sc: '11326002' })])).toEqual({
      finding: 'YES',
      eligible: 2,
      withDirectB7sc: 2,
      coveragePercent: 100,
      aliasAuthorityEnabled: true,
    });
  });

  it('classifies incomplete direct coverage as PARTIAL and keeps alias authority disabled', () => {
    const { assessB5scB7scCoverage } = require('./lib/reconcile');
    expect(assessB5scB7scCoverage([topology(), topology({ bfi: '0000000002', onStreetB7sc: null })])).toEqual({
      finding: 'PARTIAL',
      eligible: 2,
      withDirectB7sc: 1,
      coveragePercent: 50,
      aliasAuthorityEnabled: false,
    });
  });

  it('never synthesizes a B7SC from B5SC when the segment-local value is absent', () => {
    const { assessB5scB7scCoverage } = require('./lib/reconcile');
    expect(assessB5scB7scCoverage([topology({ onStreetB7sc: null })])).toEqual({
      finding: 'NO',
      eligible: 1,
      withDirectB7sc: 0,
      coveragePercent: 0,
      aliasAuthorityEnabled: false,
    });
  });
});
