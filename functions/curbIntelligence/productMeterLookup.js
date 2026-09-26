'use strict';

const { createHash } = require('crypto');
const { createCsclCandidateStore } = require('./csclSocrataAdapter');
const { createParkNycCandidateStore } = require('./parkNycSocrataAdapter');
const { resolveOfficialCurbRuntime } = require('./runtimeCurbResolution');
const { searchPolicy } = require('./curbResolver');
const { associateParkNycRules } = require('./parkNycAssociation');
const { osmNameToDOT } = require('../nycOpenDataNormalizer');
const {
  letterForCardinal,
  toPublicMeterProduct,
  omit,
  unavailable,
  METER_EVENTS,
} = require('./productMeterModel');

const SOURCE_DEADLINE_MS = 2500;
const MAX_PARK_CANDIDATES = 50;
const MAX_CSCL_CANDIDATES = 100;

function bounded(operation, timeoutMs, parentSignal) {
  if (parentSignal?.aborted) return Promise.resolve({ ok: false, reason: 'execution_timeout' });
  const controller = new AbortController();
  let resolveAbort;
  const aborted = new Promise(resolve => { resolveAbort = resolve; });
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
    resolveAbort({ ok: false, reason: 'execution_timeout' });
  };
  parentSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  const skipped = Symbol('bounded-operation-skipped');
  const task = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw skipped;
    return operation(controller.signal);
  }).then(value => ({ ok: true, value }), error => ({
    ok: false,
    reason: error === skipped || controller.signal.aborted ? 'execution_timeout' : 'source_unavailable',
  }));
  return Promise.race([task, aborted]).finally(() => {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abort);
  });
}

function nameSet(values) {
  const names = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim()) continue;
    const raw = value.trim().toUpperCase();
    names.add(raw);
    const dot = osmNameToDOT(value);
    if (typeof dot === 'string' && dot.trim()) names.add(dot.trim().toUpperCase());
  }
  return [...names];
}

function officialBounds(streetContext) {
  const one = typeof streetContext?.crossStreetOne === 'string' ? osmNameToDOT(streetContext.crossStreetOne) : '';
  const two = typeof streetContext?.crossStreetTwo === 'string' ? osmNameToDOT(streetContext.crossStreetTwo) : '';
  if (!one || !two) return null;
  return [one, two];
}

function computeBearing(fromLat, fromLng, toLat, toLng) {
  const dLon = ((toLng - fromLng) * Math.PI) / 180;
  const lat1 = (fromLat * Math.PI) / 180;
  const lat2 = (toLat * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function detectCardinalSide(userLat, userLng, fromLat, fromLng, toLat, toLng, bearing) {
  const dx = toLng - fromLng;
  const dy = toLat - fromLat;
  const cross = dx * (userLat - fromLat) - dy * (userLng - fromLng);
  const isPositive = cross > 0;
  if (bearing < 45) return isPositive ? 'West' : 'East';
  if (bearing < 135) return isPositive ? 'North' : 'South';
  return isPositive ? 'East' : 'West';
}

function parkingSideFromGeometry(location, geometry) {
  const line = geometry?.coordinates?.[0];
  if (!Array.isArray(line) || line.length < 2) return null;
  let fromLng = line[0][0];
  let fromLat = line[0][1];
  let toLng = line[line.length - 1][0];
  let toLat = line[line.length - 1][1];
  let bearing = computeBearing(fromLat, fromLng, toLat, toLng);
  if (bearing > 180) {
    [fromLat, toLat] = [toLat, fromLat];
    [fromLng, toLng] = [toLng, fromLng];
    bearing = computeBearing(fromLat, fromLng, toLat, toLng);
  }
  return detectCardinalSide(location.lat, location.lng, fromLat, fromLng, toLat, toLng, bearing);
}

async function runProductMeterLookup(input = {}, options = {}) {
  if (input.identity) return runCanonicalMeterLookup(input, options);
  const location = input.location;
  if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng)) {
    return unavailable('invalid_location');
  }
  const accuracyMeters = Number.isFinite(location.accuracyMeters) ? location.accuracyMeters : 15;
  const curbInput = { lat: location.lat, lng: location.lng, accuracyMeters };
  const query = searchPolicy(curbInput, { maxSearchRadiusMeters: 150, modelErrorMeters: 3 });
  const overall = new AbortController();
  const csclStore = options.candidateStore || createCsclCandidateStore({
    fetchFn: options.fetchFn,
    getSocrataToken: options.getSocrataToken,
    candidateLimit: MAX_CSCL_CANDIDATES,
  });
  const parkStore = options.parkNycStore || createParkNycCandidateStore({
    fetchFn: options.fetchFn,
    getSocrataToken: options.getSocrataToken,
    candidateLimit: MAX_PARK_CANDIDATES,
  });

  const [curbAttempt, parkAttempt] = await Promise.all([
    bounded(signal => resolveOfficialCurbRuntime(curbInput, {
      candidateStore: csclStore,
      signal,
      maxCandidates: MAX_CSCL_CANDIDATES,
      maxSearchRadiusMeters: 150,
    }), SOURCE_DEADLINE_MS, overall.signal),
    bounded(signal => parkStore.query({
      lat: location.lat,
      lng: location.lng,
      searchRadiusMeters: query.searchRadiusMeters,
      signal,
    }), SOURCE_DEADLINE_MS, overall.signal),
  ]);

  if (!curbAttempt.ok || !curbAttempt.value?.runtimeEvidence || curbAttempt.value.resolution?.state !== 'SUPPORTED') {
    const reason = !curbAttempt.ok ? curbAttempt.reason : (curbAttempt.value?.resolution?.state === 'CAUTION'
      ? 'curb_identity_caution' : 'curb_identity_unresolved');
    return omit(reason, reason === 'execution_timeout' ? METER_EVENTS.OMITTED : METER_EVENTS.RELATIONSHIP_UNCERTAIN);
  }
  if (!parkAttempt.ok || !parkAttempt.value?.candidateSnapshot) {
    return unavailable(parkAttempt.reason === 'execution_timeout' ? 'execution_timeout' : 'park_nyc_unavailable');
  }

  const { resolution, runtimeEvidence } = curbAttempt.value;
  const parkingSide = ['East', 'West', 'North', 'South'].includes(input.parkingSide)
    ? input.parkingSide
    : parkingSideFromGeometry(location, runtimeEvidence.selectedGeometry);
  const sideLetter = letterForCardinal(parkingSide);
  if (!sideLetter) return omit('parking_side_unresolved', METER_EVENTS.RELATIONSHIP_UNCERTAIN);

  const streetContext = input.streetContext || {};
  const selectedNames = [
    runtimeEvidence.selectedRecord?.sourceNative?.full_street_name,
    runtimeEvidence.selectedRecord?.sourceNative?.street_name,
    runtimeEvidence.selectedRecord?.sourceNative?.stname_label,
    streetContext.onStreet,
  ];
  const officialNames = nameSet(selectedNames);
  const bounds = officialBounds(streetContext);
  if (!officialNames.length || !bounds || !streetContext.borough) {
    return omit('street_context_incomplete', METER_EVENTS.NO_MATCH);
  }

  const association = associateParkNycRules({
    curbIdentity: resolution,
    resolvedPoint: runtimeEvidence.resolvedPoint,
    officialNames,
    officialBounds: bounds,
    borough: streetContext.borough,
    side: sideLetter,
    officialRoadwayEvidence: {
      officialBlockFaceId: runtimeEvidence.officialBlockFaceId,
      csclSide: runtimeEvidence.csclSide,
      selectedGeometry: runtimeEvidence.selectedGeometry,
      streetWidthFeet: runtimeEvidence.streetWidthFeet,
      modelUncertaintyMeters: runtimeEvidence.modelUncertaintyMeters,
      candidateCoverageComplete: runtimeEvidence.candidateCoverageComplete === true,
      competingRoadways: runtimeEvidence.competingRoadways,
    },
    candidateSnapshot: parkAttempt.value.candidateSnapshot,
  });

  const publicMeter = toPublicMeterProduct(association, parkingSide);
  if (publicMeter.state === 'supported') {
    publicMeter.hostHint = {
      streetName: streetContext.onStreet || runtimeEvidence.selectedRecord?.sourceNative?.full_street_name || null,
      borough: streetContext.borough,
      fromCross: streetContext.crossStreetOne || null,
      toCross: streetContext.crossStreetTwo || null,
      geometry: runtimeEvidence.selectedGeometry,
      location,
    };
  }
  return publicMeter.state === 'supported' ? publicMeter : publicMeter;
}

function canonicalCurbPoint(identity) {
  const line = identity?.roadway?.geometry?.coordinates?.[0];
  if (!Array.isArray(line) || line.length < 2) return null;
  const first = line[0];
  const last = line[line.length - 1];
  if (![first, last].every(point => Array.isArray(point)
    && Number.isFinite(point[0]) && Number.isFinite(point[1]))) return null;
  const lng = (first[0] + last[0]) / 2;
  const lat = (first[1] + last[1]) / 2;
  const eastMeters = (last[0] - first[0]) * 111320 * Math.cos(lat * Math.PI / 180);
  const northMeters = (last[1] - first[1]) * 111320;
  const length = Math.hypot(eastMeters, northMeters);
  const halfWidthMeters = Number(identity.roadway.streetWidthFeet) * 0.3048 / 2;
  if (!length || !Number.isFinite(halfWidthMeters) || halfWidthMeters <= 0) return null;
  const direction = identity.csclSide === 'LEFT' ? 1 : identity.csclSide === 'RIGHT' ? -1 : 0;
  if (!direction) return null;
  const offsetEast = direction * (-northMeters / length) * halfWidthMeters;
  const offsetNorth = direction * (eastMeters / length) * halfWidthMeters;
  return {
    lat: lat + offsetNorth / 111320,
    lng: lng + offsetEast / (111320 * Math.cos(lat * Math.PI / 180)),
  };
}

async function runCanonicalMeterLookup(input = {}, options = {}) {
  const identity = input.identity;
  const center = canonicalCurbPoint(identity);
  const side = identity?.side?.cardinal;
  const sideLetter = letterForCardinal(side);
  const names = identity?.names;
  if (!center || !sideLetter || !names?.borough || !names?.onStreet
    || !names?.fromStreet || !names?.toStreet) return unavailable('invalid_identity');
  const store = options.parkNycStore || createParkNycCandidateStore({
    fetchFn: options.fetchFn,
    getSocrataToken: options.getSocrataToken,
    candidateLimit: MAX_PARK_CANDIDATES,
  });
  let response;
  try {
    response = await store.query({
      lat: center.lat,
      lng: center.lng,
      searchRadiusMeters: 150,
      signal: input.signal,
    });
  } catch {
    return unavailable('park_nyc_unavailable');
  }
  if (!response?.candidateSnapshot) return unavailable('park_nyc_unavailable');
  const association = associateParkNycRules({
    curbIdentity: {
      state: 'SUPPORTED',
      officialIdentity: {
        officialBlockFaceId: identity.officialBlockFaceId,
        csclSide: identity.csclSide,
      },
    },
    resolvedPoint: center,
    officialNames: nameSet([names.onStreet, ...(names.aliases || [])]),
    officialBounds: [osmNameToDOT(names.fromStreet), osmNameToDOT(names.toStreet)],
    borough: names.borough.toUpperCase(),
    side: sideLetter,
    officialRoadwayEvidence: {
      officialBlockFaceId: identity.officialBlockFaceId,
      csclSide: identity.csclSide,
      selectedGeometry: identity.roadway.geometry,
      streetWidthFeet: identity.roadway.streetWidthFeet,
      modelUncertaintyMeters: 3,
      candidateCoverageComplete: true,
      competingRoadways: [],
    },
    candidateSnapshot: response.candidateSnapshot,
  });
  const product = toPublicMeterProduct(association, side);
  if (product.state === 'supported' && product.product) {
    product.product = { ...product.product, category: 'meter' };
  }
  return product;
}

function meterHostSegmentId(hint, parkingSide) {
  const line = hint?.geometry?.coordinates?.[0];
  const mid = Array.isArray(line) && line.length
    ? line[Math.floor(line.length / 2)]
    : null;
  const material = [
    hint?.borough || '',
    hint?.streetName || '',
    hint?.fromCross || '',
    hint?.toCross || '',
    parkingSide || '',
    mid ? `${mid[0].toFixed(5)},${mid[1].toFixed(5)}` : '',
  ].join('|');
  return `parknyc_${createHash('sha256').update(material).digest('hex').slice(0, 20)}`;
}

module.exports = {
  runProductMeterLookup,
  runCanonicalMeterLookup,
  meterHostSegmentId,
  SOURCE_DEADLINE_MS,
  METER_EVENTS,
};
