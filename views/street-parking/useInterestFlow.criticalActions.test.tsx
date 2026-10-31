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
  getDocs, getDoc, runTransaction, onSnapshot, updateDoc, deleteDoc, addDoc, setDoc,
} = vi.hoisted(() => ({
  getDocs: vi.fn(async () => ({ empty: true, docs: [] })),
  getDoc: vi.fn(async () => ({
    exists: () => true,
    data: () => ({
      status: 'occupied',
      claimState: 'arrived_pending_outcome',
      arrivedAt: { toMillis: () => Date.now() },
      interestedUserId: 'u1',
      finderId: 'finder1',
    }),
  })),
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
  getDoc,
  addDoc,
  setDoc,
  onSnapshot,
  orderBy: vi.fn(),
  limit: vi.fn(),
  increment: vi.fn((n: number) => ({ __increment: n })),
}));

const { cancelClaimCallable } = vi.hoisted(() => ({ cancelClaimCallable: vi.fn() }));
vi.mock('./cancelClaimCallable', () => ({ cancelClaimCallable }));

const { claimSpotCallable, prepareClaimIntentCallable, revokeClaimIntentCallable } = vi.hoisted(() => ({
  claimSpotCallable: vi.fn(async (input: { spotId: string; mode: 'immediate' | 'scheduled' }) => ({
    outcome: 'claimed' as const,
    claimGenerationId: 'a'.repeat(64),
    spotId: input.spotId,
    mode: input.mode,
  })),
  prepareClaimIntentCallable: vi.fn(async (input: { attemptId: string; spotId: string; mode: string }) => ({
    state: 'prepared', attemptId: input.attemptId, spotId: input.spotId, mode: input.mode, expiresAt: 1,
  })),
  revokeClaimIntentCallable: vi.fn(async () => ({ outcome: 'revoked', attemptId: 'x', spotId: 'spot1', mode: 'immediate' })),
}));
vi.mock('./claimSpotCallable', () => ({ claimSpotCallable, prepareClaimIntentCallable, revokeClaimIntentCallable }));

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
    cancelClaimCallable.mockReset();
    claimSpotCallable.mockReset();
    claimSpotCallable.mockImplementation(async (input: { spotId: string; mode: 'immediate' | 'scheduled' }) => ({
      outcome: 'claimed' as const,
      claimGenerationId: 'a'.repeat(64),
      spotId: input.spotId,
      mode: input.mode,
    }));
    getDocs.mockClear();
    getDoc.mockReset();
    getDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({
        status: 'occupied',
        claimState: 'arrived_pending_outcome',
        arrivedAt: { toMillis: () => Date.now() },
        interestedUserId: 'u1',
        finderId: 'finder1',
      }),
    });
    updateDoc.mockClear();
    deleteDoc.mockClear();
  });

  it('handleExpressInterest: a failed transaction reports spot_claim/immediate exactly once, with no ids/coordinates', async () => {
    claimSpotCallable.mockRejectedValue(txError);
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
    getDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({
        status: 'interested',
        claimState: 'heading',
        claimGenerationId: 'a'.repeat(64),
        interestedUserId: 'u1',
      }),
    });
    const getFlow = mount();

    await act(async () => { await getFlow().handleExpressInterest(5); });

    expect(reportCriticalActionFailure).not.toHaveBeenCalled();
    expect(getFlow().interestError).toBeNull();
  });

  it('handleScheduledClaim: a failed transaction reports spot_claim/scheduled exactly once', async () => {
    claimSpotCallable.mockRejectedValue(txError);
    const getFlow = mount();

    await act(async () => { await getFlow().handleScheduledClaim(); });

    expect(reportCriticalActionFailure).toHaveBeenCalledTimes(1);
    expect(reportCriticalActionFailure).toHaveBeenCalledWith('spot_claim', txError, { operationType: 'scheduled' });
    expect(getFlow().interestError).toBe('unavailable');
  });

  it('handleScheduledClaim: a successful claim reports zero failures', async () => {
    getDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({
        status: 'interested',
        claimState: 'committed',
        claimGenerationId: 'a'.repeat(64),
        interestedUserId: 'u1',
      }),
    });
    const getFlow = mount();

    await act(async () => { await getFlow().handleScheduledClaim(); });

    expect(reportCriticalActionFailure).not.toHaveBeenCalled();
  });

  it('handleCancelByClaimer: a failed cancellation reports claim_cancel exactly once, with no spot/finder ids, and still shows the existing generic error copy', async () => {
    getDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ claimGenerationId: 'a'.repeat(64), status: 'interested', interestedUserId: 'u1' }),
    });
    cancelClaimCallable.mockRejectedValue(txError);
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
    getDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ claimGenerationId: 'a'.repeat(64), status: 'interested', interestedUserId: 'u1' }),
    });
    cancelClaimCallable.mockResolvedValue('cancelled');
    const getFlow = mount();

    await act(async () => { await getFlow().handleCancelByClaimer('Changed my mind'); });

    expect(reportCriticalActionFailure).not.toHaveBeenCalled();
  });

  it('handleCancelByClaimer: duplicate-tap protection is unchanged — a second concurrent call is a no-op', async () => {
    getDoc.mockResolvedValue({
      exists: () => true,
      data: () => ({ claimGenerationId: 'a'.repeat(64), status: 'interested', interestedUserId: 'u1' }),
    });
    let resolveCancel!: (v: string) => void;
    cancelClaimCallable.mockReturnValue(new Promise((resolve) => { resolveCancel = resolve; }));
    const getFlow = mount();

    let firstCall!: Promise<void>;
    act(() => { firstCall = getFlow().handleCancelByClaimer('Changed my mind'); });
    // Second tap while the first is still in flight.
    await act(async () => { await getFlow().handleCancelByClaimer('Changed my mind'); });
    expect(cancelClaimCallable).toHaveBeenCalledTimes(1);

    resolveCancel('cancelled');
    await act(async () => { await firstCall; });
  });

  it('handleHandoffOutcome reports terminal_handoff and stays on the outcome step when the write fails', async () => {
    runTransaction.mockImplementationOnce(async (_db, cb) => cb({
      get: async () => ({ exists: () => true, data: () => ({ status: 'interested', interestedUserId: 'u1', finderId: 'finder1' }) }),
      update: vi.fn(),
      delete: vi.fn(),
    }));
    const getFlow = mount();

    // Establish handoffSpotRef via handleArrival first, matching real flow.
    await act(async () => { await getFlow().handleArrival(); });
    setDoc.mockRejectedValueOnce(txError);

    await act(async () => { await getFlow().handleHandoffOutcome('success'); });
    expect(reportCriticalActionFailure).toHaveBeenCalledTimes(1);
    expect(reportCriticalActionFailure).toHaveBeenCalledWith('terminal_handoff', txError);
    expect(getFlow().handoffStep).toBe('outcome');
    expect(getFlow().handoffSubmitError).toBe("Couldn't save this outcome.");
  });
});
