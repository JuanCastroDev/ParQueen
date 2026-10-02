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

const { updateDoc } = vi.hoisted(() => ({
  updateDoc: vi.fn(async () => {}),
}));

vi.mock('firebase/firestore', () => ({
  doc: vi.fn((_db: unknown, col: string, id: string) => ({ __col: col, __id: id })),
  updateDoc,
  deleteDoc: vi.fn(async () => {}),
  runTransaction: vi.fn(),
  Timestamp: {
    now: () => ({ toMillis: () => Date.now() }),
    fromMillis: (ms: number) => ({ toMillis: () => ms }),
  },
  collection: vi.fn((_db: unknown, name: string) => ({ __collection: name })),
  query: vi.fn((...args: unknown[]) => ({ __query: args })),
  where: vi.fn(),
  getDocs: vi.fn(async () => ({ empty: true, docs: [] })),
  addDoc: vi.fn(async () => ({ id: 'notif1' })),
  setDoc: vi.fn(async () => {}),
  onSnapshot: vi.fn(() => () => {}),
  orderBy: vi.fn(),
  limit: vi.fn(),
  increment: vi.fn((n: number) => ({ __increment: n })),
}));

const { commitClaimToHeading } = vi.hoisted(() => ({
  commitClaimToHeading: vi.fn(),
}));
vi.mock('./commitToHeading', () => ({ commitClaimToHeading }));

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
  interestedUserId: user.id,
  status: 'interested' as const,
  claimState: 'committed' as const,
};

function mount() {
  const activeRouteDestinationRef: { current: [number, number] | null } = { current: null };
  let flow!: ReturnType<typeof useInterestFlow>;
  act(() => {
    TestRenderer.create(
      <Harness
        destinationRef={activeRouteDestinationRef}
        onReady={(next) => { flow = next; }}
      />,
    );
  });
  return { getFlow: () => flow, activeRouteDestinationRef };
}

function Harness({
  onReady,
  destinationRef,
}: {
  onReady: (flow: ReturnType<typeof useInterestFlow>) => void;
  destinationRef: { current: [number, number] | null };
}) {
  const flow = useInterestFlow({
    selectedItem: spot,
    setSelectedItem: () => {},
    user,
    freeSpots: [spot],
    userLocation: null,
    mapRef: { current: null },
    activeRouteDestinationRef: destinationRef,
  });
  onReady(flow);
  return null;
}

describe('useInterestFlow handleCommitToHeading', () => {
  beforeEach(() => {
    commitClaimToHeading.mockReset();
    updateDoc.mockClear();
  });

  it('starts navigation only after the transaction commits or is already heading', async () => {
    commitClaimToHeading.mockResolvedValueOnce('committed');
    const committed = mount();
    await act(async () => { await committed.getFlow().handleCommitToHeading(); });
    expect(commitClaimToHeading).toHaveBeenCalledWith({ __db: true }, {
      spotId: 'spot-1',
      uid: 'driver-1',
      etaMinutes: 5,
      claimMinutes: 10,
    });
    expect(committed.activeRouteDestinationRef.current).toEqual([-73.9, 40.7]);
    expect(updateDoc).not.toHaveBeenCalled();

    commitClaimToHeading.mockResolvedValueOnce('already_heading');
    const again = mount();
    await act(async () => { await again.getFlow().handleCommitToHeading(); });
    expect(again.activeRouteDestinationRef.current).toEqual([-73.9, 40.7]);
  });

  it('does not start navigation when auto-release already won', async () => {
    commitClaimToHeading.mockResolvedValueOnce('rejected');
    const rejected = mount();
    await act(async () => { await rejected.getFlow().handleCommitToHeading(); });
    expect(rejected.activeRouteDestinationRef.current).toBeNull();
    expect(updateDoc).not.toHaveBeenCalled();

    commitClaimToHeading.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'permission-denied' }));
    const thrown = mount();
    await act(async () => { await thrown.getFlow().handleCommitToHeading(); });
    expect(thrown.activeRouteDestinationRef.current).toBeNull();
  });
});
