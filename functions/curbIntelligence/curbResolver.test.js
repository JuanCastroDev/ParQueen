import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveOfficialCurb } = require('./curbResolver');

const line = ({ id, lng, left = '0000000001', right = '0000000002', b5sc = '100001',
  physicalid = id, type = '1', level = 'M', status = '2', nonped = 'N', startLat = 40.70, endLat = 40.72,
  sourceVersion = { resourceId: 'inkn-q76z', version: 'fixture-v1' } }) => ({
  globalId: id,
  geometry: { type: 'MultiLineString', coordinates: [[[lng, startLat], [lng, endLat]]] },
  leftBlockFaceId: left,
  rightBlockFaceId: right,
  sourceNative: {
    physicalid, b5sc, rw_type: type, from_level_code: level, to_level_code: level,
    full_street_name: 'TEST STREET', streetwidth: '40', status, nonped, accessible: 'Y',
  },
  sourceVersion,
});

const store = (candidates, completeness = { state: 'COMPLETE', reason: null }) => ({
  async queryCandidates(query) { return { candidates, completeness, query }; },
});

describe('official curb resolver', () => {
  it('uses a broad accuracy-derived store query, exact metric ranking, signed side, and official BFI', async () => {
    const near = line({ id: 'near', lng: -74 });
    const far = line({ id: 'far', lng: -73.999, left: '0000000003', right: '0000000004', b5sc: '100002' });
    let observed;
    const candidateStore = { async queryCandidates(query) { observed = query; return { candidates: [far, near], completeness: { state: 'COMPLETE', reason: null } }; } };
    const result = await resolveOfficialCurb({ lat: 40.71, lng: -73.9999, accuracyMeters: 2 }, { candidateStore, modelErrorMeters: 2 });
    expect(observed.searchRadiusMeters).toBeGreaterThanOrEqual(50);
    expect(observed.envelope.minLat).toBeLessThan(40.71);
    expect(result.state).toBe('SUPPORTED');
    expect(result.officialIdentity).toMatchObject({ officialBlockFaceId: '0000000002', csclSide: 'RIGHT' });
    expect(result.roadway.selectedRecordGlobalId).toBe('near');
  });

  it('keeps GPS accuracy first-class without a universal accuracy cutoff', async () => {
    const ordinary = line({ id: 'ordinary', lng: -74 });
    const excellent = await resolveOfficialCurb({ lat: 40.71, lng: -73.99993, accuracyMeters: 1 }, { candidateStore: store([ordinary]), modelErrorMeters: 1 });
    const moderate = await resolveOfficialCurb({ lat: 40.71, lng: -73.99993, accuracyMeters: 8 }, { candidateStore: store([ordinary]), modelErrorMeters: 2 });
    const poorButUnopposed = await resolveOfficialCurb({ lat: 40.71, lng: -73.99976, accuracyMeters: 25 }, { candidateStore: store([ordinary]), modelErrorMeters: 2 });
    expect(excellent.state).toBe('SUPPORTED');
    expect(moderate).toMatchObject({ state: 'CAUTION', reasons: ['side_uncertain'] });
    expect(poorButUnopposed).toMatchObject({ state: 'CAUTION', reasons: ['side_uncertain'] });
  });

  it('returns UNKNOWN for overlapping parallel roadbeds under uncertainty', async () => {
    const result = await resolveOfficialCurb({ lat: 40.71, lng: -73.9999, accuracyMeters: 12 }, {
      candidateStore: store([line({ id: 'west', lng: -74, b5sc: '100001' }), line({ id: 'east', lng: -73.9997, b5sc: '100002' })]),
      modelErrorMeters: 3,
    });
    expect(result.state).toBe('UNKNOWN');
    expect(result.reasons).toContain('competing_roadways_overlap');
  });

  it('returns CAUTION near an endpoint/intersection and on centerline-crossing side uncertainty', async () => {
    const endpoint = await resolveOfficialCurb({ lat: 40.70001, lng: -73.9999, accuracyMeters: 2 }, {
      candidateStore: store([line({ id: 'endpoint', lng: -74 })]), modelErrorMeters: 2,
    });
    expect(endpoint.state).toBe('CAUTION');
    expect(endpoint.reasons).toContain('endpoint_or_intersection_ambiguous');

    const center = await resolveOfficialCurb({ lat: 40.71, lng: -74, accuracyMeters: 1 }, {
      candidateStore: store([line({ id: 'center', lng: -74 })]), modelErrorMeters: 1,
    });
    expect(center.state).toBe('UNKNOWN');
    expect(center.reasons).toContain('official_face_missing');
  });

  it('keeps service roads and level-conflicting roadways as meaningful competitors', async () => {
    const main = line({ id: 'main', lng: -74, b5sc: '100001', type: '1', level: 'M' });
    const service = line({ id: 'service', lng: -73.9998, b5sc: '100002', type: '9', level: 'M' });
    const result = await resolveOfficialCurb({ lat: 40.71, lng: -73.9999, accuracyMeters: 8 }, {
      candidateStore: store([main, service]), modelErrorMeters: 2,
    });
    expect(result.state).toBe('UNKNOWN');
    expect(result.reasons).toContain('competing_roadways_overlap');

    const bridge = line({ id: 'bridge', lng: -74, level: '1' });
    const surface = line({ id: 'surface', lng: -74, level: 'M' });
    const levels = await resolveOfficialCurb({ lat: 40.71, lng: -73.9999, accuracyMeters: 2 }, {
      candidateStore: store([bridge, surface]), modelErrorMeters: 2,
    });
    expect(levels.state).toBe('UNKNOWN');
    expect(levels.reasons).toContain('multilevel_or_roadbed_ambiguity');
  });

  it('fails closed for missing official face, incomplete retrieval, unusable candidates, and off-network input', async () => {
    const missing = await resolveOfficialCurb({ lat: 40.71, lng: -73.9999, accuracyMeters: 2 }, {
      candidateStore: store([line({ id: 'missing', lng: -74, right: null })]), modelErrorMeters: 2,
    });
    expect(missing).toMatchObject({ state: 'UNKNOWN' });
    expect(missing.reasons).toContain('official_face_missing');

    const incomplete = await resolveOfficialCurb({ lat: 40.71, lng: -73.9999, accuracyMeters: 2 }, {
      candidateStore: store([line({ id: 'one', lng: -74 })], { state: 'INCOMPLETE', reason: 'coverage_gap' }), modelErrorMeters: 2,
    });
    expect(incomplete.state).toBe('UNKNOWN');
    expect(incomplete.reasons).toContain('evidence_insufficient');

    const nonped = await resolveOfficialCurb({ lat: 40.71, lng: -73.9999, accuracyMeters: 2 }, {
      candidateStore: store([line({ id: 'nonped', lng: -74, nonped: 'Y' })]), modelErrorMeters: 2,
    });
    expect(nonped).toMatchObject({ state: 'UNKNOWN', reasons: ['unsupported_nonpedestrian_roadway'] });

    const inaccessible = await resolveOfficialCurb({ lat: 40.71, lng: -73.9999, accuracyMeters: 2 }, {
      candidateStore: store([{ ...line({ id: 'inaccessible', lng: -74 }), sourceNative: { ...line({ id: 'inaccessible', lng: -74 }).sourceNative, accessible: 'N' } }]), modelErrorMeters: 2,
    });
    expect(inaccessible).toMatchObject({ state: 'UNKNOWN', reasons: ['unsupported_inaccessible_roadway'] });

    expect(await resolveOfficialCurb({ lat: 39, lng: -73.9, accuracyMeters: 2 }, { candidateStore: store([]) }))
      .toMatchObject({ state: 'UNKNOWN', reasons: ['unsupported_off_network_location'], fallbackClassifications: ['unsupported_off_network_location'] });
  });

  it('cannot claim complete evidence when accuracy requires a wider envelope than the resolver cap', async () => {
    const result = await resolveOfficialCurb({ lat: 40.71, lng: -73.9999, accuracyMeters: 200 }, {
      candidateStore: store([line({ id: 'capped', lng: -74 })]), modelErrorMeters: 2, maxSearchRadiusMeters: 100,
    });
    expect(result.state).toBe('UNKNOWN');
    expect(result.reasons).toContain('evidence_insufficient');
    expect(result.searchEnvelopeComplete).toBe(false);
  });

  it('fails closed without source-version, roadway-type, or level evidence', async () => {
    const complete = line({ id: 'complete', lng: -74 });
    for (const candidate of [
      { ...complete, sourceVersion: null },
      { ...complete, sourceNative: { ...complete.sourceNative, rw_type: null } },
      { ...complete, sourceNative: { ...complete.sourceNative, from_level_code: null } },
      { ...complete, sourceNative: { ...complete.sourceNative, to_level_code: null } },
    ]) {
      const result = await resolveOfficialCurb({ lat: 40.71, lng: -73.9999, accuracyMeters: 2 }, {
        candidateStore: store([candidate]), modelErrorMeters: 2,
      });
      expect(result.state).toBe('UNKNOWN');
      expect(result.reasons).toContain('evidence_insufficient');
    }
  });

  it('fails closed when a complete candidate set contains malformed or mixed-version evidence', async () => {
    const valid = line({ id: 'valid', lng: -74 });
    const malformedCompetitor = {
      ...line({ id: 'malformed', lng: -73.9998, b5sc: '100002' }), sourceVersion: null,
    };
    const malformed = await resolveOfficialCurb({ lat: 40.71, lng: -73.9999, accuracyMeters: 2 }, {
      candidateStore: store([valid, malformedCompetitor]), modelErrorMeters: 2,
    });
    expect(malformed).toMatchObject({ state: 'UNKNOWN' });
    expect(malformed.reasons).toContain('evidence_insufficient');

    const differentVersion = line({
      id: 'different-version', lng: -73.9998, b5sc: '100002',
      sourceVersion: { resourceId: 'inkn-q76z', version: 'fixture-v2' },
    });
    const mixed = await resolveOfficialCurb({ lat: 40.71, lng: -73.9999, accuracyMeters: 2 }, {
      candidateStore: store([valid, differentVersion]), modelErrorMeters: 2,
    });
    expect(mixed).toMatchObject({ state: 'UNKNOWN' });
    expect(mixed.reasons).toContain('evidence_insufficient');
  });
});
