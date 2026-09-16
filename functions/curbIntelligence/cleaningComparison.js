'use strict';

const RANK = Object.freeze({ UNKNOWN: 0, CAUTION: 1, SUPPORTED: 2 });

function compareCleaningEvidence(legacy, current) {
  if (!legacy || ['UNAVAILABLE', 'MALFORMED'].includes(legacy.availability)) {
    return { category: 'legacy_unavailable' };
  }
  if (legacy.availability === 'USABLE'
    && legacy.fingerprintsBySide
    && Object.keys(legacy.fingerprintsBySide).length !== 1) {
    return { category: 'legacy_side_context_unavailable' };
  }
  const oldFingerprint = legacy.fingerprint || null;
  const newFingerprint = current?.fingerprint || null;
  if (!oldFingerprint && !newFingerprint) return { category: 'both_no_usable_cleaning' };
  if (oldFingerprint && !newFingerprint) return { category: 'legacy_cleaning_only' };
  if (!oldFingerprint && newFingerprint) return { category: 'curb_intelligence_cleaning_only' };
  if (oldFingerprint !== newFingerprint) return { category: 'cleaning_schedule_differs' };
  const oldRank = RANK[legacy.confidence];
  const newRank = RANK[current?.confidence];
  if (oldRank === newRank) return { category: 'exact_agreement' };
  if (!Number.isInteger(oldRank) || !Number.isInteger(newRank)) {
    return { category: 'same_schedule_confidence_differs' };
  }
  return { category: newRank < oldRank ? 'new_more_cautious' : 'new_more_supported' };
}

module.exports = { compareCleaningEvidence };
