'use strict';

const STREET_INTEL_REFRESH_DOMAIN = 'street_intel_refresh';

const ALLOWED_EXTRA_KEYS = new Set([
  'via',
  'signsCount',
  'parsedCount',
  'sweepReason',
  'usableCount',
  'cleaningCount',
  'meterCount',
  'restrictionCount',
]);

const STREET_INTEL_EVENTS = Object.freeze({
  DEDUP_HIT_USABLE: 'dedup_hit_usable',
  DEDUP_HIT_EMPTY_REFRESH: 'dedup_hit_empty_refresh',
  PARSER_ATTEMPTED: 'parser_attempted',
  FALLBACK_ATTEMPTED: 'fallback_attempted',
  CACHE_HIT_USABLE: 'cache_hit_usable',
  CACHE_HIT_EMPTY_REFRESH: 'cache_hit_empty_refresh',
  CACHE_HIT_EMPTY_NO_RETRY: 'cache_hit_empty_no_retry',
  CACHE_HIT_RESTRICTION_REFRESH: 'cache_hit_restriction_refresh',
});

function isUsableSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') return false;
  const days = Array.isArray(schedule.days)
    ? schedule.days.filter(day => typeof day === 'string' && day.trim())
    : [];
  if (schedule.anytime === true) return true;
  const start = typeof schedule.startTime === 'string' ? schedule.startTime.trim() : '';
  const end = typeof schedule.endTime === 'string' ? schedule.endTime.trim() : '';
  return days.length > 0 && Boolean(start) && Boolean(end);
}

function isProhibitionType(type) {
  return type === 'noParking' || type === 'noStanding' || type === 'noStopping' || type === 'timeLimited'
    || type === 'curbRestrictionSet';
}

function countUsableProhibitionSchedules(rules) {
  if (!Array.isArray(rules)) return 0;
  let count = 0;
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    if (!isProhibitionType(rule.type)) continue;
    const schedules = Array.isArray(rule.schedules) ? rule.schedules : [];
    for (const schedule of schedules) {
      if (isUsableSchedule(schedule)) count += 1;
    }
  }
  return count;
}

function countUsableStreetIntelligence(rules) {
  return countUsableSchedules(rules) + countUsableMeterSchedules(rules) + countUsableProhibitionSchedules(rules);
}

function hasRestrictionEvaluation(rules) {
  if (!Array.isArray(rules)) return false;
  return rules.some(rule => rule && (rule.type === 'curbRestrictionSet' || rule.restrictionSchemaVersion === 1));
}

function shouldCallRestrictionMigrationRefresh(usableCount, evaluated, alreadyAttempted) {
  if (alreadyAttempted) return false;
  if (usableCount <= 0) return false;
  if (evaluated) return false;
  return true;
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

function countUsableMeterSchedules(rules) {
  if (!Array.isArray(rules)) return 0;
  let count = 0;
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    if (rule.type !== 'meter') continue;
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

function hasUsableStreetIntelligence(rules) {
  return countUsableStreetIntelligence(rules) > 0;
}

function decideDedupPath(usableCount) {
  return usableCount > 0 ? 'fast' : 'refresh';
}

function shouldCallEmptyCacheRefresh(usableCount, alreadyAttempted) {
  if (usableCount > 0) return false;
  if (alreadyAttempted) return false;
  return true;
}

const { emitStructuredLog } = require('./streetIntelStructuredLog');

function logStreetIntelEvent(event, extra, write) {
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
  emitStructuredLog(payload, write);
  return payload;
}

module.exports = {
  STREET_INTEL_REFRESH_DOMAIN,
  STREET_INTEL_EVENTS,
  ALLOWED_EXTRA_KEYS,
  isUsableSchedule,
  countUsableSchedules,
  countUsableMeterSchedules,
  countUsableProhibitionSchedules,
  countUsableStreetIntelligence,
  hasUsableSchedules,
  hasUsableStreetIntelligence,
  hasRestrictionEvaluation,
  decideDedupPath,
  shouldCallEmptyCacheRefresh,
  shouldCallRestrictionMigrationRefresh,
  logStreetIntelEvent,
};
