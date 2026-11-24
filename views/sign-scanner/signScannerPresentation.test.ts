import { describe, expect, it } from 'vitest';
import {
  dayWord, errorKindFor, formatScanTime, parseFutureTime, relativeIn, reminderMinutesFor, reminderOffered,
  REMINDER_FALLBACK_MINUTES, splitExplanation, timingEventFor, verdictFor,
} from './signScannerPresentation';
import { SIGN_ANALYSIS_UNAVAILABLE_EXPLANATION, SIGN_ANALYSIS_UNREADABLE_EXPLANATION, type SignAnalysisResult } from '../../services/geminiService';

const NOW = new Date('2026-11-23T14:17:30').getTime();
const at = (mins: number) => new Date(NOW + mins * 60_000).toISOString();

/** Verbatim copy of the retired AssistantView.setReminder timing, kept as the reference. */
function legacyReminderMinutes(analysis: SignAnalysisResult, now: number): number {
  let minutes = 60;
  if (analysis.restrictionStartsAt) {
    const parsed = new Date(analysis.restrictionStartsAt);
    const diff = Math.ceil((parsed.getTime() - now) / 60_000);
    if (diff > 0) minutes = diff;
  }
  return minutes;
}

describe('verdictFor', () => {
  it('hedges every verdict', () => {
    expect(verdictFor('YES')).toMatchObject({ tone: 'ok', labelKey: 'scanner.verdict_yes' });
    expect(verdictFor('NO')).toMatchObject({ tone: 'bad', labelKey: 'scanner.verdict_no' });
    expect(verdictFor('CONDITIONAL')).toMatchObject({ tone: 'warn', labelKey: 'scanner.verdict_conditional' });
  });
});

describe('errorKindFor', () => {
  it('maps the service outage text to unavailable and everything else to unreadable', () => {
    expect(errorKindFor({ status: 'ERROR', explanation: SIGN_ANALYSIS_UNAVAILABLE_EXPLANATION })).toBe('unavailable');
    expect(errorKindFor({ status: 'ERROR', explanation: SIGN_ANALYSIS_UNREADABLE_EXPLANATION })).toBe('unreadable');
    expect(errorKindFor({ status: 'ERROR', explanation: 'Model said the image is not a sign.' })).toBe('unreadable');
  });
});

describe('reminder timing is unchanged from the previous screen', () => {
  const cases: Array<[string, SignAnalysisResult]> = [
    ['future start', { status: 'YES', explanation: '', restrictionStartsAt: at(47.5) }],
    ['start tomorrow', { status: 'CONDITIONAL', explanation: '', restrictionStartsAt: at(21 * 60) }],
    ['past start', { status: 'YES', explanation: '', restrictionStartsAt: at(-5) }],
    ['start exactly now', { status: 'YES', explanation: '', restrictionStartsAt: at(0) }],
    ['no start', { status: 'CONDITIONAL', explanation: '' }],
    ['garbage start', { status: 'YES', explanation: '', restrictionStartsAt: 'soon-ish' }],
    ['end only', { status: 'NO', explanation: '', restrictionEndsAt: at(30) }],
  ];
  it.each(cases)('%s', (_label, result) => {
    expect(reminderMinutesFor(result, NOW)).toBe(legacyReminderMinutes(result, NOW));
  });
  it('keeps the 60-minute fallback', () => {
    expect(REMINDER_FALLBACK_MINUTES).toBe(60);
    expect(reminderMinutesFor({ status: 'YES', explanation: '' }, NOW)).toBe(60);
  });
});

describe('reminderOffered', () => {
  it('requires actionable advice, as before', () => {
    expect(reminderOffered({ status: 'YES', explanation: '' })).toBe(false);
    expect(reminderOffered({ status: 'YES', explanation: '', actionableAdvice: 'Move by 4.' })).toBe(true);
    expect(reminderOffered({ status: 'CONDITIONAL', explanation: '', actionableAdvice: 'Move by 4.' })).toBe(true);
  });
  it('is never offered when parking appears prohibited, or on errors', () => {
    expect(reminderOffered({ status: 'NO', explanation: '', actionableAdvice: 'Move now.' })).toBe(false);
    expect(reminderOffered({ status: 'ERROR', explanation: '', actionableAdvice: 'x' })).toBe(false);
  });
});

describe('timing', () => {
  it('ignores unparseable, past, and implausibly distant times', () => {
    expect(parseFutureTime('nope', NOW)).toBeNull();
    expect(parseFutureTime(at(-1), NOW)).toBeNull();
    expect(parseFutureTime(at(9 * 24 * 60), NOW)).toBeNull();
    expect(parseFutureTime(at(30), NOW)?.getTime()).toBe(NOW + 30 * 60_000);
  });
  it('prefers the next restriction start, then the current restriction end', () => {
    expect(timingEventFor({ status: 'YES', explanation: '', restrictionStartsAt: at(30), restrictionEndsAt: at(90) }, NOW)?.kind).toBe('starts');
    expect(timingEventFor({ status: 'NO', explanation: '', restrictionStartsAt: at(-30), restrictionEndsAt: at(90) }, NOW)?.kind).toBe('ends');
    expect(timingEventFor({ status: 'CONDITIONAL', explanation: '' }, NOW)).toBeNull();
  });
});

describe('formatting', () => {
  const now = new Date(NOW);
  it('names tomorrow and weekdays in both languages', () => {
    const tomorrow = new Date(NOW + 20 * 3600_000);
    expect(dayWord(new Date(NOW + 60_000), now, 'en')).toBeNull();
    expect(dayWord(tomorrow, now, 'en')).toBe('tomorrow');
    expect(dayWord(tomorrow, now, 'es')).toBe('mañana');
  });
  it('describes short waits relatively', () => {
    expect(relativeIn(new Date(NOW + 42 * 60_000), now, 'en')).toBe('in 42 minutes');
    expect(relativeIn(new Date(NOW + 3 * 3600_000), now, 'es')).toBe('dentro de 3 horas');
    expect(relativeIn(new Date(NOW + 22 * 3600_000), now, 'en')).toBe('');
  });
  it('formats recent-scan times for today, yesterday, and older', () => {
    expect(formatScanTime(NOW - 60_000, now, 'en')).toMatch(/2:16\sPM/);
    expect(formatScanTime(NOW - 24 * 3600_000, now, 'en')).toBe('Yesterday');
    expect(formatScanTime(NOW - 24 * 3600_000, now, 'es')).toBe('Ayer');
    expect(formatScanTime(NOW - 5 * 24 * 3600_000, now, 'en')).toBe('Nov 18');
  });
  it('leads with the first line of a packed explanation', () => {
    expect(splitExplanation('Headline\nBody text')).toEqual({ headline: 'Headline', body: 'Body text' });
    expect(splitExplanation('One sentence.')).toEqual({ headline: 'One sentence.', body: '' });
  });
});
