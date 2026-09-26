'use strict';

const { normalizeBlockFaceId } = require('./curbIdentity');

const CURB_RESOLUTION_POLICY = Object.freeze({
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

const finiteNonnegative = value => Number.isFinite(value) && value >= 0;

function unsupported(reasons) {
  return { state: 'UNSUPPORTED', reasons, candidates: [] };
}

function classifyCanonicalCurb(evidence) {
  if (!evidence || typeof evidence !== 'object') return unsupported(['invalid_evidence']);

  const reasons = [];
  if (!finiteNonnegative(evidence.reportedAccuracyMeters)) reasons.push('invalid_reported_accuracy');
  else if (evidence.reportedAccuracyMeters > CURB_RESOLUTION_POLICY.maxReportedAccuracyMeters) {
    reasons.push('reported_accuracy_exceeds_limit');
  }
  if (!Number.isInteger(evidence.sampleCount) || evidence.sampleCount < 0) {
    reasons.push('invalid_sample_count');
  } else if (evidence.sampleCount < CURB_RESOLUTION_POLICY.minimumAutomaticSamples) {
    reasons.push('insufficient_samples');
  }
  if (!finiteNonnegative(evidence.consistencyMeters)) reasons.push('invalid_consistency');
  else if (evidence.consistencyMeters > CURB_RESOLUTION_POLICY.maxAutomaticConsistencyMeters) {
    reasons.push('inconsistent_samples');
  }
  if (!normalizeBlockFaceId(evidence.selectedBlockFaceId)) reasons.push('official_face_missing');
  if (evidence.candidateSetComplete !== true) reasons.push('candidate_coverage_incomplete');
  if (evidence.sourceVersionConsistent !== true) reasons.push('source_version_problem');
  if (evidence.roadwaySupported !== true) reasons.push('unsupported_roadway_status');
  if (evidence.geometryPlausible !== true) reasons.push('implausible_geometry');
  if (evidence.projectedWithinBounds !== true) reasons.push('projection_outside_component');
  if (evidence.levelOrRoadbedAmbiguous === true) reasons.push('multilevel_or_roadbed_ambiguity');
  if (evidence.streetIdentityConflict === true) reasons.push('street_identity_conflict');
  if (reasons.length) return unsupported(reasons);

  const candidates = Array.isArray(evidence.actionableCandidates)
    ? evidence.actionableCandidates : [];
  const ambiguityReasons = [];
  if (evidence.sideCrossesCenterline === true) ambiguityReasons.push('side_uncertain');
  if (evidence.roadwayIntervalsOverlap === true) {
    ambiguityReasons.push('competing_roadways_overlap');
  }
  if (evidence.endpointAmbiguous === true) {
    ambiguityReasons.push('endpoint_or_intersection_ambiguous');
  }
  if (candidates.length > 2) return unsupported(['intersection_complex']);
  if (candidates.length === 2 && candidates.some(value => value?.visuallyDistinct !== true)) {
    return unsupported(['candidates_not_distinguishable']);
  }
  if (ambiguityReasons.length || candidates.length === 2) {
    if (candidates.length !== 2) return unsupported(['ambiguity_unresolved']);
    return {
      state: 'AMBIGUOUS',
      reasons: ambiguityReasons.length ? ambiguityReasons : ['multiple_material_candidates'],
      candidates,
    };
  }
  if (candidates.length !== 1) return unsupported(['canonical_candidate_missing']);
  return { state: 'SUPPORTED', reasons: [], candidates };
}

module.exports = { CURB_RESOLUTION_POLICY, classifyCanonicalCurb };
