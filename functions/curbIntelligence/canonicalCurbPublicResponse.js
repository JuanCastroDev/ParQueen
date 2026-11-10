'use strict';

const { toPublicRule } = require('./canonicalCurbPersistence');

const PUBLIC_RESPONSE_VERSION = 1;

function selectedHasUnresolvedConflicts(selectedRules) {
  return Boolean(selectedRules && !Array.isArray(selectedRules)
    && Array.isArray(selectedRules.conflicts) && selectedRules.conflicts.length > 0);
}

function rulesFromSelected(selected) {
  if (Array.isArray(selected)) return selected.map(rule => toPublicRule(rule) || sanitizeAlreadyPublic(rule)).filter(Boolean);
  if (Array.isArray(selected?.rules)) {
    return selected.rules.map(rule => toPublicRule(rule) || sanitizeAlreadyPublic(rule)).filter(Boolean);
  }
  return [];
}

function sanitizeAlreadyPublic(rule) {
  if (!rule || typeof rule !== 'object') return null;
  if (typeof rule.category === 'string') return toPublicRule(rule);
  if (typeof rule.type !== 'string') return null;
  const categoryByType = {
    streetCleaning: 'cleaning',
    meter: 'meter',
    timeLimited: 'timeLimit',
  };
  return toPublicRule({
    ...rule,
    category: categoryByType[rule.type] || 'restriction',
  });
}

function cleaningAvailableFrom(publicRules, selected) {
  if (selected && !Array.isArray(selected) && selected.cleaning != null) return true;
  return publicRules.some(rule => rule.type === 'streetCleaning' || rule.category === 'cleaning');
}

function buildPublicSchedules(publicRules) {
  const cleaning = [];
  const restrictions = [];
  const timeLimited = [];
  const meters = [];
  for (const rule of publicRules) {
    const schedules = Array.isArray(rule.schedules) ? rule.schedules : [];
    if (rule.type === 'streetCleaning' || rule.category === 'cleaning') {
      for (const schedule of schedules) cleaning.push({ ...schedule, type: 'streetCleaning' });
      continue;
    }
    if (rule.type === 'meter' || rule.category === 'meter') {
      for (const schedule of schedules) meters.push({ ...schedule });
      continue;
    }
    if (rule.type === 'timeLimited' || rule.category === 'timeLimit') {
      for (const schedule of schedules) timeLimited.push({ ...schedule, type: 'timeLimited' });
      continue;
    }
    if (rule.type === 'noParking' || rule.type === 'noStanding' || rule.type === 'noStopping' || rule.type === 'curbRestrictionSet') {
      for (const schedule of schedules) {
        restrictions.push({ ...schedule, type: schedule.type || rule.type });
      }
    }
  }
  return { cleaning, restrictions, timeLimited, meters };
}

function buildHighConfidenceResponse(publicCurb, selected, options = {}) {
  if (!publicCurb || typeof publicCurb.segmentId !== 'string'
    || typeof publicCurb.streetName !== 'string'
    || typeof publicCurb.sideLabel !== 'string') {
    return { protocolVersion: 2, status: 'unsupported', reason: 'candidate_incomplete' };
  }
  if (selectedHasUnresolvedConflicts(selected)) {
    return { protocolVersion: 2, status: 'unsupported', reason: 'source_unavailable' };
  }
  const publicRules = rulesFromSelected(selected);
  const cleaningAvailable = cleaningAvailableFrom(publicRules, selected);
  const response = {
    protocolVersion: 2,
    status: 'high_confidence',
    segmentId: publicCurb.segmentId,
    streetName: publicCurb.streetName,
    sideLabel: publicCurb.sideLabel,
    ruleSummary: { cleaningAvailable },
  };
  if (options.includeExtended !== true) return response;
  return {
    ...response,
    responseVersion: PUBLIC_RESPONSE_VERSION,
    cacheHit: options.cacheHit === true,
    publicRules,
    publicSchedules: buildPublicSchedules(publicRules),
  };
}

function requestIncludesExtendedResponse(request) {
  return request?.responseVersion === PUBLIC_RESPONSE_VERSION;
}

module.exports = {
  PUBLIC_RESPONSE_VERSION,
  selectedHasUnresolvedConflicts,
  rulesFromSelected,
  buildPublicSchedules,
  buildHighConfidenceResponse,
  requestIncludesExtendedResponse,
  sanitizeAlreadyPublic,
};
