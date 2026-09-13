'use strict';

const NYC_OD_EVIDENCE_REVALIDATION_VERSION = 'nyc_od_block_face_evidence_v1';

function isLegacyNYCOpenDataSegment(segment) {
  if (!segment || typeof segment !== 'object') return false;
  return segment.source === 'nyc_open_data'
    && segment.provenance?.provider === 'nyc_open_data'
    && segment.blockFaceEvidence == null
    && segment.status === 'needs_review'
    && segment.needsReview === true
    && segment.confidenceScore === 0.5
    && segment.confidence?.level === 'unverified'
    && segment.legacyRevalidation?.version !== NYC_OD_EVIDENCE_REVALIDATION_VERSION;
}

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
  segmentId, loadAndClaim, refresh, markFailed, cachedResult,
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
  await markFailed(claim.operationId, reason);
  return cachedResult(claim.segment, 'failed');
}

module.exports = {
  NYC_OD_EVIDENCE_REVALIDATION_VERSION,
  deriveNYCOpenDataConfidence,
  isLegacyNYCOpenDataSegment,
  runLegacyNYCOpenDataRevalidation,
};
