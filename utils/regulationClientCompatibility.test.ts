import { describe, expect, it } from 'vitest';
import { parseCanonicalCurbResponse } from './canonicalCurbClient';
import { assessHydrantDistance } from './hydrantDistance';
import { evaluateParkingCheck } from './parkingCheck';
import {
  coverageForDisplayedRules,
  coverageIsComplete,
  unknownRegulationCoverage,
} from './regulationCoverage';
import type { SafeUntilResult } from './streetIntelligence';

const key = 'curb2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const cleaningRule = {
  category: 'cleaning',
  type: 'streetCleaning',
  source: 'nyc_open_data',
  schedules: [{ days: ['Mon', 'Thu'], startTime: '08:30', endTime: '10:00', side: 'West' }],
};
const partialCoverage = {
  cleaning: 'verified' as const,
  restrictions: 'verified_empty' as const,
  timeLimits: 'verified_empty' as const,
  meters: 'unknown' as const,
};
const farHydrant = assessHydrantDistance({ distanceMeters: 12.2, accuracyMeters: 1 });
const clearRules: SafeUntilResult = {
  activeNow: false,
  safeUntil: new Date('2026-08-24T12:30:00Z'),
  nextDay: 'Monday',
  nextTime: '8:30 AM',
  scheduleDescription: 'Mon & Thu · 8:30–10 AM',
};

function clientBeforeCoverageShowsSafeUntil(response: {
  publicRules?: readonly unknown[] | null;
  regulationStatus?: string | null;
}): boolean {
  return Array.isArray(response.publicRules)
    && response.publicRules.length > 0
    && (response.regulationStatus == null || response.regulationStatus === 'verified');
}

describe('old and new curb clients', () => {
  it('does not all-clear a version 2 response with partial category coverage', () => {
    const response = parseCanonicalCurbResponse({
      protocolVersion: 2,
      status: 'high_confidence',
      segmentId: key,
      streetName: 'MELVILLE STREET',
      sideLabel: 'West',
      ruleSummary: { cleaningAvailable: true },
      responseVersion: 2,
      cacheHit: false,
      identityConfidence: 'high',
      regulationStatus: 'partial',
      regulationCompleteness: 'incomplete',
      regulationAvailability: 'unavailable',
      regulationCoverage: partialCoverage,
      publicRules: [cleaningRule],
      publicSchedules: { cleaning: cleaningRule.schedules, restrictions: [], timeLimited: [], meters: [] },
    });
    if (response.status !== 'high_confidence') throw new Error('expected a high confidence fixture');
    const coverage = coverageForDisplayedRules({
      segmentId: response.segmentId,
      curbProtocolVersion: 2,
      regulationStatus: response.regulationStatus,
      regulationCoverage: response.regulationCoverage,
      publicRules: response.publicRules,
    });
    expect(coverageIsComplete(coverage)).toBe(false);
    expect(evaluateParkingCheck({
      street: { presentation: 'supported', safeUntil: clearRules, effectiveSide: 'West', regulationCoverage: coverage },
      hydrant: farHydrant,
    }).overall).not.toBe('no_known_issue');
  });

  it('gives a version 2 client no schedule when an older server omits the extended fields', () => {
    const response = parseCanonicalCurbResponse({
      protocolVersion: 2,
      status: 'high_confidence',
      segmentId: key,
      streetName: 'MELVILLE STREET',
      sideLabel: 'West',
      ruleSummary: { cleaningAvailable: true },
    });
    if (response.status !== 'high_confidence') throw new Error('expected a legacy high confidence fixture');
    expect(response.publicRules).toBeUndefined();
    expect(coverageForDisplayedRules({
      segmentId: response.segmentId,
      curbProtocolVersion: 2,
      regulationStatus: null,
      publicRules: null,
    })).toEqual(unknownRegulationCoverage());
    expect(clientBeforeCoverageShowsSafeUntil(response)).toBe(false);
  });

  it('records that a version 1 client still treats a coarse verified cleaning rule as Safe Until', () => {
    const response = parseCanonicalCurbResponse({
      protocolVersion: 2,
      status: 'high_confidence',
      segmentId: key,
      streetName: 'MELVILLE STREET',
      sideLabel: 'West',
      ruleSummary: { cleaningAvailable: true },
      responseVersion: 1,
      cacheHit: false,
      identityConfidence: 'high',
      regulationStatus: 'verified',
      regulationCompleteness: 'complete',
      regulationAvailability: 'available',
      publicRules: [cleaningRule],
      publicSchedules: { cleaning: cleaningRule.schedules, restrictions: [], timeLimited: [], meters: [] },
    });
    if (response.status !== 'high_confidence') throw new Error('expected a version 1 fixture');
    expect(clientBeforeCoverageShowsSafeUntil(response)).toBe(true);
    const coverage = coverageForDisplayedRules({
      segmentId: response.segmentId,
      curbProtocolVersion: 2,
      regulationStatus: response.regulationStatus,
      publicRules: response.publicRules,
    });
    expect(coverage).toEqual({
      cleaning: 'verified', restrictions: 'unknown', timeLimits: 'unknown', meters: 'unknown',
    });
    expect(coverageIsComplete(coverage)).toBe(false);
    expect(evaluateParkingCheck({
      street: { presentation: 'supported', safeUntil: clearRules, effectiveSide: 'West', regulationCoverage: coverage },
      hydrant: farHydrant,
    }).overall).toBe('check');
  });

  it('does not upgrade a saved spot from before coverage or a rule without a category', () => {
    const stored = {
      segmentId: key,
      curbProtocolVersion: 2 as const,
      regulationStatus: 'verified' as const,
      publicRules: [{ type: 'streetCleaning', source: 'nyc_open_data', schedules: cleaningRule.schedules }],
    };
    const fromType = coverageForDisplayedRules(stored);
    expect(fromType?.cleaning).toBe('verified');
    expect(coverageIsComplete(fromType)).toBe(false);

    const missingCategory = coverageForDisplayedRules({
      ...stored,
      publicRules: [{ source: 'admin', schedules: cleaningRule.schedules }],
    });
    expect(missingCategory).toEqual(unknownRegulationCoverage());

    const beforeSchema = coverageForDisplayedRules({
      segmentId: 'legacy-segment',
      curbProtocolVersion: null,
      regulationStatus: null,
      publicRules: stored.publicRules,
    });
    expect(beforeSchema).toBeNull();
    expect(coverageIsComplete(beforeSchema)).toBe(false);
  });
});
