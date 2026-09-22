'use strict';

const {
  publicProductSchedules,
  decideProductPresentation,
  createProductOverlayPlan,
} = require('./productPathDecision');

const supported = Object.freeze({
  outcome: 'COMPLETED',
  skipOrFailureClass: 'none',
  curbState: 'SUPPORTED',
  cleaningState: 'SUPPORTED',
  comparisonCategory: 'schedule_difference',
  productSchedules: [{
    side: 'East', days: ['Tue'], startTime: '08:30', endTime: '10:00',
  }],
});

describe('pre-release Curb product-path decision', () => {
  it('uses a confident Curb result instead of legacy', () => {
    const decision = decideProductPresentation(supported);
    expect(decision).toEqual({
      apply: true,
      caution: false,
      schedules: supported.productSchedules,
      reason: 'usable',
    });
  });

  it('keeps legacy when the relationship is unsupported', () => {
    expect(decideProductPresentation({
      ...supported,
      outcome: 'UNKNOWN',
      skipOrFailureClass: 'relationship_unknown',
      comparisonCategory: 'not_comparable',
    }).apply).toBe(false);
  });

  it('keeps legacy on resolver timeout', () => {
    expect(decideProductPresentation({
      outcome: 'UNKNOWN',
      skipOrFailureClass: 'execution_timeout',
      curbState: 'UNKNOWN',
      cleaningState: 'UNKNOWN',
      comparisonCategory: 'not_comparable',
    })).toEqual({ apply: false, reason: 'execution_timeout' });
  });

  it('keeps legacy on resolver 5xx / internal failure', () => {
    expect(decideProductPresentation({
      outcome: 'FAILED',
      skipOrFailureClass: 'internal_failure',
      curbState: 'UNKNOWN',
      cleaningState: 'UNKNOWN',
      comparisonCategory: 'not_comparable',
    })).toEqual({ apply: false, reason: 'internal_failure' });
  });

  it('marks caution instead of overstating an ambiguous Curb result', () => {
    const decision = decideProductPresentation({
      ...supported,
      curbState: 'CAUTION',
      cleaningState: 'CAUTION',
      comparisonCategory: 'confidence_difference',
    });
    expect(decision.apply).toBe(true);
    expect(decision.caution).toBe(true);
  });

  it('strips internal provenance, BFI, and raw resolver fields from public schedules', () => {
    const schedules = publicProductSchedules([{
      schedules: [{
        side: 'West', days: ['Mon'], startTime: '07:00', endTime: '08:00',
        durationMinutes: 60, orderNumber: 'P-100',
      }],
      provenance: [{ orderNumber: 'P-100', officialBlockFaceId: '0212261301' }],
      rawEvidence: { rawText: 'secret' },
    }]);
    expect(schedules).toEqual([{ side: 'West', days: ['Mon'], startTime: '07:00', endTime: '08:00' }]);
    expect(JSON.stringify(schedules)).not.toMatch(/0212261301|P-100|secret|durationMinutes/);
  });

  it('does not write an overlay when the callable result is not a usable segment', () => {
    expect(createProductOverlayPlan({ success: false }, { apply: true, schedules: supported.productSchedules }))
      .toBe(null);
    const plan = createProductOverlayPlan(
      { success: true, segmentId: 'nyc-od:seg' },
      decideProductPresentation(supported),
    );
    expect(plan.ruleDocId).toBe('nyc_open_data_v1');
    expect(plan.status).toBe('active');
    expect(JSON.stringify(plan)).not.toMatch(/officialBlockFaceId|blockFaceId|BFI/);
  });
});
