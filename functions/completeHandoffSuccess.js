'use strict';

const { HttpsError } = require('firebase-functions/v2/https');
const { claimerAttestationId } = require('./handoffSuccessContract');

function validId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && !value.includes('/');
}

/**
 * Retry entry point for immutable success attestations. Firestore create
 * triggers complete new writes; this callable also lets an upgraded client
 * resume a valid attestation created before the one-party protocol shipped.
 * The join transaction re-reads every authoritative document and never trusts
 * participant or generation state supplied by the client.
 */
function createCompleteHandoffSuccessHandler({ db, assertProductAccess, joinMutualSuccess, deps }) {
  return async function completeHandoffSuccess(request) {
    const claimerId = request.auth?.uid;
    if (!claimerId) throw new HttpsError('unauthenticated', 'Sign in is required.');
    await assertProductAccess(claimerId, db);

    const { spotId, finderId } = request.data || {};
    if (!validId(spotId) || !validId(finderId) || claimerId === finderId) {
      throw new HttpsError('invalid-argument', 'A valid handoff identity is required.');
    }

    const feedbackId = claimerAttestationId(spotId, claimerId);
    const result = await joinMutualSuccess(db, {
      params: { feedbackId },
      data: {
        data: () => ({
          outcome: 'participant_success',
          spotId,
          userId: claimerId,
          finderId,
        }),
      },
    }, deps);

    if (result?.outcome === 'awarded' || result?.outcome === 'skipped_already_completed') {
      return result;
    }
    throw new HttpsError('failed-precondition', 'This handoff cannot be completed.');
  };
}

module.exports = { createCompleteHandoffSuccessHandler };
