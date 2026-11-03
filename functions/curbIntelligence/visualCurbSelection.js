'use strict';

const { candidateTokenNonceDigest } = require('./canonicalCurbIdentity');
const { isSideConfirmationEnabled } = require('./sideConfirmation');
const {
  inspectSideConfirmationToken,
  isSideConfirmationToken,
  normalizeHmacKey,
  parseSideConfirmationToken,
} = require('./sideConfirmationToken');
const {
  attestedSideConfirmationMatch,
  promoteAttestedSideConfirmation,
  promoteAttestedVisualSelection,
  resolveCanonicalCurb,
} = require('./canonicalCurbResolver');

const unsupported = reason => ({ state: 'UNSUPPORTED', reasons: [reason] });

async function applySideConfirmationToken(input, options) {
  if (!input?.location) return unsupported('candidate_token_invalid');
  if (!isSideConfirmationEnabled(options)) return unsupported('candidate_selection_stale');
  if (!normalizeHmacKey(options.sideConfirmationHmacKey)) return unsupported('candidate_token_unavailable');
  const now = Number.isSafeInteger(options.sideConfirmationNow) ? options.sideConfirmationNow : Date.now();
  const parsed = parseSideConfirmationToken(input.candidateToken, { now });
  if (!parsed.ok) return unsupported('candidate_token_invalid');
  const resolve = options.resolveCanonicalCurb || resolveCanonicalCurb;
  const current = await resolve(input.location, {
    ...options,
    requestNonce: undefined,
    requestNonceDigest: undefined,
    sideConfirmationEnabled: true,
    sideConfirmationNow: now,
  });
  if (current?.state !== 'SIDE_CONFIRMATION_REQUIRED') return unsupported('candidate_selection_stale');
  const selected = attestedSideConfirmationMatch(current, parsed.visible);
  if (!selected) return unsupported('candidate_selection_stale');
  const verified = inspectSideConfirmationToken(input.candidateToken, {
    key: options.sideConfirmationHmacKey,
    now,
    uid: options.callerUid,
    officialBlockFaceId: selected.officialBlockFaceId,
  });
  if (!verified.ok) return unsupported('candidate_token_invalid');
  return promoteAttestedSideConfirmation(current, selected.token);
}

async function applyVisualCurbSelection(input, options = {}) {
  if (isSideConfirmationToken(input?.candidateToken)) return applySideConfirmationToken(input, options);
  const nonceDigest = candidateTokenNonceDigest(input?.candidateToken);
  if (!nonceDigest || !input?.location) return unsupported('candidate_token_invalid');

  const resolve = options.resolveCanonicalCurb || resolveCanonicalCurb;
  const current = await resolve(input.location, {
    ...options,
    requestNonce: undefined,
    requestNonceDigest: nonceDigest,
  });
  if (current?.state === 'AMBIGUOUS') return promoteAttestedVisualSelection(current, input.candidateToken);
  if (current?.state === 'SIDE_CONFIRMATION_REQUIRED') {
    return promoteAttestedSideConfirmation(current, input.candidateToken);
  }
  return unsupported('candidate_selection_stale');
}

module.exports = { applyVisualCurbSelection };
