'use strict';

const APPLY_COMPARISONS = new Set([
  'agreement', 'schedule_difference', 'new_only', 'confidence_difference',
]);

function publicProductSchedules(rules) {
  if (!Array.isArray(rules)) return [];
  const schedules = [];
  for (const rule of rules) {
    const schedule = Array.isArray(rule?.schedules) ? rule.schedules[0] : null;
    if (!schedule || typeof schedule !== 'object') continue;
    const side = typeof schedule.side === 'string' ? schedule.side.trim() : '';
    const days = Array.isArray(schedule.days)
      ? schedule.days.filter(day => typeof day === 'string' && day.trim()).map(day => day.trim())
      : [];
    const startTime = typeof schedule.startTime === 'string' ? schedule.startTime : '';
    const endTime = typeof schedule.endTime === 'string' ? schedule.endTime : '';
    if (!side || !days.length || !startTime || !endTime) continue;
    const item = { side, days, startTime, endTime };
    if (typeof schedule.ruleType === 'string' && schedule.ruleType.trim()) {
      item.ruleType = schedule.ruleType.trim();
    }
    schedules.push(item);
  }
  return schedules;
}

function normalizeSchedules(value) {
  if (!Array.isArray(value)) return [];
  if (value.some(item => item && Array.isArray(item.schedules))) return publicProductSchedules(value);
  return publicProductSchedules(value.map(schedule => ({ schedules: [schedule] })));
}

function decideProductPresentation(result) {
  if (!result || result.outcome !== 'COMPLETED') {
    return { apply: false, reason: result?.skipOrFailureClass || 'unusable' };
  }
  if (result.skipOrFailureClass === 'execution_timeout'
    || result.skipOrFailureClass === 'internal_failure') {
    return { apply: false, reason: result.skipOrFailureClass };
  }
  if (!APPLY_COMPARISONS.has(result.comparisonCategory)) {
    return { apply: false, reason: result.comparisonCategory || 'unusable' };
  }
  if (result.curbState === 'UNKNOWN' || result.cleaningState === 'UNKNOWN') {
    return { apply: false, reason: 'unknown' };
  }
  const schedules = normalizeSchedules(result.productSchedules || result.rules);
  if (!schedules.length) return { apply: false, reason: 'unusable' };
  const caution = result.curbState === 'CAUTION' || result.cleaningState === 'CAUTION'
    || result.comparisonCategory === 'confidence_difference';
  return { apply: true, caution, schedules, reason: 'usable' };
}

function createProductOverlayPlan(productionResult, decision) {
  if (!decision?.apply || !productionResult?.success || typeof productionResult.segmentId !== 'string'
    || !productionResult.segmentId || !Array.isArray(decision.schedules) || !decision.schedules.length) {
    return null;
  }
  return {
    segmentId: productionResult.segmentId,
    ruleDocId: 'nyc_open_data_v1',
    schedules: decision.schedules,
    needsReview: decision.caution === true,
    status: decision.caution === true ? 'needs_review' : 'active',
    confidenceScore: decision.caution === true ? 0.5 : 1,
  };
}

module.exports = {
  publicProductSchedules,
  decideProductPresentation,
  createProductOverlayPlan,
};
