import type { SignAnalysisResult } from '../../services/geminiService';
import { isSignAnalysisUnavailable } from '../../services/geminiService';
import type { Lang } from '../../i18n';

/**
 * Pure presentation rules for the Sign Scanner. Everything here maps the existing analyzeSign
 * response (SignAnalysisResult) onto the screen; nothing re-interprets what the model said.
 */

export type VerdictTone = 'ok' | 'bad' | 'warn';
export type ResultStatus = Exclude<SignAnalysisResult['status'], 'ERROR'>;

export interface Verdict {
  tone: VerdictTone;
  /** i18n key for the verdict pill. Always hedged ("appears"); never a guarantee. */
  labelKey: string;
  /** i18n key for the compact word used in Recent scans. */
  shortKey: string;
}

/**
 * CONDITIONAL is one verdict whether or not timestamps came back. The server uses it both for
 * day/time-dependent rules and for ambiguous or partly legible signs, and the response does not
 * say which, so the screen never guesses (it is not shown as "unreadable").
 */
export function verdictFor(status: ResultStatus): Verdict {
  if (status === 'YES') return { tone: 'ok', labelKey: 'scanner.verdict_yes', shortKey: 'scanner.recent_yes' };
  if (status === 'NO') return { tone: 'bad', labelKey: 'scanner.verdict_no', shortKey: 'scanner.recent_no' };
  return { tone: 'warn', labelKey: 'scanner.verdict_conditional', shortKey: 'scanner.recent_conditional' };
}

export type ScanErrorKind = 'unavailable' | 'unreadable';

/** Service outage / quota → retry the same photo first. Anything else → retake first. */
export function errorKindFor(result: SignAnalysisResult): ScanErrorKind {
  return isSignAnalysisUnavailable(result) ? 'unavailable' : 'unreadable';
}

/** Model timestamps are free-form ISO strings; ignore anything unparseable, past, or implausibly far out. */
const MAX_TIMING_AHEAD_MS = 8 * 24 * 60 * 60 * 1000;
export function parseFutureTime(iso: string | null | undefined, now: number): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  const ms = d.getTime();
  if (!Number.isFinite(ms) || ms <= now || ms - now > MAX_TIMING_AHEAD_MS) return null;
  return d;
}

export interface TimingEvent {
  kind: 'starts' | 'ends';
  at: Date;
}

/** The one upcoming change worth showing: the next restriction start, else the current one's end. */
export function timingEventFor(result: SignAnalysisResult, now: number): TimingEvent | null {
  const starts = parseFutureTime(result.restrictionStartsAt, now);
  if (starts) return { kind: 'starts', at: starts };
  const ends = parseFutureTime(result.restrictionEndsAt, now);
  if (ends) return { kind: 'ends', at: ends };
  return null;
}

/* ── Reminders ────────────────────────────────────────────────────────────────
   Timing is deliberately UNCHANGED from the retired AssistantView.setReminder:
   minutes until restrictionStartsAt when that is in the future, otherwise 60.
   The proposed 10-minute advance is documented separately
   (docs/SIGN_SCANNER_REMINDER_LEAD_PROPOSAL.md) and is not implemented. */

export const REMINDER_FALLBACK_MINUTES = 60;
/** Label passed to useParkingTimer, unchanged from the previous screen. */
export const REMINDER_TIMER_LABEL = 'parking sign';

export function reminderMinutesFor(result: SignAnalysisResult, now: number): number {
  let minutes = REMINDER_FALLBACK_MINUTES;
  if (result.restrictionStartsAt) {
    const parsed = new Date(result.restrictionStartsAt);
    const diff = Math.ceil((parsed.getTime() - now) / 60_000);
    if (diff > 0) minutes = diff;
  }
  return minutes;
}

/**
 * Previously offered whenever actionableAdvice existed. Now also withheld when parking appears
 * prohibited: a "move your car" reminder for a spot you should not be in is the wrong prompt.
 */
export function reminderOffered(result: SignAnalysisResult): boolean {
  return result.status !== 'ERROR' && result.status !== 'NO' && !!result.actionableAdvice;
}

/* ── Formatting ─────────────────────────────────────────────────────────────── */

export const localeFor = (lang: Lang) => (lang === 'es' ? 'es-US' : 'en-US');

const capitalize = (s: string) => (s ? s[0].toLocaleUpperCase() + s.slice(1) : s);

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const addDays = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

export function formatClock(d: Date, lang: Lang): string {
  return new Intl.DateTimeFormat(localeFor(lang), { hour: 'numeric', minute: '2-digit' }).format(d);
}

/** null for today, otherwise "tomorrow" / weekday in the active language (lower case, for sentences). */
export function dayWord(d: Date, now: Date, lang: Lang): string | null {
  if (sameDay(d, now)) return null;
  if (sameDay(d, addDays(now, 1))) {
    return new Intl.RelativeTimeFormat(localeFor(lang), { numeric: 'auto' }).format(1, 'day');
  }
  return new Intl.DateTimeFormat(localeFor(lang), { weekday: 'long' }).format(d).toLocaleLowerCase();
}

/** "in 42 minutes" / "in 3 hours"; empty when a day word already says enough. */
export function relativeIn(d: Date, now: Date, lang: Lang): string {
  const mins = Math.round((d.getTime() - now.getTime()) / 60_000);
  if (mins <= 0 || mins > 20 * 60) return '';
  const rtf = new Intl.RelativeTimeFormat(localeFor(lang), { numeric: 'always' });
  return mins < 90 ? rtf.format(mins, 'minute') : rtf.format(Math.round(mins / 60), 'hour');
}

/** Recent-scan timestamp: a time today, "Yesterday", else a short date. */
export function formatScanTime(ts: number, now: Date, lang: Lang): string {
  const d = new Date(ts);
  if (sameDay(d, now)) return formatClock(d, lang);
  if (sameDay(d, addDays(now, -1))) {
    return capitalize(new Intl.RelativeTimeFormat(localeFor(lang), { numeric: 'auto' }).format(-1, 'day'));
  }
  return new Intl.DateTimeFormat(localeFor(lang), { month: 'short', day: 'numeric' }).format(d);
}

export { capitalize };

/**
 * The result payload sometimes packs a headline and a body into `explanation`, separated by a
 * newline. Results lead with the first line; the remainder is supporting detail.
 */
export function splitExplanation(text: string): { headline: string; body: string } {
  const value = (text || '').trim();
  const idx = value.indexOf('\n');
  if (idx === -1) return { headline: value, body: '' };
  return { headline: value.slice(0, idx).trim(), body: value.slice(idx + 1).trim() };
}
