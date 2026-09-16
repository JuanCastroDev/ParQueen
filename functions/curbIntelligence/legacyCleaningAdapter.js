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

function scheduleSetFingerprint(schedules) {
  const values = [];
  for (const schedule of schedules) {
    const fingerprint = createCleaningFingerprint([schedule]);
    if (!fingerprint.ok || !fingerprint.fingerprint) return null;
    const ruleType = typeof schedule.ruleType === 'string' ? schedule.ruleType.trim() : '';
    values.push(`${fingerprint.fingerprint}|${ruleType}`);
  }
  return [...new Set(values)].sort().join('||');
}

function collectSideEvidence(rules) {
  const bySide = new Map();
  for (const rule of rules) {
    for (const schedule of rule.schedules) {
      const side = String(schedule?.side || '').trim();
      if (!side) return null;
      if (!bySide.has(side)) bySide.set(side, new Map());
      const bySource = bySide.get(side);
      if (!bySource.has(rule.source)) bySource.set(rule.source, []);
      bySource.get(rule.source).push(schedule);
    }
  }

  const fingerprintsBySide = {};
  let conflictingSchedules = false;
  for (const [side, bySource] of [...bySide.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const allSchedules = [...bySource.values()].flat();
    const combined = createCleaningFingerprint(allSchedules);
    if (!combined.ok || !combined.fingerprint) return null;
    fingerprintsBySide[side] = combined.fingerprint;
    if (bySource.size > 1) {
      const sourceSets = [...bySource.values()].map(scheduleSetFingerprint);
      if (sourceSets.some(value => !value)) return null;
      if (new Set(sourceSets).size > 1) conflictingSchedules = true;
    }
  }
  return { fingerprintsBySide, conflictingSchedules };
}

function legacyConfidence(segment, rules, conflictingSchedules) {
  const evidence = segment.blockFaceEvidence;
  const caution = segment.status === 'needs_review'
    || segment.needsReview === true
    || rules.some(rule => rule.needsReview === true)
    || ['flagged', 'unverified'].includes(segment.confidence?.level)
    || segment.confidenceScore < 0.9
    || evidence?.blockDecisive === false
    || evidence?.sideResolved === false
    || evidence?.parseComplete === false
    || conflictingSchedules;
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
  const sideEvidence = collectSideEvidence(rules);
  if (!sideEvidence) return empty('MALFORMED', source);
  const sideEntries = Object.entries(sideEvidence.fingerprintsBySide);
  const sources = [...new Set(rules.map(rule => rule.source))];
  return {
    availability: 'USABLE',
    confidence: legacyConfidence(input.segment, rules, sideEvidence.conflictingSchedules),
    fingerprint: sideEntries.length === 1 ? sideEntries[0][1] : null,
    fingerprintsBySide: sideEvidence.fingerprintsBySide,
    sourceFamily: sources.length === 1 ? sources[0] : null,
  };
}

module.exports = { adaptLegacyCleaningEvidence };
