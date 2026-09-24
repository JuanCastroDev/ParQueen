'use strict';

const { readFileSync } = require('fs');
const { join } = require('path');
const { parseNYCOpenDataSign, parseNYCODDays } = require('./nycOpenDataNormalizer');

const INDEX_SRC = readFileSync(join(__dirname, 'index.js'), 'utf8');
const CTX = { street: 'TEST STREET', fromCross: 'A AVE', toCross: 'B AVE', side: 'West', borough: 'Manhattan' };

function loadSweepParser() {
  const start = INDEX_SRC.indexOf('const _DAY_ABBR');
  const end = INDEX_SRC.indexOf('function _computeBearing');
  const fn = new Function(`${INDEX_SRC.slice(start, end)}\nreturn _parseSweepNYCSign;`);
  return fn();
}

const parseSweep = loadSweepParser();
const nyc = (text) => parseNYCOpenDataSign(text, CTX);

describe('daily-token diagnostic — SweepNYC parser (unchanged)', () => {
  it('still parses a classic weekday window, including 30 minutes', () => {
    const r = parseSweep('No Parking Tuesday 8:30AM-9AM on Test Street (Side: West)', CTX);
    expect(r).not.toBeNull();
    expect(r.days).toEqual(['Tue']);
    expect(r.startTime).toBe('08:30');
    expect(r.endTime).toBe('09:00');
  });

  it('rejects Daily and Everyday; Every day / All days currently collapse to leftover 3-letter tokens', () => {
    expect(parseSweep('No Parking Daily 8AM-9AM on Test Street (Side: West)', CTX)).toBeNull();
    expect(parseSweep('No Parking Everyday 8AM-9AM on Test Street (Side: West)', CTX)).toBeNull();
    // Current SweepNYC day tokenizer keeps any leftover token of length <= 3.
    // Do not broaden the parser in this phase.
    expect(parseSweep('No Parking Every day 8AM-9AM on Test Street (Side: West)', CTX).days).toEqual(['Day']);
    expect(parseSweep('No Parking All days 8AM-9AM on Test Street (Side: West)', CTX).days).toEqual(['All']);
  });
});

describe('daily-token diagnostic — NYC Open Data parser (unchanged)', () => {
  it('accepts DAILY and ALL DAYS, including a 30-minute window', () => {
    expect(parseNYCODDays('DAILY')).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(parseNYCODDays('ALL DAYS')).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    const daily = nyc('NO PARKING DAILY 8:30AM-9AM <->');
    expect(daily.days).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    expect(daily.startTime).toBe('08:30');
    expect(daily.endTime).toBe('09:00');
    expect(nyc('NO PARKING 7AM-7PM ALL DAYS <-> (SUPERSEDES SP-130C)').days)
      .toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  });

  it('rejects Everyday / Every day / Daily-as-SweepNYC-wording is not ALL DAYS', () => {
    expect(parseNYCODDays('EVERYDAY')).toEqual([]);
    expect(parseNYCODDays('EVERY DAY')).toEqual([]);
    expect(nyc('NO PARKING EVERYDAY 8AM-9AM <->')).toBeNull();
    expect(nyc('NO PARKING EVERY DAY 8AM-9AM <->')).toBeNull();
  });
});
