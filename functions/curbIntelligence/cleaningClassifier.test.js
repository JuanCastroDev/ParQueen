import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  CLEANING_IDENTITY_EXCEPTIONS_VERSION,
  classifyStreetCleaningSign,
} = require('./cleaningClassifier');

const CTX = { street: 'GOLD STREET', fromCross: 'BEEKMAN STREET', toCross: 'ANN STREET', side: 'West' };
const row = (sign_code, sign_description, record_type = 'Current') => ({ sign_code, sign_description, record_type });

describe('reviewed street-cleaning identity', () => {
  it('accepts the standard sanitation-broom identity and retains its complete source evidence', () => {
    const source = row(
      'PS-246B',
      'NO PARKING (SANITATION BROOM SYMBOL) MONDAY TUESDAY THURSDAY FRIDAY 6:30AM-7:30AM <->',
    );
    const result = classifyStreetCleaningSign(source, CTX);
    expect(result.classified).toBe(true);
    expect(result.schedule).toMatchObject({
      days: ['Mon', 'Tue', 'Thu', 'Fri'], startTime: '06:30', endTime: '07:30', durationMinutes: 60,
    });
    expect(result.evidence).toMatchObject({
      signCode: 'PS-246B', recordType: 'Current', rawText: source.sign_description,
      identityKind: 'standard_broom_marker', exceptionTableVersion: null,
    });
  });

  it('accepts EXCEPT SUNDAY as the concrete Mon-Sat schedule represented by the source', () => {
    const result = classifyStreetCleaningSign(row(
      'PS-20B', 'NO PARKING (SANITATION BROOM SYMBOL) 7AM-7:30AM EXCEPT SUNDAY <->',
    ), CTX);
    expect(result.classified).toBe(true);
    expect(result.schedule.days).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
    expect(result.schedule.durationMinutes).toBe(30);
  });

  it.each([
    ['PS-188B', 'NO PARKING (SANITATION BRROM SYMBOL) MOON & STARS (SYMBOLS) FRIDAY 3AM-6AM <-> (SUPERSEDES SP-554C)', 180],
    ['PS-162BA', 'NO PARKING (SANITATION BROOMM SYMBOL) FRIDAY 10:30AM-NOON --> (SUPERSEDES SP-401CA)', 90],
    ['PS-165BA', 'NO PARKING (SANITATIOJN BROOM SYMBOL) MOON & STARS (SYMBOLS) 3AM-6AM EXCEPT SUNDAY --> (SUPERSEDES SP-795CA)', 180],
  ])('accepts only reviewed exact source typo %s', (signCode, description, durationMinutes) => {
    const result = classifyStreetCleaningSign(row(signCode, description), CTX);
    expect(result.classified).toBe(true);
    expect(result.schedule.durationMinutes).toBe(durationMinutes);
    expect(result.evidence).toMatchObject({
      identityKind: 'reviewed_exception', exceptionTableVersion: CLEANING_IDENTITY_EXCEPTIONS_VERSION,
    });
  });

  it('does not fuzzy-match a typo or transfer a reviewed marker to another sign code', () => {
    expect(classifyStreetCleaningSign(row(
      'PS-188B', 'NO PARKING (SANITATION BROOOM SYMBOL) FRIDAY 3AM-6AM <->',
    ), CTX)).toMatchObject({ classified: false, reason: 'unreviewed_cleaning_identity' });
    expect(classifyStreetCleaningSign(row(
      'PS-999X', 'NO PARKING (SANITATION BRROM SYMBOL) FRIDAY 3AM-6AM <->',
    ), CTX)).toMatchObject({ classified: false, reason: 'unreviewed_cleaning_identity' });
  });
});
describe('street-cleaning fail-closed boundary', () => {
  it('requires a Current DOT source row', () => {
    expect(classifyStreetCleaningSign(row(
      'PS-20B', 'NO PARKING (SANITATION BROOM SYMBOL) 7AM-7:30AM EXCEPT SUNDAY <->', 'Historical',
    ), CTX)).toMatchObject({ classified: false, reason: 'not_current' });
  });

  it.each([
    ['PS-15G', 'NO PARKING MONDAY-FRIDAY 8AM-6PM <-> (SUPERSEDES R7-45R)'],
    ['PS-39G', 'NO PARKING 8AM-6PM EXCEPT SUNDAY <->'],
    ['PS-38G', 'NO PARKING MONDAY-FRIDAY 7AM-7PM <-> (SUPERSEDES R7-43R)'],
    ['PS-175G', 'NO PARKING TUESDAY 8AM-6PM <-> (SUPERSEDES SP-299C)'],
    ['GENERIC', 'NO PARKING STREET CLEANING MONDAY 8AM-9AM <->'],
  ])('rejects timed non-cleaning sign %s', (signCode, description) => {
    expect(classifyStreetCleaningSign(row(signCode, description), CTX))
      .toMatchObject({ classified: false, reason: 'unreviewed_cleaning_identity' });
  });

  it.each([
    ['PS-7A', 'METERS ARE NOT IN EFFECT ABOVE TIMES (TO BE USED ONLY FOR CONFLICTING STREET CLEANING AND METERED PARKING REGULATIONS) (SUPERSEDES SW-473)'],
    ['PS-6A', 'LIMITED PARKING IS NOT IN EFFECT ABOVE TIMES (TO BE USED ONLY FOR CONFLICTING STREET CLEANING AND FREE LIMITED TIME PARKING REGULATIONS) (SUPERSEDES SW-672)'],
  ])('never promotes contextual rider %s to a standalone schedule', (signCode, description) => {
    expect(classifyStreetCleaningSign(row(signCode, description), CTX))
      .toMatchObject({ classified: false, reason: 'contextual_rider' });
  });

  it('rejects the SP-798C source template with unresolved days and times', () => {
    expect(classifyStreetCleaningSign(row(
      'SP-798C',
      'NO PARKING <----> SANITATION BROOM (SYMBOL) XYY-XYY "DAY" THRU "DAY" (TIMES & DAYS TO BE SPECIFIED) (FOR CIRCULAR BUS SIGNS)',
    ), CTX)).toMatchObject({ classified: false, reason: 'unresolved_template' });
  });

  it('fails closed when a reviewed identity has no complete, nonzero schedule', () => {
    expect(classifyStreetCleaningSign(row(
      'PS-X', 'NO PARKING (SANITATION BROOM SYMBOL) MONDAY 8AM-8AM <->',
    ), CTX)).toMatchObject({ classified: false, reason: 'incomplete_schedule' });
    expect(classifyStreetCleaningSign(row(
      'PS-X', 'NO PARKING (SANITATION BROOM SYMBOL) 8AM-9AM <->',
    ), CTX)).toMatchObject({ classified: false, reason: 'incomplete_schedule' });
  });
});
