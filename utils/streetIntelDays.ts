export const CANONICAL_WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

const DAILY_PHRASES = new Set([
  'DAILY',
  'EVERYDAY',
  'EVERY DAY',
  'ALL DAYS',
  'ALL DAY',
  '7 DAYS',
  'SEVEN DAYS',
]);

const SWEEP_DAY_ABBR: Record<string, string> = {
  Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu',
  Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun',
  monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu',
  friday: 'Fri', saturday: 'Sat', sunday: 'Sun',
  MON: 'Mon', TUE: 'Tue', WED: 'Wed', THU: 'Thu', FRI: 'Fri', SAT: 'Sat', SUN: 'Sun',
};

export function normalizeDailyPhrase(raw: unknown): string {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function expandDailyDays(raw: unknown): string[] | null {
  const cleaned = normalizeDailyPhrase(raw);
  if (!cleaned) return null;
  if (DAILY_PHRASES.has(cleaned)) return [...CANONICAL_WEEKDAYS];
  return null;
}

export function parseSweepNYCDayList(daysRaw: unknown): string[] {
  const daily = expandDailyDays(daysRaw);
  if (daily) return daily;
  const tokens = String(daysRaw || '').trim().split(/[\s,]+/).map(d => d.trim()).filter(Boolean);
  const days: string[] = [];
  for (const token of tokens) {
    const mapped = SWEEP_DAY_ABBR[token]
      || SWEEP_DAY_ABBR[token.toUpperCase()]
      || (token.length <= 3
        ? token.charAt(0).toUpperCase() + token.slice(1).toLowerCase()
        : null);
    if (!mapped || !CANONICAL_WEEKDAYS.includes(mapped as typeof CANONICAL_WEEKDAYS[number])) continue;
    if (!days.includes(mapped)) days.push(mapped);
  }
  return days;
}

export function isCanonicalFullWeek(days: unknown): boolean {
  if (!Array.isArray(days) || days.length !== CANONICAL_WEEKDAYS.length) return false;
  const set = new Set(days.filter(day => typeof day === 'string' && day.trim()));
  return CANONICAL_WEEKDAYS.every(day => set.has(day));
}

export function formatDaysLabel(days: unknown): string {
  if (isCanonicalFullWeek(days)) return 'Every day';
  if (!Array.isArray(days) || !days.length) return '';
  return days.join(' & ');
}
