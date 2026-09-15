import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { capAssociationState, createInternalCurbRuleResult } = require('./ruleConfidence');

describe('independent curb-rule confidence', () => {
  it.each([
    ['SUPPORTED', 'SUPPORTED', 'SUPPORTED'], ['SUPPORTED', 'CAUTION', 'CAUTION'],
    ['SUPPORTED', 'UNKNOWN', 'UNKNOWN'], ['CAUTION', 'SUPPORTED', 'CAUTION'],
    ['UNKNOWN', 'SUPPORTED', 'UNKNOWN'], ['BROKEN', 'SUPPORTED', 'UNKNOWN'],
    ['toString', 'SUPPORTED', 'UNKNOWN'], ['SUPPORTED', '__proto__', 'UNKNOWN'],
  ])('caps %s by curb %s as %s', (rule, curb, expected) => {
    expect(capAssociationState(rule, curb)).toBe(expected);
  });

  it('does not accept inherited object-property names as confidence states', () => {
    const result = createInternalCurbRuleResult({ curbIdentity: { state: 'toString' } });
    expect(result.states).toEqual({ curb: 'UNKNOWN', cleaning: 'UNKNOWN', meter: 'UNKNOWN' });
  });

  it('retains independent cleaning and meter states without cross-domain upgrades', () => {
    const result = createInternalCurbRuleResult({
      curbIdentity: { state: 'SUPPORTED', officialIdentity: { officialBlockFaceId: '123' } },
      cleaning: { confidence: 'UNKNOWN', reasons: ['conflicting_cleaning_rules'], rules: [] },
      meter: { state: 'SUPPORTED', reasonCodes: [], rules: [{ zoneId: '100124' }] },
      sourceVersions: { cscl: 'v1', dotSigns: 'v2', parkNyc: 'v3' },
      diagnostics: { candidateCounts: { dot: 2, parkNyc: 1 } },
    });
    expect(result.states).toEqual({ curb: 'SUPPORTED', cleaning: 'UNKNOWN', meter: 'SUPPORTED' });
    expect(result.cleaning.reasons).toEqual(['conflicting_cleaning_rules']);
    expect(result.meter.rules[0].zoneId).toBe('100124');
  });
});
