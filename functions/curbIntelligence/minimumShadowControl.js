'use strict';

const { createHash } = require('crypto');
const { adaptLegacyCleaningEvidence } = require('./legacyCleaningAdapter');
const { createReusedDotSnapshot } = require('./reusedDotEvidence');

const MAX_SHADOW_ACCURACY_METERS = 150;

function validateShadowAccuracy(value) {
  if (value === undefined) return { ok: false, reason: 'accuracy_missing' };
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
    || value > MAX_SHADOW_ACCURACY_METERS) return { ok: false, reason: 'accuracy_invalid' };
  return { ok: true, value };
}

function evaluateLegacyUsable(input = {}) {
  const legacy = adaptLegacyCleaningEvidence(input.legacyEvidence);
  if (legacy.availability === 'UNAVAILABLE' || legacy.availability === 'NONE') {
    return { eligible: false, reason: 'legacy_evidence_missing' };
  }
  if (legacy.availability !== 'USABLE') return { eligible: false, reason: 'legacy_evidence_malformed' };
  return { eligible: true };
}

function evaluateSafeEvidence(input = {}, options = {}) {
  const accuracy = validateShadowAccuracy(input.accuracyMeters);
  if (!accuracy.ok) return { eligible: false, reason: accuracy.reason };
  const allowSweepnycProduct = options.allowSweepnycProduct === true
    && input.productionPath === 'sweepnyc';
  if (!allowSweepnycProduct && input.productionPath !== 'nyc_open_data_fallback') {
    return { eligible: false, reason: 'production_path_ineligible' };
  }
  if (!allowSweepnycProduct) {
    const dotSnapshot = createReusedDotSnapshot(input.dotEvidence);
    if (dotSnapshot.completeness.state !== 'COMPLETE') {
      return { eligible: false, reason: dotSnapshot.completeness.reason };
    }
  }
  return evaluateLegacyUsable(input);
}

function evaluatePreSourceEligibility(input = {}) {
  if (input.mode !== 'shadow') return { eligible: false, reason: 'mode_off' };
  const samplingAuthorized = input.samplePermille === 0
    ? input.operatorAuthorized === true
    : input.sampleSelected === true;
  if (!samplingAuthorized) return { eligible: false, reason: 'sample_not_authorized' };
  return evaluateSafeEvidence(input);
}

function evaluateProductPathEligibility(input = {}) {
  if (input.productPath !== 'on') return { eligible: false, reason: 'product_path_off' };
  if (input.mode !== 'shadow') return { eligible: false, reason: 'mode_off' };
  return evaluateSafeEvidence(input, { allowSweepnycProduct: true });
}

function deterministicSampleSelected(basis, samplePermille) {
  if (typeof basis !== 'string' || !basis || !Number.isInteger(samplePermille)
    || samplePermille <= 0 || samplePermille > 1000) return false;
  if (samplePermille === 1000) return true;
  const digest = createHash('sha256').update(`curb-shadow-cleaning-v1:${basis}`, 'utf8').digest();
  return digest.readUInt32BE(0) % 1000 < samplePermille;
}

module.exports = {
  MAX_SHADOW_ACCURACY_METERS,
  validateShadowAccuracy,
  evaluatePreSourceEligibility,
  evaluateProductPathEligibility,
  deterministicSampleSelected,
};
