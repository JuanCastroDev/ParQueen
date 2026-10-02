'use strict';

const { Timestamp, FieldPath } = require('firebase-admin/firestore');
const { sanitizeError } = require('./redactForLog');
const {
  STALE_ACTIVE_CLAIM_LOCK_MS,
  ACTIVE_INCOMING_CLAIM_COLLECTION,
  ACTIVE_INCOMING_CLAIM_DOC_ID,
  ACTIVE_INCOMING_CLAIM_ROLLOUT_COLLECTION,
  ACTIVE_INCOMING_CLAIM_ROLLOUT_DOC_ID,
  ACTIVE_INCOMING_CLAIM_CONFLICT_COLLECTION,
  CANONICAL_ACTIVE_CLAIM_RULE,
  pingHoldsActiveClaim,
  shouldGarbageCollectLock,
  lockNamesSpot,
  planUserReconciliation,
  auditActiveClaimGroups,
  invariantMayBeEnforced,
  releasedInterestPatch,
} = require('./activeIncomingClaimLogic');

const INTERESTED_CLAIM_PAGE_SIZE = 200;
const MAX_INTERESTED_CLAIM_SCAN = 2000;

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
 * 15-minute stale-lock GC, then full reconciliation of every interested Ping.
 * Reconciliation establishes the canonical lock and releases duplicate
 * interested Pings before the rollout gate is allowed to open.
 * The collection-group query needs the activeIncomingClaims.updatedAt index;
 * if that query fails, GC is skipped and reconciliation still runs.
 * Reconciliation pages spots by status + document id (composite index).
 */
async function repairActiveIncomingClaims(db, now) {
  const gc = await garbageCollectStaleLocks(db, now);
  const reconcile = await reconcileActiveIncomingClaims(db, now);
  return { ...gc, ...reconcile };
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

function millisOf(value) {
  return value && typeof value.toMillis === 'function' ? value.toMillis() : Number.NaN;
}

function rolloutStatusRef(db) {
  return db.doc(`${ACTIVE_INCOMING_CLAIM_ROLLOUT_COLLECTION}/${ACTIVE_INCOMING_CLAIM_ROLLOUT_DOC_ID}`);
}

/**
 * Page every status==interested Ping. An incomplete scan must not reconcile
 * or open the gate: a user's Pings could be split across the cut.
 */
async function loadInterestedSpotDocs(db) {
  const docs = [];
  let last = null;
  while (docs.length < MAX_INTERESTED_CLAIM_SCAN) {
    let query = db.collection('spots')
      .where('status', '==', 'interested')
      .orderBy(FieldPath.documentId())
      .limit(INTERESTED_CLAIM_PAGE_SIZE);
    if (last) query = query.startAfter(last);
    const snap = await query.get();
    if (snap.empty) return { docs, complete: true };
    docs.push(...snap.docs);
    last = snap.docs[snap.docs.length - 1];
    if (snap.size < INTERESTED_CLAIM_PAGE_SIZE) return { docs, complete: true };
  }
  return { docs, complete: false };
}

async function readLockSpotIds(db, uids) {
  const locks = new Map();
  for (let i = 0; i < uids.length; i += 100) {
    const chunk = uids.slice(i, i + 100);
    const snaps = await db.getAll(...chunk.map((uid) => activeIncomingClaimRef(db, uid)));
    snaps.forEach((snap, idx) => {
      const spotId = snap.exists ? (snap.data() || {}).spotId : null;
      locks.set(chunk[idx], typeof spotId === 'string' ? spotId : null);
    });
  }
  return locks;
}

async function scanInterestedClaims(db) {
  const loaded = await loadInterestedSpotDocs(db);
  if (!loaded.complete) return { scanComplete: false, groups: [], audit: null };
  const byUser = new Map();
  for (const spotDoc of loaded.docs) {
    const data = spotDoc.data() || {};
    const uid = data.interestedUserId;
    if (typeof uid !== 'string' || uid.length === 0 || uid.includes('/')) continue;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push({
      spotId: spotDoc.id,
      ref: spotDoc.ref,
      claimStartedAtMs: millisOf(data.claimStartedAt),
      expiresAtMs: millisOf(data.expiresAt),
    });
  }
  const uids = [...byUser.keys()];
  const locks = await readLockSpotIds(db, uids);
  const groups = uids.map((uid) => {
    const claims = byUser.get(uid);
    return {
      uid,
      claims,
      spotIds: claims.map((claim) => claim.spotId),
      lockSpotId: locks.has(uid) ? locks.get(uid) : null,
    };
  });
  return {
    scanComplete: true,
    groups,
    audit: auditActiveClaimGroups(groups),
  };
}

function lockAlreadyCanonical(existing, keep) {
  if (!existing || existing.spotId !== keep.spotId) return false;
  if (existing.claimState !== claimStateForLock(keep.spot)) return false;
  const pingStarted = millisOf(keep.spot && keep.spot.claimStartedAt);
  if (Number.isFinite(pingStarted)) return millisOf(existing.claimStartedAt) === pingStarted;
  return Number.isFinite(millisOf(existing.claimStartedAt));
}

async function reconcileUserClaims(db, uid, claims, now) {
  const nowMs = now.toMillis();
  return db.runTransaction(async (tx) => {
    const live = [];
    for (const claim of claims) {
      const snap = await tx.get(claim.ref);
      if (!snap.exists) continue;
      const spot = snap.data() || {};
      if (!pingHoldsActiveClaim(spot, uid)) continue;
      live.push({
        spotId: snap.id,
        ref: snap.ref,
        claimStartedAtMs: millisOf(spot.claimStartedAt),
        expiresAtMs: millisOf(spot.expiresAt),
        spot,
      });
    }
    const lockRef = activeIncomingClaimRef(db, uid);
    const lockSnap = await tx.get(lockRef);
    if (live.length === 0) {
      return { locksEstablished: 0, duplicatesReleased: 0, conflictsReported: 0 };
    }
    const plan = planUserReconciliation(live);
    const keep = plan.keep;
    for (const extra of plan.release) {
      tx.update(extra.ref, releasedInterestPatch(extra.expiresAtMs, nowMs));
    }
    const existing = lockSnap.exists ? (lockSnap.data() || {}) : null;
    let locksEstablished = 0;
    if (!lockAlreadyCanonical(existing, keep)) {
      tx.set(lockRef, {
        spotId: keep.spotId,
        claimStartedAt: claimStartedAtForLock(keep.spot, now),
        claimState: claimStateForLock(keep.spot),
        updatedAt: now,
      });
      locksEstablished = 1;
    }
    let conflictsReported = 0;
    if (plan.release.length > 0) {
      tx.set(db.collection(ACTIVE_INCOMING_CLAIM_CONFLICT_COLLECTION).doc(uid), {
        uid,
        keptSpotId: keep.spotId,
        releasedSpotIds: plan.release.map((extra) => extra.spotId),
        rule: CANONICAL_ACTIVE_CLAIM_RULE,
        reportedAt: now,
      });
      conflictsReported = 1;
    }
    return {
      locksEstablished,
      duplicatesReleased: plan.release.length,
      conflictsReported,
    };
  });
}

async function writeRolloutStatus(db, audit, extra, now) {
  await rolloutStatusRef(db).set({
    enforced: extra.enforced === true,
    locklessCount: audit.locklessCount,
    duplicateUserCount: audit.duplicateUserCount,
    duplicatePingCount: audit.duplicatePingCount,
    interestedWithClaimerCount: audit.interestedWithClaimerCount,
    canonicalRule: CANONICAL_ACTIVE_CLAIM_RULE,
    reconciledAt: now,
    locksEstablished: extra.locksEstablished || 0,
    duplicatesReleased: extra.duplicatesReleased || 0,
    conflictsReported: extra.conflictsReported || 0,
    reconcileErrors: extra.reconcileErrors || 0,
    phase: extra.phase,
  });
}

/**
 * Full-scan reconciliation for legacy interested Pings that have no lock.
 *
 * The hard invariant stays closed on any run that still has to repair data.
 * A later run opens it only when the scan is already clean (zero lockless
 * interested Pings and zero duplicate interested Pings per uid). That keeps
 * a repair from publishing enforced:true in the same commit window as the
 * writes it just made. Deploy rules before this function so Arm 1 is
 * fail-closed while that confirming scan is still outstanding.
 *
 * Duplicate interested Pings are not left active. The earliest claimStartedAt
 * (then lexicographic spot id) is kept; the others are released and written
 * to activeIncomingClaimConflicts/{uid}.
 */
async function reconcileActiveIncomingClaims(db, now) {
  const pre = await scanInterestedClaims(db);
  if (!pre.scanComplete) {
    console.error('activeIncomingClaims: interested scan incomplete; rollout gate unchanged');
    return {
      scanComplete: false,
      enforced: null,
      locklessCount: null,
      duplicateUserCount: null,
      duplicatePingCount: null,
      interestedWithClaimerCount: null,
      locksEstablished: 0,
      duplicatesReleased: 0,
      conflictsReported: 0,
      reconcileErrors: 0,
    };
  }

  const preAudit = { scanComplete: true, ...pre.audit };
  if (invariantMayBeEnforced(preAudit)) {
    await writeRolloutStatus(db, pre.audit, {
      enforced: true,
      phase: 'enforced',
    }, now);
    return {
      scanComplete: true,
      enforced: true,
      ...pre.audit,
      locksEstablished: 0,
      duplicatesReleased: 0,
      conflictsReported: 0,
      reconcileErrors: 0,
    };
  }

  await writeRolloutStatus(db, pre.audit, {
    enforced: false,
    phase: 'repairing',
  }, now);

  let locksEstablished = 0;
  let duplicatesReleased = 0;
  let conflictsReported = 0;
  let reconcileErrors = 0;
  for (const group of pre.groups) {
    try {
      const result = await reconcileUserClaims(db, group.uid, group.claims, now);
      locksEstablished += result.locksEstablished;
      duplicatesReleased += result.duplicatesReleased;
      conflictsReported += result.conflictsReported;
    } catch (e) {
      reconcileErrors++;
      console.error(
        'activeIncomingClaims: reconcile failed',
        String(group.uid).slice(0, 8) + '***',
        sanitizeError(e),
      );
    }
  }

  const post = await scanInterestedClaims(db);
  if (!post.scanComplete) {
    console.error('activeIncomingClaims: post-repair scan incomplete; rollout gate left closed');
    return {
      scanComplete: false,
      enforced: false,
      locklessCount: null,
      duplicateUserCount: null,
      duplicatePingCount: null,
      interestedWithClaimerCount: null,
      locksEstablished,
      duplicatesReleased,
      conflictsReported,
      reconcileErrors,
    };
  }

  await writeRolloutStatus(db, post.audit, {
    enforced: false,
    phase: 'repaired',
    locksEstablished,
    duplicatesReleased,
    conflictsReported,
    reconcileErrors,
  }, now);

  return {
    scanComplete: true,
    enforced: false,
    ...post.audit,
    locksEstablished,
    duplicatesReleased,
    conflictsReported,
    reconcileErrors,
  };
}

async function auditActiveIncomingClaims(db) {
  const scan = await scanInterestedClaims(db);
  if (!scan.scanComplete) {
    return {
      scanComplete: false,
      locklessCount: null,
      duplicateUserCount: null,
      duplicatePingCount: null,
      interestedWithClaimerCount: null,
    };
  }
  return { scanComplete: true, ...scan.audit };
}

module.exports = {
  activeIncomingClaimRef,
  readActiveIncomingClaim,
  deleteMatchingActiveIncomingClaim,
  clearMatchingActiveIncomingClaim,
  repairActiveIncomingClaims,
  reconcileActiveIncomingClaims,
  auditActiveIncomingClaims,
};
