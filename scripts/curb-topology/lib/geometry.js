'use strict';

const finitePair = value => Array.isArray(value)
  && value.length >= 2
  && Number.isFinite(value[0])
  && Number.isFinite(value[1]);

const normalizeLineGeometry = geometry => {
  if (!geometry || !['LineString', 'MultiLineString'].includes(geometry.type)) {
    throw new TypeError('invalid line geometry type');
  }
  const lines = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
  if (!Array.isArray(lines) || lines.length === 0
    || lines.some(line => !Array.isArray(line) || line.length < 2 || line.some(point => !finitePair(point)))) {
    throw new TypeError('invalid line geometry coordinates');
  }
  return {
    type: 'MultiLineString',
    coordinates: lines.map(line => line.map(point => [point[0], point[1]])),
  };
};

const normalizePointGeometry = geometry => {
  if (!geometry || geometry.type !== 'Point' || !finitePair(geometry.coordinates)) {
    throw new TypeError('invalid point geometry');
  }
  return { type: 'Point', coordinates: [geometry.coordinates[0], geometry.coordinates[1]] };
};

module.exports = { normalizeLineGeometry, normalizePointGeometry };
