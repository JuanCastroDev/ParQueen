import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runTransaction, writes } = vi.hoisted(() => ({
  runTransaction: vi.fn(),
  writes: [] as string[],
}));

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(),
  doc: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join('/') })),
  getDoc: vi.fn(),
  getDocs: vi.fn(),
  query: vi.fn(),
  runTransaction,
  setDoc: vi.fn(),
  Timestamp: { now: () => ({ seconds: 1_700_000_000, nanoseconds: 1 }) },
  where: vi.fn(),
}));

import { completeTerminalHandoff } from './completeTerminalHandoff';

describe('completeTerminalHandoff lock identity', () => {
  beforeEach(() => {
    writes.length = 0;
    runTransaction.mockReset();
  });

  it('rejects a conflicting same-Ping generation before queuing feedback, notification, or deletion', async () => {
    const generation = 'a'.repeat(64);
    const otherGeneration = 'b'.repeat(64);
    runTransaction.mockImplementation(async (_db: unknown, callback: (tx: any) => Promise<unknown>) => callback({
      get: async (ref: { path: string }) => ({
        exists: () => true,
        data: () => ref.path === 'spots/spot-1'
          ? {
              finderId: 'finder-1', interestedUserId: 'driver-1', status: 'occupied',
              claimGenerationId: generation,
            }
          : { spotId: 'spot-1', claimGenerationId: otherGeneration },
      }),
      delete: () => writes.push('delete'),
      set: () => writes.push('set'),
      update: () => writes.push('update'),
    }));

    await expect(completeTerminalHandoff({}, {
      spotId: 'spot-1',
      driverId: 'driver-1',
      driverName: 'Driver',
      finderId: 'finder-1',
      address: 'Conflict St',
      outcome: 'success',
      failureReason: null,
    })).rejects.toThrow(/identity conflict/);

    expect(writes).toEqual([]);
  });
});
