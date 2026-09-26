'use strict';

const { parseMeterSchedule } = require('./parkNycNormalizer');
const { associateParkNycRules } = require('./parkNycAssociation');
const { toPublicMeterProduct, logMeterEvent, publicRate, METER_EVENTS } = require('./productMeterModel');
const { runProductMeterLookup, runCanonicalMeterLookup } = require('./productMeterLookup');

const version = { resourceId: 'e7yp-wx55', rowsUpdatedAt: '2026-09-01T10:21:51Z', viewLastModified: '2026-09-01T10:20:59Z' };
const point = { lat: 40.70958, lng: -74.00504 };
const windows = [{ days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], startTime: '09:00', endTime: '19:00' }];
const passenger = {
  complete: true,
  rateComplete: true,
  maximumMinutes: 120,
  schedule: { ok: true, windows },
  rate: { ok: true, kind: 'FIXED', amount: 3.5, unitMinutes: 60 },
  maximumCharge: { ok: true, amount: 7 },
};

const meter = (overrides = {}) => ({
  zoneId: '100124', vehicleClass: 'ALL_VEHICLES', passengerApplicable: true,
  commercialApplicable: true, borough: 'MANHATTAN', side: 'W', onStreet: 'GOLD STREET',
  fromStreet: 'BEEKMAN STREET', toStreet: 'ANN STREET', rateZone: 'Zone M1',
  geometry: { type: 'MultiLineString', coordinates: [[[-74.00515, 40.70949], [-74.00494, 40.70968]]] },
  branches: { passenger, commercial: null },
  sourceVersion: version, sourceNative: {}, ...overrides,
});
const curb = (state = 'SUPPORTED', csclSide = 'LEFT') => ({
  state, officialIdentity: { officialBlockFaceId: '1234567890', csclSide },
});
const snapshot = (candidates, state = 'COMPLETE') => ({
  candidates, completeness: { state, reason: state === 'COMPLETE' ? null : 'coverage_gap' }, sourceVersion: version,
});
const roadwayEvidence = (overrides = {}) => ({
  officialBlockFaceId: '1234567890',
  csclSide: 'LEFT',
  selectedGeometry: {
    type: 'MultiLineString',
    coordinates: [[[-74.00515, 40.70945], [-74.00494, 40.70964]]],
  },
  streetWidthFeet: 40,
  modelUncertaintyMeters: 2,
  candidateCoverageComplete: true,
  competingRoadways: [],
  ...overrides,
});
const input = (candidates, extra = {}) => ({
  curbIdentity: curb(), resolvedPoint: point, officialNames: ['GOLD STREET'],
  officialBounds: ['BEEKMAN STREET', 'ANN STREET'], borough: 'MANHATTAN', side: 'W',
  officialRoadwayEvidence: roadwayEvidence(), candidateSnapshot: snapshot(candidates), ...extra,
});

describe('H. ParkNYC schedule parsing for live meters', () => {
  it('parses Monday-Saturday hours used by the live product', () => {
    expect(parseMeterSchedule('Monday-Saturday 9 AM-7 PM')).toMatchObject({
      ok: true,
      windows: [{ days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], startTime: '09:00', endTime: '19:00' }],
    });
  });

  it('I. parses a full-week meter schedule when the source states Monday-Sunday', () => {
    expect(parseMeterSchedule('Monday-Sunday 9 AM-7 PM').windows[0].days).toEqual([
      'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun',
    ]);
  });
});

describe('live meter product model', () => {
  it('A. emits a public meter rule from a SUPPORTED same-curb association', () => {
    const association = associateParkNycRules(input([meter()]));
    const product = toPublicMeterProduct(association, 'West');
    expect(association.state).toBe('SUPPORTED');
    expect(product).toMatchObject({
      state: 'supported',
      event: METER_EVENTS.SUPPORTED,
      product: { type: 'meter', source: 'park_nyc', side: 'West', maxStayMinutes: 120 },
    });
    expect(product.product.windows[0]).toMatchObject({ startTime: '09:00', endTime: '19:00' });
    expect(product.product.rate.display).toBe('$3.50/hour');
    expect(JSON.stringify(product)).not.toMatch(/1234567890|100124|officialBlockFaceId/);
  });

  it('E. does not attach an opposite-side meter', () => {
    const association = associateParkNycRules(input([meter({ side: 'E' })]));
    const product = toPublicMeterProduct(association, 'West');
    expect(association.reasonCodes).toContain('official_meter_face_mismatch');
    expect(product.state).toBe('omitted');
    expect(product.event).toBe(METER_EVENTS.NO_MATCH);
    expect(product.product).toBeNull();
  });

  it('F. omits meters when the relationship is not SUPPORTED', () => {
    const association = associateParkNycRules(input([meter()], { officialRoadwayEvidence: undefined }));
    const product = toPublicMeterProduct(association, 'West');
    expect(association.state).not.toBe('SUPPORTED');
    expect(product.state).toBe('omitted');
    expect(product.event).toBe(METER_EVENTS.RELATIONSHIP_UNCERTAIN);
  });

  it('does not advertise a single hourly price for tiered rates', () => {
    expect(publicRate({ ok: true, kind: 'TIERED_HOURLY', amount: 5, unitMinutes: 60 })).toBeNull();
    expect(publicRate({ ok: true, kind: 'FIXED', amount: 1.5, unitMinutes: 60 }).display).toBe('$1.50/hour');
  });
});

describe('Q. privacy-safe meter telemetry', () => {
  it('logs aggregate-safe JSON and drops identifying extras', () => {
    const lines = [];
    const product = toPublicMeterProduct(associateParkNycRules(input([meter()])), 'West');
    const payload = logMeterEvent(product, line => lines.push(line));
    const parsed = JSON.parse(lines[0]);
    expect(parsed.event).toBe(METER_EVENTS.SUPPORTED);
    expect(parsed.domain).toBe('street_intel_meter');
    expect(parsed.windowCount).toBe(1);
    expect(payload).not.toHaveProperty('lat');
    expect(JSON.stringify(payload)).not.toMatch(/100124|1234567890|GOLD STREET|uid|token/);
  });
});

describe('product meter lookup fail-soft and parallelism', () => {
  const csclRecord = {
    globalId: 'cscl-1',
    sourceVersion: { resourceId: 'inkn-q76z', version: '1:1' },
    geometry: { type: 'MultiLineString', coordinates: [[[-74.00515, 40.70945], [-74.00494, 40.70964]]] },
    leftBlockFaceId: '1234567890',
    rightBlockFaceId: '1234567891',
    sourceNative: {
      globalid: 'cscl-1', physicalid: '101', rw_type: '1', from_level_code: 'M', to_level_code: 'M',
      status: '2', nonped: '', accessible: 'Y', streetwidth: '40', full_street_name: 'GOLD STREET',
    },
  };

  it('G. ParkNYC failure omits the meter without throwing', async () => {
    const result = await runProductMeterLookup({
      location: { lat: 40.70958, lng: -74.00504, accuracyMeters: 1 },
      parkingSide: 'West',
      streetContext: {
        borough: 'MANHATTAN', onStreet: 'GOLD STREET',
        crossStreetOne: 'Beekman Street', crossStreetTwo: 'Ann Street',
      },
    }, {
      candidateStore: {
        async queryCandidates() {
          return { candidates: [csclRecord], completeness: { state: 'COMPLETE', reason: null }, sourceVersion: csclRecord.sourceVersion };
        },
      },
      parkNycStore: {
        async query() { throw new Error('park down'); },
      },
    });
    expect(['omitted', 'unavailable']).toContain(result.state);
    expect(result.product).toBeNull();
  });

  it('R. starts CSCL and ParkNYC work together rather than retrying', async () => {
    let parkStarted = false;
    let curbStarted = false;
    let parkCalls = 0;
    await runProductMeterLookup({
      location: { lat: 40.70958, lng: -74.00504, accuracyMeters: 1 },
      parkingSide: 'West',
      streetContext: {
        borough: 'MANHATTAN', onStreet: 'GOLD STREET',
        crossStreetOne: 'Beekman Street', crossStreetTwo: 'Ann Street',
      },
    }, {
      candidateStore: {
        async queryCandidates() {
          curbStarted = true;
          expect(parkStarted).toBe(true);
          return { candidates: [csclRecord], completeness: { state: 'COMPLETE', reason: null }, sourceVersion: csclRecord.sourceVersion };
        },
      },
      parkNycStore: {
        async query() {
          parkStarted = true;
          parkCalls += 1;
          await new Promise(resolve => setTimeout(resolve, 20));
          return { candidateSnapshot: snapshot([meter()]) };
        },
      },
    });
    expect(parkCalls).toBe(1);
  });

  it('uses one supplied canonical identity without a second CSCL resolution', async () => {
    const candidateStore = { queryCandidates: vi.fn() };
    const canonical = {
      schemaVersion: 2,
      jurisdiction: 'NYC',
      officialBlockFaceId: '1234567890',
      csclSide: 'LEFT',
      roadway: {
        geometry: {
          type: 'MultiLineString',
          coordinates: [[[-74.00515, 40.70943], [-74.00494, 40.70962]]],
        },
        streetWidthFeet: 40,
      },
      names: {
        borough: 'Manhattan',
        onStreet: 'GOLD STREET',
        fromStreet: 'BEEKMAN STREET',
        toStreet: 'ANN STREET',
        aliases: [],
      },
      side: { cardinal: 'West' },
    };
    const result = await runCanonicalMeterLookup({ identity: canonical }, {
      candidateStore,
      parkNycStore: {
        async query() { return { candidateSnapshot: snapshot([meter()]) }; },
      },
    });
    expect(result).toMatchObject({
      state: 'supported',
      product: { category: 'meter', source: 'park_nyc', side: 'West' },
    });
    expect(candidateStore.queryCandidates).not.toHaveBeenCalled();
  });
});
