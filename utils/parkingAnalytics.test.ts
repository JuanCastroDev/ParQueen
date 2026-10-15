import { beforeEach, describe, expect, it, vi } from 'vitest';

const { captureProductAnalyticsEvent } = vi.hoisted(() => ({
  captureProductAnalyticsEvent: vi.fn(),
}));
vi.mock('./posthogAnalyticsRuntime', () => ({ captureProductAnalyticsEvent }));

import { isConfirmedServerHandoffSuccess, recordParkingAnalyticsEvent, runAnalyticsCaptureSafely } from './parkingAnalytics';

beforeEach(() => captureProductAnalyticsEvent.mockReset());

describe('observational parking analytics', () => {
  it('passes exactly the approved event name to the consent-gated runtime', () => {
    recordParkingAnalyticsEvent('map_opened');
    expect(captureProductAnalyticsEvent).toHaveBeenCalledTimes(1);
    expect(captureProductAnalyticsEvent).toHaveBeenCalledWith('map_opened');
    expect(Object.keys(captureProductAnalyticsEvent.mock.calls[0])).toEqual(['0']);
  });

  it('never disrupts a parking action when the capture callback throws', () => {
    let attempts = 0;
    expect(() => runAnalyticsCaptureSafely(() => {
      attempts += 1;
      throw new Error('capture unavailable');
    })).not.toThrow();
    expect(attempts).toBe(1);
    expect(captureProductAnalyticsEvent).not.toHaveBeenCalled();
  });

  it('does not inspect or pass parking data or identifiers', () => {
    recordParkingAnalyticsEvent('parking_claim_started');
    expect(captureProductAnalyticsEvent.mock.calls[0]).toEqual(['parking_claim_started']);
  });
});

describe('server-backed handoff success', () => {
  const server = { fromCache: false, hasPendingWrites: false };
  it('accepts only server-confirmed completed_success', () => {
    expect(isConfirmedServerHandoffSuccess('completed_success', server)).toBe(true);
  });
  it('rejects local cached success', () => {
    expect(isConfirmedServerHandoffSuccess('completed_success', { fromCache: true, hasPendingWrites: false })).toBe(false);
  });
  it('rejects pending writes', () => {
    expect(isConfirmedServerHandoffSuccess('completed_success', { fromCache: false, hasPendingWrites: true })).toBe(false);
  });
  it('rejects missing metadata', () => {
    expect(isConfirmedServerHandoffSuccess('completed_success', undefined)).toBe(false);
  });
  it('rejects single-party attestations and failed terminal states', () => {
    for (const state of ['arrived_pending_outcome', 'completed_failed', 'unconfirmed', 'interested', null]) {
      expect(isConfirmedServerHandoffSuccess(state, server)).toBe(false);
    }
  });
});
