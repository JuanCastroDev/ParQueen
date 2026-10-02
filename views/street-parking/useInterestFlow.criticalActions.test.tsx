import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('../../firebase', () => ({ db: {} }));

const {
  getDocs, runTransaction, onSnapshot, updateDoc, deleteDoc, addDoc, setDoc,
} = vi.hoisted(() => ({
  getDocs: vi.fn(async () => ({ empty: true, docs: [] })),
  runTransaction: vi.fn(),
  onSnapshot: vi.fn(() => () => {}),
  updateDoc: vi.fn(async () => {}),
  deleteDoc: vi.fn(async () => {}),
  addDoc: vi.fn(async () => ({ id: 'notif1' })),
  setDoc: vi.fn(async () => {}),
}));

vi.mock('firebase/firestore', () => ({
  doc: vi.fn((_db, col, id) => ({ __col: col, __id: id })),
  updateDoc,
  deleteDoc,
  runTransaction,
  Timestamp: {
    now: () => ({ toMillis: () => Date.now() }),
    fromMillis: (ms: number) => ({ toMillis: () => ms }),
  },
  collection: vi.fn((_db, name) => ({ __collection: name })),
  query: vi.fn((...args) => ({ __query: args })),
  where: vi.fn(),
  getDocs,
  addDoc,
  setDoc,
  onSnapshot,
  orderBy: vi.fn(),
  limit: vi.fn(),
  increment: vi.fn((n: number) => ({ __increment: n })),
}));

const { cancelClaimTransaction } = vi.hoisted(() => ({ cancelClaimTransaction: vi.fn() }));
vi.mock('./cancelClaimTransaction', () => ({ cancelClaimTransaction }));

const { reportCriticalActionFailure } = vi.hoisted(() => ({ reportCriticalActionFailure: vi.fn() }));
vi.mock('../../utils/errorReporting', () => ({ reportCriticalActionFailure }));

import { useInterestFlow } from './useInterestFlow';

const user = { id: 'u1', username: 'driver1', crowns: 0 };
const spot = { id: 'spot1', lat: 40.7, lng: -73.9, finderId: 'finder1', finderName: 'Finder' };

function Harness({ onReady, selectedItem = spot }: { onReady: (flow: ReturnType<typeof useInterestFlow>) => void; selectedItem?: any }) {
  const flow = useInterestFlow({
    selectedItem,
    setSelectedItem: () => {},
    user,
    freeSpots: [selectedItem],
    userLocation: null,
    mapRef: { current: null },
    activeRouteDestinationRef: { current: null },
  });
  onReady(flow);
  return null;
}

function mount(selectedItem = spot) {
  let flow!: ReturnType<typeof useInterestFlow>;
  act(() => {
    TestRenderer.create(<Harness selectedItem={selectedItem} onReady={(f) => { flow = f; }} />);
  });
  return () => flow;
}

const txError = Object.assign(new Error('unavailable'), { code: 'unavailable' });

describe('useInterestFlow — critical-action failure reporting', () => {
  beforeEach(() => {
    reportCriticalActionFailure.mockClear();
    runTransaction.mockReset();
    cancelClaimTransaction.mockReset();
    getDocs.mockClear();
    updateDoc.mockClear();
    deleteDoc.mockClear();
  });

  it('handleExpressInterest: a failed transaction reports spot_claim/immediate exactly once, with no ids/coordinates', async () => {
    runTransaction.mockRejectedValue(txError);
    const getFlow = mount();

    await act(async () => { await getFlow().handleExpressInterest(5); });

    expect(reportCriticalActionFailure).toHaveBeenCalledTimes(1);
    const [action, error, context] = reportCriticalActionFailure.mock.calls[0];
    expect(action).toBe('spot_claim');
    expect(error).toBe(txError);
    expect(context).toEqual({ operationType: 'immediate' });
    // existing user-facing behavior unchanged: retryable error message set
    expect(getFlow().interestError).toBe('unavailable');
  });

  it('handleExpressInterest: a successful claim reports zero failures', async () => {
    runTransaction.mockImplementation(async (_db, cb) => cb({
      get: async () => ({ exists: () => true, data: () => ({ status: 'available' }) }),
      update: vi.fn(),
      set: vi.fn(),
    }));
    const getFlow = mount();

    await act(async () => { await getFlow().handleExpressInterest(5); });

    expect(reportCriticalActionFailure).not.toHaveBeenCalled();
    expect(getFlow().interestError).toBeNull();
  });

  it('handleScheduledClaim: a failed transaction reports spot_claim/scheduled exactly once', async () => {
    runTransaction.mockRejectedValue(txError);
    const getFlow = mount();

    await act(async () => { await getFlow().handleScheduledClaim(); });

    expect(reportCriticalActionFailure).toHaveBeenCalledTimes(1);
    expect(reportCriticalActionFailure).toHaveBeenCalledWith('spot_claim', txError, { operationType: 'scheduled' });
    expect(getFlow().interestError).toBe('unavailable');
  });

  it('handleScheduledClaim: a successful claim reports zero failures', async () => {
    runTransaction.mockImplementation(async (_db, cb) => cb({
      get: async () => ({ exists: () => true, data: () => ({ status: 'available', reportedAt: { toMillis: () => Date.now() + 3600_000 }, expiresAt: { toMillis: () => Date.now() + 7200_000 } }) }),
      update: vi.fn(),
      set: vi.fn(),
    }));
    const getFlow = mount();

    await act(async () => { await getFlow().handleScheduledClaim(); });

    expect(reportCriticalActionFailure).not.toHaveBeenCalled();
  });

  it('handleCancelByClaimer: a failed cancellation reports claim_cancel exactly once, with no spot/finder ids, and still shows the existing generic error copy', async () => {
    cancelClaimTransaction.mockRejectedValue(txError);
    const getFlow = mount();

    await act(async () => { await getFlow().handleCancelByClaimer('Changed my mind'); });

    expect(reportCriticalActionFailure).toHaveBeenCalledTimes(1);
    const [action, error, context] = reportCriticalActionFailure.mock.calls[0];
    expect(action).toBe('claim_cancel');
    expect(error).toBe(txError);
    expect(context).toBeUndefined();
    // Unchanged existing UX contract: never leaks raw SDK text to the user.
    expect(getFlow().interestError).not.toContain('unavailable');
    expect(getFlow().cancelingClaim).toBe(false);
  });

  it('handleCancelByClaimer: a successful cancellation reports zero failures', async () => {
    cancelClaimTransaction.mockResolvedValue('cancelled');
    const getFlow = mount();

    await act(async () => { await getFlow().handleCancelByClaimer('Changed my mind'); });

    expect(reportCriticalActionFailure).not.toHaveBeenCalled();
  });

  it('handleCancelByClaimer: duplicate-tap protection is unchanged — a second concurrent call is a no-op', async () => {
    let resolveCancel!: (v: string) => void;
    cancelClaimTransaction.mockReturnValue(new Promise((resolve) => { resolveCancel = resolve; }));
    const getFlow = mount();

    let firstCall!: Promise<void>;
    act(() => { firstCall = getFlow().handleCancelByClaimer('Changed my mind'); });
    // Second tap while the first is still in flight.
    await act(async () => { await getFlow().handleCancelByClaimer('Changed my mind'); });
    expect(cancelClaimTransaction).toHaveBeenCalledTimes(1);

    resolveCancel('cancelled');
    await act(async () => { await firstCall; });
  });

  it('handleHandoffOutcome remains uncaught on failure (no local catch) — Sentry\'s global handler covers it, so no explicit report is added here', async () => {
    runTransaction.mockImplementationOnce(async (_db, cb) => cb({
      get: async () => ({ exists: () => true, data: () => ({ status: 'interested', interestedUserId: 'u1' }) }),
      update: vi.fn(),
      delete: vi.fn(),
    }));
    runTransaction.mockRejectedValueOnce(txError);
    const getFlow = mount();

    // Establish handoffSpotRef via handleArrival first, matching real flow.
    await act(async () => { await getFlow().handleArrival(); });

    await expect(getFlow().handleHandoffOutcome('success')).rejects.toBe(txError);
    expect(reportCriticalActionFailure).not.toHaveBeenCalled();
  });
});
