import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  CURB_RESOLUTION_POLICY,
  classifyCanonicalCurb,
} = require('./curbResolutionPolicy');

const candidate = rank => ({ rank, visuallyDistinct: true });
const BASE = Object.freeze({
  reportedAccuracyMeters: 50,
  sampleCount: 3,
  consistencyMeters: 12,
  selectedBlockFaceId: '0212261301',
  candidateSetComplete: true,
  sourceVersionConsistent: true,
  roadwaySupported: true,
  geometryPlausible: true,
  projectedWithinBounds: true,
  levelOrRoadbedAmbiguous: false,
  streetIdentityConflict: false,
  sideCrossesCenterline: false,
  roadwayIntervalsOverlap: false,
  endpointAmbiguous: false,
  actionableCandidates: [candidate(0)],
});

describe('canonical curb confidence policy', () => {
  it('uses the exact frozen policy values', () => {
    expect(CURB_RESOLUTION_POLICY).toEqual({
      modelErrorMeters: 3,
      maxReportedAccuracyMeters: 50,
      minimumAutomaticSamples: 3,
      maxAutomaticConsistencyMeters: 12,
      endpointUncertaintyMultiplier: 1,
      planimetricDeadlineMs: 900,
      sourceDeadlineMs: 2500,
      maximumCsclCandidates: 100,
      maximumPlanimetricCandidates: 40,
    });
    expect(Object.isFrozen(CURB_RESOLUTION_POLICY)).toBe(true);
  });

  it('supports exactly 50m accuracy with three samples and 12m consistency', () => {
    expect(classifyCanonicalCurb(BASE)).toEqual({
      state: 'SUPPORTED',
      reasons: [],
      candidates: BASE.actionableCandidates,
    });
  });

  it.each([
    ['accuracy over 50m', { reportedAccuracyMeters: 50.001 }, 'reported_accuracy_exceeds_limit'],
    ['fewer than three samples', { sampleCount: 2 }, 'insufficient_samples'],
    ['consistency over 12m', { consistencyMeters: 12.001 }, 'inconsistent_samples'],
    ['incomplete coverage', { candidateSetComplete: false }, 'candidate_coverage_incomplete'],
  ])('rejects %s', (_name, change, reason) => {
    expect(classifyCanonicalCurb({ ...BASE, ...change })).toMatchObject({
      state: 'UNSUPPORTED',
      reasons: expect.arrayContaining([reason]),
      candidates: [],
    });
  });

  it.each([
    ['centerline crossing', { sideCrossesCenterline: true }, 'side_uncertain'],
    ['overlapping roadway intervals', { roadwayIntervalsOverlap: true }, 'competing_roadways_overlap'],
    ['endpoint ambiguity', { endpointAmbiguous: true }, 'endpoint_or_intersection_ambiguous'],
  ])('returns an actionable two-curb ambiguity for %s', (_name, change, reason) => {
    const actionableCandidates = [candidate(0), candidate(1)];
    expect(classifyCanonicalCurb({ ...BASE, ...change, actionableCandidates })).toEqual({
      state: 'AMBIGUOUS',
      reasons: [reason],
      candidates: actionableCandidates,
    });
  });

  it('rejects more than two unresolved actionable candidates', () => {
    expect(classifyCanonicalCurb({
      ...BASE,
      endpointAmbiguous: true,
      actionableCandidates: [candidate(0), candidate(1), candidate(2)],
    })).toEqual({
      state: 'UNSUPPORTED',
      reasons: ['intersection_complex'],
      candidates: [],
    });
  });

  it('rejects two candidates that are not both visually distinguishable', () => {
    expect(classifyCanonicalCurb({
      ...BASE,
      roadwayIntervalsOverlap: true,
      actionableCandidates: [candidate(0), { rank: 1, visuallyDistinct: false }],
    })).toEqual({
      state: 'UNSUPPORTED',
      reasons: ['candidates_not_distinguishable'],
      candidates: [],
    });
  });
});
