import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildHeadingUpdate, decideCommitToHeading } from './commitToHeadingDecision';

const uid = 'claimer-1';

describe('decideCommitToHeading', () => {
  it('commits only a committed interested claim held by this user', () => {
    expect(decideCommitToHeading({
      status: 'interested',
      interestedUserId: uid,
      claimState: 'committed',
    }, uid)).toBe('commit');
  });

  it('treats an existing heading claim as idempotent success', () => {
    expect(decideCommitToHeading({
      status: 'interested',
      interestedUserId: uid,
      claimState: 'heading',
    }, uid)).toBe('already_heading');
  });

  it('rejects a released Ping so a stale commit cannot resurrect it', () => {
    expect(decideCommitToHeading({
      status: 'available',
      interestedUserId: null,
      claimState: null,
    }, uid)).toBe('rejected');
    expect(decideCommitToHeading({
      status: 'interested',
      interestedUserId: null,
      claimState: null,
    }, uid)).toBe('rejected');
  });

  it('rejects a different claimer, a missing spot, and a non-committed state', () => {
    expect(decideCommitToHeading({
      status: 'interested',
      interestedUserId: 'someone-else',
      claimState: 'committed',
    }, uid)).toBe('rejected');
    expect(decideCommitToHeading(null, uid)).toBe('rejected');
    expect(decideCommitToHeading({
      status: 'interested',
      interestedUserId: uid,
      claimState: null,
    }, uid)).toBe('rejected');
    expect(decideCommitToHeading({
      status: 'interested',
      interestedUserId: uid,
      claimState: 'committed',
    }, '')).toBe('rejected');
  });
});

describe('buildHeadingUpdate', () => {
  it('stays inside the Arm 2b onlyChanges list', () => {
    const patch = buildHeadingUpdate(5, { marker: 'expiry' });
    expect(Object.keys(patch)).toEqual([
      'claimState',
      'ownerLeavingNow',
      'ownerLeavingNowAt',
      'etaMinutes',
      'interestExpiresAt',
      'claimReminderAt',
      'claimReminderSentAt',
      'claimAutoReleaseAt',
    ]);
    expect(patch).toEqual({
      claimState: 'heading',
      ownerLeavingNow: null,
      ownerLeavingNowAt: null,
      etaMinutes: 5,
      interestExpiresAt: { marker: 'expiry' },
      claimReminderAt: null,
      claimReminderSentAt: null,
      claimAutoReleaseAt: null,
    });

    const rules = readFileSync('firestore.rules', 'utf8');
    const start = rules.indexOf('// Arm 2b:');
    expect(start, 'Arm 2b marker').toBeGreaterThan(-1);
    // Arm 3 is written earlier in the file. The section after Arm 2b is Arm 3b.
    const end = rules.indexOf('// Arm 3b:', start + '// Arm 2b:'.length);
    expect(end, 'Arm 2b following boundary').toBeGreaterThan(start);
    const arm = rules.slice(start, end);
    expect(arm).not.toContain('// Arm 3:');
    expect(arm).toContain("request.resource.data.claimState == 'heading'");

    const listMatch = arm.match(/onlyChanges\(\[([\s\S]*?)\]\)/);
    expect(listMatch).not.toBeNull();
    const allowed = [...listMatch![1].matchAll(/'([^']+)'/g)].map((match) => match[1]);
    const covers = (list: string[], keys: string[]) => keys.every((key) => list.includes(key));
    const keys = Object.keys(patch);
    expect(covers(allowed, keys)).toBe(true);
    expect(allowed).not.toContain('claimStartedAt');
    expect(allowed).not.toContain('interestedUserId');
    expect(covers(allowed.filter((field) => field !== 'claimState'), keys)).toBe(false);
  });
});
