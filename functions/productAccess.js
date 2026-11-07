'use strict';

const { HttpsError } = require('firebase-functions/v2/https');

// Same contract as firestore.rules userRecordDenies / productAccessDenied.
// A missing user document does not deny: first-time onboarding has no profile.
// status Suspended denies. A present productAccessBlocked denies unless it is
// exactly boolean false. The client never supplies this decision.
const PRODUCT_ACCESS_DENIED = 'Product access is not available.';

function userRecordDenies(data) {
  if (!data || typeof data !== 'object') return false;
  if (data.status === 'Suspended') return true;
  if (!Object.prototype.hasOwnProperty.call(data, 'productAccessBlocked')) return false;
  return data.productAccessBlocked !== false;
}

function lifecycleDoc(firestore, uid) {
  return firestore.doc(`accountLifecycle/${uid}`);
}

// Fail closed. A read error is a denial, not proof that no fence exists.
async function deletionFencePresent(uid, db) {
  if (typeof uid !== 'string' || uid.length === 0) {
    throw new HttpsError('permission-denied', PRODUCT_ACCESS_DENIED);
  }
  const firestore = db || require('firebase-admin/firestore').getFirestore();
  try {
    const snap = await lifecycleDoc(firestore, uid).get();
    return snap.exists;
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('permission-denied', PRODUCT_ACCESS_DENIED);
  }
}

async function assertProductAccess(uid, db) {
  if (typeof uid !== 'string' || uid.length === 0) {
    throw new HttpsError('permission-denied', PRODUCT_ACCESS_DENIED);
  }
  if (await deletionFencePresent(uid, db)) {
    throw new HttpsError('permission-denied', PRODUCT_ACCESS_DENIED);
  }
  const firestore = db || require('firebase-admin/firestore').getFirestore();
  let snap;
  try {
    snap = await firestore.doc(`users/${uid}`).get();
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    throw new HttpsError('permission-denied', PRODUCT_ACCESS_DENIED);
  }
  if (!snap.exists) return;
  if (userRecordDenies(snap.data())) {
    throw new HttpsError('permission-denied', PRODUCT_ACCESS_DENIED);
  }
}

module.exports = {
  userRecordDenies,
  assertProductAccess,
  deletionFencePresent,
  PRODUCT_ACCESS_DENIED,
};
