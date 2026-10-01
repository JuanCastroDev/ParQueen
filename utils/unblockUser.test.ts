import { describe, expect, it, vi } from 'vitest';

vi.mock('firebase/firestore', () => ({
    doc: vi.fn((...args: unknown[]) => ({ args })),
    updateDoc: vi.fn(),
    arrayRemove: vi.fn((uid: string) => ({ op: 'arrayRemove', uid })),
}));

import { arrayRemove, doc, updateDoc } from 'firebase/firestore';
import { unblockUser } from './unblockUser';

describe('unblockUser', () => {
    it('BU-07 BU-08 BU-09: arrayRemove on only the current user social document', async () => {
        const db = { kind: 'firestore' } as never;
        await unblockUser(db, 'user-a', 'user-b');

        expect(arrayRemove).toHaveBeenCalledTimes(1);
        expect(arrayRemove).toHaveBeenCalledWith('user-b');
        expect(doc).toHaveBeenCalledTimes(1);
        expect(doc).toHaveBeenCalledWith(db, 'users', 'user-a', 'private', 'social');
        expect(updateDoc).toHaveBeenCalledTimes(1);
        expect(updateDoc).toHaveBeenCalledWith(
            { args: [db, 'users', 'user-a', 'private', 'social'] },
            { blockedUsers: { op: 'arrayRemove', uid: 'user-b' } },
        );
        const updatePayload = vi.mocked(updateDoc).mock.calls[0][1] as unknown as { blockedUsers: unknown };
        expect(Array.isArray(updatePayload.blockedUsers)).toBe(false);
    });
});
