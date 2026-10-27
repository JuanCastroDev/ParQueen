'use strict';

const {
  readCanonicalCache,
  persistCanonicalCurb,
} = require('./curbIntelligence/canonicalCurbPersistence');

/**
 * Product reuse window for one already-proven curb.
 * Street rules and cleaning change on a day scale. A shorter window would
 * repeat Function 3C on every save of the same curb. Proof and source-version
 * equality still reject a fresh entry that is not the current curb.
 */
const STREET_INTELLIGENCE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * How far a server timestamp may sit ahead of the read clock and still be
 * eligible. This is clock skew only. It does not extend an expired entry.
 */
const STREET_INTELLIGENCE_CACHE_FUTURE_SKEW_MS = 2 * 60 * 1000;

function trustedTimestampMillis(value) {
  if (!value || typeof value.toMillis !== 'function') return null;
  let millis;
  try {
    millis = value.toMillis();
  } catch {
    return null;
  }
  return Number.isFinite(millis) ? millis : null;
}

function trustedNowMillis(Timestamp) {
  if (!Timestamp || typeof Timestamp.now !== 'function') return null;
  try {
    return trustedTimestampMillis(Timestamp.now());
  } catch {
    return null;
  }
}

/**
 * Inclusive boundary: age === TTL remains eligible. age > TTL is expired.
 * A timestamp further ahead than the skew constant is rejected.
 */
function streetIntelligenceCacheAgeEligible(createdAtMs, nowMs) {
  if (!Number.isFinite(createdAtMs) || !Number.isFinite(nowMs)) return false;
  const age = nowMs - createdAtMs;
  if (age < -STREET_INTELLIGENCE_CACHE_FUTURE_SKEW_MS) return false;
  if (age > STREET_INTELLIGENCE_CACHE_TTL_MS) return false;
  return true;
}

function createStreetIntelligenceCacheBoundary(dependencies = {}) {
  const readInner = dependencies.readCanonicalCache || readCanonicalCache;
  const persistInner = dependencies.persistCanonicalCurb || persistCanonicalCurb;
  const Timestamp = dependencies.Timestamp;

  return {
    async readCanonicalCache(input) {
      const frozen = await readInner(input);
      if (!frozen?.hit) return frozen;
      const nowMs = trustedNowMillis(Timestamp);
      if (nowMs === null) return { hit: false, reason: 'cache_clock_unavailable' };
      const createdAtMs = trustedTimestampMillis(frozen.publicSegment?.updatedAt);
      if (createdAtMs === null || !streetIntelligenceCacheAgeEligible(createdAtMs, nowMs)) {
        return { hit: false, reason: 'cache_expired' };
      }
      return frozen;
    },
    persistCanonicalCurb(input) {
      return persistInner(input);
    },
  };
}

module.exports = {
  STREET_INTELLIGENCE_CACHE_TTL_MS,
  STREET_INTELLIGENCE_CACHE_FUTURE_SKEW_MS,
  streetIntelligenceCacheAgeEligible,
  trustedTimestampMillis,
  createStreetIntelligenceCacheBoundary,
};
