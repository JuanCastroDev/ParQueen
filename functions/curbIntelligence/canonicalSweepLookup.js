'use strict';

const { osmNameToDOT, dotSideToCardinal } = require('../nycOpenDataNormalizer');
const { normalizeBlockFaceId } = require('./curbIdentity');
const { CURB_RESOLUTION_POLICY } = require('./curbResolutionPolicy');
const { letterForCardinal } = require('./productMeterModel');

const result = (state, reason, rules = []) => ({ state, reason, rules });
const text = value => (typeof value === 'string' && value.trim()
  ? value.trim().toUpperCase() : null);
const dotName = value => text(osmNameToDOT(value));

function curbContext(identity) {
  const face = normalizeBlockFaceId(identity?.officialBlockFaceId);
  const side = letterForCardinal(identity?.side?.cardinal);
  const names = identity?.names;
  if (identity?.schemaVersion !== 2 || identity?.jurisdiction !== 'NYC'
    || !face || !side || !names) return null;
  const streets = [...new Set([names.onStreet, ...(names.aliases || [])]
    .map(dotName).filter(Boolean))];
  const bounds = [dotName(names.fromStreet), dotName(names.toStreet)];
  return streets.length && bounds.every(Boolean) && text(names.borough)
    ? { face, side, streets, bounds, borough: text(names.borough) } : null;
}

function validSchedule(schedule) {
  return schedule && Array.isArray(schedule.days) && schedule.days.length > 0
    && schedule.days.every(day => typeof day === 'string' && day.trim())
    && typeof schedule.startTime === 'string' && /^\d{2}:\d{2}$/.test(schedule.startTime)
    && typeof schedule.endTime === 'string' && /^\d{2}:\d{2}$/.test(schedule.endTime);
}

function matches(row, curb) {
  const rowBounds = [dotName(row?.fromStreet), dotName(row?.toStreet)];
  const boundsMatch = (rowBounds[0] === curb.bounds[0] && rowBounds[1] === curb.bounds[1])
    || (rowBounds[0] === curb.bounds[1] && rowBounds[1] === curb.bounds[0]);
  const rowSide = text(row?.side);
  const sideMatch = rowSide === curb.side
    || letterForCardinal(dotSideToCardinal(rowSide)) === curb.side;
  return text(row?.borough) === curb.borough
    && curb.streets.includes(dotName(row?.onStreet))
    && boundsMatch && sideMatch;
}

function tuple(row) {
  const cardinal = dotSideToCardinal(row.side);
  return {
    borough: text(row.borough),
    onStreet: dotName(row.onStreet),
    crossStreetOne: dotName(row.fromStreet),
    crossStreetTwo: dotName(row.toStreet),
    compassDirection: letterForCardinal(cardinal) || text(row.side),
  };
}

async function runCanonicalSweepLookup(input = {}, options = {}) {
  const curb = curbContext(input.identity);
  if (!curb) return result('unavailable', 'invalid_identity');
  if (!options.sweepSource || typeof options.sweepSource.query !== 'function') {
    return result('unavailable', 'source_unavailable');
  }
  if (!options.blockfaceResolver || typeof options.blockfaceResolver.resolve !== 'function') {
    return result('unverifiable', 'official_blockface_lookup_unavailable');
  }

  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  input.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CURB_RESOLUTION_POLICY.sourceDeadlineMs);
  try {
    const snapshot = await options.sweepSource.query({ identity: input.identity, signal: controller.signal });
    if (snapshot?.complete !== true || !Array.isArray(snapshot.rows)) {
      return result('unavailable', 'source_unavailable');
    }
    const rows = snapshot.rows.filter(row => matches(row, curb));
    if (!rows.length) return result('unverifiable', 'exact_curb_evidence_missing');
    if (rows.some(row => !Array.isArray(row.schedules)
      || row.schedules.length === 0 || row.schedules.some(schedule => !validSchedule(schedule)))) {
      return result('unverifiable', 'invalid_schedule');
    }
    const resolved = new Map();
    const exactRows = [];
    for (const row of rows) {
      const request = tuple(row);
      const key = JSON.stringify([
        request.borough,
        request.onStreet,
        [request.crossStreetOne, request.crossStreetTwo].sort(),
        request.compassDirection,
      ]);
      if (!resolved.has(key)) {
        resolved.set(key, await options.blockfaceResolver.resolve({ ...request, signal: controller.signal }));
      }
      if (normalizeBlockFaceId(resolved.get(key)?.officialBlockFaceId) === curb.face) {
        exactRows.push(row);
      }
    }
    if (!exactRows.length) return result('unverifiable', 'official_blockface_mismatch');
    const schedules = exactRows.flatMap(row => row.schedules);
    const uniqueSchedules = [...new Map(schedules.map(schedule => [JSON.stringify(schedule), schedule])).values()];
    return result('exact', 'official_blockface_match', [{
      category: 'cleaning',
      source: 'sweepNyc',
      schedules: uniqueSchedules,
    }]);
  } catch {
    return result('unavailable', timedOut || input.signal?.aborted
      ? 'execution_timeout' : 'source_unavailable');
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', abort);
  }
}

module.exports = { runCanonicalSweepLookup };
