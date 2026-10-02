import { beforeEach, describe, expect, it, vi } from 'vitest';

const arrivedAt = { __arrivedAt: true, toMillis: () => 1_700_000_000_000 };

const { runTransaction, Timestamp } = vi.hoisted(() => ({
  runTransaction: vi.fn(),
  Timestamp: {
    now: () => ({ __arrivedAt: true, toMillis: () => 1_700_000_000_000 }),
  },
}));

vi.mock('firebase/firestore', () => ({
  doc: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join('/') })),
  runTransaction,
  Timestamp,
}));

import { markClaimArrived } from './activeIncomingClaim';

function installStore(initial: Record<string, any>) {
  const docs = new Map<string, any>(Object.entries(initial));
  const writes: Array<{ op: 'update' | 'delete'; path: string; data?: Record<string, any> }> = [];
  runTransaction.mockImplementation(async (_db: unknown, callback: (tx: any) => Promise<any>) => {
    const queued: typeof writes = [];
    const result = await callback({
      get: async (ref: { path: string }) => {
        const data = docs.get(ref.path);
        return {
          exists: () => data !== undefined,
          data: () => data,
        };
      },
      update: (ref: { path: string }, data: Record<string, any>) => {
        queued.push({ op: 'update', path: ref.path, data });
      },
      delete: (ref: { path: string }) => {
        queued.push({ op: 'delete', path: ref.path });
      },
    });
    for (const write of queued) {
      writes.push(write);
      if (write.op === 'delete') docs.delete(write.path);
      else docs.set(write.path, { ...(docs.get(write.path) ?? {}), ...write.data });
    }
    return result;
  });
  return { docs, writes };
}

const lockPath = 'users/user-1/activeIncomingClaims/current';

describe('markClaimArrived', () => {
  beforeEach(() => {
    runTransaction.mockReset();
  });

  it('writes occupied, arrived_pending_outcome, and arrivedAt, and deletes the matching lock', async () => {
    const { docs, writes } = installStore({
      'spots/spot-1': {
        status: 'interested',
        claimState: 'heading',
        interestedUserId: 'user-1',
        lat: 40.7,
        lng: -73.9,
      },
      [lockPath]: { spotId: 'spot-1', claimState: 'heading' },
    });

    await markClaimArrived({}, 'spot-1', 'user-1');

    const spot = docs.get('spots/spot-1');
    expect(spot.status).toBe('occupied');
    expect(spot.claimState).toBe('arrived_pending_outcome');
    expect(spot.arrivedAt.toMillis()).toBe(arrivedAt.toMillis());
    expect(spot.lat).toBe(40.7);
    expect(docs.has(lockPath)).toBe(false);
    const update = writes.find((write) => write.op === 'update');
    expect(Object.keys(update?.data ?? {}).sort()).toEqual(['arrivedAt', 'claimState', 'status']);
    expect(update?.data).toMatchObject({
      status: 'occupied',
      claimState: 'arrived_pending_outcome',
    });
    expect(update?.data?.arrivedAt.toMillis()).toBe(arrivedAt.toMillis());
    expect(writes.some((write) => write.op === 'delete' && write.path === lockPath)).toBe(true);
  });

  it('a second arrive is a no-op and does not rewrite arrivedAt', async () => {
    const original = { toMillis: () => 50 };
    const { docs, writes } = installStore({
      'spots/spot-1': {
        status: 'occupied',
        claimState: 'arrived_pending_outcome',
        arrivedAt: original,
        interestedUserId: 'user-1',
      },
    });

    await markClaimArrived({}, 'spot-1', 'user-1');
    await markClaimArrived({}, 'spot-1', 'user-1');

    expect(writes.filter((write) => write.op === 'update')).toHaveLength(0);
    expect(docs.get('spots/spot-1').arrivedAt).toBe(original);
    expect(docs.get('spots/spot-1').claimState).toBe('arrived_pending_outcome');
    expect(docs.get('spots/spot-1').status).toBe('occupied');
  });

  it('does not reopen arrived_pending_outcome on an already occupied Ping', async () => {
    const { docs, writes } = installStore({
      'spots/spot-1': {
        status: 'occupied',
        claimState: 'heading',
        interestedUserId: 'user-1',
      },
      [lockPath]: { spotId: 'spot-1', claimState: 'heading' },
    });

    await markClaimArrived({}, 'spot-1', 'user-1');

    expect(writes.filter((write) => write.op === 'update')).toHaveLength(0);
    expect(docs.get('spots/spot-1').claimState).toBe('heading');
    expect(docs.get('spots/spot-1').arrivedAt).toBeUndefined();
    expect(docs.has(lockPath)).toBe(false);
  });

  it('does not delete a lock that names a different Ping', async () => {
    const { docs } = installStore({
      'spots/spot-1': {
        status: 'interested',
        claimState: 'heading',
        interestedUserId: 'user-1',
      },
      [lockPath]: { spotId: 'other-spot', claimState: 'heading' },
    });

    await markClaimArrived({}, 'spot-1', 'user-1');

    expect(docs.get('spots/spot-1').claimState).toBe('arrived_pending_outcome');
    expect(docs.get(lockPath).spotId).toBe('other-spot');
  });

  it('rejects a claim that is no longer this user without writing', async () => {
    const { docs, writes } = installStore({
      'spots/spot-1': {
        status: 'available',
        interestedUserId: null,
        claimState: null,
      },
    });

    await expect(markClaimArrived({}, 'spot-1', 'user-1')).rejects.toThrow(/no longer active/);
    expect(writes).toHaveLength(0);
    expect(docs.get('spots/spot-1').status).toBe('available');
  });
});
