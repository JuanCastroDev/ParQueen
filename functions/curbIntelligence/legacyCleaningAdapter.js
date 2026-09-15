'use strict';

const { createCleaningFingerprint } = require('./cleaningFingerprint');

const SOURCES = new Set(['admin', 'sweepnyc', 'nyc_open_data']);

function empty(availability, sourceFamily = null) {
  return { availability, confidence: 'UNKNOWN', fingerprint: null, sourceFamily };
}

function segmentSource(segment) {
  const source = segment?.source;
  return SOURCES.has(source) && segment?.provenance?.provider === source ? source : null;
}

function legacyConfidence(segment, rules) {
  const evidence = segment.blockFaceEvidence;
  const caution = segment.status === 'needs_review'
    || segment.needsReview === true
    || rules.some(rule => rule.needsReview === true)
    || ['flagged', 'unverified'].includes(segment.confidence?.level)
    || segment.confidenceScore < 0.9
    || evidence?.blockDecisive === false
    || evidence?.sideResolved === false
    || evidence?.parseComplete === false;
  return caution ? 'CAUTION' : 'SUPPORTED';
}

function adaptLegacyCleaningEvidence(input) {
  if (!input || !input.segment || !Array.isArray(input.activeRules)) return empty('UNAVAILABLE');
  const source = segmentSource(input.segment);
  if (!source || !['active', 'needs_review'].includes(input.segment.status)
    || !Number.isFinite(input.segment.confidenceScore)) return empty('MALFORMED');

  const rules = input.activeRules.filter(rule => rule?.supersededAt == null);
  if (!rules.length) return empty('NONE', source);
  if (rules.some(rule => rule.type !== 'streetCleaning' || !SOURCES.has(rule.source)
    || !Array.isArray(rule.schedules))) return empty('MALFORMED', source);
  const schedules = rules.flatMap(rule => rule.schedules);
  if (!schedules.length) return empty('NONE', source);
  const sides = new Set(schedules.map(schedule => String(schedule?.side || '').trim()).filter(Boolean));
  if (sides.size !== 1) return empty('MALFORMED', source);
  const fingerprint = createCleaningFingerprint(schedules);
  if (!fingerprint.ok) return empty('MALFORMED', source);
  const sources = [...new Set(rules.map(rule => rule.source))];
  return {
    availability: 'USABLE',
    confidence: legacyConfidence(input.segment, rules),
    fingerprint: fingerprint.fingerprint,
    sourceFamily: sources.length === 1 ? sources[0] : null,
  };
}

module.exports = { adaptLegacyCleaningEvidence };
