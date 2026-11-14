'use strict';

const { Timestamp } = require('firebase-admin/firestore');

const {
  classifyLockForExpectedClaim,
  expectedClaimFromSpot,
  LOCK_MATCH,
} = require('./claimLockIdentity');

const SPOT = 'spot-1';
const GEN_A = 'a1'.repeat(32);
const GEN_B = 'b2'.repeat(32);
const LEGACY = { seconds: 1_700_000_000, nanoseconds: 123_456_000 };
const STORED_LEGACY = new Timestamp(LEGACY.seconds, LEGACY.nanoseconds);

describe('F1 claim-lock identity classifier', () => {
  test('F1-01: modern Ping and exact generation lock match', () => {
    expect(classifyLockForExpectedClaim(
      { spotId: SPOT, claimGenerationId: GEN_A },
      { kind: 'generation', spotId: SPOT, claimGenerationId: GEN_A },
    )).toBe(LOCK_MATCH.EXACT);
  });

  test('F1-02: same-Ping different modern generation conflicts', () => {
    expect(classifyLockForExpectedClaim(
      { spotId: SPOT, claimGenerationId: GEN_B },
      { kind: 'generation', spotId: SPOT, claimGenerationId: GEN_A },
    )).toBe(LOCK_MATCH.SAME_SPOT_CONFLICT);
  });

  test('F1-03: modern Ping with a same-Ping legacy lock conflicts', () => {
    expect(classifyLockForExpectedClaim(
      { spotId: SPOT, claimStartedAt: STORED_LEGACY },
      { kind: 'generation', spotId: SPOT, claimGenerationId: GEN_A },
    )).toBe(LOCK_MATCH.SAME_SPOT_CONFLICT);
  });

  test('F1-04: exact legacy seconds and nanoseconds match', () => {
    expect(classifyLockForExpectedClaim(
      { spotId: SPOT, claimStartedAt: STORED_LEGACY },
      { kind: 'legacy', spotId: SPOT, claimStartedAt: LEGACY },
    )).toBe(LOCK_MATCH.EXACT);
  });

  test('F1-05: legacy nanosecond mismatch conflicts', () => {
    expect(classifyLockForExpectedClaim(
      { spotId: SPOT, claimStartedAt: new Timestamp(LEGACY.seconds, LEGACY.nanoseconds + 1) },
      { kind: 'legacy', spotId: SPOT, claimStartedAt: LEGACY },
    )).toBe(LOCK_MATCH.SAME_SPOT_CONFLICT);
  });

  test('F1-06: absent lock is missing', () => {
    expect(classifyLockForExpectedClaim(
      null,
      { kind: 'generation', spotId: SPOT, claimGenerationId: GEN_A },
    )).toBe(LOCK_MATCH.MISSING);
  });

  test('F1-07: lock naming another Ping is unrelated', () => {
    expect(classifyLockForExpectedClaim(
      { spotId: 'spot-2', claimGenerationId: GEN_A },
      { kind: 'generation', spotId: SPOT, claimGenerationId: GEN_A },
    )).toBe(LOCK_MATCH.UNRELATED_SPOT);
  });

  test.each([
    [{ spotId: SPOT, claimGenerationId: 'bad' }, { kind: 'generation', spotId: SPOT, claimGenerationId: GEN_A }],
    [{ spotId: SPOT }, { kind: 'legacy', spotId: SPOT, claimStartedAt: LEGACY }],
    [{ spotId: SPOT, claimStartedAt: STORED_LEGACY }, { kind: 'generation', spotId: SPOT, claimGenerationId: 'bad' }],
  ])('F1-08: malformed or identity-less same-Ping state fails closed', (lock, expected) => {
    expect(classifyLockForExpectedClaim(lock, expected)).toBe(LOCK_MATCH.MALFORMED);
  });

  test.each([
    ['plain map', { ...LEGACY }],
    ['missing Timestamp behavior', { seconds: LEGACY.seconds, nanoseconds: LEGACY.nanoseconds }],
    ['unsafe seconds', { seconds: Number.MAX_SAFE_INTEGER + 1, nanoseconds: 0, toMillis() { return 0; } }],
    ['negative nanoseconds', { seconds: LEGACY.seconds, nanoseconds: -1, toMillis() { return 0; } }],
    ['excess nanoseconds', { seconds: LEGACY.seconds, nanoseconds: 1_000_000_000, toMillis() { return 0; } }],
    ['fractional seconds', { seconds: LEGACY.seconds + 0.5, nanoseconds: 0, toMillis() { return 0; } }],
    ['fractional nanoseconds', { seconds: LEGACY.seconds, nanoseconds: 1.5, toMillis() { return 0; } }],
    ['null', null],
    ['absent', undefined],
  ])('F1-11: rejects %s as an authoritative stored legacy timestamp', (_label, stored) => {
    expect(classifyLockForExpectedClaim(
      { spotId: SPOT, claimStartedAt: stored },
      { kind: 'legacy', spotId: SPOT, claimStartedAt: LEGACY },
    )).toBe(LOCK_MATCH.MALFORMED);
  });

  test('F1-12: a stored plain-map Ping cannot establish expected legacy authority', () => {
    expect(expectedClaimFromSpot(SPOT, { claimStartedAt: { ...LEGACY } })).toBeNull();
    expect(expectedClaimFromSpot(SPOT, { claimStartedAt: STORED_LEGACY })).toEqual({
      kind: 'legacy', spotId: SPOT, claimStartedAt: LEGACY,
    });
  });

  test('F1-13: a generation-bearing claim cannot be offered through legacy identity', () => {
    expect(classifyLockForExpectedClaim(
      { spotId: SPOT, claimStartedAt: STORED_LEGACY },
      { kind: 'legacy', spotId: SPOT, claimStartedAt: LEGACY, claimGenerationId: GEN_A },
    )).toBe(LOCK_MATCH.MALFORMED);
  });
});
