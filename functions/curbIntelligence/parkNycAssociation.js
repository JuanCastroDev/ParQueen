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

function direction(projection) {
  const length = Math.hypot(projection.tangent.eastMeters, projection.tangent.northMeters);
  return length ? { x: projection.tangent.eastMeters / length, y: projection.tangent.northMeters / length } : null;
}

function orientationsCompete(left, right) {
  const a = direction(left);
  const b = direction(right);
  if (!a || !b) return true;
  return Math.abs(a.x * b.x + a.y * b.y) < Math.cos(Math.PI / 4);
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
  if (plausible.length > 1 && plausible.slice(1).some(item => orientationsCompete(plausible[0].projection, item.projection))) {
    const reasonCodes = ['competing_meter_faces', ...capReasons];
    const ordered = [...plausible].sort((a, b) => a.candidate.zoneId.localeCompare(b.candidate.zoneId));
    return { state: 'UNKNOWN', reasonCodes, rules: ordered.map(item => toRule(item, 'UNKNOWN', reasonCodes)) };
  }
  const groups = new Map();
  for (const item of plausible) {
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
  const baseState = distinct.length > 1 || incompleteRate ? 'CAUTION' : 'SUPPORTED';
  const state = capAssociationState(baseState, curbState);
  const reasonCodes = [
    ...(distinct.length > 1 ? ['multiple_meter_zones'] : []),
    ...(incompleteRate ? ['meter_rate_incomplete'] : []),
    ...capReasons,
  ];
  const rules = distinct.map(item => toRule(item, state, reasonCodes));
  return { state, reasonCodes, rules };
}

module.exports = { associateParkNycRules };
