import { describe, expect, it } from 'vitest';
import { isLegacyNYCOpenDataSegment } from './streetIntelligenceLegacy';

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

  it('does not continuously request a completed or failed versioned attempt', () => {
    for (const state of ['complete', 'failed', 'in_progress']) {
      expect(isLegacyNYCOpenDataSegment(legacy({
        legacyRevalidation: { version: 'nyc_od_block_face_evidence_v1', state },
      }))).toBe(false);
    }
  });
});
