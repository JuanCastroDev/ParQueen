import { describe, expect, it } from 'vitest';
import { computeSafeUntil } from './streetIntelligence';
import { formatMeterWindowLabel, formatMaxStay, isMeterWindowActive } from './streetIntelMeter';
import { countUsableStreetIntelligence, shouldCallEmptyCacheRefresh } from './streetIntelRefresh';

const METER = [{ side: 'West', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], startTime: '09:00', endTime: '19:00' }];
const CLEANING = [{ side: 'West', days: ['Mon', 'Thu'], startTime: '08:30', endTime: '09:00' }];

describe('meter copy and SAFE UNTIL isolation', () => {
  it('M. ordinary meter hours do not change SAFE UNTIL', () => {
    const now = new Date('2026-08-24T10:00:00-04:00');
    const cleaningOnly = computeSafeUntil(CLEANING, 'West', [], now);
    const ifMetersWereCleaning = computeSafeUntil([...CLEANING, ...METER], 'West', [], now);
    expect(cleaningOnly.activeNow).toBe(false);
    expect(ifMetersWereCleaning.activeNow).toBe(true);
    expect(cleaningOnly.scheduleDescription).toContain('8:30');
    expect(cleaningOnly.scheduleDescription).not.toContain('7 PM');
  });

  it('J/K. earliest prohibition wins and meter hours are ignored', () => {
    const now = new Date('2026-08-24T10:00:00-04:00');
    const standing = [{
      side: 'West', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], startTime: '16:00', endTime: '19:00', type: 'noStanding' as const,
    }];
    const mixed = computeSafeUntil([...CLEANING, ...standing], 'West', [], now);
    const cleaningOnly = computeSafeUntil(CLEANING, 'West', [], now);
    expect(mixed.nextTime).toBe('4 PM');
    expect(cleaningOnly.nextTime).not.toBe('4 PM');
    const withMeterShaped = computeSafeUntil([
      ...CLEANING,
      { side: 'West', days: ['Mon'], startTime: '09:00', endTime: '19:00', type: 'meter' as const },
    ], 'West', [], now);
    expect(withMeterShaped.nextTime).toBe(cleaningOnly.nextTime);
  });

  it('L. an active No Standing window is restricted now', () => {
    const now = new Date('2026-08-24T16:30:00-04:00');
    const standing = [{
      side: 'West', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], startTime: '16:00', endTime: '19:00', type: 'noStanding' as const,
    }];
    const result = computeSafeUntil([...CLEANING, ...standing], 'West', [], now);
    expect(result.activeNow).toBe(true);
    expect(result.restrictionKind).toBe('noStanding');
  });

  it('A. No Parking Anytime has no future clock', () => {
    const result = computeSafeUntil([{
      side: 'West', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], anytime: true, type: 'noParking' as const,
    }], 'West', [], new Date('2026-08-24T10:00:00-04:00'));
    expect(result.activeNow).toBe(true);
    expect(result.anytime).toBe(true);
    expect(result.safeUntil).toBeNull();
    expect(result.nextTime).toBeNull();
  });

  it('formats source-backed meter hours without claiming free parking', () => {
    expect(formatMeterWindowLabel(METER[0])).toBe('Mon & Tue & Wed & Thu & Fri & Sat · 9 AM–7 PM');
    expect(formatMaxStay(120)).toBe('2 hr maximum');
    expect(formatMaxStay(null)).toBeNull();
    expect(isMeterWindowActive(METER[0], new Date('2026-08-24T10:00:00-04:00'))).toBe(true);
    expect(isMeterWindowActive(METER[0], new Date('2026-08-24T07:00:00-04:00'))).toBe(false);
  });

  it('J. meter-only cache is usable intelligence and empty cache still refreshes', () => {
    expect(countUsableStreetIntelligence([{ type: 'meter', schedules: METER }])).toBe(1);
    expect(shouldCallEmptyCacheRefresh(1, false)).toBe(false);
    expect(shouldCallEmptyCacheRefresh(0, false)).toBe(true);
  });
});
