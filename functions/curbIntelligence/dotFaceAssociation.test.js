import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { associateDotCandidates, createFaceAssociationContext } = require('./dotFaceAssociation');

const VERSION = { resourceId: 'nfid-uabd', rowsUpdatedAt: '2026-09-15T10:04:47Z', viewLastModified: '2026-09-15T10:00:16Z' };
const candidate = (overrides = {}) => ({
  orderNumber: 'P-01775228', recordType: 'Current', borough: 'MANHATTAN',
  onStreet: 'GOLD STREET', fromStreet: 'BEEKMAN STREET', toStreet: 'ANN STREET', side: 'W',
  signCode: 'PS-246B', signDescription: 'NO PARKING (SANITATION BROOM SYMBOL) MONDAY 6:30AM-7:30AM <->',
  arrowDirection: null, signLocation: null, distanceFromIntersection: 36,
  projectedSignCoordinate: { x: 982905, y: 197775, crs: null }, sourceVersion: VERSION,
  sourceNative: {}, ...overrides,
});
const context = (overrides = {}) => createFaceAssociationContext({
  curbIdentityState: 'SUPPORTED', borough: 'Manhattan', streetNames: ['Gold Street'],
  fromNames: ['Beekman Street'], toNames: ['Ann Street'], side: 'W',
  officialRelationship: {
    providerId: 'official-boundary-fixture', version: '2026-09-15',
    orderApplicability: { 'P-01775228': 'WHOLE_FACE' },
  },
  ...overrides,
});
const snapshot = (candidates, state = 'COMPLETE') => ({
  candidates, completeness: { state, reason: state === 'COMPLETE' ? null : 'source_query_truncated' },
  sourceVersion: VERSION,
});

describe('explicit DOT face association context', () => {
  it('accepts a uniquely mapped exact official street/bounds/side candidate', () => {
    const result = associateDotCandidates(context(), snapshot([candidate()]));
    expect(result).toMatchObject({ state: 'SUPPORTED', reasons: [], applicability: 'WHOLE_FACE' });
    expect(result.candidates).toHaveLength(1);
  });

  it('allows officially declared endpoint order and SND alias equivalence', () => {
    const result = associateDotCandidates(context({
      streetNames: ['GOLD ST'], fromNames: ['ANN ST'], toNames: ['BEEKMAN ST'],
    }), snapshot([candidate({ onStreet: 'GOLD ST', fromStreet: 'BEEKMAN ST', toStreet: 'ANN ST' })]));
    expect(result.state).toBe('SUPPORTED');
  });

  it('never promotes name plus side without official bounds and order relationship', () => {
    expect(associateDotCandidates(context({ fromNames: [], toNames: [] }), snapshot([candidate()])))
      .toMatchObject({ state: 'UNKNOWN', reasons: ['official_face_context_incomplete'] });
    expect(associateDotCandidates(createFaceAssociationContext({
      curbIdentityState: 'SUPPORTED', borough: 'Manhattan', streetNames: ['Gold Street'], side: 'W',
    }), snapshot([candidate()])))
      .toMatchObject({ state: 'UNKNOWN', reasons: ['official_face_context_incomplete'] });
    expect(associateDotCandidates(context({ officialRelationship: { providerId: '', version: '', orderApplicability: [] } }), snapshot([candidate()])))
      .toMatchObject({ state: 'UNKNOWN', reasons: ['official_face_context_incomplete'] });
  });

  it.each([
    [candidate({ borough: 'BROOKLYN' }), 'borough_mismatch'],
    [candidate({ side: 'E' }), 'side_mismatch'],
    [candidate({ fromStreet: 'FULTON STREET', toStreet: 'FRANKFORT STREET' }), 'bounds_mismatch'],
    [candidate({ onStreet: 'PEARL STREET' }), 'street_identity_mismatch'],
  ])('rejects candidate mismatch %#', (row, reason) => {
    expect(associateDotCandidates(context(), snapshot([row])))
      .toMatchObject({ state: 'UNKNOWN', reasons: [reason] });
  });

  it('fails closed for incomplete retrieval and source-version disagreement', () => {
    expect(associateDotCandidates(context(), snapshot([candidate()], 'INCOMPLETE')))
      .toMatchObject({ state: 'UNKNOWN', reasons: ['candidate_source_incomplete'] });
    expect(associateDotCandidates(context(), { ...snapshot([candidate()]), sourceVersion: { ...VERSION, rowsUpdatedAt: '2026-09-16T10:04:47Z' } }))
      .toMatchObject({ state: 'UNKNOWN', reasons: ['source_version_mismatch'] });
  });

  it('requires the exact official DOT resource identity at association time', () => {
    const wrong = { ...snapshot([candidate()]), sourceVersion: { ...VERSION, resourceId: 'other' } };
    expect(associateDotCandidates(context(), wrong))
      .toMatchObject({ state: 'UNKNOWN', reasons: ['source_version_mismatch'] });
  });

  it('keeps explicitly mapped partial or unknown extent below whole-face support', () => {
    const partial = context({ officialRelationship: {
      providerId: 'official-boundary-fixture', version: '2026-09-15',
      orderApplicability: { 'P-01775228': 'PARTIAL_FACE' },
    } });
    expect(associateDotCandidates(partial, snapshot([candidate({ arrowDirection: 'North' })])))
      .toMatchObject({ state: 'CAUTION', applicability: 'PARTIAL_FACE', reasons: ['partial_face_detected'] });

    const unknown = context({ officialRelationship: {
      providerId: 'official-boundary-fixture', version: '2026-09-15',
      orderApplicability: { 'P-01775228': 'UNKNOWN' },
    } });
    expect(associateDotCandidates(unknown, snapshot([candidate({ signLocation: '25 FT FROM CORNER' })])))
      .toMatchObject({ state: 'UNKNOWN', applicability: 'UNKNOWN', reasons: ['face_applicability_unknown'] });
  });

  it('does not trust undocumented projected sign coordinates as geometry', () => {
    expect(associateDotCandidates(context({ officialRelationship: {
      providerId: 'official-boundary-fixture', version: '2026-09-15', orderApplicability: {},
    } }), snapshot([candidate()])))
      .toMatchObject({ state: 'UNKNOWN', reasons: ['official_order_relationship_missing'] });
  });
});
