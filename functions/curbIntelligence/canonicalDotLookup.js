'use strict';

const { osmNameToDOT, dotSideToCardinal } = require('../nycOpenDataNormalizer');
const { parseNYCOpenDataRestriction, isCurrentUnvoidedRow } = require('../nycOpenDataRestriction');
const { classifyStreetCleaningSign } = require('./cleaningClassifier');
const { normalizeBlockFaceId } = require('./curbIdentity');
const { CURB_RESOLUTION_POLICY } = require('./curbResolutionPolicy');
const { letterForCardinal } = require('./productMeterModel');

const RESOURCE_ID = 'nfid-uabd';
const DATA_URL = `https://data.cityofnewyork.us/resource/${RESOURCE_ID}.json`;
const MAX_ROWS = 200;

const unavailable = reason => ({ state: 'unavailable', reason, rules: [] });
const text = value => (typeof value === 'string' && value.trim()
  ? value.trim().toUpperCase() : null);
const dotName = value => text(osmNameToDOT(value));

function context(identity) {
  const names = identity?.names;
  const side = letterForCardinal(identity?.side?.cardinal);
  const blockFaceId = normalizeBlockFaceId(identity?.officialBlockFaceId);
  if (identity?.schemaVersion !== 2 || identity?.jurisdiction !== 'NYC'
    || !blockFaceId || !side || !names) return null;
  const onStreetNames = [...new Set([
    names.onStreet,
    ...(Array.isArray(names.aliases) ? names.aliases : []),
  ].map(dotName).filter(Boolean))];
  const bounds = [dotName(names.fromStreet), dotName(names.toStreet)];
  const borough = text(names.borough);
  return onStreetNames.length && bounds.every(Boolean) && borough
    ? { blockFaceId, onStreetNames, bounds, borough, side } : null;
}

function sameBounds(row, bounds) {
  const actual = [dotName(row?.from_street), dotName(row?.to_street)];
  return (actual[0] === bounds[0] && actual[1] === bounds[1])
    || (actual[0] === bounds[1] && actual[1] === bounds[0]);
}

function sameSide(row, expectedSide) {
  const raw = text(row?.side_of_street);
  return raw === expectedSide || letterForCardinal(dotSideToCardinal(raw)) === expectedSide;
}

function wholeFace(row) {
  return /<-+>/.test(String(row?.sign_description || ''));
}

function tupleFor(row) {
  const cardinal = dotSideToCardinal(row.side_of_street);
  return {
    borough: text(row.borough),
    onStreet: dotName(row.on_street),
    crossStreetOne: dotName(row.from_street),
    crossStreetTwo: dotName(row.to_street),
    compassDirection: letterForCardinal(cardinal) || text(row.side_of_street),
  };
}

function tupleKey(tuple) {
  const bounds = [tuple.crossStreetOne, tuple.crossStreetTwo].sort();
  return JSON.stringify([tuple.borough, tuple.onStreet, bounds, tuple.compassDirection]);
}

function defaultDotSource(options) {
  const fetchFn = options.fetchFn || globalThis.fetch;
  return {
    async query({ identity, signal }) {
      const curb = context(identity);
      if (!curb) return { rows: [], completeness: { state: 'INCOMPLETE', reason: 'invalid_identity' } };
      const from = curb.bounds[0].replace(/'/g, "''");
      const to = curb.bounds[1].replace(/'/g, "''");
      const names = curb.onStreetNames.map(name => `'${name.replace(/'/g, "''")}'`).join(',');
      const where = [
        "record_type='Current'",
        'sign_design_voided_on_date IS NULL',
        `upper(borough)='${curb.borough.replace(/'/g, "''")}'`,
        `upper(on_street) in(${names})`,
        `((upper(from_street)='${from}' AND upper(to_street)='${to}')`,
        `OR (upper(from_street)='${to}' AND upper(to_street)='${from}'))`,
      ].join(' AND ');
      const parameters = new URLSearchParams({
        '$where': where,
        '$limit': String(MAX_ROWS + 1),
        '$order': ':id',
      });
      const headers = { Accept: 'application/json' };
      const token = options.getSocrataToken?.();
      if (token) headers['X-App-Token'] = token;
      const response = await fetchFn(`${DATA_URL}?${parameters}`, { headers, signal });
      if (!response?.ok) throw new Error('source_unavailable');
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new Error('source_response_malformed');
      if (rows.length > MAX_ROWS) throw new Error('source_truncated');
      return {
        rows,
        completeness: { state: 'COMPLETE', reason: null },
        sourceVersion: { resourceId: RESOURCE_ID, version: 'live-current' },
      };
    },
  };
}

async function bounded(operation, parentSignal) {
  if (parentSignal?.aborted) return { ok: false, reason: 'execution_timeout' };
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  parentSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, CURB_RESOLUTION_POLICY.sourceDeadlineMs);
  try {
    return { ok: true, value: await operation(controller.signal) };
  } catch {
    return { ok: false, reason: timedOut || parentSignal?.aborted ? 'execution_timeout' : 'source_unavailable' };
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abort);
  }
}

function publicRule(row, curb) {
  const cleaning = classifyStreetCleaningSign(row, {
    street: curb.onStreetNames[0],
    fromCross: curb.bounds[0],
    toCross: curb.bounds[1],
    side: curb.side,
  });
  if (cleaning.classified) {
    return { category: 'cleaning', source: 'dot', schedules: [cleaning.schedule] };
  }
  const parsed = parseNYCOpenDataRestriction(row.sign_description);
  if (!parsed.ok || parsed.extent !== 'whole_face') return null;
  const schedules = parsed.anytime
    ? [{ side: curb.side, days: parsed.days, anytime: true }]
    : parsed.windows.map(window => ({
      side: curb.side,
      days: parsed.days,
      startTime: window.startTime,
      endTime: window.endTime,
      anytime: false,
    }));
  return {
    category: parsed.kind === 'timeLimited' ? 'timeLimit' : 'restriction',
    type: parsed.kind,
    source: 'dot',
    restrictionLevel: parsed.restrictionLevel,
    schedules,
    ...(parsed.kind === 'timeLimited'
      ? { maxStayMinutes: parsed.hourLimit * 60 } : {}),
  };
}

async function runCanonicalDotLookup(input = {}, options = {}) {
  const curb = context(input.identity);
  if (!curb) return unavailable('invalid_identity');
  const dotSource = options.dotSource || defaultDotSource(options);
  const blockfaceResolver = options.blockfaceResolver;
  if (!blockfaceResolver || typeof blockfaceResolver.resolve !== 'function') {
    return unavailable('official_blockface_lookup_unavailable');
  }

  const attempt = await bounded(async (signal) => {
    const snapshot = await dotSource.query({ identity: input.identity, signal });
    if (snapshot?.completeness?.state !== 'COMPLETE' || !Array.isArray(snapshot.rows)) {
      return unavailable('candidate_source_incomplete');
    }
    const rows = snapshot.rows.filter(row => isCurrentUnvoidedRow(row)
      && curb.onStreetNames.includes(dotName(row.on_street))
      && sameBounds(row, curb.bounds)
      && sameSide(row, curb.side)
      && wholeFace(row));
    const tupleResults = new Map();
    const matchingRows = [];
    let mismatch = false;
    for (const row of rows) {
      const tuple = tupleFor(row);
      const key = tupleKey(tuple);
      if (!tupleResults.has(key)) {
        tupleResults.set(key, await blockfaceResolver.resolve({ ...tuple, signal }));
      }
      const resolvedFace = normalizeBlockFaceId(tupleResults.get(key)?.officialBlockFaceId);
      if (resolvedFace === curb.blockFaceId) matchingRows.push(row);
      else mismatch = true;
    }
    const rules = matchingRows.map(row => publicRule(row, curb)).filter(Boolean);
    const uniqueRules = [...new Map(rules.map(rule => [JSON.stringify(rule), rule])).values()];
    return {
      state: 'complete',
      rules: uniqueRules,
      reasons: mismatch ? ['official_blockface_mismatch'] : [],
    };
  }, input.signal);
  return attempt.ok ? attempt.value : unavailable(attempt.reason);
}

module.exports = { runCanonicalDotLookup };
