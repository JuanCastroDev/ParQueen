'use strict';

const CSCL_MAP_ASSET_ID = '3mf9-qshr';
const CSCL_RESOURCE_ID = 'inkn-q76z';

/**
 * NYC publishes Block Face IDs as a ten-character value. Accepting a Number
 * would make a leading zero unrecoverable, so identity input is string-only.
 */
function normalizeBlockFaceId(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{1,10}$/.test(trimmed) || /^0+$/.test(trimmed)) return null;
  return trimmed.padStart(10, '0');
}

function normalizeCsclSourceVersion(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.mapAssetId !== CSCL_MAP_ASSET_ID || value.resourceId !== CSCL_RESOURCE_ID) return null;
  if (typeof value.version !== 'string' || !value.version.trim()) return null;
  return {
    mapAssetId: CSCL_MAP_ASSET_ID,
    resourceId: CSCL_RESOURCE_ID,
    version: value.version.trim(),
  };
}

const uniqueStrings = values => [...new Set(values.filter(value => typeof value === 'string')
  .map(value => value.trim()).filter(Boolean))];

function createOfficialCurbIdentity(input) {
  if (!input || !Array.isArray(input.csclRows) || input.csclRows.length === 0) {
    return { ok: false, reason: 'invalid_cscl_rows' };
  }
  if (input.csclSide !== 'LEFT' && input.csclSide !== 'RIGHT') {
    return { ok: false, reason: 'invalid_cscl_side' };
  }
  const sourceVersion = normalizeCsclSourceVersion(input.sourceVersion);
  if (!sourceVersion) return { ok: false, reason: 'invalid_source_version' };

  const faceField = input.csclSide === 'LEFT' ? 'l_blockfaceid' : 'r_blockfaceid';
  const rawFaces = input.csclRows.map(row => row && row[faceField]);
  if (rawFaces.every(value => value == null || String(value).trim() === '' || /^0+$/.test(String(value).trim()))) {
    return { ok: false, reason: 'official_face_missing' };
  }
  const normalizedFaces = rawFaces.map(normalizeBlockFaceId);
  if (normalizedFaces.some(face => face === null)) return { ok: false, reason: 'invalid_block_face_id' };
  const distinctFaces = [...new Set(normalizedFaces)];
  if (distinctFaces.length !== 1) return { ok: false, reason: 'conflicting_block_face_ids' };

  const first = input.csclRows[0];
  return {
    ok: true,
    identity: {
      jurisdiction: 'NYC',
      officialBlockFaceId: distinctFaces[0],
      sourceVersion,
      cscl: {
        globalIds: uniqueStrings(input.csclRows.map(row => row && row.globalid)),
        physicalIds: uniqueStrings(input.csclRows.map(row => row && row.physicalid)),
      },
      roadway: {
        boroughCode: typeof first.boroughcode === 'string' ? first.boroughcode : null,
        b5sc: typeof first.b5sc === 'string' ? first.b5sc : null,
        roadwayType: typeof first.rw_type === 'string' ? first.rw_type : null,
        fromLevelCode: typeof first.from_level_code === 'string' ? first.from_level_code : null,
        toLevelCode: typeof first.to_level_code === 'string' ? first.to_level_code : null,
      },
      names: {
        sourceNativePrimary: typeof first.full_street_name === 'string' ? first.full_street_name : null,
        sourceNativeStreet: typeof first.street_name === 'string' ? first.street_name : null,
        sourceNativeLabel: typeof first.stname_label === 'string' ? first.stname_label : null,
        canonicalSearchName: typeof input.canonicalSearchName === 'string'
          ? input.canonicalSearchName.trim() || null : null,
        aliases: [],
      },
      side: {
        cscl: input.csclSide,
        cardinal: typeof input.cardinalSide === 'string' ? input.cardinalSide : null,
      },
      centerlineGeometryReference: {
        globalIds: uniqueStrings(input.csclRows.map(row => row && row.globalid)),
      },
      resolutionEvidence: input.resolutionEvidence && typeof input.resolutionEvidence === 'object'
        ? { ...input.resolutionEvidence } : null,
    },
  };
}

module.exports = {
  CSCL_MAP_ASSET_ID,
  CSCL_RESOURCE_ID,
  normalizeBlockFaceId,
  normalizeCsclSourceVersion,
  createOfficialCurbIdentity,
};
