'use strict';

async function persistPublicRestrictionRules({ db, Timestamp, segmentId, lookup } = {}) {
  if (!db || !segmentId) return null;
  const now = Timestamp.now();
  const rules = lookup?.state === 'supported' && Array.isArray(lookup.rules) ? lookup.rules : [];
  await db.doc(`streetSegments/${segmentId}/streetRules/dot_restrictions_v1`).set({
    type: 'curbRestrictionSet',
    source: 'nyc_open_data',
    status: rules.length ? 'active' : 'evaluated_empty',
    restrictionSchemaVersion: 1,
    effectiveDate: now,
    supersededAt: null,
    rules,
    schedules: rules.flatMap(rule => (rule.schedules || []).map(schedule => ({
      ...schedule,
      type: rule.type,
      restrictionLevel: rule.restrictionLevel,
      ...(Number.isInteger(rule.meterTerms?.maxStayMinutes)
        ? { hourLimit: rule.meterTerms.maxStayMinutes / 60 }
        : {}),
    }))),
    lastSourceSync: new Date().toISOString(),
    createdAt: now,
    updatedAt: now,
  });
  return { success: true, segmentId, ruleCount: rules.length };
}

module.exports = { persistPublicRestrictionRules };
