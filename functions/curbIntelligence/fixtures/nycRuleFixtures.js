'use strict';

const DOT_VERSION = Object.freeze({
  resourceId: 'nfid-uabd',
  rowsUpdatedAt: '2026-09-15T10:04:47Z',
  viewLastModified: '2026-09-15T10:00:16Z',
});
const PARK_NYC_VERSION = Object.freeze({
  resourceId: 'e7yp-wx55',
  rowsUpdatedAt: '2026-09-01T10:21:51Z',
  viewLastModified: '2026-09-01T10:20:59Z',
});

function park({ zone, vehicle = 'All Vehicles', street, side, from, to, borough, first, last,
  duration = '2 Hours', schedule, rate, cap, rateZone, commercial = null }) {
  return {
    the_geom: { type: 'MultiLineString', coordinates: [[first, last]] },
    pay_by_cel: zone,
    vehicle_ty: vehicle,
    all_vehicl: vehicle === 'Commercial Only' ? 'N/A' : duration,
    all_vehi_1: vehicle === 'Commercial Only' ? 'N/A' : schedule,
    all_vehi_2: vehicle === 'Commercial Only' ? 'N/A' : rate,
    all_vehi_3: vehicle === 'Commercial Only' ? 'N/A' : cap,
    commercial: commercial?.duration || (vehicle === 'Commercial Only' ? '3 Hours' : 'N/A'),
    commerci_1: commercial?.schedule || (vehicle === 'Commercial Only' ? 'Monday-Friday 7 AM-7 PM' : 'N/A'),
    commerci_2: commercial?.rate || (vehicle === 'Commercial Only' ? '$7.00 1st Hour / $10.00 2nd Hour / $13.00 3rd Hour' : 'N/A'),
    commerci_3: commercial?.cap || (vehicle === 'Commercial Only' ? '$30.00' : 'N/A'),
    on_street: street, side_of_st: side, from_stree: from, to_street: to, borough,
    meter_rate: rateZone, shape_leng: null,
  };
}

function dot({ order, code, description, borough, street, side, from, to }) {
  return {
    order_number: order, record_type: 'Current', order_type: 'P', borough,
    on_street: street, from_street: from, to_street: to, side_of_street: side,
    sign_code: code, sign_description: description,
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

const fixtures = [
  {
    id: 'chatham_doyers_mott_west', curbState: 'UNKNOWN', point: { lat: 40.7138156, lng: -73.9981215 },
    borough: 'MANHATTAN', streetNames: ['CHATHAM SQUARE'], bounds: ['DOYERS STREET', 'MOTT STREET'], side: 'W',
    dotApplicability: 'WHOLE_FACE', expected: { cleaning: 'UNKNOWN', meter: 'UNKNOWN' },
    dotRows: [dot({ order: 'P-01868237', code: 'PS-20B', description: 'NO PARKING (SANITATION BROOM SYMBOL) 7AM-7:30AM EXCEPT SUNDAY <->', borough: 'MANHATTAN', street: 'CHATHAM SQUARE', side: 'W', from: 'DOYERS STREET', to: 'MOTT STREET' })],
    parkRows: [park({ zone: '100014', street: 'Chatham Square', side: 'W', from: 'Doyers Street', to: 'Mott Street', borough: 'Manhattan', first: [-73.9985844413438, 40.7136307529502], last: [-73.9976934281076, 40.7140454488275], schedule: 'Monday-Saturday 7:30 AM-7 PM', rate: '$5.00 1st Hour / $8.25 2nd Hour', cap: '$13.25', rateZone: 'Zone M2' })],
  },
  {
    id: 'gold_beekman_ann_west', curbState: 'SUPPORTED', point: { lat: 40.709579, lng: -74.0050487 },
    borough: 'MANHATTAN', streetNames: ['GOLD STREET'], bounds: ['BEEKMAN STREET', 'ANN STREET'], side: 'W',
    dotApplicability: 'WHOLE_FACE', expected: { cleaning: 'SUPPORTED', meter: 'SUPPORTED' },
    dotRows: [dot({ order: 'P-01775228', code: 'PS-246B', description: 'NO PARKING (SANITATION BROOM SYMBOL) MONDAY TUESDAY THURSDAY FRIDAY 6:30AM-7:30AM <->', borough: 'MANHATTAN', street: 'GOLD STREET', side: 'W', from: 'BEEKMAN STREET', to: 'ANN STREET' })],
    parkRows: [park({ zone: '100124', street: 'Gold Street', side: 'W', from: 'Beekman Street', to: 'Ann Street', borough: 'Manhattan', first: [-74.004940079168, 40.7096752163424], last: [-74.0051589912663, 40.7094842263736], schedule: 'Monday-Saturday 8 AM-7 PM', rate: '$5.50 1st Hour / $9.00 2nd Hour', cap: '$14.50', rateZone: 'Zone M1' })],
  },
  {
    id: 'st_james_chatham_madison_west', curbState: 'CAUTION', point: { lat: 40.712539, lng: -73.9990416 },
    borough: 'MANHATTAN', streetNames: ['ST. JAMES PLACE'], bounds: ['CHATHAM SQUARE', 'MADISON STREET'], side: 'W',
    dotApplicability: 'WHOLE_FACE', expected: { cleaning: 'CAUTION', meter: 'CAUTION' },
    dotRows: [dot({ order: 'P-01310064', code: 'PS-18B', description: 'NO PARKING (SANITATION BROOM SYMBOL) MONDAY THURSDAY 11AM-12:30PM <->', borough: 'MANHATTAN', street: 'ST. JAMES PLACE', side: 'W', from: 'CHATHAM SQUARE', to: 'MADISON STREET' })],
    parkRows: [park({ zone: '100279', street: 'St. James Place', side: 'W', from: 'Chatham Square', to: 'Madison Street', borough: 'Manhattan', first: [-73.9983768529118, 40.7132541504124], last: [-73.9997677169922, 40.7118414108519], schedule: 'Monday-Saturday 7:30 AM-7 PM', rate: '$5.00 1st Hour / $8.25 2nd Hour', cap: '$13.25', rateZone: 'Zone M2' })],
  },
  {
    id: 'east_170_walton_grand_concourse_south', curbState: 'CAUTION', point: { lat: 40.839063, lng: -73.9150273 },
    borough: 'BRONX', streetNames: ['EAST 170 STREET'], bounds: ['WALTON AVENUE', 'GRAND CONCOURSE'], side: 'S',
    dotApplicability: 'UNKNOWN', expected: { cleaning: 'UNKNOWN', meter: 'CAUTION' },
    currentSourceNote: 'The exact reviewed nfid-uabd query returned no current row; cleaning remains UNKNOWN rather than reproducing the Phase 0 expectation.',
    dotRows: [],
    parkRows: [park({ zone: '200012', street: 'East 170 Street', side: 'S', from: 'Walton Avenue', to: 'Grand Concourse', borough: 'Bronx', first: [-73.9140812063014, 40.8386890593937], last: [-73.9159387816247, 40.839476487216], schedule: 'Monday-Saturday 8:30 AM-7 PM', rate: '$1.50 1st Hour / $2.50 2nd Hour', cap: '$4.00', rateZone: 'Zone 3' })],
  },
  {
    id: 'pierrepont_clinton_cadman_north', curbState: 'CAUTION', point: { lat: 40.6947981, lng: -73.9914137 },
    borough: 'BROOKLYN', streetNames: ['PIERREPONT STREET'], bounds: ['CLINTON STREET', 'CADMAN PLAZA WEST'], side: 'N',
    dotApplicability: 'WHOLE_FACE', expected: { cleaning: 'CAUTION', meter: 'CAUTION' },
    dotRows: [dot({ order: 'P-01797377', code: 'PS-22B', description: 'NO PARKING (SANITATION BROOM SYMBOL) 8AM-8:30AM EXCEPT SUNDAY <->', borough: 'BROOKLYN', street: 'PIERREPONT STREET', side: 'N', from: 'CLINTON STREET', to: 'CADMAN PLAZA WEST' })],
    parkRows: [park({ zone: '300008', street: 'Pierrepont Street', side: 'N', from: 'Clinton Street', to: 'Cadman Plaza West', borough: 'Brooklyn', first: [-73.9920280744378, 40.694973750532], last: [-73.9908188883673, 40.6946392514338], schedule: 'Monday-Saturday 8:30 AM-7 PM', rate: '$2.50 1st Hour / $5.00 2nd Hour', cap: '$7.50', rateZone: 'Zone 1' })],
  },
  {
    id: 'prince_roosevelt_40_road_east', curbState: 'SUPPORTED', point: { lat: 40.7586708, lng: -73.8316506 },
    borough: 'QUEENS', streetNames: ['PRINCE STREET'], bounds: ['ROOSEVELT AVENUE', '40 ROAD'], side: 'E',
    dotApplicability: 'WHOLE_FACE', expected: { cleaning: 'SUPPORTED', meter: 'SUPPORTED' },
    dotRows: [dot({ order: 'P-01809087', code: 'PS-20B', description: 'NO PARKING (SANITATION BROOM SYMBOL) 7AM-7:30AM EXCEPT SUNDAY <->', borough: 'QUEENS', street: 'PRINCE STREET', side: 'E', from: 'ROOSEVELT AVENUE', to: '40 ROAD' })],
    parkRows: [park({ zone: '400356', street: 'Prince Street', side: 'E', from: 'Roosevelt Avenue', to: '40 Road', borough: 'Queens', first: [-73.831795009419, 40.7589230063772], last: [-73.831489341828, 40.7584255341032], schedule: 'Monday-Saturday 7:30 AM-10 PM', rate: '$2.50 1st Hour / $5.00 2nd Hour', cap: '$7.50', rateZone: 'Zone 1' })],
  },
  {
    id: 'bay_victory_hannah_west', curbState: 'CAUTION', point: { lat: 40.636825, lng: -74.07649 },
    borough: 'STATEN ISLAND', streetNames: ['BAY STREET'], bounds: ['VICTORY BOULEVARD', 'HANNAH STREET'], side: 'W',
    dotApplicability: 'PARTIAL_FACE', expected: { cleaning: 'CAUTION', meter: 'CAUTION' },
    dotRows: [dot({ order: 'P-01683639', code: 'PS-161B', description: 'NO PARKING (SANITATION BROOM SYMBOL) MONDAY 12AM-3AM <->', borough: 'STATEN ISLAND', street: 'BAY STREET', side: 'W', from: 'VICTORY BOULEVARD', to: 'HANNAH STREET' })],
    parkRows: [park({ zone: '514472', street: 'Bay Street', side: 'W', from: 'Victory Boulevard', to: 'Hannah Street', borough: 'Staten Island', first: [-74.0760385364653, 40.6359380258941], last: [-74.0769169164927, 40.6377113780252], schedule: 'Monday-Saturday 8 AM-7 PM', rate: '$2.00 1st Hour / $3.00 2nd Hour', cap: '$5.00', rateZone: 'Zone 2' })],
  },
  {
    id: 'william_cedar_liberty_east', curbState: 'CAUTION', point: { lat: 40.7075049, lng: -74.0084142 },
    borough: 'MANHATTAN', streetNames: ['WILLIAM STREET'], bounds: ['CEDAR STREET', 'LIBERTY STREET'], side: 'E',
    dotApplicability: 'UNKNOWN', expected: { cleaning: 'UNKNOWN', meter: 'UNKNOWN' },
    currentSourceNote: 'No reviewed current sanitation-broom row was found; the ParkNYC row is Commercial Only.',
    dotRows: [],
    parkRows: [park({ zone: '100009', vehicle: 'Commercial Only', street: 'William Street', side: 'E', from: 'Cedar Street', to: 'Liberty Street', borough: 'Manhattan', first: [-74.0085638126145, 40.70734561572], last: [-74.0082547014946, 40.707655171022], schedule: 'N/A', rate: 'N/A', cap: 'N/A', rateZone: 'Zone M1' })],
  },
  {
    id: 'queens_33_ditmars_23_ave_west', curbState: 'UNKNOWN', point: { lat: 40.7751774, lng: -73.9104295 },
    borough: 'QUEENS', streetNames: ['33 STREET'], bounds: ['DITMARS BOULEVARD', '23 AVENUE'], side: 'W',
    dotApplicability: 'WHOLE_FACE', expected: { cleaning: 'UNKNOWN', meter: 'UNKNOWN' },
    currentSourceNote: 'Official ParkNYC evidence contains an on-street Zone 2 row and separate Off-Street Parking rows on the same named bounds; competing geometry remains UNKNOWN.',
    dotRows: [dot({ order: 'P-01691437', code: 'PS-30B', description: 'NO PARKING (SANITATION BROOM SYMBOL) THURSDAY 8:30AM-10AM <->', borough: 'QUEENS', street: '33 STREET', side: 'W', from: 'DITMARS BOULEVARD', to: '23 AVENUE' })],
    parkRows: [
      park({ zone: '425652', street: '33 Street', side: 'W', from: 'Ditmars Boulevard', to: '23 Avenue', borough: 'Queens', first: [-73.90973557836743, 40.77535915879452], last: [-73.91178110139525, 40.7736815477164], schedule: 'Monday-Saturday 9 AM-7 PM', rate: '$2.00 1st Hour / $3.00 2nd Hour', cap: '$5.00', rateZone: 'Zone 2' }),
      park({ zone: '469229', duration: '4 Hours', street: '33 Street', side: 'W', from: 'Ditmars Boulevard', to: '23 Avenue', borough: 'Queens', first: [-73.9108040794818, 40.775210263303215], last: [-73.91005494735279, 40.77514463133813], schedule: 'Monday-Saturday 7 AM-10 PM', rate: '$2.00 per Hour', cap: '$8.00', rateZone: 'Off-Street Parking' }),
    ],
  },
];

module.exports = {
  DOT_VERSION,
  PARK_NYC_VERSION,
  NYC_RULE_FIXTURES: deepFreeze(fixtures),
};
