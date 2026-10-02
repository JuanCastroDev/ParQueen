import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n';
import { PingCreateRejected } from './pingCreateBounds';

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

const { commitPingCreate } = vi.hoisted(() => ({
  commitPingCreate: vi.fn(async () => {}),
}));

vi.mock('./pingCreateBounds', async () => {
  const actual = await vi.importActual<typeof import('./pingCreateBounds')>('./pingCreateBounds');
  return { ...actual, commitPingCreate };
});

const {
  addDoc, getDoc, getDocs, onSnapshot, runTransaction, setDoc, updateDoc,
} = vi.hoisted(() => ({
  addDoc: vi.fn(async () => ({ id: 'notification' })),
  getDoc: vi.fn(async (): Promise<any> => ({ exists: () => false, data: () => undefined })),
  getDocs: vi.fn(async () => ({ empty: true, docs: [] })),
  onSnapshot: vi.fn(() => () => {}),
  runTransaction: vi.fn(async (_db: any, callback: any): Promise<any> => callback({
    get: async () => ({ exists: () => false, data: () => undefined }),
    set: () => {},
    update: () => {},
    delete: () => {},
  })),
  setDoc: vi.fn(async () => {}),
  updateDoc: vi.fn(async () => {}),
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
    now: () => ({ toMillis: () => Date.now() }),
  },
  updateDoc,
  where: vi.fn(),
}));

vi.mock('./cancelClaimTransaction', () => ({ cancelClaimTransaction: vi.fn() }));
vi.mock('../../utils/errorReporting', () => ({ reportCriticalActionFailure: vi.fn() }));

import { useInterestFlow } from './useInterestFlow';

const documents = new Map<string, Record<string, any>>();
const pathOf = (ref: { __col?: string; __id?: string }) => `${ref.__col}/${ref.__id}`;

function snapshotFor(ref: { __col?: string; __id?: string }) {
  const data = documents.get(pathOf(ref));
  return { exists: () => data !== undefined, data: () => data };
}

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
  geohash: 'dr5regw',
};

function mount() {
  let flow!: ReturnType<typeof useInterestFlow>;
  const setSelectedItem = vi.fn();
  act(() => {
    TestRenderer.create(
      <Harness onReady={(next) => { flow = next; }} setSelectedItem={setSelectedItem} />,
    );
  });
  return { getFlow: () => flow, setSelectedItem };
}

function Harness({
  onReady, setSelectedItem,
}: {
  onReady: (flow: ReturnType<typeof useInterestFlow>) => void;
  setSelectedItem: React.Dispatch<React.SetStateAction<any>>;
}) {
  const flow = useInterestFlow({
    selectedItem: spot,
    setSelectedItem,
    user,
    freeSpots: [spot],
    userLocation: null,
    mapRef: { current: null },
    activeRouteDestinationRef: { current: null },
  });
  onReady(flow);
  return null;
}

async function reachCelebration(getFlow: () => ReturnType<typeof useInterestFlow>) {
  await act(async () => { await getFlow().handleArrival(); });
  await act(async () => { await getFlow().handleHandoffOutcome('success'); });
  expect(getFlow().handoffStep).toBe('celebration');
}

describe('handleDeparturePing denial UX', () => {
  beforeEach(() => {
    commitPingCreate.mockReset();
    commitPingCreate.mockResolvedValue(undefined);
    addDoc.mockClear();
    getDocs.mockClear();
    setDoc.mockReset();
    updateDoc.mockReset();
    documents.clear();
    documents.set('spots/spot-1', { ...spot });
    getDoc.mockImplementation(async (ref) => snapshotFor(ref));
    runTransaction.mockImplementation(async (_db, callback) => {
      const staged: Array<{ ref: any; data: Record<string, any>; merge?: boolean }> = [];
      const result = await callback({
        get: async (ref: any) => snapshotFor(ref),
        set: (ref: any, data: Record<string, any>) => staged.push({ ref, data }),
        update: (ref: any, data: Record<string, any>) => staged.push({ ref, data, merge: true }),
        delete: () => {},
      });
      for (const { ref, data, merge } of staged) {
        documents.set(pathOf(ref), merge ? { ...(documents.get(pathOf(ref)) ?? {}), ...data } : data);
      }
      return result;
    });
  });

  it('shows the rate-limit toast when the rolling-hour cap denies the re-ping', async () => {
    commitPingCreate.mockRejectedValue(new PingCreateRejected('rate', 12));
    const { getFlow, setSelectedItem } = mount();
    await reachCelebration(getFlow);

    await act(async () => { await getFlow().handleDeparturePing(30); });

    expect(commitPingCreate).toHaveBeenCalledTimes(1);
    expect(getFlow().driverNotifVariant).toBe('warning');
    expect(getFlow().driverNotifTitle).toBe(t('ping_errors.denied_title'));
    expect(getFlow().driverNotification).toBe(t('ping_errors.rate_limit', { min: 12 }));
    expect(getFlow().handoffStep).toBe('celebration');
    expect(setSelectedItem).not.toHaveBeenCalledWith(null);
  });

  it('shows the origin toast when this handoff was already re-pinged', async () => {
    commitPingCreate.mockRejectedValue(new PingCreateRejected('origin'));
    const { getFlow } = mount();
    await reachCelebration(getFlow);

    await act(async () => { await getFlow().handleDeparturePing(30); });

    expect(commitPingCreate).toHaveBeenCalledTimes(1);
    expect(getFlow().driverNotification).toBe(t('ping_errors.origin'));
    expect(getFlow().driverNotifTitle).toBe(t('ping_errors.denied_title'));
    expect(getFlow().handoffStep).toBe('celebration');
  });

  it('shows a visible failure toast when Rules return a generic permission-denied', async () => {
    commitPingCreate.mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'permission-denied' }));
    const { getFlow } = mount();
    await reachCelebration(getFlow);

    await act(async () => { await getFlow().handleDeparturePing(30); });

    expect(getFlow().driverNotification).toBe(t('ping_errors.save_failed'));
    expect(getFlow().driverNotifVariant).toBe('warning');
    expect(getFlow().handoffStep).toBe('celebration');
  });
});
