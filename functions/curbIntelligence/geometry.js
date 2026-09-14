'use strict';

const EARTH_RADIUS_METERS = 6371008.8;
const DEG_TO_RAD = Math.PI / 180;

function isPoint(point) {
  return point && Number.isFinite(point.lat) && Number.isFinite(point.lng)
    && point.lat >= -90 && point.lat <= 90 && point.lng >= -180 && point.lng <= 180;
}

const MAX_LOCAL_DELTA_DEGREES = 1;

function isCoordinate(value, origin) {
  return Array.isArray(value) && value.length >= 2
    && Number.isFinite(value[0]) && value[0] >= -180 && value[0] <= 180
    && Number.isFinite(value[1]) && value[1] >= -90 && value[1] <= 90
    // This is deliberately a local tangent-plane helper. The envelope rejects
    // swapped [lat,lng] and non-local data rather than returning plausible-looking
    // meter values outside the approximation's intended NYC-scale use.
    && Math.abs(value[0] - origin.lng) <= MAX_LOCAL_DELTA_DEGREES
    && Math.abs(value[1] - origin.lat) <= MAX_LOCAL_DELTA_DEGREES;
}

function localProject(origin, coordinate) {
  return {
    x: EARTH_RADIUS_METERS * (coordinate[0] - origin.lng) * DEG_TO_RAD
      * Math.cos(origin.lat * DEG_TO_RAD),
    y: EARTH_RADIUS_METERS * (coordinate[1] - origin.lat) * DEG_TO_RAD,
  };
}

function localUnproject(origin, point) {
  return {
    lat: origin.lat + (point.y / EARTH_RADIUS_METERS) / DEG_TO_RAD,
    lng: origin.lng + (point.x / (EARTH_RADIUS_METERS * Math.cos(origin.lat * DEG_TO_RAD))) / DEG_TO_RAD,
  };
}

function projectPointToSegment(a, b) {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const lengthSquared = vx * vx + vy * vy;
  if (lengthSquared === 0) return null;
  const t = Math.max(0, Math.min(1, (-(a.x * vx + a.y * vy)) / lengthSquared));
  const projected = { x: a.x + t * vx, y: a.y + t * vy };
  const length = Math.sqrt(lengthSquared);
  const signedOffset = (vx * -a.y - vy * -a.x) / length;
  return { t, projected, length, signedOffset, distance: Math.hypot(projected.x, projected.y), vx, vy };
}

/**
 * Projects one public/device point onto CSCL GeoJSON MultiLineString coordinates.
 * GeoJSON is always `[longitude, latitude]`; malformed or reversed input fails closed.
 */
function projectPointToMultiLineString(point, coordinates) {
  if (!isPoint(point) || !Array.isArray(coordinates) || coordinates.length === 0) return null;
  if (coordinates.some(line => !Array.isArray(line) || line.length < 2 || line.some(c => !isCoordinate(c, point)))) {
    return null;
  }

  let best = null;
  coordinates.forEach((line, lineIndex) => {
    const local = line.map(coordinate => localProject(point, coordinate));
    const lengths = local.slice(0, -1).map((a, index) => Math.hypot(
      local[index + 1].x - a.x,
      local[index + 1].y - a.y,
    ));
    const totalLength = lengths.reduce((sum, value) => sum + value, 0);
    let accumulated = 0;
    for (let segmentIndex = 0; segmentIndex < local.length - 1; segmentIndex += 1) {
      const projection = projectPointToSegment(local[segmentIndex], local[segmentIndex + 1]);
      if (!projection) continue;
      const along = accumulated + projection.t * projection.length;
      const candidate = {
        distanceMeters: projection.distance,
        signedOffsetMeters: projection.signedOffset,
        csclSide: Math.abs(projection.signedOffset) < 1e-7
          ? 'CENTERLINE' : projection.signedOffset > 0 ? 'LEFT' : 'RIGHT',
        projectedPoint: localUnproject(point, projection.projected),
        tangent: { eastMeters: projection.vx, northMeters: projection.vy },
        lineIndex,
        segmentIndex,
        segmentFraction: projection.t,
        distanceToComponentStartMeters: along,
        distanceToComponentEndMeters: totalLength - along,
      };
      if (!best || candidate.distanceMeters < best.distanceMeters) best = candidate;
      accumulated += lengths[segmentIndex];
    }
  });
  return best;
}

function rankRoadwayCandidates(point, candidates) {
  if (!Array.isArray(candidates)) return [];
  return candidates.map(candidate => ({
    ...candidate,
    projection: projectPointToMultiLineString(point, candidate && candidate.coordinates),
  })).filter(candidate => candidate.projection)
    .sort((a, b) => a.projection.distanceMeters - b.projection.distanceMeters);
}

module.exports = { projectPointToMultiLineString, rankRoadwayCandidates };
