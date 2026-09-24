'use strict';

const CARDINAL = Object.freeze({
  N: 'North', S: 'South', E: 'East', W: 'West',
  North: 'North', South: 'South', East: 'East', West: 'West',
});
const CARDINAL_TO_LETTER = Object.freeze({
  North: 'N', South: 'S', East: 'E', West: 'W',
});

const METER_EVENTS = Object.freeze({
  LOOKUP_ATTEMPTED: 'meter_lookup_attempted',
  SUPPORTED: 'meter_supported',
  NO_MATCH: 'meter_no_match',
  RELATIONSHIP_UNCERTAIN: 'meter_relationship_uncertain',
  PARSE_FAILED: 'meter_parse_failed',
  OMITTED: 'meter_omitted',
});

const ALLOWED_METER_LOG_KEYS = Object.freeze(new Set([
  'event',
  'reason',
  'state',
  'windowCount',
  'hasFixedRate',
  'hasMaxStay',
]));

function letterForCardinal(side) {
  return CARDINAL_TO_LETTER[side] || null;
}

function cardinalForLetter(side) {
  if (typeof side !== 'string') return null;
  return CARDINAL[side.trim()] || null;
}

function usableWindow(window) {
  if (!window || typeof window !== 'object') return false;
  const days = Array.isArray(window.days)
    ? window.days.filter(day => typeof day === 'string' && day.trim())
    : [];
  const start = typeof window.startTime === 'string' ? window.startTime.trim() : '';
  const end = typeof window.endTime === 'string' ? window.endTime.trim() : '';
  return days.length > 0 && Boolean(start) && Boolean(end);
}

function publicRate(rate) {
  if (!rate || rate.ok !== true || rate.kind !== 'FIXED') return null;
  if (!Number.isFinite(rate.amount) || rate.amount < 0) return null;
  const amount = rate.amount.toFixed(2);
  if (rate.unitMinutes === 60) return { kind: 'FIXED', unitMinutes: 60, amount: rate.amount, display: `$${amount}/hour` };
  if (rate.unitMinutes === 30) return { kind: 'FIXED', unitMinutes: 30, amount: rate.amount, display: `$${amount} / 30 min` };
  return null;
}

function omit(reason, event = METER_EVENTS.OMITTED) {
  return { state: 'omitted', reason, event, product: null };
}

function unavailable(reason) {
  return { state: 'unavailable', reason, event: METER_EVENTS.OMITTED, product: null };
}

function eventForAssociation(association) {
  const reasons = Array.isArray(association?.reasonCodes) ? association.reasonCodes : [];
  if (reasons.some(code => [
    'official_meter_side_uncertain',
    'official_meter_side_contradiction',
    'official_meter_side_crossing',
    'official_meter_geometry_ambiguous',
    'official_meter_geometry_unverified',
    'competing_meter_faces',
  ].includes(code))) return METER_EVENTS.RELATIONSHIP_UNCERTAIN;
  if (reasons.some(code => [
    'unsupported_schedule_format',
    'essential_meter_terms_incomplete',
    'meter_parse_failed',
  ].includes(code))) return METER_EVENTS.PARSE_FAILED;
  if (reasons.some(code => [
    'official_meter_missing',
    'official_meter_face_mismatch',
    'no_passenger_meter_rule',
    'meter_geometry_off_network',
    'official_meter_geometry_incompatible',
  ].includes(code))) return METER_EVENTS.NO_MATCH;
  return METER_EVENTS.OMITTED;
}

function toPublicMeterProduct(association, parkingSide) {
  const side = cardinalForLetter(parkingSide) || parkingSide;
  if (!['East', 'West', 'North', 'South'].includes(side)) {
    return omit('parking_side_unresolved', METER_EVENTS.RELATIONSHIP_UNCERTAIN);
  }
  if (!association || association.state !== 'SUPPORTED' || !Array.isArray(association.rules) || !association.rules.length) {
    const event = eventForAssociation(association);
    return omit(association?.reasonCodes?.[0] || 'unsupported', event);
  }
  const rule = association.rules[0];
  const windows = (Array.isArray(rule.schedules) ? rule.schedules : []).filter(usableWindow);
  if (!windows.length) return omit('meter_parse_failed', METER_EVENTS.PARSE_FAILED);
  const terms = rule.meterTerms;
  const maxStayMinutes = Number.isInteger(terms?.maximumMinutes) && terms.maximumMinutes > 0
    ? terms.maximumMinutes : null;
  const rate = publicRate(terms?.rate);
  return {
    state: 'supported',
    reason: 'matched',
    event: METER_EVENTS.SUPPORTED,
    product: {
      type: 'meter',
      source: 'park_nyc',
      side,
      windows: windows.map(window => ({
        side,
        days: window.days.filter(day => typeof day === 'string' && day.trim()),
        startTime: window.startTime.trim(),
        endTime: window.endTime.trim(),
      })),
      maxStayMinutes,
      rate,
    },
  };
}

const { emitStructuredLog } = require('../streetIntelStructuredLog');

function logMeterEvent(result, write) {
  const event = result?.event || METER_EVENTS.OMITTED;
  const payload = {
    message: event,
    event,
    domain: 'street_intel_meter',
    state: result?.state || 'omitted',
  };
  if (typeof result?.reason === 'string' && result.reason) payload.reason = result.reason;
  if (result?.product) {
    payload.windowCount = result.product.windows.length;
    payload.hasFixedRate = Boolean(result.product.rate);
    payload.hasMaxStay = Number.isInteger(result.product.maxStayMinutes);
  }
  emitStructuredLog(payload, write);
  return payload;
}

module.exports = {
  METER_EVENTS,
  ALLOWED_METER_LOG_KEYS,
  letterForCardinal,
  cardinalForLetter,
  usableWindow,
  publicRate,
  omit,
  unavailable,
  toPublicMeterProduct,
  logMeterEvent,
};
