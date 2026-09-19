'use strict';

const { normalizeCsclRow } = require('./csclNormalizer');

const RESOURCE_ID = 'inkn-q76z';
const DATA_URL = `https://data.cityofnewyork.us/resource/${RESOURCE_ID}.json`;
const METADATA_URL = `https://data.cityofnewyork.us/api/views/${RESOURCE_ID}`;
const MAX_RADIUS_METERS = 500;
const DEFAULT_CANDIDATE_LIMIT = 100;
const NYC = Object.freeze({ minLat: 40.4, maxLat: 40.95, minLng: -74.3, maxLng: -73.65 });

function incomplete(reason, sourceVersion = null) {
  return { candidates: [], completeness: { state: 'INCOMPLETE', reason }, sourceVersion };
}

function validFinite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validQuery(query) {
  const envelope = query?.envelope;
  return validFinite(query?.lat) && query.lat >= NYC.minLat && query.lat <= NYC.maxLat
    && validFinite(query?.lng) && query.lng >= NYC.minLng && query.lng <= NYC.maxLng
    && validFinite(query?.searchRadiusMeters) && query.searchRadiusMeters > 0
    && query.searchRadiusMeters <= MAX_RADIUS_METERS
    && envelope && ['minLat', 'maxLat', 'minLng', 'maxLng'].every(key => validFinite(envelope[key]))
    && envelope.minLat <= query.lat && query.lat <= envelope.maxLat
    && envelope.minLng <= query.lng && query.lng <= envelope.maxLng
    && envelope.minLat < envelope.maxLat && envelope.minLng < envelope.maxLng;
}

function sourceVersionFromMetadata(value) {
  if (!value || value.id !== RESOURCE_ID
    || !Number.isInteger(value.rowsUpdatedAt) || value.rowsUpdatedAt <= 0
    || !Number.isInteger(value.viewLastModified) || value.viewLastModified <= 0) return null;
  return {
    resourceId: RESOURCE_ID,
    version: `${value.rowsUpdatedAt}:${value.viewLastModified}`,
  };
}

function sameVersion(left, right) {
  return left?.resourceId === right?.resourceId && left?.version === right?.version;
}

function createCsclCandidateStore(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const getSocrataToken = typeof options.getSocrataToken === 'function'
    ? options.getSocrataToken : () => '';
  const candidateLimit = Number.isInteger(options.candidateLimit) && options.candidateLimit > 0
    && options.candidateLimit <= 500 ? options.candidateLimit : DEFAULT_CANDIDATE_LIMIT;

  async function requestJson(url, requestOptions) {
    const response = await fetchFn(url, requestOptions);
    if (!response?.ok) throw new Error('source_unavailable');
    return response.json();
  }

  return Object.freeze({
    async queryCandidates(query = {}) {
      if (!validQuery(query)) return incomplete('invalid_query');
      if (query.signal?.aborted) return incomplete('request_aborted');

      let beforePayload;
      try {
        beforePayload = await requestJson(METADATA_URL, { signal: query.signal });
      } catch {
        return incomplete(query.signal?.aborted ? 'request_aborted' : 'source_unavailable');
      }
      const before = sourceVersionFromMetadata(beforePayload);
      if (!before) return incomplete('invalid_source_version');

      const parameters = new URLSearchParams({
        '$where': `within_circle(the_geom, ${query.lat}, ${query.lng}, ${query.searchRadiusMeters})`,
        '$limit': String(candidateLimit + 1),
        '$order': ':id',
      });
      const headers = { Accept: 'application/json' };
      const token = getSocrataToken();
      if (typeof token === 'string' && token) headers['X-App-Token'] = token;

      let rows;
      try {
        rows = await requestJson(`${DATA_URL}?${parameters}`, { headers, signal: query.signal });
      } catch {
        return incomplete(query.signal?.aborted ? 'request_aborted' : 'source_unavailable', before);
      }
      if (!Array.isArray(rows)) return incomplete('source_response_malformed', before);
      if (rows.length > candidateLimit) return incomplete('source_query_truncated', before);

      let afterPayload;
      try {
        afterPayload = await requestJson(METADATA_URL, { signal: query.signal });
      } catch {
        return incomplete(query.signal?.aborted ? 'request_aborted' : 'source_unavailable', before);
      }
      const after = sourceVersionFromMetadata(afterPayload);
      if (!after) return incomplete('invalid_source_version', before);
      if (!sameVersion(before, after)) return incomplete('source_changed_during_read', before);

      const normalized = rows.map(value => normalizeCsclRow(value, before));
      if (normalized.some(value => value.ok !== true)) {
        return incomplete('source_response_malformed', before);
      }
      return {
        candidates: normalized.map(value => value.record),
        completeness: { state: 'COMPLETE', reason: null },
        sourceVersion: before,
      };
    },
  });
}

module.exports = { createCsclCandidateStore };
