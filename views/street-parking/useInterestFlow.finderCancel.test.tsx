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

const G1 = 'a'.repeat(64);
const G2 = 'b'.repeat(64);
const fresh = vi.hoisted(() => ({
  exists: true,
  data: {
    status: 'interested',
    interestedUserId: 'claimer-2',
    interestedUserName: 'New driver',
    claimState: 'heading',
    claimGenerationId: 'b'.repeat(64),
    claimStartedAt: { toMillis: () => 1_700_000_111_000 },
  } as Record<string, unknown>,
}));

vi.mock('../../firebase', () => ({ db: { __db: true } }));
vi.mock('firebase/firestore', () => ({
  doc: vi.fn((_db: unknown, collectionName: string, id: string) => ({ collectionName, id })),
  updateDoc: vi.fn(async () => {}),
  deleteDoc: vi.fn(async () => {}),
  Timestamp: { now: () => ({ toMillis: () => Date.now() }), fromMillis: (ms: number) => ({ toMillis: () => ms }) },
  collection: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  getDocs: vi.fn(async () => ({ empty: true, docs: [] })),
  getDoc: vi.fn(async () => ({
    exists: () => fresh.exists,
    data: () => ({ ...fresh.data }),
  })),
  addDoc: vi.fn(async () => ({ id: 'notif' })),
  setDoc: vi.fn(async () => {}),
  onSnapshot: vi.fn(() => () => {}),
  orderBy: vi.fn(),
  limit: vi.fn(),
}));

const { finderCancelSpot } = vi.hoisted(() => ({ finderCancelSpot: vi.fn() }));
vi.mock('./finderCancelSpot', () => ({ finderCancelSpot }));
vi.mock('./cancelClaimCallable', () => ({ cancelClaimCallable: vi.fn() }));
vi.mock('../../utils/errorReporting', () => ({
  reportCriticalActionFailure: vi.fn(),
  captureClientException: vi.fn(),
}));

import { t } from '../../i18n';
import { useInterestFlow } from './useInterestFlow';

const user = { id: 'finder-1', username: 'finder', crowns: 0 };
const spot = {
  id: 'spot-1',
  lat: 40.7,
  lng: -73.9,
  finderId: 'finder-1',
  status: 'interested' as const,
  interestedUserId: 'claimer-1',
  claimState: 'heading' as const,
  claimGenerationId: G1,
  claimStartedAt: { toMillis: () => 1_700_000_000_000 },
};

function mount() {
  const setSelectedItem = vi.fn();
  const activeRouteDestinationRef: { current: [number, number] | null } = { current: null };
  const map = { getLayer: vi.fn(() => undefined), getSource: vi.fn(() => undefined), removeLayer: vi.fn(), removeSource: vi.fn() };
  let flow!: ReturnType<typeof useInterestFlow>;
  act(() => {
    TestRenderer.create(React.createElement(() => {
      flow = useInterestFlow({
        selectedItem: spot as never,
        setSelectedItem,
        user: user as never,
        freeSpots: [spot as never],
        userLocation: null,
        mapRef: { current: map as never },
        activeRouteDestinationRef,
      });
      return null;
    }));
  });
  return { getFlow: () => flow, setSelectedItem };
}

describe('finder cancellation UI', () => {
  beforeEach(() => {
    finderCancelSpot.mockReset();
    fresh.exists = true;
    fresh.data = {
      status: 'interested',
      interestedUserId: 'claimer-2',
      interestedUserName: 'New driver',
      claimState: 'heading',
      claimGenerationId: G2,
      claimStartedAt: { toMillis: () => 1_700_000_111_000 },
    };
  });

  it('closes the sheet only after a confirmed deletion and does not mention notification delivery', async () => {
    finderCancelSpot.mockResolvedValue('deleted');
    const { getFlow, setSelectedItem } = mount();
    await act(async () => { await getFlow().handleCancelByFinder('Spot no longer available'); });
    expect(finderCancelSpot).toHaveBeenCalledTimes(1);
    expect(finderCancelSpot.mock.calls[0][0].confirmedSpot.claimGenerationId).toBe(G1);
    expect(setSelectedItem).toHaveBeenCalledWith(null);
    expect(getFlow().interestError).toBeNull();
    expect(JSON.stringify(finderCancelSpot.mock.calls[0][0])).not.toContain('notification');
  });

  it('keeps the ping open, shows the stale message, and refreshes the new claimant', async () => {
    finderCancelSpot.mockResolvedValue('stale');
    const { getFlow, setSelectedItem } = mount();
    await act(async () => { await getFlow().handleCancelByFinder("Can't wait anymore"); });
    expect(finderCancelSpot).toHaveBeenCalledTimes(1);
    expect(getFlow().interestError).toBe(t('claim_flow.cancel_stale'));
    const refreshed = setSelectedItem.mock.calls[0][0];
    expect(refreshed).not.toBeNull();
    expect(refreshed.claimGenerationId).toBe(G2);
    expect(refreshed.interestedUserId).toBe('claimer-2');
    expect(refreshed.interestedUserName).toBe('New driver');
  });

  it('does not report success when deletion is denied', async () => {
    finderCancelSpot.mockRejectedValue(Object.assign(new Error('denied'), { code: 'permission-denied' }));
    const { getFlow, setSelectedItem } = mount();
    await act(async () => { await getFlow().handleCancelByFinder("Can't wait anymore"); });
    expect(setSelectedItem).not.toHaveBeenCalled();
    expect(getFlow().interestError).toBe(t('claim_flow.cancel_error'));
  });
});
