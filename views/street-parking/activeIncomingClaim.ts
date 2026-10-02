import { doc, runTransaction, Timestamp } from 'firebase/firestore';

type Firestore = any;

/** Single authoritative lock: users/{uid}/activeIncomingClaims/current. */
export const ACTIVE_INCOMING_CLAIM_COLLECTION = 'activeIncomingClaims';
export const ACTIVE_INCOMING_CLAIM_DOC_ID = 'current';
export const ALREADY_CLAIMED_MESSAGE = 'You already have a claimed spot';

export function activeIncomingClaimRef(db: Firestore, uid: string) {
    return doc(db, 'users', uid, ACTIVE_INCOMING_CLAIM_COLLECTION, ACTIVE_INCOMING_CLAIM_DOC_ID);
}

export function deleteLockIfNamesSpot(
    tx: { delete: (ref: any) => void },
    lockSnap: { exists: () => boolean; data: () => any },
    lockRef: any,
    spotId: string,
) {
    if (lockSnap.exists() && lockSnap.data()?.spotId === spotId) {
        tx.delete(lockRef);
    }
}

export interface AcquireActiveIncomingClaimParams {
    spotId: string;
    uid: string;
    /** Thrown when the target Ping is no longer available (someone else won it). */
    unavailableMessage: string;
    missingMessage: string;
    buildClaimFields: (spot: Record<string, any>, claimStartedAt: Timestamp) => Record<string, any>;
}

/**
 * Atomically writes the Ping claim fields and this user's active-incoming lock.
 * Rules reject the commit unless both writes agree. A lock whose Ping is no
 * longer an active claim for this user is overwritten in the same commit
 * (immediate stale-lock repair). The 15-minute sweeper is only leftover GC.
 *
 * Idempotent when this user already holds the target Ping: no field rewrite,
 * so claimStartedAt stays the original fingerprint.
 */
export async function acquireActiveIncomingClaim(
    db: Firestore,
    params: AcquireActiveIncomingClaimParams,
): Promise<'claimed' | 'already_held'> {
    const spotRef = doc(db, 'spots', params.spotId);
    const lockRef = activeIncomingClaimRef(db, params.uid);
    return runTransaction(db, async (tx) => {
        // Both reads happen before any write. The lock is in the read set so
        // two devices claiming different Pings conflict and one commit retries.
        const spotSnap = await tx.get(spotRef);
        await tx.get(lockRef);
        if (!spotSnap.exists()) throw new Error(params.missingMessage);
        const spot = spotSnap.data() as Record<string, any>;
        if (spot.status === 'interested' && spot.interestedUserId === params.uid) {
            return 'already_held';
        }
        if (spot.status !== 'available') throw new Error(params.unavailableMessage);

        const claimStartedAt = Timestamp.now();
        const fields = params.buildClaimFields(spot, claimStartedAt);
        const claimState = fields.claimState === 'committed' ? 'committed' : 'heading';
        tx.update(spotRef, { ...fields, claimState, claimStartedAt });
        tx.set(lockRef, {
            spotId: params.spotId,
            claimStartedAt,
            claimState,
            // Same client timestamp as the fingerprint. Rules bound it to a
            // short window around request.time so a lock cannot hide from GC.
            updatedAt: claimStartedAt,
        });
        return 'claimed';
    });
}

/**
 * Claimer arrival. Marks the Ping occupied and deletes the matching lock in
 * the same transaction. Already-occupied is success so a duplicate tap does
 * not fail after the first commit.
 */
export async function markClaimArrived(db: Firestore, spotId: string, uid: string): Promise<void> {
    const spotRef = doc(db, 'spots', spotId);
    const lockRef = activeIncomingClaimRef(db, uid);
    await runTransaction(db, async (tx) => {
        const spotSnap = await tx.get(spotRef);
        const lockSnap = await tx.get(lockRef);
        if (!spotSnap.exists()) throw new Error('Spot no longer exists');
        const spot = spotSnap.data() as Record<string, any>;
        if (spot.interestedUserId !== uid) throw new Error('Claim is no longer active');
        if (spot.status === 'interested') {
            tx.update(spotRef, { status: 'occupied' });
        } else if (spot.status !== 'occupied') {
            throw new Error('Claim is no longer active');
        }
        deleteLockIfNamesSpot(tx, lockSnap, lockRef, spotId);
    });
}
