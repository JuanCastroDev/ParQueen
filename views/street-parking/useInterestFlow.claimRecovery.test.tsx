import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActiveClaimRecovery } from './ActiveClaimRecovery';
import { RECOVERY_CHANGED, RECOVERY_CHECK_FAILED, RECOVERY_RELEASED } from './recoverActiveClaim';

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

const spots = new Map<string, Record<string, unknown>>();
let lock: { spotId?: string; claimGenerationId?: string } | null = null;
let queryArgs: unknown[][] = [];

const { getDocs, getDoc, updateDoc, setDoc } = vi.hoisted(() => ({
  getDocs: vi.fn(),
  getDoc: vi.fn(),
  updateDoc: vi.fn(async () => {}),
  setDoc: vi.fn(async () => {}),
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
  query: vi.fn((...args: unknown[]) => {
    queryArgs.push(args);
    return { __query: args };
  }),
  where: vi.fn((field: string, op: string, value: unknown) => ({ field, op, value })),
  limit: vi.fn((count: number) => ({ limit: count })),
  getDocs,
  getDoc,
  addDoc: vi.fn(async () => ({ id: 'notif' })),
  onSnapshot: vi.fn(() => () => {}),
  orderBy: vi.fn(),
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
  revokeClaimIntentCallable: vi.fn(async () => ({ outcome: 'revoked', attemptId: 'x', spotId: 'spot-1', mode: 'immediate' })),
}));
vi.mock('./claimSpotCallable', () => ({ claimSpotCallable, prepareClaimIntentCallable, revokeClaimIntentCallable }));

const { cancelClaimCallable } = vi.hoisted(() => ({ cancelClaimCallable: vi.fn() }));
vi.mock('./cancelClaimCallable', () => ({ cancelClaimCallable }));

const { recordParkingAnalyticsEvent } = vi.hoisted(() => ({ recordParkingAnalyticsEvent: vi.fn() }));
vi.mock('../../utils/parkingAnalytics', () => ({
  recordParkingAnalyticsEvent,
  isConfirmedServerHandoffSuccess: () => false,
}));

vi.mock('../../utils/errorReporting', () => ({ reportCriticalActionFailure: vi.fn() }));
vi.mock('./claimFailureReporting', () => ({
  reportClaimFailure: vi.fn(),
  reportClaimCancelFailure: vi.fn(),
}));

import { useInterestFlow } from './useInterestFlow';

const userA = { id: 'driver-1', username: 'Driver', crowns: 4 };
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

function live(id: string, generation: string, claimState: 'heading' | 'committed', address = 'Far from the map') {
  return {
    id,
    status: 'interested',
    interestedUserId: 'driver-1',
    claimGenerationId: generation,
    claimState,
    address,
    lat: 10,
    lng: 20,
    finderId: 'finder-9',
    geohash: '0000000',
  };
}

function installReads() {
  getDoc.mockImplementation(async (ref: { path: string }) => {
    if (ref.path.includes('activeIncomingClaims/current')) {
      return { exists: () => lock != null, data: () => lock, id: 'current' };
    }
    const data = spots.get(ref.path);
    return { exists: () => data != null, id: ref.path.split('/').pop(), data: () => data };
  });
  getDocs.mockImplementation(async () => {
    const docs = [...spots.entries()].map(([path, data]) => ({
      id: path.split('/').pop(),
      data: () => data,
    }));
    return { empty: docs.length === 0, docs };
  });
}

async function settle() {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
}

describe('active claim recovery', () => {
  beforeEach(() => {
    spots.clear();
    lock = null;
    queryArgs = [];
    installReads();
    updateDoc.mockClear();
    setDoc.mockClear();
    claimSpotCallable.mockReset();
    prepareClaimIntentCallable.mockClear();
    revokeClaimIntentCallable.mockReset();
    revokeClaimIntentCallable.mockResolvedValue({ outcome: 'revoked', attemptId: 'x', spotId: 'spot-1', mode: 'immediate' });
    cancelClaimCallable.mockReset();
    recordParkingAnalyticsEvent.mockClear();
  });

  function mount(initialUser: { id: string } | null = userA, initialItem: typeof spot | null = null) {
    const bridge: {
      user: { id: string } | null;
      item: typeof spot | null;
      flow: ReturnType<typeof useInterestFlow> | null;
    } = { user: initialUser, item: initialItem, flow: null };
    let renderer!: TestRenderer.ReactTestRenderer;
    function Probe() {
      bridge.flow = useInterestFlow({
        selectedItem: bridge.item,
        setSelectedItem: (item: typeof spot | null) => { bridge.item = item; },
        user: bridge.user,
        freeSpots: [],
        userLocation: null,
        mapRef: { current: null },
        activeRouteDestinationRef: { current: null },
      });
      return (
        <ActiveClaimRecovery
          claims={bridge.flow.recoveredClaims}
          error={bridge.flow.recoveryError}
          ack={bridge.flow.recoveryAck}
          releasing={bridge.flow.cancelingClaim}
          onInspect={bridge.flow.inspectRecoveredClaim}
          onRelease={(id) => bridge.flow!.releaseRecoveredClaim(id)}
          onDismissAck={bridge.flow.dismissRecoveryAck}
        />
      );
    }
    act(() => { renderer = TestRenderer.create(<Probe />); });
    return {
      bridge,
      renderer,
      rerender() { act(() => { renderer.update(<Probe />); }); },
      unmount() { act(() => { renderer.unmount(); }); },
      button(label: string) {
        return renderer.root.findAll((node) => node.type === 'button' && node.children.includes(label))[0];
      },
    };
  }

  it('does not persist attempt identity', () => {
    const recovery = readFileSync(join(process.cwd(), 'views/street-parking/recoverActiveClaim.ts'), 'utf8');
    const hook = readFileSync(join(process.cwd(), 'views/street-parking/useInterestFlow.ts'), 'utf8');
    expect(recovery).not.toContain('localStorage');
    expect(hook).not.toContain('localStorage');
    expect(recovery).not.toContain('claimSpotCallable');
    expect(recovery).not.toContain('prepareClaimIntentCallable');
  });

  it('recovers a committed claim after unmount when the redeem response was lost', async () => {
    claimSpotCallable.mockImplementation(async () => {
      spots.set('spots/spot-1', live('spot-1', G1, 'heading'));
      throw Object.assign(new Error('network down'), { code: 'unavailable' });
    });
    const first = mount(userA, spot);
    await settle();
    await act(async () => { await first.bridge.flow!.handleExpressInterest(5); });
    expect(first.bridge.flow!.recoveryAck).toBeNull();
    expect(recordParkingAnalyticsEvent).not.toHaveBeenCalled();
    first.unmount();

    const second = mount(userA, null);
    await settle();
    expect(second.bridge.flow!.recoveredClaims).toEqual([
      expect.objectContaining({ spotId: 'spot-1', claimGenerationId: G1, claimState: 'heading' }),
    ]);
    expect(second.button('Active claim')).toBeUndefined();
    expect(second.renderer.root.findAll((node) => node.children?.includes?.('Active claim')).length).toBeGreaterThan(0);
    expect(claimSpotCallable).toHaveBeenCalledTimes(1);
    expect(prepareClaimIntentCallable).toHaveBeenCalledTimes(1);
    expect(recordParkingAnalyticsEvent).not.toHaveBeenCalled();
    expect(cancelClaimCallable).not.toHaveBeenCalled();
    expect(second.bridge.flow!.recoveryAck).toBeNull();
    const constraints = queryArgs.flat().filter((item) => item && typeof item === 'object' && 'field' in (item as object));
    expect(constraints).toEqual(expect.arrayContaining([
      { field: 'interestedUserId', op: '==', value: 'driver-1' },
      { field: 'claimState', op: 'in', value: ['heading', 'committed'] },
    ]));
    expect(JSON.stringify(queryArgs)).not.toContain('geohash');
    second.unmount();
  });

  it('recovers after a failed revoke and shows release only after cancelClaim acknowledges it', async () => {
    claimSpotCallable.mockImplementation(async () => {
      spots.set('spots/spot-1', live('spot-1', G1, 'heading', '1 Main St'));
      lock = { spotId: 'spot-1' };
      throw new Error('offline');
    });
    revokeClaimIntentCallable.mockRejectedValue(new Error('offline'));
    const first = mount(userA, spot);
    await settle();
    await act(async () => { await first.bridge.flow!.handleExpressInterest(5); });
    expect(recordParkingAnalyticsEvent).not.toHaveBeenCalled();
    first.bridge.item = null;
    first.rerender();
    await settle();
    expect(revokeClaimIntentCallable).toHaveBeenCalled();
    expect(first.bridge.flow!.recoveryAck).toBeNull();
    first.unmount();

    const second = mount(userA, null);
    await settle();
    expect(second.bridge.flow!.recoveredClaims.map((item) => item.claimGenerationId)).toEqual([G1]);
    expect(second.bridge.flow!.recoveryAck).toBeNull();
    expect(second.renderer.root.findAll((node) => node.children?.includes?.(RECOVERY_RELEASED))).toHaveLength(0);

    let release: (value: 'cancelled') => void = () => {};
    cancelClaimCallable.mockImplementation(() => new Promise((resolve) => { release = resolve; }));
    const pending = second.button('Release claim').props.onClick();
    await settle();
    expect(cancelClaimCallable).toHaveBeenCalledTimes(1);
    expect(cancelClaimCallable.mock.calls[0][0]).toEqual({
      spotId: 'spot-1',
      claimGenerationId: G1,
      reason: 'changed_mind',
    });
    expect(second.bridge.flow!.recoveryAck).toBeNull();
    await act(async () => { release('cancelled'); await pending; });
    expect(second.bridge.flow!.recoveryAck).toBe(RECOVERY_RELEASED);
    expect(second.bridge.flow!.recoveredClaims).toEqual([]);
    expect(recordParkingAnalyticsEvent).not.toHaveBeenCalled();
    expect(updateDoc).not.toHaveBeenCalled();
    expect(setDoc).not.toHaveBeenCalled();
    second.unmount();
  });

  it('shows an immediate and a scheduled claim that are outside the map feed', async () => {
    spots.set('spots/now', live('now', G1, 'heading', 'Immediate street'));
    spots.set('spots/later', live('later', G2, 'committed', 'Scheduled street'));
    const session = mount();
    await settle();
    const text = JSON.stringify(session.renderer.toJSON());
    expect(text).toContain('Active claim');
    expect(text).toContain('Immediate street');
    expect(text).toContain('Scheduled claim');
    expect(text).toContain('Scheduled street');
    expect(session.bridge.flow!.recoveredClaims).toHaveLength(2);
    expect(recordParkingAnalyticsEvent).not.toHaveBeenCalled();
    session.unmount();
  });

  it('does not send a recovered G1 cancellation after the spot has become G2', async () => {
    spots.set('spots/spot-1', live('spot-1', G1, 'heading'));
    const session = mount();
    await settle();
    spots.set('spots/spot-1', live('spot-1', G2, 'heading'));
    await act(async () => { session.button('Release claim').props.onClick(); });
    await settle();
    expect(cancelClaimCallable).not.toHaveBeenCalled();
    expect(session.bridge.flow!.recoveryError).toBe(RECOVERY_CHANGED);
    expect(session.bridge.flow!.recoveryAck).toBeNull();
    expect(session.bridge.flow!.recoveredClaims[0].claimGenerationId).toBe(G2);
    session.unmount();
  });

  it('keeps the captured generation when the selection changes during cancellation', async () => {
    spots.set('spots/spot-1', live('spot-1', G1, 'heading'));
    const session = mount();
    await settle();
    let release: (value: 'cancelled') => void = () => {};
    cancelClaimCallable.mockImplementation((input: { claimGenerationId: string }) => {
      expect(input.claimGenerationId).toBe(G1);
      return new Promise((resolve) => { release = resolve; });
    });
    await act(async () => { session.button('Release claim').props.onClick(); });
    spots.set('spots/spot-1', live('spot-1', G2, 'committed'));
    session.bridge.item = { ...spot, id: 'spot-2' };
    session.rerender();
    await act(async () => { release('cancelled'); });
    expect(cancelClaimCallable).toHaveBeenCalledTimes(1);
    expect(cancelClaimCallable.mock.calls[0][0].claimGenerationId).toBe(G1);
    expect(session.bridge.flow!.recoveryAck).toBe(RECOVERY_RELEASED);
    session.unmount();
  });

  it('fails closed when the generation id is missing, the spot is gone, or the lock is stale', async () => {
    spots.set('spots/missing-gen', {
      status: 'interested',
      interestedUserId: 'driver-1',
      claimState: 'heading',
      address: 'No generation',
    });
    spots.set('spots/expired', {
      status: 'available',
      interestedUserId: null,
      claimState: null,
      claimGenerationId: G1,
    });
    lock = { spotId: 'deleted-spot', claimGenerationId: G1 };
    const session = mount();
    await settle();
    expect(session.bridge.flow!.recoveredClaims).toEqual([]);
    expect(session.bridge.flow!.recoveryAck).toBeNull();
    expect(cancelClaimCallable).not.toHaveBeenCalled();
    expect(session.renderer.root.findAll((node) => node.children?.includes?.(RECOVERY_RELEASED))).toHaveLength(0);
    session.unmount();
  });

  it('uses the spot generation when a stale lock names a different id', async () => {
    lock = { spotId: 'spot-1', claimGenerationId: G1 };
    spots.set('spots/spot-1', live('spot-1', G2, 'committed', 'Current claim'));
    const session = mount();
    await settle();
    expect(session.bridge.flow!.recoveredClaims).toEqual([
      expect.objectContaining({ spotId: 'spot-1', claimGenerationId: G2 }),
    ]);
    cancelClaimCallable.mockResolvedValue('cancelled');
    await act(async () => { await session.bridge.flow!.releaseRecoveredClaim('spot-1'); });
    expect(cancelClaimCallable.mock.calls[0][0].claimGenerationId).toBe(G2);
    session.unmount();
  });

  it('releases one of two inconsistent claims without releasing the other', async () => {
    spots.set('spots/one', live('one', G1, 'heading', 'First'));
    spots.set('spots/two', live('two', G2, 'committed', 'Second'));
    const session = mount();
    await settle();
    expect(session.bridge.flow!.recoveredClaims).toHaveLength(2);
    cancelClaimCallable.mockResolvedValue('cancelled');
    await act(async () => { await session.bridge.flow!.releaseRecoveredClaim('one'); });
    expect(cancelClaimCallable).toHaveBeenCalledTimes(1);
    expect(cancelClaimCallable.mock.calls[0][0]).toMatchObject({ spotId: 'one', claimGenerationId: G1 });
    expect(session.bridge.flow!.recoveredClaims.map((item) => item.spotId)).toEqual(['two']);
    expect(session.bridge.flow!.recoveryAck).toBe(RECOVERY_RELEASED);
    session.unmount();
  });

  it('does not cancel or announce success when recovery or cancellation cannot reach the server', async () => {
    getDocs.mockRejectedValue(Object.assign(new Error('offline'), { code: 'unavailable' }));
    const failed = mount();
    await settle();
    expect(failed.bridge.flow!.recoveryError).toBe(RECOVERY_CHECK_FAILED);
    expect(failed.bridge.flow!.recoveredClaims).toEqual([]);
    expect(failed.bridge.flow!.recoveryAck).toBeNull();
    expect(cancelClaimCallable).not.toHaveBeenCalled();
    failed.unmount();

    spots.set('spots/spot-1', live('spot-1', G1, 'heading'));
    installReads();
    const session = mount();
    await settle();
    cancelClaimCallable.mockRejectedValue(Object.assign(new Error('offline'), { code: 'unavailable' }));
    await act(async () => { await session.bridge.flow!.releaseRecoveredClaim('spot-1'); });
    expect(session.bridge.flow!.recoveryAck).toBeNull();
    expect(session.bridge.flow!.recoveryError).toBe("Couldn't cancel — please try again");
    expect(session.bridge.flow!.recoveredClaims).toHaveLength(1);
    session.unmount();
  });

  it('does not discover or cancel a claim when product access is denied', async () => {
    spots.set('spots/spot-1', live('spot-1', G1, 'heading'));
    getDoc.mockRejectedValue(Object.assign(new Error('denied'), { code: 'permission-denied' }));
    const session = mount();
    await settle();
    expect(session.bridge.flow!.recoveryError).toBe(RECOVERY_CHECK_FAILED);
    expect(session.bridge.flow!.recoveredClaims).toEqual([]);
    expect(session.bridge.flow!.recoveryAck).toBeNull();
    expect(cancelClaimCallable).not.toHaveBeenCalled();
    expect(recordParkingAnalyticsEvent).not.toHaveBeenCalled();
    session.unmount();
  });

  it('drops the previous user\'s claim when authentication changes and does not cancel on a second read', async () => {
    spots.set('spots/spot-1', live('spot-1', G1, 'heading'));
    const session = mount(userA, null);
    await settle();
    expect(session.bridge.flow!.recoveredClaims).toHaveLength(1);
    session.unmount();
    const again = mount(userA, null);
    await settle();
    expect(cancelClaimCallable).not.toHaveBeenCalled();
    expect(recordParkingAnalyticsEvent).not.toHaveBeenCalled();
    again.bridge.user = { id: 'driver-2' };
    spots.clear();
    again.rerender();
    await settle();
    expect(again.bridge.flow!.recoveredClaims).toEqual([]);
    expect(again.bridge.flow!.recoveryAck).toBeNull();
    again.unmount();
  });

  it('opens the recovered spot for inspection without starting an acquisition', async () => {
    spots.set('spots/spot-1', live('spot-1', G1, 'heading', 'Inspect me'));
    const session = mount();
    await settle();
    await act(async () => { session.button('Inspect claim').props.onClick(); });
    expect(session.bridge.item).toMatchObject({
      id: 'spot-1',
      status: 'interested',
      interestedUserId: 'driver-1',
      claimGenerationId: G1,
      address: 'Inspect me',
    });
    expect(claimSpotCallable).not.toHaveBeenCalled();
    expect(prepareClaimIntentCallable).not.toHaveBeenCalled();
    expect(recordParkingAnalyticsEvent).not.toHaveBeenCalled();
    session.unmount();
  });
});
