import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('firebase/firestore', () => ({
    doc: vi.fn((_db: unknown, col: string, id: string) => ({ __col: col, __id: id })),
    getDoc: vi.fn(),
    runTransaction: vi.fn(),
    Timestamp: { now: () => ({ toMillis: () => Date.now() }) },
}));

import { getDoc, runTransaction } from 'firebase/firestore';
import { cancelClaimTransaction } from './cancelClaimTransaction';

const params = { spotId: 's1', claimantId: 'u1', finderId: 'owner1', fingerprint: 123, message: 'x' };
const permissionDenied = () => Object.assign(new Error('permission denied'), { code: 'permission-denied' });

// A transaction never actually reaches its own write logic in these tests —
// runTransaction is mocked to reject directly, simulating a commit-time
// denial after the transaction body already ran once for real. This isolates
// the post-failure classification branch in cancelClaimTransaction's catch
// block, which the real-emulator TX- suite can't easily force deterministically.
describe('cancelClaimTransaction — post-failure error classification (Phase 3 cases A-D)', () => {
    beforeEach(() => {
        vi.mocked(runTransaction).mockReset();
        vi.mocked(getDoc).mockReset();
    });

    it('Case A: re-read shows the claim already released by someone else — resolves already_resolved, no error surfaces', async () => {
        vi.mocked(runTransaction).mockRejectedValue(permissionDenied());
        vi.mocked(getDoc).mockResolvedValue({
            exists: () => true,
            data: () => ({ interestedUserId: null }),
        } as any);

        await expect(cancelClaimTransaction({} as any, params)).resolves.toBe('already_resolved');
    });

    it('Case A (spot gone entirely): re-read finds no document — resolves already_resolved', async () => {
        vi.mocked(runTransaction).mockRejectedValue(permissionDenied());
        vi.mocked(getDoc).mockResolvedValue({ exists: () => false } as any);

        await expect(cancelClaimTransaction({} as any, params)).resolves.toBe('already_resolved');
    });

    it('Case B: re-read shows a different (newer) claimant now holds it — resolves stale_claim, does not release the newer claim', async () => {
        vi.mocked(runTransaction).mockRejectedValue(permissionDenied());
        vi.mocked(getDoc).mockResolvedValue({
            exists: () => true,
            data: () => ({ interestedUserId: 'someone-else' }),
        } as any);

        await expect(cancelClaimTransaction({} as any, params)).resolves.toBe('stale_claim');
    });

    it('Case C: re-read shows the SAME user and SAME claim generation still fully active — rethrows rather than reporting success', async () => {
        const err = permissionDenied();
        vi.mocked(runTransaction).mockRejectedValue(err);
        vi.mocked(getDoc).mockResolvedValue({
            exists: () => true,
            data: () => ({
                interestedUserId: 'u1',
                claimStartedAt: { toMillis: () => 123 },
            }),
        } as any);

        await expect(cancelClaimTransaction({} as any, params)).rejects.toBe(err);
    });

    it('Case D: the re-read itself fails — rethrows the original error, never assumes success', async () => {
        const err = permissionDenied();
        vi.mocked(runTransaction).mockRejectedValue(err);
        vi.mocked(getDoc).mockRejectedValue(new Error('network unavailable'));

        await expect(cancelClaimTransaction({} as any, params)).rejects.toBe(err);
    });

    it('an occupied arrived claim is already resolved and is not cleared', async () => {
        const writes: string[] = [];
        vi.mocked(runTransaction).mockImplementation(async (_db: unknown, callback: any) => callback({
            get: async () => ({
                exists: () => true,
                data: () => ({
                    status: 'occupied',
                    claimState: 'arrived_pending_outcome',
                    interestedUserId: 'u1',
                    claimStartedAt: { toMillis: () => 123 },
                }),
            }),
            update: () => writes.push('update'),
            delete: () => writes.push('delete'),
            set: () => writes.push('set'),
        }));

        await expect(cancelClaimTransaction({} as any, params)).resolves.toBe('already_resolved');
        expect(writes).toEqual([]);
    });

    it('a permission-denied re-read of an arrived Ping is already resolved', async () => {
        const err = permissionDenied();
        vi.mocked(runTransaction).mockRejectedValue(err);
        vi.mocked(getDoc).mockResolvedValue({
            exists: () => true,
            data: () => ({
                status: 'occupied',
                claimState: 'arrived_pending_outcome',
                interestedUserId: 'u1',
                claimStartedAt: { toMillis: () => 123 },
            }),
        } as any);

        await expect(cancelClaimTransaction({} as any, params)).resolves.toBe('already_resolved');
    });

    it('a non-permission-denied failure is rethrown immediately, without attempting a re-read at all', async () => {
        const err = Object.assign(new Error('unavailable'), { code: 'unavailable' });
        vi.mocked(runTransaction).mockRejectedValue(err);

        await expect(cancelClaimTransaction({} as any, params)).rejects.toBe(err);
        expect(getDoc).not.toHaveBeenCalled();
    });
});
