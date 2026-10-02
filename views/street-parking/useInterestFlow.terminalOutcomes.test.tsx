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

vi.mock('../../firebase', () => ({ db: {} }));

const {
  addDoc, getDoc, getDocs, onSnapshot, runTransaction, setDoc, updateDoc,
} = vi.hoisted(() => ({
  addDoc: vi.fn(async (_collection: any, _data: any) => ({ id: 'notification' })),
  getDoc: vi.fn(async (_ref: any): Promise<any> => ({ exists: () => false, data: () => undefined })),
  getDocs: vi.fn(async () => ({ empty: true, docs: [] })),
  onSnapshot: vi.fn(() => () => {}),
  runTransaction: vi.fn(async (_db: any, _callback: any): Promise<any> => undefined),
  setDoc: vi.fn(async (_ref: any, _data: any) => {}),
  updateDoc: vi.fn(async (_ref: any, _data: any) => {}),
}));

vi.mock('firebase/firestore', () => ({
  addDoc,
  collection: vi.fn((_db, name) => ({ __collection: name })),
  deleteDoc: vi.fn(async () => {}),
  doc: vi.fn((_db, col, id) => ({ __col: col, __id: id })),
  getDoc,
  getDocs,
  increment: vi.fn((n: number) => ({ __increment: n })),
  limit: vi.fn(),
  onSnapshot,
  orderBy: vi.fn(),
  query: vi.fn((...args) => ({ __query: args })),
  runTransaction,
  setDoc,
  Timestamp: {
    fromMillis: (ms: number) => ({ toMillis: () => ms }),
    now: () => ({ toMillis: () => 1_000 }),
  },
  updateDoc,
  where: vi.fn(),
}));

vi.mock('./cancelClaimTransaction', () => ({ cancelClaimTransaction: vi.fn() }));
vi.mock('../../utils/errorReporting', () => ({ reportCriticalActionFailure: vi.fn() }));

import { useInterestFlow } from './useInterestFlow';

const user = { id: 'driver-1', username: 'Driver', crowns: 0 };
const spot = {
  id: 'spot-1',
  lat: 40.7,
  lng: -73.9,
  address: '1 Main St',
  title: '1 Main St',
  type: 'free' as const,
  finderId: 'finder-1',
  finderName: 'Finder',
  interestedUserId: user.id,
  status: 'interested' as const,
};

const documents = new Map<string, Record<string, any>>();
const pathOf = (ref: { __col: string; __id: string }) => `${ref.__col}/${ref.__id}`;
const permissionDenied = () => Object.assign(new Error('permission denied'), { code: 'permission-denied' });

function snapshotFor(ref: { __col: string; __id: string }) {
  const data = documents.get(pathOf(ref));
  return {
    exists: () => data !== undefined,
    data: () => data,
  };
}

function mount(currentUser: typeof user = user) {
  let flow!: ReturnType<typeof useInterestFlow>;
  const setSelectedItem = vi.fn();
  act(() => {
    TestRenderer.create(
      <Harness
        onReady={(next) => { flow = next; }}
        setSelectedItem={setSelectedItem}
        currentUser={currentUser}
      />,
    );
  });
  return { getFlow: () => flow, setSelectedItem };
}

function Harness({
  onReady, setSelectedItem, currentUser = user,
}: {
  onReady: (flow: ReturnType<typeof useInterestFlow>) => void;
  setSelectedItem: React.Dispatch<React.SetStateAction<any>>;
  currentUser?: typeof user;
}) {
  const flow = useInterestFlow({
    selectedItem: spot,
    setSelectedItem,
    user: currentUser,
    freeSpots: [spot],
    userLocation: null,
    mapRef: { current: null },
    activeRouteDestinationRef: { current: null },
  });
  onReady(flow);
  return null;
}

async function arrive(getFlow: () => ReturnType<typeof useInterestFlow>) {
  await act(async () => { await getFlow().handleArrival(); });
  expect(getFlow().handoffStep).toBe('outcome');
}

function writesTo(collection: string) {
  const calls = setDoc.mock.calls as unknown as Array<[any, Record<string, any>]>;
  return calls.filter(([ref]) => ref.__col === collection);
}

function updatesTo(collection: string) {
  const calls = updateDoc.mock.calls as unknown as Array<[any, Record<string, any>]>;
  return calls.filter(([ref]) => ref.__col === collection);
}

describe('useInterestFlow — terminal handoff outcomes', () => {
  beforeEach(() => {
    addDoc.mockClear();
    getDoc.mockReset();
    getDocs.mockClear();
    runTransaction.mockReset();
    setDoc.mockReset();
    setDoc.mockImplementation(async (ref, data) => {
      if ((ref.__col === 'spotFeedback' || ref.__col === 'spotNotifications')
        && documents.has(pathOf(ref))) {
        throw permissionDenied();
      }
      documents.set(pathOf(ref), data);
    });
    updateDoc.mockReset();
    updateDoc.mockImplementation(async (ref, data) => {
      documents.set(pathOf(ref), { ...(documents.get(pathOf(ref)) ?? {}), ...data });
    });
    documents.clear();
    documents.set('spots/spot-1', { ...spot });
    getDoc.mockImplementation(async (ref) => snapshotFor(ref));
    runTransaction.mockImplementation(async (_db, callback) => {
      const staged: Array<{ ref: any; data: Record<string, any>; merge?: boolean }> = [];
      const result = await callback({
        get: async (ref: any) => snapshotFor(ref),
        set: (ref: any, data: Record<string, any>) => staged.push({ ref, data }),
        update: (ref: any, data: Record<string, any>) => staged.push({ ref, data, merge: true }),
        delete: (_ref: any) => {},
      });
      if (staged.some(({ ref }) => ref.__col === 'spotFeedback' && documents.has(pathOf(ref)))) {
        throw permissionDenied();
      }
      for (const { ref, data, merge } of staged) {
        await setDoc(ref, merge ? { ...(documents.get(pathOf(ref)) ?? {}), ...data } : data);
      }
      return result;
    });
  });

  it('successful handoff reaches celebration without mutating the user root', async () => {
    const { getFlow } = mount();
    await arrive(getFlow);

    await act(async () => { await getFlow().handleHandoffOutcome('success'); });

    expect(getFlow().handoffStep).toBe('celebration');
    expect(getFlow().handoffSpotCoords).toEqual({ lat: 40.7, lng: -73.9, address: '1 Main St' });
    expect(documents.get('spots/spot-1')?.status).toBe('occupied');
    expect(writesTo('spotFeedback')).toHaveLength(1);
    expect(updatesTo('users')).toHaveLength(0);
  });

  it('finder-confirmed success atomically completes once with one deterministic notification', async () => {
    const finder = { id: 'finder-1', username: 'Finder', crowns: 0 };
    const { getFlow } = mount(finder);

    await act(async () => {
      await getFlow().handleFinderConfirmsArrival();
      await getFlow().handleFinderConfirmsArrival();
    });

    expect(runTransaction).toHaveBeenCalledTimes(2);
    expect(writesTo('spotFeedback')).toHaveLength(1);
    expect([...documents.keys()].filter((path) => path.startsWith('spotNotifications/'))).toHaveLength(1);
    expect(addDoc).toHaveBeenCalledTimes(0);
    expect(documents.get('spots/spot-1')?.status).toBe('occupied');
  });

  it('duplicate successful completion creates feedback and finder notification only once', async () => {
    const { getFlow } = mount();
    await arrive(getFlow);

    await act(async () => {
      await getFlow().handleHandoffOutcome('success');
      await getFlow().handleHandoffOutcome('success');
    });

    expect(writesTo('spotFeedback')).toHaveLength(1);
    expect([...documents.keys()].filter((path) => path.startsWith('spotNotifications/'))).toHaveLength(1);
    expect(addDoc).toHaveBeenCalledTimes(0);
  });

  it('retry after an already-committed successful terminal transaction restores celebration without duplicate state', async () => {
    documents.set('spotFeedback/spot-1_driver-1', {
      spotId: 'spot-1', userId: 'driver-1', finderId: 'finder-1',
      outcome: 'success', failureReason: null, address: '1 Main St',
    });
    documents.set('spotNotifications/handoff_success_spot-1_driver-1', {
      spotId: 'spot-1', senderId: 'driver-1', targetUserId: 'finder-1', type: 'handoff_success',
    });
    const { getFlow } = mount();
    await arrive(getFlow);

    await act(async () => { await getFlow().handleHandoffOutcome('success'); });

    expect(getFlow().handoffStep).toBe('celebration');
    expect(writesTo('spotFeedback')).toHaveLength(0);
    expect([...documents.keys()].filter((path) => path.startsWith('spotNotifications/'))).toHaveLength(1);
  });

  it('choosing failed only opens the reason step and performs no feedback write', async () => {
    const { getFlow } = mount();
    await arrive(getFlow);

    await act(async () => { await getFlow().handleHandoffOutcome('failed'); });

    expect(getFlow().handoffStep).toBe('failure_reason');
    expect(writesTo('spotFeedback')).toHaveLength(0);
  });

  it('failed handoff creates one complete immutable feedback document and closes the flow', async () => {
    const { getFlow, setSelectedItem } = mount();
    await arrive(getFlow);
    await act(async () => { await getFlow().handleHandoffOutcome('failed'); });

    await act(async () => { await getFlow().handleFailureReason('Someone else got it'); });

    expect(writesTo('spotFeedback')).toHaveLength(1);
    expect(writesTo('spotFeedback')[0][1]).toMatchObject({
      outcome: 'failed',
      failureReason: 'Someone else got it',
    });
    expect(updatesTo('spotFeedback')).toHaveLength(0);
    expect(documents.get('spots/spot-1')?.status).toBe('occupied');
    expect(getFlow().handoffStep).toBeNull();
    expect(setSelectedItem).toHaveBeenCalledWith(null);
  });

  it('duplicate failed submission creates feedback only once', async () => {
    const { getFlow } = mount();
    await arrive(getFlow);
    await act(async () => { await getFlow().handleHandoffOutcome('failed'); });

    await act(async () => {
      await getFlow().handleFailureReason("Finder hadn't left yet");
      await getFlow().handleFailureReason("Finder hadn't left yet");
    });

    expect(writesTo('spotFeedback')).toHaveLength(1);
    expect(writesTo('spotFeedback')[0][1]).toMatchObject({
      outcome: 'failed',
      failureReason: "Finder hadn't left yet",
    });
    expect(updatesTo('spotFeedback')).toHaveLength(0);
  });

  it('retry after already-committed failed feedback closes cleanly without another write', async () => {
    documents.set('spotFeedback/spot-1_driver-1', {
      spotId: 'spot-1', userId: 'driver-1', finderId: 'finder-1',
      outcome: 'failed', failureReason: "Couldn't find the location", address: '1 Main St',
    });
    const { getFlow } = mount();
    await arrive(getFlow);
    await act(async () => { await getFlow().handleHandoffOutcome('failed'); });

    await act(async () => { await getFlow().handleFailureReason("Couldn't find the location"); });

    expect(getFlow().handoffStep).toBeNull();
    expect(writesTo('spotFeedback')).toHaveLength(0);
  });

  it('invalid failed-handoff reason is rejected without writing or closing the flow', async () => {
    const { getFlow } = mount();
    await arrive(getFlow);
    await act(async () => { await getFlow().handleHandoffOutcome('failed'); });

    await expect(getFlow().handleFailureReason('arbitrary user text')).rejects.toThrow('Invalid handoff failure reason');

    expect(writesTo('spotFeedback')).toHaveLength(0);
    expect(getFlow().handoffStep).toBe('failure_reason');
  });

  it('a failed terminal write preserves the current step and remains retryable', async () => {
    const error = Object.assign(new Error('unavailable'), { code: 'unavailable' });
    const { getFlow } = mount();
    await arrive(getFlow);
    // Arrival now commits through the same transaction helper, which applies
    // its spot update via setDoc. Reject only the following terminal write.
    setDoc.mockRejectedValueOnce(error);

    await expect(getFlow().handleHandoffOutcome('success')).rejects.toBe(error);

    expect(getFlow().handoffStep).toBe('outcome');
  });
});
