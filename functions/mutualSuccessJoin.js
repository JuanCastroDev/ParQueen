'use strict';

const { FieldValue, Timestamp } = require('firebase-admin/firestore');
const {
  PARTICIPANT_SUCCESS_OUTCOME,
  claimerAttestationId,
  finderAttestationId,
  isClaimerSuccessAttestation,
  isClaimerAuthoritativeSuccess,
  isLegacyMutualSuccessPair,
  isTimelyAttestation,
  isTimestampLike,
} = require('./handoffSuccessContract');

function markerPayload(outcome, pairId, claimerId, finderId) {
  return {
    functionName: 'awardCrowns',
    feedbackId: pairId,
    driverId: claimerId,
    finderId,
    outcome,
    processedAt: Timestamp.now(),
  };
}

function terminalSkipReason(spot, claimerDocId, claimerData, spotId, claimerId, finderId) {
  if (!spot || spot.claimState === 'unconfirmed') return 'skipped_not_pending';
  if (spot.claimState === 'completed_success') return 'skipped_already_completed';
  if (spot.claimState !== 'arrived_pending_outcome') return 'skipped_not_pending';
  if (!isTimestampLike(spot.arrivedAt) || spot.status !== 'occupied') return 'skipped_no_arrival';
  if (spot.interestedUserId !== claimerId || spot.finderId !== finderId) return 'skipped_mismatch';

  const claimerOk = isClaimerSuccessAttestation(claimerDocId, claimerData, spotId, claimerId, finderId);
  if (claimerOk) {
    const arrivedAtMs = spot.arrivedAt.toMillis();
    if (!isTimelyAttestation(claimerData, arrivedAtMs)) {
      return 'skipped_late';
    }
    if (typeof claimerData.claimGenerationId === 'string'
      && claimerData.claimGenerationId !== spot.claimGenerationId) return 'skipped_generation_mismatch';
  }
  return 'skipped_mismatch';
}

/**
 * Award Crowns and finder trust from the legitimate claimer's immutable
 * success attestation. The transaction revalidates the durable arrival,
 * participants, exact modern generation or bounded legacy mutual attestations,
 * and writes rewards, terminal state, informational finder notification, and
 * the idempotency marker together.
 */
async function joinMutualSuccess(db, event, deps) {
  const data = event.data?.data();
  if (!data || data.outcome !== PARTICIPANT_SUCCESS_OUTCOME) return { outcome: 'ignored' };

  const spotId = data.spotId;
  const claimerId = data.userId;
  const finderId = data.finderId;
  if (typeof spotId !== 'string' || typeof claimerId !== 'string' || typeof finderId !== 'string') return { outcome: 'ignored' };
  if (!spotId || !claimerId || !finderId) return { outcome: 'ignored' };
  if (spotId.includes('/') || claimerId.includes('/') || finderId.includes('/')) return { outcome: 'ignored' };
  if (claimerId === finderId) return { outcome: 'ignored' };

  const claimerDocId = claimerAttestationId(spotId, claimerId);
  const finderDocId = finderAttestationId(spotId, claimerId);
  const triggeredId = event.params && event.params.feedbackId;
  if (triggeredId !== claimerDocId && triggeredId !== finderDocId) return { outcome: 'ignored' };

  const pairId = claimerDocId;
  const processedRef = db.doc(`functionEvents/awardCrowns_${pairId}`);
  const trustEventId = `${pairId}:finder`;
  const claimerFbRef = db.doc(`spotFeedback/${claimerDocId}`);
  const finderFbRef = db.doc(`spotFeedback/${finderDocId}`);
  const spotRef = db.doc(`spots/${spotId}`);
  const driverRef = db.doc(`users/${claimerId}`);
  const finderRef = db.doc(`users/${finderId}`);
  const trustRef = db.doc(`users/${finderId}/processedTrustEvents/${trustEventId}`);
  const notificationRef = db.doc(`spotNotifications/handoff_success_${pairId}`);

  return db.runTransaction(async (tx) => {
    const [
      processedSnap,
      claimerFb,
      finderFb,
      spotSnap,
      driverSnap,
      finderSnap,
      trustSnap,
    ] = await Promise.all([
      tx.get(processedRef),
      tx.get(claimerFbRef),
      tx.get(finderFbRef),
      tx.get(spotRef),
      tx.get(driverRef),
      tx.get(finderRef),
      tx.get(trustRef),
    ]);

    if (processedSnap.exists) return { outcome: processedSnap.data()?.outcome || 'already_processed' };
    if (!claimerFb.exists) return { outcome: 'pending_attestation' };

    const claimerData = claimerFb.data() || {};
    const finderData = finderFb.exists ? (finderFb.data() || {}) : null;
    const spot = spotSnap.exists ? (spotSnap.data() || {}) : null;

    if (claimerData.outcome === 'failed') {
      tx.set(processedRef, markerPayload('skipped_claimer_failure', pairId, claimerId, finderId));
      return { outcome: 'skipped_claimer_failure' };
    }

    const modernAuthoritative = isClaimerAuthoritativeSuccess({
      spotId,
      claimerId,
      finderId,
      claimerDocId,
      claimerData,
      spot,
    });
    const isLegacyRequest = claimerData.claimGenerationId == null;
    if (isLegacyRequest && !finderFb.exists) return { outcome: 'pending_legacy_finder' };
    const legacyAuthoritative = isLegacyRequest && isLegacyMutualSuccessPair({
      spotId,
      claimerId,
      finderId,
      claimerDocId,
      claimerData,
      finderDocId,
      finderData,
      spot,
    });

    if (!modernAuthoritative && !legacyAuthoritative) {
      tx.set(processedRef, markerPayload(
        terminalSkipReason(spot, claimerDocId, claimerData, spotId, claimerId, finderId),
        pairId,
        claimerId,
        finderId,
      ));
      return { outcome: terminalSkipReason(spot, claimerDocId, claimerData, spotId, claimerId, finderId) };
    }

    if (!driverSnap.exists || !finderSnap.exists) {
      tx.set(processedRef, markerPayload('skipped_missing_user', pairId, claimerId, finderId));
      return { outcome: 'skipped_missing_user' };
    }

    const { getTitleForCrowns, defaultTrustStats, computeTrustScore } = deps;
    const driverCrowns = (driverSnap.data().crowns || 0) + 1;
    const finderCrowns = (finderSnap.data().crowns || 0) + 2;
    const finderUpdate = {
      crowns: FieldValue.increment(2),
      title: getTitleForCrowns(finderCrowns),
    };

    if (!trustSnap.exists) {
      const stats = { ...defaultTrustStats(), ...(finderSnap.data().trustStats || {}) };
      stats.handoffsCompleted = (stats.handoffsCompleted || 0) + 1;
      finderUpdate.trustStats = stats;
      finderUpdate.trustScore = computeTrustScore(stats);
      tx.set(trustRef, {
        processedAt: Timestamp.now(),
        statField: 'handoffsCompleted',
        source: 'claimer_success',
      });
    }

    tx.update(driverRef, {
      crowns: FieldValue.increment(1),
      title: getTitleForCrowns(driverCrowns),
    });
    tx.update(finderRef, finderUpdate);
    tx.update(spotRef, { claimState: 'completed_success' });
    tx.set(notificationRef, {
      spotId,
      senderId: claimerId,
      targetUserId: finderId,
      type: 'handoff_success',
      message: 'The other driver parked successfully — +2 Crowns earned!',
      createdAt: Timestamp.now(),
    });
    tx.set(processedRef, markerPayload('awarded', pairId, claimerId, finderId));

    console.log(`Crowns awarded: driver ${claimerId.slice(0, 4)}*** +1 (${driverCrowns}), finder ${finderId.slice(0, 4)}*** +2 (${finderCrowns})`);
    return { outcome: 'awarded' };
  });
}

module.exports = {
  joinMutualSuccess,
};
