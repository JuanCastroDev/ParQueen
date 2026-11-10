import { describe, expect, it } from 'vitest';
import { evaluateWriteAuthority, filterAuthoritativeRules, segmentAllowsAuthoritativeRead } from './canonicalCurbWriteAuthority';

const generationId = 'b'.repeat(32);

describe('client write authority', () => {
  it('rejects a direct reader late or malformed result', () => {
    const late = { writeAuthority: { scheme: 1, generationId, deadlineAtMs: 50, committedAt: { toMillis: () => 50 } } };
    const malformed = { writeAuthority: { scheme: 1, generationId, deadlineAtMs: 50 } };
    expect(segmentAllowsAuthoritativeRead(late).ok).toBe(false);
    expect(filterAuthoritativeRules(late, [{ id: 'r1', writeAuthority: late.writeAuthority }])).toEqual({
      ok: false, rules: [], reason: 'committed_at_or_after_deadline', status: 'reject',
    });
    expect(filterAuthoritativeRules(malformed, [{ id: 'r1' }]).ok).toBe(false);
  });

  it('keeps legacy documents without metadata readable', () => {
    const segment = { streetName: 'MARAN PLACE' };
    const rules = [{ id: 'legacy-rule' }];
    expect(evaluateWriteAuthority(undefined).status).toBe('legacy');
    expect(filterAuthoritativeRules(segment, rules)).toEqual({
      ok: true, rules, reason: null, status: 'legacy',
    });
  });
});