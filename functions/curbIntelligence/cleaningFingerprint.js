'use strict';

const DAYS = Object.freeze(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
const DAY_INDEX = new Map(DAYS.map((day, index) => [day, index]));
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function createCleaningFingerprint(schedules) {
  if (!Array.isArray(schedules)) return { ok: false, reason: 'invalid_cleaning_schedule' };
  if (schedules.length === 0) return { ok: true, fingerprint: null };
  const fingerprints = [];
  for (const schedule of schedules) {
    if (!schedule || !Array.isArray(schedule.days) || schedule.days.length === 0
      || !TIME.test(schedule.startTime || '') || !TIME.test(schedule.endTime || '')) {
      return { ok: false, reason: 'invalid_cleaning_schedule' };
    }
    const uniqueDays = [...new Set(schedule.days)];
    if (uniqueDays.some(day => !DAY_INDEX.has(day))) return { ok: false, reason: 'invalid_cleaning_schedule' };
    uniqueDays.sort((left, right) => DAY_INDEX.get(left) - DAY_INDEX.get(right));
    fingerprints.push(`${uniqueDays.join(',')}|${schedule.startTime}|${schedule.endTime}`);
  }
  return { ok: true, fingerprint: [...new Set(fingerprints)].sort().join(';') };
}

module.exports = { createCleaningFingerprint };
