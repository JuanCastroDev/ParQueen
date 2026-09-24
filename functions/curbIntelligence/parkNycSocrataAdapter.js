'use strict';

const { PARK_NYC_RESOURCE_ID, normalizeParkNycRow } = require('./parkNycNormalizer');

const RESOURCE_ID = PARK_NYC_RESOURCE_ID;
const DATA_URL = `https://data.cityofnewyork.us/resource/${RESOURCE_ID}.json`;
const METADATA_URL = `https://data.cityofnewyork.us/api/views/${RESOURCE_ID}`;
const MAX_RADIUS_METERS = 500;
const DEFAULT_CANDIDATE_LIMIT = 50;
const NYC = Object.freeze({ minLat: 40.4, maxLat: 40.95, minLng: -74.3, maxLng: -73.65 });

/**
 * ParkNYC Payment Regulations (e7yp-wx55) is both:
 *   A. physical meter-face geometry (the_geom MultiLineString, side_of_st)
 *   B. posted payment hours / duration / optional rate (all_vehicl, all_vehi_1, all_vehi_2)
 * Source does not include a live operational meter-status field. Rows that fail
 * normalizeParkNycRow are dropped from the candidate snapshot rather than guessed.
 */

function incomplete(reason, sourceVersion = null) {
  return {
    candidateSnapshot: {
      candidates: [],
      completeness: { state: 'INCOMPLETE', reason },
      sourceVersion,
    },
  };
}

function validFinite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validQuery(query) {
  return validFinite(query?.lat) && query.lat >= NYC.minLat && query.lat <= NYC.maxLat
    && validFinite(query?.lng) && query.lng >= NYC.minLng && query.lng <= NYC.maxLng
    && validFinite(query?.searchRadiusMeters) && query.searchRadiusMeters > 0
    && query.searchRadiusMeters <= MAX_RADIUS_METERS;
}

function isoFromMetadataInstant(value) {
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  if (Number.isInteger(value) && value > 0) {
    const millis = value > 1e12 ? value : value * 1000;
    return new Date(millis).toISOString();
  }
  return null;
}

function sourceVersionFromMetadata(value) {
  if (!value || value.id !== RESOURCE_ID) return null;
  const rowsUpdatedAt = isoFromMetadataInstant(value.rowsUpdatedAt);
  const viewLastModified = isoFromMetadataInstant(value.viewLastModified);
  if (!rowsUpdatedAt || !viewLastModified) return null;
  return { resourceId: RESOURCE_ID, rowsUpdatedAt, viewLastModified };
}

function sameVersion(left, right) {
  return left?.resourceId === right?.resourceId
    && left?.rowsUpdatedAt === right?.rowsUpdatedAt
    && left?.viewLastModified === right?.viewLastModified;
}

function createParkNycCandidateStore(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const getSocrataToken = typeof options.getSocrataToken === 'function'
    ? options.getSocrataToken : () => '';
  const candidateLimit = Number.isInteger(options.candidateLimit) && options.candidateLimit > 0
    && options.candidateLimit <= 200 ? options.candidateLimit : DEFAULT_CANDIDATE_LIMIT;

  async function requestJson(url, requestOptions) {
    const response = await fetchFn(url, requestOptions);
    if (!response?.ok) throw new Error('source_unavailable');
    return response.json();
  }

  return Object.freeze({
    async query(query = {}) {
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

      const normalized = rows.map(value => normalizeParkNycRow(value, before));
      const candidates = normalized.filter(value => value.ok === true).map(value => value.record);
      return {
        candidateSnapshot: {
          candidates,
          completeness: { state: 'COMPLETE', reason: null },
          sourceVersion: before,
        },
      };
    },
  });
}

module.exports = { createParkNycCandidateStore, PARK_NYC_RESOURCE_ID: RESOURCE_ID };
