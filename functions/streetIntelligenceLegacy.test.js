import { describe, expect, it } from 'vitest';
import legacyModule from './streetIntelligenceLegacy.js';

const {
  LEGACY_REVALIDATION_LEASE_MS,
  LEGACY_REVALIDATION_RETRY_COOLDOWN_MS,
  NYC_OD_EVIDENCE_REVALIDATION_VERSION,
  deriveNYCOpenDataConfidence,
  isLegacyNYCOpenDataSegment,
  runLegacyNYCOpenDataRevalidation,
} = legacyModule;

const legacy = (overrides = {}) => ({
  source: 'nyc_open_data',
  provenance: { provider: 'nyc_open_data', geometrySource: 'osm' },
  status: 'needs_review',
  needsReview: true,
  confidenceScore: 0.5,
  confidence: { level: 'unverified', source: 'nyc_open_data' },
  streetName: 'MORRIS PARK AVENUE',
  ...overrides,
});

const cachedResult = (segment, stage) => ({
  success: true,
  segmentId: 'legacy-segment',
  streetName: segment.streetName,
  revalidation: stage,
});

describe('legacy NYC Open Data lazy revalidation', () => {
  it('A. recognizes the legacy shape and triggers its authoritative refresh', async () => {
    expect(isLegacyNYCOpenDataSegment(legacy())).toBe(true);
    expect(isLegacyNYCOpenDataSegment(legacy({ source: 'sweepnyc' }))).toBe(false);
    expect(isLegacyNYCOpenDataSegment(legacy({ status: 'active' }))).toBe(false);
    expect(isLegacyNYCOpenDataSegment(legacy({ needsReview: false }))).toBe(false);
    expect(isLegacyNYCOpenDataSegment(legacy({ confidenceScore: 0.9 }))).toBe(false);

    let refreshCalls = 0;
    const result = await runLegacyNYCOpenDataRevalidation({
      segmentId: 'legacy-segment',
      loadAndClaim: async () => ({
        acquired: true,
        segment: legacy(),
        operationId: 'op-a',
      }),
      refresh: async operationId => {
        refreshCalls++;
        expect(operationId).toBe('op-a');
        return { success: true, segmentId: 'legacy-segment' };
      },
      markFailed: async () => {},
      cachedResult,
    });

    expect(refreshCalls).toBe(1);
    expect(result).toMatchObject({
      success: true,
      segmentId: 'legacy-segment',
      revalidation: 'complete',
    });
  });

  it('B. maps decisive revalidation evidence to supported metadata', () => {
    expect(deriveNYCOpenDataConfidence({
      blockDecisive: true,
      sideResolved: true,
      parseComplete: true,
    })).toEqual({
      decisive: true,
      needsReview: false,
      status: 'active',
      confidenceScore: 0.9,
      level: 'community',
    });
  });

  it('C. keeps ambiguous or incomplete revalidation in caution metadata', () => {
    for (const evidence of [
      { blockDecisive: false, sideResolved: true, parseComplete: true },
      { blockDecisive: true, sideResolved: false, parseComplete: true },
      { blockDecisive: true, sideResolved: true, parseComplete: false },
    ]) {
      expect(deriveNYCOpenDataConfidence(evidence)).toEqual({
        decisive: false,
        needsReview: true,
        status: 'needs_review',
        confidenceScore: 0.5,
        level: 'unverified',
      });
    }
  });

  it('D. already-migrated rows stay on the cache path and do not refresh', async () => {
    let refreshCalls = 0;
    const migrated = legacy({
      blockFaceEvidence: { blockDecisive: true, sideResolved: true, parseComplete: true },
      status: 'active', needsReview: false, confidenceScore: 0.9,
      confidence: { level: 'community' },
    });
    const result = await runLegacyNYCOpenDataRevalidation({
      segmentId: 'legacy-segment',
      loadAndClaim: async () => ({ acquired: false, segment: migrated, state: 'cached' }),
      refresh: async () => { refreshCalls++; return { success: true }; },
      markFailed: async () => {},
      cachedResult,
    });
    expect(result.revalidation).toBe('cached');
    expect(refreshCalls).toBe(0);
  });

  it('E. failed refresh retains the existing safe row and records failure', async () => {
    const failures = [];
    const existing = legacy();
    const result = await runLegacyNYCOpenDataRevalidation({
      segmentId: 'legacy-segment',
      loadAndClaim: async () => ({ acquired: true, segment: existing, operationId: 'op-1' }),
      refresh: async () => ({ success: false, reason: 'unknown_error' }),
      markFailed: async (operationId, reason, retryAfterMs) => failures.push({ operationId, reason, retryAfterMs }),
      cachedResult,
    });
    expect(result).toMatchObject({ success: true, segmentId: 'legacy-segment', revalidation: 'failed' });
    expect(failures).toEqual([{
      operationId: 'op-1',
      reason: 'unknown_error',
      retryAfterMs: expect.any(Number),
    }]);
    expect(existing).toMatchObject({ status: 'needs_review', needsReview: true, confidenceScore: 0.5 });
  });

  it('F. a completed versioned attempt is not continuously rebuilt on repeated lookup', () => {
    expect(isLegacyNYCOpenDataSegment(legacy({
      legacyRevalidation: {
        version: NYC_OD_EVIDENCE_REVALIDATION_VERSION,
        state: 'complete',
      },
    }))).toBe(false);
  });

  it('allows only one refresh when two callers race for the same legacy row', async () => {
    let claimed = false;
    let refreshCalls = 0;
    const existing = legacy();
    const loadAndClaim = async () => {
      if (claimed) return { acquired: false, segment: existing, state: 'in_progress' };
      claimed = true;
      return { acquired: true, segment: existing, operationId: 'winner' };
    };
    const options = {
      segmentId: 'legacy-segment', loadAndClaim,
      refresh: async () => { refreshCalls++; return { success: true, segmentId: 'legacy-segment' }; },
      markFailed: async () => {}, cachedResult,
    };
    const [first, second] = await Promise.all([
      runLegacyNYCOpenDataRevalidation(options),
      runLegacyNYCOpenDataRevalidation(options),
    ]);
    expect(refreshCalls).toBe(1);
    expect([first.revalidation, second.revalidation]).toContain('in_progress');
  });

  it('keeps a fresh in-progress claim leased to its current owner', () => {
    const now = Date.UTC(2026, 8, 13, 14, 0, 0);
    expect(isLegacyNYCOpenDataSegment(legacy({
      legacyRevalidation: {
        version: NYC_OD_EVIDENCE_REVALIDATION_VERSION,
        state: 'in_progress',
        startedAt: { toMillis: () => now - LEGACY_REVALIDATION_LEASE_MS + 1 },
      },
    }), now)).toBe(false);
  });

  it('allows an expired in-progress claim to be reclaimed after interruption', () => {
    const now = Date.UTC(2026, 8, 13, 14, 0, 0);
    expect(isLegacyNYCOpenDataSegment(legacy({
      legacyRevalidation: {
        version: NYC_OD_EVIDENCE_REVALIDATION_VERSION,
        state: 'in_progress',
        startedAt: { toMillis: () => now - LEGACY_REVALIDATION_LEASE_MS },
      },
    }), now)).toBe(true);
  });

  it('retains cached caution and records a retry cooldown after transient failure', async () => {
    const now = Date.UTC(2026, 8, 13, 14, 0, 0);
    const failures = [];
    const result = await runLegacyNYCOpenDataRevalidation({
      segmentId: 'legacy-segment',
      loadAndClaim: async () => ({ acquired: true, segment: legacy(), operationId: 'transient-op' }),
      refresh: async () => ({ success: false, reason: 'unknown_error' }),
      markFailed: async (operationId, reason, retryAfterMs) => failures.push({ operationId, reason, retryAfterMs }),
      markTerminal: async () => {},
      cachedResult,
      nowMs: () => now,
    });
    expect(result).toMatchObject({ success: true, revalidation: 'failed' });
    expect(failures).toEqual([{
      operationId: 'transient-op',
      reason: 'unknown_error',
      retryAfterMs: now + LEGACY_REVALIDATION_RETRY_COOLDOWN_MS,
    }]);
  });

  it('treats a thrown parser or infrastructure exception as retryable', async () => {
    const now = Date.UTC(2026, 8, 13, 14, 0, 0);
    const failures = [];
    const result = await runLegacyNYCOpenDataRevalidation({
      segmentId: 'legacy-segment',
      loadAndClaim: async () => ({ acquired: true, segment: legacy(), operationId: 'throw-op' }),
      refresh: async () => { throw new Error('transient internal failure'); },
      markFailed: async (operationId, reason, retryAfterMs) => failures.push({ operationId, reason, retryAfterMs }),
      markTerminal: async () => {},
      cachedResult,
      nowMs: () => now,
    });
    expect(result).toMatchObject({ success: true, revalidation: 'failed' });
    expect(failures).toEqual([{
      operationId: 'throw-op',
      reason: 'legacy_revalidation_failed',
      retryAfterMs: now + LEGACY_REVALIDATION_RETRY_COOLDOWN_MS,
    }]);
  });

  it('does not immediately retry failed work but retries after its cooldown', () => {
    const now = Date.UTC(2026, 8, 13, 14, 0, 0);
    const marker = {
      version: NYC_OD_EVIDENCE_REVALIDATION_VERSION,
      state: 'failed',
      retryAfter: { toMillis: () => now + LEGACY_REVALIDATION_RETRY_COOLDOWN_MS },
    };
    expect(isLegacyNYCOpenDataSegment(legacy({ legacyRevalidation: marker }), now)).toBe(false);
    expect(isLegacyNYCOpenDataSegment(legacy({ legacyRevalidation: marker }), now + LEGACY_REVALIDATION_RETRY_COOLDOWN_MS)).toBe(true);
  });

  it('can migrate to supported evidence on a later retry after transient failure', async () => {
    const result = await runLegacyNYCOpenDataRevalidation({
      segmentId: 'legacy-segment',
      loadAndClaim: async () => ({ acquired: true, segment: legacy(), operationId: 'retry-op' }),
      refresh: async () => ({
        success: true,
        segmentId: 'legacy-segment',
        confidence: deriveNYCOpenDataConfidence({
          blockDecisive: true,
          sideResolved: true,
          parseComplete: true,
        }),
      }),
      markFailed: async () => {},
      markTerminal: async () => {},
      cachedResult,
    });
    expect(result).toMatchObject({
      success: true,
      revalidation: 'complete',
      confidence: { decisive: true, status: 'active', needsReview: false },
    });
  });

  it('persists deterministic ambiguity as terminal caution without a retry loop', async () => {
    const terminal = [];
    const result = await runLegacyNYCOpenDataRevalidation({
      segmentId: 'legacy-segment',
      loadAndClaim: async () => ({ acquired: true, segment: legacy(), operationId: 'ambiguous-op' }),
      refresh: async () => ({ success: false, reason: 'nyc_open_data_ambiguous_block' }),
      markFailed: async () => {},
      markTerminal: async (operationId, reason) => terminal.push({ operationId, reason }),
      cachedResult,
    });
    expect(result).toMatchObject({ success: true, revalidation: 'terminal_caution' });
    expect(terminal).toEqual([{
      operationId: 'ambiguous-op',
      reason: 'nyc_open_data_ambiguous_block',
    }]);
    expect(isLegacyNYCOpenDataSegment(legacy({
      legacyRevalidation: {
        version: NYC_OD_EVIDENCE_REVALIDATION_VERSION,
        state: 'terminal_caution',
      },
    }))).toBe(false);
  });
});
