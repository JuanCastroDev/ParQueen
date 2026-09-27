'use strict';

const { normalizeBfi } = require('./bfi');
const { normalizeLineGeometry, normalizePointGeometry } = require('./geometry');

const BOROUGHS = Object.freeze({
  1: 'Manhattan',
  2: 'Bronx',
  3: 'Brooklyn',
  4: 'Queens',
  5: 'Staten Island',
});

const requireSourceVersion = value => {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('source version is required');
  return value;
};

const object = value => value && value.type === 'Feature' ? value.properties : value;
const geometry = value => value && value.type === 'Feature' ? value.geometry : (value.geometry || value.the_geom);
const field = (row, ...names) => {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(row, name)) return row[name];
  }
  return undefined;
};
const nullableString = value => value === null || value === undefined || value === '' ? null : String(value);
const requiredString = (value, label) => {
  const result = nullableString(value);
  if (result === null) throw new TypeError(`${label} is required`);
  return result;
};
const nullableNumber = (value, label) => {
  if (value === null || value === undefined || value === '') return null;
  const result = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(result)) throw new TypeError(`${label} must be finite`);
  return result;
};
const optionalBfi = value => {
  if (value === null || value === undefined || value === '' || value === 0 || value === '0') return null;
  return normalizeBfi(value);
};
const officialCode = (value, width, label) => {
  const result = nullableString(value);
  if (result === null) return null;
  if (!new RegExp(`^[0-9]{${width}}$`).test(result)) throw new TypeError(`${label} must be ${width} digits`);
  return result;
};
const optionalCodeEvidence = (value, width) => {
  const result = nullableString(value);
  if (result === null) return { code: null, status: 'missing' };
  if (!new RegExp(`^[0-9]{${width}}$`).test(result)) return { code: null, status: 'invalid' };
  return { code: result, status: 'present' };
};

const normalizeCsclCenterline = (input, sourceVersion) => {
  const row = object(input);
  if (!row || typeof row !== 'object') throw new TypeError('CSCL row is required');
  const boroughCode = requiredString(field(row, 'BOROUGHCODE', 'borocode', 'boroughcode'), 'borough code');
  if (!BOROUGHS[boroughCode]) throw new TypeError('unsupported borough code');

  return {
    physicalId: requiredString(field(row, 'PHYSICALID', 'physicalid'), 'physical ID'),
    leftBfi: optionalBfi(field(row, 'L_BLOCKFACEID', 'L_BLKFC_ID', 'l_blockfaceid')),
    rightBfi: optionalBfi(field(row, 'R_BLOCKFACEID', 'R_BLKFC_ID', 'r_blockfaceid')),
    boroughCode,
    borough: BOROUGHS[boroughCode],
    displayName: requiredString(field(row, 'FULL_STREET_NAME', 'STNAME_LABEL', 'stname_label', 'street_name'), 'display name'),
    b5sc: officialCode(field(row, 'B5SC', 'b5sc'), 6, 'B5SC'),
    b7sc: officialCode(field(row, 'B7SC', 'b7sc'), 8, 'B7SC'),
    status: requiredString(field(row, 'STATUS', 'status'), 'status'),
    roadwayType: nullableNumber(field(row, 'RW_TYPE', 'rw_type'), 'roadway type'),
    segmentType: nullableString(field(row, 'SEGMENT_TYPE', 'segment_type')),
    fromLevel: nullableNumber(field(row, 'FROM_LEVEL_CODE', 'frm_lvl_co', 'from_level_code'), 'from level'),
    toLevel: nullableNumber(field(row, 'TO_LEVEL_CODE', 'to_lvl_co', 'to_level_code'), 'to level'),
    roadbedEvidence: nullableString(field(row, 'BPHYS_ID', 'bphys_id', 'ROADBED_ID', 'roadbed_id')),
    geometry: normalizeLineGeometry(geometry(input)),
    sourceVersion: requireSourceVersion(sourceVersion),
  };
};

const normalizeCsclNode = (input, sourceVersion) => {
  const row = object(input);
  if (!row || typeof row !== 'object') throw new TypeError('CSCL node is required');
  return {
    nodeId: requiredString(field(row, 'NODEID', 'nodeid'), 'node ID'),
    masterFlag: nullableString(field(row, 'MASTER_FLAG', 'master_flag')),
    safType: nullableString(field(row, 'SAFTYPE', 'saftype')),
    groundElevation: nullableNumber(field(row, 'GROUND_ELEV', 'ground_elev'), 'ground elevation'),
    geometry: normalizePointGeometry(geometry(input)),
    sourceVersion: requireSourceVersion(sourceVersion),
  };
};

const normalizeStreetName = (input, sourceVersion) => {
  const row = object(input);
  if (!row || typeof row !== 'object') throw new TypeError('street name row is required');
  const b7sc = optionalCodeEvidence(field(row, 'B7SC', 'b7sc'), 8);
  return {
    objectId: nullableString(field(row, 'OBJECTID', 'objectid')),
    preModifier: nullableString(field(row, 'PRE_MODIFIER', 'pre_modifier')),
    preDirectional: nullableString(field(row, 'PRE_DIRECTIONAL', 'pre_directional')),
    preType: nullableString(field(row, 'PRE_TYPE', 'pre_type')),
    basicName: requiredString(field(row, 'BASIC_NAME', 'basic_name'), 'basic name'),
    postType: nullableString(field(row, 'POST_TYPE', 'post_type')),
    postDirectional: nullableString(field(row, 'POST_DIRECTIONAL', 'post_directional')),
    postModifier: nullableString(field(row, 'POST_MODIFIER', 'post_modifier')),
    fullName: nullableString(field(row, 'FULL_NAME', 'full_name')),
    b7sc: b7sc.code,
    b7scStatus: b7sc.status,
    joinId: nullableString(field(row, 'JOINID', 'joinid')),
    sourceVersion: requireSourceVersion(sourceVersion),
  };
};

const parseConflated = value => {
  if (value === 0 || value === '0') return false;
  if (value === 1 || value === '1') return true;
  throw new TypeError(`Unknown CONFLATED representation: ${String(value)}`);
};

const normalizePavementEdge = (input, sourceVersion) => {
  if (!input || typeof input !== 'object') throw new TypeError('Pavement Edge row is required');
  return {
    sourceId: requiredString(field(input, 'SOURCE_ID', 'source_id'), 'source ID'),
    featureCode: nullableString(field(input, 'FEAT_CODE', 'feat_code')),
    subCode: nullableString(field(input, 'SUB_CODE', 'sub_code')),
    status: nullableString(field(input, 'STATUS', 'status')),
    blockFaceId: optionalBfi(field(input, 'BLOCKF_ID', 'blockf_id')),
    conflated: parseConflated(field(input, 'CONFLATED', 'conflated')),
    geometry: normalizeLineGeometry(geometry(input)),
    sourceVersion: requireSourceVersion(sourceVersion),
  };
};

module.exports = {
  normalizeCsclCenterline,
  normalizeCsclNode,
  normalizeStreetName,
  normalizePavementEdge,
  parseConflated,
};
