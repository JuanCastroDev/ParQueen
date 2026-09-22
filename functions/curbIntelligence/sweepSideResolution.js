'use strict';

const { projectPointToMultiLineString } = require('./geometry');
const { resolveOfficialCurbRuntime } = require('./runtimeCurbResolution');
const { resolverBorough } = require('./createSweepnycProductEvidence');

const CARDINALS = new Set(['East', 'West', 'North', 'South']);
const OPPOSITE = Object.freeze({
  East: 'West', West: 'East', North: 'South', South: 'North',
});
const COMPASS = Object.freeze({
  East: 'E', West: 'W', North: 'N', South: 'S',
});

function scheduleSides(legacyEvidence) {
  const sides = new Set();
  const rules = Array.isArray(legacyEvidence?.activeRules) ? legacyEvidence.activeRules : [];
  for (const rule of rules) {
    for (const schedule of rule?.schedules || []) {
      const side = typeof schedule?.side === 'string' ? schedule.side.trim() : '';
      if (CARDINALS.has(side)) sides.add(side);
    }
  }
  return [...sides];
}

function cardinalFromCsclSide(csclSide, geometry, location) {
  if (csclSide !== 'LEFT' && csclSide !== 'RIGHT') return null;
  if (!geometry || geometry.type !== 'MultiLineString') return null;
  const projection = projectPointToMultiLineString(location, geometry.coordinates);
  const east = projection?.tangent?.eastMeters;
  const north = projection?.tangent?.northMeters;
  if (!Number.isFinite(east) || !Number.isFinite(north)) return null;
  const leftCardinal = Math.abs(north) >= Math.abs(east)
    ? (north >= 0 ? 'West' : 'East')
    : (east >= 0 ? 'North' : 'South');
  return csclSide === 'LEFT' ? leftCardinal : OPPOSITE[leftCardinal];
}

function printableStreet(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toUpperCase();
  if (!trimmed || Buffer.byteLength(trimmed, 'utf8') > 32) return null;
  for (let index = 0; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return null;
  }
  return trimmed;
}

function resolverTuple(streetContext, parkingSide) {
  const borough = resolverBorough(streetContext?.borough) || streetContext?.borough;
  const onStreet = printableStreet(streetContext?.onStreet);
  const crossStreetOne = printableStreet(streetContext?.crossStreetOne);
  const crossStreetTwo = printableStreet(streetContext?.crossStreetTwo);
  const compassDirection = COMPASS[parkingSide];
  if (!borough || !onStreet || !crossStreetOne || !crossStreetTwo || !compassDirection) {
    return null;
  }
  return { borough, onStreet, crossStreetOne, crossStreetTwo, compassDirection };
}

function unknown(reason) {
  return {
    outcome: 'UNKNOWN',
    skipOrFailureClass: reason,
    curbState: 'UNKNOWN',
    parkingSide: null,
  };
}

async function confirmWithPrivateResolver(tuple, parkingSide, dependencies, signal) {
  const resolver = dependencies?.blockfaceResolver;
  if (!tuple || !resolver || typeof resolver.resolve !== 'function') {
    return { ok: true, parkingSide };
  }
  let resolved;
  try {
    resolved = await resolver.resolve({ ...tuple, signal });
  } catch {
    return { ok: false, result: { outcome: 'FAILED', skipOrFailureClass: 'internal_failure', curbState: 'UNKNOWN', parkingSide: null } };
  }
  if (signal?.aborted) {
    return { ok: false, result: unknown('execution_timeout') };
  }
  if (resolved?.ok === true && resolved.returnCode === '00') {
    return { ok: true, parkingSide };
  }
  if (resolved?.failureClass === 'UPSTREAM_UNAVAILABLE') {
    return { ok: false, result: { outcome: 'FAILED', skipOrFailureClass: 'internal_failure', curbState: 'UNKNOWN', parkingSide: null } };
  }
  if (resolved?.failureClass === 'TIMEOUT' || resolved?.failureClass === 'ABORTED') {
    return { ok: false, result: { outcome: 'FAILED', skipOrFailureClass: 'execution_timeout', curbState: 'UNKNOWN', parkingSide: null } };
  }
  const returnCode = String(resolved?.returnCode || '').trim();
  if (returnCode === '46' || String(resolved?.reasonCode || '').toLowerCase().includes('ambig')) {
    return {
      ok: false,
      result: {
        outcome: 'COMPLETED',
        skipOrFailureClass: 'none',
        curbState: 'CAUTION',
        parkingSide: null,
      },
    };
  }
  return { ok: false, result: unknown('relationship_unknown') };
}

async function runSweepSideResolution(input = {}) {
  const sides = scheduleSides(input.legacyEvidence);
  if (sides.length < 2) {
    return {
      outcome: 'SKIPPED',
      skipOrFailureClass: 'unambiguous_schedule',
      curbState: 'UNKNOWN',
      parkingSide: null,
    };
  }

  const resolveRuntime = input.resolveCurbRuntime || resolveOfficialCurbRuntime;
  let runtime;
  try {
    runtime = await resolveRuntime(input.location, {
      candidateStore: input.dependencies?.candidateStore,
      signal: input.signal,
    });
  } catch {
    return { outcome: 'FAILED', skipOrFailureClass: 'internal_failure', curbState: 'UNKNOWN', parkingSide: null };
  }

  if (input.signal?.aborted) {
    return { outcome: 'FAILED', skipOrFailureClass: 'execution_timeout', curbState: 'UNKNOWN', parkingSide: null };
  }

  const state = runtime?.resolution?.state;
  if (state === 'CAUTION') {
    return {
      outcome: 'COMPLETED',
      skipOrFailureClass: 'none',
      curbState: 'CAUTION',
      parkingSide: null,
    };
  }
  if (state !== 'SUPPORTED' || !runtime?.runtimeEvidence) {
    return unknown('relationship_unknown');
  }

  const parkingSide = cardinalFromCsclSide(
    runtime.runtimeEvidence.csclSide,
    runtime.runtimeEvidence.selectedGeometry,
    input.location,
  );
  if (!parkingSide || !sides.includes(parkingSide)) return unknown('side_unmatched');

  const tuple = resolverTuple(input.streetContext, parkingSide);
  const confirmed = await confirmWithPrivateResolver(tuple, parkingSide, input.dependencies, input.signal);
  if (!confirmed.ok) return confirmed.result;

  return {
    outcome: 'COMPLETED',
    skipOrFailureClass: 'none',
    curbState: 'SUPPORTED',
    parkingSide: confirmed.parkingSide,
  };
}

module.exports = {
  scheduleSides,
  cardinalFromCsclSide,
  resolverTuple,
  runSweepSideResolution,
};
