'use strict';

const { resolveOfficialCurbRuntime } = require('./runtimeCurbResolution');
const { createFaceAssociationContext } = require('./dotFaceAssociation');
const { associateCleaningRules } = require('./cleaningRuleAssociation');
const { associateParkNycRules } = require('./parkNycAssociation');
const { createInternalCurbRuleResult } = require('./ruleConfidence');
const { adaptLegacyCleaningEvidence } = require('./legacyCleaningAdapter');
const { compareCleaningEvidence } = require('./cleaningComparison');
const {
  createPersistableShadowTelemetry,
  createNoopShadowSink,
  REASON_BUCKETS,
} = require('./shadowTelemetry');

const DEFAULT_EXECUTION_POLICY = Object.freeze({
  overallDeadlineMs: 8000,
  sourceDeadlineMs: Object.freeze({ curb: 2500, dot: 2500, parkNyc: 2500, relationship: 1500, sink: 500 }),
  maxCandidates: Object.freeze({ curb: 100, dot: 100, parkNyc: 50 }),
  maxRetries: 0,
});

function policyOf(value = {}) {
  return {
    overallDeadlineMs: Number.isFinite(value.overallDeadlineMs) && value.overallDeadlineMs > 0
      ? value.overallDeadlineMs : DEFAULT_EXECUTION_POLICY.overallDeadlineMs,
    sourceDeadlineMs: { ...DEFAULT_EXECUTION_POLICY.sourceDeadlineMs, ...(value.sourceDeadlineMs || {}) },
    maxCandidates: { ...DEFAULT_EXECUTION_POLICY.maxCandidates, ...(value.maxCandidates || {}) },
    maxRetries: 0,
  };
}

function bounded(operation, timeoutMs, parentSignal) {
  if (parentSignal?.aborted) {
    return Promise.resolve({ ok: false, reason: 'execution_timeout' });
  }
  const controller = new AbortController();
  let resolveAbort;
  const aborted = new Promise(resolve => { resolveAbort = resolve; });
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
    resolveAbort({ ok: false, reason: 'execution_timeout' });
  };
  parentSignal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, timeoutMs);
  const skipped = Symbol('bounded-operation-skipped');
  const task = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw skipped;
    return operation(controller.signal);
  }).then(value => ({ ok: true, value }), error => ({
    ok: false,
    reason: error === skipped || controller.signal.aborted ? 'execution_timeout' : 'source_unavailable',
  }));
  return Promise.race([task, aborted]).finally(() => {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abort);
  });
}

function unknownCleaning(reason) {
  return { rules: [], fingerprint: null, confidence: 'UNKNOWN', reasons: [reason] };
}

function unknownMeter(reason) {
  return { state: 'UNKNOWN', reasonCodes: [reason], rules: [] };
}

function limitedSnapshot(snapshot, maximum) {
  if (!snapshot || !Array.isArray(snapshot.candidates)) return null;
  if (snapshot.candidates.length <= maximum) return snapshot;
  return {
    ...snapshot,
    candidates: snapshot.candidates.slice(0, maximum),
    completeness: { state: 'INCOMPLETE', reason: 'candidate_limit_reached' },
  };
}

function validSnapshot(snapshot) {
  return snapshot && Array.isArray(snapshot.candidates)
    && ['COMPLETE', 'INCOMPLETE'].includes(snapshot.completeness?.state);
}

function versionToken(version) {
  const raw = typeof version?.version === 'string' ? version.version
    : typeof version?.rowsUpdatedAt === 'string' ? version.rowsUpdatedAt : null;
  if (!raw) return null;
  const normalized = raw.trim().replace(/[^A-Za-z0-9._:+-]+/g, '_').replace(/^_+|_+$/g, '');
  if (normalized) return normalized.slice(0, 128);
  return null;
}

const REASON_MAP = Object.freeze({
  competing_roadways_overlap: 'competing_roadways',
  side_uncertainty: 'side_uncertain',
  endpoint_ambiguity: 'endpoint_ambiguity',
  official_face_missing: 'missing_bfi',
  implausible_geometry: 'implausible_geometry',
  evidence_insufficient: 'candidate_coverage_incomplete',
  candidate_source_incomplete: 'candidate_coverage_incomplete',
  candidate_coverage_incomplete: 'candidate_coverage_incomplete',
  unsupported_roadway_status: 'unsupported_roadway_status',
  source_version_mismatch: 'source_version_problem',
  official_alias_missing: 'alias_context_unavailable',
  official_face_context_incomplete: 'alias_context_unavailable',
  curb_identity_caution: 'curb_confidence_cap',
  curb_identity_unknown: 'curb_confidence_cap',
});

function reasonBuckets(values) {
  return [...new Set(values.map(value => REASON_MAP[value] || value)
    .filter(value => REASON_BUCKETS.has(value)))].sort();
}

async function runCurbIntelligenceShadow(input = {}) {
  const executionPolicy = policyOf(input.executionPolicy);
  const dependencies = input.dependencies || {};
  const sink = dependencies.sink || createNoopShadowSink();
  const overall = new AbortController();
  const overallTimer = setTimeout(() => overall.abort(), executionPolicy.overallDeadlineMs);
  const diagnostics = [];
  const legacy = adaptLegacyCleaningEvidence(input.legacyEvidence);

  try {
    const curbAttempt = await bounded(signal => resolveOfficialCurbRuntime(input.location, {
      candidateStore: dependencies.curbCandidateStore,
      modelErrorMeters: dependencies.modelErrorMeters,
      maxSearchRadiusMeters: dependencies.maxSearchRadiusMeters,
      maxCandidates: executionPolicy.maxCandidates.curb,
      signal,
    }), executionPolicy.sourceDeadlineMs.curb, overall.signal);
    if (!curbAttempt.ok) {
      diagnostics.push(curbAttempt.reason, 'cscl_unavailable');
      return await finish({
        resolution: { state: 'UNKNOWN', reasons: ['cscl_unavailable'], officialIdentity: null },
        runtimeEvidence: null,
        cleaning: unknownCleaning('cscl_unavailable'),
        meter: unknownMeter('cscl_unavailable'),
        legacy, diagnostics, dependencies, sink, executionPolicy, overall,
      });
    }
    const { resolution, runtimeEvidence } = curbAttempt.value;
    if (!runtimeEvidence) {
      diagnostics.push('candidate_coverage_incomplete');
      return await finish({
        resolution, runtimeEvidence: null,
        cleaning: unknownCleaning('candidate_coverage_incomplete'),
        meter: unknownMeter('candidate_coverage_incomplete'),
        legacy, diagnostics, dependencies, sink, executionPolicy, overall,
      });
    }

    const dotAttemptPromise = bounded(signal => dependencies.dotSource?.query({
      resolution, runtimeEvidence, signal, maxCandidates: executionPolicy.maxCandidates.dot,
    }), executionPolicy.sourceDeadlineMs.dot, overall.signal);
    const parkAttemptPromise = bounded(signal => dependencies.parkNycSource?.query({
      resolution, runtimeEvidence, signal, maxCandidates: executionPolicy.maxCandidates.parkNyc,
    }), executionPolicy.sourceDeadlineMs.parkNyc, overall.signal);
    const [dotAttempt, parkAttempt] = await Promise.all([dotAttemptPromise, parkAttemptPromise]);

    let cleaning;
    let dotSnapshot = null;
    if (!dotAttempt.ok || !dotAttempt.value) {
      diagnostics.push(dotAttempt.reason === 'execution_timeout' ? 'execution_timeout' : 'dot_unavailable', 'dot_unavailable');
      cleaning = unknownCleaning('dot_unavailable');
    } else if (!validSnapshot(dotAttempt.value)) {
      diagnostics.push('source_response_malformed');
      cleaning = unknownCleaning('source_response_malformed');
    } else if (!dependencies.officialRelationshipProvider
      || typeof dependencies.officialRelationshipProvider.resolve !== 'function') {
      cleaning = unknownCleaning('official_order_relationship_missing');
    } else {
      dotSnapshot = limitedSnapshot(dotAttempt.value, executionPolicy.maxCandidates.dot);
      const relationship = await bounded(signal => dependencies.officialRelationshipProvider.resolve({
        resolution, runtimeEvidence, candidateSnapshot: dotSnapshot, signal,
      }), executionPolicy.sourceDeadlineMs.relationship, overall.signal);
      const faceContext = relationship.ok && relationship.value?.ok === true
        ? createFaceAssociationContext(relationship.value.faceContext) : null;
      if (!faceContext?.complete) {
        cleaning = unknownCleaning('official_order_relationship_missing');
      } else {
        cleaning = associateCleaningRules({
          curbIdentity: resolution,
          faceContext,
          candidateSnapshot: dotSnapshot,
        });
        if (cleaning.reasons.includes('official_order_relationship_missing')) {
          cleaning = unknownCleaning('official_order_relationship_missing');
        }
      }
    }

    let meter;
    let parkSnapshot = null;
    if (!parkAttempt.ok || !parkAttempt.value?.candidateSnapshot) {
      diagnostics.push(parkAttempt.reason === 'execution_timeout' ? 'execution_timeout' : 'park_nyc_unavailable', 'park_nyc_unavailable');
      meter = unknownMeter('park_nyc_unavailable');
    } else if (!validSnapshot(parkAttempt.value.candidateSnapshot)) {
      diagnostics.push('source_response_malformed');
      meter = unknownMeter('source_response_malformed');
    } else {
      parkSnapshot = limitedSnapshot(parkAttempt.value.candidateSnapshot, executionPolicy.maxCandidates.parkNyc);
      const context = parkAttempt.value.associationContext || {};
      meter = associateParkNycRules({
        curbIdentity: resolution,
        resolvedPoint: runtimeEvidence.resolvedPoint,
        officialNames: context.officialNames,
        officialBounds: context.officialBounds,
        borough: context.borough,
        side: context.side,
        officialRoadwayEvidence: {
          officialBlockFaceId: runtimeEvidence.officialBlockFaceId,
          csclSide: runtimeEvidence.csclSide,
          selectedGeometry: runtimeEvidence.selectedGeometry,
          streetWidthFeet: runtimeEvidence.streetWidthFeet,
          modelUncertaintyMeters: runtimeEvidence.modelUncertaintyMeters,
          candidateCoverageComplete: runtimeEvidence.candidateCoverageComplete
            && context.officialRoadwayGeometryComplete === true,
          competingRoadways: runtimeEvidence.competingRoadways,
        },
        candidateSnapshot: parkSnapshot,
      });
    }

    return await finish({
      resolution, runtimeEvidence, cleaning, meter, legacy, diagnostics,
      dotSnapshot, parkSnapshot, dependencies, sink, executionPolicy, overall,
    });
  } catch {
    diagnostics.push('internal_shadow_error');
    return await finish({
      resolution: { state: 'UNKNOWN', reasons: ['internal_shadow_error'], officialIdentity: null },
      runtimeEvidence: null,
      cleaning: unknownCleaning('internal_shadow_error'), meter: unknownMeter('internal_shadow_error'),
      legacy, diagnostics, dependencies, sink, executionPolicy, overall,
    });
  } finally {
    clearTimeout(overallTimer);
  }
}

async function finish(context) {
  const sourceVersions = {};
  const cscl = versionToken(context.runtimeEvidence?.sourceVersion);
  const dot = versionToken(context.dotSnapshot?.sourceVersion);
  const park = versionToken(context.parkSnapshot?.sourceVersion);
  if (cscl) sourceVersions.cscl = cscl;
  if (dot) sourceVersions.dotSigns = dot;
  if (park) sourceVersions.parkNyc = park;
  const internal = createInternalCurbRuleResult({
    curbIdentity: context.resolution,
    cleaning: context.cleaning,
    meter: context.meter,
    sourceVersions,
    diagnostics: { reasons: [...new Set(context.diagnostics)] },
  });
  const comparison = compareCleaningEvidence(context.legacy, context.cleaning);
  const buckets = reasonBuckets([
    ...(context.resolution.reasons || []),
    ...(context.cleaning.reasons || []),
    ...(context.meter.reasonCodes || []),
    ...context.diagnostics,
  ]);
  const telemetry = createPersistableShadowTelemetry({
    schemaVersion: 'curb-shadow-aggregate-v1',
    engineVersion: context.dependencies.engineVersion || 'phase2a-v1',
    curbState: internal.states.curb,
    cleaningState: internal.states.cleaning,
    meterState: internal.states.meter,
    cleaningComparisonCategory: comparison.category,
    legacyCleaningPresent: context.legacy.availability === 'USABLE',
    newCleaningPresent: Boolean(context.cleaning.fingerprint),
    passengerMeterRulePresent: context.meter.rules.length > 0,
    cleaningRuleCount: context.cleaning.rules.length,
    meterRuleCount: context.meter.rules.length,
    reasonBuckets: buckets,
    sourceVersions,
  });
  const diagnostics = [...new Set(context.diagnostics)];
  const persistableComparison = telemetry.ok ? telemetry.telemetry : null;
  if (!telemetry.ok) diagnostics.push('internal_shadow_error');
  if (persistableComparison) {
    const sinkAttempt = await bounded(
      () => context.sink.record(persistableComparison),
      context.executionPolicy.sourceDeadlineMs.sink,
      context.overall.signal,
    );
    if (!sinkAttempt.ok) diagnostics.push('internal_shadow_error');
  }
  return {
    completed: true,
    runtimeResult: { ...internal, runtimeEvidence: context.runtimeEvidence, legacyEvidence: context.legacy },
    persistableComparison,
    diagnostics: [...new Set(diagnostics)],
  };
}

module.exports = { DEFAULT_EXECUTION_POLICY, bounded, runCurbIntelligenceShadow };
