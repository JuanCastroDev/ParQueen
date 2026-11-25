import { t } from '../i18n';

/**
 * Display-only labels for a weekday already chosen by the New York schedule
 * calculation. The stored day token stays English.
 */
const FULL_DAY_KEY: Record<string, string> = {
  Sunday: 'street_intel.day_sun',
  Monday: 'street_intel.day_mon',
  Tuesday: 'street_intel.day_tue',
  Wednesday: 'street_intel.day_wed',
  Thursday: 'street_intel.day_thu',
  Friday: 'street_intel.day_fri',
  Saturday: 'street_intel.day_sat',
};

export function localizeScheduleWeekday(day: string | null | undefined): string {
  if (!day) return '';
  return FULL_DAY_KEY[day] ? t(FULL_DAY_KEY[day]) : day;
}

export function localizeScheduleClock(time: string | null | undefined): string {
  if (!time) return '';
  return time
    .replace(/\bAM\b/g, t('street_intel.time_am'))
    .replace(/\bPM\b/g, t('street_intel.time_pm'));
}

/** Display-only. The stored schedule phrase from the calculator stays English. */
export function localizeScheduleDescription(description: string | null | undefined): string {
  if (!description) return '';
  return localizeScheduleClock(description.replace(/^Every day\b/, t('street_intel.every_day')));
}
