'use strict';

const { createHash } = require('node:crypto');
const { normalizeBlockFaceId } = require('./curbIdentity');

const OPPOSITE = Object.freeze({
  North: 'South', South: 'North', East: 'West', West: 'East',
});
const AXIS = Object.freeze({
  North: 'east-west', South: 'east-west', East: 'north-south', West: 'north-south',
});
// The cross-section draws only a north-up, axis-aligned road. A street more
// than 20 degrees from east-west or north-south is refused rather than drawn
// on the wrong axis. This limit is presentation-only. It does not change the
// official face, the tangent, or any resolution threshold.
const PRESENTATION_AXIS_LIMIT_DEGREES = 20;

function isSideConfirmationEnabled(dependencies, env = process.env) {
  if (dependencies?.sideConfirmationEnabled === true) return true;
  if (dependencies?.sideConfirmationEnabled === false) return false;
  return env?.CURB_SIDE_CONFIRMATION === 'on';
}

function cardinalForSide(tangent, csclSide) {
  const eastMeters = tangent?.eastMeters;
  const northMeters = tangent?.northMeters;
  if (!Number.isFinite(eastMeters) || !Number.isFinite(northMeters)) return null;
  if (Math.hypot(eastMeters, northMeters) < 1e-6) return null;
  if (csclSide !== 'LEFT' && csclSide !== 'RIGHT') return null;
  const left = { east: -northMeters, north: eastMeters };
  const vector = csclSide === 'LEFT' ? left : { east: -left.east, north: -left.north };
  if (Math.abs(vector.north) >= Math.abs(vector.east)) return vector.north >= 0 ? 'North' : 'South';
  return vector.east >= 0 ? 'East' : 'West';
}

function presentationAxis(tangent) {
  const eastMeters = tangent?.eastMeters;
  const northMeters = tangent?.northMeters;
  if (!Number.isFinite(eastMeters) || !Number.isFinite(northMeters)) return null;
  const east = Math.abs(eastMeters);
  const north = Math.abs(northMeters);
  const major = Math.max(east, north);
  if (!(major > 0)) return null;
  const offAxisDegrees = Math.atan2(Math.min(east, north), major) * 180 / Math.PI;
  if (offAxisDegrees > PRESENTATION_AXIS_LIMIT_DEGREES) return null;
  return east >= north ? 'east-west' : 'north-south';
}

function orientationForTangent(tangent) {
  const left = cardinalForSide(tangent, 'LEFT');
  const right = cardinalForSide(tangent, 'RIGHT');
  const axis = presentationAxis(tangent);
  if (!left || !right || !axis || OPPOSITE[left] !== right || AXIS[left] !== axis) return null;
  return Object.freeze({
    north: 'up',
    axis,
    sides: Object.freeze({ LEFT: left, RIGHT: right }),
  });
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

function sideConfirmationEligible(evidence) {
  const reasons = Array.isArray(evidence?.decisionReasons) ? evidence.decisionReasons : [];
  return evidence?.enabled === true
    && evidence.consideredCount === 1
    && evidence.sideCrossesCenterline === true
    && evidence.endpointAmbiguous === false
    && evidence.levelOrRoadbedAmbiguous === false
    && evidence.topologySelectable === true
    && evidence.sourceEnrichment !== true
    && evidence.decisionState === 'UNSUPPORTED'
    && reasons.length === 1
    && reasons[0] === 'ambiguity_unresolved'
    && Boolean(evidence.faces)
    && Boolean(evidence.orientation);
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
  presentationAxis,
  cardinalForSide,
  consistentOfficialFaces,
  isSideConfirmationEnabled,
  orientationForTangent,
  sideConfirmationEligible,
  stableSideAuthorityDigest,
};
