import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  buildStreetRulesClosedCandidate,
  streetRulesReadDiff,
  loadProductionRules,
  STREET_RULES_MIGRATION_PLAN,
} = require('./streetRulesCandidate');

describe('streetRules candidate diff', () => {
  it('changes only the two streetRules read clauses in the complete ruleset', () => {
    const source = loadProductionRules();
    const candidate = buildStreetRulesClosedCandidate(source);
    expect(candidate).not.toBe(source);
    expect(source).toMatch(/match \/streetRules\/\{ruleId\} \{\s*allow read: if true;/);
    expect(candidate).toMatch(/match \/streetRules\/\{ruleId\} \{\s*allow read: if false;/);
    expect(candidate).toMatch(/match \/\{path=\*\*\}\/streetRules\/\{ruleId\} \{\s*allow read: if false;/);
    expect(candidate).toMatch(/match \/streetSegments\/\{segmentId\} \{\s*allow read: if true;/);
    const diff = streetRulesReadDiff(source, candidate);
    expect(diff).toEqual([
      expect.objectContaining({ from: expect.stringContaining('allow read: if true;'), to: expect.stringContaining('allow read: if false;') }),
      expect.objectContaining({ from: expect.stringContaining('allow read: if true;'), to: expect.stringContaining('allow read: if false;') }),
    ]);
    expect(diff).toHaveLength(2);
    expect(STREET_RULES_MIGRATION_PLAN.rulesFileChanged).toBe(false);
    expect(STREET_RULES_MIGRATION_PLAN.founderApprovalRequired).toBe(true);
    expect(STREET_RULES_MIGRATION_PLAN.rollback.join(' ')).toMatch(/version 1/);
    expect(STREET_RULES_MIGRATION_PLAN.rollback.join(' ')).toMatch(/pq_saved_spot/);
  });
});
