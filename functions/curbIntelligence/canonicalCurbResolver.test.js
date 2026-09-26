import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveCanonicalCurb } = require('./canonicalCurbResolver');

const VERSION = Object.freeze({ resourceId: 'inkn-q76z', version: 'fixture-v2' });
const HORIZONTAL = [[[-74.001, 40.7], [-73.999, 40.7]]];
const VERTICAL = [[[-74, 40.699], [-74, 40.701]]];

function record(overrides = {}) {
  const globalId = overrides.globalId || 'main-global';
  return {
    globalId,
    sourceVersion: VERSION,
    geometry: { type: 'MultiLineString', coordinates: overrides.coordinates || HORIZONTAL },
    leftBlockFaceId: overrides.leftBlockFaceId || '1000000001',
    rightBlockFaceId: overrides.rightBlockFaceId || '1000000002',
    sourceNative: {
      globalid: globalId,
      physicalid: overrides.physicalId || `${globalId}-physical`,
      b5sc: overrides.b5sc || `${globalId}-b5sc`,
      boroughcode: '2',
      rw_type: overrides.roadwayType || '1',
      full_street_name: overrides.streetName || 'MARAN PLACE',
      street_name: overrides.streetName || 'MARAN PLACE',
      stname_label: overrides.streetName || 'Maran Place',
      streetwidth: String(overrides.streetWidthFeet || 34),
      from_level_code: overrides.fromLevel || '13',
      to_level_code: overrides.toLevel || '13',
      accessible: null,
      nonped: null,
      status: overrides.status || '2',
      from_street: overrides.fromStreet || 'WHITE PLAINS ROAD',
      to_street: overrides.toStreet || 'LURTING AVENUE',
    },
  };
}

const store = (candidates, completeness = { state: 'COMPLETE', reason: null }) => ({
  queryCandidates: vi.fn(async () => ({ candidates, completeness, sourceVersion: VERSION })),
});
const noPlanimetric = () => ({
  queryCurbs: vi.fn(async () => ({
    candidates: [],
    completeness: { state: 'COMPLETE', reason: null },
    sourceVersion: { resourceId: '5xvt-8cbk', version: 'fixture-plan-v1' },
  })),
});
const planimetric = geometries => ({
  queryCurbs: vi.fn(async () => ({
    candidates: geometries.map((geometry, index) => ({ curbId: `curb-${index}`, geometry })),
    completeness: { state: 'COMPLETE', reason: null },
    sourceVersion: { resourceId: '5xvt-8cbk', version: 'fixture-plan-v1' },
  })),
});
const location = (overrides = {}) => ({
  lat: 40.70005,
  lng: -74,
  accuracyMeters: 1,
  sampleCount: 3,
  consistencyMeters: 2,
  ...overrides,
});
const options = (candidates, extra = {}) => ({
  candidateStore: store(candidates),
  planimetricStore: noPlanimetric(),
  requestNonce: 'request-nonce',
  ...extra,
});

describe('resolveCanonicalCurb', () => {
  it('supports a clear residential curb and the opposite side with different identities', async () => {
    const north = await resolveCanonicalCurb(location(), options([record()]));
    const south = await resolveCanonicalCurb(
      location({ lat: 40.69995 }),
      options([record()]),
    );

    expect(north).toMatchObject({
      state: 'SUPPORTED',
      identity: { officialBlockFaceId: '1000000001', csclSide: 'LEFT' },
      publicCurb: { streetName: 'MARAN PLACE', sideLabel: 'North' },
    });
    expect(south).toMatchObject({
      state: 'SUPPORTED',
      identity: { officialBlockFaceId: '1000000002', csclSide: 'RIGHT' },
      publicCurb: { sideLabel: 'South' },
    });
    expect(north.publicCurb.segmentId).not.toBe(south.publicCurb.segmentId);
  });

  it.each([
    ['wide avenue', record({ streetName: 'WIDE AVENUE', streetWidthFeet: 80 }), location({ lat: 40.70009, accuracyMeters: 2 })],
    ['narrow street', record({ streetName: 'NARROW STREET', streetWidthFeet: 20 }), location({ lat: 40.700045, accuracyMeters: 1 })],
  ])('supports plausible geometry on a %s', async (_name, roadway, point) => {
    await expect(resolveCanonicalCurb(point, options([roadway])))
      .resolves.toMatchObject({ state: 'SUPPORTED' });
  });

  it('returns exactly two visual candidates at an intersection endpoint', async () => {
    const horizontal = record({ coordinates: [[[-74, 40.7], [-73.999, 40.7]]] });
    const vertical = record({
      globalId: 'white-plains',
      streetName: 'WHITE PLAINS ROAD',
      coordinates: [[[-74, 40.7], [-74, 40.701]]],
      leftBlockFaceId: '2000000001',
      rightBlockFaceId: '2000000002',
    });
    const result = await resolveCanonicalCurb(
      location({ lat: 40.700035, lng: -73.999965, accuracyMeters: 3 }),
      options([horizontal, vertical]),
    );

    expect(result.state).toBe('AMBIGUOUS');
    expect(result.candidates).toHaveLength(2);
    expect(result.candidates.map(value => value.streetName).sort())
      .toEqual(['MARAN PLACE', 'WHITE PLAINS ROAD']);
    expect(result.candidates.every(value => /^candidate2_/.test(value.token))).toBe(true);
  });

  it('never chooses a slightly closer crossing centerline when uncertainty overlaps', async () => {
    const maran = record({ coordinates: HORIZONTAL });
    const whitePlains = record({
      globalId: 'white-plains',
      streetName: 'WHITE PLAINS ROAD',
      coordinates: VERTICAL,
      leftBlockFaceId: '2000000001',
      rightBlockFaceId: '2000000002',
    });
    const result = await resolveCanonicalCurb(
      location({ lat: 40.700045, lng: -73.999965, accuracyMeters: 3 }),
      options([maran, whitePlains]),
    );

    expect(result.state).toBe('AMBIGUOUS');
    expect(result.candidates.map(value => value.streetName))
      .toEqual(expect.arrayContaining(['MARAN PLACE', 'WHITE PLAINS ROAD']));
    const serialized = JSON.stringify(result).toLowerCase();
    expect(serialized).not.toContain('officialblockface');
    expect(serialized).not.toContain('1000000001');
    expect(serialized).not.toContain('2000000001');
    expect(serialized).not.toContain('globalid');
  });

  it('fails closed for poor GPS, multi-level conflict, and incomplete CSCL evidence', async () => {
    const poor = await resolveCanonicalCurb(
      location({ accuracyMeters: 50.1 }),
      options([record()]),
    );
    const multiLevel = await resolveCanonicalCurb(location({ lat: 40.70001 }), options([
      record(),
      record({
        globalId: 'upper',
        coordinates: [[[-74.001, 40.70002], [-73.999, 40.70002]]],
        fromLevel: '14',
        toLevel: '14',
        leftBlockFaceId: '3000000001',
        rightBlockFaceId: '3000000002',
      }),
    ]));
    const incomplete = await resolveCanonicalCurb(
      location(),
      options([record()], {
        candidateStore: store([record()], { state: 'INCOMPLETE', reason: 'coverage_gap' }),
      }),
    );

    expect(poor).toMatchObject({ state: 'UNSUPPORTED', reasons: expect.arrayContaining(['reported_accuracy_exceeds_limit']) });
    expect(multiLevel).toMatchObject({ state: 'UNSUPPORTED', reasons: expect.arrayContaining(['multilevel_or_roadbed_ambiguity']) });
    expect(incomplete).toMatchObject({ state: 'UNSUPPORTED', reasons: expect.arrayContaining(['candidate_coverage_incomplete']) });
  });

  it('uses uniquely aligned nearby planimetric curb evidence to resolve crossing roads', async () => {
    const maran = record({ coordinates: HORIZONTAL });
    const whitePlains = record({
      globalId: 'white-plains', streetName: 'WHITE PLAINS ROAD', coordinates: VERTICAL,
      leftBlockFaceId: '2000000001', rightBlockFaceId: '2000000002',
    });
    const maranCurb = { type: 'MultiLineString', coordinates: [[[-74.0002, 40.70004], [-73.9998, 40.70004]]] };
    const result = await resolveCanonicalCurb(
      location({ lat: 40.70004, lng: -73.99997, accuracyMeters: 3 }),
      options([maran, whitePlains], { planimetricStore: planimetric([maranCurb]) }),
    );

    expect(result).toMatchObject({
      state: 'SUPPORTED',
      identity: { names: { onStreet: 'MARAN PLACE' } },
    });
  });

  it('keeps ambiguity when planimetric curbs conflict across both candidates', async () => {
    const maran = record({ coordinates: HORIZONTAL });
    const whitePlains = record({
      globalId: 'white-plains', streetName: 'WHITE PLAINS ROAD', coordinates: VERTICAL,
      leftBlockFaceId: '2000000001', rightBlockFaceId: '2000000002',
    });
    const result = await resolveCanonicalCurb(
      location({ lat: 40.70004, lng: -73.99997, accuracyMeters: 3 }),
      options([maran, whitePlains], {
        planimetricStore: planimetric([
          { type: 'MultiLineString', coordinates: [[[-74.0002, 40.70004], [-73.9998, 40.70004]]] },
          { type: 'MultiLineString', coordinates: [[[-73.99997, 40.6998], [-73.99997, 40.7002]]] },
        ]),
      }),
    );

    expect(result.state).toBe('AMBIGUOUS');
    expect(result.candidates).toHaveLength(2);
  });

  it('never lets an opposite-side planimetric line promote a crossing curb', async () => {
    const maran = record({ coordinates: HORIZONTAL });
    const whitePlains = record({
      globalId: 'white-plains', streetName: 'WHITE PLAINS ROAD', coordinates: VERTICAL,
      leftBlockFaceId: '2000000001', rightBlockFaceId: '2000000002',
    });
    const oppositeMaranCurb = {
      type: 'MultiLineString',
      coordinates: [[[-74.0002, 40.69996], [-73.9998, 40.69996]]],
    };
    const result = await resolveCanonicalCurb(
      location({ lat: 40.70004, lng: -73.99997, accuracyMeters: 3 }),
      options([maran, whitePlains], { planimetricStore: planimetric([oppositeMaranCurb]) }),
    );

    expect(result.state).toBe('AMBIGUOUS');
    expect(result.candidates).toHaveLength(2);
  });

  it('keeps ambiguity when planimetric distance intervals are not decisive', async () => {
    const maran = record({ coordinates: HORIZONTAL });
    const parallel = record({
      globalId: 'parallel', streetName: 'PARALLEL PLACE',
      coordinates: [[[-74.001, 40.70007], [-73.999, 40.70007]]],
      leftBlockFaceId: '2000000001', rightBlockFaceId: '2000000002',
    });
    const result = await resolveCanonicalCurb(
      location({ lat: 40.700035, lng: -74, accuracyMeters: 3 }),
      options([maran, parallel], {
        planimetricStore: planimetric([
          { type: 'MultiLineString', coordinates: [[[-74.0002, 40.70004], [-73.9998, 40.70004]]] },
          { type: 'MultiLineString', coordinates: [[[-74.0002, 40.70003], [-73.9998, 40.70003]]] },
        ]),
      }),
    );

    expect(result.state).toBe('AMBIGUOUS');
  });

  it('returns unsupported when more than two material curbs remain', async () => {
    const result = await resolveCanonicalCurb(
      location({ lat: 40.70001, lng: -73.99999, accuracyMeters: 4 }),
      options([
        record(),
        record({
          globalId: 'vertical', streetName: 'VERTICAL STREET', coordinates: VERTICAL,
          leftBlockFaceId: '2000000001', rightBlockFaceId: '2000000002',
        }),
        record({
          globalId: 'diagonal', streetName: 'DIAGONAL STREET',
          coordinates: [[[-74.0005, 40.6995], [-73.9995, 40.7005]]],
          leftBlockFaceId: '3000000001', rightBlockFaceId: '3000000002',
        }),
      ]),
    );

    expect(result).toEqual({ state: 'UNSUPPORTED', reasons: ['intersection_complex'] });
  });

  it('fails closed when the CSCL result exceeds the 100-candidate cap', async () => {
    const candidates = Array.from({ length: 101 }, (_, index) => record({
      globalId: `candidate-${index}`,
      physicalId: `physical-${index}`,
      b5sc: `b5sc-${index}`,
    }));
    const result = await resolveCanonicalCurb(location(), options(candidates));

    expect(result).toEqual({
      state: 'UNSUPPORTED',
      reasons: ['candidate_coverage_incomplete'],
    });
  });

  it('starts CSCL and planimetric reads in parallel', async () => {
    let csclStarted = false;
    let planStarted = false;
    const candidateStore = {
      async queryCandidates() {
        csclStarted = true;
        await Promise.resolve();
        expect(planStarted).toBe(true);
        return { candidates: [record()], completeness: { state: 'COMPLETE', reason: null } };
      },
    };
    const planimetricStore = {
      async queryCurbs() {
        planStarted = true;
        await Promise.resolve();
        expect(csclStarted).toBe(true);
        return { candidates: [], completeness: { state: 'COMPLETE', reason: null } };
      },
    };

    await expect(resolveCanonicalCurb(location(), {
      candidateStore, planimetricStore, requestNonce: 'parallel',
    })).resolves.toMatchObject({ state: 'SUPPORTED' });
  });
});
