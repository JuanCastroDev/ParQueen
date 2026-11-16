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
  planUserReconciliation,
  auditActiveClaimGroups,
  invariantMayBeEnforced,
  releasedInterestPatch,
} = require('./activeIncomingClaimLogic');
const { isClaimGenerationId } = require('./claimGeneration');
const {
  LOCK_MATCH,
  expectedClaimFromSpot,
  classifyLockForExpectedClaim,
  deleteExactClaimLock,
  lockConflict,
} = require('./claimLockIdentity');
const { timestampFingerprint, sameFingerprint } = require('./legacyClaimIdentity');

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

/** Delete only a lock proven to name the exact claim cycle being released. */
function deleteMatchingActiveIncomingClaim(tx, lockSnap, expectedClaim) {
  return deleteExactClaimLock(tx, lockSnap, expectedClaim);
}

/**
 * Standalone clear used by spot-delete handling (not inside another transaction).
 * Deletes the lock only when it still names the deleted Ping.
 */
async function clearMatchingActiveIncomingClaim(db, uid, expectedClaim) {
  if (typeof uid !== 'string' || uid.length === 0) return LOCK_MATCH.MALFORMED;
  if (!expectedClaim || typeof expectedClaim.spotId !== 'string' || !expectedClaim.spotId) {
    return LOCK_MATCH.MALFORMED;
  }
  const ref = activeIncomingClaimRef(db, uid);
  return db.runTransaction(async (tx) => {
    const lockSnap = await tx.get(ref);
    const result = deleteMatchingActiveIncomingClaim(tx, lockSnap, expectedClaim);
    if (lockConflict(result)) {
      console.error('activeClaimLockRepairRequired', {
        operation: 'spot_delete',
        classification: result,
        claimKind: expectedClaim.kind,
      });
    } else if (result === LOCK_MATCH.MISSING || result === LOCK_MATCH.UNRELATED_SPOT) {
      console.warn('activeClaimLockReconciliationNeeded', {
        operation: 'spot_delete',
        classification: result,
        claimKind: expectedClaim.kind,
      });
    }
    return result;
  });
}

function claimStateForLock(spot) {
  if (!spot || (spot.claimState !== 'committed' && spot.claimState !== 'heading')) return null;
  return spot.claimState;
}

function claimStartedAtForLock(spot) {
  const started = spot && spot.claimStartedAt;
  return timestampFingerprint(started) ? started : null;
}

/** Reconciliation requires a canonical lock shape, not merely release identity. */
function classifyCanonicalLock(lock, spotId, spot) {
  const canonicalClaimState = claimStateForLock(spot);
  const expectedClaim = expectedClaimFromSpot(spotId, spot);
  const spotStartedAt = timestampFingerprint(spot && spot.claimStartedAt);
  if (!canonicalClaimState || !expectedClaim || !spotStartedAt) return LOCK_MATCH.MALFORMED;
  const identityResult = classifyLockForExpectedClaim(lock, expectedClaim);
  if (identityResult !== LOCK_MATCH.EXACT) return identityResult;
  const lockStartedAt = timestampFingerprint(lock && lock.claimStartedAt);
  if (!lockStartedAt) return LOCK_MATCH.MALFORMED;
  if (!sameFingerprint(lockStartedAt, spotStartedAt)) return LOCK_MATCH.SAME_SPOT_CONFLICT;
  return lock.claimState === canonicalClaimState
    ? LOCK_MATCH.EXACT
    : LOCK_MATCH.SAME_SPOT_CONFLICT;
}

/**
 * 15-minute stale-lock GC, then full reconciliation of every interested Ping.
 * Reconciliation establishes the canonical lock and releases duplicate
 * interested Pings before the rollout gate is allowed to open.
 * The collection-group query needs the activeIncomingClaims.updatedAt index;
 * if that query fails, GC is skipped and reconciliation still runs.
 * Reconciliation pages spots by status + document id. That equality plus
 * orderBy(documentId()) is served by the automatic single-field index on
 * status; a composite of status + __name__ is rejected by Firebase (400).
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

async function readActiveLocks(db, uids) {
  const locks = new Map();
  for (let i = 0; i < uids.length; i += 100) {
    const chunk = uids.slice(i, i + 100);
    const snaps = await db.getAll(...chunk.map((uid) => activeIncomingClaimRef(db, uid)));
    snaps.forEach((snap, idx) => {
      locks.set(chunk[idx], snap.exists ? (snap.data() || {}) : null);
    });
  }
  return locks;
}

async function scanInterestedClaims(db) {
  const loaded = await loadInterestedSpotDocs(db);
  if (!loaded.complete) return { scanComplete: false, groups: [], audit: null };
  const byUser = new Map();
  let malformedInterestedCount = 0;
  for (const spotDoc of loaded.docs) {
    const data = spotDoc.data() || {};
    const uid = data.interestedUserId;
    if (typeof uid !== 'string' || uid.length === 0 || uid.includes('/')) {
      malformedInterestedCount++;
      continue;
    }
    if (!claimStateForLock(data)
      || !expectedClaimFromSpot(spotDoc.id, data)
      || !timestampFingerprint(data.claimStartedAt)) {
      malformedInterestedCount++;
    }
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push({
      spotId: spotDoc.id,
      ref: spotDoc.ref,
      claimStartedAtMs: millisOf(data.claimStartedAt),
      expiresAtMs: millisOf(data.expiresAt),
      spot: data,
    });
  }
  const uids = [...byUser.keys()];
  if (malformedInterestedCount > 0) {
    console.error('activeIncomingClaims: malformed interested Ping records', {
      operation: 'active_claim_scan',
      classification: LOCK_MATCH.MALFORMED,
      count: malformedInterestedCount,
    });
  }
  const locks = await readActiveLocks(db, uids);
  const groups = uids.map((uid) => {
    const claims = byUser.get(uid);
    const lock = locks.has(uid) ? locks.get(uid) : null;
    return {
      uid,
      claims,
      spotIds: claims.map((claim) => claim.spotId),
      canonicalSpotIds: claims
        .filter((claim) => classifyCanonicalLock(lock, claim.spotId, claim.spot) === LOCK_MATCH.EXACT)
        .map((claim) => claim.spotId),
    };
  });
  return {
    scanComplete: true,
    groups,
    audit: auditActiveClaimGroups(groups, malformedInterestedCount),
  };
}

function generationForLock(spot) {
  const id = spot && spot.claimGenerationId;
  return isClaimGenerationId(id) ? id : null;
}

function lockAlreadyCanonical(existing, keep) {
  return classifyCanonicalLock(existing, keep.spotId, keep.spot) === LOCK_MATCH.EXACT;
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
      const expectedClaim = expectedClaimFromSpot(snap.id, spot);
      const claimStartedAt = claimStartedAtForLock(spot);
      const claimState = claimStateForLock(spot);
      if (!expectedClaim || !claimStartedAt || !claimState) {
        console.error('activeClaimReconciliationBlocked', {
          operation: 'active_claim_reconciliation',
          classification: LOCK_MATCH.MALFORMED,
          claimKind: expectedClaim && expectedClaim.kind,
        });
        return {
          locksEstablished: 0,
          duplicatesReleased: 0,
          conflictsReported: 0,
          reconcileErrors: 1,
        };
      }
      live.push({
        spotId: snap.id,
        ref: snap.ref,
        claimStartedAtMs: millisOf(spot.claimStartedAt),
        expiresAtMs: millisOf(spot.expiresAt),
        spot,
        expectedClaim,
        claimStartedAt,
        claimState,
      });
    }
    const lockRef = activeIncomingClaimRef(db, uid);
    const lockSnap = await tx.get(lockRef);
    if (live.length === 0) {
      return { locksEstablished: 0, duplicatesReleased: 0, conflictsReported: 0, reconcileErrors: 0 };
    }
    const plan = planUserReconciliation(live);
    const keep = plan.keep;
    for (const extra of plan.release) {
      tx.update(extra.ref, releasedInterestPatch(extra.expiresAtMs, nowMs));
    }
    const existing = lockSnap.exists ? (lockSnap.data() || {}) : null;
    let locksEstablished = 0;
    if (!lockAlreadyCanonical(existing, keep)) {
      const keptGeneration = generationForLock(keep.spot);
      tx.set(lockRef, {
        spotId: keep.spotId,
        claimStartedAt: keep.claimStartedAt,
        claimState: keep.claimState,
        updatedAt: now,
        ...(keptGeneration ? { claimGenerationId: keptGeneration } : {}),
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
      reconcileErrors: 0,
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
    malformedInterestedCount: audit.malformedInterestedCount,
    canonicalRule: CANONICAL_ACTIVE_CLAIM_RULE,
    reconciledAt: now,
    locksEstablished: extra.locksEstablished || 0,
    duplicatesReleased: extra.duplicatesReleased || 0,
    conflictsReported: extra.conflictsReported || 0,
    reconcileErrors: extra.reconcileErrors || 0,
    phase: extra.phase,
  });
}

async function writeIncompleteRolloutStatus(db, now, phase, reconcileErrors = 1) {
  await writeRolloutStatus(db, {
    locklessCount: null,
    duplicateUserCount: null,
    duplicatePingCount: null,
    interestedWithClaimerCount: null,
    malformedInterestedCount: null,
  }, {
    enforced: false,
    phase,
    reconcileErrors,
  }, now);
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
  let pre;
  try {
    pre = await scanInterestedClaims(db);
  } catch (e) {
    console.error('activeIncomingClaims: interested scan failed; rollout gate closed', sanitizeError(e));
    await writeIncompleteRolloutStatus(db, now, 'failed_pre_scan');
    return {
      scanComplete: false,
      enforced: false,
      locklessCount: null,
      duplicateUserCount: null,
      duplicatePingCount: null,
      interestedWithClaimerCount: null,
      malformedInterestedCount: null,
      locksEstablished: 0,
      duplicatesReleased: 0,
      conflictsReported: 0,
      reconcileErrors: 1,
    };
  }
  if (!pre.scanComplete) {
    console.error('activeIncomingClaims: interested scan incomplete; rollout gate closed');
    await writeIncompleteRolloutStatus(db, now, 'incomplete_pre_scan');
    return {
      scanComplete: false,
      enforced: false,
      locklessCount: null,
      duplicateUserCount: null,
      duplicatePingCount: null,
      interestedWithClaimerCount: null,
      malformedInterestedCount: null,
      locksEstablished: 0,
      duplicatesReleased: 0,
      conflictsReported: 0,
      reconcileErrors: 1,
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
      reconcileErrors += result.reconcileErrors || 0;
    } catch (e) {
      reconcileErrors++;
      console.error(
        'activeIncomingClaims: reconcile failed',
        String(group.uid).slice(0, 8) + '***',
        sanitizeError(e),
      );
    }
  }

  let post;
  try {
    post = await scanInterestedClaims(db);
  } catch (e) {
    console.error('activeIncomingClaims: post-repair scan failed; rollout gate left closed', sanitizeError(e));
    await writeIncompleteRolloutStatus(db, now, 'failed_post_scan', reconcileErrors + 1);
    return {
      scanComplete: false,
      enforced: false,
      locklessCount: null,
      duplicateUserCount: null,
      duplicatePingCount: null,
      interestedWithClaimerCount: null,
      malformedInterestedCount: null,
      locksEstablished,
      duplicatesReleased,
      conflictsReported,
      reconcileErrors: reconcileErrors + 1,
    };
  }
  if (!post.scanComplete) {
    console.error('activeIncomingClaims: post-repair scan incomplete; rollout gate left closed');
    await writeIncompleteRolloutStatus(db, now, 'incomplete_post_scan', reconcileErrors + 1);
    return {
      scanComplete: false,
      enforced: false,
      locklessCount: null,
      duplicateUserCount: null,
      duplicatePingCount: null,
      interestedWithClaimerCount: null,
      malformedInterestedCount: null,
      locksEstablished,
      duplicatesReleased,
      conflictsReported,
      reconcileErrors: reconcileErrors + 1,
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
      malformedInterestedCount: null,
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
