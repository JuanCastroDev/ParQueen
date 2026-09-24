'use strict';

const { osmNameToDOT, dotSideToCardinal, BOROUGH_CODE_TO_NAME } = require('../nycOpenDataNormalizer');
const {
  parseNYCOpenDataRestriction,
  isCurrentUnvoidedRow,
} = require('../nycOpenDataRestriction');
const { letterForCardinal } = require('./productMeterModel');
const { RESTRICTION_EVENTS } = require('./productRestrictionModel');

const RESOURCE_ID = 'nfid-uabd';
const DATA_URL = `https://data.cityofnewyork.us/resource/${RESOURCE_ID}.json`;
const SOURCE_DEADLINE_MS = 2500;
const MAX_ROWS = 200;

function socrataBorough(value) {
  const trimmed = String(value || '').trim();
  if (BOROUGH_CODE_TO_NAME[trimmed]) return BOROUGH_CODE_TO_NAME[trimmed];
  const upper = trimmed.toUpperCase();
  const names = {
    MANHATTAN: 'Manhattan', BRONX: 'Bronx', BROOKLYN: 'Brooklyn', QUEENS: 'Queens',
    'STATEN ISLAND': 'Staten Island',
  };
  return names[upper] || trimmed;
}

function omit(reason, event) {
  return { state: 'omitted', reason, event, rules: [] };
}

function unavailable(reason) {
  return { state: 'unavailable', reason, event: RESTRICTION_EVENTS.OMITTED, rules: [] };
}

function sameBounds(row, bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 2) return false;
  const from = osmNameToDOT(row.from_street);
  const to = osmNameToDOT(row.to_street);
  return (from === bounds[0] && to === bounds[1]) || (from === bounds[1] && to === bounds[0]);
}

function bounded(operation, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return Promise.resolve()
    .then(() => operation(controller.signal))
    .finally(() => clearTimeout(timer));
}

async function queryCurrentSigns({ borough, onStreet, bounds, signal, fetchFn, getSocrataToken }) {
  const from = bounds[0].replace(/'/g, "''");
  const to = bounds[1].replace(/'/g, "''");
  const street = onStreet.replace(/'/g, "''");
  const boro = borough.replace(/'/g, "''");
  const where = [
    "record_type='Current'",
    'sign_design_voided_on_date IS NULL',
    `borough='${boro}'`,
    `on_street='${street}'`,
    `((from_street='${from}' AND to_street='${to}') OR (from_street='${to}' AND to_street='${from}'))`,
  ].join(' AND ');
  const params = new URLSearchParams({
    '$where': where,
    '$limit': String(MAX_ROWS + 1),
    '$order': ':id',
  });
  const headers = { Accept: 'application/json' };
  const token = typeof getSocrataToken === 'function' ? getSocrataToken() : '';
  if (token) headers['X-App-Token'] = token;
  const response = await fetchFn(`${DATA_URL}?${params}`, { headers, signal });
  if (!response?.ok) throw new Error('source_unavailable');
  const rows = await response.json();
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new Error('source_truncated');
  return rows;
}

function toPublicRule(parsed, side) {
  const schedules = parsed.anytime
    ? [{ side, days: parsed.days, anytime: true }]
    : parsed.windows.map(window => ({
      side,
      days: parsed.days,
      startTime: window.startTime,
      endTime: window.endTime,
      anytime: false,
    }));
  const rule = {
    type: parsed.kind,
    source: 'nyc_open_data',
    restrictionLevel: parsed.restrictionLevel,
    schedules,
  };
  if (parsed.kind === 'timeLimited' && Number.isInteger(parsed.hourLimit)) {
    rule.meterTerms = { maxStayMinutes: parsed.hourLimit * 60 };
  }
  return rule;
}

function fingerprint(rule, schedule) {
  return JSON.stringify({
    type: rule.type,
    days: schedule.days,
    startTime: schedule.startTime || null,
    endTime: schedule.endTime || null,
    anytime: Boolean(schedule.anytime),
  });
}

async function runProductRestrictionLookup(input = {}, options = {}) {
  const streetContext = input.streetContext || {};
  const parkingSide = ['East', 'West', 'North', 'South'].includes(input.parkingSide)
    ? input.parkingSide : null;
  if (!parkingSide) return omit('parking_side_unresolved', RESTRICTION_EVENTS.UNCERTAIN_SIDE);
  const borough = socrataBorough(streetContext.borough);
  const onStreet = osmNameToDOT(streetContext.onStreet);
  const bounds = [
    osmNameToDOT(streetContext.crossStreetOne),
    osmNameToDOT(streetContext.crossStreetTwo),
  ];
  if (!borough || !onStreet || !bounds[0] || !bounds[1]) {
    return omit('street_context_incomplete', RESTRICTION_EVENTS.NO_MATCH);
  }

  const fetchFn = options.fetchFn || globalThis.fetch;
  let rows;
  try {
    rows = await bounded(
      signal => queryCurrentSigns({
        borough,
        onStreet,
        bounds,
        signal,
        fetchFn,
        getSocrataToken: options.getSocrataToken,
      }),
      SOURCE_DEADLINE_MS,
    );
  } catch (error) {
    const reason = String(error?.message || '') === 'source_truncated' ? 'source_truncated' : 'source_unavailable';
    return unavailable(reason);
  }

  const current = rows.filter(isCurrentUnvoidedRow);
  const sameFace = current.filter(row => sameBounds(row, bounds));
  const sideLetter = letterForCardinal(parkingSide);
  const sameSide = sameFace.filter((row) => {
    const cardinal = dotSideToCardinal(row.side_of_street);
    if (cardinal && cardinal === parkingSide) return true;
    return String(row.side_of_street || '').trim().toUpperCase() === sideLetter;
  });
  const opposite = sameFace.filter(row => !sameSide.includes(row) && row.side_of_street);
  if (!sameSide.length) {
    if (opposite.length) return omit('opposite_side', RESTRICTION_EVENTS.NO_MATCH);
    return omit('official_restriction_missing', RESTRICTION_EVENTS.NO_MATCH);
  }

  const seen = new Set();
  const rules = [];
  let uncertainExtent = 0;
  let parseFailed = 0;
  for (const row of sameSide) {
    const parsed = parseNYCOpenDataRestriction(row.sign_description);
    if (!parsed.ok) {
      if (parsed.reason === 'malformed_schedule') parseFailed += 1;
      continue;
    }
    if (parsed.extent !== 'whole_face') {
      uncertainExtent += 1;
      continue;
    }
    const publicRule = toPublicRule(parsed, parkingSide);
    for (const schedule of publicRule.schedules) {
      const key = fingerprint(publicRule, schedule);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    const existing = rules.find(rule => rule.type === publicRule.type);
    if (existing) {
      for (const schedule of publicRule.schedules) {
        if (!existing.schedules.some(item => fingerprint(existing, item) === fingerprint(publicRule, schedule))) {
          existing.schedules.push(schedule);
        }
      }
    } else {
      rules.push(publicRule);
    }
  }

  const prohibitions = rules.filter(rule => rule.type !== 'timeLimited');
  if (!rules.length) {
    if (uncertainExtent) return omit('uncertain_extent', RESTRICTION_EVENTS.UNCERTAIN_EXTENT);
    if (parseFailed) return omit('malformed_schedule', RESTRICTION_EVENTS.PARSE_FAILED);
    return omit('no_supported_restriction', RESTRICTION_EVENTS.NO_MATCH);
  }
  return {
    state: 'supported',
    reason: 'matched',
    event: RESTRICTION_EVENTS.SUPPORTED,
    rules,
    ruleCount: rules.length,
    windowCount: rules.reduce((sum, rule) => sum + rule.schedules.length, 0),
    prohibitionCount: prohibitions.length,
  };
}

module.exports = {
  runProductRestrictionLookup,
  SOURCE_DEADLINE_MS,
  RESOURCE_ID,
};
