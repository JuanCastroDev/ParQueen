'use strict';

const { createHash } = require('crypto');
const { resolveOfficialCurbRuntime } = require('./runtimeCurbResolution');
const { createFaceAssociationContext } = require('./dotFaceAssociation');
const { associateCleaningRules } = require('./cleaningRuleAssociation');
const { adaptLegacyCleaningEvidence } = require('./legacyCleaningAdapter');
const { compareCleaningEvidence } = require('./cleaningComparison');
const { publicProductSchedules } = require('./productPathDecision');

const ENGINE_VERSION = '2a15-local-1';
const RELATIONSHIP_TIMEOUT_MS = 3000;

function comparisonCategory(value) {
  if (['exact_agreement', 'both_no_usable_cleaning', 'new_more_cautious'].includes(value)) return 'agreement';
  if (value === 'cleaning_schedule_differs') return 'schedule_difference';
  if (value === 'legacy_cleaning_only') return 'legacy_only';
  if (value === 'curb_intelligence_cleaning_only') return 'new_only';
  if (['same_schedule_confidence_differs', 'new_more_supported'].includes(value)) {
    return 'confidence_difference';
  }
  return 'not_comparable';
}

function latencyBucket(milliseconds) {
  if (milliseconds < 250) return 'lt_250ms';
  if (milliseconds < 500) return 'lt_500ms';
  if (milliseconds < 1000) return 'lt_1s';
  if (milliseconds < 2000) return 'lt_2s';
  if (milliseconds < 4000) return 'lt_4s';
  return 'gte_4s';
}

function countBucket(value) {
  if (value <= 0) return '0';
  if (value === 1) return '1';
  if (value === 2) return '2';
  return '3+';
}

function safeVersion(value) {
  if (typeof value !== 'string' || !value) return 'unavailable';
  return `sha256-${createHash('sha256').update(value, 'utf8').digest('hex').slice(0, 16)}`;
}

function sourceVersionToken(value) {
  if (!value || typeof value !== 'object') return 'unavailable';
  return safeVersion(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${key}:${String(item)}`).join('|'));
}

function applicabilitySupported(relationship, snapshot) {
  const values = snapshot.candidates.map(row => (
    relationship?.faceContext?.officialRelationship?.orderApplicability?.[row.orderNumber]
  ));
  return values.length > 0 && values.every(value => value === 'WHOLE_FACE');
}

async function safeRecord(sink, value) {
  try {
    if (sink && typeof sink.record === 'function') await sink.record(value);
  } catch {
    // Observational logging cannot affect the shadow result or callable.
  }
}

async function boundedRelationship(provider, input, timeoutMs) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  if (input.signal?.aborted) controller.abort();
  else input.signal?.addEventListener?.('abort', abortFromParent, { once: true });
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => provider.resolve({ ...input, signal: controller.signal }))
        .then(value => ({ timedOut: false, value })),
      new Promise(resolve => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ timedOut: true, value: null });
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    input.signal?.removeEventListener?.('abort', abortFromParent);
  }
}

function baseTelemetry(input, elapsed) {
  return {
    event: 'curb_shadow_v1',
    schemaVersion: 'curb-shadow-cleaning-v1',
    engineVersion: ENGINE_VERSION,
    cohort: input.cohort || 'sampled',
    outcome: 'UNKNOWN',
    skipOrFailureClass: 'relationship_unknown',
    curbState: 'UNKNOWN',
    cleaningState: 'UNKNOWN',
    comparisonCategory: 'not_comparable',
    legacyAvailability: 'UNAVAILABLE',
    csclAvailability: 'INCOMPLETE',
    dotAvailability: 'INCOMPLETE',
    relationshipAvailability: 'UNKNOWN',
    latencyBucket: latencyBucket(elapsed),
    cleaningRuleCountBucket: '0',
    reasonBuckets: [],
    sourceVersions: {},
  };
}

function publicResult(telemetry) {
  return {
    outcome: telemetry.outcome,
    skipOrFailureClass: telemetry.skipOrFailureClass,
    curbState: telemetry.curbState,
    cleaningState: telemetry.cleaningState,
    comparisonCategory: telemetry.comparisonCategory,
    parkNycState: 'NOT_EVALUATED',
  };
}

async function runMinimumCleaningShadow(input = {}) {
  const startedAt = (input.now || Date.now)();
  const now = input.now || Date.now;
  const deps = input.dependencies || {};
  let telemetry = baseTelemetry(input, 0);
  try {
    const legacy = adaptLegacyCleaningEvidence(input.legacyEvidence);
    telemetry.legacyAvailability = legacy.availability;
    if (legacy.availability !== 'USABLE') {
      telemetry.outcome = 'SKIPPED';
      telemetry.skipOrFailureClass = ['UNAVAILABLE', 'NONE'].includes(legacy.availability)
        ? 'legacy_evidence_missing' : 'legacy_evidence_malformed';
      telemetry.latencyBucket = latencyBucket(now() - startedAt);
      await safeRecord(deps.sink, telemetry);
      return publicResult(telemetry);
    }

    const resolveRuntime = input.resolveCurbRuntime || resolveOfficialCurbRuntime;
    const runtime = await resolveRuntime(input.location, {
      candidateStore: deps.candidateStore,
      signal: input.signal,
      maxSearchRadiusMeters: 500,
      maxCandidates: 100,
    });
    telemetry.curbState = runtime?.resolution?.state || 'UNKNOWN';
    const csclComplete = runtime?.runtimeEvidence?.candidateCoverageComplete === true
      && runtime.runtimeEvidence.candidateCompleteness?.state === 'COMPLETE';
    telemetry.csclAvailability = csclComplete ? 'COMPLETE' : 'INCOMPLETE';
    telemetry.sourceVersions.cscl = sourceVersionToken(runtime?.runtimeEvidence?.sourceVersion);
    if (runtime?.resolution?.state === 'UNKNOWN' || !runtime?.runtimeEvidence || !csclComplete) {
      telemetry.skipOrFailureClass = 'cscl_incomplete';
      telemetry.reasonBuckets = ['candidate_coverage_incomplete'];
      telemetry.latencyBucket = latencyBucket(now() - startedAt);
      await safeRecord(deps.sink, telemetry);
      return publicResult(telemetry);
    }

    const dotSnapshot = await deps.dotSource.query({ signal: input.signal });
    telemetry.dotAvailability = dotSnapshot?.completeness?.state || 'INCOMPLETE';
    telemetry.sourceVersions.dotSigns = sourceVersionToken(dotSnapshot?.sourceVersion);
    if (dotSnapshot?.completeness?.state !== 'COMPLETE') {
      telemetry.skipOrFailureClass = 'dot_evidence_incomplete';
      telemetry.latencyBucket = latencyBucket(now() - startedAt);
      await safeRecord(deps.sink, telemetry);
      return publicResult(telemetry);
    }

    const relationshipAttempt = await boundedRelationship(deps.officialRelationshipProvider, {
      resolution: runtime.resolution,
      candidateSnapshot: dotSnapshot,
      signal: input.signal,
    }, Number.isFinite(input.executionPolicy?.relationshipTimeoutMs)
      && input.executionPolicy.relationshipTimeoutMs > 0
      ? input.executionPolicy.relationshipTimeoutMs : RELATIONSHIP_TIMEOUT_MS);
    if (relationshipAttempt.timedOut) {
      telemetry.skipOrFailureClass = 'relationship_unknown';
      telemetry.reasonBuckets = ['execution_timeout'];
      telemetry.latencyBucket = latencyBucket(now() - startedAt);
      await safeRecord(deps.sink, telemetry);
      return publicResult(telemetry);
    }
    const relationship = relationshipAttempt.value;
    telemetry.sourceVersions.resolver = safeVersion(
      relationship?.faceContext?.officialRelationship?.version || '',
    );
    if (!applicabilitySupported(relationship, dotSnapshot)) {
      telemetry.skipOrFailureClass = 'relationship_unknown';
      telemetry.reasonBuckets = ['official_order_relationship_missing'];
      telemetry.latencyBucket = latencyBucket(now() - startedAt);
      await safeRecord(deps.sink, telemetry);
      return publicResult(telemetry);
    }
    telemetry.relationshipAvailability = 'SUPPORTED';

    const faceContext = createFaceAssociationContext(relationship.faceContext);
    const cleaning = associateCleaningRules({
      curbIdentity: runtime.resolution,
      faceContext,
      candidateSnapshot: dotSnapshot,
    });
    telemetry.cleaningState = cleaning.confidence;
    telemetry.cleaningRuleCountBucket = countBucket(cleaning.rules.length);
    const comparison = compareCleaningEvidence(legacy, cleaning);
    telemetry.comparisonCategory = comparisonCategory(comparison.category);
    telemetry.outcome = telemetry.comparisonCategory === 'not_comparable' ? 'UNKNOWN' : 'COMPLETED';
    telemetry.skipOrFailureClass = telemetry.outcome === 'COMPLETED' ? 'none' : 'relationship_unknown';
    telemetry.latencyBucket = latencyBucket(now() - startedAt);
    await safeRecord(deps.sink, telemetry);
    return {
      ...publicResult(telemetry),
      productSchedules: telemetry.outcome === 'COMPLETED' ? publicProductSchedules(cleaning.rules) : [],
    };
  } catch {
    telemetry = {
      ...telemetry,
      outcome: 'FAILED',
      skipOrFailureClass: 'internal_failure',
      latencyBucket: latencyBucket(now() - startedAt),
    };
    await safeRecord(deps.sink, telemetry);
    return publicResult(telemetry);
  }
}

module.exports = { comparisonCategory, runMinimumCleaningShadow, RELATIONSHIP_TIMEOUT_MS };
