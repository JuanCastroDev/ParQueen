'use strict';

function fingerprint(rule) {
  if (!rule) return null;
  if (rule.category === 'cleaning') return JSON.stringify(rule.schedules || []);
  return JSON.stringify({
    category: rule.category,
    type: rule.type || null,
    schedules: rule.schedules || [],
    maxStayMinutes: rule.maxStayMinutes || null,
  });
}

function uniqueRules(rules) {
  return [...new Map(rules.map(rule => [fingerprint(rule), rule])).values()];
}

function selectRuleSet(sourceResults = {}) {
  const dot = sourceResults.dot || { state: 'unavailable', rules: [] };
  const sweep = sourceResults.sweepNyc || { state: 'unavailable', rules: [] };
  const park = sourceResults.parkNyc || { state: 'unavailable', product: null };
  const admin = sourceResults.admin || { state: 'complete', rules: [] };
  const dotRules = Array.isArray(dot.rules) ? dot.rules : [];
  const sweepRules = Array.isArray(sweep.rules) ? sweep.rules : [];
  const conflicts = [];

  const dotCleaning = uniqueRules(dotRules.filter(rule => rule?.category === 'cleaning'));
  const sweepCleaning = uniqueRules(sweepRules.filter(rule => rule?.category === 'cleaning'));
  let cleaning = null;
  if (dotCleaning.length > 1 || dot.conflicts?.includes('cleaning')) {
    conflicts.push({
      category: 'cleaning',
      sources: ['dot'],
      outcome: 'omitted_authoritative_conflict',
    });
  } else if (dot.state === 'complete') {
    cleaning = dotCleaning[0] || null;
    if (cleaning && sweep.state === 'exact' && sweepCleaning.length
      && fingerprint(cleaning) !== fingerprint(sweepCleaning[0])) {
      conflicts.push({
        category: 'cleaning',
        sources: ['dot', 'sweepNyc'],
        outcome: 'dot_selected',
      });
    }
  } else if (dot.state === 'unavailable' && sweep.state === 'exact') {
    if (sweepCleaning.length === 1) cleaning = sweepCleaning[0];
    else if (sweepCleaning.length > 1) {
      conflicts.push({
        category: 'cleaning',
        sources: ['sweepNyc'],
        outcome: 'omitted_authoritative_conflict',
      });
    }
  }

  const blocked = new Set(Array.isArray(dot.conflicts) ? dot.conflicts : []);
  const restrictions = blocked.has('restriction') ? []
    : uniqueRules(dotRules.filter(rule => rule?.category === 'restriction'));
  const timeLimits = blocked.has('timeLimit') ? []
    : uniqueRules(dotRules.filter(rule => rule?.category === 'timeLimit'));
  const meter = park.state === 'supported' && park.product ? park.product : null;
  const adminRules = admin.state === 'complete' && Array.isArray(admin.rules)
    ? uniqueRules(admin.rules) : [];
  const rules = [
    ...(cleaning ? [cleaning] : []),
    ...restrictions,
    ...timeLimits,
    ...(meter ? [meter] : []),
    ...adminRules,
  ];
  return { cleaning, restrictions, timeLimits, meter, admin: adminRules, conflicts, rules };
}

module.exports = { selectRuleSet };
