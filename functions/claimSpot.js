'use strict';

const { HttpsError } = require('firebase-functions/v2/https');
const { Timestamp } = require('firebase-admin/firestore');
const { userRecordDenies, PRODUCT_ACCESS_DENIED } = require('./productAccess');
const { checkRateLimit } = require('./rateLimiter');
const { pingHoldsActiveClaim } = require('./activeIncomingClaimLogic');
const { CLEAR_FIELDS, REASONS } = require('./cancelClaim');
const {
  isClaimGenerationId,
  hasLeftoverGenerationId,
  mintClaimGenerationId,
} = require('./claimGeneration');

// One durable document per logical acquisition attempt. The id is a
// client-generated UUID. It is not a claimGenerationId and it does not
// authorize cancellation. prepared is the only state that may mint. Terminal
// documents are never deleted: deletion would reopen the attempt id. Expiry
// writes state expired; it does not remove the document. Admin SDK writes
// this collection and claimIntentCounters. Deployed rules have no match for
// either, so clients cannot read or write them. This module does not change
// those rules.
//
// Lifetime storage grows with every attempt and tombstone. There is no TTL
// deletion. A later capacity control must reject new prepares without
// reopening history. The simultaneous prepared cap below is only a concurrency
// bound, evaluated locally, not a production retention policy.
const ATTEMPT_COLLECTION = 'claimSpotAttempts';
const COUNTER_COLLECTION = 'claimIntentCounters';
const ATTEMPT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const STORED_OUTCOMES = new Set([
  'claimed',
  'already_held',
  'unavailable',
  'already_claimed',
  'refused_stale_generation',
  'permission_denied',
  'revoked',
  'expired',
  'stale_precondition',
]);
const RATE_LIMIT = Object.freeze({ limit: 10, windowSec: 600 });
const INTENT_TTL_MS = 60 * 1000;
const MAX_PREPARED = 3;
const BUSY = 'Too many requests. Try again later.';
const SPOT_ID_MAX = 200;
const FAILURE = 'Claim could not be completed.';
const INVALID = 'Invalid claim request.';
const MAX_ETA_MINUTES = 7;
const MAX_CLAIM_MINUTES = 15;

const TITLE_THRESHOLDS = [
  { crowns: 0, title: 'Newcomer' },
  { crowns: 10, title: 'Trusted Driver' },
  { crowns: 50, title: 'Street Scout' },
  { crowns: 150, title: 'Neighborhood Guide' },
  { crowns: 400, title: 'Parking Expert' },
  { crowns: 750, title: 'Block Captain' },
  { crowns: 1500, title: 'Parking Veteran' },
  { crowns: 3000, title: 'Urban Legend' },
];

function getTitleForCrowns(crowns) {
  const value = Number.isFinite(crowns) && crowns > 0 ? crowns : 0;
  for (let i = TITLE_THRESHOLDS.length - 1; i >= 0; i -= 1) {
    if (value >= TITLE_THRESHOLDS[i].crowns) return TITLE_THRESHOLDS[i].title;
  }
  return 'Newcomer';
}

function textOrNull(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function displayName(user) {
  return textOrNull(user && user.username, 80)
    || textOrNull(user && user.fullName, 80)
    || 'Someone';
}

function millisOf(value) {
  if (!value || typeof value.toMillis !== 'function') return null;
  try {
    const ms = value.toMillis();
    return Number.isSafeInteger(ms) ? ms : null;
  } catch {
    return null;
  }
}

function timestampFromMillis(ms) {
  if (!Number.isSafeInteger(ms)) return null;
  return Timestamp.fromMillis(ms);
}

function errorCode(error) {
  return error && error.code;
}

function isRetryable(error) {
  const code = errorCode(error);
  return code === 4 || code === 10 || code === 14
    || code === 'deadline-exceeded' || code === 'aborted' || code === 'unavailable';
}

function parseInput(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new HttpsError('invalid-argument', INVALID);
  }
  const keys = Object.keys(data);
  const mode = data.mode;
  const allowed = mode === 'scheduled'
    ? ['spotId', 'attemptId', 'mode']
    : ['spotId', 'attemptId', 'mode', 'etaMinutes'];
  if (mode !== 'immediate' && mode !== 'scheduled') {
    throw new HttpsError('invalid-argument', INVALID);
  }
  if (keys.length !== allowed.length || keys.some((key) => !allowed.includes(key))) {
    throw new HttpsError('invalid-argument', INVALID);
  }
  const { spotId, attemptId } = data;
  if (typeof spotId !== 'string' || spotId.length < 1 || spotId.length > SPOT_ID_MAX) {
    throw new HttpsError('invalid-argument', INVALID);
  }
  if (spotId.includes('/') || spotId === '.' || spotId === '..') {
    throw new HttpsError('invalid-argument', INVALID);
  }
  if (typeof attemptId !== 'string' || !ATTEMPT_ID_RE.test(attemptId)) {
    throw new HttpsError('invalid-argument', INVALID);
  }
  let etaMinutes = null;
  if (mode === 'immediate') {
    etaMinutes = data.etaMinutes;
    if (!Number.isInteger(etaMinutes) || etaMinutes < 1 || etaMinutes > MAX_ETA_MINUTES) {
      throw new HttpsError('invalid-argument', INVALID);
    }
  }
  return { spotId, attemptId, mode, etaMinutes };
}

function publicResult(record) {
  return {
    outcome: record.outcome,
    claimGenerationId: isClaimGenerationId(record.claimGenerationId) ? record.claimGenerationId : null,
    spotId: record.spotId,
    mode: record.mode,
  };
}

function storedResult(record, uid) {
  if (!record || record.uid !== uid) {
    throw new HttpsError('permission-denied', FAILURE);
  }
  if (!STORED_OUTCOMES.has(record.outcome) || typeof record.spotId !== 'string' || (record.mode !== 'immediate' && record.mode !== 'scheduled')) {
    throw new HttpsError('internal', FAILURE);
  }
  if (record.outcome === 'permission_denied') return { denied: true };
  if (record.outcome === 'claimed' && !isClaimGenerationId(record.claimGenerationId)) {
    throw new HttpsError('internal', FAILURE);
  }
  if (record.claimGenerationId != null && !isClaimGenerationId(record.claimGenerationId)) {
    throw new HttpsError('internal', FAILURE);
  }
  if (record.outcome !== 'claimed' && record.outcome !== 'already_held' && record.claimGenerationId != null) {
    throw new HttpsError('internal', FAILURE);
  }
  // A released intent keeps its original outcome and generation id in the
  // document. Callers must not see that history as a live acquisition.
  // Lost-response replay stays on state claimed, which is unchanged here.
  if (record.state === 'released') {
    return publicResult({
      ...record,
      outcome: 'released',
      claimGenerationId: null,
    });
  }
  return publicResult(record);
}

function holdsLiveClaim(spot, uid) {
  return !!spot && spot.status === 'interested' && spot.interestedUserId === uid;
}

function spotIsClaimable(spot, uid) {
  if (!spot || spot.status !== 'available') return false;
  if (spot.interestedUserId != null) return false;
  if (spot.finderId === uid) return false;
  return true;
}

function scheduledTimes(spot, nowMs) {
  const departureMs = millisOf(spot && spot.reportedAt);
  const reminderMs = departureMs == null ? null : departureMs - (20 * 60 * 1000);
  const releaseMs = departureMs == null ? null : departureMs + (10 * 60 * 1000);
  const expires = millisOf(spot && spot.expiresAt);
  return {
    interestExpiresAt: expires == null ? null : timestampFromMillis(expires),
    claimReminderAt: reminderMs != null && reminderMs > nowMs ? timestampFromMillis(reminderMs) : null,
    claimAutoReleaseAt: timestampFromMillis(releaseMs),
  };
}

function claimPatch(input, spot, user, generationId, started) {
  const nowMs = millisOf(started);
  if (nowMs == null) throw new HttpsError('internal', FAILURE);
  const claimState = input.mode === 'scheduled' ? 'committed' : 'heading';
  const scheduled = input.mode === 'scheduled'
    ? scheduledTimes(spot, nowMs)
    : {
      interestExpiresAt: timestampFromMillis(nowMs + (Math.min(input.etaMinutes + 5, MAX_CLAIM_MINUTES) * 60000)),
      claimReminderAt: null,
      claimAutoReleaseAt: null,
    };
  return {
    status: 'interested',
    claimState,
    ownerLeavingNow: null,
    ownerLeavingNowAt: null,
    interestedUserId: user.uid,
    interestedUserName: displayName(user.profile),
    interestedUserVehicleColor: textOrNull(user.profile && user.profile.vehicleColor, 40),
    interestedUserVehicleType: textOrNull(user.profile && user.profile.vehicleType, 40),
    interestedUserVehicleBrand: textOrNull(user.profile && user.profile.vehicleBrand, 40),
    interestedUserTitle: getTitleForCrowns(user.profile && user.profile.crowns),
    claimStartedAt: started,
    claimGenerationId: generationId,
    etaMinutes: input.mode === 'immediate' ? input.etaMinutes : null,
    interestExpiresAt: scheduled.interestExpiresAt,
    claimReminderAt: scheduled.claimReminderAt,
    claimReminderSentAt: null,
    claimAutoReleaseAt: scheduled.claimAutoReleaseAt,
    claimAutoReleasedAt: null,
  };
}

function attemptRecord(input, uid, state, claimGenerationId, createdAt, extra = {}) {
  return {
    uid,
    spotId: input.spotId,
    mode: input.mode,
    etaMinutes: input.etaMinutes == null ? null : input.etaMinutes,
    state,
    outcome: extra.outcome || state,
    claimGenerationId: claimGenerationId || null,
    createdAt,
    expiresAt: extra.expiresAt || null,
    spotUpdateTime: extra.spotUpdateTime || null,
  };
}

function sameAttempt(record, input) {
  const storedEta = record && record.etaMinutes == null ? null : record.etaMinutes;
  const requestEta = input.etaMinutes == null ? null : input.etaMinutes;
  return !!record
    && record.spotId === input.spotId
    && record.mode === input.mode
    && storedEta === requestEta;
}

function intentExpired(record, nowTs) {
  const expires = millisOf(record && record.expiresAt);
  const nowMs = millisOf(nowTs);
  if (expires == null || nowMs == null) return true;
  return nowMs >= expires;
}

function sameTime(left, right) {
  const a = millisOf(left);
  const b = millisOf(right);
  return a != null && a === b;
}

function preparedIdsOf(snap) {
  if (!snap.exists) return [];
  const ids = snap.data() && snap.data().preparedIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id) => typeof id === 'string' && id.length > 0);
}

function withoutId(ids, attemptId) {
  return ids.filter((id) => id !== attemptId);
}

function prepareView(record, input) {
  return {
    state: record.state,
    attemptId: input.attemptId,
    spotId: record.spotId,
    mode: record.mode,
    expiresAt: millisOf(record.expiresAt),
  };
}

function revokeView(outcome, input) {
  return {
    outcome,
    attemptId: input.attemptId,
    spotId: input.spotId,
    mode: input.mode,
  };
}

function requireUid(request) {
  const uid = request && request.auth ? request.auth.uid : undefined;
  if (typeof uid !== 'string' || uid.length === 0) {
    throw new HttpsError('unauthenticated', 'Authentication is required.');
  }
  return uid;
}

function openDeps(deps) {
  if (deps.afterReads && deps.allowTestHooks !== true) {
    throw new HttpsError('internal', FAILURE);
  }
  return {
    db: deps.db || require('firebase-admin/firestore').getFirestore(),
    limit: deps.checkRateLimit || checkRateLimit,
    now: deps.now || (() => Timestamp.now()),
    randomBytes: deps.randomBytes || ((size) => require('crypto').randomBytes(size)),
    afterReads: deps.allowTestHooks === true && typeof deps.afterReads === 'function' ? deps.afterReads : null,
  };
}

async function rejectIdentity(limit, uid, record, input) {
  if (!record || record.uid !== uid) {
    await limit(uid, 'claimIntentMismatch', RATE_LIMIT);
    throw new HttpsError('permission-denied', FAILURE);
  }
  if (!sameAttempt(record, input)) {
    await limit(uid, 'claimIntentMismatch', RATE_LIMIT);
    throw new HttpsError('invalid-argument', INVALID);
  }
}

function finishHttps(error) {
  if (error instanceof HttpsError) throw error;
  if (isRetryable(error)) throw new HttpsError('unavailable', FAILURE);
  if (errorCode(error) === 7 || errorCode(error) === 'permission-denied') {
    throw new HttpsError('permission-denied', FAILURE);
  }
  if (errorCode(error) === 6 || errorCode(error) === 'already-exists') {
    throw new HttpsError('failed-precondition', FAILURE);
  }
  throw new HttpsError('internal', FAILURE);
}

function throwIfDenied(result) {
  if (result && result.denied) {
    throw new HttpsError('permission-denied', PRODUCT_ACCESS_DENIED);
  }
  return result;
}

function dropPrepared(tx, counterRef, uid, ids, attemptId) {
  tx.set(counterRef, { uid, preparedIds: withoutId(ids, attemptId) });
}

async function prepareClaimIntent(request, deps = {}) {
  const uid = requireUid(request);
  const input = parseInput(request.data);
  const { db, limit, now } = openDeps(deps);
  const attemptRef = db.collection(ATTEMPT_COLLECTION).doc(input.attemptId);
  const existing = await attemptRef.get();
  if (!existing.exists) await limit(uid, 'claimIntentPrepare', RATE_LIMIT);
  else await rejectIdentity(limit, uid, existing.data() || {}, input);

  let result;
  try {
    result = await db.runTransaction(async (tx) => {
      const counterRef = db.collection(COUNTER_COLLECTION).doc(uid);
      const userRef = db.collection('users').doc(uid);
      const spotRef = db.collection('spots').doc(input.spotId);
      const attemptSnap = await tx.get(attemptRef);
      const counterSnap = await tx.get(counterRef);
      const siblingIds = preparedIdsOf(counterSnap).filter((id) => id !== input.attemptId);
      const siblingRefs = siblingIds.map((id) => db.collection(ATTEMPT_COLLECTION).doc(id));
      const siblingSnaps = [];
      for (const siblingRef of siblingRefs) siblingSnaps.push(await tx.get(siblingRef));
      const userSnap = await tx.get(userRef);
      const spotSnap = await tx.get(spotRef);
      const createdAt = now();
      const nowMs = millisOf(createdAt);
      if (nowMs == null) throw new HttpsError('internal', FAILURE);

      const liveIds = [];
      for (let i = 0; i < siblingSnaps.length; i += 1) {
        const sibling = siblingSnaps[i];
        if (!sibling.exists) continue;
        const record = sibling.data() || {};
        if (record.uid !== uid || record.state !== 'prepared') continue;
        if (intentExpired(record, createdAt)) {
          tx.update(siblingRefs[i], { state: 'expired', outcome: 'expired' });
        } else {
          liveIds.push(siblingIds[i]);
        }
      }

      if (attemptSnap.exists) {
        const record = attemptSnap.data() || {};
        if (record.uid !== uid) throw new HttpsError('permission-denied', FAILURE);
        if (!sameAttempt(record, input)) throw new HttpsError('invalid-argument', INVALID);
        if (record.state === 'prepared' && intentExpired(record, createdAt)) {
          tx.update(attemptRef, { state: 'expired', outcome: 'expired' });
          tx.set(counterRef, { uid, preparedIds: liveIds });
          return prepareView({ ...record, state: 'expired', expiresAt: record.expiresAt }, input);
        }
        if (record.state === 'prepared') {
          tx.set(counterRef, { uid, preparedIds: liveIds.concat(input.attemptId) });
        } else if (liveIds.length !== siblingIds.length) {
          tx.set(counterRef, { uid, preparedIds: liveIds });
        }
        if (record.outcome === 'permission_denied' || record.state === 'permission_denied') return { denied: true };
        return prepareView(record, input);
      }

      if (liveIds.length >= MAX_PREPARED) throw new HttpsError('resource-exhausted', BUSY);
      const profile = userSnap.exists ? (userSnap.data() || {}) : null;
      const spot = spotSnap.exists ? (spotSnap.data() || {}) : null;
      if (userSnap.exists && userRecordDenies(profile)) {
        tx.set(attemptRef, attemptRecord(input, uid, 'permission_denied', null, createdAt));
        tx.set(counterRef, { uid, preparedIds: liveIds });
        return { denied: true };
      }
      if (!spotSnap.exists || !spot) {
        const record = attemptRecord(input, uid, 'unavailable', null, createdAt);
        tx.set(attemptRef, record);
        tx.set(counterRef, { uid, preparedIds: liveIds });
        return prepareView(record, input);
      }
      if (holdsLiveClaim(spot, uid)) {
        const record = attemptRecord(input, uid, 'already_held', null, createdAt);
        tx.set(attemptRef, record);
        tx.set(counterRef, { uid, preparedIds: liveIds });
        return prepareView(record, input);
      }
      if (!spotIsClaimable(spot, uid)) {
        const record = attemptRecord(input, uid, 'unavailable', null, createdAt);
        tx.set(attemptRef, record);
        tx.set(counterRef, { uid, preparedIds: liveIds });
        return prepareView(record, input);
      }
      if (millisOf(spotSnap.updateTime) == null) throw new HttpsError('internal', FAILURE);
      const expiresAt = Timestamp.fromMillis(nowMs + INTENT_TTL_MS);
      const record = attemptRecord(input, uid, 'prepared', null, createdAt, {
        expiresAt,
        spotUpdateTime: spotSnap.updateTime,
      });
      tx.set(attemptRef, record);
      tx.set(counterRef, { uid, preparedIds: liveIds.concat(input.attemptId) });
      return prepareView(record, input);
    });
  } catch (error) {
    finishHttps(error);
  }
  return throwIfDenied(result);
}

async function claimSpot(request, deps = {}) {
  const uid = requireUid(request);
  const input = parseInput(request.data);
  const { db, limit, now, randomBytes, afterReads } = openDeps(deps);
  const attemptRef = db.collection(ATTEMPT_COLLECTION).doc(input.attemptId);
  const existing = await attemptRef.get();
  if (!existing.exists) throw new HttpsError('failed-precondition', FAILURE);
  await rejectIdentity(limit, uid, existing.data() || {}, input);

  let result;
  let hookUsed = false;
  try {
    result = await db.runTransaction(async (tx) => {
      const counterRef = db.collection(COUNTER_COLLECTION).doc(uid);
      const userRef = db.collection('users').doc(uid);
      const spotRef = db.collection('spots').doc(input.spotId);
      const lockRef = userRef.collection('activeIncomingClaims').doc('current');
      const attemptSnap = await tx.get(attemptRef);
      const counterSnap = await tx.get(counterRef);
      const userSnap = await tx.get(userRef);
      const spotSnap = await tx.get(spotRef);
      const lockSnap = await tx.get(lockRef);
      const lock = lockSnap.exists ? (lockSnap.data() || {}) : null;
      let otherSpot = null;
      if (lock && typeof lock.spotId === 'string' && lock.spotId !== input.spotId
        && lock.spotId.length > 0 && !lock.spotId.includes('/') && lock.spotId !== '.' && lock.spotId !== '..') {
        const otherSnap = await tx.get(db.collection('spots').doc(lock.spotId));
        otherSpot = otherSnap.exists ? (otherSnap.data() || {}) : null;
      }
      if (afterReads && !hookUsed) {
        hookUsed = true;
        await afterReads();
      }
      if (!attemptSnap.exists) throw new HttpsError('failed-precondition', FAILURE);
      const record = attemptSnap.data() || {};
      if (record.uid !== uid) throw new HttpsError('permission-denied', FAILURE);
      if (!sameAttempt(record, input)) throw new HttpsError('invalid-argument', INVALID);
      if (record.state !== 'prepared') return storedResult(record, uid);

      const createdAt = now();
      const nowMs = millisOf(createdAt);
      if (nowMs == null) throw new HttpsError('internal', FAILURE);
      const preparedIds = preparedIdsOf(counterSnap);
      if (intentExpired(record, createdAt)) {
        tx.update(attemptRef, { state: 'expired', outcome: 'expired' });
        dropPrepared(tx, counterRef, uid, preparedIds, input.attemptId);
        return publicResult({ ...record, outcome: 'expired', claimGenerationId: null });
      }
      const profile = userSnap.exists ? (userSnap.data() || {}) : null;
      if (userSnap.exists && userRecordDenies(profile)) {
        tx.update(attemptRef, { state: 'permission_denied', outcome: 'permission_denied', claimGenerationId: null });
        dropPrepared(tx, counterRef, uid, preparedIds, input.attemptId);
        return { denied: true };
      }
      const spot = spotSnap.exists ? (spotSnap.data() || {}) : null;
      if (!spot || !sameTime(record.spotUpdateTime, spotSnap.updateTime)) {
        tx.update(attemptRef, { state: 'stale_precondition', outcome: 'stale_precondition', claimGenerationId: null });
        dropPrepared(tx, counterRef, uid, preparedIds, input.attemptId);
        return publicResult({ ...record, outcome: 'stale_precondition', claimGenerationId: null });
      }

      let outcome;
      let generationId = null;
      if (holdsLiveClaim(spot, uid)) {
        outcome = 'already_held';
        generationId = null;
      } else if (!spotIsClaimable(spot, uid)) outcome = 'unavailable';
      else if (hasLeftoverGenerationId(spot.claimGenerationId)) outcome = 'refused_stale_generation';
      else if (otherSpot && pingHoldsActiveClaim(otherSpot, uid)) outcome = 'already_claimed';
      else {
        outcome = 'claimed';
        generationId = mintClaimGenerationId(randomBytes);
        const patch = claimPatch(input, spot, { uid, profile }, generationId, createdAt);
        tx.update(spotRef, patch);
        tx.set(lockRef, {
          spotId: input.spotId,
          claimStartedAt: createdAt,
          claimState: patch.claimState,
          updatedAt: createdAt,
          claimGenerationId: generationId,
        });
      }
      tx.update(attemptRef, {
        state: outcome,
        outcome,
        claimGenerationId: generationId,
      });
      dropPrepared(tx, counterRef, uid, preparedIds, input.attemptId);
      return publicResult({
        outcome,
        claimGenerationId: generationId,
        spotId: input.spotId,
        mode: input.mode,
      });
    });
  } catch (error) {
    finishHttps(error);
  }
  return throwIfDenied(result);
}

function spotStillThisGeneration(spot, uid, generationId) {
  return holdsLiveClaim(spot, uid) && spot.claimGenerationId === generationId && isClaimGenerationId(generationId);
}

async function revokeClaimIntent(request, deps = {}) {
  const uid = requireUid(request);
  const input = parseInput(request.data);
  const { db, limit, now, afterReads } = openDeps(deps);
  const attemptRef = db.collection(ATTEMPT_COLLECTION).doc(input.attemptId);
  const existing = await attemptRef.get();
  if (!existing.exists) await limit(uid, 'claimIntentRevoke', RATE_LIMIT);
  else await rejectIdentity(limit, uid, existing.data() || {}, input);

  let result;
  let hookUsed = false;
  try {
    result = await db.runTransaction(async (tx) => {
      const counterRef = db.collection(COUNTER_COLLECTION).doc(uid);
      const userRef = db.collection('users').doc(uid);
      const spotRef = db.collection('spots').doc(input.spotId);
      const lockRef = userRef.collection('activeIncomingClaims').doc('current');
      const attemptSnap = await tx.get(attemptRef);
      const counterSnap = await tx.get(counterRef);
      const createdAt = now();
      const nowMs = millisOf(createdAt);
      if (nowMs == null) throw new HttpsError('internal', FAILURE);
      const preparedIds = preparedIdsOf(counterSnap);
      const preread = attemptSnap.exists ? (attemptSnap.data() || {}) : null;
      if (afterReads && !hookUsed && (!preread || preread.state === 'prepared')) {
        hookUsed = true;
        await afterReads();
      }

      if (!attemptSnap.exists) {
        const record = attemptRecord(input, uid, 'revoked', null, createdAt);
        tx.set(attemptRef, record);
        return revokeView('revoked', input);
      }
      const record = attemptSnap.data() || {};
      if (record.uid !== uid) throw new HttpsError('permission-denied', FAILURE);
      if (!sameAttempt(record, input)) throw new HttpsError('invalid-argument', INVALID);
      if (record.state === 'prepared') {
        tx.update(attemptRef, { state: 'revoked', outcome: 'revoked', claimGenerationId: null });
        dropPrepared(tx, counterRef, uid, preparedIds, input.attemptId);
        return revokeView('revoked', input);
      }
      if (record.state === 'released') return revokeView('released', input);
      if (record.state !== 'claimed') return revokeView(record.state || record.outcome, input);

      const generationId = record.claimGenerationId;
      const spotSnap = await tx.get(spotRef);
      const lockSnap = await tx.get(lockRef);
      const notifRef = db.collection('spotNotifications').doc(`claimer_cancelled_${input.spotId}_${generationId}`);
      const notifSnap = await tx.get(notifRef);
      if (afterReads && !hookUsed) {
        hookUsed = true;
        await afterReads();
      }
      const spot = spotSnap.exists ? (spotSnap.data() || {}) : null;
      if (!spot || !spotStillThisGeneration(spot, uid, generationId)) {
        const liveOther = spot && holdsLiveClaim(spot, spot.interestedUserId) && isClaimGenerationId(spot.claimGenerationId);
        return revokeView(liveOther ? 'generation_unchanged' : 'already_resolved', input);
      }
      const patch = { ...CLEAR_FIELDS };
      if (!(millisOf(spot.expiresAt) != null && millisOf(spot.expiresAt) <= nowMs)) patch.status = 'available';
      tx.update(spotRef, patch);
      if (lockSnap.exists && lockSnap.data() && lockSnap.data().spotId === input.spotId) tx.delete(lockRef);
      if (!notifSnap.exists && typeof spot.finderId === 'string' && spot.finderId && spot.finderId !== uid) {
        tx.create(notifRef, {
          spotId: input.spotId,
          senderId: uid,
          targetUserId: spot.finderId,
          type: 'claimer_cancelled',
          message: REASONS.unspecified,
          createdAt,
        });
      }
      tx.update(attemptRef, { state: 'released' });
      return revokeView('released', input);
    });
  } catch (error) {
    finishHttps(error);
  }
  return result;
}

module.exports = {
  claimSpot,
  prepareClaimIntent,
  revokeClaimIntent,
  ATTEMPT_COLLECTION,
  COUNTER_COLLECTION,
  ATTEMPT_ID_RE,
  INTENT_TTL_MS,
  MAX_PREPARED,
};
