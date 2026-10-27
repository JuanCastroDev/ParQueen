'use strict';

const { createHash } = require('node:crypto');
const { deepFreeze } = require('./canonicalSearchEnvelope');

const POPULATION_SCHEMA = 'canonical-cscl-population-1';
const NATIVE_IDENTITY_FIELDS = Object.freeze([
  'physicalid', 'b5sc', 'rw_type', 'boroughcode',
  'full_street_name', 'street_name', 'stname_label',
  'from_street', 'to_street', 'streetwidth', 'from_level_code', 'to_level_code',
  'accessible', 'nonped', 'status',
]);

const number = value => Object.is(value, -0) ? 0 : value;
function geometry(value) {
  if (value?.type !== 'MultiLineString' || !Array.isArray(value.coordinates)) return null;
  const coordinates = value.coordinates.map(line => line.map(point => point.map(number)));
  if (!coordinates.length || coordinates.some(line => line.length < 2
    || line.some(point => point.length < 2 || !point.every(Number.isFinite)))) return null;
  return { type: 'MultiLineString', coordinates };
}

function canonicalCandidate(record) {
  const normalizedGeometry = geometry(record?.geometry);
  if (!record || typeof record.globalId !== 'string' || !record.globalId
    || !normalizedGeometry || record?.sourceVersion?.resourceId !== 'inkn-q76z'
    || typeof record?.sourceVersion?.version !== 'string' || !record.sourceVersion.version) return null;
  const identityRecord = {
    globalId: record.globalId,
    geometry: normalizedGeometry,
    leftBlockFaceId: record.leftBlockFaceId ?? null,
    rightBlockFaceId: record.rightBlockFaceId ?? null,
    ...Object.fromEntries(NATIVE_IDENTITY_FIELDS.map(field => (
      [field, record.sourceNative?.[field] ?? null]
    ))),
  };
  const acceptedRecord = {
    globalId: record.globalId,
    sourceVersion: { resourceId: record.sourceVersion.resourceId, version: record.sourceVersion.version },
    geometry: normalizedGeometry,
    leftBlockFaceId: record.leftBlockFaceId ?? null,
    rightBlockFaceId: record.rightBlockFaceId ?? null,
    sourceNative: Object.fromEntries(Object.entries(record.sourceNative || {}).map(([key, value]) => [key, value])),
  };
  return { identityRecord, acceptedRecord };
}

function buildCanonicalCsclPopulation(candidates) {
  if (!Array.isArray(candidates)) return { ok: false, reason: 'population_invalid' };
  const normalized = candidates.map(canonicalCandidate);
  if (normalized.some(value => !value)) return { ok: false, reason: 'population_invalid' };
  normalized.sort((left, right) => {
    if (left.identityRecord.globalId < right.identityRecord.globalId) return -1;
    if (left.identityRecord.globalId > right.identityRecord.globalId) return 1;
    return 0;
  });
  if (normalized.some((value, index) => index > 0
    && value.identityRecord.globalId === normalized[index - 1].identityRecord.globalId)) {
    return { ok: false, reason: 'duplicate_candidate_identity' };
  }
  const representation = { schema: POPULATION_SCHEMA, candidates: normalized.map(value => value.identityRecord) };
  const populationIdentity = createHash('sha256').update(JSON.stringify(representation)).digest('hex');
  return deepFreeze({
    ok: true,
    schema: POPULATION_SCHEMA,
    candidates: normalized.map(value => value.acceptedRecord),
    populationIdentity,
  });
}

module.exports = { POPULATION_SCHEMA, NATIVE_IDENTITY_FIELDS, buildCanonicalCsclPopulation };
