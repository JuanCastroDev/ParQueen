'use strict';

const {
  comparisonCategory,
  runMinimumCleaningShadow,
  RELATIONSHIP_TIMEOUT_MS,
} = require('./minimumCleaningShadow');
const { DEFAULT_EXECUTION_POLICY } = require('./shadowExecution');

const DOT_VERSION = Object.freeze({
  resourceId: 'nfid-uabd',
  rowsUpdatedAt: '2026-01-01T00:00:00.000Z',
  viewLastModified: '2026-01-02T00:00:00.000Z',
});

const legacyEvidence = Object.freeze({
  segment: {
    source: 'nyc_open_data',
    provenance: { provider: 'nyc_open_data' },
    status: 'active',
    confidenceScore: 1,
    confidence: { level: 'verified' },
    blockFaceEvidence: { blockDecisive: true, sideResolved: true, parseComplete: true },
  },
  activeRules: [{
    type: 'streetCleaning', source: 'nyc_open_data', status: 'active', needsReview: false,
    schedules: [{ side: 'East', days: ['Tue'], startTime: '08:30', endTime: '10:00', ruleType: 'NO_PARKING' }],
  }],
});

const dotSnapshot = Object.freeze({
  candidates: [{
    orderNumber: 'P-100', recordType: 'Current', orderType: 'P-', borough: 'MANHATTAN',
    onStreet: 'GOLD STREET', fromStreet: 'BEEKMAN STREET', toStreet: 'ANN STREET', side: 'E',
    signCode: 'PS-1', signDescription: 'NO PARKING (SANITATION BROOM SYMBOL) TUESDAY 8:30AM-10AM',
    sourceVersion: DOT_VERSION,
    sourceNative: {
      record_type: 'Current', sign_code: 'PS-1',
      sign_description: 'NO PARKING (SANITATION BROOM SYMBOL) TUESDAY 8:30AM-10AM',
    },
  }],
  completeness: { state: 'COMPLETE', reason: null },
  sourceVersion: DOT_VERSION,
});

const runtimeResult = Object.freeze({
  resolution: { state: 'SUPPORTED', reasons: [], officialIdentity: { officialBlockFaceId: '0212261301' } },
  runtimeEvidence: {
    nonPersistable: true,
    officialBlockFaceId: '0212261301',
    sourceVersion: { resourceId: 'inkn-q76z', version: '1:2' },
    candidateCoverageComplete: true,
    candidateCompleteness: { state: 'COMPLETE', reason: null },
  },
});

function dependencies(overrides = {}) {
  return {
    candidateStore: { queryCandidates: vi.fn() },
    dotSource: { query: vi.fn(async () => dotSnapshot) },
    officialRelationshipProvider: {
      resolve: vi.fn(async () => ({
        ok: true,
        faceContext: {
          curbIdentityState: 'SUPPORTED', borough: 'MANHATTAN', streetNames: ['GOLD STREET'],
          fromNames: ['BEEKMAN STREET'], toNames: ['ANN STREET'], side: 'E',
          officialRelationship: {
            providerId: 'private-geosupport-function-3c', version: '26C:26.3',
            orderApplicability: { 'P-100': 'WHOLE_FACE' },
          },
        },
        diagnostics: { orderReasons: { 'P-100': [] } },
      })),
    },
    sink: { record: vi.fn(async () => ({ accepted: true })) },
    ...overrides,
  };
}

describe('minimum cleaning-only shadow experiment', () => {
  it.each([
    ['exact_agreement', 'agreement'],
    ['cleaning_schedule_differs', 'schedule_difference'],
    ['legacy_cleaning_only', 'legacy_only'],
    ['curb_intelligence_cleaning_only', 'new_only'],
    ['same_schedule_confidence_differs', 'confidence_difference'],
    ['new_more_cautious', 'agreement'],
    ['new_more_supported', 'confidence_difference'],
    ['legacy_unavailable', 'not_comparable'],
  ])('maps %s to bounded category %s', (value, expected) => {
    expect(comparisonCategory(value)).toBe(expected);
  });

  it('completes cleaning comparison with ParkNYC not evaluated and emits no BFI', async () => {
    const deps = dependencies();
    const result = await runMinimumCleaningShadow({
      location: { lat: 40.712, lng: -74.006, accuracyMeters: 12 },
      legacyEvidence,
      dependencies: deps,
      cohort: 'operator',
      now: () => 100,
      resolveCurbRuntime: vi.fn(async () => runtimeResult),
    });

    expect(result).toEqual(expect.objectContaining({ outcome: 'COMPLETED', parkNycState: 'NOT_EVALUATED' }));
    expect(result.comparisonCategory).toBe('agreement');
    expect(result.productSchedules[0]).toEqual(expect.objectContaining({
      side: expect.any(String), days: expect.any(Array), startTime: expect.any(String), endTime: expect.any(String),
    }));
    expect(JSON.stringify(result)).not.toContain('0212261301');
    expect(JSON.stringify(result.productSchedules)).not.toMatch(/orderNumber|officialBlockFaceId|rawText/);
    expect(deps.sink.record).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(deps.sink.record.mock.calls[0][0])).not.toContain('0212261301');
  });

  it.each([
    ['curb resolution unknown', { runtime: { resolution: { state: 'UNKNOWN' }, runtimeEvidence: null } }],
    ['CSCL coverage incomplete', { runtime: {
      ...runtimeResult,
      runtimeEvidence: {
        ...runtimeResult.runtimeEvidence,
        candidateCoverageComplete: false,
        candidateCompleteness: { state: 'INCOMPLETE', reason: 'source_query_truncated' },
      },
    } }],
    ['DOT incomplete', { dot: { ...dotSnapshot, completeness: { state: 'INCOMPLETE', reason: 'source_query_truncated' } } }],
    ['relationship unresolved', { relationship: { ok: true, faceContext: { officialRelationship: { orderApplicability: { 'P-100': 'UNKNOWN' } } } } }],
  ])('returns UNKNOWN for %s', async (_label, variant) => {
    const deps = dependencies({
      dotSource: { query: vi.fn(async () => variant.dot || dotSnapshot) },
      officialRelationshipProvider: { resolve: vi.fn(async () => variant.relationship || dependencies().officialRelationshipProvider.resolve()) },
    });
    const result = await runMinimumCleaningShadow({
      location: { lat: 40.712, lng: -74.006, accuracyMeters: 12 },
      legacyEvidence,
      dependencies: deps,
      resolveCurbRuntime: vi.fn(async () => variant.runtime || runtimeResult),
    });
    expect(result.outcome).toBe('UNKNOWN');
  });

  it('classifies internal infrastructure failure as FAILED without throwing', async () => {
    const deps = dependencies();
    const result = await runMinimumCleaningShadow({
      location: { lat: 40.712, lng: -74.006, accuracyMeters: 12 },
      legacyEvidence,
      dependencies: deps,
      resolveCurbRuntime: vi.fn(async () => { throw new Error('private detail'); }),
    });
    expect(result).toEqual(expect.objectContaining({ outcome: 'FAILED', skipOrFailureClass: 'internal_failure' }));
    expect(JSON.stringify(result)).not.toContain('private detail');
  });

  it('skips when legacy evidence has no usable cleaning comparison', async () => {
    const deps = dependencies();
    const result = await runMinimumCleaningShadow({
      location: { lat: 40.712, lng: -74.006, accuracyMeters: 12 },
      legacyEvidence: { ...legacyEvidence, activeRules: [] },
      dependencies: deps,
      resolveCurbRuntime: vi.fn(async () => runtimeResult),
    });
    expect(result).toEqual(expect.objectContaining({ outcome: 'SKIPPED', skipOrFailureClass: 'legacy_evidence_missing' }));
    expect(deps.dotSource.query).not.toHaveBeenCalled();
  });

  it('keeps telemetry failure non-fatal and performs no retry', async () => {
    const sink = { record: vi.fn(async () => { throw new Error('logging unavailable'); }) };
    const deps = dependencies({ sink });
    const result = await runMinimumCleaningShadow({
      location: { lat: 40.712, lng: -74.006, accuracyMeters: 12 },
      legacyEvidence,
      dependencies: deps,
      resolveCurbRuntime: vi.fn(async () => runtimeResult),
    });
    expect(result.outcome).toBe('COMPLETED');
    expect(sink.record).toHaveBeenCalledTimes(1);
  });

  it('keeps the official relationship budget aligned with standalone shadow execution', () => {
    expect(RELATIONSHIP_TIMEOUT_MS).toBe(3000);
    expect(RELATIONSHIP_TIMEOUT_MS).toBe(DEFAULT_EXECUTION_POLICY.sourceDeadlineMs.relationship);
    expect(DEFAULT_EXECUTION_POLICY.overallDeadlineMs).toBe(8000);
    expect(DEFAULT_EXECUTION_POLICY.maxRetries).toBe(0);
  });

  it('bounds the relationship provider to the reviewed 3-second budget without retrying', async () => {
    let receivedSignal;
    const resolve = vi.fn(input => {
      receivedSignal = input.signal;
      return new Promise(() => {});
    });
    const deps = dependencies({ officialRelationshipProvider: { resolve } });
    const result = await runMinimumCleaningShadow({
      location: { lat: 40.712, lng: -74.006, accuracyMeters: 12 },
      legacyEvidence,
      dependencies: deps,
      executionPolicy: { relationshipTimeoutMs: 5 },
      resolveCurbRuntime: vi.fn(async () => runtimeResult),
    });
    expect(result).toEqual(expect.objectContaining({ outcome: 'UNKNOWN', skipOrFailureClass: 'relationship_unknown' }));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(receivedSignal.aborted).toBe(true);
  });

  it('completes a 2700ms official relationship inside the 3000ms budget', async () => {
    vi.useFakeTimers();
    try {
      let receivedSignal;
      const resolve = vi.fn(async ({ signal }) => {
        receivedSignal = signal;
        await new Promise(done => setTimeout(done, 2700));
        expect(signal.aborted).toBe(false);
        return dependencies().officialRelationshipProvider.resolve();
      });
      const deps = dependencies({ officialRelationshipProvider: { resolve } });
      const pending = runMinimumCleaningShadow({
        location: { lat: 40.712, lng: -74.006, accuracyMeters: 12 },
        legacyEvidence,
        dependencies: deps,
        resolveCurbRuntime: vi.fn(async () => runtimeResult),
      });
      await vi.advanceTimersByTimeAsync(2700);
      const result = await pending;
      expect(result).toEqual(expect.objectContaining({
        outcome: 'COMPLETED',
        skipOrFailureClass: 'none',
        parkNycState: 'NOT_EVALUATED',
      }));
      expect(result.skipOrFailureClass).not.toBe('relationship_unknown');
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(receivedSignal).toBeInstanceOf(AbortSignal);
      expect(JSON.stringify(result)).not.toContain('0212261301');
      expect(JSON.stringify(deps.sink.record.mock.calls[0][0])).not.toContain('0212261301');
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts a relationship that exceeds 3000ms as UNKNOWN with zero retry', async () => {
    vi.useFakeTimers();
    try {
      let receivedSignal;
      const resolve = vi.fn(({ signal }) => {
        receivedSignal = signal;
        return new Promise(() => {});
      });
      const deps = dependencies({ officialRelationshipProvider: { resolve } });
      const pending = runMinimumCleaningShadow({
        location: { lat: 40.712, lng: -74.006, accuracyMeters: 12 },
        legacyEvidence,
        dependencies: deps,
        resolveCurbRuntime: vi.fn(async () => runtimeResult),
      });
      await vi.advanceTimersByTimeAsync(2999);
      expect(receivedSignal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const result = await pending;
      expect(result).toEqual(expect.objectContaining({
        outcome: 'UNKNOWN',
        skipOrFailureClass: 'relationship_unknown',
        parkNycState: 'NOT_EVALUATED',
      }));
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(receivedSignal.aborted).toBe(true);
      expect(JSON.stringify(result)).not.toContain('0212261301');
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts an in-flight relationship when the parent overall signal fires before 3000ms', async () => {
    vi.useFakeTimers();
    try {
      const parent = new AbortController();
      let receivedSignal;
      const resolve = vi.fn(({ signal }) => {
        receivedSignal = signal;
        return new Promise(() => {});
      });
      const deps = dependencies({ officialRelationshipProvider: { resolve } });
      const pending = runMinimumCleaningShadow({
        location: { lat: 40.712, lng: -74.006, accuracyMeters: 12 },
        legacyEvidence,
        dependencies: deps,
        signal: parent.signal,
        resolveCurbRuntime: vi.fn(async () => runtimeResult),
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(resolve).toHaveBeenCalledTimes(1);
      expect(receivedSignal.aborted).toBe(false);
      parent.abort();
      expect(receivedSignal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(3000);
      const result = await pending;
      expect(result).toEqual(expect.objectContaining({
        outcome: 'UNKNOWN',
        skipOrFailureClass: 'relationship_unknown',
      }));
      expect(resolve).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
