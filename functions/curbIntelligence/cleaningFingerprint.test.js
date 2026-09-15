import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createCleaningFingerprint } = require('./cleaningFingerprint');
const { createShadowComparison } = require('./contracts');

describe('canonical cleaning fingerprint producer', () => {
  it('canonicalizes weekday order and removes duplicate weekdays', () => {
    expect(createCleaningFingerprint([{ days: ['Fri', 'Mon', 'Fri', 'Wed'], startTime: '08:00', endTime: '09:30' }]))
      .toEqual({ ok: true, fingerprint: 'Mon,Wed,Fri|08:00|09:30' });
  });

  it('canonicalizes schedule order and removes duplicate schedules', () => {
    const first = { days: ['Thu'], startTime: '11:00', endTime: '12:30' };
    const second = { days: ['Mon', 'Tue'], startTime: '06:30', endTime: '07:30' };
    const expected = 'Mon,Tue|06:30|07:30;Thu|11:00|12:30';
    expect(createCleaningFingerprint([first, second, first])).toEqual({ ok: true, fingerprint: expected });
    expect(createCleaningFingerprint([second, first])).toEqual({ ok: true, fingerprint: expected });
  });

  it('fails closed for incomplete schedules and accepts null as no reviewed rule', () => {
    expect(createCleaningFingerprint([])).toEqual({ ok: true, fingerprint: null });
    expect(createCleaningFingerprint([{ days: [], startTime: '08:00', endTime: '09:00' }]))
      .toEqual({ ok: false, reason: 'invalid_cleaning_schedule' });
  });

  it('produces a multi-schedule fingerprint accepted by the privacy-safe shadow contract', () => {
    const fingerprint = createCleaningFingerprint([
      { days: ['Thu'], startTime: '11:00', endTime: '12:30' },
      { days: ['Mon'], startTime: '06:30', endTime: '07:30' },
    ]).fingerprint;
    expect(createShadowComparison({
      category: 'cleaning_schedule_differs', oldCleaningFingerprint: fingerprint,
      newCleaningFingerprint: fingerprint, meterRulePresent: false,
      blockFaceResolutionState: 'SUPPORTED', reasonCodes: ['cleaning_schedule_differs'],
      sourceVersions: { cscl: 'v1', dotSigns: 'v1' },
    }).ok).toBe(true);
  });
});
