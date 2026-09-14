import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createOfficialCurbIdentity } = require('./curbIdentity');
const { classifyStreetCleaningSign } = require('./cleaningClassifier');
const { NYC_CURB_FIXTURES } = require('./fixtures/nycCurbFixtures');

const EXPECTED = {
  chatham_doyers_mott_west: [30, 'CAUTION'],
  gold_beekman_ann_west: [60, 'SUPPORTED'],
  st_james_chatham_madison_west: [90, 'CAUTION'],
  east_170_walton_grand_concourse_south: [30, 'CAUTION'],
  pierrepont_clinton_cadman_north: [30, 'CAUTION'],
  prince_roosevelt_40_road_east: [30, 'SUPPORTED'],
  bay_victory_hannah_west: [180, 'CAUTION'],
  william_cedar_liberty_east: [null, 'CAUTION'],
  queens_33_ditmars_23_ave_west: [90, 'UNKNOWN'],
};

const FORBIDDEN_PRIVATE_KEYS = /^(userId|uid|email|deviceId|token|rawUserLocation|homeAddress)$/i;

function visit(value, path = []) {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(FORBIDDEN_PRIVATE_KEYS.test(key) ? [[...path, key].join('.')] : []),
    ...visit(child, [...path, key]),
  ]);
}

describe('public NYC curb fixture matrix', () => {
  it('contains only the nine reviewed public cases with explicit provenance and purpose', () => {
    expect(NYC_CURB_FIXTURES).toHaveLength(9);
    expect(Object.fromEntries(NYC_CURB_FIXTURES.map(fixture => [
      fixture.id,
      [fixture.expected.cleaningDurationMinutes, fixture.expected.resolutionState],
    ]))).toEqual(EXPECTED);

    for (const fixture of NYC_CURB_FIXTURES) {
      expect(fixture.source).toBe('public_nyc_open_data');
      expect(fixture.point.source).toBe('public_research_coordinate');
      expect(fixture.exercises.length).toBeGreaterThan(0);
      expect(visit(fixture)).toEqual([]);
      expect(Object.isFrozen(fixture)).toBe(true);
    }
  });

  it('reproduces the reviewed cleaning duration or explicit no-cleaning outcome', () => {
    for (const fixture of NYC_CURB_FIXTURES) {
      if (!fixture.dotCleaningSign) {
        expect(fixture.expected.cleaningDurationMinutes).toBeNull();
        expect(fixture.expected.cleaningOutcome).toBe('no_reviewed_cleaning_sign');
        continue;
      }
      const result = classifyStreetCleaningSign(fixture.dotCleaningSign.row, fixture.dotCleaningSign.streetContext);
      expect(result.classified, fixture.id).toBe(true);
      expect(result.schedule.durationMinutes, fixture.id)
        .toBe(fixture.expected.cleaningDurationMinutes);
    }
  });

  it('creates the reviewed official identity while keeping ambiguity explicit', () => {
    for (const fixture of NYC_CURB_FIXTURES) {
      const result = createOfficialCurbIdentity({
        csclRows: [fixture.cscl.row],
        csclSide: fixture.cscl.selectedSide,
        sourceVersion: fixture.cscl.sourceVersion,
        canonicalSearchName: fixture.dotStreet,
        resolutionEvidence: {
          state: fixture.expected.resolutionState,
          reasonCodes: fixture.expected.reasonCodes,
        },
      });
      expect(result.ok, fixture.id).toBe(true);
      expect(result.identity.officialBlockFaceId, fixture.id)
        .toBe(fixture.expected.officialBlockFaceId);
    }

    const bay = NYC_CURB_FIXTURES.find(fixture => fixture.id === 'bay_victory_hannah_west');
    expect(bay.expected.reasonCodes).toContain('parknyc_face_match_unresolved');
    const queens = NYC_CURB_FIXTURES.find(fixture => fixture.id === 'queens_33_ditmars_23_ave_west');
    expect(queens.parkNyc.zoneIds).toEqual(['469229', '469230', '469246']);
    expect(queens.expected.reasonCodes).toContain('multiple_meter_zones');
  });
});
