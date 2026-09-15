import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { adaptLegacyCleaningEvidence } = require('./legacyCleaningAdapter');

const segment = (overrides = {}) => ({
  status: 'active', source: 'nyc_open_data', confidenceScore: 0.9,
  provenance: { provider: 'nyc_open_data' },
  confidence: { level: 'community' },
  blockFaceEvidence: { blockDecisive: true, sideResolved: true, parseComplete: true },
  ...overrides,
});
const rule = (schedules, overrides = {}) => ({
  type: 'streetCleaning', source: 'nyc_open_data', supersededAt: null, schedules, ...overrides,
});
const schedule = (overrides = {}) => ({
  side: 'West', days: ['Thu', 'Mon'], startTime: '08:00', endTime: '09:00', ...overrides,
});

describe('structured legacy cleaning adapter', () => {
  it('canonicalizes actual segment and activeRules evidence without UI/time fields', () => {
    const result = adaptLegacyCleaningEvidence({
      segment: segment(), activeRules: [rule([schedule()])],
    });
    expect(result).toEqual({
      availability: 'USABLE',
      confidence: 'SUPPORTED',
      fingerprint: 'Mon,Thu|08:00|09:00',
      sourceFamily: 'nyc_open_data',
    });
    expect(result).not.toHaveProperty('safeUntil');
    expect(result).not.toHaveProperty('presentation');
  });

  it('maps reviewed caution evidence without inferring authority from copy', () => {
    const result = adaptLegacyCleaningEvidence({
      segment: segment({ status: 'needs_review', needsReview: true, confidenceScore: 0.5 }),
      activeRules: [rule([schedule()])],
    });
    expect(result).toMatchObject({ availability: 'USABLE', confidence: 'CAUTION' });
  });

  it('distinguishes no cleaning, malformed evidence, and unavailable evidence', () => {
    expect(adaptLegacyCleaningEvidence({ segment: segment(), activeRules: [] }))
      .toEqual({ availability: 'NONE', confidence: 'UNKNOWN', fingerprint: null, sourceFamily: 'nyc_open_data' });
    expect(adaptLegacyCleaningEvidence({ segment: segment(), activeRules: [rule([schedule({ startTime: '8am' })])] }))
      .toMatchObject({ availability: 'MALFORMED', confidence: 'UNKNOWN', fingerprint: null });
    expect(adaptLegacyCleaningEvidence({ segment: null, activeRules: null }))
      .toEqual({ availability: 'UNAVAILABLE', confidence: 'UNKNOWN', fingerprint: null, sourceFamily: null });
  });

  it('fails closed when schedules cover different curb sides', () => {
    const result = adaptLegacyCleaningEvidence({
      segment: segment(),
      activeRules: [rule([schedule(), schedule({ side: 'East' })])],
    });
    expect(result).toMatchObject({ availability: 'MALFORMED', confidence: 'UNKNOWN' });
  });
});
