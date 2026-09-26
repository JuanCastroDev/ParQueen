import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { selectRuleSet } = require('./ruleConflictPolicy');

const cleaning = (source, day = 'Mon') => ({
  category: 'cleaning',
  source,
  schedules: [{ side: 'North', days: [day], startTime: '08:00', endTime: '09:30' }],
});
const restriction = Object.freeze({
  category: 'restriction',
  type: 'noStanding',
  source: 'dot',
  schedules: [{ side: 'North', days: ['Mon'], startTime: '16:00', endTime: '19:00' }],
});
const timeLimit = Object.freeze({
  category: 'timeLimit',
  type: 'timeLimited',
  source: 'dot',
  schedules: [{ side: 'North', days: ['Sat'], startTime: '09:00', endTime: '19:00' }],
  maxStayMinutes: 120,
});
const meter = Object.freeze({ category: 'meter', source: 'parkNyc', windows: [], maxStayMinutes: 120 });

describe('selectRuleSet', () => {
  it('uses DOT regulatory dimensions and ParkNYC meters without concatenating SweepNYC conflict', () => {
    const selected = selectRuleSet({
      dot: { state: 'complete', rules: [cleaning('dot'), restriction, timeLimit] },
      parkNyc: { state: 'supported', product: meter },
      sweepNyc: { state: 'exact', rules: [cleaning('sweepNyc', 'Tue')] },
      admin: { state: 'complete', rules: [] },
    });

    expect(selected.cleaning).toEqual(cleaning('dot'));
    expect(selected.restrictions).toEqual([restriction]);
    expect(selected.timeLimits).toEqual([timeLimit]);
    expect(selected.meter).toBe(meter);
    expect(selected.rules.filter(rule => rule.category === 'cleaning')).toHaveLength(1);
    expect(selected.conflicts).toEqual([{
      category: 'cleaning',
      sources: ['dot', 'sweepNyc'],
      outcome: 'dot_selected',
    }]);
  });

  it('uses exact-curb SweepNYC only for DOT technical failure, not complete no-cleaning', () => {
    const sweepRule = cleaning('sweepNyc');
    const fallback = selectRuleSet({
      dot: { state: 'unavailable', reason: 'source_unavailable', rules: [] },
      sweepNyc: { state: 'exact', rules: [sweepRule] },
    });
    const noFallback = selectRuleSet({
      dot: { state: 'complete', rules: [restriction] },
      sweepNyc: { state: 'exact', rules: [sweepRule] },
    });

    expect(fallback.cleaning).toBe(sweepRule);
    expect(noFallback.cleaning).toBeNull();
  });

  it('omits only an unresolved authoritative dimension and preserves unaffected rules', () => {
    const selected = selectRuleSet({
      dot: {
        state: 'complete',
        rules: [cleaning('dot'), cleaning('dot', 'Tue'), restriction, timeLimit],
      },
      parkNyc: { state: 'supported', product: meter },
      sweepNyc: { state: 'exact', rules: [cleaning('sweepNyc')] },
    });

    expect(selected.cleaning).toBeNull();
    expect(selected.restrictions).toEqual([restriction]);
    expect(selected.timeLimits).toEqual([timeLimit]);
    expect(selected.meter).toBe(meter);
    expect(selected.rules.filter(rule => rule.category === 'cleaning')).toHaveLength(0);
    expect(selected.conflicts).toContainEqual({
      category: 'cleaning',
      sources: ['dot'],
      outcome: 'omitted_authoritative_conflict',
    });
  });

  it('records agreement without duplicating the cleaning schedule', () => {
    const selected = selectRuleSet({
      dot: { state: 'complete', rules: [cleaning('dot')] },
      sweepNyc: { state: 'exact', rules: [cleaning('sweepNyc')] },
    });

    expect(selected.rules.filter(rule => rule.category === 'cleaning')).toHaveLength(1);
    expect(selected.conflicts).toEqual([]);
  });
});
