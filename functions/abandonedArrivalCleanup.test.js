'use strict';

const {
  TWO_HOURS_MS,
  isEligibleAbandonedArrival,
  isLegacyOccupiedMissingArrivedAt,
  formatAbandonedArrivalSweepLog,
} = require('./abandonedArrivalCleanup');

const NOW = 1_800_000_000_000;

function at(millis) {
  return { toMillis: () => millis };
}

function arrived(overrides = {}) {
  return {
    status: 'occupied',
    claimState: 'arrived_pending_outcome',
    arrivedAt: at(NOW - TWO_HOURS_MS - 1),
    interestedUserId: 'claimer',
    finderId: 'finder',
    ...overrides,
  };
}

describe('abandoned arrival eligibility', () => {
  it('closes only an occupied arrived handoff strictly older than 2 hours', () => {
    expect(isEligibleAbandonedArrival(arrived(), NOW)).toBe(true);
    expect(isEligibleAbandonedArrival(arrived({
      arrivedAt: at(NOW - TWO_HOURS_MS),
    }), NOW)).toBe(false);
    expect(isEligibleAbandonedArrival(arrived({
      arrivedAt: at(NOW - TWO_HOURS_MS + 1),
    }), NOW)).toBe(false);
    expect(isEligibleAbandonedArrival(arrived({
      arrivedAt: at(NOW + 60_000),
    }), NOW)).toBe(false);
    expect(isEligibleAbandonedArrival(arrived({ status: 'interested' }), NOW)).toBe(false);
    expect(isEligibleAbandonedArrival(arrived({ claimState: 'heading' }), NOW)).toBe(false);
    expect(isEligibleAbandonedArrival(arrived({ claimState: 'unconfirmed' }), NOW)).toBe(false);
    expect(isEligibleAbandonedArrival(arrived({ claimState: 'completed_success' }), NOW)).toBe(false);
  });

  it('does not treat malformed or missing arrivedAt as eligible, and counts only missing as legacy', () => {
    for (const arrivedAt of ['yesterday', 123, { seconds: 1 }, { toMillis: () => NaN }, false]) {
      const spot = arrived({ arrivedAt });
      expect(isEligibleAbandonedArrival(spot, NOW)).toBe(false);
      expect(isLegacyOccupiedMissingArrivedAt(spot)).toBe(false);
    }
    expect(isEligibleAbandonedArrival(arrived({ arrivedAt: null }), NOW)).toBe(false);
    expect(isLegacyOccupiedMissingArrivedAt(arrived({ arrivedAt: null }))).toBe(true);
    const missing = arrived();
    delete missing.arrivedAt;
    expect(isEligibleAbandonedArrival(missing, NOW)).toBe(false);
    expect(isLegacyOccupiedMissingArrivedAt(missing)).toBe(true);
    expect(isLegacyOccupiedMissingArrivedAt(arrived({ status: 'interested', arrivedAt: null }))).toBe(false);
  });

  it('formats the six counters and nothing else', () => {
    expect(formatAbandonedArrivalSweepLog({
      scanned: 4,
      eligible: 1,
      converted: 1,
      skippedTerminal: 0,
      skippedLegacy: 2,
      error: 0,
    })).toBe('cleanupAbandonedArrivedHandoffs scanned=4 eligible=1 converted=1 skipped-terminal=0 skipped-legacy=2 error=0');
    expect(formatAbandonedArrivalSweepLog({
      scanned: 'user-secret',
      eligible: 1,
      converted: 1,
      skippedTerminal: 0,
      skippedLegacy: 0,
      error: 0,
    })).not.toContain('user-secret');
  });
});
