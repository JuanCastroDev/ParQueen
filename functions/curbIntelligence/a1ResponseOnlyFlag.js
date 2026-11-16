
'use strict';

/**
 * Temporary Street Intelligence A1 migration flag.
 *
 * STREET_INTEL_A1_RESPONSE_ONLY defaults OFF (unset, empty, or any value
 * other than the exact string "on"). Matches CURB_SIDE_CONFIRMATION.
 *
 * OFF: user-initiated resolution keeps main publication behavior.
 * ON: user-initiated resolution returns public rules in-process and must
 * not write shared authoritative collections, including for legacy callers.
 *
 * Do not commit a production value in params or .env files.
 *
 * Rollout / retirement (not a production activation):
 * 1. Ship app versions that understand regulationStatus and treat
 *    non-verified regulations as unknown.
 * 2. Confirm those versions are the supported fleet.
 * 3. Enable STREET_INTEL_A1_RESPONSE_ONLY=on only in a non-production
 *    environment first, then later in production under a separate founder
 *    authorization. Monitor persist skips, unsupported rates, and
 *    regulationStatus histograms.
 * 4. After compatible clients are required, remove the legacy writer,
 *    then remove this flag.
 */
const A1_RESPONSE_ONLY_ENV = 'STREET_INTEL_A1_RESPONSE_ONLY';

function isA1ResponseOnlyEnabled(env = process.env) {
  return env?.[A1_RESPONSE_ONLY_ENV] === 'on';
}

module.exports = {
  A1_RESPONSE_ONLY_ENV,
  isA1ResponseOnlyEnabled,
};
