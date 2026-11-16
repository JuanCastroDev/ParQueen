
'use strict';

const { toPublicRule } = require('./canonicalCurbPersistence');

const PUBLIC_RESPONSE_VERSION = 1;
const REGULATION_STATUSES = Object.freeze(['verified', 'partial', 'unknown', 'verified_empty']);

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

function hasSelectedRules(selected, publicRules) {
  if (publicRules.length > 0) return true;
  return Boolean(selected && !Array.isArray(selected) && selected.cleaning != null);
}

/**
 * Separate verified curb identity from parking-regulation confidence.
 * Empty rules are verified_empty only when the DOT lookup completed and
 * did not report a face-mismatch reason. Any other empty set is unknown.
 */
function classifyRegulationStatus(selected, options = {}) {
  if (selectedHasUnresolvedConflicts(selected)) {
    return {
      regulationStatus: 'unknown',
      regulationCompleteness: 'unknown',
      regulationAvailability: 'conflict',
    };
  }
  const publicRules = Array.isArray(options.publicRules) ? options.publicRules : rulesFromSelected(selected);
  const present = hasSelectedRules(selected, publicRules);
  const sourceState = options.dotState
    || (selected && !Array.isArray(selected) ? selected.sources?.dot?.state : null)
    || options.sourceState;
  const reasons = options.dotReasons
    || (selected && !Array.isArray(selected) ? selected.sources?.dot?.reasons : null)
    || [];
  const mismatch = Array.isArray(reasons) && reasons.includes('official_blockface_mismatch');
  const dotComplete = options.dotComplete === true || sourceState === 'complete';

  if (options.sourceUnavailable === true) {
    return {
      regulationStatus: present ? 'partial' : 'unknown',
      regulationCompleteness: 'unknown',
      regulationAvailability: 'unavailable',
    };
  }
  if (!dotComplete) {
    const incomplete = sourceState === 'incomplete' || options.dotComplete === false;
    return {
      regulationStatus: present ? 'partial' : 'unknown',
      regulationCompleteness: incomplete ? 'incomplete' : 'unknown',
      regulationAvailability: 'unavailable',
    };
  }
  if (mismatch && !present) {
    return {
      regulationStatus: 'unknown',
      regulationCompleteness: 'complete',
      regulationAvailability: 'unavailable',
    };
  }
  if (!present) {
    return {
      regulationStatus: 'verified_empty',
      regulationCompleteness: 'complete',
      regulationAvailability: 'available',
    };
  }
  return {
    regulationStatus: 'verified',
    regulationCompleteness: 'complete',
    regulationAvailability: 'available',
  };
}

function regulationsAreAuthoritative(regulationStatus) {
  return regulationStatus === 'verified';
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
  const regulation = options.regulation || classifyRegulationStatus(selected, {
    ...options,
    publicRules,
  });
  const cleaningAvailable = regulation.regulationStatus === 'verified'
    && cleaningAvailableFrom(publicRules, selected);
  const response = {
    protocolVersion: 2,
    status: 'high_confidence',
    segmentId: publicCurb.segmentId,
    streetName: publicCurb.streetName,
    sideLabel: publicCurb.sideLabel,
    ruleSummary: { cleaningAvailable },
  };
  if (options.includeExtended !== true) return response;
  const publishRules = regulation.regulationStatus === 'verified' ? publicRules : [];
  return {
    ...response,
    responseVersion: PUBLIC_RESPONSE_VERSION,
    cacheHit: options.cacheHit === true,
    identityConfidence: 'high',
    regulationStatus: regulation.regulationStatus,
    regulationCompleteness: regulation.regulationCompleteness,
    regulationAvailability: regulation.regulationAvailability,
    publicRules: publishRules,
    publicSchedules: buildPublicSchedules(publishRules),
  };
}

function requestIncludesExtendedResponse(request) {
  return request?.responseVersion === PUBLIC_RESPONSE_VERSION;
}

module.exports = {
  PUBLIC_RESPONSE_VERSION,
  REGULATION_STATUSES,
  selectedHasUnresolvedConflicts,
  rulesFromSelected,
  buildPublicSchedules,
  buildHighConfidenceResponse,
  requestIncludesExtendedResponse,
  sanitizeAlreadyPublic,
  classifyRegulationStatus,
  regulationsAreAuthoritative,
};
