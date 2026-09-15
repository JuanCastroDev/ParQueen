'use strict';

const CSCL_FIXTURE_VERSION = Object.freeze({
  resourceId: 'inkn-q76z',
  version: 'NYC Open Data snapshot observed 2026-09-14; dataset updated 2026-09-12',
});

const row = ({ coordinates, globalid, physicalid, left = null, right = null, boroughcode,
  b5sc, name, street, label, width, modified = '2017-03-17T10:03:52Z' }) => ({
  the_geom: { type: 'MultiLineString', coordinates },
  globalid,
  physicalid,
  l_blockfaceid: left,
  r_blockfaceid: right,
  boroughcode,
  b5sc,
  rw_type: '1',
  full_street_name: name,
  street_name: street,
  stname_label: label,
  trafdir: 'FT',
  nominaldir: null,
  streetwidth: width,
  from_level_code: '13',
  to_level_code: '13',
  accessible: null,
  nonped: null,
  status: '2',
  modified_date: modified,
  created_date: '2007-11-29T00:00:00Z',
});

const fixture = (id, latitude, longitude, accuracyMeters, expected, rows, extra = {}) => ({
  id,
  provenance: 'NYC Open Data CSCL inkn-q76z',
  point: { latitude, longitude, source: 'public_research_coordinate' },
  accuracyMeters,
  previousExpectedState: extra.previousExpectedState || expected.state,
  expectationNote: extra.expectationNote || null,
  expected,
  rows,
});

const NYC_RESOLVER_FIXTURES = Object.freeze([
  fixture('chatham_doyers_mott_west', 40.7138156, -73.9981215, 4,
    { state: 'UNKNOWN', face: '0212261085', reasons: ['competing_roadways_overlap'] }, [
      row({ coordinates: [[[-73.998486544342, 40.713565816068], [-73.998037271345, 40.713765075764]]], globalid: 'e5ef4b00-416c-4d73-981a-0f2f33981132', physicalid: '182263', left: '212261085', right: '212260522', boroughcode: '1', b5sc: '114930', name: 'CHATHAM SQ', street: 'CHATHAM', label: 'CHATHAM SQ', width: '42', modified: '2020-04-14T15:13:10Z' }),
      row({ coordinates: [[[-73.998037271345, 40.713765075764], [-73.998020914034, 40.713723480715], [-73.997995688542, 40.713686981009]]], globalid: 'c4248c97-b5b5-4ee4-973a-1bff26bc694a', physicalid: '140885', boroughcode: '1', b5sc: '119690', name: 'E  BROADWAY', street: 'BROADWAY', label: 'E BROADWAY', width: '50', modified: '2025-08-25T11:36:47Z' }),
    ], { previousExpectedState: 'CAUTION', expectationNote: 'The broad candidate set produces overlapping official roadway intervals at the Chatham/East Broadway junction, so Phase 1A correctly fails UNKNOWN.' }),
  fixture('gold_beekman_ann_west', 40.709579, -74.0050487, 2,
    { state: 'SUPPORTED', face: '0212261301', reasons: [] }, [
      row({ coordinates: [[[-74.005149032212, 40.709433763539], [-74.004989093816, 40.709550693088], [-74.004827381626, 40.709668919147]]], globalid: '0107c4a0-6639-443b-b56c-12a97c21dee0', physicalid: '189761', left: '212261301', right: '212260958', boroughcode: '1', b5sc: '121350', name: 'GOLD ST', street: 'GOLD', label: 'GOLD ST', width: '44', modified: '2024-05-10T11:31:21Z' }),
      row({ coordinates: [[[-74.004827381626, 40.709668919147], [-74.004254299483, 40.710174479461]]], globalid: '54328112-831a-4505-9f30-c6451ead8416', physicalid: '79729', left: '212260808', right: '212260958', boroughcode: '1', b5sc: '121350', name: 'GOLD ST', street: 'GOLD', label: 'GOLD ST', width: '54', modified: '2024-05-10T11:31:21Z' }),
    ]),
  fixture('st_james_chatham_madison_west', 40.712539, -73.9990416, 6,
    { state: 'CAUTION', face: '0212261642', reasons: ['side_uncertain'] }, [
      row({ coordinates: [[[-73.999702956811, 40.711788687481], [-73.998888485312, 40.71260680569]]], globalid: '8f9d0041-524d-4023-80ee-316a7f10cf47', physicalid: '79867', left: '212261642', right: '212261462', boroughcode: '1', b5sc: '130890', name: 'ST JAMES PL', street: 'ST JAMES', label: 'ST JAMES PL', width: '42', modified: '2019-04-15T15:18:28Z' }),
    ]),
  fixture('east_170_walton_grand_concourse_south', 40.839063, -73.9150273, 5,
    { state: 'CAUTION', face: '1422606254', reasons: ['side_uncertain'] }, [
      row({ coordinates: [[[-73.915089016451, 40.839233646799], [-73.915086762506, 40.839122902648], [-73.914022875628, 40.838720232791]]], globalid: '4f6321c5-7e3f-423a-914c-de02c8e3fa3a', physicalid: '61170', left: '1422600885', right: '1422606254', boroughcode: '2', b5sc: '226760', name: 'E  170 ST', street: '170', label: 'E 170 ST', width: '20', modified: '2017-10-13T18:21:16Z' }),
    ]),
  fixture('pierrepont_clinton_cadman_north', 40.6947981, -73.9914137, 8,
    { state: 'CAUTION', face: '0212261098', reasons: ['side_uncertain'] }, [
      row({ coordinates: [[[-73.992101117498, 40.694955608429], [-73.990725465388, 40.694575138575]]], globalid: '62f61ee5-7c81-413f-b4a0-081a01073d8a', physicalid: '98247', left: '212261098', right: '212261846', boroughcode: '3', b5sc: '370430', name: 'PIERREPONT ST', street: 'PIERREPONT', label: 'PIERREPONT ST', width: '26' }),
    ]),
  fixture('prince_roosevelt_40_road_east', 40.7586708, -73.8316506, 2,
    { state: 'SUPPORTED', face: '0112269669', reasons: [] }, [
      row({ coordinates: [[[-73.831911591221, 40.758957336168], [-73.831537137325, 40.758372261349]]], globalid: 'f04f632d-0323-4690-aaea-02298e00cb20', physicalid: '83901', left: '112269669', right: '112269670', boroughcode: '4', b5sc: '459590', name: 'PRINCE ST', street: 'PRINCE', label: 'PRINCE ST', width: '30', modified: '2017-06-19T09:57:29Z' }),
    ]),
  fixture('bay_victory_hannah_west', 40.636825, -74.07649, 6,
    { state: 'CAUTION', face: '1622609911', reasons: ['side_uncertain'] }, [
      row({ coordinates: [[[-74.076940427517, 40.637789837191], [-74.076867606382, 40.637702463284], [-74.076426209848, 40.636812607263], [-74.076292790111, 40.63676031537]]], globalid: '489ac72c-fad3-486e-bb75-ffe5992a69d0', physicalid: '169054', left: '1622602933', right: '1622609911', boroughcode: '5', b5sc: '517450', name: 'BAY ST', street: 'BAY', label: 'BAY ST', width: '22', modified: '2024-04-21T22:21:10Z' }),
    ]),
  fixture('william_cedar_liberty_east', 40.7075049, -74.0084142, 6,
    { state: 'CAUTION', face: '0212261080', reasons: ['side_uncertain'] }, [
      row({ coordinates: [[[-74.008646680377, 40.707348257866], [-74.008270257932, 40.707730174476]]], globalid: 'b62c4957-a09c-4be5-8dac-d63106ab456e', physicalid: '820', left: '212261051', right: '212261080', boroughcode: '1', b5sc: '145440', name: 'WILLIAM ST', street: 'WILLIAM', label: 'WILLIAM ST', width: '32', modified: '2019-01-03T13:55:58Z' }),
    ]),
  fixture('queens_33_ditmars_23_ave_west', 40.7751774, -73.9104295, 8,
    { state: 'UNKNOWN', face: '0102267042', reasons: ['implausible_geometry'] }, [
      row({ coordinates: [[[-73.909618032463, 40.775374478803], [-73.91157935171, 40.77376798976]]], globalid: '2d729ad5-fa24-49cc-a1d9-817eb2e2e53a', physicalid: '82117', left: '102266850', right: '102267042', boroughcode: '4', b5sc: '408390', name: '33 ST', street: '33', label: '33 ST', width: '36', modified: '2017-08-31T15:37:17Z' }),
      row({ coordinates: [[[-73.910262149096, 40.775838678312], [-73.909618032463, 40.775374478803]]], globalid: 'aea9e338-5141-4c67-9b19-eef955eb270a', physicalid: '23055', left: '102265330', right: '102262582', boroughcode: '4', b5sc: '442490', name: 'DITMARS BLVD', street: 'DITMARS', label: 'DITMARS BLVD', width: '40' }),
    ], { previousExpectedState: 'UNKNOWN', expectationNote: 'The official 33 Street centerline is too distant for its published width plus GPS/model uncertainty, so the resolver fails closed as implausible geometry; ParkNYC multi-zone association remains deferred to Phase 1B.2.' }),
]);

module.exports = { CSCL_FIXTURE_VERSION, NYC_RESOLVER_FIXTURES };
