'use strict';

const { resolveOfficialCurb } = require('./curbResolver');

function cloneGeometry(value) {
  if (value?.type !== 'MultiLineString' || !Array.isArray(value.coordinates)) return null;
  return {
    type: 'MultiLineString',
    coordinates: value.coordinates.map(line => line.map(point => [...point])),
  };
}

async function resolveOfficialCurbRuntime(location, options = {}) {
  let retrieved = null;
  const sourceStore = options.candidateStore;
  const candidateStore = sourceStore && typeof sourceStore.queryCandidates === 'function' ? {
    async queryCandidates(query) {
      retrieved = await sourceStore.queryCandidates(query);
      if (Number.isInteger(options.maxCandidates) && options.maxCandidates > 0
        && Array.isArray(retrieved?.candidates)
        && retrieved.candidates.length > options.maxCandidates) {
        retrieved = {
          ...retrieved,
          candidates: retrieved.candidates.slice(0, options.maxCandidates),
          completeness: { state: 'INCOMPLETE', reason: 'candidate_limit_reached' },
        };
      }
      return retrieved;
    },
  } : sourceStore;
  const resolution = await resolveOfficialCurb(location, { ...options, candidateStore });
  const selectedId = resolution?.roadway?.selectedRecordGlobalId;
  const candidates = Array.isArray(retrieved?.candidates) ? retrieved.candidates : [];
  const selected = candidates.find(record => record?.globalId === selectedId);
  const geometry = cloneGeometry(selected?.geometry);
  if (!selected || !geometry || !resolution?.officialIdentity?.officialBlockFaceId) {
    return { resolution, runtimeEvidence: null };
  }

  const supportingIds = new Set(resolution.roadway?.supportingGlobalIds || []);
  const competingRoadways = candidates
    .filter(record => !supportingIds.has(record?.globalId))
    .map(record => cloneGeometry(record?.geometry))
    .filter(Boolean)
    .map(value => ({ geometry: value }));
  const streetWidthFeet = Number(selected.sourceNative?.streetwidth);
  const modelUncertaintyMeters = Number.isFinite(options.modelErrorMeters)
    ? options.modelErrorMeters : 3;

  return {
    resolution,
    runtimeEvidence: {
      nonPersistable: true,
      officialBlockFaceId: resolution.officialIdentity.officialBlockFaceId,
      csclSide: resolution.officialIdentity.csclSide,
      selectedGeometry: geometry,
      competingRoadways,
      streetWidthFeet,
      modelUncertaintyMeters,
      candidateCoverageComplete: retrieved?.completeness?.state === 'COMPLETE'
        && resolution.searchEnvelopeComplete === true,
      candidateCompleteness: retrieved?.completeness || { state: 'INCOMPLETE', reason: 'invalid_store_response' },
      sourceVersion: selected.sourceVersion ? { ...selected.sourceVersion } : null,
      resolvedPoint: { lat: location.lat, lng: location.lng },
      selectedRecord: selected,
    },
  };
}

module.exports = { resolveOfficialCurbRuntime };
