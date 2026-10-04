import {
  collection, doc, getDoc, getDocs, query, runTransaction, setDoc, Timestamp, where,
} from 'firebase/firestore';
import { isHandoffFailureReason, spotFeedbackDocId } from '../../utils/spotFeedback';
import { activeIncomingClaimRef, deleteLockIfNamesSpot } from './activeIncomingClaim';

type Firestore = any;

export type TerminalHandoffOutcome = 'success' | 'failed';

export interface CompleteTerminalHandoffParams {
  spotId: string;
  driverId: string;
  driverName: string;
  finderId: string;
  address: string;
  outcome: TerminalHandoffOutcome;
  failureReason: string | null;
}

export type TerminalHandoffCompletion = 'created' | 'already_completed';

interface TerminalNotification {
  senderId: string;
  targetUserId: string;
  message: string;
}

interface InternalTerminalHandoffParams extends CompleteTerminalHandoffParams {
  actorId: string;
  confirmedByFinder: boolean;
  markSpotOccupied: boolean;
  notification: TerminalNotification | null;
}

function sameTerminalFeedback(
  existing: Record<string, any>,
  intended: Record<string, any>,
): boolean {
  const sameIdentityAndOutcome = existing.spotId === intended.spotId
    && existing.userId === intended.userId
    && existing.finderId === intended.finderId
    && existing.outcome === intended.outcome
    && existing.address === intended.address
    && (existing.confirmedByFinder === true) === (intended.confirmedByFinder === true);

  if (!sameIdentityAndOutcome) return false;
  if ((existing.failureReason ?? null) === intended.failureReason) return true;

  // Pre-PR #90 clients could commit failed feedback with a null reason before
  // the forbidden follow-up update. Preserve immutability and let that already-
  // terminal legacy flow close instead of trapping the user forever. New failed
  // feedback cannot enter this shape after the accompanying Rules change.
  return intended.outcome === 'failed' && existing.failureReason == null;
}

/**
 * Atomically creates the immutable terminal feedback and, for success, the
 * finder notification. The deterministic feedback id is also the retry key.
 */
async function commitTerminalHandoff(
  db: Firestore,
  params: InternalTerminalHandoffParams,
): Promise<TerminalHandoffCompletion> {
  if (params.outcome === 'failed' && !isHandoffFailureReason(params.failureReason)) {
    throw new Error('Invalid handoff failure reason');
  }
  if (params.outcome === 'success' && params.failureReason !== null) {
    throw new Error('Successful handoff cannot include a failure reason');
  }

  const feedbackId = spotFeedbackDocId(params.spotId, params.driverId);
  const spotRef = doc(db, 'spots', params.spotId);
  const feedbackRef = doc(db, 'spotFeedback', feedbackId);
  const notificationRef = doc(db, 'spotNotifications', `handoff_success_${feedbackId}`);
  const createdAt = Timestamp.now();
  const feedback = {
    spotId: params.spotId,
    userId: params.driverId,
    finderId: params.finderId,
    outcome: params.outcome,
    failureReason: params.failureReason,
    address: params.address,
    createdAt,
    ...(params.confirmedByFinder ? { confirmedByFinder: true } : {}),
  };
  const notification = params.notification ? {
    spotId: params.spotId,
    senderId: params.notification.senderId,
    targetUserId: params.notification.targetUserId,
    type: 'handoff_success',
    message: params.notification.message,
    createdAt,
  } : null;

  try {
    await runTransaction(db, async (tx) => {
      const spotSnap = await tx.get(spotRef);
      // Only the driver can read their own lock. Finder confirmation must not
      // touch it: a missing or foreign lock read would deny the whole handoff.
      // Occupied is not an active claim, so a leftover lock does not block the
      // next claim; the 15-minute sweeper deletes it.
      const lockRef = activeIncomingClaimRef(db, params.driverId);
      const lockSnap = params.actorId === params.driverId ? await tx.get(lockRef) : null;
      if (!spotSnap.exists()) throw new Error('Handoff spot no longer exists');
      const spot = spotSnap.data() as Record<string, any>;
      if (spot.finderId !== params.finderId
        || spot.interestedUserId !== params.driverId) {
        throw new Error('Handoff participants changed');
      }
      if (params.markSpotOccupied) {
        if (params.actorId !== params.finderId
          || (spot.status !== 'interested' && spot.status !== 'occupied')) {
          throw new Error('Handoff terminal state changed');
        }
        if (spot.status !== 'occupied') tx.update(spotRef, { status: 'occupied' });
      } else if (params.actorId !== params.driverId || spot.status !== 'occupied') {
        throw new Error('Handoff terminal state changed');
      }

      tx.set(feedbackRef, feedback);
      if (notification) tx.set(notificationRef, notification);
      if (lockSnap) deleteLockIfNamesSpot(tx, lockSnap, lockRef, params.spotId);
    });
    return 'created';
  } catch (error: any) {
    if (error?.code !== 'permission-denied') throw error;

    let existing;
    try {
      existing = await getDoc(feedbackRef);
    } catch {
      throw error;
    }
    if (existing.exists() && sameTerminalFeedback(existing.data(), feedback)) {
      // A pre-PR #90 client could have committed immutable success feedback
      // before its separate notification write failed. The deterministic
      // notification id lets a retry repair that legacy partial state without
      // touching the feedback document. Check sender-visible success notices
      // first because older clients used random ids; otherwise a fully completed
      // legacy handoff would receive a duplicate deterministic notification.
      if (notification) {
        const priorNotifications = await getDocs(query(
          collection(db, 'spotNotifications'),
          where('senderId', '==', notification.senderId),
          where('type', '==', 'handoff_success'),
          where('spotId', '==', params.spotId),
        ));
        const alreadyNotified = priorNotifications.docs.some((snapshot: any) => (
          snapshot.data()?.targetUserId === notification.targetUserId
        ));
        if (!alreadyNotified) {
          try {
            await setDoc(notificationRef, notification);
          } catch (notificationError: any) {
            // A concurrent retry can win this create between query and write.
            if (notificationError?.code !== 'permission-denied') throw notificationError;
          }
        }
      }
      return 'already_completed';
    }
    throw error;
  }
}

export async function completeTerminalHandoff(
  db: Firestore,
  params: CompleteTerminalHandoffParams,
): Promise<TerminalHandoffCompletion> {
  return commitTerminalHandoff(db, {
    ...params,
    actorId: params.driverId,
    confirmedByFinder: false,
    markSpotOccupied: false,
    notification: params.outcome === 'success' ? {
      senderId: params.driverId,
      targetUserId: params.finderId,
      message: `${params.driverName || 'Someone'} parked in your spot — +2 Crowns earned!`,
    } : null,
  });
}

