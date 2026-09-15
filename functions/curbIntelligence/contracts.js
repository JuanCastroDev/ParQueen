'use strict';

const { createCleaningFingerprint } = require('./cleaningFingerprint');

const SHADOW_COMPARISON_CATEGORIES = Object.freeze([
  'exact_agreement',
  'new_adds_meter',
  'old_missing_cleaning',
  'cleaning_schedule_differs',
  'side_uncertain',
  'alternate_name_mismatch',
  'multiple_meter_zones',
  'partial_face_detected',
  'official_face_missing',
  'multilevel_or_roadbed_ambiguity',
  'source_outage',
  'stale_version_mismatch',
]);

const SOURCE_ADAPTER_BOUNDARIES = Object.freeze({
  cscl: Object.freeze({
    mapAssetId: '3mf9-qshr',
    resourceId: 'inkn-q76z',
    role: 'official_curb_identity',
    authoritative: true,
    requiresSourceVersion: true,
  }),
  nycDotSigns: Object.freeze({
    resourceId: 'nfid-uabd',
    role: 'posted_regulations',
    authoritative: true,
    requiresSourceVersion: true,
  }),
  parkNyc: Object.freeze({
    resourceId: 'e7yp-wx55',
    role: 'payment_rules',
    authoritative: true,
    implementationPhase: 'shadow_only',
    requiresSourceVersion: true,
  }),
  sweepNyc: Object.freeze({
    role: 'optional_operational_evidence',
    authoritative: false,
    implementationPhase: 'deferred',
  }),
});

const ALLOWED_FIELDS = new Set([
  'category',
  'oldCleaningFingerprint',
  'newCleaningFingerprint',
  'meterRulePresent',
  'blockFaceResolutionState',
  'reasonCodes',
  'sourceVersions',
]);
const ALLOWED_SOURCE_KEYS = new Set(['cscl', 'dotSigns', 'parkNyc', 'sweepNyc']);
const RESOLUTION_STATES = new Set(['SUPPORTED', 'CAUTION', 'UNKNOWN']);
const SENSITIVE_LOCATION_KEYS = new Set([
  'latitude', 'longitude', 'lat', 'lng', 'coordinate', 'coordinates',
  'geometry', 'geohash', 'address', 'location', 'point',
  'officialblockfaceid', 'blockfaceid', 'rawuserlocation',
]);

function findSensitiveLocationField(value, path = []) {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    const nextPath = [...path, key];
    if (SENSITIVE_LOCATION_KEYS.has(key.toLowerCase())) return nextPath.join('.');
    const nested = findSensitiveLocationField(child, nextPath);
    if (nested) return nested;
  }
  return null;
}

const SCHEDULE_FINGERPRINT = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:,(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))*\\|(?:[01]\\d|2[0-3]):[0-5]\\d\\|(?:[01]\\d|2[0-3]):[0-5]\\d';
const CLEANING_FINGERPRINT = new RegExp(`^${SCHEDULE_FINGERPRINT}(?:;${SCHEDULE_FINGERPRINT})*$`);
const SAFE_SOURCE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
function validFingerprint(value) {
  if (value === null) return true;
  if (typeof value !== 'string' || !CLEANING_FINGERPRINT.test(value)) return false;
  const schedules = value.split(';').map(entry => {
    const [days, startTime, endTime] = entry.split('|');
    return { days: days.split(','), startTime, endTime };
  });
  const canonical = createCleaningFingerprint(schedules);
  return canonical.ok && canonical.fingerprint === value;
}

function validSourceVersions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return entries.length > 0 && entries.every(([key, version]) => (
    ALLOWED_SOURCE_KEYS.has(key) && typeof version === 'string' && SAFE_SOURCE_VERSION.test(version)
  ));
}

function createShadowComparison(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'invalid_input' };
  }

  const sensitiveField = findSensitiveLocationField(input);
  if (sensitiveField) {
    return { ok: false, reason: 'sensitive_location_field', field: sensitiveField };
  }

  const unexpectedField = Object.keys(input).find(key => !ALLOWED_FIELDS.has(key));
  if (unexpectedField) return { ok: false, reason: 'unexpected_field', field: unexpectedField };
  if (!SHADOW_COMPARISON_CATEGORIES.includes(input.category)) {
    return { ok: false, reason: 'invalid_category' };
  }
  if (!validFingerprint(input.oldCleaningFingerprint) || !validFingerprint(input.newCleaningFingerprint)) {
    return { ok: false, reason: 'invalid_cleaning_fingerprint' };
  }
  if (typeof input.meterRulePresent !== 'boolean') {
    return { ok: false, reason: 'invalid_meter_rule_state' };
  }
  if (!RESOLUTION_STATES.has(input.blockFaceResolutionState)) {
    return { ok: false, reason: 'invalid_resolution_state' };
  }
  if (!Array.isArray(input.reasonCodes)
    || input.reasonCodes.some(reason => !SHADOW_COMPARISON_CATEGORIES.includes(reason))) {
    return { ok: false, reason: 'invalid_reason_codes' };
  }
  if (!validSourceVersions(input.sourceVersions)) {
    return { ok: false, reason: 'invalid_source_versions' };
  }

  return {
    ok: true,
    comparison: {
      category: input.category,
      oldCleaningFingerprint: input.oldCleaningFingerprint,
      newCleaningFingerprint: input.newCleaningFingerprint,
      meterRulePresent: input.meterRulePresent,
      blockFaceResolutionState: input.blockFaceResolutionState,
      reasonCodes: [...input.reasonCodes],
      sourceVersions: { ...input.sourceVersions },
    },
  };
}

module.exports = {
  SHADOW_COMPARISON_CATEGORIES,
  SOURCE_ADAPTER_BOUNDARIES,
  createShadowComparison,
};
