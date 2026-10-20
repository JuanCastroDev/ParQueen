'use strict';

const { candidateTokenNonceDigest } = require('./canonicalCurbIdentity');
const {
  promoteAttestedVisualSelection,
  resolveCanonicalCurb,
} = require('./canonicalCurbResolver');

const unsupported = reason => ({ state: 'UNSUPPORTED', reasons: [reason] });

async function applyVisualCurbSelection(input, options = {}) {
  const nonceDigest = candidateTokenNonceDigest(input?.candidateToken);
  if (!nonceDigest || !input?.location) return unsupported('candidate_token_invalid');

  const resolve = options.resolveCanonicalCurb || resolveCanonicalCurb;
  const current = await resolve(input.location, {
    ...options,
    requestNonce: undefined,
    requestNonceDigest: nonceDigest,
  });
  if (current?.state !== 'AMBIGUOUS') return unsupported('candidate_selection_stale');
  return promoteAttestedVisualSelection(current, input.candidateToken);
}

module.exports = { applyVisualCurbSelection };
