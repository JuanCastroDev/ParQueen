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
    const arm = rules.slice(rules.indexOf('Arm 2b:'), rules.indexOf('Arm 3:'));
    for (const key of Object.keys(patch)) {
      expect(arm).toContain(`'${key}'`);
    }
    expect(arm).not.toContain("'claimStartedAt'");
    expect(arm).not.toContain("'interestedUserId'");
  });
});
