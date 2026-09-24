'use strict';

const STREET_INTEL_REFRESH_DOMAIN = 'street_intel_refresh';

const ALLOWED_EXTRA_KEYS = new Set([
  'via',
  'signsCount',
  'parsedCount',
  'sweepReason',
  'usableCount',
]);

const STREET_INTEL_EVENTS = Object.freeze({
  DEDUP_HIT_USABLE: 'dedup_hit_usable',
  DEDUP_HIT_EMPTY_REFRESH: 'dedup_hit_empty_refresh',
  PARSER_ATTEMPTED: 'parser_attempted',
  FALLBACK_ATTEMPTED: 'fallback_attempted',
  CACHE_HIT_USABLE: 'cache_hit_usable',
  CACHE_HIT_EMPTY_REFRESH: 'cache_hit_empty_refresh',
  CACHE_HIT_EMPTY_NO_RETRY: 'cache_hit_empty_no_retry',
});

function isUsableSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') return false;
  const days = Array.isArray(schedule.days)
    ? schedule.days.filter(day => typeof day === 'string' && day.trim())
    : [];
  const start = typeof schedule.startTime === 'string' ? schedule.startTime.trim() : '';
  const end = typeof schedule.endTime === 'string' ? schedule.endTime.trim() : '';
  return days.length > 0 && Boolean(start) && Boolean(end);
}

function countUsableSchedules(rules) {
  if (!Array.isArray(rules)) return 0;
  let count = 0;
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    if (rule.type && rule.type !== 'streetCleaning') continue;
    const schedules = Array.isArray(rule.schedules) ? rule.schedules : [];
    for (const schedule of schedules) {
      if (isUsableSchedule(schedule)) count += 1;
    }
  }
  return count;
}

function hasUsableSchedules(rules) {
  return countUsableSchedules(rules) > 0;
}

function decideDedupPath(usableCount) {
  return usableCount > 0 ? 'fast' : 'refresh';
}

function shouldCallEmptyCacheRefresh(usableCount, alreadyAttempted) {
  if (usableCount > 0) return false;
  if (alreadyAttempted) return false;
  return true;
}

function logStreetIntelEvent(event, extra, write) {
  const emit = typeof write === 'function' ? write : console.log;
  const payload = {
    message: event,
    event,
    domain: STREET_INTEL_REFRESH_DOMAIN,
  };
  if (extra && typeof extra === 'object' && !Array.isArray(extra)) {
    for (const [key, value] of Object.entries(extra)) {
      if (!ALLOWED_EXTRA_KEYS.has(key)) continue;
      if (value === undefined || value === null) continue;
      if (typeof value === 'object') continue;
      payload[key] = value;
    }
  }
  emit(JSON.stringify(payload));
  return payload;
}

module.exports = {
  STREET_INTEL_REFRESH_DOMAIN,
  STREET_INTEL_EVENTS,
  ALLOWED_EXTRA_KEYS,
  isUsableSchedule,
  countUsableSchedules,
  hasUsableSchedules,
  decideDedupPath,
  shouldCallEmptyCacheRefresh,
  logStreetIntelEvent,
};
