'use strict';

const { FieldPath, Timestamp } = require('firebase-admin/firestore');
const {
  TWO_HOURS_MS,
  finderAttestationId,
  isMutualSuccessPair,
} = require('./handoffSuccessContract');

// Juan 2026-10-02: unresolved arrived handoffs close two hours after arrivedAt.
// Mutual success (both timely participant attestations) is not an abandoned
// arrival. One-sided success is: past the same clock it becomes unconfirmed
// and the attestation document is left in place.
const DEFAULT_PAGE_SIZE = 200;
const MAX_PAGES = 10000;

function isTimestampLike(value) {
  if (!value || typeof value.toMillis !== 'function') return false;
  try {
    const millis = value.toMillis();
    return typeof millis === 'number' && Number.isFinite(millis);
  } catch {
    return false;
  }
}

/**
 * Eligible only when the Ping is still occupied, still awaiting an outcome,
 * and arrivedAt is a real timestamp strictly older than two hours.
 * Exactly two hours, younger, future, malformed, and missing are not eligible.
 */
function isEligibleAbandonedArrival(spot, nowMs) {
  if (!spot || spot.status !== 'occupied') return false;
  if (spot.claimState !== 'arrived_pending_outcome') return false;
  if (!isTimestampLike(spot.arrivedAt)) return false;
  return spot.arrivedAt.toMillis() < nowMs - TWO_HOURS_MS;
}

/** Occupied rows with no arrivedAt are measured and never written. */
function isLegacyOccupiedMissingArrivedAt(spot) {
  return !!spot
    && spot.status === 'occupied'
    && (spot.arrivedAt === undefined || spot.arrivedAt === null);
}

function feedbackDocId(spotId, claimerId) {
  if (typeof spotId !== 'string' || typeof claimerId !== 'string') return null;
  if (spotId.length === 0 || claimerId.length === 0) return null;
  if (spotId.length > 500 || claimerId.length > 500) return null;
  if (spotId.includes('/') || claimerId.includes('/')) return null;
  return `${spotId}_${claimerId}`;
}

function freshCounts() {
  return {
    scanned: 0,
    eligible: 0,
    converted: 0,
    skippedTerminal: 0,
    skippedLegacy: 0,
    error: 0,
  };
}

function formatAbandonedArrivalSweepLog(counts) {
  const n = (value) => (Number.isInteger(value) && value >= 0 ? String(value) : '0');
  return [
    'cleanupAbandonedArrivedHandoffs',
    `scanned=${n(counts.scanned)}`,
    `eligible=${n(counts.eligible)}`,
    `converted=${n(counts.converted)}`,
    `skipped-terminal=${n(counts.skippedTerminal)}`,
    `skipped-legacy=${n(counts.skippedLegacy)}`,
    `error=${n(counts.error)}`,
  ].join(' ');
}

/**
 * Close one abandoned arrival inside a transaction.
 * Failed feedback and a timely mutual success are terminal: they are not
 * overwritten and are not paired with claimState unconfirmed. A one-sided
 * success attestation is retained and the Ping becomes unconfirmed.
 * Returns converted | skipped-terminal | skipped-legacy | ineligible | missing | error.
 */
async function closeAbandonedArrivedHandoff(db, spotRef, nowMs) {
  return db.runTransaction(async (tx) => {
    const fresh = await tx.get(spotRef);
    if (!fresh.exists) return 'missing';
    const spot = fresh.data() || {};
    if (isLegacyOccupiedMissingArrivedAt(spot)) return 'skipped-legacy';
    if (!isEligibleAbandonedArrival(spot, nowMs)) return 'ineligible';

    const claimerId = spot.interestedUserId;
    const finderId = spot.finderId;
    const feedbackId = feedbackDocId(fresh.id, claimerId);
    if (!feedbackId || typeof finderId !== 'string' || finderId.length === 0 || finderId.includes('/')) {
      return 'error';
    }

    const feedbackRef = db.collection('spotFeedback').doc(feedbackId);
    const finderFeedbackRef = db.collection('spotFeedback').doc(finderAttestationId(fresh.id, claimerId));
    const feedbackSnap = await tx.get(feedbackRef);
    const finderSnap = await tx.get(finderFeedbackRef);
    const claimerData = feedbackSnap.exists ? feedbackSnap.data() : null;
    const finderData = finderSnap.exists ? finderSnap.data() : null;

    // Both timely success attestations beat cleanup. Do not write unconfirmed.
    // The award transaction sets completed_success; a retry of this sweep sees
    // that claimState and is no longer eligible.
    if (isMutualSuccessPair({
      spotId: fresh.id,
      claimerId,
      finderId,
      claimerDocId: feedbackId,
      claimerData,
      finderDocId: finderAttestationId(fresh.id, claimerId),
      finderData,
      spot,
    })) {
      return 'skipped-terminal';
    }

    if (feedbackSnap.exists) {
      const outcome = claimerData && claimerData.outcome;
      if (outcome === 'failed') return 'skipped-terminal';
      if (outcome === 'unconfirmed') {
        if (spot.claimState !== 'unconfirmed') {
          tx.update(spotRef, { claimState: 'unconfirmed' });
          return 'converted';
        }
        return 'skipped-terminal';
      }
      // One-sided or late success: seal the handoff. Keep the attestation.
      if (outcome === 'success' || outcome === 'participant_success') {
        tx.update(spotRef, { claimState: 'unconfirmed' });
        return 'converted';
      }
      return 'skipped-terminal';
    }

    if (finderData && (finderData.outcome === 'participant_success' || finderData.outcome === 'success')) {
      tx.update(spotRef, { claimState: 'unconfirmed' });
      return 'converted';
    }

    const address = typeof spot.address === 'string' ? spot.address : '';
    tx.set(feedbackRef, {
      spotId: fresh.id,
      userId: claimerId,
      finderId,
      outcome: 'unconfirmed',
      failureReason: null,
      address,
      createdAt: Timestamp.fromMillis(nowMs),
    });
    tx.update(spotRef, { claimState: 'unconfirmed' });
    return 'converted';
  });
}

async function sweepAbandonedArrivedHandoffs(db, nowMs, options = {}) {
  const pageSize = options.pageSize || DEFAULT_PAGE_SIZE;
  const counts = freshCounts();
  let cursor = null;

  for (let page = 0; page < MAX_PAGES; page++) {
    let query = db.collection('spots')
      .where('status', '==', 'occupied')
      .orderBy(FieldPath.documentId())
      .limit(pageSize);
    if (cursor) query = query.startAfter(cursor);

    let snap;
    try {
      snap = await query.get();
    } catch {
      counts.error++;
      return counts;
    }
    if (snap.empty) return counts;

    for (const docSnap of snap.docs) {
      counts.scanned++;
      const spot = docSnap.data() || {};
      if (isLegacyOccupiedMissingArrivedAt(spot)) {
        counts.skippedLegacy++;
        continue;
      }
      if (!isEligibleAbandonedArrival(spot, nowMs)) continue;

      let result;
      try {
        result = await closeAbandonedArrivedHandoff(db, docSnap.ref, nowMs);
      } catch {
        counts.error++;
        continue;
      }

      if (result === 'skipped-legacy') {
        counts.skippedLegacy++;
        continue;
      }
      if (result === 'ineligible' || result === 'missing') continue;
      if (result === 'converted') {
        counts.eligible++;
        counts.converted++;
      } else if (result === 'skipped-terminal') {
        counts.eligible++;
        counts.skippedTerminal++;
      } else {
        counts.eligible++;
        counts.error++;
      }
    }

    if (snap.size < pageSize) return counts;
    cursor = snap.docs[snap.docs.length - 1];
  }

  counts.error++;
  return counts;
}

module.exports = {
  TWO_HOURS_MS,
  isTimestampLike,
  isEligibleAbandonedArrival,
  isLegacyOccupiedMissingArrivedAt,
  closeAbandonedArrivedHandoff,
  sweepAbandonedArrivedHandoffs,
  formatAbandonedArrivalSweepLog,
};
