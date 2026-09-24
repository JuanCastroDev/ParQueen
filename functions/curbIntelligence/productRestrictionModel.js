'use strict';

const EVENTS = Object.freeze({
  LOOKUP_ATTEMPTED: 'restriction_lookup_attempted',
  SUPPORTED: 'restriction_supported',
  NO_MATCH: 'restriction_no_match',
  UNCERTAIN_SIDE: 'restriction_uncertain_side',
  UNCERTAIN_EXTENT: 'restriction_uncertain_extent',
  PARSE_FAILED: 'restriction_parse_failed',
  OMITTED: 'restriction_omitted',
  ACTIVE: 'restriction_active',
  DEADLINE_SELECTED: 'restriction_deadline_selected',
});

const { emitStructuredLog } = require('../streetIntelStructuredLog');

function logRestrictionEvent(result, write) {
  const event = result?.event || EVENTS.OMITTED;
  const payload = {
    message: event,
    event,
    domain: 'street_intel_restriction',
    state: result?.state || 'omitted',
  };
  if (typeof result?.reason === 'string' && result.reason) payload.reason = result.reason;
  if (Number.isInteger(result?.ruleCount)) payload.ruleCount = result.ruleCount;
  if (Number.isInteger(result?.windowCount)) payload.windowCount = result.windowCount;
  emitStructuredLog(payload, write);
  return payload;
}

module.exports = { RESTRICTION_EVENTS: EVENTS, logRestrictionEvent };
