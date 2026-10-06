import { describe, expect, it } from 'vitest';
import {
  selectFinderPendingHandoff,
  selectUnfinishedHandoff,
  terminalSpotIdsFromFeedback,
} from './unfinishedHandoff';

const uid = 'claimer-1';
const arrived = {
  lat: 40.7,
  lng: -73.9,
  address: '1 Main St',
  finderId: 'finder-1',
  finderName: 'Finder',
  geohash: 'dr5reg',
  status: 'occupied',
  claimState: 'arrived_pending_outcome',
  interestedUserId: uid,
  arrivedAt: { toMillis: () => 5_000 },
};

function feedback(outcome: string, spotId = 'spot-1') {
  return { data: () => ({ spotId, userId: uid, outcome, finderId: 'finder-1' }) };
}

describe('Finish-your-handoff resume invariant', () => {
  it('ignores participant_success on the claimer doc and the finder doc', () => {
    const terminal = terminalSpotIdsFromFeedback([
      feedback('participant_success'),
      feedback('participant_success', 'spot-1'),
      { data: () => ({ spotId: 'spot-1', userId: uid, outcome: 'participant_success', role: 'finder' }) },
    ]);
    expect(terminal.has('spot-1')).toBe(false);
    expect(selectUnfinishedHandoff(
      [{ id: 'spot-1', data: arrived }],
      terminal,
      uid,
    )?.id).toBe('spot-1');
  });

  it('keeps a one-sided attestation recoverable and drops failed, completed_success, and unconfirmed', () => {
    expect(selectUnfinishedHandoff(
      [{ id: 'spot-1', data: arrived }],
      terminalSpotIdsFromFeedback([feedback('participant_success')]),
      uid,
    )?.id).toBe('spot-1');

    expect(selectUnfinishedHandoff(
      [{ id: 'spot-1', data: arrived }],
      terminalSpotIdsFromFeedback([feedback('failed')]),
      uid,
    )).toBeNull();

    expect(selectUnfinishedHandoff(
      [{ id: 'spot-1', data: arrived }],
      terminalSpotIdsFromFeedback([feedback('success')]),
      uid,
    )).toBeNull();

    expect(selectUnfinishedHandoff(
      [{ id: 'spot-1', data: { ...arrived, claimState: 'completed_success' } }],
      new Set(),
      uid,
    )).toBeNull();

    expect(selectUnfinishedHandoff(
      [{ id: 'spot-1', data: { ...arrived, claimState: 'unconfirmed' } }],
      new Set(),
      uid,
    )).toBeNull();
  });
});


describe('finder-side pending handoff recovery', () => {
  const finderUid = 'finder-1';

  it('surfaces the latest occupied arrived handoff owned by the finder', () => {
    const older = {
      ...arrived,
      interestedUserId: 'claimer-old',
      interestedUserName: 'Older Driver',
      arrivedAt: { toMillis: () => 4_000 },
    };
    const newer = {
      ...arrived,
      interestedUserId: 'claimer-new',
      interestedUserName: 'New Driver',
      arrivedAt: { toMillis: () => 9_000 },
    };

    expect(selectFinderPendingHandoff([
      { id: 'older', data: older },
      { id: 'newer', data: newer },
    ], finderUid)).toEqual({
      id: 'newer',
      address: '1 Main St',
      claimerId: 'claimer-new',
      claimerName: 'New Driver',
      arrivedAtMs: 9_000,
    });
  });

  it('ignores non-arrived, terminal, unrelated, and self-claim rows', () => {
    expect(selectFinderPendingHandoff([
      { id: 'heading', data: { ...arrived, status: 'interested', claimState: 'heading' } },
      { id: 'done', data: { ...arrived, claimState: 'completed_success' } },
      { id: 'timeout', data: { ...arrived, claimState: 'unconfirmed' } },
      { id: 'other-finder', data: { ...arrived, finderId: 'finder-2' } },
      { id: 'self', data: { ...arrived, interestedUserId: finderUid } },
    ], finderUid)).toBeNull();
  });
});
