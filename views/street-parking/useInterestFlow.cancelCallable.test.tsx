import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
});

vi.mock('../../firebase', () => ({ db: { __db: true } }));

vi.mock('firebase/firestore', () => ({
  doc: vi.fn(),
  updateDoc: vi.fn(async () => {}),
  deleteDoc: vi.fn(async () => {}),
  Timestamp: { now: () => ({ toMillis: () => Date.now() }), fromMillis: (ms: number) => ({ toMillis: () => ms }) },
  collection: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  getDocs: vi.fn(async () => ({ empty: true, docs: [] })),
  addDoc: vi.fn(async () => ({ id: 'notif' })),
  setDoc: vi.fn(async () => {}),
  onSnapshot: vi.fn(() => () => {}),
  orderBy: vi.fn(),
  limit: vi.fn(),
}));

const { cancelClaimCallable } = vi.hoisted(() => ({ cancelClaimCallable: vi.fn() }));
vi.mock('./cancelClaimCallable', () => ({ cancelClaimCallable }));

const { reportCriticalActionFailure } = vi.hoisted(() => ({ reportCriticalActionFailure: vi.fn() }));
vi.mock('../../utils/errorReporting', () => ({ reportCriticalActionFailure }));

import { t } from '../../i18n';
import { useInterestFlow } from './useInterestFlow';

const user = { id: 'u1', username: 'driver1', crowns: 0 };
const spot = {
  id: 'spot-1',
  lat: 40.7,
  lng: -73.9,
  finderId: 'finder-1',
  claimStartedAt: { toMillis: () => 1_700_000_000_000 },
};

function mount() {
  const setSelectedItem = vi.fn();
  const activeRouteDestinationRef: { current: [number, number] | null } = { current: [40.7, -73.9] };
  const map = {
    getLayer: vi.fn(() => undefined),
    getSource: vi.fn(() => undefined),
    removeLayer: vi.fn(),
    removeSource: vi.fn(),
  };
  let flow!: ReturnType<typeof useInterestFlow>;
  act(() => {
    TestRenderer.create(React.createElement(() => {
      flow = useInterestFlow({
        selectedItem: spot,
        setSelectedItem,
        user,
        freeSpots: [spot as never],
        userLocation: null,
        mapRef: { current: map as never },
        activeRouteDestinationRef,
      });
      return null;
    }));
  });
  return { getFlow: () => flow, setSelectedItem, activeRouteDestinationRef, map };
}

describe('handleCancelByClaimer callable integration', () => {
  beforeEach(() => {
    cancelClaimCallable.mockReset();
    reportCriticalActionFailure.mockClear();
  });

  it('sends the UI reason and stored fingerprint without claimant, finder, or message fields', async () => {
    cancelClaimCallable.mockResolvedValue('cancelled');
    const { getFlow } = mount();
    await act(async () => { await getFlow().handleCancelByClaimer('Found parking elsewhere'); });
    expect(cancelClaimCallable).toHaveBeenCalledWith({
      spotId: 'spot-1',
      fingerprint: 1_700_000_000_000,
      reason: 'Found parking elsewhere',
    });
    expect(Object.keys(cancelClaimCallable.mock.calls[0][0])).toEqual(['spotId', 'fingerprint', 'reason']);
  });

  it('sends an explicit null fingerprint when the claim has no generation', async () => {
    cancelClaimCallable.mockResolvedValue('cancelled');
    const bare = { ...spot, claimStartedAt: undefined };
    let flow!: ReturnType<typeof useInterestFlow>;
    act(() => {
      TestRenderer.create(React.createElement(() => {
        flow = useInterestFlow({
          selectedItem: bare,
          setSelectedItem: vi.fn(),
          user,
          freeSpots: [],
          userLocation: null,
          mapRef: { current: null },
          activeRouteDestinationRef: { current: null },
        });
        return null;
      }));
    });
    await act(async () => { await flow.handleCancelByClaimer('Changed my mind'); });
    expect(cancelClaimCallable).toHaveBeenCalledWith({
      spotId: 'spot-1',
      fingerprint: null,
      reason: 'Changed my mind',
    });
  });

  it.each(['cancelled', 'already_resolved', 'stale_claim'] as const)(
    'closes the sheet for %s',
    async (outcome) => {
      cancelClaimCallable.mockResolvedValue(outcome);
      const { getFlow, setSelectedItem, activeRouteDestinationRef, map } = mount();
      await act(async () => { await getFlow().handleCancelByClaimer('Changed my mind'); });
      expect(setSelectedItem).toHaveBeenCalledWith(null);
      expect(activeRouteDestinationRef.current).toBeNull();
      expect(map.getLayer).toHaveBeenCalled();
      expect(reportCriticalActionFailure).not.toHaveBeenCalled();
      expect(getFlow().interestError).toBeNull();
      expect(getFlow().cancelingClaim).toBe(false);
    },
  );

  it.each([
    ['functions/unavailable', 'unavailable'],
    ['functions/permission-denied', 'permission-denied'],
    ['functions/unauthenticated', 'App Check rejected this request'],
  ] as const)('keeps the Ping retryable when the callable fails with %s', async (code, message) => {
    const error = Object.assign(new Error(message), { code });
    cancelClaimCallable.mockRejectedValue(error);
    const { getFlow, setSelectedItem, activeRouteDestinationRef, map } = mount();
    await act(async () => { await getFlow().handleCancelByClaimer('Traffic is too heavy'); });
    expect(setSelectedItem).not.toHaveBeenCalled();
    expect(activeRouteDestinationRef.current).toEqual([40.7, -73.9]);
    expect(map.getLayer).not.toHaveBeenCalled();
    expect(getFlow().interestError).toBe(t('claim_flow.cancel_error'));
    expect(getFlow().interestError).not.toContain(message);
    expect(getFlow().cancelingClaim).toBe(false);
    expect(reportCriticalActionFailure).toHaveBeenCalledTimes(1);
    expect(reportCriticalActionFailure).toHaveBeenCalledWith('claim_cancel', error, undefined);
  });

  it('does not close the sheet when the callable result is not an allowed outcome', async () => {
    cancelClaimCallable.mockResolvedValue('success');
    const { getFlow, setSelectedItem } = mount();
    await act(async () => { await getFlow().handleCancelByClaimer('Changed my mind'); });
    expect(setSelectedItem).not.toHaveBeenCalled();
    expect(getFlow().interestError).toBe(t('claim_flow.cancel_error'));
    expect(getFlow().cancelingClaim).toBe(false);
  });

  it('invokes the callable once for overlapping taps and allows a later retry after failure', async () => {
    let resolveCancel!: (value: 'cancelled') => void;
    cancelClaimCallable.mockReturnValue(new Promise((resolve) => { resolveCancel = resolve; }));
    const { getFlow } = mount();
    let first!: Promise<void>;
    act(() => { first = getFlow().handleCancelByClaimer('Changed my mind'); });
    await act(async () => { await getFlow().handleCancelByClaimer('Changed my mind'); });
    expect(cancelClaimCallable).toHaveBeenCalledTimes(1);
    resolveCancel('cancelled');
    await act(async () => { await first; });

    cancelClaimCallable.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { code: 'functions/unavailable' }));
    await act(async () => { await getFlow().handleCancelByClaimer('Changed my mind'); });
    expect(cancelClaimCallable).toHaveBeenCalledTimes(2);
    expect(getFlow().cancelingClaim).toBe(false);
    expect(getFlow().interestError).toBe(t('claim_flow.cancel_error'));
  });
});
