'use strict';

const { rankRoadwayCandidates } = require('./geometry');
const { classifyCurbResolution } = require('./confidence');
const { groupRoadwayCandidates } = require('./roadwayGrouping');

const NYC = Object.freeze({ minLat: 40.4, maxLat: 40.95, minLng: -74.3, maxLng: -73.65 });

function unknown(reasons, extra = {}) {
  const unique = [...new Set(reasons)];
  return { state: 'UNKNOWN', reasons: unique, fallbackClassifications: fallbackClassifications(unique), ...extra };
}

function fallbackClassifications(reasons) {
  const values = [];
  if (reasons.includes('official_face_missing')) values.push('official_face_missing');
  if (reasons.includes('official_alias_missing')) values.push('official_alias_missing');
  if (reasons.includes('competing_roadways_overlap') || reasons.includes('multilevel_or_roadbed_ambiguity')) {
    values.push('candidate_roadway_ambiguous');
  }
  if (reasons.includes('unsupported_off_network_location')) values.push('unsupported_off_network_location');
  return values;
}

function validInput(input) {
  return input && Number.isFinite(input.lat) && Number.isFinite(input.lng)
    && Number.isFinite(input.accuracyMeters) && input.accuracyMeters >= 0;
}

function inNyc(input) {
  return input.lat >= NYC.minLat && input.lat <= NYC.maxLat
    && input.lng >= NYC.minLng && input.lng <= NYC.maxLng;
}

function searchPolicy(input, options) {
  const modelError = Number.isFinite(options.modelErrorMeters) ? options.modelErrorMeters : 3;
  const desired = Math.max(50, input.accuracyMeters * 3 + 50, modelError * 4 + 30);
  const maximum = Number.isFinite(options.maxSearchRadiusMeters) ? options.maxSearchRadiusMeters : 500;
  const radius = Math.min(maximum, desired);
  const latDelta = radius / 111320;
  const lngDelta = radius / (111320 * Math.cos(input.lat * Math.PI / 180));
  return {
    searchRadiusMeters: radius,
    complete: radius >= desired,
    envelope: { minLat: input.lat - latDelta, maxLat: input.lat + latDelta, minLng: input.lng - lngDelta, maxLng: input.lng + lngDelta },
  };
}

function unusableReason(record) {
  if (record?.sourceVersion?.resourceId !== 'inkn-q76z'
    || typeof record?.sourceVersion?.version !== 'string'
    || !record.sourceVersion.version.trim()) return 'evidence_insufficient';
  if (!record?.sourceNative?.rw_type
    || !record?.sourceNative?.from_level_code
    || !record?.sourceNative?.to_level_code) return 'evidence_insufficient';
  const status = String(record?.sourceNative?.status || '').toUpperCase();
  if (['INACTIVE', 'CLOSED', 'DECOMMISSIONED'].includes(status)) return 'unsupported_roadway_status';
  const nonped = String(record?.sourceNative?.nonped || '').toUpperCase();
  if (nonped && nonped !== 'N') return 'unsupported_nonpedestrian_roadway';
  const accessible = String(record?.sourceNative?.accessible || '').toUpperCase();
  if (['N', 'NO', '0', 'FALSE'].includes(accessible)) return 'unsupported_inaccessible_roadway';
  return null;
}

function geometryPlausible(record, projection, uncertaintyMeters) {
  const widthFeet = Number(record?.sourceNative?.streetwidth);
  if (!Number.isFinite(widthFeet) || widthFeet <= 0) return false;
  const centerlineToCurbMeters = widthFeet * 0.3048 / 2;
  return projection.distanceMeters <= centerlineToCurbMeters + uncertaintyMeters;
}

function rankGroups(point, groups) {
  return groups.map(group => {
    const ranked = rankRoadwayCandidates(point, group.records.map(record => ({
      ...record,
      coordinates: record.geometry?.coordinates,
    })));
    return ranked.length ? { group, best: ranked[0] } : null;
  }).filter(Boolean).sort((a, b) => a.best.projection.distanceMeters - b.best.projection.distanceMeters);
}

function levelSignature(record) {
  return `${record?.sourceNative?.from_level_code || ''}|${record?.sourceNative?.to_level_code || ''}`;
}

async function resolveOfficialCurb(input, options = {}) {
  if (!validInput(input) || !inNyc(input)) return unknown(['unsupported_off_network_location']);
  if (!options.candidateStore || typeof options.candidateStore.queryCandidates !== 'function') {
    return unknown(['evidence_insufficient']);
  }
  const query = searchPolicy(input, options);
  const retrieved = await options.candidateStore.queryCandidates({ lat: input.lat, lng: input.lng, ...query });
  const candidates = Array.isArray(retrieved?.candidates) ? retrieved.candidates : [];
  const complete = retrieved?.completeness?.state === 'COMPLETE';
  if (!candidates.length) {
    return unknown([complete ? 'official_candidate_missing' : 'evidence_insufficient'], {
      candidateCompleteness: retrieved?.completeness || { state: 'INCOMPLETE', reason: 'invalid_store_response' },
    });
  }
  const rejectionReasons = candidates.map(unusableReason).filter(Boolean);
  const usable = candidates.filter(record => !unusableReason(record));
  if (!usable.length) return unknown(rejectionReasons.length ? rejectionReasons : ['evidence_insufficient']);
  if (rejectionReasons.length) {
    return unknown(['evidence_insufficient'], { candidateCompleteness: retrieved.completeness });
  }
  const sourceVersions = new Set(usable.map(record => (
    `${record.sourceVersion.resourceId}:${record.sourceVersion.version.trim()}`
  )));
  if (sourceVersions.size !== 1) {
    return unknown(['evidence_insufficient'], { candidateCompleteness: retrieved.completeness });
  }

  const groups = groupRoadwayCandidates(usable);
  const ranked = rankGroups({ lat: input.lat, lng: input.lng }, groups);
  if (!ranked.length) return unknown(['implausible_geometry']);
  const selected = ranked[0];
  const competitor = ranked[1] || null;
  const projection = selected.best.projection;
  const selectedRecord = selected.best;
  const csclSide = projection.csclSide;
  const selectedBlockFaceId = csclSide === 'LEFT' ? selectedRecord.leftBlockFaceId
    : csclSide === 'RIGHT' ? selectedRecord.rightBlockFaceId : null;
  const modelErrorMeters = Number.isFinite(options.modelErrorMeters) ? options.modelErrorMeters : 3;
  const uncertainty = input.accuracyMeters + modelErrorMeters;
  const endpointAmbiguous = Math.min(
    projection.distanceToComponentStartMeters,
    projection.distanceToComponentEndMeters,
  ) <= uncertainty;
  const groupingAmbiguous = selected.group.reasonCodes.includes('roadway_grouping_unresolved');
  const levelAmbiguous = Boolean(competitor
    && levelSignature(selectedRecord) !== levelSignature(competitor.best)
    && projection.distanceMeters + uncertainty >= competitor.best.projection.distanceMeters - uncertainty);

  const confidence = classifyCurbResolution({
    reportedAccuracyMeters: input.accuracyMeters,
    modelErrorMeters,
    bestRoadwayDistanceMeters: projection.distanceMeters,
    nextRoadwayDistanceMeters: competitor?.best.projection.distanceMeters ?? null,
    signedOffsetMeters: projection.signedOffsetMeters,
    selectedBlockFaceId,
    candidateSetComplete: complete && query.complete,
    geometryPlausible: geometryPlausible(selectedRecord, projection, uncertainty),
    levelOrRoadbedAmbiguous: groupingAmbiguous || levelAmbiguous,
    endpointAmbiguous,
  });

  const result = {
    ...confidence,
    fallbackClassifications: fallbackClassifications(confidence.reasons),
    candidateCompleteness: retrieved.completeness,
    searchRadiusMeters: query.searchRadiusMeters,
    searchEnvelopeComplete: query.complete,
    roadway: {
      selectedRecordGlobalId: selectedRecord.globalId,
      supportingGlobalIds: selected.group.records.map(record => record.globalId),
      distanceMeters: projection.distanceMeters,
      competitorDistanceMeters: competitor?.best.projection.distanceMeters ?? null,
      groupingReasons: [...selected.group.reasonCodes],
    },
    officialIdentity: selectedBlockFaceId ? {
      officialBlockFaceId: selectedBlockFaceId,
      csclSide,
      sourceNative: {
        globalid: selectedRecord.sourceNative?.globalid || selectedRecord.globalId,
        physicalid: selectedRecord.sourceNative?.physicalid || null,
        b5sc: selectedRecord.sourceNative?.b5sc || null,
      },
    } : null,
  };
  return result;
}

module.exports = { resolveOfficialCurb, searchPolicy };
