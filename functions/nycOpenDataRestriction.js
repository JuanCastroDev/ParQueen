'use strict';

const { stripNYCODNoise, parseNYCODDays, parseNYCODClock } = require('./nycOpenDataNormalizer');
const { CANONICAL_WEEKDAYS } = require('./streetIntelDays');

const KIND = Object.freeze({
  NO_PARKING: 'noParking',
  NO_STANDING: 'noStanding',
  NO_STOPPING: 'noStopping',
  TIME_LIMITED: 'timeLimited',
});

const RESTRICTION_LEVEL = Object.freeze({
  noStopping: 3,
  noStanding: 2,
  noParking: 1,
  streetCleaning: 1,
});

const DEFERRED_MARKERS = [
  'COMMERCIAL', 'TRUCK', 'TAXI', 'BUS ', ' BUS', 'SCHOOL', 'AUTHORIZED',
  'PERMIT', 'DIPLOMAT', 'FHV', 'HANDICAP EXPRESS', 'LOADING', 'HOTEL',
  'HOSPITAL', 'AMBULANCE', 'POLICE', 'FIRE DEPT', 'NYS OFFICIAL',
];

const TIME_RE = String.raw`(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?|MIDNIGHT|NOON)`;
const TIME_RANGE = new RegExp(String.raw`${TIME_RE}\s*(?:-|–|\bTO\b)\s*${TIME_RE}`, 'gi');

function fmtClock(mins) {
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

function meridiemOf(raw) {
  const t = String(raw || '').toUpperCase();
  if (t.includes('MIDNIGHT')) return 'AM';
  if (t.includes('NOON')) return 'PM';
  const m = t.match(/(AM|PM)/);
  return m ? m[1] : null;
}

function classifyExtent(arrows) {
  const list = Array.isArray(arrows) ? arrows : [];
  const joined = list.join(' ').toUpperCase();
  const hasDouble = list.some(value => /^<-+>$/.test(String(value).trim())) || /DOUBLE ARROW/.test(joined);
  const hasSingle = list.some(value => /^-+>$/.test(String(value).trim()) || /^<-+$/.test(String(value).trim()))
    || /SINGLE ARROW/.test(joined);
  if (hasDouble && !hasSingle) return 'whole_face';
  if (hasDouble && hasSingle) return 'uncertain_extent';
  if (hasSingle) return 'uncertain_extent';
  return 'uncertain_extent';
}

function deferredReason(text) {
  const upper = String(text || '').toUpperCase();
  if (upper.includes('SANITATION BROOM') || upper.includes('SANITATION BRROM') || upper.includes('SANITATIOJN BROOM')) {
    return 'street_cleaning_identity';
  }
  for (const marker of DEFERRED_MARKERS) {
    if (upper.includes(marker)) return 'vehicle_or_permit_specific';
  }
  return null;
}

function parseTimeWindows(body) {
  const matches = [...String(body || '').matchAll(TIME_RANGE)];
  if (!matches.length) return { windows: [], rest: String(body || '').trim() };
  const windows = [];
  for (const match of matches) {
    const endMer = meridiemOf(match[2]);
    const start = parseNYCODClock(match[1], meridiemOf(match[1]) ? null : endMer);
    const end = parseNYCODClock(match[2], null);
    if (start === null || end === null || start === end) return { windows: [], rest: null };
    windows.push({ startTime: fmtClock(start), endTime: fmtClock(end) });
  }
  const rest = String(body || '').replace(TIME_RANGE, ' ').replace(/\s+/g, ' ').trim();
  return { windows, rest };
}

function parseDaysClause(rest) {
  const cleaned = String(rest || '').replace(/\bEXCEPT HOLIDAYS?\b/gi, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned === 'ANYTIME') {
    return { days: CANONICAL_WEEKDAYS.slice(), anytime: cleaned === 'ANYTIME' };
  }
  const except = cleaned.match(/^EXCEPT\s+(.+)$/i);
  if (except) {
    const excluded = parseNYCODDays(except[1]);
    if (!excluded.length) return { days: [], anytime: false };
    return { days: CANONICAL_WEEKDAYS.filter(day => !excluded.includes(day)), anytime: false };
  }
  const daysThen = parseNYCODDays(cleaned);
  return { days: daysThen, anytime: false };
}

function kindFromPrefix(text) {
  if (text.startsWith('NO STOPPING')) return { kind: KIND.NO_STOPPING, body: text.replace(/^NO STOPPING\s*/, '').trim() };
  if (text.startsWith('NO STANDING')) return { kind: KIND.NO_STANDING, body: text.replace(/^NO STANDING\s*/, '').trim() };
  if (text.startsWith('NO PARKING')) return { kind: KIND.NO_PARKING, body: text.replace(/^NO PARKING\s*/, '').trim() };
  const hours = text.match(/^(\d+)\s+HOUR PARKING\s*(.*)$/);
  if (hours) return { kind: KIND.TIME_LIMITED, body: hours[2].trim(), hourLimit: Number(hours[1]) };
  return null;
}

/**
 * Parses a current nfid-uabd parking-regulation sign into a typed prohibition
 * or informational time-limit. Returns null when the schedule, identity, or
 * wording is not fully determined. Does not invent extent; callers must apply
 * classifyExtent to provenance.arrows.
 */
function parseNYCOpenDataRestriction(signText) {
  if (!signText || typeof signText !== 'string') return { ok: false, reason: 'invalid_text' };
  const deferred = deferredReason(signText);
  if (deferred) return { ok: false, reason: deferred };
  const { text, provenance } = stripNYCODNoise(signText.toUpperCase());
  const prefix = kindFromPrefix(text);
  if (!prefix) return { ok: false, reason: 'unsupported_prefix' };
  const extent = classifyExtent(provenance.arrows);
  if (prefix.body === 'ANYTIME' || prefix.body.startsWith('ANYTIME')) {
    if (prefix.kind === KIND.TIME_LIMITED) return { ok: false, reason: 'unsupported_time_limit' };
    return {
      ok: true,
      kind: prefix.kind,
      anytime: true,
      days: CANONICAL_WEEKDAYS.slice(),
      windows: [],
      extent,
      provenance,
      restrictionLevel: RESTRICTION_LEVEL[prefix.kind],
    };
  }
  const { windows, rest } = parseTimeWindows(prefix.body);
  if (!windows.length || rest === null) return { ok: false, reason: 'malformed_schedule' };
  const { days } = parseDaysClause(rest);
  if (!days.length) return { ok: false, reason: 'malformed_schedule' };
  if (prefix.kind === KIND.TIME_LIMITED && (!Number.isInteger(prefix.hourLimit) || prefix.hourLimit <= 0)) {
    return { ok: false, reason: 'unsupported_time_limit' };
  }
  return {
    ok: true,
    kind: prefix.kind,
    anytime: false,
    days,
    windows,
    hourLimit: prefix.hourLimit || null,
    extent,
    provenance,
    restrictionLevel: prefix.kind === KIND.TIME_LIMITED ? 0 : RESTRICTION_LEVEL[prefix.kind],
  };
}

function isCurrentUnvoidedRow(row) {
  if (!row || row.record_type !== 'Current') return false;
  const voided = row.sign_design_voided_on_date;
  return voided == null || (typeof voided === 'string' && !voided.trim());
}

module.exports = {
  KIND,
  RESTRICTION_LEVEL,
  DEFERRED_MARKERS,
  parseNYCOpenDataRestriction,
  classifyExtent,
  isCurrentUnvoidedRow,
  deferredReason,
};
