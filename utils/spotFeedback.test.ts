import { describe, expect, it } from 'vitest';
import {
  buildParticipantSuccessAttestation,
  isDurableArrival,
  isMatchingParticipantAttestation,
  participantSuccessFeedbackId,
  spotFeedbackDocId,
} from './spotFeedback';

describe('spotFeedbackDocId', () => {
  it('binds one feedback document to a spot and driver pair', () => {
    expect(spotFeedbackDocId('spot-123', 'driver-456')).toBe('spot-123_driver-456');
  });

  it('rejects identifiers that could escape the Firestore document path', () => {
    expect(() => spotFeedbackDocId('spot/123', 'driver-456')).toThrow('Invalid feedback identifier');
    expect(() => spotFeedbackDocId('spot-123', '')).toThrow('Invalid feedback identifier');
  });
});

describe('participant success attestation shape', () => {
  const arrivedAt = { toMillis: () => 1_700_000_000_000 };

  it('treats only occupied arrived_pending_outcome with a timestamp as durable', () => {
    expect(isDurableArrival({
      status: 'occupied',
      claimState: 'arrived_pending_outcome',
      arrivedAt,
    })).toBe(true);
    expect(isDurableArrival({ status: 'interested', claimState: 'heading', arrivedAt })).toBe(false);
    expect(isDurableArrival({
      status: 'occupied',
      claimState: 'arrived_pending_outcome',
      arrivedAt: null,
    })).toBe(false);
    expect(isDurableArrival({
      status: 'occupied',
      claimState: 'completed_success',
      arrivedAt,
    })).toBe(false);
  });

  it('builds a claimer doc and a finder doc that both name the claimer as userId', () => {
    expect(participantSuccessFeedbackId('spot-1', 'claimer-1', 'claimer')).toBe('spot-1_claimer-1');
    expect(participantSuccessFeedbackId('spot-1', 'claimer-1', 'finder')).toBe('spot-1_claimer-1_finder');

    const createdAt = { toMillis: () => 1_700_000_000_100 };
    const claimer = buildParticipantSuccessAttestation({
      spotId: 'spot-1',
      claimerId: 'claimer-1',
      finderId: 'finder-1',
      address: 'A'.repeat(600),
      role: 'claimer',
      createdAt,
    });
    expect(claimer).toEqual({
      spotId: 'spot-1',
      userId: 'claimer-1',
      finderId: 'finder-1',
      outcome: 'participant_success',
      role: 'claimer',
      failureReason: null,
      address: 'A'.repeat(500),
      createdAt,
    });
    expect(claimer.outcome).not.toBe('success');
    expect(claimer).not.toHaveProperty('crowns');

    const finder = buildParticipantSuccessAttestation({
      spotId: 'spot-1',
      claimerId: 'claimer-1',
      finderId: 'finder-1',
      address: '1 Main St',
      role: 'finder',
      createdAt,
    });
    expect(finder.userId).toBe('claimer-1');
    expect(finder.role).toBe('finder');
    expect(finder.outcome).toBe('participant_success');
    expect(isMatchingParticipantAttestation(finder, finder)).toBe(true);
    expect(isMatchingParticipantAttestation({ ...finder, outcome: 'success' }, finder)).toBe(false);
    expect(isMatchingParticipantAttestation({ ...finder, outcome: 'failed' }, finder)).toBe(false);
  });
});
