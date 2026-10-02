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

const { getDocs } = vi.hoisted(() => ({
  getDocs: vi.fn(async () => ({ empty: true, docs: [] })),
}));

vi.mock('firebase/firestore', () => ({
  doc: vi.fn((_db: unknown, col: string, id: string) => ({ __col: col, __id: id })),
  updateDoc: vi.fn(async () => {}),
  deleteDoc: vi.fn(async () => {}),
  runTransaction: vi.fn(),
  Timestamp: {
    now: () => ({ toMillis: () => Date.now() }),
    fromMillis: (ms: number) => ({ toMillis: () => ms }),
  },
  collection: vi.fn((_db: unknown, name: string) => ({ __collection: name })),
  query: vi.fn((...args: unknown[]) => ({ __query: args })),
  where: vi.fn(),
  getDocs,
  addDoc: vi.fn(async () => ({ id: 'notif1' })),
  setDoc: vi.fn(async () => {}),
  onSnapshot: vi.fn(() => () => {}),
  orderBy: vi.fn(),
  limit: vi.fn(),
  increment: vi.fn((n: number) => ({ __increment: n })),
}));

const { acquireActiveIncomingClaim, markClaimArrived } = vi.hoisted(() => ({
  acquireActiveIncomingClaim: vi.fn(async () => 'claimed' as const),
  markClaimArrived: vi.fn(async () => {}),
}));
vi.mock('./activeIncomingClaim', () => ({
  acquireActiveIncomingClaim,
  markClaimArrived,
  ALREADY_CLAIMED_MESSAGE: 'You already have a claimed spot',
}));

const { commitClaimToHeading } = vi.hoisted(() => ({
  commitClaimToHeading: vi.fn(async () => 'committed' as const),
}));
vi.mock('./commitToHeading', () => ({ commitClaimToHeading }));

const { cancelClaimTransaction } = vi.hoisted(() => ({
  cancelClaimTransaction: vi.fn(async () => 'cancelled' as const),
}));
vi.mock('./cancelClaimTransaction', () => ({ cancelClaimTransaction }));

vi.mock('../../utils/errorReporting', () => ({ reportCriticalActionFailure: vi.fn() }));

import { ALREADY_CLAIMED_MESSAGE } from './activeIncomingClaim';
import { useInterestFlow } from './useInterestFlow';

const user = { id: 'driver-1', username: 'Driver', crowns: 0 };
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

function mount() {
  let flow!: ReturnType<typeof useInterestFlow>;
  act(() => {
    TestRenderer.create(<Harness onReady={(next) => { flow = next; }} />);
  });
  return () => flow;
}

function Harness({ onReady }: { onReady: (flow: ReturnType<typeof useInterestFlow>) => void }) {
  const flow = useInterestFlow({
    selectedItem: spot,
    setSelectedItem: () => {},
    user,
    freeSpots: [spot],
    userLocation: null,
    mapRef: { current: null },
    activeRouteDestinationRef: { current: null },
  });
  onReady(flow);
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

describe('useInterestFlow in-flight claim and arrive guards', () => {
  beforeEach(() => {
    getDocs.mockReset();
    getDocs.mockResolvedValue({ empty: true, docs: [] });
    acquireActiveIncomingClaim.mockReset();
    acquireActiveIncomingClaim.mockResolvedValue('claimed');
    markClaimArrived.mockReset();
    markClaimArrived.mockResolvedValue(undefined);
    commitClaimToHeading.mockReset();
    commitClaimToHeading.mockResolvedValue('committed');
    cancelClaimTransaction.mockReset();
    cancelClaimTransaction.mockResolvedValue('cancelled');
  });

  it('ignores a second claim tap while an immediate claim write is in flight', async () => {
    const pending = deferred<void>();
    acquireActiveIncomingClaim.mockReturnValue(pending.promise);
    const getFlow = mount();

    let first!: Promise<void>;
    act(() => { first = getFlow().handleExpressInterest(5); });
    expect(getFlow().claiming).toBe(true);

    await act(async () => { await getFlow().handleExpressInterest(5); });
    expect(acquireActiveIncomingClaim).toHaveBeenCalledTimes(1);

    pending.resolve();
    await act(async () => { await first; });
    expect(getFlow().claiming).toBe(false);
  });

  it('ignores a second scheduled-claim tap while that write is in flight', async () => {
    const pending = deferred<void>();
    acquireActiveIncomingClaim.mockReturnValue(pending.promise);
    const getFlow = mount();

    let first!: Promise<void>;
    act(() => { first = getFlow().handleScheduledClaim(); });
    await act(async () => { await getFlow().handleScheduledClaim(); });
    expect(acquireActiveIncomingClaim).toHaveBeenCalledTimes(1);
    expect(getFlow().claiming).toBe(true);

    pending.resolve();
    await act(async () => { await first; });
    expect(getFlow().claiming).toBe(false);
  });

  it('ignores a second commit-to-heading tap while that write is in flight', async () => {
    const pending = deferred<'committed'>();
    commitClaimToHeading.mockReturnValue(pending.promise);
    const getFlow = mount();

    let first!: Promise<void>;
    act(() => { first = getFlow().handleCommitToHeading(); });
    await act(async () => { await getFlow().handleCommitToHeading(); });
    expect(commitClaimToHeading).toHaveBeenCalledTimes(1);

    pending.resolve('committed');
    await act(async () => { await first; });
    expect(getFlow().claiming).toBe(false);
  });

  it('ignores a second arrive tap while the arrival write is in flight', async () => {
    const pending = deferred<void>();
    markClaimArrived.mockReturnValue(pending.promise);
    const getFlow = mount();

    let first!: Promise<void>;
    act(() => { first = getFlow().handleArrival(); });
    expect(getFlow().arriving).toBe(true);

    await act(async () => { await getFlow().handleArrival(); });
    expect(markClaimArrived).toHaveBeenCalledTimes(1);

    pending.resolve();
    await act(async () => { await first; });
    expect(getFlow().arriving).toBe(false);
    expect(getFlow().handoffStep).toBe('outcome');
  });

  it('clears the claim guard after a failed immediate claim so the user can retry', async () => {
    acquireActiveIncomingClaim.mockRejectedValueOnce(new Error('unavailable'));
    const getFlow = mount();

    await act(async () => { await getFlow().handleExpressInterest(5); });
    expect(getFlow().claiming).toBe(false);
    expect(getFlow().interestError).toBe('unavailable');

    acquireActiveIncomingClaim.mockResolvedValueOnce('claimed');
    await act(async () => { await getFlow().handleExpressInterest(5); });
    expect(acquireActiveIncomingClaim).toHaveBeenCalledTimes(2);
    expect(getFlow().claiming).toBe(false);
    expect(getFlow().interestError).toBeNull();
  });

  it('clears the claim guard when the already-active hint fires, without a write', async () => {
    getDocs.mockResolvedValueOnce({ empty: false, docs: [{ id: 'other' }] });
    const getFlow = mount();

    await act(async () => { await getFlow().handleExpressInterest(5); });
    expect(acquireActiveIncomingClaim).not.toHaveBeenCalled();
    expect(getFlow().claiming).toBe(false);
    expect(getFlow().interestError).toBe(ALREADY_CLAIMED_MESSAGE);
  });

  it('clears the arrive guard after a failed arrival so the user can retry', async () => {
    markClaimArrived.mockRejectedValueOnce(new Error('network'));
    const getFlow = mount();

    let caught: unknown;
    await act(async () => {
      try {
        await getFlow().handleArrival();
      } catch (error) {
        caught = error;
      }
    });
    expect((caught as Error).message).toBe('network');
    expect(getFlow().arriving).toBe(false);
    expect(getFlow().handoffStep).toBeNull();

    markClaimArrived.mockResolvedValueOnce(undefined);
    await act(async () => { await getFlow().handleArrival(); });
    expect(markClaimArrived).toHaveBeenCalledTimes(2);
    expect(getFlow().arriving).toBe(false);
    expect(getFlow().handoffStep).toBe('outcome');
  });

  it('does not start a claim while cancel is in flight', async () => {
    const pending = deferred<'cancelled'>();
    cancelClaimTransaction.mockReturnValue(pending.promise);
    const getFlow = mount();

    let cancel!: Promise<void>;
    act(() => { cancel = getFlow().handleCancelByClaimer('Changed my mind'); });
    expect(getFlow().cancelingClaim).toBe(true);

    await act(async () => { await getFlow().handleExpressInterest(5); });
    expect(acquireActiveIncomingClaim).not.toHaveBeenCalled();

    pending.resolve('cancelled');
    await act(async () => { await cancel; });
    expect(getFlow().cancelingClaim).toBe(false);
  });

  it('does not start an arrival while a claim write is still open', async () => {
    const pending = deferred<void>();
    acquireActiveIncomingClaim.mockReturnValue(pending.promise);
    const getFlow = mount();

    let claim!: Promise<void>;
    act(() => { claim = getFlow().handleExpressInterest(5); });
    await act(async () => { await getFlow().handleArrival(); });
    expect(markClaimArrived).not.toHaveBeenCalled();
    expect(getFlow().arriving).toBe(false);

    pending.resolve();
    await act(async () => { await claim; });
  });

  it('still ignores a second cancel tap and clears that guard after failure', async () => {
    const pending = deferred<'cancelled'>();
    cancelClaimTransaction.mockReturnValueOnce(pending.promise);
    const getFlow = mount();

    let first!: Promise<void>;
    act(() => { first = getFlow().handleCancelByClaimer('Changed my mind'); });
    await act(async () => { await getFlow().handleCancelByClaimer('Traffic is too heavy'); });
    expect(cancelClaimTransaction).toHaveBeenCalledTimes(1);

    pending.resolve('cancelled');
    await act(async () => { await first; });

    cancelClaimTransaction.mockRejectedValueOnce(new Error('unavailable'));
    await act(async () => { await getFlow().handleCancelByClaimer('Changed my mind'); });
    expect(getFlow().cancelingClaim).toBe(false);
    expect(cancelClaimTransaction).toHaveBeenCalledTimes(2);
  });
});
