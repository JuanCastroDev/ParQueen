'use strict';

const { createCleaningFingerprint } = require('./cleaningFingerprint');
const { capAssociationState } = require('./ruleConfidence');

const STATES = new Set(['SUPPORTED', 'CAUTION', 'UNKNOWN']);
const CATEGORIES = new Set([
  'multiple_meter_zones', 'conflicting_cleaning_rules', 'partial_face_detected',
  'source_outage', 'stale_version_mismatch', 'candidate_coverage_incomplete',
  'official_face_missing', 'side_uncertain', 'no_reviewed_cleaning_rule',
  'no_passenger_meter_rule', 'meter_geometry_off_network', 'competing_meter_faces',
  'official_face_context_incomplete', 'candidate_source_incomplete',
  'official_sign_candidate_missing', 'source_version_mismatch', 'borough_mismatch',
  'street_identity_mismatch', 'side_mismatch', 'bounds_mismatch',
  'official_order_relationship_missing', 'face_applicability_unknown',
  'incomplete_cleaning_rule', 'official_meter_missing', 'official_meter_face_mismatch',
  'essential_meter_terms_incomplete', 'meter_rate_incomplete',
  'curb_identity_caution', 'curb_identity_unknown',
]);
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const SOURCE_KEYS = new Set(['cscl', 'dotSigns', 'parkNyc']);

function validFingerprint(value) {
  if (value === null) return true;
  if (typeof value !== 'string') return false;
  const schedules = value.split(';').map(part => {
    const [days, startTime, endTime] = part.split('|');
    return { days: days?.split(','), startTime, endTime };
  });
  const canonical = createCleaningFingerprint(schedules);
  return canonical.ok && canonical.fingerprint === value;
}

function validVersions(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length > 0
    && Object.keys(value).every(key => SOURCE_KEYS.has(key))
    && Object.values(value).every(version => typeof version === 'string' && SAFE_VERSION.test(version));
}

function toPersistableCurbRuleComparison(input) {
  const states = input?.states;
  if (!states || !STATES.has(states.curb) || !STATES.has(states.cleaning) || !STATES.has(states.meter)) {
    return { ok: false, reason: 'invalid_states' };
  }
  const fingerprint = input.cleaning?.fingerprint ?? null;
  if (!validFingerprint(fingerprint)) return { ok: false, reason: 'invalid_cleaning_fingerprint' };
  const categories = [...new Set([
    ...(Array.isArray(input.cleaning?.reasons) ? input.cleaning.reasons : []),
    ...(Array.isArray(input.meter?.reasonCodes) ? input.meter.reasonCodes : []),
  ])].filter(reason => CATEGORIES.has(reason)).sort();
  const allReasons = [
    ...(Array.isArray(input.cleaning?.reasons) ? input.cleaning.reasons : []),
    ...(Array.isArray(input.meter?.reasonCodes) ? input.meter.reasonCodes : []),
  ];
  if (allReasons.some(reason => !CATEGORIES.has(reason))) return { ok: false, reason: 'invalid_category' };
  if (!validVersions(input.sourceVersions)) return { ok: false, reason: 'invalid_source_versions' };
  return {
    ok: true,
    comparison: {
      curbState: states.curb,
      cleaningState: capAssociationState(states.cleaning, states.curb),
      meterState: capAssociationState(states.meter, states.curb),
      cleaningRuleCount: Array.isArray(input.cleaning?.rules) ? input.cleaning.rules.length : 0,
      meterRuleCount: Array.isArray(input.meter?.rules) ? input.meter.rules.length : 0,
      cleaningFingerprint: fingerprint,
      categories,
      sourceVersions: { ...input.sourceVersions },
    },
  };
}

module.exports = { toPersistableCurbRuleComparison };
