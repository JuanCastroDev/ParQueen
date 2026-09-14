'use strict';

const { normalizeBlockFaceId } = require('./curbIdentity');

const isNonnegativeFinite = value => Number.isFinite(value) && value >= 0;

const interval = (distance, uncertainty) => [
  Math.max(0, distance - uncertainty),
  distance + uncertainty,
];

function unknown(reasons, uncertaintyMeters = null, roadwayIntervals = null, sideInterval = null) {
  return { state: 'UNKNOWN', reasons, uncertaintyMeters, roadwayIntervals, sideInterval };
}

function classifyCurbResolution(evidence) {
  if (!evidence || !isNonnegativeFinite(evidence.reportedAccuracyMeters)
    || !isNonnegativeFinite(evidence.modelErrorMeters)
    || !isNonnegativeFinite(evidence.bestRoadwayDistanceMeters)
    || !Number.isFinite(evidence.signedOffsetMeters)
    || (evidence.nextRoadwayDistanceMeters != null
      && !isNonnegativeFinite(evidence.nextRoadwayDistanceMeters))) {
    return unknown(['invalid_evidence']);
  }

  const uncertaintyMeters = evidence.reportedAccuracyMeters + evidence.modelErrorMeters;
  const best = interval(evidence.bestRoadwayDistanceMeters, uncertaintyMeters);
  const next = evidence.nextRoadwayDistanceMeters == null
    ? null : interval(evidence.nextRoadwayDistanceMeters, uncertaintyMeters);
  const roadwayIntervals = { best, next };
  const sideInterval = [
    evidence.signedOffsetMeters - uncertaintyMeters,
    evidence.signedOffsetMeters + uncertaintyMeters,
  ];

  const reasons = [];
  if (!normalizeBlockFaceId(evidence.selectedBlockFaceId)) reasons.push('official_face_missing');
  if (evidence.candidateSetComplete !== true) reasons.push('evidence_insufficient');
  if (evidence.geometryPlausible !== true) reasons.push('implausible_geometry');
  if (evidence.levelOrRoadbedAmbiguous === true) reasons.push('multilevel_or_roadbed_ambiguity');
  if (next && best[1] >= next[0]) reasons.push('competing_roadways_overlap');
  if (reasons.length) return unknown(reasons, uncertaintyMeters, roadwayIntervals, sideInterval);

  const cautionReasons = [];
  if (sideInterval[0] <= 0 && sideInterval[1] >= 0) cautionReasons.push('side_uncertain');
  if (evidence.endpointAmbiguous === true) cautionReasons.push('endpoint_or_intersection_ambiguous');
  return {
    state: cautionReasons.length ? 'CAUTION' : 'SUPPORTED',
    reasons: cautionReasons,
    uncertaintyMeters,
    roadwayIntervals,
    sideInterval,
  };
}

module.exports = { classifyCurbResolution };
