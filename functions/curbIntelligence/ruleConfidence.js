'use strict';

const RANK = Object.freeze({ UNKNOWN: 0, CAUTION: 1, SUPPORTED: 2 });
const isState = value => Object.hasOwn(RANK, value);

function capAssociationState(ruleState, curbState) {
  if (!isState(ruleState) || !isState(curbState)) return 'UNKNOWN';
  return RANK[ruleState] <= RANK[curbState] ? ruleState : curbState;
}

function createInternalCurbRuleResult(input = {}) {
  const curbState = input.curbIdentity?.state || 'UNKNOWN';
  const cleaningState = capAssociationState(input.cleaning?.confidence || 'UNKNOWN', curbState);
  const meterState = capAssociationState(input.meter?.state || 'UNKNOWN', curbState);
  return {
    states: { curb: isState(curbState) ? curbState : 'UNKNOWN', cleaning: cleaningState, meter: meterState },
    curbIdentity: input.curbIdentity || null,
    cleaning: input.cleaning || { confidence: 'UNKNOWN', reasons: ['evidence_insufficient'], rules: [] },
    meter: input.meter || { state: 'UNKNOWN', reasonCodes: ['evidence_insufficient'], rules: [] },
    sourceVersions: { ...(input.sourceVersions || {}) },
    diagnostics: input.diagnostics || {},
  };
}

module.exports = { capAssociationState, createInternalCurbRuleResult };
