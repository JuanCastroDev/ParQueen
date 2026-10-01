import { arrayRemove, doc, updateDoc, type Firestore } from 'firebase/firestore';

/**
 * Remove one UID from the signed-in user's own block list.
 * arrayRemove is atomic, so a stale client snapshot cannot rewrite the list.
 */
export async function unblockUser(
    firestore: Firestore,
    currentUid: string,
    blockedUid: string,
): Promise<void> {
    await updateDoc(doc(firestore, 'users', currentUid, 'private', 'social'), {
        blockedUsers: arrayRemove(blockedUid),
    });
}
