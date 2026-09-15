import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { normalizeDotSignRow } = require('./dotSignNormalizer');
const { createFaceAssociationContext } = require('./dotFaceAssociation');
const { associateCleaningRules } = require('./cleaningRuleAssociation');
const { normalizeParkNycRow } = require('./parkNycNormalizer');
const { associateParkNycRules } = require('./parkNycAssociation');
const { DOT_VERSION, PARK_NYC_VERSION, NYC_RULE_FIXTURES } = require('./fixtures/nycRuleFixtures');
const { NYC_RESOLVER_FIXTURES } = require('./fixtures/nycResolverFixtures');

describe('nine public NYC Phase 1B.2 fixtures', () => {
  it('contains exactly the approved small, deeply frozen public cases', () => {
    expect(NYC_RULE_FIXTURES.map(fixture => fixture.id)).toEqual([
      'chatham_doyers_mott_west', 'gold_beekman_ann_west', 'st_james_chatham_madison_west',
      'east_170_walton_grand_concourse_south', 'pierrepont_clinton_cadman_north',
      'prince_roosevelt_40_road_east', 'bay_victory_hannah_west',
      'william_cedar_liberty_east', 'queens_33_ditmars_23_ave_west',
    ]);
    expect(Object.isFrozen(NYC_RULE_FIXTURES)).toBe(true);
    for (const fixture of NYC_RULE_FIXTURES) {
      expect(Object.isFrozen(fixture)).toBe(true);
      expect(fixture.dotRows.length).toBeLessThanOrEqual(1);
      expect(fixture.parkRows.length).toBeLessThanOrEqual(2);
      expect(JSON.stringify(fixture).toLowerCase()).not.toContain('userid');
      expect(fixture).not.toHaveProperty('address');
    }
  });

  it('normalizes official excerpts and preserves independent expected outcomes', () => {
    for (const fixture of NYC_RULE_FIXTURES) {
      const curbFixture = NYC_RESOLVER_FIXTURES.find(item => item.id === fixture.id);
      expect(curbFixture, `${fixture.id}: Phase 1B.1 curb evidence`).toBeDefined();
      const dotCandidates = fixture.dotRows.map(row => {
        const result = normalizeDotSignRow(row, DOT_VERSION);
        expect(result.ok, `${fixture.id}: DOT normalize`).toBe(true);
        return result.record;
      });
      const context = createFaceAssociationContext({
        curbIdentityState: fixture.curbState, borough: fixture.borough,
        streetNames: fixture.streetNames, fromNames: [fixture.bounds[0]], toNames: [fixture.bounds[1]], side: fixture.side,
        officialRelationship: {
          providerId: 'deterministic-public-fixture-context', version: '2026-09-15',
          orderApplicability: Object.fromEntries(dotCandidates.map(candidate => [candidate.orderNumber, fixture.dotApplicability])),
        },
      });
      const cleaning = associateCleaningRules({
        curbIdentity: { state: fixture.curbState }, faceContext: context,
        candidateSnapshot: { candidates: dotCandidates, completeness: { state: 'COMPLETE', reason: null }, sourceVersion: DOT_VERSION },
      });
      const parkCandidates = fixture.parkRows.map(row => {
        const result = normalizeParkNycRow(row, PARK_NYC_VERSION);
        expect(result.ok, `${fixture.id}: ParkNYC normalize`).toBe(true);
        return result.record;
      });
      const meter = associateParkNycRules({
        curbIdentity: { state: fixture.curbState, officialIdentity: { officialBlockFaceId: curbFixture.expected.face } },
        resolvedPoint: fixture.point, officialNames: fixture.streetNames, officialBounds: fixture.bounds,
        borough: fixture.borough, side: fixture.side,
        officialRoadwayEvidence: {
          officialBlockFaceId: curbFixture.expected.face,
          selectedGeometry: curbFixture.rows[0].the_geom,
          streetWidthFeet: Number(curbFixture.rows[0].streetwidth),
          modelUncertaintyMeters: 3,
          candidateCoverageComplete: fixture.officialRoadwayGeometryComplete !== false,
          competingRoadways: curbFixture.rows.slice(1).map(row => row.the_geom),
        },
        candidateSnapshot: { candidates: parkCandidates, completeness: { state: 'COMPLETE', reason: null }, sourceVersion: PARK_NYC_VERSION },
      });
      expect(
        { cleaning: cleaning.confidence, meter: meter.state },
        `${fixture.id}: ${meter.reasonCodes.join(',')}`,
      ).toEqual(fixture.expected);
      if (fixture.id === 'queens_33_ditmars_23_ave_west') {
        expect(meter.reasonCodes).toContain('official_meter_geometry_incompatible');
        expect(meter.reasonCodes).toContain('curb_identity_unknown');
        expect(meter.rules.map(rule => rule.zoneId)).toEqual(['425652', '469229']);
      }
      if (fixture.id === 'st_james_chatham_madison_west') {
        expect(meter.reasonCodes).toContain('official_meter_geometry_unverified');
      }
    }
  });

  it('documents current-source changes instead of forcing Phase 0 assumptions', () => {
    const noted = NYC_RULE_FIXTURES.filter(fixture => fixture.currentSourceNote);
    expect(noted.map(fixture => fixture.id)).toEqual([
      'st_james_chatham_madison_west', 'east_170_walton_grand_concourse_south',
      'bay_victory_hannah_west', 'william_cedar_liberty_east',
      'queens_33_ditmars_23_ave_west',
    ]);
  });
});
