'use strict';

const {
  TWO_HOURS_MS,
  isMutualSuccessPair,
  isClaimerAuthoritativeSuccess,
  isTimelyAttestation,
  claimerAttestationId,
  finderAttestationId,
} = require('./handoffSuccessContract');

const NOW = 1_800_000_000_000;

function at(millis) {
  return { toMillis: () => millis };
}

function spot(overrides = {}) {
  return {
    status: 'occupied',
    claimState: 'arrived_pending_outcome',
    arrivedAt: at(NOW - 60_000),
    interestedUserId: 'claimer',
    finderId: 'finder',
    claimGenerationId: '11111111-1111-4111-8111-111111111111',
    ...overrides,
  };
}

function attestation(role, createdAtMs) {
  return {
    spotId: 'spot',
    userId: 'claimer',
    finderId: 'finder',
    outcome: 'participant_success',
    role,
    createdAt: at(createdAtMs),
  };
}

describe('handoff success contract', () => {
  it('treats exactly two hours as timely and one millisecond later as late', () => {
    const arrivedAtMs = NOW - TWO_HOURS_MS;
    expect(isTimelyAttestation(attestation('claimer', arrivedAtMs + TWO_HOURS_MS), arrivedAtMs)).toBe(true);
    expect(isTimelyAttestation(attestation('claimer', arrivedAtMs + TWO_HOURS_MS + 1), arrivedAtMs)).toBe(false);
  });

  it('requires both timely participant attestations and matching identities', () => {
    const arrived = spot();
    const created = NOW - 30_000;
    const pair = {
      spotId: 'spot',
      claimerId: 'claimer',
      finderId: 'finder',
      claimerDocId: claimerAttestationId('spot', 'claimer'),
      claimerData: attestation('claimer', created),
      finderDocId: finderAttestationId('spot', 'claimer'),
      finderData: attestation('finder', created),
      spot: arrived,
    };
    expect(isMutualSuccessPair(pair)).toBe(true);
    expect(isMutualSuccessPair({ ...pair, finderData: null })).toBe(false);
    expect(isMutualSuccessPair({
      ...pair,
      claimerData: { ...pair.claimerData, outcome: 'success' },
    })).toBe(false);
    expect(isMutualSuccessPair({
      ...pair,
      claimerData: { ...pair.claimerData, finderId: 'other' },
    })).toBe(false);
    expect(isMutualSuccessPair({
      ...pair,
      finderId: 'claimer',
      claimerData: { ...pair.claimerData, finderId: 'claimer' },
      finderData: { ...pair.finderData, finderId: 'claimer' },
      spot: spot({ finderId: 'claimer', interestedUserId: 'claimer' }),
    })).toBe(false);
    expect(isMutualSuccessPair({
      ...pair,
      spot: spot({ claimState: 'unconfirmed' }),
    })).toBe(false);
    expect(isMutualSuccessPair({
      ...pair,
      spot: spot({ claimState: 'completed_success' }),
    })).toBe(false);
  });

  it('accepts one timely claimer attestation bound to the current generation', () => {
    const arrived = spot();
    const claimerData = {
      ...attestation('claimer', NOW - 30_000),
      claimGenerationId: arrived.claimGenerationId,
    };
    expect(isClaimerAuthoritativeSuccess({
      spotId: 'spot',
      claimerId: 'claimer',
      finderId: 'finder',
      claimerDocId: claimerAttestationId('spot', 'claimer'),
      claimerData,
      spot: arrived,
    })).toBe(true);
    expect(isClaimerAuthoritativeSuccess({
      spotId: 'spot',
      claimerId: 'claimer',
      finderId: 'finder',
      claimerDocId: claimerAttestationId('spot', 'claimer'),
      claimerData: { ...claimerData, claimGenerationId: '22222222-2222-4222-8222-222222222222' },
      spot: arrived,
    })).toBe(false);
  });

  it('keeps legacy clients compatible only for generation-less historical arrivals', () => {
    const arrived = spot({ claimGenerationId: null });
    const input = {
      spotId: 'spot',
      claimerId: 'claimer',
      finderId: 'finder',
      claimerDocId: claimerAttestationId('spot', 'claimer'),
      claimerData: attestation('claimer', NOW - 30_000),
      spot: arrived,
    };
    expect(isClaimerAuthoritativeSuccess(input)).toBe(true);
    expect(isClaimerAuthoritativeSuccess({
      ...input,
      claimerData: attestation('claimer', NOW - 120_000),
    })).toBe(false);
    expect(isClaimerAuthoritativeSuccess({
      ...input,
      spot: spot(),
    })).toBe(false);
  });
});
