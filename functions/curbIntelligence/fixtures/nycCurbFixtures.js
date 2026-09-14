'use strict';

const CSCL_SOURCE_VERSION = Object.freeze({
  mapAssetId: '3mf9-qshr',
  resourceId: 'inkn-q76z',
  version: 'phase-0.5-audit-snapshot-2026-09-14',
});

const deepFreeze = value => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
};

const sign = (signCode, signDescription, street, fromCross, toCross, side) => ({
  row: {
    sign_code: signCode,
    sign_description: signDescription,
    record_type: 'Current',
  },
  streetContext: { street, fromCross, toCross, side },
});

const cscl = (physicalid, left, right, fullStreetName, selectedSide, boroughcode) => ({
  selectedSide,
  sourceVersion: CSCL_SOURCE_VERSION,
  row: {
    physicalid,
    l_blockfaceid: left,
    r_blockfaceid: right,
    boroughcode,
    full_street_name: fullStreetName,
    street_name: fullStreetName.replace(/\s+(STREET|PLACE|ROAD)$/i, ''),
    stname_label: fullStreetName,
  },
});

const NYC_CURB_FIXTURES = deepFreeze([
  {
    id: 'chatham_doyers_mott_west',
    source: 'public_nyc_open_data',
    point: { latitude: 40.7138156, longitude: -73.9981215, source: 'public_research_coordinate' },
    dotStreet: 'CHATHAM SQUARE',
    cscl: cscl('182263', '212261085', '212260522', 'CHATHAM SQUARE', 'LEFT', '1'),
    dotCleaningSign: sign('PS-20B', 'NO PARKING (SANITATION BROOM SYMBOL) 7AM-7:30AM EXCEPT SUNDAY <->', 'CHATHAM SQUARE', 'DOYERS STREET', 'MOTT STREET', 'West'),
    parkNyc: { zoneIds: ['100014'] },
    expected: { officialBlockFaceId: '0212261085', resolutionState: 'CAUTION', reasonCodes: ['side_uncertainty'], cleaningDurationMinutes: 30, cleaningOutcome: 'classified' },
    exercises: ['leading_zero_block_face', 'except_sunday_schedule', 'side_caution'],
  },
  {
    id: 'gold_beekman_ann_west',
    source: 'public_nyc_open_data',
    point: { latitude: 40.709579, longitude: -74.0050487, source: 'public_research_coordinate' },
    dotStreet: 'GOLD STREET',
    cscl: cscl('189761', '212261301', '212260958', 'GOLD STREET', 'LEFT', '1'),
    dotCleaningSign: sign('PS-246B', 'NO PARKING (SANITATION BROOM SYMBOL) MONDAY TUESDAY THURSDAY FRIDAY 6:30AM-7:30AM <->', 'GOLD STREET', 'BEEKMAN STREET', 'ANN STREET', 'West'),
    parkNyc: { zoneIds: ['100124'] },
    expected: { officialBlockFaceId: '0212261301', resolutionState: 'SUPPORTED', reasonCodes: [], cleaningDurationMinutes: 60, cleaningOutcome: 'classified' },
    exercises: ['supported_identity', 'discrete_day_list', 'sixty_minute_schedule'],
  },
  {
    id: 'st_james_chatham_madison_west',
    source: 'public_nyc_open_data',
    point: { latitude: 40.712539, longitude: -73.9990416, source: 'public_research_coordinate' },
    dotStreet: 'ST JAMES PLACE',
    cscl: cscl('79867', '212261642', '212261462', 'ST JAMES PLACE', 'LEFT', '1'),
    dotCleaningSign: sign('PS-18B', 'NO PARKING (SANITATION BROOM SYMBOL) MONDAY THURSDAY 11AM-12:30PM <->', 'ST JAMES PLACE', 'CHATHAM SQUARE', 'MADISON STREET', 'West'),
    parkNyc: { zoneIds: ['100279'] },
    expected: { officialBlockFaceId: '0212261642', resolutionState: 'CAUTION', reasonCodes: ['side_uncertainty'], cleaningDurationMinutes: 90, cleaningOutcome: 'classified' },
    exercises: ['source_native_street_name', 'ninety_minute_schedule', 'side_caution'],
  },
  {
    id: 'east_170_walton_grand_concourse_south',
    source: 'public_nyc_open_data',
    point: { latitude: 40.839063, longitude: -73.9150273, source: 'public_research_coordinate' },
    dotStreet: 'EAST 170 STREET',
    cscl: cscl('61170', '1422600885', '1422606254', 'EAST  170 STREET', 'RIGHT', '2'),
    dotCleaningSign: sign('PS-22B', 'NO PARKING (SANITATION BROOM SYMBOL) 8AM-8:30AM EXCEPT SUNDAY <->', 'EAST 170 STREET', 'WALTON AVENUE', 'GRAND CONCOURSE', 'South'),
    parkNyc: { zoneIds: ['200012'] },
    expected: { officialBlockFaceId: '1422606254', resolutionState: 'CAUTION', reasonCodes: ['side_uncertainty'], cleaningDurationMinutes: 30, cleaningOutcome: 'classified' },
    exercises: ['source_whitespace_preservation', 'right_side_identity', 'except_sunday_schedule'],
  },
  {
    id: 'pierrepont_clinton_cadman_north',
    source: 'public_nyc_open_data',
    point: { latitude: 40.6947981, longitude: -73.9914137, source: 'public_research_coordinate' },
    dotStreet: 'PIERREPONT STREET',
    cscl: cscl('98247', '212261098', '212261846', 'PIERREPONT STREET', 'LEFT', '3'),
    dotCleaningSign: sign('PS-22B', 'NO PARKING (SANITATION BROOM SYMBOL) 8AM-8:30AM EXCEPT SUNDAY <->', 'PIERREPONT STREET', 'CLINTON STREET', 'CADMAN PLAZA WEST', 'North'),
    parkNyc: { zoneIds: ['300008'] },
    expected: { officialBlockFaceId: '0212261098', resolutionState: 'CAUTION', reasonCodes: ['side_uncertainty'], cleaningDurationMinutes: 30, cleaningOutcome: 'classified' },
    exercises: ['brooklyn_identity', 'except_sunday_schedule', 'side_caution'],
  },
  {
    id: 'prince_roosevelt_40_road_east',
    source: 'public_nyc_open_data',
    point: { latitude: 40.7586708, longitude: -73.8316506, source: 'public_research_coordinate' },
    dotStreet: 'PRINCE STREET',
    cscl: cscl('83901', '112269669', '112269670', 'PRINCE STREET', 'LEFT', '4'),
    dotCleaningSign: sign('PS-20B', 'NO PARKING (SANITATION BROOM SYMBOL) 7AM-7:30AM EXCEPT SUNDAY <->', 'PRINCE STREET', 'ROOSEVELT AVENUE', '40 ROAD', 'East'),
    parkNyc: { zoneIds: ['400356'] },
    expected: { officialBlockFaceId: '0112269669', resolutionState: 'SUPPORTED', reasonCodes: [], cleaningDurationMinutes: 30, cleaningOutcome: 'classified' },
    exercises: ['queens_supported_identity', 'leading_zero_block_face', 'except_sunday_schedule'],
  },
  {
    id: 'bay_victory_hannah_west',
    source: 'public_nyc_open_data',
    point: { latitude: 40.636825, longitude: -74.07649, source: 'public_research_coordinate' },
    dotStreet: 'BAY STREET',
    cscl: cscl('169054', '1622602933', '1622609911', 'BAY STREET', 'RIGHT', '5'),
    dotCleaningSign: sign('PS-161B', 'NO PARKING (SANITATION BROOM SYMBOL) MONDAY MIDNIGHT-3AM <->', 'BAY STREET', 'VICTORY BOULEVARD', 'HANNAH STREET', 'West'),
    parkNyc: { zoneIds: ['514472'] },
    expected: { officialBlockFaceId: '1622609911', resolutionState: 'CAUTION', reasonCodes: ['parknyc_face_match_unresolved'], cleaningDurationMinutes: 180, cleaningOutcome: 'classified' },
    exercises: ['parknyc_face_mismatch', 'midnight_schedule', 'fail_closed_join'],
  },
  {
    id: 'william_cedar_liberty_east',
    source: 'public_nyc_open_data',
    point: { latitude: 40.7075049, longitude: -74.0084142, source: 'public_research_coordinate' },
    dotStreet: 'WILLIAM STREET',
    cscl: cscl('820', '212261051', '212261080', 'WILLIAM STREET', 'RIGHT', '1'),
    dotCleaningSign: null,
    parkNyc: { zoneIds: ['100009'] },
    expected: { officialBlockFaceId: '0212261080', resolutionState: 'CAUTION', reasonCodes: ['no_reviewed_cleaning_sign'], cleaningDurationMinutes: null, cleaningOutcome: 'no_reviewed_cleaning_sign' },
    exercises: ['meter_without_cleaning', 'no_invented_schedule', 'right_side_identity'],
  },
  {
    id: 'queens_33_ditmars_23_ave_west',
    source: 'public_nyc_open_data',
    point: { latitude: 40.7751774, longitude: -73.9104295, source: 'public_research_coordinate' },
    dotStreet: '33 STREET',
    cscl: cscl('82117', '102266850', '102267042', '33 STREET', 'RIGHT', '4'),
    dotCleaningSign: sign('PS-30B', 'NO PARKING (SANITATION BROOM SYMBOL) THURSDAY 8:30AM-10AM <->', '33 STREET', 'DITMARS BOULEVARD', '23 AVENUE', 'West'),
    parkNyc: { zoneIds: ['469229', '469230', '469246'] },
    expected: { officialBlockFaceId: '0102267042', resolutionState: 'UNKNOWN', reasonCodes: ['multiple_meter_zones', 'ambiguous_geometry'], cleaningDurationMinutes: 90, cleaningOutcome: 'classified' },
    exercises: ['multiple_meter_zones', 'ambiguous_geometry', 'unknown_resolution'],
  },
]);

module.exports = { CSCL_SOURCE_VERSION, NYC_CURB_FIXTURES };
