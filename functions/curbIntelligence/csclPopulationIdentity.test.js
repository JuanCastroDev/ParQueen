'use strict';

const { buildCanonicalCsclPopulation, NATIVE_IDENTITY_FIELDS } = require('./csclPopulationIdentity');

const candidate = (globalId, overrides = {}) => ({
  globalId,
  sourceVersion: { resourceId: 'inkn-q76z', version: '1:2' },
  geometry: { type: 'MultiLineString', coordinates: [[[-73.98, 40.75], [-73.97, 40.76]]] },
  leftBlockFaceId: '0000000001', rightBlockFaceId: '0000000002',
  sourceNative: Object.fromEntries(NATIVE_IDENTITY_FIELDS.map(field => [field, null])),
  ...overrides,
});

describe('canonical CSCL population identity', () => {
  it('locks the topology/output semantic field set to contract version 1', () => {
    expect(NATIVE_IDENTITY_FIELDS).toEqual([
      'physicalid', 'b5sc', 'rw_type', 'boroughcode',
      'full_street_name', 'street_name', 'stname_label',
      'from_street', 'to_street', 'streetwidth', 'from_level_code', 'to_level_code',
      'accessible', 'nonped', 'status',
    ]);
  });
  it('sorts, hashes, and recursively freezes the exact versioned representation', () => {
    const result = buildCanonicalCsclPopulation([candidate('b'), candidate('a')]);
    expect(result).toMatchObject({ ok: true, schema: 'canonical-cscl-population-1' });
    expect(result.candidates.map(value => value.globalId)).toEqual(['a', 'b']);
    expect(result.populationIdentity).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result.candidates)).toBe(true);
    expect(Object.isFrozen(result.candidates[0].geometry.coordinates[0][0])).toBe(true);
  });

  it('is stable for excluded fields and sensitive to included topology fields', () => {
    const base = candidate('a', { ignoredRawField: 'one' });
    const ignored = candidate('a', { ignoredRawField: 'two' });
    ignored.sourceNative.trafdir = 'W';
    ignored.sourceNative.nominaldir = 'N';
    ignored.sourceVersion = { resourceId: 'inkn-q76z', version: '9:9' };
    const changed = candidate('a', { leftBlockFaceId: '0000000003' });
    expect(buildCanonicalCsclPopulation([base]).populationIdentity)
      .toBe(buildCanonicalCsclPopulation([ignored]).populationIdentity);
    expect(buildCanonicalCsclPopulation([base]).populationIdentity)
      .not.toBe(buildCanonicalCsclPopulation([changed]).populationIdentity);
  });

  it('rejects malformed candidates and all duplicate global IDs', () => {
    expect(buildCanonicalCsclPopulation([candidate('a'), candidate('a')]))
      .toEqual({ ok: false, reason: 'duplicate_candidate_identity' });
    expect(buildCanonicalCsclPopulation([{ globalId: 'a' }])).toEqual({ ok: false, reason: 'population_invalid' });
  });
});
