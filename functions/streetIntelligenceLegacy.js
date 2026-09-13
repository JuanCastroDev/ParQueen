'use strict';

const NYC_OD_EVIDENCE_REVALIDATION_VERSION = 'nyc_od_block_face_evidence_v1';
// The longest declared upstream query budgets are 15s and 10s. Two minutes
// leaves generous headroom for reverse geocoding and Socrata paging without
// overlapping a healthy invocation, while still recovering crashed containers.
// Transient failures cool down longer so lookups do not amplify an outage.
const LEGACY_REVALIDATION_LEASE_MS = 2 * 60 * 1000;
const LEGACY_REVALIDATION_RETRY_COOLDOWN_MS = 15 * 60 * 1000;

function timestampMillis(value) {
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (value && typeof value.seconds === 'number') {
    return (value.seconds * 1000) + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  return null;
}

function markerAllowsRevalidation(marker, nowMs) {
  if (!marker || marker.version !== NYC_OD_EVIDENCE_REVALIDATION_VERSION) return true;
  if (marker.state === 'complete' || marker.state === 'terminal_caution') return false;
  if (marker.state === 'in_progress') {
    const startedAt = timestampMillis(marker.startedAt);
    return startedAt == null || startedAt + LEGACY_REVALIDATION_LEASE_MS <= nowMs;
  }
  if (marker.state === 'failed') {
    const retryAfter = timestampMillis(marker.retryAfter);
    if (retryAfter != null) return retryAfter <= nowMs;
    const completedAt = timestampMillis(marker.completedAt);
    return completedAt == null
      || completedAt + LEGACY_REVALIDATION_RETRY_COOLDOWN_MS <= nowMs;
  }
  return false;
}

function isLegacyNYCOpenDataSegment(segment, nowMs = Date.now()) {
  if (!segment || typeof segment !== 'object') return false;
  return segment.source === 'nyc_open_data'
    && segment.provenance?.provider === 'nyc_open_data'
    && segment.blockFaceEvidence == null
    && segment.status === 'needs_review'
    && segment.needsReview === true
    && segment.confidenceScore === 0.5
    && segment.confidence?.level === 'unverified'
    && markerAllowsRevalidation(segment.legacyRevalidation, nowMs);
}

const DETERMINISTIC_CAUTION_REASONS = new Set([
  'nyc_open_data_ambiguous_block',
  'legacy_revalidation_target_changed',
  'no_sweepnyc_data',
]);

function deriveNYCOpenDataConfidence(evidence) {
  const decisive = evidence?.blockDecisive === true
    && evidence?.sideResolved === true
    && evidence?.parseComplete === true;
  return {
    decisive,
    needsReview: !decisive,
    status: decisive ? 'active' : 'needs_review',
    confidenceScore: decisive ? 0.9 : 0.5,
    level: decisive ? 'community' : 'unverified',
  };
}

async function runLegacyNYCOpenDataRevalidation({
  segmentId, loadAndClaim, refresh, markFailed, markTerminal, cachedResult,
  nowMs = Date.now,
}) {
  const claim = await loadAndClaim(segmentId);
  if (!claim?.segment) return { success: false, reason: 'legacy_segment_missing' };
  if (!claim.acquired) return cachedResult(claim.segment, claim.state || 'cached');

  let result;
  try {
    result = await refresh(claim.operationId);
  } catch {
    result = { success: false, reason: 'legacy_revalidation_failed' };
  }
  if (result?.success) return { ...result, revalidation: 'complete' };

  const reason = typeof result?.reason === 'string'
    ? result.reason
    : 'legacy_revalidation_failed';
  if (DETERMINISTIC_CAUTION_REASONS.has(reason)) {
    await markTerminal(claim.operationId, reason);
    return cachedResult(claim.segment, 'terminal_caution');
  }
  await markFailed(
    claim.operationId,
    reason,
    nowMs() + LEGACY_REVALIDATION_RETRY_COOLDOWN_MS,
  );
  return cachedResult(claim.segment, 'failed');
}

module.exports = {
  LEGACY_REVALIDATION_LEASE_MS,
  LEGACY_REVALIDATION_RETRY_COOLDOWN_MS,
  NYC_OD_EVIDENCE_REVALIDATION_VERSION,
  deriveNYCOpenDataConfidence,
  isLegacyNYCOpenDataSegment,
  runLegacyNYCOpenDataRevalidation,
};
