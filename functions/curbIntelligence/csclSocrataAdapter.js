'use strict';

const { normalizeCsclRow } = require('./csclNormalizer');
const { isCanonicalSearchEnvelope } = require('./canonicalSearchEnvelope');

const RESOURCE_ID = 'inkn-q76z';
const DATA_URL = `https://data.cityofnewyork.us/resource/${RESOURCE_ID}.json`;
const SODA3_URL = `https://data.cityofnewyork.us/api/v3/views/${RESOURCE_ID}/query.json`;
const METADATA_URL = `https://data.cityofnewyork.us/api/views/${RESOURCE_ID}`;
const DEMO_PROJECT_ID = 'demo-parkqueen-functions-test';
const MAX_RADIUS_METERS = 500;
const DEFAULT_CANDIDATE_LIMIT = 100;
const NYC = Object.freeze({ minLat: 40.4, maxLat: 40.95, minLng: -74.3, maxLng: -73.65 });

function incomplete(reason, sourceVersion = null, stageTiming = null) {
  return { candidates: [], completeness: { state: 'INCOMPLETE', reason }, sourceVersion, stageTiming };
}

function validFinite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validQueryInput(query) {
  return validFinite(query?.lat) && query.lat >= NYC.minLat && query.lat <= NYC.maxLat
    && validFinite(query?.lng) && query.lng >= NYC.minLng && query.lng <= NYC.maxLng
    && validFinite(query?.searchRadiusMeters) && query.searchRadiusMeters > 0
    && query.searchRadiusMeters <= MAX_RADIUS_METERS;
}

function validEnvelopeBinding(query) {
  const envelope = query?.canonicalEnvelope;
  return isCanonicalSearchEnvelope(envelope)
    && envelope.center[1] === query.lat
    && envelope.center[0] === query.lng
    && envelope.radiusMeters === query.searchRadiusMeters;
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

function demoQaEnabled() {
  const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT;
  return process.env.FUNCTIONS_EMULATOR === 'true' && project === DEMO_PROJECT_ID;
}

function spatialProtocol(options) {
  if (options.spatialProtocol === 'soda2' || options.spatialProtocol === 'soda3') return options.spatialProtocol;
  if (process.env.CURB_CSCL_SPATIAL !== 'soda3' || !demoQaEnabled()) return 'soda2';
  return 'soda3';
}

function usableToken(value) {
  return typeof value === 'string' && value.trim() && value.trim() !== 'local-demo-not-a-secret'
    ? value.trim() : '';
}

function createCsclCandidateStore(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const getSocrataToken = typeof options.getSocrataToken === 'function'
    ? options.getSocrataToken : () => '';
  const protocol = spatialProtocol(options);
  const includeSystem = options.includeSystem === true;
  const includeSynthetic = options.includeSynthetic === true;
  const candidateLimit = Number.isInteger(options.candidateLimit) && options.candidateLimit > 0
    && options.candidateLimit <= 500 ? options.candidateLimit : DEFAULT_CANDIDATE_LIMIT;

  async function requestJson(url, requestOptions) {
    const response = await fetchFn(url, requestOptions);
    if (!response?.ok) throw new Error('source_unavailable');
    try {
      return await response.json();
    } catch {
      const error = new Error('source_response_malformed');
      error.reason = 'source_response_malformed';
      throw error;
    }
  }

  return Object.freeze({
    async queryCandidates(query = {}) {
      if (!validQueryInput(query)) return incomplete('invalid_query');
      if (!validEnvelopeBinding(query)) return incomplete('invalid_envelope');
      if (query.signal?.aborted) return incomplete('request_aborted');

      const stageTiming = {
        metadataBeforeMs: null,
        spatialMs: null,
        metadataAfterMs: null,
        spatialAttempts: null,
        spatialProtocol: protocol,
      };
      const metadataStarted = Date.now();
      let beforePayload;
      try {
        beforePayload = await requestJson(METADATA_URL, { signal: query.signal });
      } catch {
        stageTiming.metadataBeforeMs = Date.now() - metadataStarted;
        return incomplete(query.signal?.aborted ? 'request_aborted' : 'source_unavailable', null, stageTiming);
      }
      stageTiming.metadataBeforeMs = Date.now() - metadataStarted;
      if (query.signal?.aborted) return incomplete('request_aborted', null, stageTiming);
      const before = sourceVersionFromMetadata(beforePayload);
      if (!before) return incomplete('invalid_source_version', null, stageTiming);

      const parameters = new URLSearchParams({
        '$where': `intersects(the_geom,'${query.canonicalEnvelope.wkt}')`,
        '$limit': String(candidateLimit + 1),
        '$order': 'globalid',
      });
      const headers = { Accept: 'application/json' };
      const token = usableToken(getSocrataToken());
      if (token) headers['X-App-Token'] = token;

      let rows;
      let dataFailure = null;
      const spatialStarted = Date.now();
      try {
        if (protocol === 'soda3') {
          if (!token) throw Object.assign(new Error('source_unavailable'), { reason: 'source_unavailable' });
          const limit = candidateLimit + 1;
          const payload = await requestJson(SODA3_URL, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              query: `SELECT * WHERE intersects(the_geom, '${query.canonicalEnvelope.wkt}') ORDER BY globalid LIMIT ${limit}`,
              page: { pageNumber: 1, pageSize: limit },
              includeSystem,
              includeSynthetic,
            }),
            signal: query.signal,
          });
          if (!Array.isArray(payload)) {
            throw Object.assign(new Error('source_response_malformed'), { reason: 'source_response_malformed' });
          }
          rows = payload;
        } else {
          rows = await requestJson(`${DATA_URL}?${parameters}`, { headers, signal: query.signal });
        }
        stageTiming.spatialAttempts = 1;
      } catch (error) {
        dataFailure = error?.reason === 'source_response_malformed'
          ? 'source_response_malformed' : 'source_unavailable';
      }
      stageTiming.spatialMs = Date.now() - spatialStarted;
      if (query.signal?.aborted) return incomplete('request_aborted', before, stageTiming);
      if (!dataFailure && !Array.isArray(rows)) dataFailure = 'source_response_malformed';
      let afterPayload;
      let afterFailure = null;
      const afterStarted = Date.now();
      try {
        afterPayload = await requestJson(METADATA_URL, { signal: query.signal });
      } catch {
        afterFailure = 'source_unavailable';
      }
      stageTiming.metadataAfterMs = Date.now() - afterStarted;
      if (query.signal?.aborted) return incomplete('request_aborted', before, stageTiming);
      if (dataFailure) return incomplete(dataFailure, before, stageTiming);
      if (afterFailure) return incomplete(afterFailure, before, stageTiming);
      const after = sourceVersionFromMetadata(afterPayload);
      if (!after) return incomplete('invalid_source_version', before, stageTiming);
      if (!sameVersion(before, after)) return incomplete('source_changed_during_read', before, stageTiming);
      if (rows.length > candidateLimit) return incomplete('source_query_truncated', before, stageTiming);

      const normalized = rows.map(value => normalizeCsclRow(value, before));
      if (normalized.some(value => value.ok !== true)) {
        return incomplete('invalid_candidate_row', before, stageTiming);
      }
      return {
        candidates: normalized.map(value => value.record),
        completeness: { state: 'COMPLETE', reason: null },
        sourceVersion: before,
        retrievalContractVersion: 'canonical-cscl-intersects-1',
        envelope: query.canonicalEnvelope,
        envelopeDigest: query.canonicalEnvelope.digest,
        stageTiming,
      };
    },
  });
}

module.exports = { createCsclCandidateStore };
