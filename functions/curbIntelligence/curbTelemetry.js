'use strict';

const CURB_TELEMETRY_EVENTS = new Set([
  'curb_resolution_attempted',
  'curb_resolution_high',
  'curb_resolution_ambiguous',
  'curb_resolution_unsupported',
  'curb_candidate_count',
  'intersection_ambiguity',
  'visual_curb_selector_shown',
  'visual_curb_selected',
  'source_conflict',
  'street_name_conflict',
  'cache_curb_mismatch',
]);

const REASONS = new Set([
  'location_quality',
  'candidate_incomplete',
  'intersection_complex',
  'source_unavailable',
  'source_conflict',
  'street_name_conflict',
  'cache_curb_mismatch',
  'competing_roadways_overlap',
  'endpoint_or_intersection_ambiguous',
]);
const SOURCES = new Set(['cscl', 'planimetric', 'dot', 'parkNyc', 'sweepNyc', 'admin']);
const RULES = new Set(['cleaning', 'restriction', 'timeLimit', 'meter', 'suspension']);

function candidateBucket(value) {
  if (!Number.isInteger(value) || value < 0) return null;
  if (value >= 3) return '3_plus';
  return String(value);
}

function sampleBucket(value) {
  if (!Number.isInteger(value) || value < 0) return null;
  if (value <= 2) return '0_2';
  if (value >= 5) return '5_plus';
  return String(value);
}

function latencyBucket(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  if (value < 250) return '0_249ms';
  if (value < 1000) return '250_999ms';
  if (value < 2500) return '1000_2499ms';
  return '2500_plus_ms';
}

function buildCurbTelemetryPayload(event, input = {}) {
  if (!CURB_TELEMETRY_EVENTS.has(event)) return null;
  const payload = { event };
  if (input.protocolVersion === 2) payload.protocolVersion = 2;
  if (REASONS.has(input.reason)) payload.reason = input.reason;
  if (SOURCES.has(input.sourceCategory)) payload.sourceCategory = input.sourceCategory;
  if (RULES.has(input.ruleCategory)) payload.ruleCategory = input.ruleCategory;
  const candidateCountBucket = candidateBucket(input.candidateCount);
  const latency = latencyBucket(input.latencyMs);
  const sampleCountBucket = sampleBucket(input.sampleCount);
  if (candidateCountBucket) payload.candidateCountBucket = candidateCountBucket;
  if (latency) payload.latencyBucket = latency;
  if (sampleCountBucket) payload.sampleCountBucket = sampleCountBucket;
  for (const key of ['cacheHit', 'hasCandidateToken', 'sourceAvailable', 'rulesAvailable']) {
    if (typeof input[key] === 'boolean') payload[key] = input[key];
  }
  return payload;
}

function createCurbTelemetry(options = {}) {
  const logger = options.logger || console;
  return Object.freeze({
    emit(event, input) {
      const payload = buildCurbTelemetryPayload(event, input);
      if (!payload) return null;
      try { logger.info(payload); } catch { /* telemetry must never affect product behavior */ }
      return payload;
    },
  });
}

module.exports = {
  CURB_TELEMETRY_EVENTS,
  buildCurbTelemetryPayload,
  createCurbTelemetry,
};
