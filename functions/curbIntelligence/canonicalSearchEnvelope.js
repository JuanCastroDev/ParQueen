'use strict';

const { createHash } = require('node:crypto');

const SCHEMA = 'canonical-cscl-envelope-1';
const ALGORITHM_VERSION = 'geodesic-bearing-ring-1';
const EARTH_RADIUS_METERS = 6371008.8;
const VERTEX_COUNT = 24;
const NYC = Object.freeze({ minLat: 40.4, maxLat: 40.95, minLng: -74.3, maxLng: -73.65 });

const normalizedNumber = value => Object.is(value, -0) ? 0 : value;
const roundedCoordinate = value => normalizedNumber(Number(value.toFixed(12)));
const validLocation = value => Number.isFinite(value?.lat) && Number.isFinite(value?.lng)
  && value.lat >= NYC.minLat && value.lat <= NYC.maxLat
  && value.lng >= NYC.minLng && value.lng <= NYC.maxLng;

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function canonicalPayload(center, radiusMeters, vertices) {
  return JSON.stringify({
    schemaVersion: SCHEMA,
    coordinateSystem: 'EPSG:4326',
    coordinateOrder: 'longitude-latitude',
    center,
    radiusMeters,
    vertexCount: VERTEX_COUNT,
    coordinatePrecision: 12,
    algorithmVersion: ALGORITHM_VERSION,
    vertices,
  });
}

function buildCanonicalSearchEnvelope(location, radiusMeters) {
  if (!validLocation(location)) throw new TypeError('invalid_location');
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0 || radiusMeters > 500) {
    throw new TypeError('invalid_radius');
  }
  const center = [normalizedNumber(location.lng), normalizedNumber(location.lat)];
  const radius = normalizedNumber(radiusMeters);
  const lat1 = center[1] * Math.PI / 180;
  const lng1 = center[0] * Math.PI / 180;
  const angular = radius / EARTH_RADIUS_METERS;
  const vertices = [];
  for (let index = 0; index < VERTEX_COUNT; index += 1) {
    const bearing = 2 * Math.PI * index / VERTEX_COUNT;
    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angular)
      + Math.cos(lat1) * Math.sin(angular) * Math.cos(bearing));
    const lng2 = lng1 + Math.atan2(
      Math.sin(bearing) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );
    const point = [roundedCoordinate(lng2 * 180 / Math.PI), roundedCoordinate(lat2 * 180 / Math.PI)];
    if (!validLocation({ lng: point[0], lat: point[1] })) throw new TypeError('envelope_outside_nyc');
    vertices.push(point);
  }
  vertices.push([...vertices[0]]);
  const digest = createHash('sha256').update(canonicalPayload(center, radius, vertices)).digest('hex');
  const wkt = `POLYGON((${vertices.map(point => `${point[0]} ${point[1]}`).join(',')}))`;
  return deepFreeze({
    schemaVersion: SCHEMA,
    coordinateSystem: 'EPSG:4326',
    coordinateOrder: 'longitude-latitude',
    center,
    radiusMeters: radius,
    vertexCount: VERTEX_COUNT,
    coordinatePrecision: 12,
    algorithmVersion: ALGORITHM_VERSION,
    vertices,
    digest,
    wkt,
  });
}

function isCanonicalSearchEnvelope(value) {
  if (!value || value.schemaVersion !== SCHEMA || value.coordinateSystem !== 'EPSG:4326'
    || value.coordinateOrder !== 'longitude-latitude' || value.coordinatePrecision !== 12
    || value.algorithmVersion !== ALGORITHM_VERSION
    || value.vertexCount !== VERTEX_COUNT || !Array.isArray(value.vertices)
    || value.vertices.length !== VERTEX_COUNT + 1 || !Array.isArray(value.center)
    || !validLocation({ lng: value.center[0], lat: value.center[1] })
    || !Number.isFinite(value.radiusMeters) || value.radiusMeters <= 0 || value.radiusMeters > 500
    || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)) return false;
  try {
    const expected = buildCanonicalSearchEnvelope({ lng: value.center[0], lat: value.center[1] }, value.radiusMeters);
    return expected.digest === value.digest
      && expected.wkt === value.wkt
      && JSON.stringify(expected.vertices) === JSON.stringify(value.vertices);
  } catch { return false; }
}

module.exports = { buildCanonicalSearchEnvelope, isCanonicalSearchEnvelope, deepFreeze };
