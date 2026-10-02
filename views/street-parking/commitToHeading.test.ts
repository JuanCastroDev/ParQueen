import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildHeadingUpdate } from '../../utils/commitToHeadingDecision';

const { runTransaction, Timestamp } = vi.hoisted(() => ({
  runTransaction: vi.fn(),
  Timestamp: {
    fromMillis: (ms: number) => ({ toMillis: () => ms }),
  },
}));

vi.mock('firebase/firestore', () => ({
  doc: vi.fn((_db: unknown, col: string, id: string) => ({ path: `${col}/${id}` })),
  runTransaction,
  Timestamp,
}));

import { commitClaimToHeading } from './commitToHeading';

function installStore(initial: Record<string, any>) {
  const docs = new Map<string, any>(Object.entries(initial));
  runTransaction.mockImplementation(async (_db: unknown, callback: (tx: any) => Promise<any>) => {
    const writes: Array<{ path: string; data: Record<string, any> }> = [];
    const result = await callback({
      get: async (ref: { path: string }) => {
        const data = docs.get(ref.path);
        return {
          exists: () => data !== undefined,
          data: () => data,
        };
      },
      update: (ref: { path: string }, data: Record<string, any>) => {
        writes.push({ path: ref.path, data });
      },
    });
    for (const write of writes) {
      docs.set(write.path, { ...(docs.get(write.path) ?? {}), ...write.data });
    }
    return result;
  });
  return docs;
}

describe('commitClaimToHeading', () => {
  beforeEach(() => {
    runTransaction.mockReset();
  });

  it('writes the Arm 2b heading patch for a committed claim and leaves the fingerprint', async () => {
    const started = { toMillis: () => 50 };
    const docs = installStore({
      'spots/spot-1': {
        status: 'interested',
        interestedUserId: 'user-1',
        claimState: 'committed',
        claimStartedAt: started,
        claimAutoReleaseAt: { toMillis: () => 10 },
      },
    });

    const outcome = await commitClaimToHeading({}, {
      spotId: 'spot-1',
      uid: 'user-1',
      etaMinutes: 5,
      claimMinutes: 10,
      nowMs: 1_000_000,
    });

    expect(outcome).toBe('committed');
    const spot = docs.get('spots/spot-1');
    const patch = buildHeadingUpdate(5, Timestamp.fromMillis(1_000_000 + 10 * 60_000));
    expect(spot.claimState).toBe('heading');
    expect(spot.claimStartedAt).toBe(started);
    expect(spot.interestedUserId).toBe('user-1');
    expect(spot.ownerLeavingNow).toBeNull();
    expect(spot.ownerLeavingNowAt).toBeNull();
    expect(spot.etaMinutes).toBe(patch.etaMinutes);
    expect(spot.claimReminderAt).toBeNull();
    expect(spot.claimReminderSentAt).toBeNull();
    expect(spot.claimAutoReleaseAt).toBeNull();
    expect(spot.interestExpiresAt.toMillis()).toBe(1_000_000 + 10 * 60_000);
  });

  it('does not write when auto-release already cleared the claimer', async () => {
    const docs = installStore({
      'spots/spot-1': {
        status: 'available',
        interestedUserId: null,
        claimState: null,
        claimStartedAt: null,
      },
    });
    let writes = 0;
    runTransaction.mockImplementation(async (_db: unknown, callback: (tx: any) => Promise<any>) => callback({
      get: async () => ({
        exists: () => true,
        data: () => docs.get('spots/spot-1'),
      }),
      update: () => { writes += 1; },
    }));

    expect(await commitClaimToHeading({}, {
      spotId: 'spot-1', uid: 'user-1', etaMinutes: 5, claimMinutes: 10,
    })).toBe('rejected');
    expect(writes).toBe(0);
    expect(docs.get('spots/spot-1').claimState).toBeNull();
  });

  it('is idempotent when the claim is already heading', async () => {
    const docs = installStore({
      'spots/spot-1': {
        status: 'interested',
        interestedUserId: 'user-1',
        claimState: 'heading',
        etaMinutes: 4,
        claimStartedAt: { toMillis: () => 50 },
      },
    });
    let writes = 0;
    runTransaction.mockImplementation(async (_db: unknown, callback: (tx: any) => Promise<any>) => callback({
      get: async () => ({
        exists: () => true,
        data: () => docs.get('spots/spot-1'),
      }),
      update: () => { writes += 1; },
    }));

    expect(await commitClaimToHeading({}, {
      spotId: 'spot-1', uid: 'user-1', etaMinutes: 9, claimMinutes: 14,
    })).toBe('already_heading');
    expect(writes).toBe(0);
    expect(docs.get('spots/spot-1').etaMinutes).toBe(4);
  });

  it('rejects a missing Ping without writing', async () => {
    installStore({});
    let writes = 0;
    runTransaction.mockImplementationOnce(async (_db: unknown, callback: (tx: any) => Promise<any>) => callback({
      get: async () => ({ exists: () => false, data: () => undefined }),
      update: () => { writes += 1; },
    }));

    expect(await commitClaimToHeading({}, {
      spotId: 'gone', uid: 'user-1', etaMinutes: 5, claimMinutes: 10,
    })).toBe('rejected');
    expect(writes).toBe(0);
  });
});
