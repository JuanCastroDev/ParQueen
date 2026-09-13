export const NYC_OD_EVIDENCE_REVALIDATION_VERSION = 'nyc_od_block_face_evidence_v1';
// Keep these aligned with the transaction-side policy in functions/.
export const LEGACY_REVALIDATION_LEASE_MS = 2 * 60 * 1000;
export const LEGACY_REVALIDATION_RETRY_COOLDOWN_MS = 15 * 60 * 1000;

const timestampMillis = (value: any): number | null => {
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  if (value && typeof value.seconds === 'number') {
    return (value.seconds * 1000) + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  return null;
};

const markerAllowsRevalidation = (marker: any, nowMs: number): boolean => {
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
};

export const isLegacyNYCOpenDataSegment = (
  segment: Record<string, any> | null,
  nowMs: number = Date.now(),
): boolean => {
  if (!segment || typeof segment !== 'object') return false;
  return segment.source === 'nyc_open_data'
    && segment.provenance?.provider === 'nyc_open_data'
    && segment.blockFaceEvidence == null
    && segment.status === 'needs_review'
    && segment.needsReview === true
    && segment.confidenceScore === 0.5
    && segment.confidence?.level === 'unverified'
    && markerAllowsRevalidation(segment.legacyRevalidation, nowMs);
};
