'use strict';

const { randomUUID } = require('crypto');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { reconcileAuthReplica } = require('./suspensionAccess');

// Dormant single-account recovery coordinator.
// It is not exported from functions/index.js and has no schedule, trigger,
// task, or callable entry point.
//
// One invocation inspects one explicit uid and may call reconcileAuthReplica
// once. There is no retry loop and no account scan.
//
// Attempt ceiling is 3 reconciliation passes per intent generation.
// Cooldown after a pass that was allowed to call the reconciler is 120s.
// Coordinator ownership lasts 90s. Those values do not cancel an Auth RPC
// that Identity Toolkit has already accepted.
//
// A record is never stable. matched means one observation agreed with the
// current intent. A previously accepted updateUser can still land later.
//
// If ownership expires while uncertain is true, a later invocation must not
// send another updateUser. The Auth mutation may already have been issued.
// That state is UNCERTAIN_STALE and requires an administrator.
//
// A repaired disable records REVOCATION_REQUIRED. This module does not call
// revokeRefreshTokens. Revocation after the reconciler returns can race a
// newer unsuspend, so it stays an explicit follow-up.

const ATTEMPT_CEILING = 3;
const COOLDOWN_MS = 120000;
const OWNERSHIP_MS = 90000;
const COLLECTION = 'authReplicaRecovery';

const ERROR_CATEGORIES = new Set([
  'none',
  'not-found',
  'unconfirmed',
  'rejected',
  'superseded',
  'lease-held',
  'deletion',
  'ineligible',
  'refused',
  'duplicate',
  'cooldown',
  'attempt-exhausted',
  'uncertain-stale',
  'revocation-required',
  'internal',
  'matched',
  'repaired',
]);

function db() {
  return getFirestore();
}

function recoveryRef(userId) {
  return db().doc(`${COLLECTION}/${userId}`);
}

function millis(value) {
  return value && typeof value.toMillis === 'function' ? value.toMillis() : 0;
}

function live(value, nowMs) {
  return millis(value) > nowMs;
}

function blankRecord(now) {
  return {
    generation: null,
    desiredDisabled: null,
    observedDisabled: null,
    outcome: 'refused',
    attempts: 0,
    lastAttemptAt: null,
    nextEligibleAt: null,
    authMutationIssued: false,
    uncertain: false,
    administratorRequired: false,
    revocationRequired: false,
    retractable: false,
    errorCategory: 'refused',
    updatedAt: now,
    ownerOperationId: null,
    ownershipExpiresAt: null,
    stable: false,
  };
}

function parseIntent(data) {
  if (!data || !Number.isInteger(data.generation) || typeof data.desiredDisabled !== 'boolean') return null;
  if (data.phase !== 'confirmed' && data.phase !== 'pending' && data.phase !== 'intent' && data.phase !== 'rpc-issued') {
    return null;
  }
  return data;
}

function denialAbsent(profile) {
  return !!profile && !Object.prototype.hasOwnProperty.call(profile, 'productAccessBlocked');
}

function enableEligible(intent, profile) {
  return !!intent
    && intent.desiredDisabled === false
    && intent.phase === 'confirmed'
    && !!profile
    && profile.status === 'Active'
    && denialAbsent(profile);
}

function categoryFor(outcome) {
  if (outcome === 'revocation-required') return 'revocation-required';
  if (outcome === 'uncertain-stale') return 'uncertain-stale';
  if (ERROR_CATEGORIES.has(outcome)) return outcome;
  return 'internal';
}

function finish(base, patch) {
  return {
    ...base,
    ...patch,
    stable: false,
    retractable: false,
    errorCategory: categoryFor(patch.outcome || base.outcome),
  };
}

function validTimestamp(value) {
  return value == null || millis(value) > 0 || value instanceof Timestamp || (value && typeof value.toMillis === 'function');
}

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function existingRecordTrusted(prior, exists) {
  if (!exists) return true;
  if (!prior || typeof prior !== 'object') return false;
  if (!Object.prototype.hasOwnProperty.call(prior, 'generation') || !safeCount(prior.generation)) return false;
  if (!Object.prototype.hasOwnProperty.call(prior, 'desiredDisabled') || typeof prior.desiredDisabled !== 'boolean') return false;
  if (!Object.prototype.hasOwnProperty.call(prior, 'attempts') || !safeCount(prior.attempts)) return false;
  if (!Object.prototype.hasOwnProperty.call(prior, 'uncertain') || typeof prior.uncertain !== 'boolean') return false;
  if (!Object.prototype.hasOwnProperty.call(prior, 'outcome') || typeof prior.outcome !== 'string' || prior.outcome.length === 0) return false;
  if (prior.administratorRequired != null && typeof prior.administratorRequired !== 'boolean') return false;
  if (prior.revocationRequired != null && typeof prior.revocationRequired !== 'boolean') return false;
  if (prior.authMutationIssued != null && typeof prior.authMutationIssued !== 'boolean') return false;
  if (prior.outcome != null && typeof prior.outcome !== 'string') return false;
  if (prior.ownerOperationId != null && (typeof prior.ownerOperationId !== 'string' || prior.ownerOperationId.length === 0)) return false;
  if (prior.ownershipExpiresAt != null && !validTimestamp(prior.ownershipExpiresAt)) return false;
  if (prior.stable != null && prior.stable !== false) return false;
  return true;
}

async function runAuthReplicaRecovery(userId) {
  const now = Timestamp.now();
  if (typeof userId !== 'string' || userId.length === 0 || userId.indexOf('/') !== -1) {
    return finish(blankRecord(now), { outcome: 'refused', errorCategory: 'refused' });
  }

  const operationId = randomUUID();
  const decision = await db().runTransaction(async (tx) => {
    const profileSnap = await tx.get(db().doc(`users/${userId}`));
    const intentSnap = await tx.get(db().doc(`users/${userId}/private/authIntent`));
    const lockSnap = await tx.get(db().doc(`users/${userId}/private/suspensionLock`));
    const lifeSnap = await tx.get(db().doc(`accountLifecycle/${userId}`));
    const jobSnap = await tx.get(db().doc(`accountDeletionJobs/${userId}`));
    const recoverySnap = await tx.get(recoveryRef(userId));
    const nowMs = Timestamp.now().toMillis();
    const stamp = Timestamp.fromMillis(nowMs);
    const prior = recoverySnap.exists ? (recoverySnap.data() || {}) : {};
    const attempts = Number.isInteger(prior.attempts) ? prior.attempts : 0;
    const intent = intentSnap.exists ? parseIntent(intentSnap.data() || {}) : null;
    const profile = profileSnap.exists ? (profileSnap.data() || {}) : null;
    const base = {
      ...blankRecord(stamp),
      ...prior,
      updatedAt: stamp,
      stable: false,
      ownerOperationId: null,
    };

    function stop(patch) {
      const next = finish(base, patch);
      tx.set(recoveryRef(userId), next);
      return { action: 'stop', record: next };
    }

    if (live(prior.ownershipExpiresAt, nowMs) && prior.ownerOperationId) {
      return {
        action: 'stop',
        record: {
          ...blankRecord(stamp),
          ...prior,
          outcome: 'duplicate',
          errorCategory: 'duplicate',
          stable: false,
          updatedAt: stamp,
        },
      };
    }
    if (!existingRecordTrusted(prior, recoverySnap.exists)) {
      return {
        action: 'stop',
        record: {
          ...prior,
          outcome: 'invalid-record',
          administratorRequired: true,
          stable: false,
          retractable: false,
          errorCategory: 'internal',
          persisted: false,
        },
      };
    }
    if ((prior.uncertain === true || prior.administratorRequired === true || prior.revocationRequired === true) && (!intent || intent.generation !== prior.generation || intent.desiredDisabled !== prior.desiredDisabled)) {
      return stop({
        outcome: 'superseded',
        generation: intent && Number.isInteger(intent.generation) ? intent.generation : prior.generation,
        desiredDisabled: intent && typeof intent.desiredDisabled === 'boolean' ? intent.desiredDisabled : prior.desiredDisabled,
        attempts,
        uncertain: prior.uncertain === true || prior.authMutationIssued === true,
        administratorRequired: true,
        revocationRequired: false,
        authMutationIssued: prior.authMutationIssued === true,
        errorCategory: 'superseded',
      });
    }
    if (prior.uncertain === true) {
      return stop({
        outcome: 'uncertain-stale',
        uncertain: true,
        administratorRequired: true,
        authMutationIssued: prior.authMutationIssued === true,
        revocationRequired: false,
        attempts,
        errorCategory: 'uncertain-stale',
      });
    }
    if (prior.revocationRequired === true && intent && intent.generation === prior.generation && intent.desiredDisabled === prior.desiredDisabled) {
      return stop({
        outcome: 'revocation-required',
        administratorRequired: true,
        revocationRequired: true,
        attempts,
        generation: prior.generation,
        desiredDisabled: prior.desiredDisabled,
        observedDisabled: typeof prior.observedDisabled === 'boolean' ? prior.observedDisabled : null,
        authMutationIssued: prior.authMutationIssued === true,
        uncertain: prior.uncertain === true,
      });
    }
    if (prior.administratorRequired === true && intent && intent.generation === prior.generation && intent.desiredDisabled === prior.desiredDisabled) {
      return stop({
        outcome: typeof prior.outcome === 'string' ? prior.outcome : 'refused',
        administratorRequired: true,
        revocationRequired: false,
        attempts,
        generation: prior.generation,
        desiredDisabled: prior.desiredDisabled,
        observedDisabled: typeof prior.observedDisabled === 'boolean' ? prior.observedDisabled : null,
        authMutationIssued: prior.authMutationIssued === true,
        uncertain: prior.uncertain === true,
      });
    }
    if (!profileSnap.exists || !intent) {
      return stop({ outcome: 'refused', attempts, errorCategory: 'refused' });
    }
    if (lifeSnap.exists || jobSnap.exists) {
      return stop({
        outcome: 'deletion',
        generation: intent.generation,
        desiredDisabled: intent.desiredDisabled,
        attempts,
        errorCategory: 'deletion',
      });
    }
    if (lockSnap.exists && live(lockSnap.data() && lockSnap.data().leaseExpiresAt, nowMs)) {
      return stop({
        outcome: 'lease-held',
        generation: intent.generation,
        desiredDisabled: intent.desiredDisabled,
        attempts,
        errorCategory: 'lease-held',
      });
    }
    if (intent.phase !== 'confirmed' || (intent.desiredDisabled === false && !enableEligible(intent, profile))) {
      return stop({
        outcome: 'ineligible',
        generation: intent.generation,
        desiredDisabled: intent.desiredDisabled,
        attempts,
        errorCategory: 'ineligible',
      });
    }
    const sameGeneration = prior.generation === intent.generation && prior.desiredDisabled === intent.desiredDisabled;
    const attemptCount = sameGeneration ? attempts : 0;
    if (sameGeneration && live(prior.nextEligibleAt, nowMs)) {
      return stop({
        outcome: 'cooldown',
        generation: intent.generation,
        desiredDisabled: intent.desiredDisabled,
        attempts: attemptCount,
        nextEligibleAt: prior.nextEligibleAt,
        errorCategory: 'cooldown',
      });
    }
    if (attemptCount >= ATTEMPT_CEILING) {
      return stop({
        outcome: 'attempt-exhausted',
        generation: intent.generation,
        desiredDisabled: intent.desiredDisabled,
        attempts: attemptCount,
        administratorRequired: true,
        errorCategory: 'attempt-exhausted',
      });
    }

    const owned = finish(base, {
      outcome: 'pending',
      generation: intent.generation,
      desiredDisabled: intent.desiredDisabled,
      attempts: attemptCount + 1,
      lastAttemptAt: stamp,
      nextEligibleAt: Timestamp.fromMillis(nowMs + COOLDOWN_MS),
      authMutationIssued: false,
      uncertain: true,
      administratorRequired: false,
      revocationRequired: false,
      errorCategory: 'none',
      ownerOperationId: operationId,
      ownershipExpiresAt: Timestamp.fromMillis(nowMs + OWNERSHIP_MS),
    });
    tx.set(recoveryRef(userId), owned);
    return { action: 'call', record: owned, generation: intent.generation, desiredDisabled: intent.desiredDisabled };
  });

  if (decision.action !== 'call') return decision.record;

  let observed = null;
  try {
    const user = await getAuth().getUser(userId);
    observed = user.disabled === true;
  } catch (err) {
    const missing = err && err.code === 'auth/user-not-found';
    return writeTerminal(userId, operationId, decision, {
      outcome: missing ? 'not-found' : 'unconfirmed',
      observedDisabled: null,
      authMutationIssued: false,
      uncertain: !missing,
      administratorRequired: !missing,
      errorCategory: missing ? 'not-found' : 'unconfirmed',
    });
  }

  if (observed === decision.desiredDisabled) {
    const disable = decision.desiredDisabled === true;
    return writeTerminal(userId, operationId, decision, {
      outcome: disable ? 'revocation-required' : 'matched',
      observedDisabled: observed,
      authMutationIssued: false,
      uncertain: false,
      administratorRequired: disable,
      revocationRequired: disable,
      errorCategory: disable ? 'revocation-required' : 'matched',
    });
  }

  let reconciled;
  try {
    reconciled = await reconcileAuthReplica(userId);
  } catch {
    return writeTerminal(userId, operationId, decision, {
      outcome: 'unconfirmed',
      observedDisabled: observed,
      authMutationIssued: true,
      uncertain: true,
      administratorRequired: true,
      errorCategory: 'internal',
    });
  }

  const issued = reconciled && reconciled.issued === true;
  const outcome = reconciled && typeof reconciled.outcome === 'string' ? reconciled.outcome : 'unconfirmed';
  const seen = reconciled && typeof reconciled.observedDisabled === 'boolean' ? reconciled.observedDisabled : observed;
  if (outcome === 'unconfirmed' || (issued && outcome !== 'repaired' && outcome !== 'matched')) {
    return writeTerminal(userId, operationId, decision, {
      outcome: outcome === 'superseded' ? 'superseded' : (outcome === 'rejected' ? 'rejected' : 'unconfirmed'),
      observedDisabled: seen,
      authMutationIssued: issued,
      uncertain: true,
      administratorRequired: true,
      errorCategory: categoryFor(outcome === 'rejected' || outcome === 'superseded' ? outcome : 'unconfirmed'),
    });
  }
  if (outcome === 'repaired' && decision.desiredDisabled === true) {
    return writeTerminal(userId, operationId, decision, {
      outcome: 'revocation-required',
      observedDisabled: true,
      authMutationIssued: true,
      uncertain: false,
      administratorRequired: true,
      revocationRequired: true,
      errorCategory: 'revocation-required',
    });
  }
  if (outcome === 'repaired' && decision.desiredDisabled === false) {
    return writeTerminal(userId, operationId, decision, {
      outcome: 'repaired',
      observedDisabled: false,
      authMutationIssued: true,
      uncertain: true,
      administratorRequired: true,
      revocationRequired: false,
      errorCategory: 'repaired',
    });
  }
  return writeTerminal(userId, operationId, decision, {
    outcome,
    observedDisabled: seen,
    authMutationIssued: issued,
    uncertain: issued === true,
    administratorRequired: issued === true || outcome === 'deletion' || outcome === 'not-found',
    errorCategory: categoryFor(outcome),
  });
}

async function writeTerminal(userId, operationId, decision, patch) {
  const now = Timestamp.now();
  const next = finish(decision.record, {
    ...patch,
    generation: decision.generation,
    desiredDisabled: decision.desiredDisabled,
    ownerOperationId: null,
    ownershipExpiresAt: null,
    updatedAt: now,
    stable: false,
  });
  let wrote = false;
  await db().runTransaction(async (tx) => {
    const snap = await tx.get(recoveryRef(userId));
    const intentSnap = await tx.get(db().doc(`users/${userId}/private/authIntent`));
    const lifeSnap = await tx.get(db().doc(`accountLifecycle/${userId}`));
    const jobSnap = await tx.get(db().doc(`accountDeletionJobs/${userId}`));
    if (!snap.exists) return;
    const current = snap.data() || {};
    const nowMs = Timestamp.now().toMillis();
    const intent = intentSnap.exists ? parseIntent(intentSnap.data() || {}) : null;
    const stillOwned = current.ownerOperationId === operationId
      && current.outcome === 'pending'
      && current.uncertain === true
      && current.generation === decision.generation
      && current.desiredDisabled === decision.desiredDisabled
      && Number.isInteger(current.attempts)
      && current.attempts >= 1
      && live(current.ownershipExpiresAt, nowMs)
      && !!intent
      && intent.generation === decision.generation
      && intent.desiredDisabled === decision.desiredDisabled;
    if (!stillOwned) return;
    const deletion = lifeSnap.exists || jobSnap.exists;
    const terminal = deletion
      ? finish(next, {
        outcome: 'deletion-overlap',
        uncertain: true,
        administratorRequired: true,
        authMutationIssued: patch.authMutationIssued === true,
        revocationRequired: false,
        errorCategory: 'deletion',
        updatedAt: now,
      })
      : next;
    tx.set(recoveryRef(userId), terminal);
    wrote = true;
  });
  const saved = await recoveryRef(userId).get();
  if (!wrote) {
    return {
      ...(saved.exists ? saved.data() : {}),
      outcome: 'stale-finalization',
      stable: false,
      retractable: false,
      persisted: false,
      uncertain: true,
      administratorRequired: true,
    };
  }
  return saved.exists ? { ...saved.data(), stable: false, retractable: false } : next;
}

module.exports = {
  ATTEMPT_CEILING,
  COOLDOWN_MS,
  OWNERSHIP_MS,
  COLLECTION,
  runAuthReplicaRecovery,
};
