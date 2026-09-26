'use strict';

const { createHash } = require('node:crypto');
const { CSCL_RESOURCE_ID, normalizeBlockFaceId } = require('./curbIdentity');

const CARDINAL_SIDES = new Set(['North', 'South', 'East', 'West']);
const RESOLUTION_METHODS = new Set(['automatic', 'visual_selection']);

const cleanString = value => (typeof value === 'string' && value.trim()
  ? value.trim() : null);
const uniqueStrings = values => [...new Set(values.map(cleanString).filter(Boolean))];

function validSourceVersion(value) {
  return value && value.resourceId === CSCL_RESOURCE_ID && cleanString(value.version);
}

function validGeometry(value) {
  return value?.type === 'MultiLineString'
    && Array.isArray(value.coordinates)
    && value.coordinates.length > 0
    && value.coordinates.every(line => Array.isArray(line) && line.length >= 2
      && line.every(point => Array.isArray(point) && point.length >= 2
        && Number.isFinite(point[0]) && Number.isFinite(point[1])));
}

function createCanonicalCurbIdentity(input) {
  if (!input || !Array.isArray(input.csclRows) || input.csclRows.length === 0) {
    return { ok: false, reason: 'invalid_cscl_rows' };
  }
  if (input.csclSide !== 'LEFT' && input.csclSide !== 'RIGHT') {
    return { ok: false, reason: 'invalid_cscl_side' };
  }
  if (!validSourceVersion(input.sourceVersion)) {
    return { ok: false, reason: 'invalid_source_version' };
  }
  if (input.csclRows.some(row => row?.sourceVersion
    && (!validSourceVersion(row.sourceVersion)
      || row.sourceVersion.version.trim() !== input.sourceVersion.version.trim()))) {
    return { ok: false, reason: 'source_version_mismatch' };
  }

  const faceField = input.csclSide === 'LEFT' ? 'l_blockfaceid' : 'r_blockfaceid';
  const blockFaceIds = input.csclRows.map(row => normalizeBlockFaceId(row?.[faceField]));
  if (blockFaceIds.some(value => value === null)) {
    return { ok: false, reason: 'invalid_block_face_id' };
  }
  if (new Set(blockFaceIds).size !== 1) {
    return { ok: false, reason: 'conflicting_block_face_ids' };
  }
  if (!validGeometry(input.geometry)) return { ok: false, reason: 'invalid_geometry' };
  if (!Number.isFinite(input.streetWidthFeet) || input.streetWidthFeet <= 0) {
    return { ok: false, reason: 'invalid_street_width' };
  }
  if (!CARDINAL_SIDES.has(input.cardinalSide)) {
    return { ok: false, reason: 'invalid_cardinal_side' };
  }
  if (!RESOLUTION_METHODS.has(input.resolutionMethod)) {
    return { ok: false, reason: 'invalid_resolution_method' };
  }

  const supportingGlobalIds = uniqueStrings(input.csclRows.map(row => row?.globalid));
  const selectedGlobalId = cleanString(input.selectedGlobalId) || supportingGlobalIds[0];
  if (!selectedGlobalId || !supportingGlobalIds.includes(selectedGlobalId)) {
    return { ok: false, reason: 'invalid_selected_global_id' };
  }
  const first = input.csclRows[0];
  const borough = cleanString(input.borough);
  const onStreet = cleanString(input.onStreet);
  const fromStreet = cleanString(input.fromStreet);
  const toStreet = cleanString(input.toStreet);
  if (!borough || !onStreet || !fromStreet || !toStreet) {
    return { ok: false, reason: 'invalid_street_context' };
  }

  return {
    ok: true,
    identity: {
      schemaVersion: 2,
      jurisdiction: 'NYC',
      officialBlockFaceId: blockFaceIds[0],
      csclSide: input.csclSide,
      sourceVersion: {
        resourceId: CSCL_RESOURCE_ID,
        version: input.sourceVersion.version.trim(),
      },
      roadway: {
        selectedGlobalId,
        supportingGlobalIds,
        physicalId: cleanString(first?.physicalid),
        b5sc: cleanString(first?.b5sc),
        geometry: input.geometry,
        streetWidthFeet: input.streetWidthFeet,
      },
      names: {
        borough,
        onStreet,
        fromStreet,
        toStreet,
        aliases: uniqueStrings(Array.isArray(input.aliases) ? input.aliases : []),
      },
      side: { cardinal: input.cardinalSide },
      resolution: {
        method: input.resolutionMethod,
        evidenceVersion: 'curb-v2',
      },
    },
  };
}

function digest(parts) {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32);
}

function publicCurbKey(identity) {
  const blockFaceId = normalizeBlockFaceId(identity?.officialBlockFaceId);
  if (identity?.schemaVersion !== 2 || identity?.jurisdiction !== 'NYC'
    || !blockFaceId || !validSourceVersion(identity.sourceVersion)) return null;
  return `curb2_${digest([
    identity.jurisdiction,
    blockFaceId,
    identity.sourceVersion.resourceId,
    identity.sourceVersion.version.trim(),
  ])}`;
}

function candidateNonceDigest(input) {
  if (typeof input?.requestNonceDigest === 'string'
    && /^[a-f0-9]{16}$/.test(input.requestNonceDigest)) return input.requestNonceDigest;
  const requestNonce = cleanString(input?.requestNonce);
  return requestNonce ? digest(['candidate-nonce', requestNonce]).slice(0, 16) : null;
}

function createCandidateToken(input) {
  const nonceDigest = candidateNonceDigest(input);
  if (!input || !/^curb2_[a-f0-9]{32}$/.test(input.publicCurbKey)
    || !nonceDigest
    || !Number.isInteger(input.rank) || input.rank < 0) return null;
  return `candidate2_${nonceDigest}_${digest([
    input.publicCurbKey,
    nonceDigest,
    input.rank,
  ])}`;
}

function candidateTokenNonceDigest(token) {
  const match = typeof token === 'string'
    ? /^candidate2_([a-f0-9]{16})_[a-f0-9]{32}$/.exec(token) : null;
  return match ? match[1] : null;
}

function toPublicCurb(identity) {
  const segmentId = publicCurbKey(identity);
  if (!segmentId || !cleanString(identity?.names?.onStreet)
    || !CARDINAL_SIDES.has(identity?.side?.cardinal)
    || !validGeometry(identity?.roadway?.geometry)) return null;
  return {
    schemaVersion: 2,
    segmentId,
    streetName: identity.names.onStreet,
    sideLabel: identity.side.cardinal,
    geometry: identity.roadway.geometry,
  };
}

module.exports = {
  createCanonicalCurbIdentity,
  publicCurbKey,
  createCandidateToken,
  candidateTokenNonceDigest,
  toPublicCurb,
};
