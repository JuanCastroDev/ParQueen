'use strict';

const { candidateTokenNonceDigest, toPublicCurb } = require('./canonicalCurbIdentity');
const {
  getPrivateCanonicalCandidateSet,
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
  const candidates = getPrivateCanonicalCandidateSet(current);
  const selected = candidates.find(candidate => candidate.token === input.candidateToken);
  if (!selected) return unsupported('candidate_selection_stale');

  const identity = {
    ...selected.identity,
    resolution: {
      ...selected.identity.resolution,
      method: 'visual_selection',
    },
  };
  return {
    state: 'SUPPORTED',
    reasons: [],
    identity,
    publicCurb: toPublicCurb(identity),
  };
}

module.exports = { applyVisualCurbSelection };
