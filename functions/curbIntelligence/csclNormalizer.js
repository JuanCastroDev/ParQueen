'use strict';

const { normalizeBlockFaceId } = require('./curbIdentity');

const NATIVE_FIELDS = Object.freeze([
  'globalid', 'physicalid', 'l_blockfaceid', 'r_blockfaceid', 'boroughcode', 'b5sc',
  'rw_type', 'full_street_name', 'street_name', 'stname_label', 'trafdir', 'nominaldir',
  'streetwidth', 'from_level_code', 'to_level_code', 'accessible', 'nonped', 'status',
  'modified_date', 'created_date',
]);

const NYC_ENVELOPE = Object.freeze({ minLng: -74.3, maxLng: -73.65, minLat: 40.4, maxLat: 40.95 });

function sourceText(value) {
  return typeof value === 'string' ? value : value == null ? null : String(value);
}

function validCoordinate(value) {
  return Array.isArray(value) && value.length >= 2
    && Number.isFinite(value[0]) && Number.isFinite(value[1])
    && value[0] >= NYC_ENVELOPE.minLng && value[0] <= NYC_ENVELOPE.maxLng
    && value[1] >= NYC_ENVELOPE.minLat && value[1] <= NYC_ENVELOPE.maxLat;
}

function validMultiLineString(value) {
  return value && value.type === 'MultiLineString' && Array.isArray(value.coordinates)
    && value.coordinates.length > 0
    && value.coordinates.every(line => Array.isArray(line) && line.length >= 2
      && line.every(validCoordinate));
}

function normalizeOptionalFace(value) {
  if (value == null || (typeof value === 'string' && !value.trim())) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false };
  const normalized = normalizeBlockFaceId(value);
  return normalized ? { ok: true, value: normalized } : { ok: false };
}

function validSourceVersion(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && value.resourceId === 'inkn-q76z'
    && typeof value.version === 'string' && Boolean(value.version.trim());
}

function normalizeCsclRow(row, sourceVersion) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    return { ok: false, reason: 'invalid_source_row' };
  }
  if (!validSourceVersion(sourceVersion)) return { ok: false, reason: 'invalid_source_version' };
  if (typeof row.globalid !== 'string' || !row.globalid.trim()) {
    return { ok: false, reason: 'missing_globalid' };
  }
  if (!validMultiLineString(row.the_geom)) return { ok: false, reason: 'invalid_geometry' };

  const left = normalizeOptionalFace(row.l_blockfaceid);
  const right = normalizeOptionalFace(row.r_blockfaceid);
  if (!left.ok || !right.ok) return { ok: false, reason: 'invalid_block_face_id' };

  const sourceNative = Object.fromEntries(NATIVE_FIELDS.map(field => [field, sourceText(row[field])]));
  return {
    ok: true,
    sourceVersion: { ...sourceVersion, version: sourceVersion.version.trim() },
    record: {
      globalId: row.globalid.trim(),
      sourceVersion: { ...sourceVersion, version: sourceVersion.version.trim() },
      geometry: { type: 'MultiLineString', coordinates: row.the_geom.coordinates.map(line => line.map(point => [...point])) },
      leftBlockFaceId: left.value,
      rightBlockFaceId: right.value,
      sourceNative,
    },
  };
}

module.exports = { NATIVE_FIELDS, normalizeCsclRow };
