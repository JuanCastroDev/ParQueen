import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { normalizeCsclRow } = require('./csclNormalizer');
const { resolveOfficialCurb } = require('./curbResolver');
const { NYC_RESOLVER_FIXTURES, CSCL_FIXTURE_VERSION } = require('./fixtures/nycResolverFixtures');

describe('nine public NYC resolver fixtures', () => {
  it('contains only reviewed public coordinates and compact official CSCL evidence', () => {
    expect(NYC_RESOLVER_FIXTURES).toHaveLength(9);
    for (const fixture of NYC_RESOLVER_FIXTURES) {
      expect(fixture.provenance).toBe('NYC Open Data CSCL inkn-q76z');
      expect(fixture.point.source).toBe('public_research_coordinate');
      expect(fixture.rows.length).toBeGreaterThan(0);
      expect(fixture.rows.length).toBeLessThanOrEqual(3);
      expect(fixture).not.toHaveProperty('userId');
      expect(fixture).not.toHaveProperty('address');
    }
  });

  it('normalizes every retained official row and resolves with explicit evidence-derived state', async () => {
    for (const fixture of NYC_RESOLVER_FIXTURES) {
      const records = fixture.rows.map(row => {
        const normalized = normalizeCsclRow(row, CSCL_FIXTURE_VERSION);
        expect(normalized.ok, fixture.id).toBe(true);
        return normalized.record;
      });
      const result = await resolveOfficialCurb({
        lat: fixture.point.latitude,
        lng: fixture.point.longitude,
        accuracyMeters: fixture.accuracyMeters,
      }, {
        modelErrorMeters: 2,
        candidateStore: { async queryCandidates() { return { candidates: records, completeness: { state: 'COMPLETE', reason: null } }; } },
      });
      expect({ state: result.state, face: result.officialIdentity?.officialBlockFaceId || null, reasons: result.reasons }, fixture.id)
        .toEqual(fixture.expected);
    }
  });

  it('documents changed Phase 0.5 expectations instead of forcing them', () => {
    const changed = NYC_RESOLVER_FIXTURES.filter(fixture => fixture.previousExpectedState !== fixture.expected.state);
    expect(changed.map(fixture => fixture.id)).toEqual(['chatham_doyers_mott_west']);
    expect(changed[0].expectationNote).toContain('overlapping official roadway intervals');
  });
});
