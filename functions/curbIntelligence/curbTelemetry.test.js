import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  CURB_TELEMETRY_EVENTS,
  buildCurbTelemetryPayload,
  createCurbTelemetry,
} = require('./curbTelemetry');

const REQUIRED_EVENTS = [
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
];

describe('curb telemetry privacy', () => {
  it('allows every required categorical event', () => {
    expect([...CURB_TELEMETRY_EVENTS].sort()).toEqual([...REQUIRED_EVENTS].sort());
    for (const event of REQUIRED_EVENTS) {
      expect(buildCurbTelemetryPayload(event, { protocolVersion: 2 })).toMatchObject({ event, protocolVersion: 2 });
    }
  });

  it('buckets candidate, latency, and sample values and drops identifying fields', () => {
    const payload = buildCurbTelemetryPayload('curb_resolution_ambiguous', {
      protocolVersion: 2,
      reason: 'intersection_complex',
      sourceCategory: 'cscl',
      ruleCategory: 'cleaning',
      candidateCount: 4,
      latencyMs: 1250,
      sampleCount: 3,
      cacheHit: false,
      hasCandidateToken: true,
      lat: 1,
      lng: -1,
      streetName: 'test-only',
      uid: 'test-only',
      segmentId: 'test-only',
      publicCurbKey: 'test-only',
      officialBlockFaceId: 'test-only',
      globalId: 'test-only',
      signId: 'test-only',
      token: 'test-only',
      rows: [{ value: 'test-only' }],
      error: new Error('test-only'),
    });

    expect(payload).toEqual({
      event: 'curb_resolution_ambiguous',
      protocolVersion: 2,
      reason: 'intersection_complex',
      sourceCategory: 'cscl',
      ruleCategory: 'cleaning',
      candidateCountBucket: '3_plus',
      latencyBucket: '1000_2499ms',
      sampleCountBucket: '3',
      cacheHit: false,
      hasCandidateToken: true,
    });
    for (const forbiddenField of [
      'lat', 'lng', 'streetName', 'uid', 'segmentId', 'publicCurbKey',
      'officialBlockFaceId', 'globalId', 'signId', 'token', 'rows', 'error',
    ]) {
      expect(payload).not.toHaveProperty(forbiddenField);
    }
    expect(JSON.stringify(payload)).not.toContain('test-only');
  });

  it('rejects unknown events and unsupported categorical values', () => {
    expect(buildCurbTelemetryPayload('unknown_event', {})).toBeNull();
    expect(buildCurbTelemetryPayload('source_conflict', {
      protocolVersion: 2,
      reason: 'raw upstream response',
      sourceCategory: 'unknown-private-source',
      ruleCategory: 'private-rule',
    })).toEqual({ event: 'source_conflict', protocolVersion: 2 });
  });

  it('keeps logger failure from affecting the caller', () => {
    const logger = { info: vi.fn(() => { throw new Error('logger down'); }) };
    const telemetry = createCurbTelemetry({ logger });

    expect(() => telemetry.emit('curb_resolution_high', {
      protocolVersion: 2, latencyMs: 100, cacheHit: true,
    })).not.toThrow();
    expect(logger.info).toHaveBeenCalledOnce();
  });
});
