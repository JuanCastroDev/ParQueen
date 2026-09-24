'use strict';

const { readFileSync } = require('fs');
const { join } = require('path');
const { parseNYCOpenDataSign, parseNYCODDays } = require('./nycOpenDataNormalizer');
const { parseSweepNYCDayList, CANONICAL_WEEKDAYS } = require('./streetIntelDays');

const INDEX_SRC = readFileSync(join(__dirname, 'index.js'), 'utf8');
const CTX = { street: 'TEST STREET', fromCross: 'A AVE', toCross: 'B AVE', side: 'West', borough: 'Manhattan' };
const WEEK = CANONICAL_WEEKDAYS.slice();

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

describe('daily-token SweepNYC parser', () => {
  it('still parses a classic weekday window, including 30 minutes', () => {
    const r = parseSweep('No Parking Tuesday 8:30AM-9AM on Test Street (Side: West)', CTX);
    expect(r).not.toBeNull();
    expect(r.days).toEqual(['Tue']);
    expect(r.startTime).toBe('08:30');
    expect(r.endTime).toBe('09:00');
  });

  it('normalizes Daily / Everyday / Every day / All days to the full week', () => {
    expect(parseSweep('No Parking Daily 8AM-9AM on Test Street (Side: West)', CTX).days).toEqual(WEEK);
    expect(parseSweep('No Parking Everyday 8AM-9AM on Test Street (Side: West)', CTX).days).toEqual(WEEK);
    expect(parseSweep('No Parking Every day 8AM-9AM on Test Street (Side: West)', CTX).days).toEqual(WEEK);
    expect(parseSweep('No Parking All days 8AM-9AM on Test Street (Side: West)', CTX).days).toEqual(WEEK);
  });
});

describe('daily-token NYC Open Data parser', () => {
  it('accepts DAILY, ALL DAYS, EVERYDAY, and EVERY DAY', () => {
    expect(parseNYCODDays('DAILY')).toEqual(WEEK);
    expect(parseNYCODDays('ALL DAYS')).toEqual(WEEK);
    expect(parseNYCODDays('EVERYDAY')).toEqual(WEEK);
    expect(parseNYCODDays('EVERY DAY')).toEqual(WEEK);
    const daily = nyc('NO PARKING DAILY 8:30AM-9AM <->');
    expect(daily.days).toEqual(WEEK);
    expect(daily.startTime).toBe('08:30');
    expect(daily.endTime).toBe('09:00');
  });
});
