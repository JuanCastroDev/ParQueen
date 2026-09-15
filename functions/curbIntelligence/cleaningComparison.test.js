import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { compareCleaningEvidence } = require('./cleaningComparison');

const legacy = (overrides = {}) => ({
  availability: 'USABLE', confidence: 'SUPPORTED', fingerprint: 'Mon|08:00|09:00', ...overrides,
});
const current = (overrides = {}) => ({
  confidence: 'SUPPORTED', fingerprint: 'Mon|08:00|09:00', rules: [{}], ...overrides,
});

describe('neutral cleaning comparison', () => {
  it.each([
    [legacy(), current(), 'exact_agreement'],
    [legacy({ availability: 'NONE', confidence: 'UNKNOWN', fingerprint: null }), current({ confidence: 'UNKNOWN', fingerprint: null, rules: [] }), 'both_no_usable_cleaning'],
    [legacy(), current({ confidence: 'UNKNOWN', fingerprint: null, rules: [] }), 'legacy_cleaning_only'],
    [legacy({ availability: 'NONE', confidence: 'UNKNOWN', fingerprint: null }), current(), 'curb_intelligence_cleaning_only'],
    [legacy(), current({ fingerprint: 'Tue|08:00|09:00' }), 'cleaning_schedule_differs'],
    [legacy({ confidence: 'SUPPORTED' }), current({ confidence: 'CAUTION' }), 'new_more_cautious'],
    [legacy({ confidence: 'CAUTION' }), current({ confidence: 'SUPPORTED' }), 'new_more_supported'],
    [legacy({ availability: 'MALFORMED', confidence: 'UNKNOWN', fingerprint: null }), current(), 'legacy_unavailable'],
    [legacy({ availability: 'UNAVAILABLE', confidence: 'UNKNOWN', fingerprint: null }), current({ confidence: 'UNKNOWN', fingerprint: null, rules: [] }), 'legacy_unavailable'],
  ])('returns %s/%s as %s', (oldEvidence, newEvidence, expected) => {
    expect(compareCleaningEvidence(oldEvidence, newEvidence)).toMatchObject({ category: expected });
  });

  it('treats canonical ordering as agreement and ignores meter state', () => {
    const result = compareCleaningEvidence(
      legacy({ fingerprint: 'Mon,Thu|08:00|09:00' }),
      current({ fingerprint: 'Mon,Thu|08:00|09:00', meterState: 'UNKNOWN' }),
    );
    expect(result).toEqual({ category: 'exact_agreement' });
  });
});
