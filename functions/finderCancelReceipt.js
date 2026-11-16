'use strict';

const { isClaimGenerationId } = require('./claimGeneration');
const {
  isGenerationless,
  timestampFingerprint,
  sameFingerprint,
  legacyToken,
} = require('./legacyClaimIdentity');

// Server-only record of an authorized finder cancellation. finderCancelSpot
// writes it in the same transaction that deletes the Ping. The delete trigger
// may create a finder-cancel notice or a handoffsCancelledByFinder penalty
// only when this record matches the deleted snapshot. Clients cannot read
// or write the collection. claimStartedAt is
// not part of the identity. The "_unclaimed" and "_stored_" tokens are path
// discriminators, not minted claim generation ids.
//
// S7 T2-G2 (t682u): a "legacy" receipt is written by finderCancelSpot for a
// generationless legacy claim. Its id carries "_legacy_<claimant>_<seconds>_
// <nanos>", a path discriminator from the deleted claim's claimStartedAt, not a
// generation. It authorizes the trust penalty once per legacy claim cycle and
// never a generation notice. Attribution for a generation snapshot is unchanged.

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
  if (identity.kind === 'legacy') suffix = legacyToken(identity.interestedUserId, identity.claimStartedAt);
  if (!suffix) return null;
  const id = `${spotId}_${suffix}`;
  return id.length <= ID_MAX ? id : null;
}

function receiptBody(spotId, identity) {
  if (identity.kind === 'legacy') {
    return {
      spotId,
      finderId: identity.finderId,
      status: identity.status,
      interestedUserId: identity.interestedUserId,
      claimState: identity.claimState || null,
      claimGenerationId: null,
      claimStartedAtSeconds: identity.claimStartedAt.seconds,
      claimStartedAtNanos: identity.claimStartedAt.nanoseconds,
      kind: 'legacy',
    };
  }
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

function legacyTrustEventId(spotId, token) {
  if (!safeToken(spotId) || typeof token !== 'string') return null;
  const eventId = `${spotId}:finder-cancel:${token}`;
  if (eventId.includes('/') || eventId.length > ID_MAX) return null;
  return eventId;
}

function receiptAuthorizesLegacy(receipt, spotId, data, fingerprint) {
  if (!receipt || receipt.kind !== 'legacy' || receipt.spotId !== spotId) return false;
  if (receipt.finderId !== data.finderId || receipt.status !== data.status) return false;
  if (receipt.interestedUserId !== textOrNull(data.interestedUserId)) return false;
  if ((receipt.claimState || null) !== textOrNull(data.claimState)) return false;
  if (receipt.claimGenerationId !== null) return false;
  return sameFingerprint({ seconds: receipt.claimStartedAtSeconds, nanoseconds: receipt.claimStartedAtNanos }, fingerprint);
}

async function readLegacyFinderCancelAttribution(db, spotId, data) {
  if (!data || data.status !== 'interested' || !isGenerationless(data)) return null;
  const uid = textOrNull(data.interestedUserId);
  const fingerprint = timestampFingerprint(data.claimStartedAt);
  if (!uid || !fingerprint) return null;
  const token = legacyToken(uid, fingerprint);
  const receiptId = receiptDocumentId(spotId, { kind: 'legacy', interestedUserId: uid, claimStartedAt: fingerprint });
  const eventId = legacyTrustEventId(spotId, token);
  if (!token || !receiptId || !eventId) return null;
  const snap = await db.collection(RECEIPT_COLLECTION).doc(receiptId).get();
  if (!snap.exists) return null;
  if (!receiptAuthorizesLegacy(snap.data() || {}, spotId, data, fingerprint)) return null;
  return { eventId, claimGenerationId: null };
}

async function readFinderCancelAttribution(db, spotId, data) {
  const generation = data && data.claimGenerationId;
  if (isGenerationless(data)) return readLegacyFinderCancelAttribution(db, spotId, data);
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
  receiptAuthorizesLegacy,
};
