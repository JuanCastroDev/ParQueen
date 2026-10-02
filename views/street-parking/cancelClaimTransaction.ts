import { doc, getDoc, runTransaction, Timestamp } from 'firebase/firestore';
import { timestampToMillis } from '../../utils/pingLifecycle';
import { activeIncomingClaimRef, deleteLockIfNamesSpot } from './activeIncomingClaim';

// Loosely typed on purpose: @firebase/rules-unit-testing's RulesTestContext
// .firestore() is declared against the older compat SDK's Firestore type,
// which doesn't structurally match the modular SDK's Firestore even though
// both are valid runtime arguments to doc()/runTransaction(). Production
// code passes the real modular `db` from firebase.ts; tests pass the
// emulator's context Firestore — both work at runtime.
type Firestore = any;

export type CancelClaimOutcome = 'cancelled' | 'already_resolved' | 'stale_claim';

export interface CancelClaimParams {
    spotId: string;
    claimantId: string;
    finderId: string | null;
    /** claimStartedAt millis captured client-side at click time, or null if unknown. */
    fingerprint: number | null;
    message: string;
}

function claimStatus(spot: Record<string, any>, claimantId: string, fingerprint: number | null) {
    const currentFingerprint = timestampToMillis(spot.claimStartedAt) || null;
    const matches = spot.interestedUserId === claimantId
        && (fingerprint === null || currentFingerprint === fingerprint);
    const releasedByOther = spot.interestedUserId == null;
    return { matches, releasedByOther };
}

/**
 * Atomically cancels a claimant's claim on a Ping.
 *
 * Firestore transactions require every tx.get() to run before the first
 * tx.update()/tx.set()/tx.delete() — violating that order throws "Firestore
 * transactions require all reads to be executed before all writes." at
 * commit time. This function reads the spot, then the claimant's active
 * incoming lock, and only then writes. The lock is deleted in the same
 * commit when it names this Ping. A missing lock (legacy claim) does not
 * block cancel.
 *
 * Deliberately does NOT also read the deterministic cancellation-notification
 * doc to check whether it already exists: spotNotifications reads are
 * owner-only (`resource.data.targetUserId == request.auth.uid`), so the
 * claimant has no read access to a notification addressed to the Ping
 * owner — attempting that read throws permission-denied. Idempotency is
 * instead derived entirely from the spot's own state:
 *
 *   - The notification is only ever written in the same atomic commit as
 *     the claim-field clear, by this exact function, keyed on
 *     (spotId, claimStartedAt). No other code path writes that id.
 *   - Once a claim's fields are cleared, `claimStatus(...).matches` is false
 *     for any later call with the same fingerprint — so a lost-response
 *     retry always resolves to `already_resolved` before it would ever
 *     attempt to write again.
 *
 * A permission-denied on commit does NOT automatically mean "someone else
 * already resolved it" — it could also mean this claim is still fully
 * intact and something else about the write was rejected (e.g. a stray
 * notification doc already occupying this exact deterministic id). Treating
 * every denial as success would silently misreport a genuine failure as a
 * completed cancellation. So on denial, re-read the spot *outside* the
 * failed transaction and classify from what's actually true now:
 *   - claim is gone/cleared by someone else  -> already_resolved
 *   - a different claimant now holds it      -> stale_claim
 *   - the same claim is still fully active   -> rethrow (genuine failure)
 *   - the re-read itself fails               -> rethrow the original error
 */
export async function cancelClaimTransaction(
    db: Firestore,
    { spotId, claimantId, finderId, fingerprint, message }: CancelClaimParams
): Promise<CancelClaimOutcome> {
    const spotRef = doc(db, 'spots', spotId);
    const needsNotification = !!finderId && finderId !== claimantId;

    try {
        return await runTransaction(db, async (tx) => {
            // All reads before any write. The lock read is skipped when the
            // spot is already gone or the claim does not match — those paths
            // return without writing, so they must not queue a later read.
            const freshSpotSnap = await tx.get(spotRef);
            if (!freshSpotSnap.exists()) return 'already_resolved';
            const spot = freshSpotSnap.data() as Record<string, any>;

            const { matches, releasedByOther } = claimStatus(spot, claimantId, fingerprint);
            if (!matches) {
                // Already resolved (by the scheduler, the owner, or an earlier run
                // of this exact call) or replaced by a newer claim — either way
                // there is nothing to release and nothing to notify.
                return releasedByOther ? 'already_resolved' : 'stale_claim';
            }

            const lockRef = activeIncomingClaimRef(db, claimantId);
            const lockSnap = await tx.get(lockRef);

            const clearFields = {
                claimState: null,
                ownerLeavingNow: null,
                ownerLeavingNowAt: null,
                interestedUserId: null,
                interestedUserName: null,
                interestedUserVehicleColor: null,
                interestedUserVehicleType: null,
                interestedUserVehicleBrand: null,
                interestedUserTitle: null,
                etaMinutes: null,
                interestExpiresAt: null,
                claimReminderAt: null,
                claimReminderSentAt: null,
                claimAutoReleaseAt: null,
                claimAutoReleasedAt: null,
                claimStartedAt: null,
            };
            const expired = spot.expiresAt && spot.expiresAt.toMillis() <= Date.now();
            tx.update(spotRef, expired ? clearFields : { ...clearFields, status: 'available' });
            deleteLockIfNamesSpot(tx, lockSnap, lockRef, spotId);

            if (needsNotification) {
                const notifRef = doc(db, 'spotNotifications', `claimer_cancelled_${spotId}_${fingerprint ?? 'x'}`);
                tx.set(notifRef, {
                    spotId,
                    senderId: claimantId,
                    targetUserId: finderId,
                    type: 'claimer_cancelled',
                    message,
                    createdAt: Timestamp.now(),
                });
            }

            return 'cancelled';
        });
    } catch (e: any) {
        if (e?.code !== 'permission-denied') throw e;

        let freshSnap;
        try {
            freshSnap = await getDoc(spotRef);
        } catch {
            throw e; // can't determine current truth — never assume success
        }

        if (!freshSnap.exists()) return 'already_resolved';
        const { matches, releasedByOther } = claimStatus(
            freshSnap.data() as Record<string, any>, claimantId, fingerprint
        );
        if (!matches) return releasedByOther ? 'already_resolved' : 'stale_claim';

        // Same user, same claim generation, still fully active — the write
        // genuinely failed for some other reason. Report it as a real
        // failure so the caller shows a retryable error instead of
        // silently treating a failed cancellation as a successful one.
        throw e;
    }
}
