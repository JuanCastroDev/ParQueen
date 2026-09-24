import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const {
  parseNYCOpenDataSign, parseNYCODDays, parseNYCODClock, stripNYCODNoise,
} = require('./nycOpenDataNormalizer');

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(resolve(HERE, 'index.js'), 'utf-8');

const CTX = { street: 'BROOKLYN AVENUE', fromCross: 'ATLANTIC AVENUE', toCross: 'PACIFIC STREET', side: 'West' };
const p = t => parseNYCOpenDataSign(t, CTX);

/**
 * Fixtures are verbatim sign_description values sampled read-only from
 * nfid-uabd across all five boroughs (337 distinct ASP texts). _parseSweepNYCSign
 * rejected all of them: its regex ends with "[(Side: X)]$", and DOT text carries
 * trailing arrows and (SUPERSEDES ...) metadata, so the anchor never matched.
 */
describe('parseNYCOpenDataSign — the exact Bed-Stuy rows that failed in production', () => {
  // These two are the signs on ATLANTIC AVENUE|PACIFIC STREET|W, the face the
  // geometry selects, and the reason the fallback died at nyc_od_parse.
  const BEDSTUY = 'NO PARKING (SANITATION BROOM SYMBOL) MONDAY THURSDAY 8:30AM-10AM <-> (SUPERSEDES SP-369C)';

  it('parses the Bed-Stuy sign into the canonical shape', () => {
    const r = p(BEDSTUY);
    expect(r).not.toBeNull();
    expect(r.days).toEqual(['Mon', 'Thu']);
    expect(r.startTime).toBe('08:30');
    expect(r.endTime).toBe('10:00');
  });

  it('carries the block-face context through unchanged', () => {
    const r = p(BEDSTUY);
    expect(r.street).toBe('BROOKLYN AVENUE');
    expect(r.fromCross).toBe('ATLANTIC AVENUE');
    expect(r.toCross).toBe('PACIFIC STREET');
    expect(r.side).toBe('West');
  });

  it('preserves the raw text and stripped metadata as provenance', () => {
    const r = p(BEDSTUY);
    expect(r.provenance.rawText).toBe(BEDSTUY);
    expect(r.provenance.arrows).toContain('<->');
    expect(r.provenance.notes.join(' ')).toContain('SUPERSEDES SP-369C');
    expect(r.source).toBe('nyc_open_data');
  });
});

describe('day semantics — validated against the dataset, not English', () => {
  it('whitespace separates DISCRETE days, it is not a range', () => {
    // Forced by the 3- and 4-token rows, which cannot be ranges.
    expect(p('NO PARKING MONDAY THURSDAY 8:30AM-10AM <->').days).toEqual(['Mon', 'Thu']);
    expect(p('NO PARKING MONDAY WEDNESDAY FRIDAY 8AM-9AM <->').days).toEqual(['Mon', 'Wed', 'Fri']);
    expect(p('NO PARKING MONDAY TUESDAY THURSDAY FRIDAY 8AM-9AM <->').days)
      .toEqual(['Mon', 'Tue', 'Thu', 'Fri']);
  });

  it('a hyphen IS a range', () => {
    expect(p('NO PARKING MONDAY-FRIDAY 8AM-6PM <-> (SUPERSEDES R7-45R)').days)
      .toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
  });

  it('single-day signs parse', () => {
    expect(p('NO PARKING (SANITATION BROOM SYMBOL) MONDAY 9:30AM-11AM <-> (SUPERSEDES SP-453C)').days)
      .toEqual(['Mon']);
    expect(p('NO PARKING (SANITATION BROOM SYMBOL) FRIDAY 9:30AM-11AM --> (SUPERSEDES SP-400CA & SP-465CA)').days)
      .toEqual(['Fri']);
  });

  it('EXCEPT inverts the week', () => {
    expect(p('NO PARKING 8AM-1PM EXCEPT SUNDAY --> (SUPERSEDES SP-211CA)').days)
      .toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  });

  it('ALL DAYS is an explicit every-day marker', () => {
    expect(p('NO PARKING 7AM-7PM ALL DAYS <-> (SUPERSEDES SP-130C)').days)
      .toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  });

  it('abbreviations and & separators (legacy rows) parse', () => {
    expect(p('NO PARKING (SANITATION BROOM SYMBOL) 9:30-11AM TUES & FRI <-----> (SUPERSEDED BY SP-63C)').days)
      .toEqual(['Tue', 'Fri']);
  });

  it('HOLIDAYS is not treated as a weekday', () => {
    expect(p('NO PARKING SATURDAY SUNDAY & HOLIDAYS 7AM-7PM --> (SUPERSEDES SP-20CA)').days)
      .toEqual(['Sat', 'Sun']);
  });

  it('an unrecognised day token refuses the whole sign', () => {
    expect(parseNYCODDays('MONDAY FUNDAY')).toEqual([]);
    expect(p('NO PARKING MONDAY FUNDAY 8AM-9AM <->')).toBeNull();
  });
});

describe('time semantics', () => {
  it('whole hours and half hours', () => {
    expect(p('NO PARKING MONDAY 8AM-9AM <->').startTime).toBe('08:00');
    expect(p('NO PARKING MONDAY 8:30AM-10AM <->').endTime).toBe('10:00');
    expect(p('NO PARKING MONDAY 11:30AM-1PM <->').endTime).toBe('13:00');
  });

  it('a first time without a meridiem inherits the second (legacy shape)', () => {
    const r = p('NO PARKING (SANITATION BROOM SYMBOL) 9:30-11AM TUES & FRI <-----> (SUPERSEDED BY SP-63C)');
    expect(r.startTime).toBe('09:30');
    expect(r.endTime).toBe('11:00');
  });

  it('MIDNIGHT and NOON', () => {
    const a = p('NO PARKING (SANITATION BROOM SYMBOL) TUESDAY FRIDAY MIDNIGHT-3AM <-> (SUPERSEDES SP-841C)');
    expect(a.startTime).toBe('00:00');
    expect(a.endTime).toBe('03:00');
    const b = p('NO PARKING 8AM-MIDNIGHT EXCEPT SUNDAY <-> (SUPERSEDES R7-41R)');
    expect(b.endTime).toBe('00:00');
  });

  it('the word TO works as a range separator', () => {
    const r = p('NO PARKING (SANITATION BROOM SYMBOL) 11AM TO 12:30PM TUES & FRI');
    expect(r.startTime).toBe('11:00');
    expect(r.endTime).toBe('12:30');
  });

  it('PM conversion and the 12-hour edges', () => {
    expect(parseNYCODClock('12AM')).toBe(0);
    expect(parseNYCODClock('12PM')).toBe(720);
    expect(parseNYCODClock('1PM')).toBe(780);
  });

  it('never assumes a meridiem when none can be established', () => {
    expect(parseNYCODClock('9:30')).toBeNull();
    expect(p('NO PARKING MONDAY 9:30-11 <->')).toBeNull();
  });

  it('rejects impossible clock values', () => {
    expect(parseNYCODClock('13AM')).toBeNull();
    expect(parseNYCODClock('8:75AM')).toBeNull();
    expect(parseNYCODClock('')).toBeNull();
  });

  it('rejects a zero-length window rather than inventing one', () => {
    expect(p('NO PARKING MONDAY 8AM-8AM <->')).toBeNull();
  });
});

describe('metadata stripping and arrow semantics', () => {
  it('all arrow forms are removed from the schedule and kept as provenance', () => {
    for (const arrow of ['<->', '-->', '<--', '->', '<-', '<----->']) {
      const r = p(`NO PARKING MONDAY THURSDAY 8:30AM-10AM ${arrow} (SUPERSEDES SP-1C)`);
      expect(r, arrow).not.toBeNull();
      expect(r.days).toEqual(['Mon', 'Thu']);
      expect(r.provenance.arrows.join(' ')).toContain(arrow);
    }
  });

  it('arrows do not change the parsed schedule', () => {
    const a = p('NO PARKING MONDAY THURSDAY 8:30AM-10AM <-> (SUPERSEDES SP-1C)');
    const b = p('NO PARKING MONDAY THURSDAY 8:30AM-10AM --> (SUPERSEDES SP-1CA)');
    expect(a.days).toEqual(b.days);
    expect(a.startTime).toBe(b.startTime);
    expect(a.endTime).toBe(b.endTime);
  });

  it('W/SINGLE ARROW is recognised as directional metadata, not schedule text', () => {
    const r = p('NO PARKING (SANITATION BROOM SYMBOL) 9:30-11AM TUES & FRI W/SINGLE ARROW (SUPERSEDED BY SP-63CA)');
    expect(r).not.toBeNull();
    expect(r.days).toEqual(['Tue', 'Fri']);
    expect(r.provenance.arrows).toContain('W/SINGLE ARROW');
  });

  it('pictogram and administrative parentheticals are stripped but preserved', () => {
    const r = p('NO PARKING (SANITATION BROOM SYMBOL) MOON & STARS (SYMBOLS) TUESDAY FRIDAY MIDNIGHT-3AM <-> (SUPERSEDES SP-841C)');
    expect(r.days).toEqual(['Tue', 'Fri']);
    const notes = r.provenance.notes.join(' ');
    expect(notes).toContain('SANITATION BROOM SYMBOL');
    expect(notes).toContain('SUPERSEDES SP-841C');
  });

  it("(DON'T LITTER) does not derail the parse", () => {
    const r = p("NO PARKING (SANITATION BROOM SYMBOL) 8:30-10AM TUES <--> (DON'T LITTER)(SUPERSEDED BY PS-28B)");
    expect(r).not.toBeNull();
    expect(r.days).toEqual(['Tue']);
    expect(r.startTime).toBe('08:30');
  });

  it('stripNYCODNoise keeps the raw arrows and notes it removed', () => {
    const { text, provenance } = stripNYCODNoise('NO PARKING (SANITATION BROOM SYMBOL) MONDAY 8AM-9AM <-> (SUPERSEDES X)');
    expect(text).toBe('NO PARKING MONDAY 8AM-9AM');
    expect(provenance.arrows).toContain('<->');
    expect(provenance.notes.length).toBeGreaterThan(0);
  });

  it('tolerates case and whitespace variation', () => {
    const a = p('no parking (sanitation broom symbol) monday thursday 8:30am-10am <->');
    const b = p('NO   PARKING    MONDAY   THURSDAY   8:30AM - 10AM   <->');
    expect(a.days).toEqual(['Mon', 'Thu']);
    expect(b.days).toEqual(['Mon', 'Thu']);
    expect(b.startTime).toBe('08:30');
  });
});

describe('regulation safety — refuses rather than guesses', () => {
  it('malformed source text stays unparsed', () => {
    // Real corruption found in the dataset.
    expect(p('NO PARKING (SANITATION BROOM SYMBOL) TUESDAY FRIDAY 10A M-11:30AM --> (SUPERSEDES SP-847CA)')).toBeNull();
    expect(p('NO PARKING (SANITATION BROOM SYMBOL) MOON & STARS (SYMB OLS) MONDAY TUESDAY THURSDAY FRIDAY MIDNIGHT-3AM <->')).toBeNull();
  });

  it('a sign carrying two schedules is refused, not half-read', () => {
    expect(p('NO PARKING MONDAY-FRIDAY 7AM-4PM SATURDAY 7AM-7PM <->')).toBeNull();
  });

  it('non-ASP no-parking text is not read as a cleaning schedule', () => {
    expect(p('BUS STOP SIGN (BUS & HANDICAP SYMBOLS) NO STANDING W/ SINGLE ARROW')).toBeNull();
    expect(p('NO PARKING ANYTIME <->')).toBeNull();
    expect(p('14 STREET & UNION SQ (BOTTOM LOCATION PANEL)(USE AS EXAMPLE FOR DIFFERENT LOCATION)')).toBeNull();
  });

  it('empty and non-string input is refused', () => {
    expect(parseNYCOpenDataSign('', CTX)).toBeNull();
    expect(parseNYCOpenDataSign(null, CTX)).toBeNull();
    expect(parseNYCOpenDataSign(undefined, CTX)).toBeNull();
    expect(parseNYCOpenDataSign(42, CTX)).toBeNull();
  });

  it('a time range with no days at all is refused', () => {
    expect(p('NO PARKING 8AM-9AM <-> (SUPERSEDES SP-1C)')).toBeNull();
  });
});

describe('wiring and non-regression', () => {
  it('the NYC Open Data path uses the source-specific parser', () => {
    expect(INDEX_SRC).toMatch(/parseNYCOpenDataSign\(r\.sign_description, streetCtx\)/);
  });

  it('the SweepNYC primary path still uses its own parser, unchanged', () => {
    expect(INDEX_SRC).toMatch(/_parseSweepNYCSign\(signText, streetCtx\)/);
    expect(INDEX_SRC).toMatch(/function _parseSweepNYCSign\(signText, streetCtx\) \{/);
    expect(INDEX_SRC).toMatch(/parseSweepNYCDayList\(/);
    expect(INDEX_SRC).toContain('\\(Side:\\s*(\\w+)\\)');
  });

  it('unparsed signs are surfaced by count without logging their text', () => {
    expect(INDEX_SRC).toMatch(/unparsed sign count/);
    expect(INDEX_SRC).not.toMatch(/unparsed sign text/);
  });

  it('an empty parse still yields the existing failure behaviour', () => {
    expect(INDEX_SRC).toMatch(/if \(!parsed\.length\) \{[\s\S]{0,200}stage: 'nyc_od_parse'/);
  });
});
