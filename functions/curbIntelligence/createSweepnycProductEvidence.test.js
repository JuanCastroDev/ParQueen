'use strict';

const { createSweepnycProductEvidence } = require('./createSweepnycProductEvidence');

describe('SweepNYC product evidence capture', () => {
  it('reuses in-memory SweepNYC segment and schedule evidence without DOT rows', () => {
    const evidence = createSweepnycProductEvidence({
      segment: {
        source: 'sweepnyc',
        provenance: { provider: 'sweepnyc' },
        streetName: 'MELVILLE STREET',
        fromCross: 'JAMAICA AVENUE',
        toCross: 'HILLSIDE AVENUE',
        borough: 'QN',
        status: 'active',
        confidenceScore: 0.95,
      },
      rule: {
        type: 'streetCleaning',
        source: 'sweepnyc',
        schedules: [
          { side: 'East', days: ['Tue'], startTime: '08:30', endTime: '10:00' },
          { side: 'West', days: ['Wed'], startTime: '08:30', endTime: '10:00' },
        ],
      },
    });
    expect(evidence.productionPath).toBe('sweepnyc');
    expect(evidence.streetContext.borough).toBe('QUEENS');
    expect(evidence.dotEvidence).toBeUndefined();
    expect(JSON.stringify(evidence)).not.toMatch(/officialBlockFaceId|blockFaceId|BFI/);
  });

  it('keeps every active SweepNYC rule instead of requiring sweepnyc_v1', () => {
    const evidence = createSweepnycProductEvidence({
      segment: {
        source: 'sweepnyc', provenance: { provider: 'sweepnyc' }, borough: 'QN',
        status: 'active', confidenceScore: 0.95,
      },
      activeRules: [
        { type: 'streetCleaning', source: 'sweepnyc', schedules: [{ side: 'East', days: ['Tue'], startTime: '08:30', endTime: '10:00' }] },
        { type: 'streetCleaning', source: 'sweepnyc', schedules: [{ side: 'West', days: ['Wed'], startTime: '08:30', endTime: '10:00' }] },
      ],
    });
    expect(evidence.legacyEvidence.activeRules).toHaveLength(2);
    expect(evidence.legacyEvidence.activeRules.map(rule => rule.schedules[0].side)).toEqual(['East', 'West']);
  });
});
