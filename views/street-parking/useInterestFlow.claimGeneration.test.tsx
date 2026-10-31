import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
const ATTEMPT_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const { getDocs, getDoc, updateDoc, setDoc, addDoc } = vi.hoisted(() => ({
  getDocs: vi.fn(async () => ({ empty: true, docs: [] as Array<{ id: string }> })),
  getDoc: vi.fn(),
  updateDoc: vi.fn(async () => {}),
  setDoc: vi.fn(async () => {}),
  addDoc: vi.fn(async () => ({ id: 'notif' })),
}));

vi.mock('firebase/firestore', () => ({
  doc: vi.fn((_db: unknown, ...parts: string[]) => ({ path: parts.join('/') })),
  updateDoc,
  deleteDoc: vi.fn(async () => {}),
  setDoc,
  Timestamp: {
    now: () => ({ toMillis: () => Date.now() }),
    fromMillis: (ms: number) => ({ toMillis: () => ms }),
  },
  collection: vi.fn((_db: unknown, name: string) => ({ __collection: name })),
  query: vi.fn((...args: unknown[]) => ({ __query: args })),
  where: vi.fn(),
  getDocs,
  getDoc,
  addDoc,
  onSnapshot: vi.fn(() => () => {}),
  orderBy: vi.fn(),
  limit: vi.fn(),
}));

const { claimSpotCallable, prepareClaimIntentCallable, revokeClaimIntentCallable } = vi.hoisted(() => ({
  claimSpotCallable: vi.fn(),
  prepareClaimIntentCallable: vi.fn(async (input: { attemptId: string; spotId: string; mode: string }) => ({
    state: 'prepared',
    attemptId: input.attemptId,
    spotId: input.spotId,
    mode: input.mode,
    expiresAt: 1_700_000_060_000,
  })),
  revokeClaimIntentCallable: vi.fn(async (input: { attemptId: string; spotId: string; mode: string }) => ({
    outcome: 'revoked',
    attemptId: input.attemptId,
    spotId: input.spotId,
    mode: input.mode,
  })),
}));
vi.mock('./claimSpotCallable', () => ({ claimSpotCallable, prepareClaimIntentCallable, revokeClaimIntentCallable }));

const { cancelClaimCallable } = vi.hoisted(() => ({ cancelClaimCallable: vi.fn() }));
vi.mock('./cancelClaimCallable', () => ({ cancelClaimCallable }));

const { recordParkingAnalyticsEvent } = vi.hoisted(() => ({ recordParkingAnalyticsEvent: vi.fn() }));
vi.mock('../../utils/parkingAnalytics', () => ({
  recordParkingAnalyticsEvent,
  isConfirmedServerHandoffSuccess: () => false,
}));

const { drawRoute } = vi.hoisted(() => ({ drawRoute: vi.fn() }));
vi.mock('./utils', async () => {
  const actual = await vi.importActual<typeof import('./utils')>('./utils');
  return { ...actual, drawRoute };
});

vi.mock('../../utils/errorReporting', () => ({ reportCriticalActionFailure: vi.fn() }));

import { ALREADY_CLAIMED_MESSAGE } from './activeIncomingClaim';
import { useInterestFlow } from './useInterestFlow';

const user = { id: 'driver-1', username: 'Driver', crowns: 4, vehicleColor: 'red' };
const spot = {
  id: 'spot-1',
  lat: 40.7,
  lng: -73.9,
  type: 'free' as const,
  title: '1 Main St',
  address: '1 Main St',
  finderId: 'finder-1',
  finderName: 'Finder',
  status: 'available' as const,
};

function activeSnap(generation: string, claimState: 'heading' | 'committed' | null = 'heading') {
  return {
    exists: () => true,
    data: () => ({
      interestedUserId: user.id,
      claimGenerationId: generation,
      status: 'interested',
      claimState,
    }),
  };
}

function claimed(generation: string, mode: 'immediate' | 'scheduled') {
  return {
    outcome: 'claimed' as const,
    claimGenerationId: generation,
    spotId: 'spot-1',
    mode,
  };
}

describe('claimSpot client acquisition', () => {
  beforeEach(() => {
    getDocs.mockReset();
    getDocs.mockResolvedValue({ empty: true, docs: [] });
    getDoc.mockReset();
    getDoc.mockResolvedValue(activeSnap(G1));
    updateDoc.mockClear();
    setDoc.mockClear();
    addDoc.mockClear();
    claimSpotCallable.mockReset();
    prepareClaimIntentCallable.mockClear();
    revokeClaimIntentCallable.mockClear();
    cancelClaimCallable.mockReset();
    recordParkingAnalyticsEvent.mockClear();
    drawRoute.mockClear();
  });

  function mountLive(initial: typeof spot | null = spot) {
    const bridge: { item: typeof spot | null; flow: ReturnType<typeof useInterestFlow> | null } = {
      item: initial,
      flow: null,
    };
    let renderer!: TestRenderer.ReactTestRenderer;
    function Probe() {
      bridge.flow = useInterestFlow({
        selectedItem: bridge.item,
        setSelectedItem: (item: typeof spot | null) => { bridge.item = item; },
        user,
        freeSpots: bridge.item ? [bridge.item] : [],
        userLocation: null,
        mapRef: { current: null },
        activeRouteDestinationRef: { current: null },
      });
      return null;
    }
    act(() => { renderer = TestRenderer.create(React.createElement(Probe)); });
    return {
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

  it('reserves an immediate spot through claimSpot and reconciles the returned generation', async () => {
    claimSpotCallable.mockResolvedValue(claimed(G1, 'immediate'));
    const { getFlow } = mountLive();
    await act(async () => { await getFlow().handleExpressInterest(5); });
    const request = claimSpotCallable.mock.calls[0][0];
    expect(request).toEqual({
      spotId: 'spot-1',
      attemptId: request.attemptId,
      mode: 'immediate',
      etaMinutes: 5,
    });
    expect(request.attemptId).toMatch(ATTEMPT_RE);
    expect(request).not.toHaveProperty('claimGenerationId');
    expect(request).not.toHaveProperty('interestedUserName');
    expect(getFlow().interestError).toBeNull();
    expect(getFlow().claiming).toBe(false);
    expect(recordParkingAnalyticsEvent).toHaveBeenCalledTimes(1);
    expect(recordParkingAnalyticsEvent).toHaveBeenCalledWith('parking_claim_started');
    expect(updateDoc).not.toHaveBeenCalled();
    expect(setDoc).not.toHaveBeenCalled();
  });

  it('reserves a scheduled spot without client-authored timing or profile authority', async () => {
    getDoc.mockResolvedValue(activeSnap(G1, 'committed'));
    claimSpotCallable.mockResolvedValue(claimed(G1, 'scheduled'));
    const { getFlow } = mountLive();
    await act(async () => { await getFlow().handleScheduledClaim(); });
    expect(Object.keys(claimSpotCallable.mock.calls[0][0]).sort()).toEqual(['attemptId', 'mode', 'spotId']);
    expect(claimSpotCallable.mock.calls[0][0]).toMatchObject({ spotId: 'spot-1', mode: 'scheduled' });
    expect(getFlow().interestError).toBeNull();
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it('reuses the original attempt id after a lost response and mints a new id after a completed response', async () => {
    claimSpotCallable.mockRejectedValueOnce(Object.assign(new Error('network down'), { code: 'functions/unavailable' }));
    const { getFlow } = mountLive();
    await act(async () => { await getFlow().handleExpressInterest(5); });
    const first = claimSpotCallable.mock.calls[0][0].attemptId;
    expect(getFlow().interestError).toBe('network down');
    expect(getFlow().claiming).toBe(false);

    claimSpotCallable.mockResolvedValueOnce(claimed(G1, 'immediate'));
    await act(async () => { await getFlow().handleExpressInterest(5); });
    expect(claimSpotCallable.mock.calls[1][0].attemptId).toBe(first);
    expect(getFlow().interestError).toBeNull();

    claimSpotCallable.mockResolvedValueOnce(claimed(G2, 'immediate'));
    getDoc.mockResolvedValue(activeSnap(G2));
    await act(async () => { await getFlow().handleExpressInterest(5); });
    expect(claimSpotCallable.mock.calls[2][0].attemptId).not.toBe(first);
    expect(getFlow().interestError).toBeNull();
  });

  it('does not treat a released G1 replay as a successful acquisition', async () => {
    claimSpotCallable.mockResolvedValueOnce(claimed(G1, 'immediate'));
    let spotReads = 0;
    getDoc.mockImplementation(async (ref: { path?: string }) => {
      if (String(ref?.path || '').includes('activeIncomingClaims')) {
        return { exists: () => false, data: () => undefined };
      }
      spotReads += 1;
      if (spotReads === 1) return { exists: () => false, data: () => undefined };
      return activeSnap(G2);
    });
    const { getFlow } = mountLive();
    await act(async () => { await getFlow().handleExpressInterest(5); });
    const first = claimSpotCallable.mock.calls[0][0].attemptId;
    expect(getFlow().interestError).toBe('Failed to reserve spot');

    claimSpotCallable.mockResolvedValueOnce(claimed(G2, 'immediate'));
    await act(async () => { await getFlow().handleExpressInterest(5); });
    expect(claimSpotCallable.mock.calls[1][0].attemptId).not.toBe(first);
    expect(getFlow().interestError).toBeNull();
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it('does not display a stale G1 response as success after G2 is the active claim', async () => {
    claimSpotCallable.mockResolvedValue(claimed(G1, 'immediate'));
    getDoc.mockResolvedValue(activeSnap(G2));
    const { getFlow } = mountLive();
    await act(async () => { await getFlow().handleExpressInterest(5); });
    expect(getFlow().interestError).toBe('Failed to reserve spot');
    expect(updateDoc).not.toHaveBeenCalled();
    expect(setDoc).not.toHaveBeenCalled();
    expect(addDoc).not.toHaveBeenCalled();
  });

  it('treats already_held as an observation and does not adopt another generation', async () => {
    const map = { id: 'map' };
    function mountWithMap() {
      const bridge: { item: typeof spot | null; flow: ReturnType<typeof useInterestFlow> | null } = {
        item: spot,
        flow: null,
      };
      function Probe() {
        bridge.flow = useInterestFlow({
          selectedItem: bridge.item,
          setSelectedItem: () => {},
          user,
          freeSpots: [spot],
          userLocation: null,
          mapRef: { current: map as never },
          activeRouteDestinationRef: { current: null },
        });
        return null;
      }
      act(() => { TestRenderer.create(React.createElement(Probe)); });
      return () => bridge.flow!;
    }

    claimSpotCallable.mockResolvedValueOnce({
      outcome: 'already_held',
      claimGenerationId: G2,
      spotId: 'spot-1',
      mode: 'immediate',
    });
    const current = mountWithMap();
    await act(async () => { await current().handleExpressInterest(5); });
    expect(current().interestError).toBeNull();
    expect(recordParkingAnalyticsEvent).not.toHaveBeenCalled();
    expect(drawRoute).not.toHaveBeenCalled();
    expect(getDoc.mock.calls.every((call) => String(call[0]?.path || '').includes('activeIncomingClaims'))).toBe(true);
    expect(updateDoc).not.toHaveBeenCalled();

    claimSpotCallable.mockResolvedValueOnce({
      outcome: 'already_held',
      claimGenerationId: null,
      spotId: 'spot-1',
      mode: 'immediate',
    });
    getDoc.mockResolvedValue(activeSnap(G2));
    cancelClaimCallable.mockResolvedValue('cancelled');
    const observed = mountWithMap();
    await act(async () => { await observed().handleExpressInterest(5); });
    await act(async () => { await observed().handleCancelByClaimer('Changed my mind'); });
    expect(cancelClaimCallable).toHaveBeenCalledWith({
      spotId: 'spot-1',
      claimGenerationId: G2,
      reason: 'Changed my mind',
    });
    expect(recordParkingAnalyticsEvent).not.toHaveBeenCalled();
    expect(drawRoute).not.toHaveBeenCalled();
  });

  it('shows the competing-user outcome without a direct write', async () => {
    claimSpotCallable.mockResolvedValue({
      outcome: 'already_claimed',
      claimGenerationId: null,
      spotId: 'spot-1',
      mode: 'immediate',
    });
    const { getFlow } = mountLive();
    await act(async () => { await getFlow().handleExpressInterest(5); });
    expect(getFlow().interestError).toBe(ALREADY_CLAIMED_MESSAGE);
    expect(updateDoc).not.toHaveBeenCalled();
    expect(getDoc.mock.calls.every((call) => String(call[0]?.path || '').includes('activeIncomingClaims'))).toBe(true);
  });

  it('surfaces a suspended or blocked callable failure and does not fall back to a direct write', async () => {
    const denied = Object.assign(new Error('Product access is not available.'), { code: 'permission-denied' });
    claimSpotCallable.mockRejectedValue(denied);
    const { getFlow } = mountLive();
    await act(async () => { await getFlow().handleExpressInterest(5); });
    expect(getFlow().interestError).toBe('Product access is not available.');
    expect(updateDoc).not.toHaveBeenCalled();
    expect(setDoc).not.toHaveBeenCalled();
    expect(addDoc).not.toHaveBeenCalled();
  });

  it('rejects a malformed callable response without writing the claim', async () => {
    claimSpotCallable.mockRejectedValue(new Error('Invalid claim response.'));
    const { getFlow } = mountLive();
    await act(async () => { await getFlow().handleExpressInterest(5); });
    expect(getFlow().interestError).toBe('Invalid claim response.');
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it('keeps the loading guard around one logical attempt and ignores a second tap', async () => {
    let resolveClaim!: (value: ReturnType<typeof claimed>) => void;
    claimSpotCallable.mockReturnValue(new Promise((resolve) => { resolveClaim = resolve; }));
    const { getFlow } = mountLive();
    let first!: Promise<void>;
    act(() => { first = getFlow().handleExpressInterest(5); });
    expect(getFlow().claiming).toBe(true);
    await act(async () => { await getFlow().handleExpressInterest(5); });
    expect(claimSpotCallable).toHaveBeenCalledTimes(1);
    resolveClaim(claimed(G1, 'immediate'));
    await act(async () => { await first; });
    expect(getFlow().claiming).toBe(false);
    expect(getFlow().interestError).toBeNull();
  });

  it('drops a delayed response after the sheet closes and uses a new attempt when it reopens', async () => {
    let resolveClaim!: (value: ReturnType<typeof claimed>) => void;
    claimSpotCallable.mockReturnValue(new Promise((resolve) => { resolveClaim = resolve; }));
    const { getFlow, replaceItem } = mountLive();
    let first!: Promise<void>;
    await act(async () => {
      first = getFlow().handleExpressInterest(5);
      await Promise.resolve();
      await Promise.resolve();
    });
    const firstAttempt = claimSpotCallable.mock.calls[0][0].attemptId;
    replaceItem(null);
    resolveClaim(claimed(G1, 'immediate'));
    await act(async () => { await first; });
    expect(getFlow().interestError).toBeNull();

    replaceItem(spot);
    claimSpotCallable.mockResolvedValueOnce(claimed(G2, 'immediate'));
    getDoc.mockResolvedValue(activeSnap(G2));
    await act(async () => { await getFlow().handleExpressInterest(5); });
    expect(claimSpotCallable.mock.calls[1][0].attemptId).not.toBe(firstAttempt);
    expect(getFlow().interestError).toBeNull();
  });

  it('does not apply a delayed response to a newer spot selection', async () => {
    let resolveClaim!: (value: ReturnType<typeof claimed>) => void;
    claimSpotCallable.mockReturnValue(new Promise((resolve) => { resolveClaim = resolve; }));
    const { getFlow, replaceItem } = mountLive();
    let first!: Promise<void>;
    await act(async () => {
      first = getFlow().handleExpressInterest(5);
      await Promise.resolve();
      await Promise.resolve();
    });
    replaceItem({ ...spot, id: 'spot-2' });
    resolveClaim(claimed(G1, 'immediate'));
    await act(async () => { await first; });
    expect(getFlow().interestError).toBeNull();
    expect(updateDoc).not.toHaveBeenCalled();
  });

  it('mints a new attempt id after a remount because attempt authority is not stored', async () => {
    claimSpotCallable.mockRejectedValueOnce(new Error('network down'));
    const first = mountLive();
    await act(async () => { await first.getFlow().handleExpressInterest(5); });
    const firstAttempt = claimSpotCallable.mock.calls[0][0].attemptId;
    first.unmount();

    claimSpotCallable.mockResolvedValueOnce(claimed(G1, 'immediate'));
    const second = mountLive();
    await act(async () => { await second.getFlow().handleExpressInterest(5); });
    expect(claimSpotCallable.mock.calls[1][0].attemptId).not.toBe(firstAttempt);
  });

  it('dismisses a claim error when the sheet selection is cleared', async () => {
    claimSpotCallable.mockRejectedValueOnce(new Error('network down'));
    const { getFlow, replaceItem } = mountLive();
    await act(async () => { await getFlow().handleExpressInterest(5); });
    expect(getFlow().interestError).toBe('network down');
    replaceItem(null);
    expect(getFlow().interestError).toBeNull();
  });

  it('prepares on the claim tap and redeems that same attempt only after preparation is accepted', async () => {
    claimSpotCallable.mockResolvedValue(claimed(G1, 'immediate'));
    const { getFlow } = mountLive();
    await act(async () => { await getFlow().handleExpressInterest(5); });
    expect(prepareClaimIntentCallable).toHaveBeenCalledTimes(1);
    expect(claimSpotCallable).toHaveBeenCalledTimes(1);
    const prepared = prepareClaimIntentCallable.mock.calls[0][0];
    const redeemed = claimSpotCallable.mock.calls[0][0];
    expect(prepared.attemptId).toBe(redeemed.attemptId);
    expect(prepared).toEqual({ spotId: 'spot-1', attemptId: prepared.attemptId, mode: 'immediate', etaMinutes: 5 });
    expect(getFlow().claiming).toBe(false);
  });

  it('does not redeem when preparation is revoked, expired, or rejected', async () => {
    prepareClaimIntentCallable.mockResolvedValueOnce({
      state: 'revoked', attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', spotId: 'spot-1', mode: 'immediate', expiresAt: null,
    });
    const { getFlow } = mountLive();
    await act(async () => { await getFlow().handleExpressInterest(5); });
    expect(claimSpotCallable).not.toHaveBeenCalled();
    expect(getFlow().interestError).toBe('Failed to reserve spot');
    expect(recordParkingAnalyticsEvent).not.toHaveBeenCalled();
    expect(getFlow().claiming).toBe(false);
  });

  it('reuses one attempt id when the prepare response is lost', async () => {
    prepareClaimIntentCallable.mockRejectedValueOnce(new Error('network down'));
    const { getFlow } = mountLive();
    await act(async () => { await getFlow().handleExpressInterest(5); });
    const first = prepareClaimIntentCallable.mock.calls[0][0].attemptId;
    expect(claimSpotCallable).not.toHaveBeenCalled();
    expect(getFlow().interestError).toBe('network down');
    expect(getFlow().claiming).toBe(false);

    claimSpotCallable.mockResolvedValueOnce(claimed(G1, 'immediate'));
    await act(async () => { await getFlow().handleExpressInterest(5); });
    expect(prepareClaimIntentCallable.mock.calls[1][0].attemptId).toBe(first);
    expect(claimSpotCallable.mock.calls[0][0].attemptId).toBe(first);
  });

  it('revokes a pending attempt on dismissal and does not report a lost revoke as success', async () => {
    let resolvePrepare!: (value: { state: string; attemptId: string; spotId: string; mode: string; expiresAt: number }) => void;
    prepareClaimIntentCallable.mockReturnValueOnce(new Promise((resolve) => { resolvePrepare = resolve; }));
    const { getFlow, replaceItem } = mountLive();
    let first!: Promise<void>;
    await act(async () => {
      first = getFlow().handleExpressInterest(5);
      await Promise.resolve();
      await Promise.resolve();
    });
    const attemptId = prepareClaimIntentCallable.mock.calls[0][0].attemptId;
    replaceItem(null);
    expect(revokeClaimIntentCallable).toHaveBeenCalledWith({
      spotId: 'spot-1', attemptId, mode: 'immediate', etaMinutes: 5,
    });
    resolvePrepare({ state: 'prepared', attemptId, spotId: 'spot-1', mode: 'immediate', expiresAt: 1 });
    await act(async () => { await first; });
    expect(claimSpotCallable).not.toHaveBeenCalled();
    expect(getFlow().interestError).toBeNull();
    expect(getFlow().claiming).toBe(false);
    expect(recordParkingAnalyticsEvent).not.toHaveBeenCalled();

    revokeClaimIntentCallable.mockRejectedValueOnce(new Error('network down'));
    prepareClaimIntentCallable.mockReturnValueOnce(new Promise((resolve) => { resolvePrepare = resolve; }));
    replaceItem(spot);
    let second!: Promise<void>;
    await act(async () => {
      second = getFlow().handleExpressInterest(5);
      await Promise.resolve();
      await Promise.resolve();
    });
    replaceItem(null);
    await act(async () => { await Promise.resolve(); });
    expect(getFlow().interestError).toBe('network down');
    expect(getFlow().interestError).not.toMatch(/released|cancelled/i);
    resolvePrepare({
      state: 'prepared',
      attemptId: prepareClaimIntentCallable.mock.calls[1][0].attemptId,
      spotId: 'spot-1',
      mode: 'immediate',
      expiresAt: 1,
    });
    await act(async () => { await second; });
    expect(claimSpotCallable).not.toHaveBeenCalled();
  });

  it('keeps the live claim path off the direct-write helper', () => {
    const flow = readFileSync(join(__dirname, 'useInterestFlow.ts'), 'utf8');
    const view = readFileSync(join(__dirname, '..', 'StreetParkingView.tsx'), 'utf8');
    expect(flow).not.toContain('acquireActiveIncomingClaim');
    expect(flow).not.toContain('cancelClaimTransaction');
    expect(flow).not.toContain('localStorage');
    expect(view).toContain('handleExpressInterest');
    expect(view).toContain('handleScheduledClaim');
    expect(view).not.toContain('acquireActiveIncomingClaim');
    expect(view).not.toContain('cancelClaimTransaction');
  });
});
