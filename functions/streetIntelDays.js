'use strict';

const CANONICAL_WEEKDAYS = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);

const DAILY_PHRASES = new Set([
  'DAILY',
  'EVERYDAY',
  'EVERY DAY',
  'ALL DAYS',
  'ALL DAY',
  '7 DAYS',
  'SEVEN DAYS',
]);

const SWEEP_DAY_ABBR = {
  Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu',
  Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun',
  monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu',
  friday: 'Fri', saturday: 'Sat', sunday: 'Sun',
  MON: 'Mon', TUE: 'Tue', WED: 'Wed', THU: 'Thu', FRI: 'Fri', SAT: 'Sat', SUN: 'Sun',
};

function normalizeDailyPhrase(raw) {
  return String(raw || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function expandDailyDays(raw) {
  const cleaned = normalizeDailyPhrase(raw);
  if (!cleaned) return null;
  if (DAILY_PHRASES.has(cleaned)) return CANONICAL_WEEKDAYS.slice();
  return null;
}

function parseSweepNYCDayList(daysRaw) {
  const daily = expandDailyDays(daysRaw);
  if (daily) return daily;
  const tokens = String(daysRaw || '').trim().split(/[\s,]+/).map(d => d.trim()).filter(Boolean);
  const days = [];
  for (const token of tokens) {
    const mapped = SWEEP_DAY_ABBR[token]
      || SWEEP_DAY_ABBR[token.toUpperCase()]
      || (token.length <= 3
        ? token.charAt(0).toUpperCase() + token.slice(1).toLowerCase()
        : null);
    if (!CANONICAL_WEEKDAYS.includes(mapped)) continue;
    if (!days.includes(mapped)) days.push(mapped);
  }
  return days;
}

function isCanonicalFullWeek(days) {
  if (!Array.isArray(days) || days.length !== CANONICAL_WEEKDAYS.length) return false;
  const set = new Set(days.filter(day => typeof day === 'string' && day.trim()));
  return CANONICAL_WEEKDAYS.every(day => set.has(day));
}

function formatDaysLabel(days) {
  if (isCanonicalFullWeek(days)) return 'Every day';
  if (!Array.isArray(days) || !days.length) return '';
  return days.join(' & ');
}

module.exports = {
  CANONICAL_WEEKDAYS,
  DAILY_PHRASES,
  normalizeDailyPhrase,
  expandDailyDays,
  parseSweepNYCDayList,
  isCanonicalFullWeek,
  formatDaysLabel,
};
