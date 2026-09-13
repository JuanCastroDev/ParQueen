export const NYC_OD_EVIDENCE_REVALIDATION_VERSION = 'nyc_od_block_face_evidence_v1';

export const isLegacyNYCOpenDataSegment = (segment: Record<string, any> | null): boolean => {
  if (!segment || typeof segment !== 'object') return false;
  return segment.source === 'nyc_open_data'
    && segment.provenance?.provider === 'nyc_open_data'
    && segment.blockFaceEvidence == null
    && segment.status === 'needs_review'
    && segment.needsReview === true
    && segment.confidenceScore === 0.5
    && segment.confidence?.level === 'unverified'
    && segment.legacyRevalidation?.version !== NYC_OD_EVIDENCE_REVALIDATION_VERSION;
};
