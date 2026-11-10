'use strict';

const { createHash, randomUUID } = require('node:crypto');
const {
  OVERALL_DEADLINE_MS,
  childBudgetMs,
  createRequestDeadline,
} = require('./requestDeadline');
const { publicCurbKey, toPublicCurb } = require('./canonicalCurbIdentity');
const {
  acquireAuthoritativeCscl,
  resolveCanonicalCurb,
  hasPrimaryTopologyAuthority,
  hasAmbiguousTopologyAuthority,
  hasSideConfirmationAuthority,
} = require('./canonicalCurbResolver');
const { logDemoResolutionDiagnostic } = require('./demoResolutionDiagnostic');
const { isSideConfirmationEnabled } = require('./sideConfirmation');
const { SIDE_CONFIRMATION_TOKEN_MAX_LENGTH } = require('./sideConfirmationToken');
const { applyVisualCurbSelection } = require('./visualCurbSelection');
const { loadCanonicalRules } = require('./canonicalRuleSources');
const { readCanonicalCache } = require('./canonicalCurbPersistence');
const {
  buildHighConfidenceResponse,
  requestIncludesExtendedResponse,
  selectedHasUnresolvedConflicts,
} = require('./canonicalCurbPublicResponse');
const {
  proveCanonicalCurbIdentity,
  hasCanonicalCurbIdentityProof,
} = require('./canonicalCurbIdentityProof');

const defaultInFlight = new Map();

const unsupported = reason => ({ protocolVersion: 2, status: 'unsupported', reason });

function mapCanonicalAuthorityFailure(value) {
  const reasons = Array.isArray(value) ? value : value?.reasons;
  const values = Array.isArray(reasons) ? reasons : [];
  if (values.some(reason => [
    'reported_accuracy_exceeds_limit', 'insufficient_samples', 'inconsistent_samples',
    'invalid_reported_accuracy', 'invalid_sample_count', 'invalid_consistency',
    'unsupported_off_network_location',
  ].includes(reason))) return 'location_quality';
  if (values.includes('intersection_complex') || values.includes('candidates_not_distinguishable')) {
    return 'intersection_complex';
  }
  if (values.some(reason => [
    'candidate_coverage_incomplete', 'candidate_incomplete', 'candidate_selection_stale',
    'candidate_token_invalid', 'candidate_token_unavailable', 'canonical_candidate_missing',
    'official_face_missing', 'ambiguity_unresolved', 'duplicate_candidate_identity',
    'duplicate_canonical_identity', 'source_query_truncated', 'invalid_candidate_row',
    'authority_population_mismatch', 'authority_envelope_mismatch', 'authority_attestation_invalid',
  ].includes(reason))) return 'candidate_incomplete';
  return 'source_unavailable';
}

function validRequest(request) {
  const location = request?.location;
  return request?.protocolVersion === 2
    && Number.isFinite(location?.lat) && Number.isFinite(location?.lng)
    && Number.isFinite(location?.accuracyMeters)
    && Number.isInteger(location?.sampleCount)
    && Number.isFinite(location?.consistencyMeters)
    && (request.candidateToken === undefined
      || (typeof request.candidateToken === 'string'
        && request.candidateToken.length <= SIDE_CONFIRMATION_TOKEN_MAX_LENGTH));
}

function requestKey(request) {
  return createHash('sha256').update(JSON.stringify({
    protocolVersion: request.protocolVersion,
    location: request.location,
    candidateToken: request.candidateToken || null,
  })).digest('hex');
}

function emit(telemetry, event, payload) {
  try { telemetry?.emit?.(event, payload); } catch { /* telemetry is fail-soft */ }
}

function highResponse(publicCurb, selected, options = {}) {
  return buildHighConfidenceResponse(publicCurb, selected, {
    cacheHit: options.cacheHit === true,
    includeExtended: options.includeExtended === true,
  });
}

function emptySelected() {
  return {
    cleaning: null, restrictions: [], timeLimits: [], meter: null, admin: [], conflicts: [], rules: [],
  };
}

async function loadSelectedRules(identity, dependencies) {
  const loadRules = dependencies.loadCanonicalRules || loadCanonicalRules;
  if (dependencies.signal?.aborted) return { aborted: true };
  let rulesResult;
  try {
    rulesResult = await loadRules(identity, dependencies);
  } catch {
    return { aborted: true };
  }
  if (dependencies.signal?.aborted || dependencies.resolutionClosed?.()) return { aborted: true };
  const dotComplete = rulesResult?.sources?.dot?.state === 'complete';
  const selectedRules = {
    ...(rulesResult?.selected || emptySelected()),
    rulesResolved: dotComplete,
  };
  for (const conflict of selectedRules.conflicts || []) {
    emit(dependencies.telemetry, 'source_conflict', {
      protocolVersion: 2,
      reason: 'source_conflict',
      sourceCategory: conflict?.sources?.[0],
      ruleCategory: conflict?.category,
    });
  }
  return { aborted: false, dotComplete, selectedRules };
}

async function execute(request, dependencies) {
  const startedAt = Date.now();
  const scoped = {
    ...dependencies,
    sideConfirmationEnabled: isSideConfirmationEnabled(dependencies),
  };
  emit(dependencies.telemetry, 'curb_resolution_attempted', {
    protocolVersion: 2,
    sampleCount: request.location.sampleCount,
    accuracyMeters: request.location.accuracyMeters,
    hasCandidateToken: Boolean(request.candidateToken),
  });
  let resolution;
  try {
    if (request.candidateToken) {
      const select = dependencies.applyVisualCurbSelection || applyVisualCurbSelection;
      resolution = await select({
        location: request.location,
        candidateToken: request.candidateToken,
      }, scoped);
    } else {
      const resolve = dependencies.resolveCanonicalCurb || resolveCanonicalCurb;
      const nonce = (dependencies.requestNonceFactory || randomUUID)();
      resolution = await resolve(request.location, { ...scoped, requestNonce: nonce });
    }
  } catch {
    emit(dependencies.telemetry, 'curb_resolution_unsupported', {
      protocolVersion: 2, reason: 'source_unavailable', latencyMs: Date.now() - startedAt,
    });
    return unsupported('source_unavailable');
  }

  if (dependencies.signal?.aborted) return unsupported('source_unavailable');

  if (resolution?.state === 'AMBIGUOUS' && !hasAmbiguousTopologyAuthority(resolution)) {
    resolution = { state: 'UNSUPPORTED', reasons: ['authority_invalid'] };
  }
  if (resolution?.state === 'SIDE_CONFIRMATION_REQUIRED' && !hasSideConfirmationAuthority(resolution)) {
    resolution = { state: 'UNSUPPORTED', reasons: ['authority_invalid'] };
  }
  if (resolution?.state === 'SIDE_CONFIRMATION_REQUIRED') {
    emit(dependencies.telemetry, 'curb_side_confirmation_required', {
      protocolVersion: 2,
      candidateCount: resolution.confirmation?.curbs?.length || 0,
    });
    return {
      protocolVersion: 2,
      status: 'side_confirmation_required',
      confirmation: resolution.confirmation,
    };
  }
  if (resolution?.state === 'SUPPORTED' && !hasPrimaryTopologyAuthority(resolution)) {
    resolution = { state: 'UNSUPPORTED', reasons: ['authority_invalid'] };
  }

  if (resolution?.state === 'AMBIGUOUS') {
    emit(dependencies.telemetry, 'curb_candidate_count', {
      protocolVersion: 2, candidateCount: resolution.candidates?.length || 0,
    });
    emit(dependencies.telemetry, 'intersection_ambiguity', {
      protocolVersion: 2, reason: 'intersection_complex',
      candidateCount: resolution.candidates?.length || 0,
    });
    emit(dependencies.telemetry, 'visual_curb_selector_shown', {
      protocolVersion: 2, candidateCount: resolution.candidates?.length || 0,
    });
    emit(dependencies.telemetry, 'curb_resolution_ambiguous', {
      protocolVersion: 2, candidateCount: resolution.candidates?.length || 0,
      latencyMs: Date.now() - startedAt,
    });
    return {
      protocolVersion: 2,
      status: 'ambiguous',
      selector: { center: resolution.center, candidates: resolution.candidates },
    };
  }
  if (resolution?.state !== 'SUPPORTED' || !resolution.identity) {
    const reason = mapCanonicalAuthorityFailure(resolution);
    if (resolution?.reasons?.includes('street_identity_conflict')) {
      emit(dependencies.telemetry, 'street_name_conflict', {
        protocolVersion: 2, reason: 'street_name_conflict',
      });
    }
    emit(dependencies.telemetry, 'curb_resolution_unsupported', {
      protocolVersion: 2,
      reason,
      candidateCount: resolution?.candidateCount,
      ...(request.candidateToken ? {} : { sourceCategory: 'cscl' }),
      latencyMs: Date.now() - startedAt,
    });
    return unsupported(reason);
  }

  const identityProof = await proveCanonicalCurbIdentity(resolution, {
    blockfaceResolver: dependencies.blockfaceResolver,
    signal: dependencies.signal,
  });
  if (!hasCanonicalCurbIdentityProof(identityProof, resolution)) {
    emit(dependencies.telemetry, 'curb_resolution_unsupported', {
      protocolVersion: 2,
      reason: 'source_unavailable',
      latencyMs: Date.now() - startedAt,
    });
    return unsupported('source_unavailable');
  }

  const identity = resolution.identity;
  if (request.candidateToken) {
    emit(dependencies.telemetry, 'visual_curb_selected', { protocolVersion: 2 });
  }
  const key = publicCurbKey(identity);
  const publicCurb = resolution.publicCurb || toPublicCurb(identity);
  if (!key || !publicCurb) return unsupported('candidate_incomplete');
  const readCache = dependencies.readCanonicalCache || readCanonicalCache;
  let cache = null;
  try {
    cache = await readCache({
      db: dependencies.db,
      topologyResult: resolution,
      identityProof,
    });
  } catch {
    cache = { hit: false, reason: 'cache_unavailable' };
  }
  if (cache?.reason === 'cache_curb_mismatch') {
    emit(dependencies.telemetry, 'cache_curb_mismatch', {
      protocolVersion: 2, reason: 'cache_curb_mismatch',
    });
  }
  const includeExtended = requestIncludesExtendedResponse(request);
  if (cache?.hit && cache.publicSegment) {
    const summary = cache.publicSegment.ruleSummary || {};
    const cachedRules = Array.isArray(cache.publicRules) ? cache.publicRules : [];
    const cacheComplete = cachedRules.length > 0
      || summary.cleaningAvailable === true
      || summary.rulesResolved === true;
    if (!cacheComplete) {
      const loaded = await loadSelectedRules(identity, dependencies);
      if (loaded.aborted) return unsupported('source_unavailable');
      if (loaded.dotComplete) {
        if (selectedHasUnresolvedConflicts(loaded.selectedRules)) {
          return unsupported('source_unavailable');
        }
        if (dependencies.signal?.aborted || dependencies.resolutionClosed?.()) return unsupported('source_unavailable');
        emit(dependencies.telemetry, 'curb_resolution_high', {
          protocolVersion: 2, cacheHit: true, latencyMs: Date.now() - startedAt,
        });
        return highResponse(publicCurb, loaded.selectedRules, { cacheHit: true, includeExtended });
      }
    } else if (cachedRules.length === 0 && summary.cleaningAvailable !== true && summary.rulesResolved !== true) {
      return unsupported('source_unavailable');
    } else {
      emit(dependencies.telemetry, 'curb_resolution_high', {
        protocolVersion: 2, cacheHit: true, latencyMs: Date.now() - startedAt,
      });
      return highResponse(cache.publicSegment, cachedRules, { cacheHit: true, includeExtended });
    }
  }

  const loaded = await loadSelectedRules(identity, dependencies);
  if (loaded.aborted) return unsupported('source_unavailable');
  const selectedRules = loaded.selectedRules;
  if (dependencies.signal?.aborted || dependencies.resolutionClosed?.()) return unsupported('source_unavailable');
  if (selectedHasUnresolvedConflicts(selectedRules)) return unsupported('source_unavailable');
  emit(dependencies.telemetry, 'curb_resolution_high', {
    protocolVersion: 2, cacheHit: false, latencyMs: Date.now() - startedAt,
  });
  return highResponse(publicCurb, selectedRules, { cacheHit: false, includeExtended });
}

async function boundedExecute(request, dependencies) {
  const controller = new AbortController();
  let closed = false;
  let finishAbort;
  const aborted = new Promise(resolve => { finishAbort = resolve; });
  const abort = () => {
    closed = true;
    controller.abort();
    finishAbort(unsupported('source_unavailable'));
  };
  dependencies.signal?.addEventListener('abort', abort, { once: true });
  if (dependencies.signal?.aborted) abort();
  const remaining = childBudgetMs(OVERALL_DEADLINE_MS, {
    deadlineAt: dependencies.deadlineAt,
    signal: dependencies.signal,
  });
  const timer = setTimeout(abort, remaining);
  try {
    if (closed) return unsupported('source_unavailable');
    return await Promise.race([
      execute(request, {
        ...dependencies,
        signal: controller.signal,
        resolutionClosed: () => closed,
      }),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    dependencies.signal?.removeEventListener('abort', abort);
  }
}

function publishStageTiming(dependencies, timing) {
  try { dependencies.observeResolutionTiming?.(timing); } catch { /* timing never changes resolution */ }
  logDemoResolutionDiagnostic({
    internalReason: timing.internalReason,
    stage: timing.stage,
    rawCsclCandidateCount: timing.rawCsclCandidateCount,
    elapsedMs: timing.totalServerElapsedMs,
    stageElapsedMs: timing.canonicalStageElapsedMs,
    sourceStageElapsedMs: timing.sourceStageElapsedMs,
    canonicalStageElapsedMs: timing.canonicalStageElapsedMs,
    initializationElapsedMs: timing.initializationElapsedMs,
    totalServerElapsedMs: timing.totalServerElapsedMs,
    ...(Number.isInteger(timing.spatialMs) ? {
      metadataBeforeMs: timing.metadataBeforeMs,
      spatialMs: timing.spatialMs,
      metadataAfterMs: timing.metadataAfterMs,
      spatialAttempts: timing.spatialAttempts,
    } : {}),
    ...(timing.spatialProtocol === 'soda2' || timing.spatialProtocol === 'soda3'
      ? { spatialProtocol: timing.spatialProtocol } : {}),
  }, dependencies.env);
}

async function runBoundedSourceThenCanonical(request, dependencies) {
  const enteredAt = Date.now();
  const initializationStartedAt = Number.isFinite(dependencies.initializationStartedAt)
    ? dependencies.initializationStartedAt
    : enteredAt;
  const initializationElapsedMs = Math.max(0, enteredAt - initializationStartedAt);
  const nonce = randomUUID();
  const sourceStarted = Date.now();
  const acquired = await acquireAuthoritativeCscl(request.location, {
    fetchFn: dependencies.fetchFn,
    getSocrataToken: dependencies.getSocrataToken,
    signal: dependencies.signal,
    acquisitionNonce: nonce,
    deadlineAt: dependencies.deadlineAt,
    sourceBudgetMs: childBudgetMs(OVERALL_DEADLINE_MS, {
      deadlineAt: dependencies.deadlineAt,
      signal: dependencies.signal,
    }),
  });
  const sourceStageElapsedMs = Date.now() - sourceStarted;
  const timing = {
    initializationElapsedMs,
    sourceStageElapsedMs,
    rawCsclCandidateCount: Number.isInteger(acquired.candidateCount) ? acquired.candidateCount : 0,
    metadataBeforeMs: acquired.stageTiming?.metadataBeforeMs,
    spatialMs: acquired.stageTiming?.spatialMs,
    metadataAfterMs: acquired.stageTiming?.metadataAfterMs,
    spatialAttempts: acquired.stageTiming?.spatialAttempts,
    spatialProtocol: acquired.stageTiming?.spatialProtocol,
  };
  if (!acquired.ok && mapCanonicalAuthorityFailure(acquired.reasons) === 'location_quality') {
    const canonicalStarted = Date.now();
    const result = await boundedExecute(request, {
      ...dependencies,
      fetchFn: undefined,
      attestedRetrieval: undefined,
      acquisitionNonce: undefined,
    });
    publishStageTiming(dependencies, {
      ...timing,
      canonicalStageElapsedMs: Date.now() - canonicalStarted,
      totalServerElapsedMs: Date.now() - initializationStartedAt,
      internalReason: result?.reason || acquired.reasons?.[0] || null,
      stage: 'classification',
    });
    return result;
  }
  if (!acquired.ok || dependencies.signal?.aborted) {
    const internalReason = acquired.reasons?.[0] || 'request_aborted';
    publishStageTiming(dependencies, {
      ...timing,
      canonicalStageElapsedMs: 0,
      totalServerElapsedMs: Date.now() - initializationStartedAt,
      internalReason,
      stage: 'cscl_retrieval',
    });
    return unsupported(mapCanonicalAuthorityFailure(acquired.reasons || ['request_aborted']));
  }
  const canonicalStarted = Date.now();
  const boundResolve = (location, options = {}) => resolveCanonicalCurb(location, {
    ...options,
    fetchFn: undefined,
    candidateStore: undefined,
    attestedRetrieval: acquired.retrieval,
    acquisitionNonce: nonce,
  });
  const result = await boundedExecute(request, {
    ...dependencies,
    fetchFn: undefined,
    attestedRetrieval: undefined,
    acquisitionNonce: undefined,
    resolveCanonicalCurb: boundResolve,
  });
  publishStageTiming(dependencies, {
    ...timing,
    canonicalStageElapsedMs: Date.now() - canonicalStarted,
    totalServerElapsedMs: Date.now() - initializationStartedAt,
    internalReason: result?.status === 'unsupported' ? result.reason : null,
    stage: result?.status === 'unsupported' ? 'cscl_retrieval' : null,
  });
  return result;
}

function inFlightReusable(existing) {
  if (!existing || typeof existing.then !== 'function') return false;
  if (existing.signal?.aborted) return false;
  if (Number.isFinite(existing.deadlineAt) && Date.now() >= existing.deadlineAt) return false;
  return true;
}

async function runCanonicalCurbOrchestrator(request, dependencies = {}) {
  if (request?.protocolVersion !== 2) return null;
  if (!validRequest(request)) return unsupported('location_quality');
  const safe = { ...dependencies };
  delete safe.attestedRetrieval;
  delete safe.acquisitionNonce;
  let ownedDeadline = null;
  if (!safe.signal || !Number.isFinite(safe.deadlineAt) || typeof safe.persistAllowed !== 'function') {
    ownedDeadline = createRequestDeadline({
      startedAt: Number.isFinite(safe.initializationStartedAt)
        ? safe.initializationStartedAt
        : Date.now(),
      signal: safe.signal,
    });
    safe.signal = ownedDeadline.signal;
    safe.deadlineAt = ownedDeadline.deadlineAt;
    safe.persistToken = ownedDeadline.persistToken;
    safe.persistAllowed = ownedDeadline.persistAllowed;
  }
  const inFlight = safe.inFlight || defaultInFlight;
  const key = requestKey(request);
  const existing = inFlight.get(key);
  if (inFlightReusable(existing)) return existing;
  const pending = (typeof safe.fetchFn === 'function'
    ? runBoundedSourceThenCanonical(request, safe)
    : boundedExecute(request, safe)
  ).finally(() => {
    if (inFlight.get(key) === pending) inFlight.delete(key);
    ownedDeadline?.dispose();
  });
  pending.deadlineAt = safe.deadlineAt;
  pending.signal = safe.signal;
  inFlight.set(key, pending);
  return pending;
}

module.exports = {
  runCanonicalCurbOrchestrator,
  OVERALL_DEADLINE_MS,
  CSCL_SOURCE_BUDGET_MS: OVERALL_DEADLINE_MS,
  mapCanonicalAuthorityFailure,
};
