import { describe, expect, it } from 'vitest';
import {
  LEGACY_REVALIDATION_LEASE_MS,
  LEGACY_REVALIDATION_RETRY_COOLDOWN_MS,
  isLegacyNYCOpenDataSegment,
} from './streetIntelligenceLegacy';

const legacy = (overrides: Record<string, unknown> = {}) => ({
  source: 'nyc_open_data',
  provenance: { provider: 'nyc_open_data', geometrySource: 'osm' },
  status: 'needs_review',
  needsReview: true,
  confidenceScore: 0.5,
  confidence: { level: 'unverified' },
  ...overrides,
});

describe('client legacy NYC Open Data detection', () => {
  it('routes only the old evidence-free conservative row to lazy revalidation', () => {
    expect(isLegacyNYCOpenDataSegment(legacy())).toBe(true);
    expect(isLegacyNYCOpenDataSegment(legacy({
      blockFaceEvidence: { blockDecisive: true, sideResolved: true, parseComplete: true },
    }))).toBe(false);
    expect(isLegacyNYCOpenDataSegment(legacy({ status: 'active' }))).toBe(false);
    expect(isLegacyNYCOpenDataSegment(legacy({ source: 'sweepnyc' }))).toBe(false);
  });

  it('does not continuously request a completed or deterministic-caution outcome', () => {
    for (const state of ['complete', 'terminal_caution']) {
      expect(isLegacyNYCOpenDataSegment(legacy({
        legacyRevalidation: { version: 'nyc_od_block_face_evidence_v1', state },
      }))).toBe(false);
    }
  });

  it('observes the in-progress lease and recovers an interrupted claim', () => {
    const now = Date.UTC(2026, 8, 13, 14, 0, 0);
    const marker = (startedAt: number) => ({
      version: 'nyc_od_block_face_evidence_v1',
      state: 'in_progress',
      startedAt: { toMillis: () => startedAt },
    });
    expect(isLegacyNYCOpenDataSegment(legacy({
      legacyRevalidation: marker(now - LEGACY_REVALIDATION_LEASE_MS + 1),
    }), now)).toBe(false);
    expect(isLegacyNYCOpenDataSegment(legacy({
      legacyRevalidation: marker(now - LEGACY_REVALIDATION_LEASE_MS),
    }), now)).toBe(true);
  });

  it('observes transient retry cooldown and eventually requests recovery', () => {
    const now = Date.UTC(2026, 8, 13, 14, 0, 0);
    const marker = {
      version: 'nyc_od_block_face_evidence_v1',
      state: 'failed',
      retryAfter: { toMillis: () => now + LEGACY_REVALIDATION_RETRY_COOLDOWN_MS },
    };
    expect(isLegacyNYCOpenDataSegment(legacy({ legacyRevalidation: marker }), now)).toBe(false);
    expect(isLegacyNYCOpenDataSegment(
      legacy({ legacyRevalidation: marker }),
      now + LEGACY_REVALIDATION_RETRY_COOLDOWN_MS,
    )).toBe(true);
  });
});
