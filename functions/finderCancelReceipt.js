'use strict';

const { isClaimGenerationId } = require('./claimGeneration');

// Server-only record of an authorized finder cancellation. finderCancelSpot
// writes it in the same transaction that deletes the Ping. The delete trigger
// may create a finder-cancel notice or a handoffsCancelledByFinder penalty
// only when this record matches the deleted snapshot. Clients cannot read
// or write the collection. claimStartedAt is
// not part of the identity. The "_unclaimed" and "_stored_" tokens are path
// discriminators, not minted claim generation ids.

const RECEIPT_COLLECTION = 'finderCancelReceipts';
const ID_MAX = 700;

function safeToken(value) {
  return typeof value === 'string' && value.length > 0 && !value.includes('/') && value !== '.' && value !== '..';
}

function receiptDocumentId(spotId, identity) {
  if (!safeToken(spotId) || !identity) return null;
  let suffix = null;
  if (identity.kind === 'generation' && safeToken(identity.claimGenerationId)) suffix = identity.claimGenerationId;
  if (identity.kind === 'stored_value' && safeToken(identity.claimGenerationId)) suffix = `stored_${identity.claimGenerationId}`;
  if (identity.kind === 'unclaimed') suffix = 'unclaimed';
  if (!suffix) return null;
  const id = `${spotId}_${suffix}`;
  return id.length <= ID_MAX ? id : null;
}

function receiptBody(spotId, identity) {
  return {
    spotId,
    finderId: identity.finderId,
    status: identity.status,
    interestedUserId: identity.interestedUserId || null,
    claimState: identity.claimState || null,
    claimGenerationId: identity.kind === 'unclaimed' ? null : identity.claimGenerationId,
    kind: identity.kind,
  };
}

function textOrNull(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return value;
}

function receiptAuthorizesNotice(receipt, spotId, data) {
  if (!receipt || receipt.kind !== 'generation' || receipt.spotId !== spotId) return false;
  if (receipt.finderId !== data.finderId || receipt.status !== data.status) return false;
  if (receipt.interestedUserId !== textOrNull(data.interestedUserId)) return false;
  if ((receipt.claimState || null) !== textOrNull(data.claimState)) return false;
  return receipt.claimGenerationId === data.claimGenerationId;
}

function finderCancelTrustEventId(spotId, generation) {
  if (!safeToken(spotId) || !isClaimGenerationId(generation)) return null;
  const eventId = `${spotId}:finder-cancel:${generation}`;
  if (eventId.includes('/') || eventId.length > ID_MAX) return null;
  return eventId;
}

async function readFinderCancelAttribution(db, spotId, data) {
  const generation = data && data.claimGenerationId;
  const eventId = finderCancelTrustEventId(spotId, generation);
  const receiptId = receiptDocumentId(spotId, { kind: 'generation', claimGenerationId: generation });
  if (!eventId || !receiptId) return null;
  const snap = await db.collection(RECEIPT_COLLECTION).doc(receiptId).get();
  if (!snap.exists) return null;
  if (!receiptAuthorizesNotice(snap.data() || {}, spotId, data)) return null;
  return { eventId, claimGenerationId: generation };
}

module.exports = {
  RECEIPT_COLLECTION,
  receiptDocumentId,
  receiptBody,
  receiptAuthorizesNotice,
  finderCancelTrustEventId,
  readFinderCancelAttribution,
};
