'use strict';

const { CURB_RESOLUTION_POLICY } = require('./curbResolutionPolicy');

const RESOURCE_ID = '5xvt-8cbk';
const DATA_URL = `https://data.cityofnewyork.us/resource/${RESOURCE_ID}.json`;
const METADATA_URL = `https://data.cityofnewyork.us/api/views/${RESOURCE_ID}`;
const MAX_RADIUS_METERS = 100;
const NYC = Object.freeze({ minLat: 40.4, maxLat: 40.95, minLng: -74.3, maxLng: -73.65 });

const incomplete = (reason, sourceVersion = null) => ({
  candidates: [],
  completeness: { state: 'INCOMPLETE', reason },
  sourceVersion,
});

const finite = value => typeof value === 'number' && Number.isFinite(value);
const validPoint = point => Array.isArray(point) && point.length >= 2
  && finite(point[0]) && point[0] >= -180 && point[0] <= 180
  && finite(point[1]) && point[1] >= -90 && point[1] <= 90;
const validLine = line => Array.isArray(line) && line.length >= 2 && line.every(validPoint);

function normalizePlanimetricCurbRow(row) {
  if (!row || typeof row !== 'object') return { ok: false, reason: 'invalid_row' };
  const curbId = typeof row.objectid === 'string' || Number.isInteger(row.objectid)
    ? String(row.objectid).trim() : '';
  if (!curbId) return { ok: false, reason: 'invalid_curb_id' };
  const geometry = row.the_geom;
  let coordinates;
  if (geometry?.type === 'LineString' && validLine(geometry.coordinates)) {
    coordinates = [geometry.coordinates];
  } else if (geometry?.type === 'MultiLineString'
    && Array.isArray(geometry.coordinates) && geometry.coordinates.length > 0
    && geometry.coordinates.every(validLine)) {
    coordinates = geometry.coordinates;
  } else {
    return { ok: false, reason: 'invalid_geometry' };
  }
  return {
    ok: true,
    record: {
      curbId,
      geometry: { type: 'MultiLineString', coordinates },
    },
  };
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

function validQuery(query) {
  return finite(query?.lat) && query.lat >= NYC.minLat && query.lat <= NYC.maxLat
    && finite(query?.lng) && query.lng >= NYC.minLng && query.lng <= NYC.maxLng
    && finite(query?.radiusMeters) && query.radiusMeters > 0
    && query.radiusMeters <= MAX_RADIUS_METERS;
}

function createPlanimetricCurbStore(options = {}) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  const setTimer = options.setTimer || setTimeout;
  const clearTimer = options.clearTimer || clearTimeout;
  const deadlineMs = CURB_RESOLUTION_POLICY.planimetricDeadlineMs;
  const maximumCandidates = CURB_RESOLUTION_POLICY.maximumPlanimetricCandidates;

  return Object.freeze({
    async queryCurbs(query = {}) {
      if (!validQuery(query)) return incomplete('invalid_query');
      if (query.signal?.aborted) return incomplete('request_aborted');

      const controller = new AbortController();
      let timedOut = false;
      const abortFromParent = () => controller.abort();
      query.signal?.addEventListener('abort', abortFromParent, { once: true });
      const timer = setTimer(() => {
        timedOut = true;
        controller.abort();
      }, deadlineMs);
      const parameters = new URLSearchParams({
        '$where': `within_circle(the_geom, ${query.lat}, ${query.lng}, ${query.radiusMeters})`,
        '$limit': String(maximumCandidates + 1),
        '$order': ':id',
      });
      const requestOptions = { signal: controller.signal, headers: { Accept: 'application/json' } };

      try {
        const [metadataResponse, dataResponse] = await Promise.all([
          fetchFn(METADATA_URL, requestOptions),
          fetchFn(`${DATA_URL}?${parameters}`, requestOptions),
        ]);
        if (!metadataResponse?.ok || !dataResponse?.ok) return incomplete('source_unavailable');
        const [metadata, rows] = await Promise.all([
          metadataResponse.json(),
          dataResponse.json(),
        ]);
        const sourceVersion = sourceVersionFromMetadata(metadata);
        if (!sourceVersion) return incomplete('invalid_source_version');
        if (!Array.isArray(rows)) return incomplete('source_response_malformed', sourceVersion);
        if (rows.length > maximumCandidates) {
          return incomplete('source_query_truncated', sourceVersion);
        }
        const normalized = rows.map(normalizePlanimetricCurbRow);
        if (normalized.some(result => result.ok !== true)) {
          return incomplete('source_response_malformed', sourceVersion);
        }
        return {
          candidates: normalized.map(result => result.record),
          completeness: { state: 'COMPLETE', reason: null },
          sourceVersion,
        };
      } catch {
        if (timedOut) return incomplete('deadline_exceeded');
        if (query.signal?.aborted) return incomplete('request_aborted');
        return incomplete('source_unavailable');
      } finally {
        clearTimer(timer);
        query.signal?.removeEventListener('abort', abortFromParent);
      }
    },
  });
}

module.exports = { createPlanimetricCurbStore, normalizePlanimetricCurbRow };
