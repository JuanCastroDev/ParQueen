'use strict';

// Design A (SEC-001) shared predicates for the mutual-success join and B4.
// TWO_HOURS_MS matches the existing abandoned-arrival clock: exactly two hours
// is still inside the window; strictly more than two hours is outside it.
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const PARTICIPANT_SUCCESS_OUTCOME = 'participant_success';

function isTimestampLike(value) {
  if (!value || typeof value.toMillis !== 'function') return false;
  try {
    const millis = value.toMillis();
    return typeof millis === 'number' && Number.isFinite(millis);
  } catch {
    return false;
  }
}

function claimerAttestationId(spotId, claimerId) {
  return `${spotId}_${claimerId}`;
}

function finderAttestationId(spotId, claimerId) {
  return `${spotId}_${claimerId}_finder`;
}

function sameParticipants(data, spotId, claimerId, finderId) {
  return !!data
    && data.spotId === spotId
    && data.userId === claimerId
    && data.finderId === finderId
    && typeof claimerId === 'string'
    && typeof finderId === 'string'
    && claimerId.length > 0
    && finderId.length > 0
    && claimerId !== finderId;
}

function isClaimerSuccessAttestation(docId, data, spotId, claimerId, finderId) {
  return docId === claimerAttestationId(spotId, claimerId)
    && !!data
    && data.outcome === PARTICIPANT_SUCCESS_OUTCOME
    && data.role === 'claimer'
    && sameParticipants(data, spotId, claimerId, finderId);
}

function isFinderSuccessAttestation(docId, data, spotId, claimerId, finderId) {
  return docId === finderAttestationId(spotId, claimerId)
    && !!data
    && data.outcome === PARTICIPANT_SUCCESS_OUTCOME
    && data.role === 'finder'
    && sameParticipants(data, spotId, claimerId, finderId);
}

function attestationCreatedAtMs(data) {
  if (!data || !isTimestampLike(data.createdAt)) return null;
  return data.createdAt.toMillis();
}

// Timely at exactly arrivedAt + 2 hours. Late only when createdAt is strictly
// after that instant, matching B4's "exactly two hours is not yet eligible".
function isTimelyAttestation(data, arrivedAtMs) {
  const createdAtMs = attestationCreatedAtMs(data);
  return createdAtMs != null && createdAtMs <= arrivedAtMs + TWO_HOURS_MS;
}

function isRewardableArrival(spot) {
  return !!spot
    && spot.status === 'occupied'
    && spot.claimState === 'arrived_pending_outcome'
    && isTimestampLike(spot.arrivedAt)
    && typeof spot.interestedUserId === 'string'
    && typeof spot.finderId === 'string';
}

function isMutualSuccessPair({
  spotId,
  claimerId,
  finderId,
  claimerDocId,
  claimerData,
  finderDocId,
  finderData,
  spot,
}) {
  if (!isRewardableArrival(spot)) return false;
  if (spot.interestedUserId !== claimerId || spot.finderId !== finderId) return false;
  if (!isClaimerSuccessAttestation(claimerDocId, claimerData, spotId, claimerId, finderId)) return false;
  if (!isFinderSuccessAttestation(finderDocId, finderData, spotId, claimerId, finderId)) return false;
  const arrivedAtMs = spot.arrivedAt.toMillis();
  return isTimelyAttestation(claimerData, arrivedAtMs)
    && isTimelyAttestation(finderData, arrivedAtMs);
}

module.exports = {
  TWO_HOURS_MS,
  PARTICIPANT_SUCCESS_OUTCOME,
  isTimestampLike,
  claimerAttestationId,
  finderAttestationId,
  isClaimerSuccessAttestation,
  isFinderSuccessAttestation,
  isTimelyAttestation,
  isRewardableArrival,
  isMutualSuccessPair,
};
