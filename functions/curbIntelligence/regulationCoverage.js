'use strict';

// Category coverage contract, responseVersion 2.
// A missing rule is not an explicitly verified empty category.
// verified: the source returned evidence for this category.
// verified_empty: the source's own completeness rules prove there is nothing applicable.
// incomplete: the source answered, but the answer was truncated or unfinished.
// unknown: the source failed, timed out, mismatched the face, or cannot prove a negative.
// conflict: the selected rules disagree. The public response still withholds the whole answer.

const CATEGORIES = Object.freeze(['cleaning', 'restrictions', 'timeLimits', 'meters']);
const STATES = new Set(['verified', 'verified_empty', 'unknown', 'incomplete', 'conflict']);
const PROVEN_EMPTY_METER = new Set(['official_meter_missing', 'no_passenger_meter_rule']);

function isRegulationCoverage(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && CATEGORIES.every(key => STATES.has(value[key]));
}

function categoryFromRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  if (rule.category === 'cleaning' || rule.type === 'streetCleaning') return 'cleaning';
  if (rule.category === 'timeLimit' || rule.type === 'timeLimited') return 'timeLimits';
  if (rule.category === 'meter' || rule.type === 'meter') return 'meters';
  if (rule.category === 'restriction' || rule.type === 'noParking' || rule.type === 'noStanding'
    || rule.type === 'noStopping' || rule.type === 'curbRestrictionSet') return 'restrictions';
  return null;
}

function rulesFor(selected, category) {
  const rules = Array.isArray(selected?.rules) ? selected.rules : [];
  return rules.filter(rule => categoryFromRule(rule) === category);
}

function dotMode(dot) {
  if (!dot || dot.state === 'unavailable' || !dot.state) {
    if (dot?.reason === 'candidate_source_incomplete' || dot?.reason === 'source_truncated') return 'incomplete';
    return 'unknown';
  }
  return dot.state === 'complete' ? 'complete' : 'incomplete';
}

function dotCategory(dot, selected, category) {
  const mode = dotMode(dot);
  if (mode !== 'complete') return mode;
  const conflictName = category === 'restrictions' ? 'restriction'
    : category === 'timeLimits' ? 'timeLimit' : category;
  const conflicts = Array.isArray(selected?.conflicts) ? selected.conflicts : [];
  if (conflicts.some(conflict => conflict?.category === conflictName || conflict?.category === category)) {
    return 'conflict';
  }
  const present = rulesFor(selected, category).length > 0
    || (category === 'cleaning' && selected?.cleaning != null);
  const mismatch = Array.isArray(dot?.reasons) && dot.reasons.includes('official_blockface_mismatch');
  if (mismatch && !present) return 'unknown';
  return present ? 'verified' : 'verified_empty';
}

function meterCategory(park) {
  if (!park) return 'unknown';
  if (park.state === 'supported' && park.product) return 'verified';
  if (park.state === 'unavailable' || park.state == null) {
    if (park.reason === 'candidate_source_incomplete' || park.reason === 'source_truncated') return 'incomplete';
    return 'unknown';
  }
  if (park.event === 'meter_no_match' && PROVEN_EMPTY_METER.has(park.reason)) return 'verified_empty';
  return 'unknown';
}

function classifyRegulationCoverage(sources = {}, selected = {}) {
  const dot = sources?.dot || selected?.sources?.dot || null;
  const park = sources?.parkNyc || sources?.park || selected?.sources?.parkNyc || null;
  return {
    cleaning: dotCategory(dot, selected, 'cleaning'),
    restrictions: dotCategory(dot, selected, 'restrictions'),
    timeLimits: dotCategory(dot, selected, 'timeLimits'),
    meters: meterCategory(park),
  };
}

function summarizeRegulationCoverage(coverage) {
  const values = CATEGORIES.map(key => coverage[key]);
  const settled = value => value === 'verified' || value === 'verified_empty';
  if (values.some(value => value === 'conflict')) {
    return {
      regulationStatus: 'unknown',
      regulationCompleteness: 'unknown',
      regulationAvailability: 'conflict',
    };
  }
  if (values.every(settled)) {
    if (values.every(value => value === 'verified_empty')) {
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
  if (values.some(settled)) {
    return {
      regulationStatus: 'partial',
      regulationCompleteness: 'incomplete',
      regulationAvailability: 'unavailable',
    };
  }
  if (values.some(value => value === 'incomplete')) {
    return {
      regulationStatus: 'unknown',
      regulationCompleteness: 'incomplete',
      regulationAvailability: 'unavailable',
    };
  }
  return {
    regulationStatus: 'unknown',
    regulationCompleteness: 'unknown',
    regulationAvailability: 'unavailable',
  };
}

function publishableRules(rules, coverage) {
  return (Array.isArray(rules) ? rules : []).filter(rule => coverage[categoryFromRule(rule)] === 'verified');
}

module.exports = {
  CATEGORIES,
  isRegulationCoverage,
  classifyRegulationCoverage,
  summarizeRegulationCoverage,
  publishableRules,
  categoryFromRule,
};
