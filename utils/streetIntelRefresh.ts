export const STREET_INTEL_REFRESH_DOMAIN = 'street_intel_refresh';

const ALLOWED_EXTRA_KEYS = new Set([
  'via',
  'signsCount',
  'parsedCount',
  'sweepReason',
  'usableCount',
  'cleaningCount',
  'meterCount',
]);

export const STREET_INTEL_EVENTS = {
  DEDUP_HIT_USABLE: 'dedup_hit_usable',
  DEDUP_HIT_EMPTY_REFRESH: 'dedup_hit_empty_refresh',
  PARSER_ATTEMPTED: 'parser_attempted',
  FALLBACK_ATTEMPTED: 'fallback_attempted',
  CACHE_HIT_USABLE: 'cache_hit_usable',
  CACHE_HIT_EMPTY_REFRESH: 'cache_hit_empty_refresh',
  CACHE_HIT_EMPTY_NO_RETRY: 'cache_hit_empty_no_retry',
} as const;

export function isUsableSchedule(schedule: unknown): boolean {
  if (!schedule || typeof schedule !== 'object') return false;
  const rec = schedule as { days?: unknown; startTime?: unknown; endTime?: unknown };
  const days = Array.isArray(rec.days)
    ? rec.days.filter(day => typeof day === 'string' && day.trim())
    : [];
  const start = typeof rec.startTime === 'string' ? rec.startTime.trim() : '';
  const end = typeof rec.endTime === 'string' ? rec.endTime.trim() : '';
  return days.length > 0 && Boolean(start) && Boolean(end);
}

export function countUsableSchedules(rules: unknown): number {
  if (!Array.isArray(rules)) return 0;
  let count = 0;
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    const rec = rule as { type?: unknown; schedules?: unknown };
    if (rec.type && rec.type !== 'streetCleaning') continue;
    const schedules = Array.isArray(rec.schedules) ? rec.schedules : [];
    for (const schedule of schedules) {
      if (isUsableSchedule(schedule)) count += 1;
    }
  }
  return count;
}

export function countUsableMeterSchedules(rules: unknown): number {
  if (!Array.isArray(rules)) return 0;
  let count = 0;
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    const rec = rule as { type?: unknown; schedules?: unknown };
    if (rec.type !== 'meter') continue;
    const schedules = Array.isArray(rec.schedules) ? rec.schedules : [];
    for (const schedule of schedules) {
      if (isUsableSchedule(schedule)) count += 1;
    }
  }
  return count;
}

export function countUsableStreetIntelligence(rules: unknown): number {
  return countUsableSchedules(rules) + countUsableMeterSchedules(rules);
}

export function hasUsableSchedules(rules: unknown): boolean {
  return countUsableSchedules(rules) > 0;
}

export function hasUsableStreetIntelligence(rules: unknown): boolean {
  return countUsableStreetIntelligence(rules) > 0;
}

export function shouldCallEmptyCacheRefresh(usableCount: number, alreadyAttempted: boolean): boolean {
  if (usableCount > 0) return false;
  if (alreadyAttempted) return false;
  return true;
}

export function logStreetIntelEvent(
  event: string,
  extra?: Record<string, unknown>,
  write: (line: string) => void = console.log,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    message: event,
    event,
    domain: STREET_INTEL_REFRESH_DOMAIN,
  };
  if (extra && typeof extra === 'object') {
    for (const [key, value] of Object.entries(extra)) {
      if (!ALLOWED_EXTRA_KEYS.has(key)) continue;
      if (value === undefined || value === null) continue;
      if (typeof value === 'object') continue;
      payload[key] = value;
    }
  }
  write(JSON.stringify(payload));
  return payload;
}
