import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Timestamp as StoredTimestamp } from 'firebase/firestore/lite';

const { runTransaction } = vi.hoisted(() => ({
  runTransaction: vi.fn(),
}));

vi.mock('firebase/firestore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('firebase/firestore')>();
  return {
    ...actual,
    doc: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join('/') })),
    runTransaction,
  };
});

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
const generation = 'a'.repeat(64);
const otherGeneration = 'b'.repeat(64);
const claimStartedAt = new StoredTimestamp(1_700_000_000, 123_456_789);

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
        claimGenerationId: generation,
        claimStartedAt,
        lat: 40.7,
        lng: -73.9,
      },
      [lockPath]: { spotId: 'spot-1', claimState: 'heading', claimGenerationId: generation },
    });

    await markClaimArrived({}, 'spot-1', 'user-1');

    const spot = docs.get('spots/spot-1');
    expect(spot.status).toBe('occupied');
    expect(spot.claimState).toBe('arrived_pending_outcome');
    expect(typeof spot.arrivedAt.toMillis).toBe('function');
    expect(spot.lat).toBe(40.7);
    expect(docs.has(lockPath)).toBe(false);
    const update = writes.find((write) => write.op === 'update');
    expect(Object.keys(update?.data ?? {}).sort()).toEqual(['arrivedAt', 'claimState', 'status']);
    expect(update?.data).toMatchObject({
      status: 'occupied',
      claimState: 'arrived_pending_outcome',
    });
    expect(update?.data?.arrivedAt?.constructor?.name).toBe('Timestamp');
    expect(typeof update?.data?.arrivedAt?.toMillis).toBe('function');
    expect(writes.some((write) => write.op === 'delete' && write.path === lockPath)).toBe(true);
  });

  it('preserves legacy missing-lock compatibility on first arrival', async () => {
    const { docs, writes } = installStore({
      'spots/spot-1': {
        status: 'interested', claimState: 'heading', interestedUserId: 'user-1',
        claimStartedAt,
      },
    });

    await expect(markClaimArrived({}, 'spot-1', 'user-1')).resolves.toBeUndefined();
    expect(docs.get('spots/spot-1')).toMatchObject({
      status: 'occupied',
      claimState: 'arrived_pending_outcome',
    });
    expect(writes.filter((write) => write.op === 'delete')).toHaveLength(0);
  });

  it('a second arrive is a no-op and does not rewrite arrivedAt', async () => {
    const original = { toMillis: () => 50 };
    const { docs, writes } = installStore({
      'spots/spot-1': {
        status: 'occupied',
        claimState: 'arrived_pending_outcome',
        arrivedAt: original,
        interestedUserId: 'user-1',
        claimGenerationId: generation,
        claimStartedAt,
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
        claimGenerationId: generation,
        claimStartedAt,
      },
      [lockPath]: { spotId: 'spot-1', claimState: 'heading', claimGenerationId: generation },
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
        claimGenerationId: generation,
        claimStartedAt,
      },
      [lockPath]: { spotId: 'other-spot', claimState: 'heading' },
    });

    await markClaimArrived({}, 'spot-1', 'user-1');

    expect(docs.get('spots/spot-1').claimState).toBe('arrived_pending_outcome');
    expect(docs.get(lockPath).spotId).toBe('other-spot');
  });

  it.each([
    ['missing', { claimState: 'heading', claimGenerationId: generation }],
    ['non-string', { spotId: 42, claimState: 'heading', claimGenerationId: generation }],
  ])('rejects a %s lock spotId before any arrival write', async (_label, malformedLock) => {
    const { docs, writes } = installStore({
      'spots/spot-1': {
        status: 'interested', claimState: 'heading', interestedUserId: 'user-1',
        claimGenerationId: generation, claimStartedAt,
      },
      [lockPath]: malformedLock,
    });

    await expect(markClaimArrived({}, 'spot-1', 'user-1')).rejects.toThrow(/identity conflict/);
    expect(writes).toHaveLength(0);
    expect(docs.get('spots/spot-1').status).toBe('interested');
    expect(docs.has(lockPath)).toBe(true);
  });

  it('rejects a conflicting modern same-Ping lock before any write', async () => {
    const { docs, writes } = installStore({
      'spots/spot-1': {
        status: 'interested', claimState: 'heading', interestedUserId: 'user-1',
        claimGenerationId: generation, claimStartedAt,
      },
      [lockPath]: { spotId: 'spot-1', claimGenerationId: otherGeneration },
    });

    await expect(markClaimArrived({}, 'spot-1', 'user-1')).rejects.toThrow(/identity conflict/);
    expect(writes).toHaveLength(0);
    expect(docs.get('spots/spot-1').status).toBe('interested');
    expect(docs.has(lockPath)).toBe(true);
  });

  it('deletes a documented legacy lock only on exact seconds and nanoseconds', async () => {
    const { docs } = installStore({
      'spots/spot-1': {
        status: 'interested', claimState: 'heading', interestedUserId: 'user-1', claimStartedAt,
      },
      [lockPath]: { spotId: 'spot-1', claimStartedAt: new StoredTimestamp(claimStartedAt.seconds, claimStartedAt.nanoseconds) },
    });

    await markClaimArrived({}, 'spot-1', 'user-1');
    expect(docs.has(lockPath)).toBe(false);
  });

  it('rejects a legacy same-Ping lock when only nanoseconds differ', async () => {
    const { docs, writes } = installStore({
      'spots/spot-1': {
        status: 'interested', claimState: 'heading', interestedUserId: 'user-1', claimStartedAt,
      },
      [lockPath]: {
        spotId: 'spot-1',
        claimStartedAt: new StoredTimestamp(claimStartedAt.seconds, claimStartedAt.nanoseconds + 1),
      },
    });

    await expect(markClaimArrived({}, 'spot-1', 'user-1')).rejects.toThrow(/identity conflict/);
    expect(writes).toHaveLength(0);
    expect(docs.has(lockPath)).toBe(true);
  });

  it.each([
    ['plain map', { seconds: claimStartedAt.seconds, nanoseconds: claimStartedAt.nanoseconds }],
    ['unsafe seconds', { seconds: Number.MAX_SAFE_INTEGER + 1, nanoseconds: 0, toMillis: () => 0 }],
    ['negative nanoseconds', { seconds: claimStartedAt.seconds, nanoseconds: -1, toMillis: () => 0 }],
    ['excess nanoseconds', { seconds: claimStartedAt.seconds, nanoseconds: 1_000_000_000, toMillis: () => 0 }],
    ['fractional seconds', { seconds: claimStartedAt.seconds + 0.5, nanoseconds: 0, toMillis: () => 0 }],
    ['fractional nanoseconds', { seconds: claimStartedAt.seconds, nanoseconds: 1.5, toMillis: () => 0 }],
    ['null', null],
    ['absent', undefined],
  ])('rejects a same-Ping legacy lock with %s timestamp provenance', async (_label, malformed) => {
    const { writes } = installStore({
      'spots/spot-1': {
        status: 'interested', claimState: 'heading', interestedUserId: 'user-1', claimStartedAt,
      },
      [lockPath]: { spotId: 'spot-1', claimStartedAt: malformed },
    });

    await expect(markClaimArrived({}, 'spot-1', 'user-1')).rejects.toThrow(/identity conflict/);
    expect(writes).toHaveLength(0);
  });

  it('rejects a same-Ping lock with missing identity instead of treating it as authority', async () => {
    const { writes } = installStore({
      'spots/spot-1': {
        status: 'interested', claimState: 'heading', interestedUserId: 'user-1',
        claimGenerationId: generation, claimStartedAt,
      },
      [lockPath]: { spotId: 'spot-1' },
    });

    await expect(markClaimArrived({}, 'spot-1', 'user-1')).rejects.toThrow(/identity conflict/);
    expect(writes).toHaveLength(0);
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
