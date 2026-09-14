'use strict';

function geometryEnvelope(record) {
  const points = record?.geometry?.coordinates?.flat() || [];
  if (!points.length) return null;
  return points.reduce((box, point) => ({
    minLng: Math.min(box.minLng, point[0]), maxLng: Math.max(box.maxLng, point[0]),
    minLat: Math.min(box.minLat, point[1]), maxLat: Math.max(box.maxLat, point[1]),
  }), { minLng: Infinity, maxLng: -Infinity, minLat: Infinity, maxLat: -Infinity });
}

const overlaps = (left, right) => left && right
  && left.minLng <= right.maxLng && left.maxLng >= right.minLng
  && left.minLat <= right.maxLat && left.maxLat >= right.minLat;

const contains = (outer, inner) => outer && inner
  && outer.minLng <= inner.minLng && outer.maxLng >= inner.maxLng
  && outer.minLat <= inner.minLat && outer.maxLat >= inner.maxLat;

function validQuery(query) {
  return query && Number.isFinite(query.lat) && Number.isFinite(query.lng)
    && Number.isFinite(query.searchRadiusMeters) && query.searchRadiusMeters > 0
    && query.envelope && ['minLat', 'maxLat', 'minLng', 'maxLng'].every(key => Number.isFinite(query.envelope[key]))
    && query.envelope.minLat <= query.envelope.maxLat
    && query.envelope.minLng <= query.envelope.maxLng;
}

function createMemoryCandidateStore(records, options = {}) {
  const maxCandidates = Number.isInteger(options.maxCandidates) && options.maxCandidates > 0
    ? options.maxCandidates : 100;
  const indexed = (Array.isArray(records) ? records : []).map(record => ({ record, envelope: geometryEnvelope(record) }))
    .sort((left, right) => String(left.record?.globalId).localeCompare(String(right.record?.globalId)));
  return {
    async queryCandidates(query) {
      if (!validQuery(query)) {
        return { candidates: [], completeness: { state: 'INCOMPLETE', reason: 'invalid_query' } };
      }
      const matching = indexed.filter(item => overlaps(item.envelope, query.envelope)).map(item => item.record);
      const coverageComplete = contains(options.coverageEnvelope, query.envelope);
      if (!coverageComplete) {
        return { candidates: matching.slice(0, maxCandidates), completeness: { state: 'INCOMPLETE', reason: 'coverage_gap' } };
      }
      if (matching.length > maxCandidates) {
        return { candidates: matching.slice(0, maxCandidates), completeness: { state: 'INCOMPLETE', reason: 'candidate_limit_reached' } };
      }
      return { candidates: matching, completeness: { state: 'COMPLETE', reason: null } };
    },
  };
}

module.exports = { createMemoryCandidateStore };
