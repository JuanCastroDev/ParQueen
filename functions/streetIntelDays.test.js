'use strict';

const { readFileSync } = require('fs');
const { join } = require('path');
const {
  CANONICAL_WEEKDAYS,
  expandDailyDays,
  parseSweepNYCDayList,
  isCanonicalFullWeek,
  formatDaysLabel,
} = require('./streetIntelDays');
const { parseNYCOpenDataSign, parseNYCODDays } = require('./nycOpenDataNormalizer');
const { hasUsableSchedules } = require('./streetIntelRefresh');
const {
  publicProductSchedules,
  decideSweepSidePresentation,
  applySweepSideToProductionResult,
} = require('./curbIntelligence/productPathDecision');

const INDEX_SRC = readFileSync(join(__dirname, 'index.js'), 'utf8');
const CLIENT_SRC = readFileSync(join(__dirname, '..', 'views', 'StreetParkingView.tsx'), 'utf8');
const WEEK = CANONICAL_WEEKDAYS.slice();
const CTX = { street: 'TEST STREET', fromCross: 'A AVE', toCross: 'B AVE', side: 'West' };

function loadSweepParser() {
  const start = INDEX_SRC.indexOf('const _DAY_ABBR');
  const end = INDEX_SRC.indexOf('function _computeBearing');
  const fn = new Function(
    'parseSweepNYCDayList',
    'CANONICAL_WEEKDAYS',
    `${INDEX_SRC.slice(start, end)}\nreturn _parseSweepNYCSign;`,
  );
  return fn(parseSweepNYCDayList, CANONICAL_WEEKDAYS);
}

const parseSweep = loadSweepParser();
const nyc = (text) => parseNYCOpenDataSign(text, CTX);

describe('shared daily-token layer', () => {
  it.each(['DAILY', 'Everyday', 'every day', 'ALL DAYS', '7 days', 'seven days'])(
    'expands %s to the canonical week',
    (token) => {
      expect(expandDailyDays(token)).toEqual(WEEK);
    },
  );

  it('does not invent meanings for leftover weekday fragments', () => {
    expect(expandDailyDays('Day')).toBeNull();
    expect(expandDailyDays('All')).toBeNull();
    expect(parseSweepNYCDayList('Day')).toEqual([]);
    expect(parseSweepNYCDayList('All')).toEqual([]);
  });
});

describe('A-D SweepNYC daily cleaning signs', () => {
  it.each([
    ['A', 'No Parking Daily 8:30AM-9AM on Test Street (Side: West)'],
    ['B', 'No Parking Everyday 8:30AM-9AM on Test Street (Side: West)'],
    ['C', 'No Parking Every day 8:30AM-9AM on Test Street (Side: West)'],
    ['D', 'No Parking All days 8:30AM-9AM on Test Street (Side: West)'],
    ['time-then-daily', 'No Parking 8:30AM-9AM DAILY'],
    ['multiline', 'NO PARKING\n8:30AM-9AM\nEVERY DAY'],
  ])('%s parses to the full week', (_label, text) => {
    const result = parseSweep(text, CTX);
    expect(result).not.toBeNull();
    expect(result.days).toEqual(WEEK);
    expect(result.startTime).toBe('08:30');
    expect(result.endTime).toBe('09:00');
  });
});

describe('E-H NYC Open Data daily signs', () => {
  it('E. DAILY still expands', () => {
    expect(parseNYCODDays('DAILY')).toEqual(WEEK);
    expect(nyc('NO PARKING DAILY 8:30AM-9AM <->').days).toEqual(WEEK);
  });

  it('F. ALL DAYS still expands', () => {
    expect(parseNYCODDays('ALL DAYS')).toEqual(WEEK);
    expect(nyc('NO PARKING 7AM-7PM ALL DAYS <-> (SUPERSEDES SP-130C)').days).toEqual(WEEK);
  });

  it('G. EVERYDAY now expands', () => {
    expect(parseNYCODDays('EVERYDAY')).toEqual(WEEK);
    expect(nyc('NO PARKING EVERYDAY 8:30AM-9AM <->').days).toEqual(WEEK);
  });

  it('H. EVERY DAY now expands', () => {
    expect(parseNYCODDays('EVERY DAY')).toEqual(WEEK);
    expect(nyc('NO PARKING EVERY DAY 8:30AM-9AM <->').days).toEqual(WEEK);
  });

  it('still refuses unknown day tokens', () => {
    expect(parseNYCODDays('MONDAY FUNDAY')).toEqual([]);
    expect(nyc('NO PARKING MONDAY FUNDAY 8AM-9AM <->')).toBeNull();
  });
});

describe('I 30-minute windows', () => {
  it('parses SweepNYC and NYC Open Data half-hour windows', () => {
    expect(parseSweep('No Parking Tuesday 8:30AM-9:00AM on Test Street (Side: West)', CTX)).toMatchObject({
      days: ['Tue'], startTime: '08:30', endTime: '09:00',
    });
    expect(parseSweep('No Parking Tuesday 8:30AM-9AM on Test Street (Side: West)', CTX)).toMatchObject({
      startTime: '08:30', endTime: '09:00',
    });
    expect(parseSweep('No Parking Tuesday 9:00AM-9:30AM on Test Street (Side: West)', CTX)).toMatchObject({
      startTime: '09:00', endTime: '09:30',
    });
    expect(parseSweep('No Parking Tuesday 11:30PM-12:00AM on Test Street (Side: West)', CTX)).toMatchObject({
      startTime: '23:30', endTime: '00:00',
    });
    expect(nyc('NO PARKING TUESDAY 8:30AM-9:00AM <->')).toMatchObject({ startTime: '08:30', endTime: '09:00' });
    expect(nyc('NO PARKING TUESDAY 8:30AM-9AM <->')).toMatchObject({ startTime: '08:30', endTime: '09:00' });
    expect(nyc('NO PARKING TUESDAY 9:00AM-9:30AM <->')).toMatchObject({ startTime: '09:00', endTime: '09:30' });
    expect(nyc('NO PARKING TUESDAY 11:30PM-12:00AM <->')).toMatchObject({ startTime: '23:30', endTime: '00:00' });
  });
});

describe('N empty-rule refresh reaches the new parser', () => {
  it('empty refresh still parses after dedup miss, and a 7-day rule is usable', () => {
    const tryStart = INDEX_SRC.indexOf('async function _tryCreateFromSweepNYC');
    const parseCall = INDEX_SRC.indexOf('_parseSweepNYCSign(signText, streetCtx)', tryStart);
    const emptyRefreshWrite = INDEX_SRC.indexOf("stage: 'empty_rules_refresh'", tryStart);
    expect(INDEX_SRC).toContain('parseSweepNYCDayList(');
    expect(parseCall).toBeGreaterThan(tryStart);
    expect(emptyRefreshWrite).toBeGreaterThan(parseCall);
    expect(hasUsableSchedules([{
      type: 'streetCleaning',
      schedules: [{ days: WEEK, startTime: '08:30', endTime: '09:00', side: 'West' }],
    }])).toBe(true);
  });
});

describe('O-P Curb side resolution and manual fallback', () => {
  it('O. a daily schedule is still a usable product schedule and high-confidence side still overlays', () => {
    const schedules = publicProductSchedules([{
      schedules: [{ side: 'East', days: WEEK, startTime: '08:30', endTime: '09:00' }],
    }]);
    expect(schedules).toEqual([{ side: 'East', days: WEEK, startTime: '08:30', endTime: '09:00' }]);
    expect(decideSweepSidePresentation({
      outcome: 'COMPLETED', skipOrFailureClass: 'none', curbState: 'SUPPORTED', parkingSide: 'East',
    })).toEqual({ apply: true, caution: false, parkingSide: 'East', reason: 'usable' });
    expect(decideSweepSidePresentation({
      outcome: 'COMPLETED', skipOrFailureClass: 'none', curbState: 'CAUTION', parkingSide: 'East',
    }).apply).toBe(false);
    expect(decideSweepSidePresentation({
      outcome: 'COMPLETED', skipOrFailureClass: 'none', curbState: 'UNKNOWN', parkingSide: 'East',
    }).apply).toBe(false);
    expect(applySweepSideToProductionResult(
      { success: true, segmentId: 'nyc_1', parkingSide: 'West' },
      'East',
    ).sideConfidence).toBe('high');
  });

  it('P. client still keeps manual side confirmation when Curb side resolution is unavailable', () => {
    expect(CLIENT_SRC).toContain('keeping manual side confirmation:');
    expect(CLIENT_SRC).toContain("nearest.source === 'sweepnyc' && scheduleSides.length > 1");
  });
});

describe('Q ordinary weekday cases unchanged', () => {
  it('still parses Tue/Fri, Mon/Thu, and Except Sunday', () => {
    expect(parseSweep('No Parking Tuesday Friday 8:30AM-10AM on Test Street (Side: West)', CTX).days)
      .toEqual(['Tue', 'Fri']);
    expect(parseSweep('No Parking Monday Thursday 8:30AM-10AM on Test Street (Side: West)', CTX).days)
      .toEqual(['Mon', 'Thu']);
    expect(parseSweep(
      'No Parking 8:30AM-9AM Except Sunday on Maran Place from White Plains Road to Cruger Avenue (Side: South)',
      CTX,
    ).days).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  });

  it('labels a full week as Every day without listing seven tokens', () => {
    expect(formatDaysLabel(WEEK)).toBe('Every day');
    expect(isCanonicalFullWeek(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])).toBe(true);
    expect(formatDaysLabel(['Mon', 'Thu'])).toBe('Mon & Thu');
  });
});
