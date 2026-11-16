'use strict';

// S7 T2 (t682u): identity of a legitimate generationless legacy claim.
//
// A legacy claim was written by a pre-callable client. It has no
// claimGenerationId (absent, or null after a server clear), so the generation
// compare in cancelClaim / finderCancelSpot cannot identify it.
//
// Ownership is never inferred from a timestamp. The claimant is the
// authenticated uid stored in interestedUserId, reread inside the transaction.
// claimStartedAt is only the claim-cycle discriminator: it tells one
// generationless claim by the same claimant on the same Ping from a later one,
// so a stale retry cannot release a newer claim. The caller must echo the exact
// stored value as read (seconds and nanoseconds; Firestore keeps microseconds). A missing or malformed fingerprint,
// a stored claimGenerationId of any value, or any disagreement fails closed.

const NANOS_MAX = 999999999;

function isGenerationless(spot) {
  return !!spot && (spot.claimGenerationId === undefined || spot.claimGenerationId === null);
}

// Request value: exactly { seconds, nanoseconds }, both integers.
function parseLegacyFingerprint(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== 2 || !keys.includes('seconds') || !keys.includes('nanoseconds')) return null;
  const { seconds, nanoseconds } = value;
  if (!Number.isSafeInteger(seconds)) return null;
  if (!Number.isInteger(nanoseconds) || nanoseconds < 0 || nanoseconds > NANOS_MAX) return null;
  return { seconds, nanoseconds };
}

// Stored value: a Firestore Timestamp. Anything else has no fingerprint.
function timestampFingerprint(value) {
  if (!value || typeof value !== 'object' || typeof value.toMillis !== 'function') return null;
  return parseLegacyFingerprint({ seconds: value.seconds, nanoseconds: value.nanoseconds });
}

function sameFingerprint(left, right) {
  return !!left && !!right && left.seconds === right.seconds && left.nanoseconds === right.nanoseconds;
}

function safeToken(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 128
    && !value.includes('/') && value !== '.' && value !== '..';
}

// Path discriminator for receipts, notices and trust events. It is not a
// generation id and does not authorize anything by itself.
function legacyToken(uid, fingerprint) {
  if (!safeToken(uid) || !fingerprint) return null;
  return `legacy_${uid}_${fingerprint.seconds}_${fingerprint.nanoseconds}`;
}

module.exports = {
  isGenerationless,
  parseLegacyFingerprint,
  timestampFingerprint,
  sameFingerprint,
  legacyToken,
  safeToken,
};
