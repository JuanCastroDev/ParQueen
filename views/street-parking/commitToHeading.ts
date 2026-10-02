import { doc, runTransaction, Timestamp } from 'firebase/firestore';
import { buildHeadingUpdate, decideCommitToHeading } from '../../utils/commitToHeadingDecision';

type Firestore = any;

export type CommitToHeadingResult = 'committed' | 'already_heading' | 'rejected';

export interface CommitClaimToHeadingParams {
  spotId: string;
  uid: string;
  etaMinutes: number;
  claimMinutes: number;
  nowMs?: number;
}

/**
 * Atomically moves a scheduled claim from committed to heading.
 *
 * Aborts with no write unless this user still holds an interested claim in
 * claimState 'committed'. Already heading is success and does not rewrite
 * ETA or expiry, so a second device cannot stack a second heading write.
 * If auto-release already cleared the claimer, the result is 'rejected' and
 * the Ping is left as the scheduler wrote it.
 *
 * The active-claim lock is intentionally not rewritten here. Arm 2b does not
 * include the lock, and the claim is still active, so the lock must keep
 * naming this Ping. Release, cancel, and arrival clear it.
 */
export async function commitClaimToHeading(
  db: Firestore,
  { spotId, uid, etaMinutes, claimMinutes, nowMs }: CommitClaimToHeadingParams,
): Promise<CommitToHeadingResult> {
  const spotRef = doc(db, 'spots', spotId);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(spotRef);
    if (!snap.exists()) return 'rejected';
    const decision = decideCommitToHeading(snap.data() as Record<string, any>, uid);
    if (decision !== 'commit') return decision;
    const at = nowMs ?? Date.now();
    tx.update(spotRef, buildHeadingUpdate(
      etaMinutes,
      Timestamp.fromMillis(at + claimMinutes * 60_000),
    ));
    return 'committed';
  });
}
