'use strict';

const STATES = new Set(['SUPPORTED', 'CAUTION', 'UNKNOWN']);
const COMPARISON_CATEGORIES = new Set([
  'exact_agreement', 'both_no_usable_cleaning', 'legacy_cleaning_only',
  'curb_intelligence_cleaning_only', 'cleaning_schedule_differs',
  'same_schedule_confidence_differs', 'new_more_cautious', 'new_more_supported',
  'legacy_unavailable', 'legacy_side_context_unavailable',
]);
const REASON_BUCKETS = new Set([
  'competing_roadways', 'side_uncertain', 'endpoint_ambiguity', 'missing_bfi',
  'implausible_geometry', 'candidate_coverage_incomplete', 'unsupported_roadway_status',
  'source_version_problem', 'alias_context_unavailable', 'official_order_relationship_missing',
  'execution_timeout', 'cscl_unavailable', 'dot_unavailable', 'park_nyc_unavailable',
  'source_changed_during_read', 'internal_shadow_error', 'source_response_malformed',
  'official_meter_geometry_unverified', 'official_meter_geometry_incompatible',
  'official_meter_geometry_ambiguous', 'official_meter_side_contradiction',
  'official_meter_side_crossing', 'official_meter_side_uncertain', 'multiple_meter_zones',
  'no_passenger_meter_rule', 'essential_meter_terms_incomplete', 'meter_rate_incomplete',
  'curb_confidence_cap', 'cleaning_provider_unavailable',
]);
const VERSION_KEYS = new Set(['cscl', 'dotSigns', 'parkNyc']);
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/;
const ALLOWED_INPUT_FIELDS = new Set([
  'schemaVersion', 'engineVersion', 'curbState', 'cleaningState', 'meterState',
  'cleaningComparisonCategory', 'legacyCleaningPresent', 'newCleaningPresent',
  'passengerMeterRulePresent', 'cleaningRuleCount', 'meterRuleCount',
  'reasonBuckets', 'sourceVersions',
]);
const SENSITIVE_KEYS = new Set([
  'lat', 'latitude', 'lng', 'longitude', 'coordinate', 'coordinates', 'geometry',
  'geohash', 'address', 'location', 'point', 'blockfaceid', 'officialblockfaceid',
  'zoneid', 'ordernumber', 'globalid', 'physicalid', 'street', 'streetname',
  'fromstreet', 'tostreet', 'userid', 'uid', 'email', 'phone', 'sessionid',
  'requestid', 'deviceid',
]);

function sensitivePath(value, path = []) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = sensitivePath(value[index], [...path, String(index)]);
      if (found) return found;
    }
    return null;
  }
  for (const [key, child] of Object.entries(value)) {
    const next = [...path, key];
    if (SENSITIVE_KEYS.has(key.toLowerCase())) return next.join('.');
    const found = sensitivePath(child, next);
    if (found) return found;
  }
  return null;
}

function countBucket(value) {
  if (!Number.isInteger(value) || value < 0) return null;
  if (value === 0) return '0';
  if (value === 1) return '1';
  if (value === 2) return '2';
  return '3+';
}

function validVersions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, version]) => (
    VERSION_KEYS.has(key) && typeof version === 'string' && SAFE_VERSION.test(version)
  ));
}

function createPersistableShadowTelemetry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, reason: 'invalid_input' };
  }
  const field = sensitivePath(input);
  if (field) return { ok: false, reason: 'sensitive_field', field };
  const unexpected = Object.keys(input).find(key => !ALLOWED_INPUT_FIELDS.has(key));
  if (unexpected) return { ok: false, reason: 'unexpected_field', field: unexpected };
  if (input.schemaVersion !== 'curb-shadow-aggregate-v1'
    || typeof input.engineVersion !== 'string' || !SAFE_VERSION.test(input.engineVersion)) {
    return { ok: false, reason: 'invalid_version' };
  }
  if (![input.curbState, input.cleaningState, input.meterState].every(value => STATES.has(value))) {
    return { ok: false, reason: 'invalid_state' };
  }
  if (!COMPARISON_CATEGORIES.has(input.cleaningComparisonCategory)) {
    return { ok: false, reason: 'invalid_comparison_category' };
  }
  if (![input.legacyCleaningPresent, input.newCleaningPresent, input.passengerMeterRulePresent]
    .every(value => typeof value === 'boolean')) return { ok: false, reason: 'invalid_boolean' };
  const cleaningRuleCountBucket = countBucket(input.cleaningRuleCount);
  const meterRuleCountBucket = countBucket(input.meterRuleCount);
  if (!cleaningRuleCountBucket || !meterRuleCountBucket) return { ok: false, reason: 'invalid_rule_count' };
  if (!Array.isArray(input.reasonBuckets)
    || input.reasonBuckets.some(reason => !REASON_BUCKETS.has(reason))) {
    return { ok: false, reason: 'invalid_reason_bucket' };
  }
  if (!validVersions(input.sourceVersions)) return { ok: false, reason: 'invalid_source_versions' };
  return {
    ok: true,
    telemetry: {
      schemaVersion: input.schemaVersion,
      engineVersion: input.engineVersion,
      curbState: input.curbState,
      cleaningState: input.cleaningState,
      meterState: input.meterState,
      cleaningComparisonCategory: input.cleaningComparisonCategory,
      legacyCleaningPresent: input.legacyCleaningPresent,
      newCleaningPresent: input.newCleaningPresent,
      passengerMeterRulePresent: input.passengerMeterRulePresent,
      cleaningRuleCountBucket,
      meterRuleCountBucket,
      reasonBuckets: [...new Set(input.reasonBuckets)].sort(),
      sourceVersions: Object.fromEntries(Object.entries(input.sourceVersions).sort(([a], [b]) => a.localeCompare(b))),
    },
  };
}

function createNoopShadowSink() {
  return {
    async record() { return { accepted: true }; },
    snapshot() { return []; },
  };
}

function createMemoryAggregateShadowSink() {
  const counters = new Map();
  return {
    async record(telemetry) {
      const key = JSON.stringify(telemetry);
      const entry = counters.get(key) || { dimensions: telemetry, count: 0 };
      counters.set(key, { dimensions: entry.dimensions, count: entry.count + 1 });
      return { accepted: true };
    },
    snapshot() {
      return [...counters.values()].map(entry => ({
        dimensions: JSON.parse(JSON.stringify(entry.dimensions)), count: entry.count,
      }));
    },
  };
}

module.exports = {
  COMPARISON_CATEGORIES,
  REASON_BUCKETS,
  createPersistableShadowTelemetry,
  createNoopShadowSink,
  createMemoryAggregateShadowSink,
};
