import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { normalizeCsclRow } = require('./csclNormalizer');
const { createMemoryCandidateStore } = require('./candidateStore');
const { normalizeDotSignRow } = require('./dotSignNormalizer');
const { normalizeParkNycRow } = require('./parkNycNormalizer');
const { classifyStreetCleaningSign } = require('./cleaningClassifier');
const { createOfficialDotRelationshipProvider } = require('./officialDotRelationshipProvider');
const { runCurbIntelligenceShadow } = require('./shadowExecution');
const { CSCL_FIXTURE_VERSION, NYC_RESOLVER_FIXTURES } = require('./fixtures/nycResolverFixtures');
const { DOT_VERSION, PARK_NYC_VERSION, NYC_RULE_FIXTURES } = require('./fixtures/nycRuleFixtures');

const sideName = Object.freeze({ N: 'North', S: 'South', E: 'East', W: 'West' });

function legacyFor(fixture, dotCandidates) {
  const schedules = dotCandidates.map(candidate => classifyStreetCleaningSign(candidate.sourceNative, {
    street: candidate.onStreet, fromCross: candidate.fromStreet,
    toCross: candidate.toStreet, side: sideName[fixture.side],
  })).filter(result => result.classified).map(result => result.schedule);
  return {
    segment: {
      status: fixture.curbState === 'SUPPORTED' ? 'active' : 'needs_review',
      needsReview: fixture.curbState !== 'SUPPORTED',
      source: 'nyc_open_data', confidenceScore: fixture.curbState === 'SUPPORTED' ? 0.9 : 0.5,
      provenance: { provider: 'nyc_open_data' },
      confidence: { level: fixture.curbState === 'SUPPORTED' ? 'community' : 'unverified' },
      blockFaceEvidence: { blockDecisive: true, sideResolved: true, parseComplete: true },
    },
    activeRules: schedules.length ? [{
      type: 'streetCleaning', source: 'nyc_open_data', supersededAt: null, schedules,
    }] : [],
  };
}

describe('nine public NYC Phase 2A end-to-end shadow replays', () => {
  it('preserves every reviewed curb, cleaning, and meter state through orchestration', async () => {
    const outcomes = {};
    for (const fixture of NYC_RULE_FIXTURES) {
      const resolverFixture = NYC_RESOLVER_FIXTURES.find(value => value.id === fixture.id);
      const csclRecords = resolverFixture.rows.map(row => normalizeCsclRow(row, CSCL_FIXTURE_VERSION).record);
      const dotCandidates = fixture.dotRows.map(row => normalizeDotSignRow(row, DOT_VERSION).record);
      const parkCandidates = fixture.parkRows.map(row => normalizeParkNycRow(row, PARK_NYC_VERSION).record);
      const officialRelationshipProvider = createOfficialDotRelationshipProvider({
        providerId: 'deterministic-public-fixture-function-3c',
        blockfaceResolver: {
          async resolve({ onStreet, crossStreetOne, crossStreetTwo }) {
            return {
              ok: true,
              officialBlockFaceId: resolverFixture.expected.face,
              normalizedStreetNames: { onStreet, crossStreetOne, crossStreetTwo },
              returnCode: '00', reasonCode: null,
              sourceVersion: { release: 'fixture-26c' },
            };
          },
        },
      });
      const delta = 0.02;
      const result = await runCurbIntelligenceShadow({
        location: {
          lat: resolverFixture.point.latitude,
          lng: resolverFixture.point.longitude,
          accuracyMeters: resolverFixture.accuracyMeters,
        },
        legacyEvidence: legacyFor(fixture, dotCandidates),
        dependencies: {
          engineVersion: 'phase2a-fixture-v1',
          curbCandidateStore: createMemoryCandidateStore(csclRecords, {
            coverageEnvelope: {
              minLat: resolverFixture.point.latitude - delta,
              maxLat: resolverFixture.point.latitude + delta,
              minLng: resolverFixture.point.longitude - delta,
              maxLng: resolverFixture.point.longitude + delta,
            },
          }),
          dotSource: { async query() {
            return { candidates: dotCandidates, completeness: { state: 'COMPLETE', reason: null }, sourceVersion: DOT_VERSION };
          } },
          parkNycSource: { async query() {
            return {
              candidateSnapshot: { candidates: parkCandidates, completeness: { state: 'COMPLETE', reason: null }, sourceVersion: PARK_NYC_VERSION },
              associationContext: {
                officialNames: fixture.streetNames, officialBounds: fixture.bounds,
                borough: fixture.borough, side: fixture.side,
                officialRoadwayGeometryComplete: fixture.officialRoadwayGeometryComplete !== false,
              },
            };
          } },
          officialRelationshipProvider,
        },
      });
      outcomes[fixture.id] = result.runtimeResult.states;
      expect(result.runtimeResult.states, fixture.id).toEqual({
        curb: resolverFixture.expected.state,
        cleaning: fixture.expected.cleaning,
        meter: fixture.expected.meter,
      });
      expect(result.persistableComparison, fixture.id).not.toBeNull();
    }

    expect(outcomes.gold_beekman_ann_west).toEqual({ curb: 'SUPPORTED', cleaning: 'SUPPORTED', meter: 'SUPPORTED' });
    expect(outcomes.prince_roosevelt_40_road_east).toEqual({ curb: 'SUPPORTED', cleaning: 'SUPPORTED', meter: 'SUPPORTED' });
    expect(outcomes.chatham_doyers_mott_west).toEqual({ curb: 'UNKNOWN', cleaning: 'UNKNOWN', meter: 'UNKNOWN' });
    expect(outcomes.william_cedar_liberty_east.meter).toBe('UNKNOWN');
    expect(outcomes.queens_33_ditmars_23_ave_west.meter).toBe('UNKNOWN');
  });
});
