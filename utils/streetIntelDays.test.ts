import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { computeSafeUntil, type CleaningSchedule, type SuspensionDoc } from './streetIntelligence';
import { classifyStreetIntelligence } from './streetIntelligencePresentation';
import { formatDaysLabel, CANONICAL_WEEKDAYS } from './streetIntelDays';

const WEEK = [...CANONICAL_WEEKDAYS];
const NO_SUSPENSIONS: SuspensionDoc[] = [];
const DAILY: CleaningSchedule[] = [
  { side: 'West', days: WEEK, startTime: '08:30', endTime: '09:00' },
];

function dateAt(dayName: string, hour: number, minute = 0): Date {
  const days: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const now = new Date();
  const diff = days[dayName] - now.getDay();
  const d = new Date(now);
  d.setDate(now.getDate() + diff);
  d.setHours(hour, minute, 0, 0);
  return d;
}

let originalTZ: string | undefined;
beforeAll(() => { originalTZ = process.env.TZ; process.env.TZ = 'America/New_York'; });
afterAll(() => { process.env.TZ = originalTZ; });

describe('J-L 7-day CleaningSchedule model', () => {
  it('J. next occurrence is the next daily 8:30 window', () => {
    const result = computeSafeUntil(DAILY, 'West', NO_SUSPENSIONS, dateAt('Mon', 7, 0));
    expect(result.nextDay).toBe('Monday');
    expect(result.nextTime).toBe('8:30 AM');
    expect(result.safeUntil).not.toBeNull();
    expect(result.safeUntil!.getHours()).toBe(8);
    expect(result.safeUntil!.getMinutes()).toBe(30);
  });

  it('K. active-now during the daily window', () => {
    const result = computeSafeUntil(DAILY, 'West', NO_SUSPENSIONS, dateAt('Wed', 8, 45));
    expect(result.activeNow).toBe(true);
    expect(result.safeUntil!.getHours()).toBe(9);
    expect(result.safeUntil!.getMinutes()).toBe(0);
  });

  it('L. safe-until is the window start when parked before it, and reminder offset is derived from that instant', () => {
    const result = computeSafeUntil(DAILY, 'West', NO_SUSPENSIONS, dateAt('Thu', 7, 0));
    expect(result.activeNow).toBe(false);
    expect(result.safeUntil).not.toBeNull();
    const reminderAt = new Date(result.safeUntil!.getTime() - 30 * 60 * 1000);
    expect(reminderAt.getHours()).toBe(8);
    expect(reminderAt.getMinutes()).toBe(0);
    expect(result.scheduleDescription).toBe('Every day · 8:30 AM–9 AM');
  });
});

describe('M equivalent full-week schedules dedup', () => {
  it('shuffled canonical weeks with the same window do not conflict', () => {
    const shuffled = ['Sun', 'Sat', 'Fri', 'Thu', 'Wed', 'Tue', 'Mon'];
    const presentation = classifyStreetIntelligence(
      {
        status: 'active',
        source: 'sweepnyc',
        confidenceScore: 0.95,
        provenance: { provider: 'sweepnyc' },
      },
      [
        { source: 'sweepnyc', schedules: [{ side: 'West', days: WEEK, startTime: '08:30', endTime: '09:00' }] },
        { source: 'nyc_open_data', schedules: [{ side: 'West', days: shuffled, startTime: '08:30', endTime: '09:00' }] },
      ],
    );
    expect(presentation.reasons).not.toContain('conflicting_schedules');
    expect(formatDaysLabel(shuffled)).toBe('Every day');
  });
});
