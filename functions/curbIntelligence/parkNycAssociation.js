'use strict';

const { projectPointToMultiLineString } = require('./geometry');
const { capAssociationState } = require('./ruleConfidence');

const STATES = new Set(['UNKNOWN', 'CAUTION', 'SUPPORTED']);

function unknown(reasonCodes, extra = {}) {
  return { state: 'UNKNOWN', reasonCodes: [...new Set(reasonCodes)], rules: [], ...extra };
}

function sameVersion(left, right) {
  return left?.resourceId === right?.resourceId
    && left?.rowsUpdatedAt === right?.rowsUpdatedAt
    && left?.viewLastModified === right?.viewLastModified;
}

function sameBounds(candidate, expected) {
  if (!Array.isArray(expected) || expected.length !== 2) return false;
  return (candidate.fromStreet === expected[0] && candidate.toStreet === expected[1])
    || (candidate.fromStreet === expected[1] && candidate.toStreet === expected[0]);
}

function semanticKey(candidate) {
  return JSON.stringify({
    zoneId: candidate.zoneId,
    vehicleClass: candidate.vehicleClass,
    passenger: candidate.branches?.passenger,
    commercial: candidate.branches?.commercial,
    rateZone: candidate.rateZone,
  });
}

function direction(tangent) {
  if (!tangent || !Number.isFinite(tangent.eastMeters) || !Number.isFinite(tangent.northMeters)) return null;
  const length = Math.hypot(tangent.eastMeters, tangent.northMeters);
  return length ? { x: tangent.eastMeters / length, y: tangent.northMeters / length } : null;
}

function orientationAlignment(left, right) {
  const a = direction(left);
  const b = direction(right);
  if (!a || !b) return 0;
  return Math.abs(a.x * b.x + a.y * b.y);
}

function geometrySegments(geometry) {
  if (geometry?.type !== 'MultiLineString' || !Array.isArray(geometry.coordinates)) return [];
  const segments = [];
  for (const line of geometry.coordinates) {
    if (!Array.isArray(line)) return [];
    for (let index = 0; index < line.length - 1; index += 1) {
      const start = line[index];
      const end = line[index + 1];
      if (!Array.isArray(start) || !Array.isArray(end)) return [];
      const meanLat = (start[1] + end[1]) / 2;
      const tangent = {
        eastMeters: (end[0] - start[0]) * Math.cos(meanLat * Math.PI / 180),
        northMeters: end[1] - start[1],
      };
      segments.push({
        tangent,
        points: [
          { lng: start[0], lat: start[1] },
          { lng: (start[0] + end[0]) / 2, lat: meanLat },
          { lng: end[0], lat: end[1] },
        ],
      });
    }
  }
  return segments;
}

function validateOfficialRoadwayEvidence(input) {
  const evidence = input?.officialRoadwayEvidence;
  const identity = input?.curbIdentity?.officialIdentity;
  if (!evidence || evidence.candidateCoverageComplete !== true
    || evidence.officialBlockFaceId !== identity?.officialBlockFaceId
    || !['LEFT', 'RIGHT'].includes(evidence.csclSide)
    || evidence.csclSide !== identity?.csclSide
    || evidence.selectedGeometry?.type !== 'MultiLineString'
    || !Array.isArray(evidence.selectedGeometry.coordinates)
    || !Number.isFinite(evidence.streetWidthFeet) || evidence.streetWidthFeet <= 0
    || !Number.isFinite(evidence.modelUncertaintyMeters) || evidence.modelUncertaintyMeters < 0
    || !Array.isArray(evidence.competingRoadways)
    || evidence.competingRoadways.some(roadway => {
      const geometry = roadway?.geometry || roadway;
      return geometry?.type !== 'MultiLineString' || !Array.isArray(geometry.coordinates);
    })) return null;
  return evidence;
}

function compareToRoadway(candidateGeometry, roadwayGeometry) {
  if (roadwayGeometry?.type !== 'MultiLineString' || !Array.isArray(roadwayGeometry.coordinates)) return null;
  const segments = geometrySegments(candidateGeometry);
  if (!segments.length) return null;
  const projections = [];
  for (const segment of segments) {
    for (const point of segment.points) {
      const projection = projectPointToMultiLineString(point, roadwayGeometry.coordinates);
      if (!projection || orientationAlignment(segment.tangent, projection.tangent) < Math.cos(Math.PI / 4)) {
        return null;
      }
      projections.push(projection);
    }
  }
  return {
    maximumDistanceMeters: Math.max(...projections.map(item => item.distanceMeters)),
    meanDistanceMeters: projections.reduce((sum, item) => sum + item.distanceMeters, 0) / projections.length,
    meanSignedOffsetMeters: projections.reduce((sum, item) => sum + item.signedOffsetMeters, 0) / projections.length,
    signedOffsetsMeters: projections.map(item => item.signedOffsetMeters),
    tangent: projections[Math.floor(projections.length / 2)].tangent,
  };
}

function classifySignedSide(offsets, expectedSide, uncertaintyMeters) {
  if (!Array.isArray(offsets) || !offsets.length || !['LEFT', 'RIGHT'].includes(expectedSide)) {
    return 'UNCERTAIN';
  }
  const positive = offsets.some(value => value > uncertaintyMeters);
  const negative = offsets.some(value => value < -uncertaintyMeters);
  if (positive && negative) return 'CROSSING';
  if (!positive && !negative) return 'UNCERTAIN';
  const observed = positive ? 'LEFT' : 'RIGHT';
  return observed === expectedSide ? 'AGREES' : 'CONTRADICTS';
}

function verifyOfficialGeometry(candidate, evidence) {
  const selected = compareToRoadway(candidate.geometry, evidence.selectedGeometry);
  if (!selected) return { state: 'INCOMPATIBLE' };
  const maximumCurbOffsetMeters = evidence.streetWidthFeet * 0.3048 / 2 + evidence.modelUncertaintyMeters;
  if (selected.maximumDistanceMeters > maximumCurbOffsetMeters) return { state: 'INCOMPATIBLE', selected };
  for (const roadway of evidence.competingRoadways) {
    const geometry = roadway?.geometry || roadway;
    const competitor = compareToRoadway(candidate.geometry, geometry);
    if (competitor && competitor.meanDistanceMeters <= selected.meanDistanceMeters + evidence.modelUncertaintyMeters) {
      return { state: 'AMBIGUOUS', selected, competitor };
    }
  }
  return {
    state: 'VERIFIED',
    selected,
    sideState: classifySignedSide(
      selected.signedOffsetsMeters,
      evidence.csclSide,
      evidence.modelUncertaintyMeters,
    ),
  };
}

function sameVerifiedFace(left, right, modelUncertaintyMeters) {
  return orientationAlignment(left.selected.tangent, right.selected.tangent) >= Math.cos(Math.PI / 4)
    && Math.abs(left.selected.meanSignedOffsetMeters - right.selected.meanSignedOffsetMeters) <= modelUncertaintyMeters;
}

function toRule(item, state, reasonCodes) {
  const branch = item.candidate.branches.passenger;
  return {
    regulationId: `park-nyc:${item.candidate.zoneId}`,
    type: 'METER',
    source: 'park_nyc',
    sourceVersion: { ...item.candidate.sourceVersion },
    state,
    associationState: state,
    reasonCodes: [...reasonCodes],
    applicability: 'WHOLE_FACE',
    schedules: branch?.schedule?.ok ? branch.schedule.windows : [],
    vehicleApplicability: { passenger: true, vehicleClass: item.candidate.vehicleClass },
    meterTerms: branch ? {
      maximumMinutes: branch.maximumMinutes,
      schedule: branch.schedule,
      rate: branch.rate,
      maximumCharge: branch.maximumCharge,
      rateZone: item.candidate.rateZone,
    } : null,
    zoneId: item.candidate.zoneId,
    distanceMeters: item.projection.distanceMeters,
    officialRoadwayDistanceMeters: item.officialGeometry?.selected?.maximumDistanceMeters ?? null,
    corroboratingRecordCount: item.corroboratingRecordCount || 1,
    provenance: item.candidate.sourceNative,
    rawEvidence: branch?.sourceNative || null,
  };
}

function associateParkNycRules(input) {
  const curbState = input?.curbIdentity?.state;
  if (!STATES.has(curbState) || !input?.curbIdentity?.officialIdentity?.officialBlockFaceId) {
    return unknown(['official_face_missing']);
  }
  const snapshot = input.candidateSnapshot;
  if (snapshot?.completeness?.state !== 'COMPLETE') return unknown(['candidate_coverage_incomplete']);
  if (!Array.isArray(snapshot.candidates) || !snapshot.candidates.length) return unknown(['official_meter_missing']);
  if (snapshot.sourceVersion?.resourceId !== 'e7yp-wx55') return unknown(['source_version_mismatch']);
  if (snapshot.candidates.some(candidate => !sameVersion(candidate.sourceVersion, snapshot.sourceVersion))) {
    return unknown(['source_version_mismatch']);
  }
  const names = new Set((input.officialNames || []).map(value => String(value).trim().toUpperCase()));
  const borough = String(input.borough || '').trim().toUpperCase();
  const matching = snapshot.candidates.filter(candidate => candidate.borough === borough
    && names.has(candidate.onStreet)
    && candidate.side === String(input.side || '').toUpperCase()
    && sameBounds(candidate, input.officialBounds));
  if (!matching.length) return unknown(['official_meter_face_mismatch']);
  const passenger = matching.filter(candidate => candidate.passengerApplicable && candidate.branches?.passenger);
  if (!passenger.length) return unknown(['no_passenger_meter_rule']);
  const projected = passenger.map(candidate => ({
    candidate,
    projection: projectPointToMultiLineString(input.resolvedPoint, candidate.geometry.coordinates),
  })).filter(item => item.projection).sort((a, b) => a.projection.distanceMeters - b.projection.distanceMeters);
  const plausible = projected.filter(item => item.projection.distanceMeters <= 30);
  if (!plausible.length) return unknown(['meter_geometry_off_network']);
  const capReasons = curbState === 'SUPPORTED' ? [] : [`curb_identity_${curbState.toLowerCase()}`];
  const officialEvidence = validateOfficialRoadwayEvidence(input);
  if (!officialEvidence) {
    const reasonCodes = ['official_meter_geometry_unverified', ...capReasons];
    const state = capAssociationState('CAUTION', curbState);
    const ordered = [...plausible].sort((a, b) => a.candidate.zoneId.localeCompare(b.candidate.zoneId));
    return { state, reasonCodes, rules: ordered.map(item => toRule(item, state, reasonCodes)) };
  }
  const withOfficialGeometry = plausible.map(item => ({
    ...item,
    officialGeometry: verifyOfficialGeometry(item.candidate, officialEvidence),
  }));
  if (withOfficialGeometry.some(item => item.officialGeometry.state === 'AMBIGUOUS')) {
    const reasonCodes = ['official_meter_geometry_ambiguous', ...capReasons];
    return { state: 'UNKNOWN', reasonCodes, rules: withOfficialGeometry.map(item => toRule(item, 'UNKNOWN', reasonCodes)) };
  }
  const verified = withOfficialGeometry.filter(item => item.officialGeometry.state === 'VERIFIED');
  if (!verified.length) {
    const reasonCodes = ['official_meter_geometry_incompatible', ...capReasons];
    const ordered = [...withOfficialGeometry].sort((a, b) => a.candidate.zoneId.localeCompare(b.candidate.zoneId));
    return { state: 'UNKNOWN', reasonCodes, rules: ordered.map(item => toRule(item, 'UNKNOWN', reasonCodes)) };
  }
  if (withOfficialGeometry.some(item => item.officialGeometry.state === 'INCOMPATIBLE')) {
    const reasonCodes = ['competing_meter_faces', ...capReasons];
    const ordered = [...withOfficialGeometry].sort((a, b) => a.candidate.zoneId.localeCompare(b.candidate.zoneId));
    return { state: 'UNKNOWN', reasonCodes, rules: ordered.map(item => toRule(item, 'UNKNOWN', reasonCodes)) };
  }
  if (verified.some(item => item.officialGeometry.sideState === 'CROSSING')) {
    const reasonCodes = ['official_meter_side_crossing', ...capReasons];
    return { state: 'UNKNOWN', reasonCodes, rules: verified.map(item => toRule(item, 'UNKNOWN', reasonCodes)) };
  }
  if (verified.some(item => item.officialGeometry.sideState === 'CONTRADICTS')) {
    const reasonCodes = ['official_meter_side_contradiction', ...capReasons];
    return { state: 'UNKNOWN', reasonCodes, rules: verified.map(item => toRule(item, 'UNKNOWN', reasonCodes)) };
  }
  if (verified.length > 1 && verified.slice(1).some(item => (
    !sameVerifiedFace(verified[0].officialGeometry, item.officialGeometry, officialEvidence.modelUncertaintyMeters)
  ))) {
    const reasonCodes = ['competing_meter_faces', ...capReasons];
    const ordered = [...verified].sort((a, b) => a.candidate.zoneId.localeCompare(b.candidate.zoneId));
    return { state: 'UNKNOWN', reasonCodes, rules: ordered.map(item => toRule(item, 'UNKNOWN', reasonCodes)) };
  }
  const groups = new Map();
  for (const item of verified) {
    const key = semanticKey(item.candidate);
    const current = groups.get(key);
    if (current) current.corroboratingRecordCount += 1;
    else groups.set(key, { ...item, corroboratingRecordCount: 1 });
  }
  const distinct = [...groups.values()].sort((a, b) => a.candidate.zoneId.localeCompare(b.candidate.zoneId));
  if (distinct.some(item => item.candidate.branches.passenger.complete !== true)) {
    const reasonCodes = ['essential_meter_terms_incomplete', ...capReasons];
    return { state: 'UNKNOWN', reasonCodes, rules: distinct.map(item => toRule(item, 'UNKNOWN', reasonCodes)) };
  }
  const incompleteRate = distinct.some(item => item.candidate.branches.passenger.rateComplete !== true);
  const sideUncertain = distinct.some(item => item.officialGeometry.sideState === 'UNCERTAIN');
  const baseState = distinct.length > 1 || incompleteRate || sideUncertain ? 'CAUTION' : 'SUPPORTED';
  const state = capAssociationState(baseState, curbState);
  const reasonCodes = [
    ...(distinct.length > 1 ? ['multiple_meter_zones'] : []),
    ...(incompleteRate ? ['meter_rate_incomplete'] : []),
    ...(sideUncertain ? ['official_meter_side_uncertain'] : []),
    ...capReasons,
  ];
  const rules = distinct.map(item => toRule(item, state, reasonCodes));
  return { state, reasonCodes, rules };
}

module.exports = { associateParkNycRules };
