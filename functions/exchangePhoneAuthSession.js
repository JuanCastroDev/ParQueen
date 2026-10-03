'use strict';

const { HttpsError } = require('firebase-functions/v2/https');

// Created manually later. Do not deploy this function until that account exists.
// It needs roles/iam.serviceAccountTokenCreator on itself (iam.serviceAccounts.signBlob),
// roles/datastore.user for the Firestore rate-limit writes, and roles/logging.logWriter.
// The deployer needs roles/iam.serviceAccountUser on this account. IAM API must be enabled.
const AUTH_BRIDGE_SERVICE_ACCOUNT =
  'parqueen-auth-bridge@parkqueen-46475363-ccf36.iam.gserviceaccount.com';

const RATE_LIMIT = { limit: 8, windowSec: 600 };

/** Native phone sign-in must be this recent before a custom token is minted. */
const PHONE_AUTH_MAX_AGE_SEC = 120;

/** Clock skew below this is not treated as a future auth_time. */
const PHONE_AUTH_FUTURE_SKEW_SEC = 30;

function phoneSignInProvider(request) {
  const firebaseClaims = request && request.auth && request.auth.token && request.auth.token.firebase;
  return firebaseClaims && firebaseClaims.sign_in_provider;
}

function tokenAuthTime(request) {
  const token = request && request.auth && request.auth.token;
  return token ? token.auth_time : undefined;
}

function assertFreshPhoneAuth(authTime, nowMs) {
  if (typeof authTime !== 'number' || !Number.isFinite(authTime)) {
    throw new HttpsError('failed-precondition', 'Phone authentication is not fresh.');
  }
  const nowSec = nowMs / 1000;
  if (authTime > nowSec + PHONE_AUTH_FUTURE_SKEW_SEC || nowSec - authTime > PHONE_AUTH_MAX_AGE_SEC) {
    throw new HttpsError('failed-precondition', 'Phone authentication is not fresh.');
  }
}

/**
 * Mint a custom token for the already-authenticated phone user.
 * The mint target is always request.auth.uid. Body fields cannot select a UID.
 */
async function exchangePhoneAuthSessionHandler(request, deps) {
  const uid = request && request.auth && request.auth.uid;
  if (!uid) {
    throw new HttpsError('unauthenticated', 'Must be signed in.');
  }
  if (phoneSignInProvider(request) !== 'phone') {
    throw new HttpsError('permission-denied', 'Phone authentication is required.');
  }

  const data = request.data && typeof request.data === 'object' ? request.data : {};
  if (Object.prototype.hasOwnProperty.call(data, 'expectedUid')) {
    const expectedUid = data.expectedUid;
    if (typeof expectedUid !== 'string' || expectedUid.length === 0 || expectedUid !== uid) {
      throw new HttpsError('permission-denied', 'Authenticated user does not match.');
    }
  }

  const nowMs = typeof deps.now === 'function' ? deps.now() : Date.now();
  assertFreshPhoneAuth(tokenAuthTime(request), nowMs);

  await deps.checkRateLimit(uid, 'exchangePhoneAuthSession', RATE_LIMIT);
  const token = await deps.createCustomToken(uid);
  if (typeof token !== 'string' || token.length === 0) {
    throw new HttpsError('internal', 'Token exchange failed.');
  }
  return { token };
}

module.exports = {
  AUTH_BRIDGE_SERVICE_ACCOUNT,
  RATE_LIMIT,
  PHONE_AUTH_MAX_AGE_SEC,
  PHONE_AUTH_FUTURE_SKEW_SEC,
  exchangePhoneAuthSessionHandler,
};
