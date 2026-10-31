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

const G1 = 'a'.repeat(64);
const G2 = 'b'.repeat(64);
const G3 = 'c'.repeat(64);

const { getDoc, updateDoc, addDoc } = vi.hoisted(() => ({
  getDoc: vi.fn(async () => ({
    exists: () => true,
    data: () => ({ claimGenerationId: 'a'.repeat(64), status: 'interested', interestedUserId: 'u1' }),
  })),
  updateDoc: vi.fn(async () => {}),
  addDoc: vi.fn(async () => ({ id: 'notif' })),
}));

vi.mock('firebase/firestore', () => ({
  doc: vi.fn(),
  updateDoc,
  deleteDoc: vi.fn(async () => {}),
  Timestamp: { now: () => ({ toMillis: () => Date.now() }), fromMillis: (ms: number) => ({ toMillis: () => ms }) },
  collection: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  getDocs: vi.fn(async () => ({ empty: true, docs: [] })),
  getDoc,
  addDoc,
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
    updateDoc.mockClear();
    addDoc.mockClear();
    getDoc.mockReset();
    getDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ claimGenerationId: G1, status: 'interested', interestedUserId: 'u1' }),
    });
  });

  it('sends the UI reason and the server generation id, not a numeric fingerprint', async () => {
    cancelClaimCallable.mockResolvedValue('cancelled');
    const { getFlow } = mount();
    await act(async () => { await getFlow().handleCancelByClaimer('Found parking elsewhere'); });
    expect(cancelClaimCallable).toHaveBeenCalledWith({
      spotId: 'spot-1',
      claimGenerationId: G1,
      reason: 'Found parking elsewhere',
    });
    expect(Object.keys(cancelClaimCallable.mock.calls[0][0])).toEqual(['spotId', 'claimGenerationId', 'reason']);
    expect(updateDoc).not.toHaveBeenCalled();
    expect(addDoc).not.toHaveBeenCalled();
  });

  it('rejects a missing generation locally and does not submit a fingerprint fallback', async () => {
    getDoc.mockResolvedValue({ exists: () => true, data: () => ({ claimStartedAt: { toMillis: () => 1_700_000_000_000 } }) });
    const { getFlow, setSelectedItem } = mount();
    await act(async () => { await getFlow().handleCancelByClaimer('Changed my mind'); });
    expect(cancelClaimCallable).not.toHaveBeenCalled();
    expect(setSelectedItem).not.toHaveBeenCalled();
    expect(getFlow().interestError).toBe(t('claim_flow.cancel_error'));
    expect(getFlow().cancelingClaim).toBe(false);
  });

  it('rejects a malformed generation locally', async () => {
    getDoc.mockResolvedValue({ exists: () => true, data: () => ({ claimGenerationId: 'not-a-generation' }) });
    const { getFlow } = mount();
    await act(async () => { await getFlow().handleCancelByClaimer('Changed my mind'); });
    expect(cancelClaimCallable).not.toHaveBeenCalled();
    expect(getFlow().interestError).toBe(t('claim_flow.cancel_error'));
  });

  it.each(['cancelled', 'already_resolved'] as const)(
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
      expect(addDoc).not.toHaveBeenCalled();
    },
  );

  it('keeps the sheet open when the server refuses a stale generation', async () => {
    cancelClaimCallable.mockResolvedValue('stale_claim');
    const { getFlow, setSelectedItem, activeRouteDestinationRef } = mount();
    await act(async () => { await getFlow().handleCancelByClaimer('Changed my mind'); });
    expect(setSelectedItem).not.toHaveBeenCalled();
    expect(activeRouteDestinationRef.current).toEqual([40.7, -73.9]);
    expect(getFlow().interestError).toBe(t('claim_flow.cancel_error'));
    expect(updateDoc).not.toHaveBeenCalled();
    expect(addDoc).not.toHaveBeenCalled();
  });

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
    expect(addDoc).not.toHaveBeenCalled();
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

describe('cancel attempt binding', () => {
  beforeEach(() => {
    cancelClaimCallable.mockReset();
    reportCriticalActionFailure.mockClear();
    updateDoc.mockClear();
    addDoc.mockClear();
    getDoc.mockReset();
    getDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ claimGenerationId: G1, status: 'interested', interestedUserId: 'u1' }),
    });
  });

  function mountLive(initial: typeof spot | null) {
    const setSelectedItem = vi.fn();
    const bridge: { item: typeof spot | null; flow: ReturnType<typeof useInterestFlow> | null } = {
      item: initial,
      flow: null,
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    function Probe() {
      bridge.flow = useInterestFlow({
        selectedItem: bridge.item,
        setSelectedItem,
        user,
        freeSpots: [],
        userLocation: null,
        mapRef: { current: null },
        activeRouteDestinationRef: { current: [40.7, -73.9] },
      });
      return null;
    }
    act(() => { renderer = TestRenderer.create(React.createElement(Probe)); });
    return {
      setSelectedItem,
      getFlow: () => bridge.flow!,
      replaceItem(item: typeof spot | null) {
        bridge.item = item;
        act(() => { renderer.update(React.createElement(Probe)); });
      },
      unmount() {
        act(() => { renderer.unmount(); });
      },
    };
  }

  it('keeps a stale refusal open and retries the captured generation after the listener refreshes', async () => {
    cancelClaimCallable.mockResolvedValue('stale_claim');
    const { getFlow, setSelectedItem, replaceItem } = mountLive(spot);
    await act(async () => { await getFlow().handleCancelByClaimer('Changed my mind'); });
    expect(cancelClaimCallable).toHaveBeenCalledWith({
      spotId: 'spot-1',
      claimGenerationId: G1,
      reason: 'Changed my mind',
    });
    expect(setSelectedItem).not.toHaveBeenCalled();
    expect(getFlow().interestError).toBe(t('claim_flow.cancel_error'));
    getDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ claimGenerationId: G2, status: 'interested', interestedUserId: 'u1' }),
    });
    replaceItem({ ...spot, claimStartedAt: { toMillis: () => 1_700_000_000_000 } });
    await act(async () => { await getFlow().handleCancelByClaimer('Changed my mind'); });
    expect(cancelClaimCallable).toHaveBeenLastCalledWith({
      spotId: 'spot-1',
      claimGenerationId: G1,
      reason: 'Changed my mind',
    });
    expect(setSelectedItem).not.toHaveBeenCalled();
    expect(addDoc).not.toHaveBeenCalled();
  });

  it('captures a new generation only after dismissal and a new confirmation', async () => {
    cancelClaimCallable.mockRejectedValue(Object.assign(new Error('unavailable'), { code: 'functions/unavailable' }));
    const { getFlow, replaceItem } = mountLive(spot);
    await act(async () => { await getFlow().handleCancelByClaimer('Traffic is too heavy'); });
    getDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ claimGenerationId: G2 }),
    });
    replaceItem({ ...spot, claimStartedAt: { toMillis: () => 1_800_000_000_000 } });
    await act(async () => { await getFlow().handleCancelByClaimer('Traffic is too heavy'); });
    expect(cancelClaimCallable).toHaveBeenLastCalledWith({
      spotId: 'spot-1',
      claimGenerationId: G1,
      reason: 'Traffic is too heavy',
    });
    act(() => { getFlow().dismissCancelAttempt(); });
    cancelClaimCallable.mockResolvedValue('cancelled');
    await act(async () => { await getFlow().handleCancelByClaimer('Changed my mind'); });
    expect(cancelClaimCallable).toHaveBeenLastCalledWith({
      spotId: 'spot-1',
      claimGenerationId: G2,
      reason: 'Changed my mind',
    });
  });

  it('drops the captured attempt when the sheet selection is cleared and does not store it', async () => {
    cancelClaimCallable.mockRejectedValue(new Error('unavailable'));
    const { getFlow, replaceItem } = mountLive(spot);
    await act(async () => { await getFlow().handleCancelByClaimer('Changed my mind'); });
    replaceItem(null);
    const next = { ...spot, id: 'spot-2', claimStartedAt: { toMillis: () => 1_700_000_000_000 } };
    getDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ claimGenerationId: G3 }),
    });
    replaceItem(next);
    cancelClaimCallable.mockResolvedValue('cancelled');
    await act(async () => { await getFlow().handleCancelByClaimer('Changed my mind'); });
    expect(cancelClaimCallable).toHaveBeenLastCalledWith({
      spotId: 'spot-2',
      claimGenerationId: G3,
      reason: 'Changed my mind',
    });
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it('does not keep cancellation authority in localStorage across a remount', async () => {
    cancelClaimCallable.mockRejectedValue(new Error('unavailable'));
    const first = mountLive(spot);
    await act(async () => { await first.getFlow().handleCancelByClaimer('Changed my mind'); });
    first.unmount();
    getDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ claimGenerationId: G2 }),
    });
    const second = mountLive(spot);
    cancelClaimCallable.mockResolvedValue('cancelled');
    await act(async () => { await second.getFlow().handleCancelByClaimer('Changed my mind'); });
    expect(cancelClaimCallable).toHaveBeenLastCalledWith({
      spotId: 'spot-1',
      claimGenerationId: G2,
      reason: 'Changed my mind',
    });
  });
});
