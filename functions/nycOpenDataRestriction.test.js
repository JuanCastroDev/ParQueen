'use strict';

const {
  parseNYCOpenDataRestriction,
  classifyExtent,
  isCurrentUnvoidedRow,
} = require('./nycOpenDataRestriction');

describe('nfid-uabd restriction parser', () => {
  it('A. parses NO PARKING ANYTIME with double-arrow whole-face extent', () => {
    const parsed = parseNYCOpenDataRestriction('NO PARKING ANYTIME <-> (SUPERSEDES SP-854C)');
    expect(parsed).toMatchObject({ ok: true, kind: 'noParking', anytime: true, extent: 'whole_face' });
  });

  it('B. parses scheduled NO PARKING', () => {
    const parsed = parseNYCOpenDataRestriction('NO PARKING MONDAY 7AM-7PM <-> (SUPERSEDES SP-600C)');
    expect(parsed.ok).toBe(true);
    expect(parsed.windows[0]).toEqual({ startTime: '07:00', endTime: '19:00' });
    expect(parsed.days).toEqual(['Mon']);
  });

  it('C/D. parses NO STANDING anytime and scheduled Mon-Fri', () => {
    expect(parseNYCOpenDataRestriction('NO STANDING ANYTIME <->')).toMatchObject({
      ok: true, kind: 'noStanding', anytime: true, extent: 'whole_face',
    });
    const scheduled = parseNYCOpenDataRestriction('NO STANDING MON-FRI 4PM-7PM <->');
    expect(scheduled).toMatchObject({ ok: true, kind: 'noStanding', anytime: false, extent: 'whole_face' });
    expect(scheduled.days).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);
    expect(scheduled.windows[0]).toEqual({ startTime: '16:00', endTime: '19:00' });
  });

  it('E/F. parses NO STOPPING anytime and dual windows except Sunday', () => {
    expect(parseNYCOpenDataRestriction('NO STOPPING ANYTIME <->')).toMatchObject({
      ok: true, kind: 'noStopping', anytime: true,
    });
    const dual = parseNYCOpenDataRestriction('NO STOPPING 7AM-9AM 4PM-7PM EXCEPT SUNDAY <-> (SUPERSEDES R7-4R)');
    expect(dual.ok).toBe(true);
    expect(dual.windows).toHaveLength(2);
    expect(dual.days).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
  });

  it('N. expands a full-week restriction via Monday-Sunday', () => {
    const parsed = parseNYCOpenDataRestriction('NO PARKING MONDAY-SUNDAY 8AM-10AM <->');
    expect(parsed.days).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
  });

  it('P. single-arrow extent is uncertain', () => {
    const parsed = parseNYCOpenDataRestriction('NO PARKING ANYTIME --> (SUPERSEDES SP-854CA)');
    expect(parsed.ok).toBe(true);
    expect(parsed.extent).toBe('uncertain_extent');
    expect(classifyExtent(['-->'])).toBe('uncertain_extent');
    expect(classifyExtent(['<->'])).toBe('whole_face');
  });

  it('Q. historical/voided rows are not current', () => {
    expect(isCurrentUnvoidedRow({ record_type: 'Historical', sign_design_voided_on_date: null })).toBe(false);
    expect(isCurrentUnvoidedRow({ record_type: 'Current', sign_design_voided_on_date: '2020-01-01' })).toBe(false);
    expect(isCurrentUnvoidedRow({ record_type: 'Current', sign_design_voided_on_date: null })).toBe(true);
  });

  it('R. malformed schedules are omitted', () => {
    expect(parseNYCOpenDataRestriction('NO STANDING SOMEDAY MAYBE').ok).toBe(false);
    expect(parseNYCOpenDataRestriction('NO PARKING 8AM-8AM <->').ok).toBe(false);
  });

  it('does not treat broom ASP as a generic no-parking product rule', () => {
    expect(parseNYCOpenDataRestriction('NO PARKING (SANITATION BROOM SYMBOL) MONDAY 8AM-9AM <->').reason)
      .toBe('street_cleaning_identity');
  });

  it('parses informational hour parking without treating it as a movement prohibition', () => {
    const parsed = parseNYCOpenDataRestriction('1 HOUR PARKING MON-SAT 9AM-7PM <->');
    expect(parsed).toMatchObject({ ok: true, kind: 'timeLimited', hourLimit: 1, extent: 'whole_face' });
    expect(parsed.restrictionLevel).toBe(0);
  });

  it('defers bus/taxi/commercial wording', () => {
    expect(parseNYCOpenDataRestriction('NO STANDING (SINGLE ARROW) HANDICAP EXPRESS BUS').reason)
      .toBe('vehicle_or_permit_specific');
  });
});
