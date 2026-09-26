'use strict';

const { createHash, randomUUID } = require('node:crypto');
const { publicCurbKey, toPublicCurb } = require('./canonicalCurbIdentity');
const { resolveCanonicalCurb } = require('./canonicalCurbResolver');
const { applyVisualCurbSelection } = require('./visualCurbSelection');
const { loadCanonicalRules } = require('./canonicalRuleSources');
const { readCanonicalCache, persistCanonicalCurb } = require('./canonicalCurbPersistence');

const defaultInFlight = new Map();
const OVERALL_DEADLINE_MS = 8000;

const unsupported = reason => ({ protocolVersion: 2, status: 'unsupported', reason });

function publicReason(reasons) {
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
    'official_face_missing', 'ambiguity_unresolved',
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
      || (typeof request.candidateToken === 'string' && request.candidateToken.length <= 256));
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

function highResponse(publicCurb, cleaningAvailable) {
  return {
    protocolVersion: 2,
    status: 'high_confidence',
    segmentId: publicCurb.segmentId,
    streetName: publicCurb.streetName,
    sideLabel: publicCurb.sideLabel,
    ruleSummary: { cleaningAvailable: cleaningAvailable === true },
  };
}

async function execute(request, dependencies) {
  const startedAt = Date.now();
  emit(dependencies.telemetry, 'curb_resolution_attempted', {
    protocolVersion: 2,
    sampleCount: request.location.sampleCount,
    hasCandidateToken: Boolean(request.candidateToken),
  });
  let resolution;
  try {
    if (request.candidateToken) {
      const select = dependencies.applyVisualCurbSelection || applyVisualCurbSelection;
      resolution = await select({
        location: request.location,
        candidateToken: request.candidateToken,
      }, dependencies);
    } else {
      const resolve = dependencies.resolveCanonicalCurb || resolveCanonicalCurb;
      const nonce = (dependencies.requestNonceFactory || randomUUID)();
      resolution = await resolve(request.location, { ...dependencies, requestNonce: nonce });
    }
  } catch {
    emit(dependencies.telemetry, 'curb_resolution_unsupported', {
      protocolVersion: 2, reason: 'source_unavailable', latencyMs: Date.now() - startedAt,
    });
    return unsupported('source_unavailable');
  }

  if (dependencies.signal?.aborted) return unsupported('source_unavailable');

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
    const reason = publicReason(resolution?.reasons);
    if (resolution?.reasons?.includes('street_identity_conflict')) {
      emit(dependencies.telemetry, 'street_name_conflict', {
        protocolVersion: 2, reason: 'street_name_conflict',
      });
    }
    emit(dependencies.telemetry, 'curb_resolution_unsupported', {
      protocolVersion: 2, reason, latencyMs: Date.now() - startedAt,
    });
    return unsupported(reason);
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
    cache = await readCache({ db: dependencies.db, publicCurbKey: key });
  } catch {
    cache = { hit: false, reason: 'cache_unavailable' };
  }
  if (cache?.reason === 'cache_curb_mismatch') {
    emit(dependencies.telemetry, 'cache_curb_mismatch', {
      protocolVersion: 2, reason: 'cache_curb_mismatch',
    });
  }
  if (cache?.hit && cache.publicSegment) {
    emit(dependencies.telemetry, 'curb_resolution_high', {
      protocolVersion: 2, cacheHit: true, latencyMs: Date.now() - startedAt,
    });
    return highResponse(cache.publicSegment, cache.publicSegment.ruleSummary?.cleaningAvailable);
  }

  const loadRules = dependencies.loadCanonicalRules || loadCanonicalRules;
  if (dependencies.signal?.aborted) return unsupported('source_unavailable');
  let rulesResult;
  try {
    rulesResult = await loadRules(identity, dependencies);
  } catch {
    rulesResult = { state: 'complete', sources: {}, selected: {
      cleaning: null, restrictions: [], timeLimits: [], meter: null, admin: [], conflicts: [], rules: [],
    } };
  }
  const selectedRules = rulesResult?.selected || {
    cleaning: null, restrictions: [], timeLimits: [], meter: null, admin: [], conflicts: [], rules: [],
  };
  for (const conflict of selectedRules.conflicts || []) {
    emit(dependencies.telemetry, 'source_conflict', {
      protocolVersion: 2,
      reason: 'source_conflict',
      sourceCategory: conflict?.sources?.[0],
      ruleCategory: conflict?.category,
    });
  }
  if (dependencies.signal?.aborted) return unsupported('source_unavailable');
  const persist = dependencies.persistCanonicalCurb || persistCanonicalCurb;
  let persisted;
  try {
    persisted = await persist({
      db: dependencies.db,
      Timestamp: dependencies.Timestamp,
      identity,
      selectedRules,
    });
  } catch {
    persisted = { success: false };
  }
  if (!persisted?.success) return unsupported('source_unavailable');
  emit(dependencies.telemetry, 'curb_resolution_high', {
    protocolVersion: 2, cacheHit: false, latencyMs: Date.now() - startedAt,
  });
  return highResponse(publicCurb, Boolean(selectedRules.cleaning));
}

async function boundedExecute(request, dependencies) {
  const controller = new AbortController();
  let finishAbort;
  const aborted = new Promise(resolve => { finishAbort = resolve; });
  const abort = () => {
    controller.abort();
    finishAbort(unsupported('source_unavailable'));
  };
  dependencies.signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, OVERALL_DEADLINE_MS);
  try {
    return await Promise.race([
      execute(request, { ...dependencies, signal: controller.signal }),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    dependencies.signal?.removeEventListener('abort', abort);
  }
}

async function runCanonicalCurbOrchestrator(request, dependencies = {}) {
  if (request?.protocolVersion !== 2) return null;
  if (!validRequest(request)) return unsupported('location_quality');
  const inFlight = dependencies.inFlight || defaultInFlight;
  const key = requestKey(request);
  if (inFlight.has(key)) return inFlight.get(key);
  const pending = boundedExecute(request, dependencies).finally(() => inFlight.delete(key));
  inFlight.set(key, pending);
  return pending;
}

module.exports = { runCanonicalCurbOrchestrator, OVERALL_DEADLINE_MS };
