'use strict';

const DEMO_PROJECT_ID = 'demo-parkqueen-functions-test';
const RECORD_NAME = 'parqueen_demo_curb_diagnostic';
const REASON = /^[a-z][a-z0-9_]{0,63}$/;
const STAGES = new Set([
  'classification',
  'cscl_retrieval',
  'candidate_coverage',
  'geometric_ranking',
  'material_selection',
  'lion_relationships',
  'candidate_construction',
  'side_confirmation_eligibility',
  'side_confirmation_signing',
  'candidate_token',
]);
const CLASSIFIER_STATES = new Set(['SUPPORTED', 'UNSUPPORTED', 'AMBIGUOUS']);
const ELIGIBILITY = new Set([
  'confirmation_disabled',
  'considered_count',
  'centerline_uncertainty',
  'endpoint_ambiguity',
  'roadway_topology',
  'source_enrichment',
  'classifier_state',
  'classifier_reason',
  'official_faces',
  'street_orientation',
]);

function demoCurbDiagnosticsEnabled(env = process.env) {
  return env?.FUNCTIONS_EMULATOR === 'true' && env?.GCLOUD_PROJECT === DEMO_PROJECT_ID;
}

function reason(value) {
  return typeof value === 'string' && REASON.test(value) ? value : null;
}

function count(value) {
  return Number.isInteger(value) && value >= 0 && value <= 10000 ? value : null;
}

function elapsed(value) {
  return Number.isInteger(value) && value >= 0 && value <= 300000 ? value : null;
}

function buildDemoResolutionRecord(input = {}) {
  const eligibility = ELIGIBILITY.has(input.sideConfirmationEligibility)
    ? input.sideConfirmationEligibility
    : null;
  const record = {
    record: RECORD_NAME,
    projectId: DEMO_PROJECT_ID,
    internalReason: reason(input.internalReason),
    stage: STAGES.has(input.stage) ? input.stage : null,
    rawCsclCandidateCount: count(input.rawCsclCandidateCount),
    materialRoadwayCandidateCount: count(input.materialRoadwayCandidateCount),
    constructedCanonicalCandidateCount: count(input.constructedCanonicalCandidateCount),
    classifierState: CLASSIFIER_STATES.has(input.classifierState) ? input.classifierState : null,
    classifierReason: reason(input.classifierReason),
    sideConfirmationEligibility: eligibility,
    elapsedMs: elapsed(input.elapsedMs),
    stageElapsedMs: elapsed(input.stageElapsedMs),
  };
  for (const field of [
    'sourceStageElapsedMs',
    'canonicalStageElapsedMs',
    'initializationElapsedMs',
    'totalServerElapsedMs',
    'metadataBeforeMs',
    'spatialMs',
    'metadataAfterMs',
    'spatialAttempts',
  ]) {
    if (Object.prototype.hasOwnProperty.call(input, field)) {
      record[field] = elapsed(input[field]);
    }
  }
  if (input.spatialProtocol === 'soda2' || input.spatialProtocol === 'soda3') {
    record.spatialProtocol = input.spatialProtocol;
  }
  return record;
}

function logDemoResolutionDiagnostic(input, env = process.env) {
  if (!demoCurbDiagnosticsEnabled(env)) return null;
  const record = buildDemoResolutionRecord(input);
  try { console.log(JSON.stringify(record)); } catch { /* diagnostics never change resolution */ }
  return record;
}

function createDemoResolutionTrace(env = process.env) {
  if (!demoCurbDiagnosticsEnabled(env)) return null;
  const startedAt = Date.now();
  let stageStartedAt = startedAt;
  const counts = {
    rawCsclCandidateCount: null,
    materialRoadwayCandidateCount: null,
    constructedCanonicalCandidateCount: null,
  };
  return {
    mark() { stageStartedAt = Date.now(); },
    setCounts(next) { Object.assign(counts, next); },
    record(result, stage, extra = {}) {
      return logDemoResolutionDiagnostic({
        internalReason: extra.internalReason || result?.reasons?.[0] || null,
        stage,
        rawCsclCandidateCount: counts.rawCsclCandidateCount,
        materialRoadwayCandidateCount: counts.materialRoadwayCandidateCount,
        constructedCanonicalCandidateCount: counts.constructedCanonicalCandidateCount,
        classifierState: extra.classifierState ?? null,
        classifierReason: extra.classifierReason ?? null,
        sideConfirmationEligibility: extra.sideConfirmationEligibility ?? null,
        elapsedMs: Date.now() - startedAt,
        stageElapsedMs: Date.now() - stageStartedAt,
      }, env);
    },
  };
}

module.exports = {
  DEMO_PROJECT_ID,
  RECORD_NAME,
  buildDemoResolutionRecord,
  createDemoResolutionTrace,
  demoCurbDiagnosticsEnabled,
  logDemoResolutionDiagnostic,
};
