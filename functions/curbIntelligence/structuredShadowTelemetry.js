'use strict';

const ALLOWED_FIELDS = new Set([
  'event', 'schemaVersion', 'engineVersion', 'cohort', 'outcome', 'skipOrFailureClass',
  'curbState', 'cleaningState', 'comparisonCategory', 'legacyAvailability',
  'csclAvailability', 'dotAvailability', 'relationshipAvailability', 'latencyBucket',
  'cleaningRuleCountBucket', 'reasonBuckets', 'sourceVersions',
]);
const VERSION_KEYS = new Set(['cscl', 'dotSigns', 'resolver']);
const SAFE_TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:+#@,-]{0,127}$/;
const ENGINE_VERSIONS = new Set(['2a15-local-1']);
const SAFE_SOURCE_VERSION = /^(?:sha256-[a-f0-9]{16}|unavailable)$/;
const COHORTS = new Set(['operator', 'sampled']);
const OUTCOMES = new Set(['COMPLETED', 'SKIPPED', 'UNKNOWN', 'FAILED']);
const STATES = new Set(['SUPPORTED', 'CAUTION', 'UNKNOWN', 'NOT_EVALUATED']);
const COMPARISONS = new Set([
  'agreement', 'schedule_difference', 'legacy_only', 'new_only',
  'confidence_difference', 'not_comparable',
]);
const AVAILABILITY = new Set(['USABLE', 'NONE', 'UNAVAILABLE', 'MALFORMED', 'COMPLETE', 'INCOMPLETE', 'SUPPORTED', 'UNKNOWN', 'NOT_EVALUATED']);
const LATENCY_BUCKETS = new Set(['lt_250ms', 'lt_500ms', 'lt_1s', 'lt_2s', 'lt_4s', 'gte_4s']);
const COUNT_BUCKETS = new Set(['0', '1', '2', '3+']);
const FAILURE_CLASSES = new Set([
  'none', 'accuracy_missing', 'accuracy_invalid', 'sample_not_authorized',
  'production_path_ineligible', 'dot_evidence_incomplete', 'dot_order_count_invalid',
  'dot_evidence_malformed', 'legacy_evidence_missing', 'legacy_evidence_malformed',
  'cscl_incomplete', 'relationship_unknown', 'execution_timeout', 'internal_failure',
]);
const REASONS = new Set([
  'candidate_coverage_incomplete', 'source_version_problem', 'source_changed_during_read',
  'source_response_malformed', 'official_order_relationship_missing', 'official_blockface_mismatch',
  'official_blockface_lookup_failed', 'cleaning_not_comparable', 'curb_confidence_cap',
  'execution_timeout',
]);

function validVersions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, version]) => (
    VERSION_KEYS.has(key) && typeof version === 'string' && SAFE_SOURCE_VERSION.test(version)
  ));
}

function validateCleaningShadowTelemetry(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'invalid_input' };
  const unexpected = Object.keys(input).find(key => !ALLOWED_FIELDS.has(key));
  if (unexpected) return { ok: false, reason: 'unexpected_field' };
  if (Object.keys(input).length !== ALLOWED_FIELDS.size
    || input.event !== 'curb_shadow_v1' || input.schemaVersion !== 'curb-shadow-cleaning-v1'
    || typeof input.engineVersion !== 'string' || !SAFE_TOKEN.test(input.engineVersion)
    || !ENGINE_VERSIONS.has(input.engineVersion)
    || !COHORTS.has(input.cohort)) {
    return { ok: false, reason: 'invalid_schema' };
  }
  if (!OUTCOMES.has(input.outcome) || !FAILURE_CLASSES.has(input.skipOrFailureClass)
    || !STATES.has(input.curbState) || !STATES.has(input.cleaningState)
    || !COMPARISONS.has(input.comparisonCategory)
    || ![input.legacyAvailability, input.csclAvailability, input.dotAvailability, input.relationshipAvailability]
      .every(value => AVAILABILITY.has(value))
    || !LATENCY_BUCKETS.has(input.latencyBucket)
    || !COUNT_BUCKETS.has(input.cleaningRuleCountBucket)) {
    return { ok: false, reason: 'invalid_enum' };
  }
  if (!Array.isArray(input.reasonBuckets) || input.reasonBuckets.some(value => !REASONS.has(value))) {
    return { ok: false, reason: 'invalid_reason_bucket' };
  }
  if (!validVersions(input.sourceVersions)) return { ok: false, reason: 'invalid_source_versions' };
  return {
    ok: true,
    telemetry: {
      ...input,
      reasonBuckets: [...new Set(input.reasonBuckets)].sort(),
      sourceVersions: Object.fromEntries(Object.entries(input.sourceVersions).sort(([a], [b]) => a.localeCompare(b))),
    },
  };
}

function createStructuredCloudLoggingSink(options = {}) {
  const logger = options.logger || console;
  return Object.freeze({
    async record(input) {
      const result = validateCleaningShadowTelemetry(input);
      if (!result.ok) return { accepted: false, reason: result.reason };
      logger.info(result.telemetry);
      return { accepted: true };
    },
  });
}

module.exports = { validateCleaningShadowTelemetry, createStructuredCloudLoggingSink };
