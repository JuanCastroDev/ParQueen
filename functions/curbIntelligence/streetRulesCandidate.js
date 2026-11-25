'use strict';

const { readFileSync } = require('node:fs');
const path = require('node:path');

const NESTED_MATCH = '      match /streetRules/{ruleId} {';
const GROUP_MATCH = '    match /{path=**}/streetRules/{ruleId} {';
const ALLOW_TRUE = 'allow read: if true;';
const ALLOW_FALSE = 'allow read: if false;';

function replaceFollowingRead(source, matchLine) {
  const at = source.indexOf(matchLine);
  if (at < 0 || source.indexOf(matchLine, at + matchLine.length) !== -1) {
    throw new Error(`streetRules candidate anchor is missing or repeated: ${matchLine.trim()}`);
  }
  const allowAt = source.indexOf(ALLOW_TRUE, at + matchLine.length);
  const boundary = source.indexOf('match /', at + matchLine.length);
  if (allowAt < 0 || (boundary !== -1 && allowAt > boundary)) {
    throw new Error(`streetRules read clause was not found in ${matchLine.trim()}`);
  }
  return `${source.slice(0, allowAt)}${ALLOW_FALSE}${source.slice(allowAt + ALLOW_TRUE.length)}`;
}

function buildStreetRulesClosedCandidate(source) {
  return replaceFollowingRead(replaceFollowingRead(source, NESTED_MATCH), GROUP_MATCH);
}

function streetRulesReadDiff(source, candidate) {
  const before = source.split(/\r?\n/);
  const after = candidate.split(/\r?\n/);
  const changes = [];
  const limit = Math.max(before.length, after.length);
  for (let index = 0; index < limit; index += 1) {
    if (before[index] !== after[index]) {
      changes.push({ line: index + 1, from: before[index] ?? null, to: after[index] ?? null });
    }
  }
  return changes;
}

function loadProductionRules(root = path.resolve(__dirname, '../..')) {
  return readFileSync(path.join(root, 'firestore.rules'), 'utf8');
}

const STREET_RULES_MIGRATION_PLAN = Object.freeze({
  rulesFileChanged: false,
  founderApprovalRequired: true,
  executed: false,
  productPath: 'off',
  androidReleaseGate: 'off',
  version1Schedules: 'suppressed',
  offlineSavedSpotsRemain: true,
  order: Object.freeze([
    'Founder-signed Functions provenance.',
    'Approved deployment of the new admin views.',
    'Verified admin client rollout.',
    'Founder approval of the separate two-line Firestore rules change.',
    'Full candidate-rules regression acceptance.',
    'Production rules deployment only after all preceding gates pass.',
  ]),
  rollback: Object.freeze([
    'Restore the two allow read: if true lines. That rollback does not publish version 1 schedules.',
    'Leave CURB_ANDROID_RELEASE_GATE off and do not turn CURB_PRODUCT_PATH on to compensate.',
    'Do not delete pq_saved_spot. Closing or reopening server reads does not erase a schedule already stored on a phone.',
  ]),
});

module.exports = {
  buildStreetRulesClosedCandidate,
  streetRulesReadDiff,
  loadProductionRules,
  STREET_RULES_MIGRATION_PLAN,
};
