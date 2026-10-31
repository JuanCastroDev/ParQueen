import { collection, doc, getDoc, getDocs, limit, query, where } from 'firebase/firestore';
import { activeIncomingClaimRef } from './activeIncomingClaim';
import { isClaimGenerationId } from './claimIdentity';

type Firestore = any;

/**
 * Live claims created by claimSpot are heading (immediate) or committed
 * (scheduled). The documented spots index is interestedUserId + claimState.
 * users/{uid}/activeIncomingClaims/current is a direct get, not a query.
 * Neither read uses the map geohash window. The 60-second prepare lifetime
 * is not consulted: it does not release a committed claim.
 */
export const RECOVERY_CHECK_FAILED = 'Could not check for an active claim.';
export const RECOVERY_CHANGED = 'This claim changed. It was not released.';
export const RECOVERY_RELEASED = 'Claim released.';
export const RECOVERABLE_CLAIM_STATES = ['heading', 'committed'] as const;
export type RecoverableClaimState = (typeof RECOVERABLE_CLAIM_STATES)[number];

export interface RecoveredClaim {
  spotId: string;
  claimGenerationId: string;
  claimState: RecoverableClaimState;
  label: string;
  lat: number | null;
  lng: number | null;
  finderId: string | null;
}

function spotIdOk(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 200
    && !value.includes('/')
    && value !== '.'
    && value !== '..';
}

/** A spot is recoverable only when this user still holds a generation-bound active claim. */
export function recoverableClaim(
  spotId: string,
  data: Record<string, unknown> | undefined,
  uid: string,
): RecoveredClaim | null {
  if (!spotIdOk(spotId) || !data || !uid) return null;
  if (data.status !== 'interested') return null;
  if (data.interestedUserId !== uid) return null;
  if (data.claimState !== 'heading' && data.claimState !== 'committed') return null;
  if (!isClaimGenerationId(data.claimGenerationId)) return null;
  const address = typeof data.address === 'string' ? data.address.trim() : '';
  return {
    spotId,
    claimGenerationId: data.claimGenerationId,
    claimState: data.claimState,
    label: (address || spotId).slice(0, 200),
    lat: typeof data.lat === 'number' && Number.isFinite(data.lat) ? data.lat : null,
    lng: typeof data.lng === 'number' && Number.isFinite(data.lng) ? data.lng : null,
    finderId: typeof data.finderId === 'string' ? data.finderId : null,
  };
}

/**
 * Lock first, then the user-scoped claimState query. The lock is only a
 * spot id. claimGenerationId is taken from the spot document, never from
 * the lock. A stale or missing lock cannot hide another live claim the
 * query returns, and it cannot invent one.
 */
export async function readRecoverableClaims(db: Firestore, uid: string): Promise<RecoveredClaim[]> {
  const lockSnap = await getDoc(activeIncomingClaimRef(db, uid));
  const lockData = lockSnap.exists() ? (lockSnap.data() as { spotId?: unknown } | undefined) : undefined;
  const lockSpotId = lockData && spotIdOk(lockData.spotId) ? lockData.spotId : null;

  const snap = await getDocs(query(
    collection(db, 'spots'),
    where('interestedUserId', '==', uid),
    where('claimState', 'in', [...RECOVERABLE_CLAIM_STATES]),
    limit(10),
  ));

  const found = new Map<string, RecoveredClaim>();
  for (const item of snap.docs) {
    const claim = recoverableClaim(item.id, item.data() as Record<string, unknown>, uid);
    if (claim) found.set(claim.spotId, claim);
  }

  if (lockSpotId && !found.has(lockSpotId)) {
    const spotSnap = await getDoc(doc(db, 'spots', lockSpotId));
    const claim = spotSnap.exists()
      ? recoverableClaim(spotSnap.id || lockSpotId, spotSnap.data() as Record<string, unknown>, uid)
      : null;
    if (claim) found.set(claim.spotId, claim);
  }
  return [...found.values()];
}
