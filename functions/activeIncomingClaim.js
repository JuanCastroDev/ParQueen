'use strict';

const { Timestamp } = require('firebase-admin/firestore');
const { sanitizeError } = require('./redactForLog');
const {
  STALE_ACTIVE_CLAIM_LOCK_MS,
  ACTIVE_INCOMING_CLAIM_COLLECTION,
  ACTIVE_INCOMING_CLAIM_DOC_ID,
  pingHoldsActiveClaim,
  shouldGarbageCollectLock,
  lockNamesSpot,
} = require('./activeIncomingClaimLogic');

function activeIncomingClaimRef(db, uid) {
  return db.doc(`users/${uid}/${ACTIVE_INCOMING_CLAIM_COLLECTION}/${ACTIVE_INCOMING_CLAIM_DOC_ID}`);
}

/**
 * Read the claimant's lock. Call before any writes in the surrounding transaction.
 * Returns null when there is no claimant id (no read).
 */
function readActiveIncomingClaim(tx, db, uid) {
  if (typeof uid !== 'string' || uid.length === 0) return Promise.resolve(null);
  return tx.get(activeIncomingClaimRef(db, uid));
}

/** Admin SDK snapshots: `exists` is a boolean. No-op unless the lock names this Ping. */
function deleteMatchingActiveIncomingClaim(tx, lockSnap, spotId) {
  if (!lockSnap || !lockSnap.exists) return false;
  const data = lockSnap.data() || {};
  if (!lockNamesSpot(data, spotId)) return false;
  tx.delete(lockSnap.ref);
  return true;
}

/**
 * Standalone clear used by spot-delete handling (not inside another transaction).
 * Deletes the lock only when it still names the deleted Ping.
 */
async function clearMatchingActiveIncomingClaim(db, uid, spotId) {
  if (typeof uid !== 'string' || uid.length === 0) return false;
  if (typeof spotId !== 'string' || spotId.length === 0) return false;
  const ref = activeIncomingClaimRef(db, uid);
  return db.runTransaction(async (tx) => {
    const lockSnap = await tx.get(ref);
    return deleteMatchingActiveIncomingClaim(tx, lockSnap, spotId);
  });
}

function claimStateForLock(spot) {
  return spot && spot.claimState === 'committed' ? 'committed' : 'heading';
}

function claimStartedAtForLock(spot, now) {
  const started = spot && spot.claimStartedAt;
  if (started && typeof started.toMillis === 'function') return started;
  return now;
}

/**
 * 15-minute stale-lock GC, then Ping-wins backfill for interested Pings that
 * have no lock. A lock that still matches an interested Ping is kept.
 * A second interested Ping does not steal a lock that still matches another
 * active claim (pre-existing dual claims are not force-released).
 * The collection-group query needs the activeIncomingClaims.updatedAt index;
 * if that query fails, GC is skipped and backfill still runs.
 */
async function repairActiveIncomingClaims(db, now) {
  const gc = await garbageCollectStaleLocks(db, now);
  const backfill = await backfillMissingLocks(db, now);
  return { ...gc, ...backfill };
}

async function garbageCollectStaleLocks(db, now) {
  const cutoff = Timestamp.fromMillis(now.toMillis() - STALE_ACTIVE_CLAIM_LOCK_MS);
  let gcExamined = 0;
  let gcDeleted = 0;
  try {
    const snap = await db.collectionGroup(ACTIVE_INCOMING_CLAIM_COLLECTION)
      .where('updatedAt', '<=', cutoff)
      .limit(100)
      .get();
    gcExamined = snap.size;
    for (const lockDoc of snap.docs) {
      try {
        const uid = lockDoc.ref.parent && lockDoc.ref.parent.parent
          ? lockDoc.ref.parent.parent.id
          : null;
        const didDelete = await db.runTransaction(async (tx) => {
          const fresh = await tx.get(lockDoc.ref);
          if (!fresh.exists) return false;
          const data = fresh.data() || {};
          const updatedAtMs = data.updatedAt && typeof data.updatedAt.toMillis === 'function'
            ? data.updatedAt.toMillis()
            : NaN;
          const spotSnap = typeof data.spotId === 'string'
            ? await tx.get(db.doc(`spots/${data.spotId}`))
            : null;
          const spot = spotSnap && spotSnap.exists ? spotSnap.data() : null;
          if (!shouldGarbageCollectLock(updatedAtMs, now.toMillis(), spot, uid)) return false;
          tx.delete(lockDoc.ref);
          return true;
        });
        if (didDelete) gcDeleted++;
      } catch (e) {
        console.error('activeIncomingClaims: stale lock repair failed', sanitizeError(e));
      }
    }
  } catch (e) {
    console.error('activeIncomingClaims: stale lock query skipped', sanitizeError(e));
  }
  return { gcExamined, gcDeleted };
}

async function backfillMissingLocks(db, now) {
  let backfillExamined = 0;
  let backfilled = 0;
  try {
    const snap = await db.collection('spots')
      .where('status', '==', 'interested')
      .limit(100)
      .get();
    backfillExamined = snap.size;
    for (const spotDoc of snap.docs) {
      const uid = spotDoc.data().interestedUserId;
      if (typeof uid !== 'string' || uid.length === 0) continue;
      try {
        const didWrite = await db.runTransaction(async (tx) => {
          const fresh = await tx.get(spotDoc.ref);
          if (!fresh.exists) return false;
          const spot = fresh.data();
          if (!pingHoldsActiveClaim(spot, uid)) return false;
          const ref = activeIncomingClaimRef(db, uid);
          const lock = await tx.get(ref);
          if (lock.exists && lockNamesSpot(lock.data(), spotDoc.id)) return false;
          if (lock.exists) {
            const otherId = (lock.data() || {}).spotId;
            if (typeof otherId === 'string' && otherId !== spotDoc.id) {
              const other = await tx.get(db.doc(`spots/${otherId}`));
              const otherSpot = other.exists ? other.data() : null;
              if (pingHoldsActiveClaim(otherSpot, uid)) return false;
            }
          }
          tx.set(ref, {
            spotId: spotDoc.id,
            claimStartedAt: claimStartedAtForLock(spot, now),
            claimState: claimStateForLock(spot),
            updatedAt: now,
          });
          return true;
        });
        if (didWrite) backfilled++;
      } catch (e) {
        console.error('activeIncomingClaims: lock backfill failed', sanitizeError(e));
      }
    }
  } catch (e) {
    console.error('activeIncomingClaims: backfill query skipped', sanitizeError(e));
  }
  return { backfillExamined, backfilled };
}

module.exports = {
  activeIncomingClaimRef,
  readActiveIncomingClaim,
  deleteMatchingActiveIncomingClaim,
  clearMatchingActiveIncomingClaim,
  repairActiveIncomingClaims,
};
