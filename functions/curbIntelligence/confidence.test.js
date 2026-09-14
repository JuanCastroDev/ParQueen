import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { classifyCurbResolution } = require('./confidence');

const BASE = {
  reportedAccuracyMeters: 3,
  modelErrorMeters: 1,
  bestRoadwayDistanceMeters: 6,
  nextRoadwayDistanceMeters: 30,
  signedOffsetMeters: 8,
  selectedBlockFaceId: '0212261301',
  candidateSetComplete: true,
  geometryPlausible: true,
  endpointAmbiguous: false,
  levelOrRoadbedAmbiguous: false,
};

describe('accuracy-aware curb resolution', () => {
  it('supports only separated roadway and side intervals with a usable face', () => {
    expect(classifyCurbResolution(BASE)).toMatchObject({
      state: 'SUPPORTED', reasons: [], uncertaintyMeters: 4,
      roadwayIntervals: { best: [2, 10], next: [26, 34] },
      sideInterval: [4, 12],
    });
  });

  it('returns CAUTION when a credible roadway is known but accuracy crosses the centerline', () => {
    const result = classifyCurbResolution({
      ...BASE,
      reportedAccuracyMeters: 25,
      modelErrorMeters: 2,
      signedOffsetMeters: 6,
      nextRoadwayDistanceMeters: 80,
    });
    expect(result.state).toBe('CAUTION');
    expect(result.reasons).toContain('side_uncertain');
    expect(result.sideInterval).toEqual([-21, 33]);
  });

  it('returns UNKNOWN when plausible roadway distance intervals overlap', () => {
    const result = classifyCurbResolution({ ...BASE, bestRoadwayDistanceMeters: 6, nextRoadwayDistanceMeters: 11 });
    expect(result.state).toBe('UNKNOWN');
    expect(result.reasons).toContain('competing_roadways_overlap');
  });

  it.each([
    ['missing official face', { selectedBlockFaceId: null }, 'official_face_missing'],
    ['incomplete candidate set', { candidateSetComplete: false }, 'evidence_insufficient'],
    ['implausible geometry', { geometryPlausible: false }, 'implausible_geometry'],
    ['unresolved level', { levelOrRoadbedAmbiguous: true }, 'multilevel_or_roadbed_ambiguity'],
  ])('returns UNKNOWN for %s', (_name, change, reason) => {
    const result = classifyCurbResolution({ ...BASE, ...change });
    expect(result.state).toBe('UNKNOWN');
    expect(result.reasons).toContain(reason);
  });

  it('returns CAUTION for endpoint/intersection ambiguity after the roadway is resolved', () => {
    const result = classifyCurbResolution({ ...BASE, endpointAmbiguous: true });
    expect(result.state).toBe('CAUTION');
    expect(result.reasons).toEqual(['endpoint_or_intersection_ambiguous']);
  });

  it.each([
    { reportedAccuracyMeters: -1 },
    { modelErrorMeters: Number.NaN },
    { bestRoadwayDistanceMeters: Number.POSITIVE_INFINITY },
    { signedOffsetMeters: undefined },
  ])('fails closed for invalid numeric evidence: %j', change => {
    expect(classifyCurbResolution({ ...BASE, ...change })).toMatchObject({
      state: 'UNKNOWN', reasons: ['invalid_evidence'],
    });
  });
});
