'use strict';

const { Timestamp } = require('firebase-admin/firestore');
const { isClaimGenerationId } = require('./claimGeneration');
const {
  RECEIPT_COLLECTION,
  receiptDocumentId,
  receiptAuthorizesNotice,
} = require('./finderCancelReceipt');

const NOTICE_MESSAGE = 'The spot is no longer available.';

// One server notice document per spot, claimant, and generation. A second
// delivery of the same deletion finds that document and does not create
// another. This is not an Eventarc exactly-once claim. A historical client
// notice with a random id is not consulted: it is not authoritative, and a
// bounded query can miss it. The server document may therefore sit beside
// one older client document.

function noticeId(spotId, uid, generation) {
  if (typeof spotId !== 'string' || typeof uid !== 'string') return null;
  if (!spotId || !uid || spotId.includes('/') || uid.includes('/')) return null;
  if (!isClaimGenerationId(generation)) return null;
  const id = `finder_cancelled_${spotId}_${uid}_${generation}`;
  return id.length <= 700 ? id : null;
}

function isNoticeCandidate(data, eventTimeMs) {
  if (!data || data.status !== 'interested' || typeof data.finderId !== 'string' || !data.finderId) return false;
  if (typeof data.interestedUserId !== 'string' || !data.interestedUserId) return false;
  if (data.source === 'admin') return false;
  const expiresAt = data.expiresAt;
  if (expiresAt && typeof expiresAt.toMillis === 'function' && Number.isFinite(eventTimeMs)) {
    if (expiresAt.toMillis() <= eventTimeMs) return false;
  }
  return true;
}

async function writeFinderCancelNotice(db, spotId, data, eventId, eventTimeMs) {
  try {
    if (!isNoticeCandidate(data, eventTimeMs)) return { wrote: false, reason: 'not_applicable' };
    const uid = data.interestedUserId;
    const id = noticeId(spotId, uid, data.claimGenerationId);
    if (!id) return { wrote: false, reason: 'no_generation' };
    const receiptId = receiptDocumentId(spotId, {
      kind: 'generation',
      claimGenerationId: data.claimGenerationId,
    });
    if (!receiptId) return { wrote: false, reason: 'no_generation' };
    return await db.runTransaction(async (tx) => {
      const receiptSnap = await tx.get(db.collection(RECEIPT_COLLECTION).doc(receiptId));
      if (!receiptSnap.exists) return { wrote: false, reason: 'no_receipt' };
      if (!receiptAuthorizesNotice(receiptSnap.data(), spotId, data)) {
        return { wrote: false, reason: 'receipt_mismatch' };
      }
      const ref = db.collection('spotNotifications').doc(id);
      const snap = await tx.get(ref);
      if (snap.exists) return { wrote: false, reason: 'already_recorded', id };
      tx.set(ref, {
        spotId,
        senderId: data.finderId,
        targetUserId: uid,
        type: 'cancelled',
        message: NOTICE_MESSAGE,
        createdAt: Timestamp.now(),
      });
      return { wrote: true, id };
    });
  } catch (error) {
    return { wrote: false, reason: 'write_failed' };
  }
}

module.exports = {
  NOTICE_MESSAGE,
  noticeId,
  isNoticeCandidate,
  writeFinderCancelNotice,
};
