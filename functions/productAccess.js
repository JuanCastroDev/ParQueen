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

async function assertProductAccess(uid, db) {
  if (typeof uid !== 'string' || uid.length === 0) {
    throw new HttpsError('permission-denied', PRODUCT_ACCESS_DENIED);
  }
  const firestore = db || require('firebase-admin/firestore').getFirestore();
  const snap = await firestore.doc(`users/${uid}`).get();
  if (!snap.exists) return;
  if (userRecordDenies(snap.data())) {
    throw new HttpsError('permission-denied', PRODUCT_ACCESS_DENIED);
  }
}

module.exports = { userRecordDenies, assertProductAccess, PRODUCT_ACCESS_DENIED };
