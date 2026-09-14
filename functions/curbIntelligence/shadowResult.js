'use strict';

const { createShadowComparison } = require('./contracts');

const STATES = new Set(['SUPPORTED', 'CAUTION', 'UNKNOWN']);

function toPersistableShadowComparison(input) {
  if (!input || !STATES.has(input.resolverResult?.state)) {
    return { ok: false, reason: 'invalid_resolver_result' };
  }
  return createShadowComparison({
    category: input.category,
    oldCleaningFingerprint: input.oldCleaningFingerprint ?? null,
    newCleaningFingerprint: input.newCleaningFingerprint ?? null,
    meterRulePresent: input.meterRulePresent === true,
    blockFaceResolutionState: input.resolverResult.state,
    reasonCodes: Array.isArray(input.reasonCodes) ? [...input.reasonCodes]
      : input.category === 'exact_agreement' ? [] : [input.category],
    sourceVersions: input.sourceVersions,
  });
}

module.exports = { toPersistableShadowComparison };
