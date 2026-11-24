import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  classifyRegulationCoverage,
  summarizeRegulationCoverage,
  publishableRules,
  isRegulationCoverage,
} = require('./regulationCoverage');

const cleaning = {
  category: 'cleaning', source: 'dot',
  schedules: [{ days: ['Mon', 'Thu'], startTime: '08:30', endTime: '10:00', side: 'West' }],
};
const restriction = {
  category: 'restriction', type: 'noParking', source: 'dot',
  schedules: [{ side: 'West', days: ['Mon'], startTime: '08:00', endTime: '09:00', type: 'noParking' }],
};
const timeLimit = {
  category: 'timeLimit', type: 'timeLimited', source: 'dot',
  schedules: [{ side: 'West', days: ['Mon'], startTime: '09:00', endTime: '19:00' }],
};

function selected(rules, extra = {}) {
  return {
    rules,
    cleaning: rules.find(rule => rule.category === 'cleaning') || null,
    restrictions: rules.filter(rule => rule.category === 'restriction'),
    timeLimits: rules.filter(rule => rule.category === 'timeLimit'),
    meter: null,
    conflicts: [],
    ...extra,
  };
}

const completeDot = { state: 'complete', resourceId: 'nfid-uabd' };

describe('regulation category coverage', () => {
  it('keeps Melville cleaning verified when ParkNYC is unavailable', () => {
    const coverage = classifyRegulationCoverage(
      { dot: completeDot, parkNyc: { state: 'unavailable', reason: 'source_unavailable' } },
      selected([cleaning]),
    );
    expect(coverage).toEqual({
      cleaning: 'verified', restrictions: 'verified_empty', timeLimits: 'verified_empty', meters: 'unknown',
    });
    expect(summarizeRegulationCoverage(coverage)).toMatchObject({
      regulationStatus: 'partial', regulationCompleteness: 'incomplete',
    });
    expect(publishableRules([cleaning], coverage)).toEqual([cleaning]);
  });

  it('keeps cleaning verified when restriction evidence is unknown', () => {
    const coverage = {
      cleaning: 'verified', restrictions: 'unknown', timeLimits: 'verified_empty', meters: 'verified_empty',
    };
    expect(summarizeRegulationCoverage(coverage).regulationStatus).toBe('partial');
    expect(publishableRules([cleaning, restriction], coverage)).toEqual([cleaning]);
  });

  it('treats every modeled category as settled when each source proves it', () => {
    const coverage = classifyRegulationCoverage(
      { dot: completeDot, parkNyc: { state: 'supported', product: { type: 'meter' } } },
      selected([cleaning, restriction, timeLimit]),
    );
    expect(coverage).toEqual({
      cleaning: 'verified', restrictions: 'verified', timeLimits: 'verified', meters: 'verified',
    });
    expect(summarizeRegulationCoverage(coverage)).toEqual({
      regulationStatus: 'verified', regulationCompleteness: 'complete', regulationAvailability: 'available',
    });
  });

  it('allows verified empty only when the source proves the negative', () => {
    const coverage = classifyRegulationCoverage(
      {
        dot: completeDot,
        parkNyc: { state: 'omitted', event: 'meter_no_match', reason: 'official_meter_missing' },
      },
      selected([]),
    );
    expect(coverage).toEqual({
      cleaning: 'verified_empty', restrictions: 'verified_empty', timeLimits: 'verified_empty', meters: 'verified_empty',
    });
    expect(summarizeRegulationCoverage(coverage).regulationStatus).toBe('verified_empty');
    expect(publishableRules([], coverage)).toEqual([]);
  });

  it('does not treat a meter miss, timeout, or unfinished response as empty', () => {
    expect(classifyRegulationCoverage(
      { dot: completeDot, parkNyc: { state: 'unavailable', reason: 'execution_timeout' } },
      selected([]),
    ).meters).toBe('unknown');
    expect(classifyRegulationCoverage(
      { dot: completeDot, parkNyc: { state: 'unavailable', reason: 'source_unavailable' } },
      selected([]),
    ).meters).toBe('unknown');
    expect(classifyRegulationCoverage(
      { dot: completeDot, parkNyc: { state: 'unavailable', reason: 'candidate_source_incomplete' } },
      selected([]),
    ).meters).toBe('incomplete');
    expect(classifyRegulationCoverage(
      { dot: completeDot, parkNyc: { state: 'unavailable', reason: 'source_truncated' } },
      selected([]),
    ).meters).toBe('incomplete');
    expect(classifyRegulationCoverage(
      { dot: completeDot, parkNyc: { state: 'omitted', event: 'meter_no_match', reason: 'official_meter_face_mismatch' } },
      selected([]),
    ).meters).toBe('unknown');
    expect(classifyRegulationCoverage(
      { dot: completeDot, parkNyc: { state: 'omitted', event: 'meter_no_match', reason: 'no_passenger_meter_rule' } },
      selected([]),
    ).meters).toBe('verified_empty');
  });

  it('does not treat a DOT failure or truncated response as an empty category', () => {
    expect(classifyRegulationCoverage(
      { dot: { state: 'unavailable', reason: 'source_unavailable' }, parkNyc: { state: 'unavailable', reason: 'source_unavailable' } },
      selected([]),
    )).toMatchObject({ cleaning: 'unknown', restrictions: 'unknown', timeLimits: 'unknown' });
    expect(classifyRegulationCoverage(
      { dot: { state: 'unavailable', reason: 'source_truncated' } },
      selected([cleaning]),
    ).cleaning).toBe('incomplete');
    expect(classifyRegulationCoverage(
      { dot: { state: 'unavailable', reason: 'candidate_source_incomplete' } },
      selected([]),
    ).cleaning).toBe('incomplete');
  });

  it('marks conflicting cleaning rules instead of publishing them as verified', () => {
    const coverage = classifyRegulationCoverage(
      { dot: completeDot },
      selected([cleaning], { conflicts: [{ category: 'cleaning' }] }),
    );
    expect(coverage.cleaning).toBe('conflict');
    expect(summarizeRegulationCoverage(coverage)).toMatchObject({
      regulationStatus: 'unknown', regulationAvailability: 'conflict',
    });
    expect(publishableRules([cleaning], coverage)).toEqual([]);
  });

  it('does not call the opposite block face an empty result', () => {
    const coverage = classifyRegulationCoverage(
      { dot: { state: 'complete', reasons: ['official_blockface_mismatch'] } },
      selected([]),
    );
    expect(coverage.cleaning).toBe('unknown');
    expect(coverage.restrictions).toBe('unknown');
    expect(coverage.timeLimits).toBe('unknown');
  });

  it('rejects coverage objects that are missing a category', () => {
    expect(isRegulationCoverage({ cleaning: 'verified' })).toBe(false);
    expect(isRegulationCoverage({
      cleaning: 'verified', restrictions: 'complete', timeLimits: 'unknown', meters: 'unknown',
    })).toBe(false);
  });
});
