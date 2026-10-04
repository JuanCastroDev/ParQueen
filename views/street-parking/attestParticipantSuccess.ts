import { doc, getDoc, setDoc, Timestamp } from 'firebase/firestore';
import {
  ArrivalNotDurableError,
  buildParticipantSuccessAttestation,
  isDurableArrival,
  isMatchingParticipantAttestation,
  participantSuccessFeedbackId,
  type ParticipantRole,
} from '../../utils/spotFeedback';

type Firestore = any;

export interface AttestParticipantSuccessParams {
  spotId: string;
  claimerId: string;
  finderId: string;
  address: string;
  role: ParticipantRole;
  actorId: string;
}

export type ParticipantAttestationResult = 'created' | 'already_attested';

/**
 * One party writes only their own immutable participant_success doc.
 * Does not write outcome success, crowns, title, functionEvents, unconfirmed,
 * or completed_success. The finder doc is not created unless the Ping is
 * already durably arrived.
 */
export async function attestParticipantSuccess(
  db: Firestore,
  params: AttestParticipantSuccessParams,
): Promise<ParticipantAttestationResult> {
  if (!params.claimerId || !params.finderId || params.claimerId === params.finderId) {
    throw new Error('Handoff participants changed');
  }
  if (params.role === 'claimer' && params.actorId !== params.claimerId) {
    throw new Error('Handoff participants changed');
  }
  if (params.role === 'finder' && params.actorId !== params.finderId) {
    throw new Error('Handoff participants changed');
  }

  const spotRef = doc(db, 'spots', params.spotId);
  const spotSnap = await getDoc(spotRef);
  if (!spotSnap.exists()) throw new Error('Handoff spot no longer exists');
  const spot = spotSnap.data() as Record<string, any>;
  if (!isDurableArrival(spot)) throw new ArrivalNotDurableError();
  if (spot.interestedUserId !== params.claimerId || spot.finderId !== params.finderId) {
    throw new Error('Handoff participants changed');
  }

  const feedback = buildParticipantSuccessAttestation({
    spotId: params.spotId,
    claimerId: params.claimerId,
    finderId: params.finderId,
    address: params.address,
    role: params.role,
    createdAt: Timestamp.now(),
  });
  const feedbackRef = doc(db, 'spotFeedback', participantSuccessFeedbackId(
    params.spotId,
    params.claimerId,
    params.role,
  ));

  try {
    await setDoc(feedbackRef, feedback);
    return 'created';
  } catch (error: any) {
    if (error?.code !== 'permission-denied') throw error;
    let existing;
    try {
      existing = await getDoc(feedbackRef);
    } catch {
      throw error;
    }
    if (existing.exists() && isMatchingParticipantAttestation(existing.data(), feedback)) {
      return 'already_attested';
    }
    throw error;
  }
}
