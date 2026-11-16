import { doc, runTransaction, Timestamp } from 'firebase/firestore';
import { isClaimGenerationId } from './claimIdentity';

type Firestore = any;

/** Single authoritative lock: users/{uid}/activeIncomingClaims/current. */
export const ACTIVE_INCOMING_CLAIM_COLLECTION = 'activeIncomingClaims';
export const ACTIVE_INCOMING_CLAIM_DOC_ID = 'current';
export const ALREADY_CLAIMED_MESSAGE = 'You already have a claimed spot';

export function activeIncomingClaimRef(db: Firestore, uid: string) {
    return doc(db, 'users', uid, ACTIVE_INCOMING_CLAIM_COLLECTION, ACTIVE_INCOMING_CLAIM_DOC_ID);
}

export type ClaimLockIdentityOutcome = 'exact' | 'missing' | 'unrelated' | 'conflict' | 'malformed';

function timestampParts(value: unknown): { seconds: number; nanoseconds: number } | null {
    if (!value || typeof value !== 'object') return null;
    const stamp = value as Timestamp & { constructor?: { name?: string } };
    const hasSdkContract = stamp.constructor?.name === 'Timestamp'
        && typeof stamp.toDate === 'function'
        && typeof stamp.toMillis === 'function'
        && typeof stamp.isEqual === 'function'
        && typeof stamp.valueOf === 'function';
    if (!(value instanceof Timestamp) && !hasSdkContract) return null;
    if (!Number.isSafeInteger(stamp.seconds)
        || !Number.isInteger(stamp.nanoseconds)
        || stamp.nanoseconds < 0
        || stamp.nanoseconds > 999_999_999) return null;
    return { seconds: stamp.seconds, nanoseconds: stamp.nanoseconds };
}

/** Classifies a lock only against identity read from its authoritative Ping. */
export function classifyClaimLockIdentity(
    lockSnap: { exists: () => boolean; data: () => any },
    spotId: string,
    spot: Record<string, any>,
): ClaimLockIdentityOutcome {
    if (!lockSnap.exists()) return 'missing';
    const lock = lockSnap.data();
    if (!lock || typeof lock !== 'object') return 'malformed';
    if (typeof lock.spotId !== 'string' || lock.spotId.length === 0) return 'malformed';
    if (lock.spotId !== spotId) return 'unrelated';

    const spotGeneration = spot.claimGenerationId;
    const lockGeneration = lock.claimGenerationId;
    if (spotGeneration != null) {
        if (!isClaimGenerationId(spotGeneration) || !isClaimGenerationId(lockGeneration)) {
            return 'malformed';
        }
        return lockGeneration === spotGeneration ? 'exact' : 'conflict';
    }
    if (lockGeneration != null) {
        return isClaimGenerationId(lockGeneration) ? 'conflict' : 'malformed';
    }

    const spotStartedAt = timestampParts(spot.claimStartedAt);
    const lockStartedAt = timestampParts(lock.claimStartedAt);
    if (!spotStartedAt || !lockStartedAt) return 'malformed';
    return spotStartedAt.seconds === lockStartedAt.seconds
        && spotStartedAt.nanoseconds === lockStartedAt.nanoseconds
        ? 'exact'
        : 'conflict';
}

export function deleteLockIfNamesSpot(
    tx: { delete: (ref: any) => void },
    lockSnap: { exists: () => boolean; data: () => any },
    lockRef: any,
    spotId: string,
    spot?: Record<string, any>,
) {
    // A caller without the authoritative Ping identity cannot prove deletion.
    // This keeps the dormant pre-callable cancellation path fail-closed.
    const outcome = spot
        ? classifyClaimLockIdentity(lockSnap, spotId, spot)
        : (lockSnap.exists() && lockSnap.data()?.spotId === spotId ? 'malformed' : 'unrelated');
    if (outcome === 'conflict' || outcome === 'malformed') {
        throw new Error('Claim lock identity conflict');
    }
    if (outcome === 'exact') tx.delete(lockRef);
    return outcome;
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
            ...(isClaimGenerationId(fields.claimGenerationId)
                ? { claimGenerationId: fields.claimGenerationId }
                : {}),
        });
        return 'claimed';
    });
}

/**
 * Claimer arrival. On the first transition from interested, the same
 * transaction sets status occupied, claimState arrived_pending_outcome, and
 * arrivedAt, and deletes a lock that names this Ping.
 *
 * Already arrived_pending_outcome for this claimer is a success no-op and
 * does not rewrite arrivedAt. An already-occupied Ping that is not in that
 * phase (finder confirm, or a pre-B1 status-only arrival) is also a no-op:
 * arrival must not reopen an awaiting-outcome phase. Terminal spotFeedback
 * is enforced by Rules on the interested → arrived transition.
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

        const alreadyArrived = spot.status === 'occupied'
            && spot.claimState === 'arrived_pending_outcome';
        if (alreadyArrived) {
            deleteLockIfNamesSpot(tx, lockSnap, lockRef, spotId, spot);
            return;
        }

        if (spot.status === 'interested') {
            tx.update(spotRef, {
                status: 'occupied',
                claimState: 'arrived_pending_outcome',
                arrivedAt: Timestamp.now(),
            });
            deleteLockIfNamesSpot(tx, lockSnap, lockRef, spotId, spot);
            return;
        }

        if (spot.status === 'occupied') {
            deleteLockIfNamesSpot(tx, lockSnap, lockRef, spotId, spot);
            return;
        }

        throw new Error('Claim is no longer active');
    });
}
