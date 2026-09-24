import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  computeSafeUntil,
  detectParkingSide,
  computeCrossRaw,
  toNYCDateKey,
  type CleaningSchedule,
  type SuspensionDoc,
} from './streetIntelligence';
import { parseSweepNYCSign, detectCardinalSide, PARSER_VERSION } from './sweepnyc';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a Date at a specific weekday and time in the current week. */
function dateAt(dayName: string, hour: number, minute = 0): Date {
  const days: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const now = new Date();
  const diff = days[dayName] - now.getDay();
  const d = new Date(now);
  d.setDate(now.getDate() + diff);
  d.setHours(hour, minute, 0, 0);
  return d;
}

// dateAt() and computeSafeUntil's own day-of-week matching both read
// device-local time — this whole file's scenarios only make sense if that
// local time is ParQueen's real, intended deployment context (NYC). Pinning
// it here makes every test in this file deterministic regardless of which
// timezone the machine/CI runner actually defaults to.
let originalTZ: string | undefined;
beforeAll(() => { originalTZ = process.env.TZ; process.env.TZ = 'America/New_York'; });
afterAll(() => { process.env.TZ = originalTZ; });

const NO_SUSPENSIONS: SuspensionDoc[] = [];

// Melville St (Bronx) schedules from SweepNYC
const MELVILLE_SCHEDULES: CleaningSchedule[] = [
  { side: 'West', days: ['Mon', 'Thu'], startTime: '08:30', endTime: '10:00' },
  { side: 'East', days: ['Tue', 'Fri'], startTime: '08:30', endTime: '10:00' },
];

// ─── parseSweepNYCSign ────────────────────────────────────────────────────────

describe('parseSweepNYCSign', () => {
  it('parses a standard two-day sign correctly', () => {
    const result = parseSweepNYCSign(
      'No Parking Monday, Thursday 8:30AM-10AM on Melville Street from Van Nest Avenue to Morris Park Avenue (Side: West)',
    );
    expect(result).toEqual({
      street: 'Melville Street',
      fromCross: 'Van Nest Avenue',
      toCross: 'Morris Park Avenue',
      side: 'West',
      days: ['Mon', 'Thu'],
      startTime: '08:30',
      endTime: '10:00',
    });
  });

  it('parses a single-day sign', () => {
    const result = parseSweepNYCSign(
      'No Parking Friday 8AM-11AM on Broadway from W 72 St to W 73 St (Side: East)',
    );
    expect(result).toEqual({
      street: 'Broadway',
      fromCross: 'W 72 St',
      toCross: 'W 73 St',
      side: 'East',
      days: ['Fri'],
      startTime: '08:00',
      endTime: '11:00',
    });
  });

  it('parses times with optional space before AM/PM', () => {
    const result = parseSweepNYCSign(
      'No Parking Tuesday, Friday 8:30 AM-10 AM on Main St from A Ave to B Ave (Side: North)',
    );
    expect(result?.startTime).toBe('08:30');
    expect(result?.endTime).toBe('10:00');
  });

  it('returns null for No Standing signs (different prefix)', () => {
    expect(parseSweepNYCSign('No Standing 7AM-7PM')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseSweepNYCSign('')).toBeNull();
  });

  it('returns null for unrecognized format', () => {
    expect(parseSweepNYCSign('No Parking Zone — see sign')).toBeNull();
  });

  it('handles PM times correctly', () => {
    const result = parseSweepNYCSign(
      'No Parking Monday 1PM-3PM on Oak Ave from 1st St to 2nd St (Side: South)',
    );
    expect(result?.startTime).toBe('13:00');
    expect(result?.endTime).toBe('15:00');
  });

  it('handles 12PM (noon) correctly', () => {
    const result = parseSweepNYCSign(
      'No Parking Monday 12PM-2PM on Oak Ave from 1st St to 2nd St (Side: West)',
    );
    expect(result?.startTime).toBe('12:00');
    expect(result?.endTime).toBe('14:00');
  });

  it('handles 12AM (midnight) correctly', () => {
    const result = parseSweepNYCSign(
      'No Parking Monday 12AM-1AM on Oak Ave from 1st St to 2nd St (Side: East)',
    );
    expect(result?.startTime).toBe('00:00');
    expect(result?.endTime).toBe('01:00');
  });

  it('exports a stable PARSER_VERSION string', () => {
    expect(typeof PARSER_VERSION).toBe('string');
    expect(PARSER_VERSION.length).toBeGreaterThan(0);
  });
});

// ─── computeSafeUntil ─────────────────────────────────────────────────────────

describe('computeSafeUntil — West side of Melville St', () => {
  it('parked Monday 7:00 AM → safe until Monday 8:30 AM', () => {
    const now = dateAt('Mon', 7, 0);
    const result = computeSafeUntil(MELVILLE_SCHEDULES, 'West', NO_SUSPENSIONS, now);
    expect(result.activeNow).toBe(false);
    expect(result.nextDay).toBe('Monday');
    expect(result.nextTime).toBe('8:30 AM');
    expect(result.safeUntil).not.toBeNull();
    expect(result.safeUntil!.getHours()).toBe(8);
    expect(result.safeUntil!.getMinutes()).toBe(30);
  });

  it('parked during active cleaning (Monday 9:00 AM) → activeNow', () => {
    const now = dateAt('Mon', 9, 0);
    const result = computeSafeUntil(MELVILLE_SCHEDULES, 'West', NO_SUSPENSIONS, now);
    expect(result.activeNow).toBe(true);
    expect(result.safeUntil!.getHours()).toBe(10);
  });

  it('parked Monday 10:30 AM (after cleaning) → next is Thursday', () => {
    const now = dateAt('Mon', 10, 30);
    const result = computeSafeUntil(MELVILLE_SCHEDULES, 'West', NO_SUSPENSIONS, now);
    expect(result.activeNow).toBe(false);
    expect(result.nextDay).toBe('Thursday');
  });

  it('Monday cleaning suspended → skips to Thursday', () => {
    const now = dateAt('Mon', 7, 0);
    const monday = toNYCDateKey(now);
    const suspensions: SuspensionDoc[] = [{
      id: 'test-susp',
      cityId: 'nyc',
      date: monday,
      type: 'holiday',
      label: 'Test Holiday',
      affectsTypes: ['streetCleaning'],
      source: 'admin',
    }];
    const result = computeSafeUntil(MELVILLE_SCHEDULES, 'West', suspensions, now);
    expect(result.activeNow).toBe(false);
    expect(result.nextDay).toBe('Thursday');
  });

  it('includes a schedule description', () => {
    const now = dateAt('Mon', 7, 0);
    const result = computeSafeUntil(MELVILLE_SCHEDULES, 'West', NO_SUSPENSIONS, now);
    expect(result.scheduleDescription).toContain('Mon');
    expect(result.scheduleDescription).toContain('Thu');
    expect(result.scheduleDescription).toContain('8:30 AM');
  });
});

describe('computeSafeUntil — East side of Melville St', () => {
  it('Monday 7 AM → East side has no Mon/Thu cleaning → next is Tuesday', () => {
    const now = dateAt('Mon', 7, 0);
    const result = computeSafeUntil(MELVILLE_SCHEDULES, 'East', NO_SUSPENSIONS, now);
    expect(result.activeNow).toBe(false);
    expect(result.nextDay).toBe('Tuesday');
  });
});

describe('computeSafeUntil — no rules for this side', () => {
  it('returns null result when no schedules match the parking side', () => {
    const now = dateAt('Mon', 7, 0);
    const result = computeSafeUntil(MELVILLE_SCHEDULES, 'North', NO_SUSPENSIONS, now);
    expect(result.scheduleDescription).toBeNull();
    expect(result.safeUntil).toBeNull();
    expect(result.activeNow).toBe(false);
  });
});

describe('computeSafeUntil — simple block, one side', () => {
  const SIMPLE: CleaningSchedule[] = [
    { side: 'even', days: ['Wed'], startTime: '11:00', endTime: '12:30' },
  ];

  it('Wednesday 10:00 AM → safe until 11:00 AM', () => {
    const now = dateAt('Wed', 10, 0);
    const result = computeSafeUntil(SIMPLE, 'even', NO_SUSPENSIONS, now);
    expect(result.nextDay).toBe('Wednesday');
    expect(result.nextTime).toBe('11 AM');
  });

  it('Wednesday 11:30 AM → activeNow', () => {
    const now = dateAt('Wed', 11, 30);
    const result = computeSafeUntil(SIMPLE, 'even', NO_SUSPENSIONS, now);
    expect(result.activeNow).toBe(true);
  });

  it('odd side → no applicable schedules', () => {
    const now = dateAt('Wed', 10, 0);
    const result = computeSafeUntil(SIMPLE, 'odd', NO_SUSPENSIONS, now);
    expect(result.scheduleDescription).toBeNull();
  });
});

// ─── detectParkingSide ────────────────────────────────────────────────────────

describe('detectParkingSide — N-S street, even on East side', () => {
  // Segment runs South→North (bearing ~0°, normalized)
  // from = south end, to = north end
  // User east of the segment → negative cross (right of northward vector) → East
  // Even houses on East → evenSideIsPositiveCross = false
  const fromLat = 40.840, fromLng = -73.870;
  const toLat   = 40.845, toLng  = -73.870;

  it('user to the East → even side', () => {
    const side = detectParkingSide(
      40.8425, -73.869,  // slightly east
      fromLat, fromLng, toLat, toLng,
      false, // even = negative cross (East)
    );
    expect(side).toBe('even');
  });

  it('user to the West → odd side', () => {
    const side = detectParkingSide(
      40.8425, -73.871,  // slightly west
      fromLat, fromLng, toLat, toLng,
      false,
    );
    expect(side).toBe('odd');
  });
});

// ─── detectCardinalSide ───────────────────────────────────────────────────────

describe('detectCardinalSide — E-W street (bearing ~90°)', () => {
  // Segment runs West→East
  const fromLat = 40.842, fromLng = -73.872;
  const toLat   = 40.842, toLng  = -73.866;
  const bearing = 90;

  it('user north of street → North', () => {
    expect(detectCardinalSide(40.843, -73.869, fromLat, fromLng, toLat, toLng, bearing)).toBe('North');
  });

  it('user south of street → South', () => {
    expect(detectCardinalSide(40.841, -73.869, fromLat, fromLng, toLat, toLng, bearing)).toBe('South');
  });
});

describe('detectCardinalSide — N-S street (bearing ~0°)', () => {
  // Segment runs South→North
  const fromLat = 40.840, fromLng = -73.870;
  const toLat   = 40.845, toLng  = -73.870;
  const bearing = 0;

  it('user west of street → West', () => {
    expect(detectCardinalSide(40.8425, -73.871, fromLat, fromLng, toLat, toLng, bearing)).toBe('West');
  });

  it('user east of street → East', () => {
    expect(detectCardinalSide(40.8425, -73.869, fromLat, fromLng, toLat, toLng, bearing)).toBe('East');
  });
});

describe('detectCardinalSide — diagonal street (bearing ~135°)', () => {
  // Segment runs NW→SE (bearing 135°)
  const fromLat = 40.845, fromLng = -73.874;
  const toLat   = 40.840, toLng  = -73.867;
  const bearing = 135;

  it('user northeast of segment → East', () => {
    expect(detectCardinalSide(40.844, -73.868, fromLat, fromLng, toLat, toLng, bearing)).toBe('East');
  });

  it('user southwest of segment → West', () => {
    expect(detectCardinalSide(40.841, -73.873, fromLat, fromLng, toLat, toLng, bearing)).toBe('West');
  });
});

// ─── backfill — computeSegmentUpdate ─────────────────────────────────────────

import { computeSegmentUpdate, computeRuleUpdate } from './backfill';

describe('computeSegmentUpdate', () => {
  it('fills all missing fields on an old admin segment', () => {
    const update = computeSegmentUpdate({ streetName: 'Oak Ave', cslSegmentId: null });
    expect(update.status).toBe('active');
    expect(update.source).toBe('admin');
    expect(update.confidenceScore).toBe(1.0);
    expect(update.editedBy).toBe('migration:backfill');
    expect(update.provenance).toEqual({ provider: 'admin', importedBy: 'migration:backfill' });
  });

  it('fills missing fields on a sweepnyc segment detected via cslSegmentId', () => {
    const update = computeSegmentUpdate({ streetName: 'Melville St', cslSegmentId: '98053' });
    expect(update.source).toBe('sweepnyc');
    expect(update.confidenceScore).toBe(0.95);
    expect(update.provenance).toEqual({
      provider: 'sweepnyc',
      sweepNYCObjectId: 98053,
      importedBy: 'migration:backfill',
    });
  });

  it('fills missing fields on a sweepnyc segment detected via source field', () => {
    const update = computeSegmentUpdate({ source: 'sweepnyc', cslSegmentId: null });
    expect(update.source).toBeUndefined();  // already set — must not overwrite
    expect(update.confidenceScore).toBe(0.95);
    expect(update.provenance?.provider).toBe('sweepnyc');
    expect(update.provenance?.sweepNYCObjectId).toBeUndefined(); // no cslSegmentId to recover from
  });

  it('does not overwrite any existing valid field', () => {
    const update = computeSegmentUpdate({
      status: 'needs_review',
      source: 'sweepnyc',
      confidenceScore: 0.95,
      provenance: { provider: 'sweepnyc', sweepNYCObjectId: 99 },
      editedBy: 'system:sweepnyc',
    });
    expect(Object.keys(update)).toHaveLength(0);
  });

  it('is idempotent — second call on already-backfilled doc returns empty update', () => {
    const data = { streetName: 'Broadway', cslSegmentId: null };
    const first = computeSegmentUpdate(data);
    // Apply the first update to the data
    const afterFirst = { ...data, ...first };
    const second = computeSegmentUpdate(afterFirst);
    expect(Object.keys(second)).toHaveLength(0);
  });
});

describe('computeRuleUpdate', () => {
  it('sets admin provenance when parent is admin', () => {
    const update = computeRuleUpdate({ type: 'streetCleaning', source: 'admin' }, false);
    expect(update.provenance).toEqual({ provider: 'admin', importedBy: 'migration:backfill' });
    expect(update.editedBy).toBe('migration:backfill');
  });

  it('sets sweepnyc provenance when parent is sweepnyc', () => {
    const update = computeRuleUpdate({ type: 'streetCleaning', source: 'sweepnyc' }, true);
    expect(update.provenance?.provider).toBe('sweepnyc');
  });

  it('rule source field takes precedence over parent classification', () => {
    // Rule says admin even though parent is sweepnyc
    const update = computeRuleUpdate({ type: 'streetCleaning', source: 'admin' }, true);
    expect(update.provenance?.provider).toBe('admin');
  });

  it('does not overwrite existing provenance or editedBy', () => {
    const update = computeRuleUpdate({
      provenance: { provider: 'admin', importedBy: 'admin:abc' },
      editedBy: 'admin:abc',
    }, false);
    expect(Object.keys(update)).toHaveLength(0);
  });
});

// ─── computeCrossRaw ──────────────────────────────────────────────────────────

describe('computeCrossRaw', () => {
  it('point to the left of a northward vector → positive', () => {
    // from=(0,0) to=(1,0) pointing North; point at (-1, 0.5) is West = left
    const cross = computeCrossRaw(0.5, -1, 0, 0, 1, 0);
    expect(cross).toBeGreaterThan(0);
  });

  it('point to the right of a northward vector → negative', () => {
    const cross = computeCrossRaw(0.5, 1, 0, 0, 1, 0);
    expect(cross).toBeLessThan(0);
  });

  it('point exactly on the line → zero', () => {
    const cross = computeCrossRaw(0.5, 0, 0, 0, 1, 0);
    expect(cross).toBe(0);
  });
});

// ─── toNYCDateKey — NYC ASP suspension date correctness ────────────────────────
//
// SuspensionDoc.date is a NYC civil-calendar date ("YYYY-MM-DD"). These tests
// pin instants using explicit UTC offsets (e.g. "-04:00") so behavior does not
// depend on the machine/CI running these tests.

describe('toNYCDateKey', () => {
  it('NYC evening (8:01 PM EDT) does not prematurely advance to the next day', () => {
    // UTC instant is already 00:01 the next day — the bug this PR fixes.
    expect(toNYCDateKey(new Date('2026-08-27T20:01:00-04:00'))).toBe('2026-08-27');
  });

  it('NYC 7:59 PM EDT (before the UTC rollover) is unaffected either way', () => {
    expect(toNYCDateKey(new Date('2026-08-27T19:59:00-04:00'))).toBe('2026-08-27');
  });

  it('NYC midnight (EDT) advances exactly once', () => {
    expect(toNYCDateKey(new Date('2026-08-27T23:59:00-04:00'))).toBe('2026-08-27');
    expect(toNYCDateKey(new Date('2026-08-28T00:00:00-04:00'))).toBe('2026-08-28');
  });

  it('a midnight cleaning window becomes the next SAFE UNTIL after 11:50 PM', () => {
    const overnight = [{ side: 'West', days: ['Fri'], startTime: '00:00', endTime: '01:00' }];
    const result = computeSafeUntil(overnight, 'West', [], new Date('2026-08-27T23:50:00-04:00'));
    expect(result.activeNow).toBe(false);
    expect(result.nextTime).toBe('12 AM');
  });

  it('winter EST boundary: the UTC rollover happens an hour earlier (7 PM, not 8 PM) but the NYC date is still correct', () => {
    // 7:01 PM EST → UTC is already 00:01 the next day.
    expect(toNYCDateKey(new Date('2026-01-15T19:01:00-05:00'))).toBe('2026-01-15');
    expect(toNYCDateKey(new Date('2026-01-15T18:59:00-05:00'))).toBe('2026-01-15');
  });

  it('summer EDT boundary is correct (rollover at 8 PM, not 7 PM)', () => {
    expect(toNYCDateKey(new Date('2026-08-27T20:01:00-04:00'))).toBe('2026-08-27');
    expect(toNYCDateKey(new Date('2026-08-27T19:01:00-04:00'))).toBe('2026-08-27');
  });

  it('the same absolute instant yields the same NYC date under any device/runtime timezone', () => {
    const instant = new Date('2026-08-27T20:01:00-04:00');
    const originalTZ = process.env.TZ;
    try {
      const results = ['America/New_York', 'America/Los_Angeles', 'UTC', 'Asia/Tokyo'].map(tz => {
        process.env.TZ = tz;
        return toNYCDateKey(instant);
      });
      expect(new Set(results).size).toBe(1);
      expect(results[0]).toBe('2026-08-27');
    } finally {
      process.env.TZ = originalTZ;
    }
  });

  it('spring-forward DST transition (2026-03-08): calendar identity is preserved across the jump', () => {
    expect(toNYCDateKey(new Date('2026-03-07T23:59:00-05:00'))).toBe('2026-03-07'); // still EST
    expect(toNYCDateKey(new Date('2026-03-08T00:00:00-05:00'))).toBe('2026-03-08'); // still EST, pre-2am jump
    expect(toNYCDateKey(new Date('2026-03-08T12:00:00-04:00'))).toBe('2026-03-08'); // now EDT, same civil day
  });

  it('fall-back DST transition (2026-11-01): calendar identity is preserved across the jump', () => {
    expect(toNYCDateKey(new Date('2026-10-31T23:59:00-04:00'))).toBe('2026-10-31'); // still EDT
    expect(toNYCDateKey(new Date('2026-11-01T00:00:00-04:00'))).toBe('2026-11-01'); // still EDT, pre-2am jump
    expect(toNYCDateKey(new Date('2026-11-01T12:00:00-05:00'))).toBe('2026-11-01'); // now EST, same civil day
  });
});

// ─── computeSafeUntil — NYC suspension-check integration (device pinned to NYC) ─
//
// The schedule/day-of-week matching inside computeSafeUntil reads device-local
// time (a separate, pre-existing, out-of-scope behavior — see PR notes); the
// file-level America/New_York pin above makes that assumption hold true here.

describe('computeSafeUntil — suspension check uses the NYC date, not UTC (device pinned to America/New_York)', () => {
  it('active-now check: an evening cleaning window on a suspended NYC day is correctly recognized as suspended', () => {
    const now = new Date('2026-08-27T20:15:00-04:00'); // Thu 8:15 PM EDT — UTC date has already rolled to Aug 28
    const nycWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(now);
    const eveningSchedule: CleaningSchedule[] = [{ side: 'West', days: [nycWeekday], startTime: '20:00', endTime: '21:00' }];
    const suspensions: SuspensionDoc[] = [{
      id: 'evening-susp', cityId: 'nyc', date: toNYCDateKey(now), type: 'holiday',
      label: 'Test', affectsTypes: ['streetCleaning'], source: 'admin',
    }];
    const result = computeSafeUntil(eveningSchedule, 'West', suspensions, now);
    expect(result.activeNow).toBe(false);
  });

  it('active-now check: without the suspension, the same evening window IS active (control)', () => {
    const now = new Date('2026-08-27T20:15:00-04:00');
    const nycWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(now);
    const eveningSchedule: CleaningSchedule[] = [{ side: 'West', days: [nycWeekday], startTime: '20:00', endTime: '21:00' }];
    const result = computeSafeUntil(eveningSchedule, 'West', NO_SUSPENSIONS, now);
    expect(result.activeNow).toBe(true);
  });

  it('+14-day forward search skips a suspended upcoming day keyed by its correct NYC date', () => {
    const now = dateAt('Thu', 23, 30); // late evening — UTC date may already be the next day
    const followingMonday = new Date(now);
    followingMonday.setDate(now.getDate() + 4); // Thu + 4 = Mon
    const suspensions: SuspensionDoc[] = [{
      id: 'next-monday-susp', cityId: 'nyc', date: toNYCDateKey(followingMonday), type: 'holiday',
      label: 'Test', affectsTypes: ['streetCleaning'], source: 'admin',
    }];
    const result = computeSafeUntil(MELVILLE_SCHEDULES, 'West', suspensions, now);
    // Without the suspension, next window is Monday 8:30 AM; suspended → skips to Thursday.
    expect(result.nextDay).toBe('Thursday');
  });

  it('+14-day forward search: without the suspension, the same scenario resolves to Monday (control)', () => {
    const now = dateAt('Thu', 23, 30);
    const result = computeSafeUntil(MELVILLE_SCHEDULES, 'West', NO_SUSPENSIONS, now);
    expect(result.nextDay).toBe('Monday');
  });

  it('archived suspension is still ignored regardless of NYC date correctness', () => {
    const now = dateAt('Mon', 7, 0);
    const suspensions: SuspensionDoc[] = [{
      id: 'archived-susp', cityId: 'nyc', date: toNYCDateKey(now), type: 'holiday',
      label: 'Test', affectsTypes: ['streetCleaning'], source: 'admin', status: 'archived',
    }];
    // computeSafeUntil itself doesn't filter archived status (StreetIntelligenceCard does,
    // before calling computeSafeUntil) — this pins that computeSafeUntil's own contract is
    // unchanged: it trusts whatever suspensions array it's given.
    const result = computeSafeUntil(MELVILLE_SCHEDULES, 'West', suspensions, now);
    expect(result.nextDay).toBe('Thursday');
  });

  it('affectsTypes filtering is unchanged: a suspension for a different rule type does not suppress streetCleaning', () => {
    const now = dateAt('Mon', 9, 0); // inside the 8:30–10:00 active window
    const suspensions: SuspensionDoc[] = [{
      id: 'other-type-susp', cityId: 'nyc', date: toNYCDateKey(now), type: 'holiday',
      label: 'Test', affectsTypes: ['someOtherRuleType'], source: 'admin',
    }];
    const result = computeSafeUntil(MELVILLE_SCHEDULES, 'West', suspensions, now);
    expect(result.activeNow).toBe(true);
  });

  it('ordinary non-suspension safe-until behavior is unchanged', () => {
    const now = dateAt('Mon', 10, 30);
    const result = computeSafeUntil(MELVILLE_SCHEDULES, 'West', NO_SUSPENSIONS, now);
    expect(result.activeNow).toBe(false);
    expect(result.nextDay).toBe('Thursday');
  });
});

// ─── computeSafeUntil — NYC clock correctness (device-timezone independence) ───
//
// computeSafeUntil must evaluate parking-rule day-of-week and wall-clock time
// against NYC's own civil clock, not whatever timezone the device/runtime
// happens to be in. These tests drive process.env.TZ through several real
// zones for the SAME absolute instant and assert identical results — bypassing
// the file-level America/New_York pin above on purpose, since that pin is
// exactly the assumption these tests must not silently rely on.

describe('computeSafeUntil — device-timezone independence (NYC clock)', () => {
  function withTZ<T>(tz: string, fn: () => T): T {
    const prior = process.env.TZ;
    process.env.TZ = tz;
    try {
      return fn();
    } finally {
      process.env.TZ = prior;
    }
  }

  // Thursday, 2026-08-27, 9:00 AM America/New_York (EDT) — inside Melville
  // West's Thu 8:30–10:00 window. In UTC this is 13:00, which is late evening
  // in Tokyo (22:00) and morning in Los Angeles (06:00) — device-local
  // getDay()/getHours() would disagree on which weekday and time this is.
  const ACTIVE_INSTANT = new Date('2026-08-27T09:00:00-04:00');

  it('activeNow is true under America/New_York for the reference instant', () => {
    const result = withTZ('America/New_York', () =>
      computeSafeUntil(MELVILLE_SCHEDULES, 'West', NO_SUSPENSIONS, ACTIVE_INSTANT));
    expect(result.activeNow).toBe(true);
  });

  it('the same absolute instant yields activeNow=true under UTC, America/Los_Angeles, and Asia/Tokyo too', () => {
    const tzs = ['America/New_York', 'UTC', 'America/Los_Angeles', 'Asia/Tokyo'];
    const results = tzs.map(tz => withTZ(tz, () =>
      computeSafeUntil(MELVILLE_SCHEDULES, 'West', NO_SUSPENSIONS, ACTIVE_INSTANT).activeNow));
    expect(results).toEqual([true, true, true, true]);
  });

  it('the same absolute instant yields an identical safeUntil instant under every device timezone', () => {
    const tzs = ['America/New_York', 'UTC', 'America/Los_Angeles', 'Asia/Tokyo'];
    const times = tzs.map(tz => withTZ(tz, () =>
      computeSafeUntil(MELVILLE_SCHEDULES, 'West', NO_SUSPENSIONS, ACTIVE_INSTANT).safeUntil?.getTime()));
    expect(new Set(times).size).toBe(1);
  });

  // A late-Sunday-evening NYC instant whose UTC/device-local calendar date and
  // weekday have already rolled over to Monday under a UTC-ahead device zone.
  const LATE_SUNDAY_NYC = new Date('2026-08-30T23:30:00-04:00'); // Sun 11:30 PM EDT

  it('forward search finds the same next-day/time under NYC and under a UTC-ahead device timezone', () => {
    const nyResult = withTZ('America/New_York', () =>
      computeSafeUntil(MELVILLE_SCHEDULES, 'West', NO_SUSPENSIONS, LATE_SUNDAY_NYC));
    const tokyoResult = withTZ('Asia/Tokyo', () =>
      computeSafeUntil(MELVILLE_SCHEDULES, 'West', NO_SUSPENSIONS, LATE_SUNDAY_NYC));
    expect(nyResult.nextDay).toBe('Monday');
    expect(tokyoResult.nextDay).toBe(nyResult.nextDay);
    expect(tokyoResult.safeUntil?.getTime()).toBe(nyResult.safeUntil?.getTime());
  });

  it('safeUntil is the correct absolute instant for an EDT-side target day (8:30 AM NYC = 12:30 UTC)', () => {
    const result = withTZ('America/New_York', () =>
      computeSafeUntil(MELVILLE_SCHEDULES, 'West', NO_SUSPENSIONS, new Date('2026-08-24T07:00:00-04:00'))); // Mon Aug 24 2026, 7 AM EDT
    expect(result.safeUntil?.toISOString()).toBe('2026-08-24T12:30:00.000Z');
  });

  it('safeUntil is the correct absolute instant for an EST-side target day (8:30 AM NYC = 13:30 UTC)', () => {
    const result = withTZ('America/New_York', () =>
      computeSafeUntil(MELVILLE_SCHEDULES, 'West', NO_SUSPENSIONS, new Date('2026-01-19T07:00:00-05:00'))); // Mon Jan 19 2026, 7 AM EST
    expect(result.safeUntil?.toISOString()).toBe('2026-01-19T13:30:00.000Z');
  });

  it('a 14-civil-day forward search spanning a DST transition still lands on the correct calendar day', () => {
    const beforeSpringForward = new Date('2026-03-01T07:00:00-05:00'); // Sun, one week before transition — stays in EST throughout
    const result = withTZ('America/New_York', () =>
      computeSafeUntil(MELVILLE_SCHEDULES, 'West', NO_SUSPENSIONS, beforeSpringForward));
    // Next Mon/Thu window after Mar 1 (Sun) is Monday Mar 2 — still pre-DST (EST).
    expect(result.nextDay).toBe('Monday');
    expect(result.safeUntil?.toISOString()).toBe('2026-03-02T13:30:00.000Z'); // 8:30 AM EST = 13:30 UTC

    // Now start the search from just before the transition weekend (a
    // non-schedule day), so the search must cross March 8 (spring-forward)
    // to reach the next Mon/Thu window.
    const spanningTransition = new Date('2026-03-06T07:00:00-05:00'); // Fri, before transition, no schedule that day
    const spanResult = withTZ('America/New_York', () =>
      computeSafeUntil(MELVILLE_SCHEDULES, 'West', NO_SUSPENSIONS, spanningTransition));
    // Next window after Fri Mar 6 is Monday Mar 9 — AFTER the Mar 8 transition (now EDT).
    expect(spanResult.nextDay).toBe('Monday');
    expect(spanResult.safeUntil?.toISOString()).toBe('2026-03-09T12:30:00.000Z'); // 8:30 AM EDT = 12:30 UTC
  });

  it('suspension-date matching (#84) is unaffected by this change', () => {
    const now = new Date('2026-08-27T20:15:00-04:00'); // Thu 8:15 PM EDT — UTC date already rolled to Aug 28
    const eveningSchedule: CleaningSchedule[] = [{ side: 'West', days: ['Thu'], startTime: '20:00', endTime: '21:00' }];
    const suspensions: SuspensionDoc[] = [{
      id: 'evening-susp', cityId: 'nyc', date: toNYCDateKey(now), type: 'holiday',
      label: 'Test', affectsTypes: ['streetCleaning'], source: 'admin',
    }];
    const result = withTZ('Asia/Tokyo', () => computeSafeUntil(eveningSchedule, 'West', suspensions, now));
    expect(result.activeNow).toBe(false);
  });

  it('no-schedule-for-side and empty-schedule behavior are unaffected', () => {
    const result = withTZ('Asia/Tokyo', () =>
      computeSafeUntil(MELVILLE_SCHEDULES, 'North', NO_SUSPENSIONS, ACTIVE_INSTANT));
    expect(result.scheduleDescription).toBeNull();
    expect(result.activeNow).toBe(false);
  });

  it('scheduleDescription formatting is unaffected by device timezone', () => {
    const tzs = ['America/New_York', 'UTC', 'Asia/Tokyo'];
    const descriptions = tzs.map(tz => withTZ(tz, () =>
      computeSafeUntil(MELVILLE_SCHEDULES, 'West', NO_SUSPENSIONS, ACTIVE_INSTANT).scheduleDescription));
    expect(new Set(descriptions).size).toBe(1);
    expect(descriptions[0]).toContain('Mon & Thu');
  });
});
