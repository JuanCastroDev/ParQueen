'use strict';

const { createHash } = require('node:crypto');
const { normalizeBlockFaceId } = require('./curbIdentity');

const COMPASS = Object.freeze([
  'North', 'Northeast', 'East', 'Southeast', 'South', 'Southwest', 'West', 'Northwest',
]);
const OPPOSITE = Object.freeze({
  North: 'South', South: 'North', East: 'West', West: 'East',
  Northeast: 'Southwest', Southwest: 'Northeast',
  Northwest: 'Southeast', Southeast: 'Northwest',
});
const AXIS = Object.freeze({
  North: 'east-west', South: 'east-west', East: 'north-south', West: 'north-south',
});
// Streets within 20 degrees of east-west or north-south keep the original
// axis-aligned drawing. A valid tangent beyond that limit is drawn obliquely.
// A missing or zero-length tangent stays ineligible.
const PRESENTATION_AXIS_LIMIT_DEGREES = 20;

function isSideConfirmationEnabled(dependencies, env = process.env) {
  if (dependencies?.sideConfirmationEnabled === true) return true;
  if (dependencies?.sideConfirmationEnabled === false) return false;
  return env?.CURB_SIDE_CONFIRMATION === 'on';
}

function roundedRoadBearing(tangent) {
  const eastMeters = tangent?.eastMeters;
  const northMeters = tangent?.northMeters;
  if (!Number.isFinite(eastMeters) || !Number.isFinite(northMeters)) return null;
  if (Math.hypot(eastMeters, northMeters) < 1e-6) return null;
  const raw = Math.atan2(eastMeters, northMeters) * 180 / Math.PI;
  return (Math.round((raw % 360 + 360) % 360)) % 360;
}

function axisOffset(bearing) {
  const quadrant = bearing % 90;
  return Math.min(quadrant, 90 - quadrant);
}

function compassLabel(bearing) {
  return COMPASS[Math.round(bearing / 45) % 8];
}

function orientationForTangent(tangent) {
  const bearing = roundedRoadBearing(tangent);
  if (bearing === null) return null;
  const left = compassLabel((bearing + 270) % 360);
  const right = compassLabel((bearing + 90) % 360);
  if (OPPOSITE[left] !== right) return null;
  const sides = Object.freeze({ LEFT: left, RIGHT: right });
  if (axisOffset(bearing) <= PRESENTATION_AXIS_LIMIT_DEGREES) {
    const axis = Math.min(Math.abs(bearing - 90), Math.abs(bearing - 270))
      <= PRESENTATION_AXIS_LIMIT_DEGREES ? 'east-west' : 'north-south';
    if (AXIS[left] !== axis) return null;
    return Object.freeze({ north: 'up', axis, sides });
  }
  return Object.freeze({
    north: 'up',
    axis: 'oblique',
    bearingDegrees: bearing,
    sides,
  });
}

function drivingChoices(records) {
  const codes = (Array.isArray(records) ? records : []).map(record => (
    String(record?.sourceNative?.trafdir || '').trim().toUpperCase()
  ));
  if (!codes.length || codes.some(code => code !== codes[0])) return null;
  // CSCL trafdir is relative to the centerline's digitized vertex order.
  // FT travels with that order. TF travels against it. Anything else, including
  // two-way TW, is not a legal left/right.
  if (codes[0] === 'FT') return Object.freeze({ LEFT: 'left', RIGHT: 'right' });
  if (codes[0] === 'TF') return Object.freeze({ LEFT: 'right', RIGHT: 'left' });
  return null;
}

function cardinalForSide(tangent, csclSide) {
  if (csclSide !== 'LEFT' && csclSide !== 'RIGHT') return null;
  return orientationForTangent(tangent)?.sides[csclSide] ?? null;
}

function consistentOfficialFaces(records) {
  if (!Array.isArray(records) || records.length === 0) return null;
  const collect = field => {
    const ids = records.map(record => normalizeBlockFaceId(record?.[field]));
    if (ids.some(id => !id) || new Set(ids).size !== 1) return null;
    return ids[0];
  };
  const left = collect('leftBlockFaceId');
  const right = collect('rightBlockFaceId');
  if (!left || !right || left === right) return null;
  return Object.freeze({ LEFT: left, RIGHT: right });
}

function firstSideConfirmationEligibilityFailure(evidence) {
  const reasons = Array.isArray(evidence?.decisionReasons) ? evidence.decisionReasons : [];
  if (evidence?.enabled !== true) return 'confirmation_disabled';
  if (evidence?.consideredCount !== 1) return 'considered_count';
  if (evidence?.sideCrossesCenterline !== true) return 'centerline_uncertainty';
  if (evidence?.endpointAmbiguous !== false) return 'endpoint_ambiguity';
  if (evidence?.levelOrRoadbedAmbiguous !== false) return 'roadway_topology';
  if (evidence?.topologySelectable !== true) return 'roadway_topology';
  if (evidence?.sourceEnrichment === true) return 'source_enrichment';
  if (evidence?.decisionState !== 'UNSUPPORTED') return 'classifier_state';
  if (reasons.length !== 1 || reasons[0] !== 'ambiguity_unresolved') return 'classifier_reason';
  if (!evidence?.faces) return 'official_faces';
  if (!evidence?.orientation) return 'street_orientation';
  return null;
}

function sideConfirmationEligible(evidence) {
  return firstSideConfirmationEligibilityFailure(evidence) === null;
}

const finiteCoordinate = value => Number.isFinite(value);
const canonicalNumber = value => Object.is(value, -0) ? 0 : value;

function canonicalGeometry(geometry) {
  if (geometry?.type !== 'MultiLineString' || !Array.isArray(geometry.coordinates)) return null;
  const coordinates = geometry.coordinates.map(line => {
    if (!Array.isArray(line) || line.length < 2) return null;
    const points = line.map(point => {
      if (!Array.isArray(point) || point.length < 2
        || !finiteCoordinate(point[0]) || !finiteCoordinate(point[1])) return null;
      return [canonicalNumber(point[0]), canonicalNumber(point[1])];
    });
    return points.some(point => !point) ? null : points;
  });
  if (!coordinates.length || coordinates.some(line => !line)) return null;
  return { type: 'MultiLineString', coordinates };
}

function stableSideAuthorityDigest(input) {
  // This digest identifies the official roadway. It is not itself a credential.
  // The side-confirmation token binds it with HMAC-SHA256, the authenticated
  // uid, the selected face, and a five-minute lifetime. Possession of a valid
  // token is driver-confirmed selection, not proof the driver is parked there.
  const sourceVersion = input?.sourceVersion;
  const faces = input?.faces;
  const records = Array.isArray(input?.records) ? input.records : [];
  if (sourceVersion?.resourceId !== 'inkn-q76z'
    || typeof sourceVersion.version !== 'string' || !sourceVersion.version.trim()) return null;
  if (!faces?.LEFT || !faces?.RIGHT || faces.LEFT === faces.RIGHT) return null;
  const roadways = records.map(record => {
    const geometry = canonicalGeometry(record?.geometry);
    if (!geometry || typeof record?.globalId !== 'string' || !record.globalId) return null;
    return {
      globalId: record.globalId,
      physicalId: record.sourceNative?.physicalid ?? null,
      b5sc: record.sourceNative?.b5sc ?? null,
      streetWidth: record.sourceNative?.streetwidth ?? null,
      geometry,
    };
  });
  if (!roadways.length || roadways.some(roadway => !roadway)) return null;
  roadways.sort((left, right) => left.globalId < right.globalId ? -1 : left.globalId > right.globalId ? 1 : 0);
  return createHash('sha256').update(JSON.stringify({
    schema: 'side-confirmation-authority-1',
    sourceVersion: { resourceId: sourceVersion.resourceId, version: sourceVersion.version.trim() },
    faces: { LEFT: faces.LEFT, RIGHT: faces.RIGHT },
    roadways,
  })).digest('hex');
}

module.exports = {
  AXIS,
  OPPOSITE,
  PRESENTATION_AXIS_LIMIT_DEGREES,
  cardinalForSide,
  drivingChoices,
  consistentOfficialFaces,
  firstSideConfirmationEligibilityFailure,
  isSideConfirmationEnabled,
  orientationForTangent,
  sideConfirmationEligible,
  stableSideAuthorityDigest,
};
