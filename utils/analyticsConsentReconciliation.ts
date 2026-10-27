import { doc, getDocFromServer, setDoc } from 'firebase/firestore';
import { auth, db } from '../firebase';
import {
  confirmAnalyticsOptOutReconciled,
  getAnalyticsConsentDisplayState,
  hasPendingAnalyticsOptOut,
  revokeAnalyticsConsentImmediately,
} from './analyticsConsentSession';

/**
 * A durable OFF intent lives in localStorage, not in Firestore's offline cache.
 * This coordinator never waits for an unfinished ON promise before submitting
 * OFF. It only CLEARS the local veto after the OFF write, any older ON writes,
 * and a fresh server read all confirm the denied value.
 *
 * Firestore itself may buffer writes while disconnected. An offline app cannot
 * revoke data already sent or change another online device immediately.
 */
const inFlightOn = new Map<string, Set<Promise<void>>>();
const inFlightOff = new Map<string, Promise<void>>();
const lastAutomaticFailure = new Map<string, number>();
const AUTO_RETRY_COOLDOWN_MS = 10_000;

function signedInAs(userId: string): boolean {
  return !!userId && auth?.currentUser?.uid === userId &&
    getAnalyticsConsentDisplayState(userId) !== 'unavailable';
}

function preferenceRef(userId: string) {
  return doc(db, 'users', userId, 'private', 'preferences');
}

function submitPreference(userId: string, value: boolean): Promise<void> {
  return setDoc(preferenceRef(userId), { analyticsConsent: value }, { merge: true });
}

/**
 * Reconcile an opt-out saved before a reload or rejected Firestore write.
 * Concurrent triggers reuse one attempt. A foreground/manual attempt bypasses
 * the automatic failure cooldown, but cannot bypass account validation.
 */
export function reconcilePendingAnalyticsOptOut(
  userId: string | null,
  manual = false,
): Promise<void> {
  if (!userId || !signedInAs(userId) || !hasPendingAnalyticsOptOut(userId)) {
    return Promise.resolve();
  }

  const existing = inFlightOff.get(userId);
  if (existing) return existing;

  if (!manual && Date.now() - (lastAutomaticFailure.get(userId) ?? -Infinity) < AUTO_RETRY_COOLDOWN_MS) {
    return Promise.resolve();
  }

  // Capture every ON request that had already started. A delayed ON completion
  // must not be allowed to leave the server ON after the latest user intent OFF.
  const olderOnWrites = [...(inFlightOn.get(userId) ?? [])];
  const operation = (async () => {
    // First OFF goes to Firestore immediately, even while an ON promise hangs.
    await submitPreference(userId, false);

    if (olderOnWrites.length) {
      // If an earlier ON settles later, reassert OFF after it settles.
      // Staying locally OFF throughout is the privacy-preserving tradeoff.
      await Promise.allSettled(olderOnWrites);
      if (!signedInAs(userId) || !hasPendingAnalyticsOptOut(userId)) return;
      await submitPreference(userId, false);
    }

    if (!signedInAs(userId) || !hasPendingAnalyticsOptOut(userId)) return;

    // A cached/offline snapshot (or an earlier confirmed OFF snapshot) cannot
    // discharge this obligation. Read the authoritative server value.
    const server = await getDocFromServer(preferenceRef(userId));
    if (!server.exists() || server.data()?.analyticsConsent !== false) {
      throw new Error('Analytics withdrawal is not confirmed by Firestore.');
    }
    if (!signedInAs(userId) || !hasPendingAnalyticsOptOut(userId)) return;
    confirmAnalyticsOptOutReconciled(userId);
    lastAutomaticFailure.delete(userId);
  })();

  inFlightOff.set(userId, operation);
  // Explicit handlers for both outcomes prevent detached UI/background callers
  // from generating unhandled rejections.
  void operation.then(
    () => { if (inFlightOff.get(userId) === operation) inFlightOff.delete(userId); },
    () => {
      if (inFlightOff.get(userId) === operation) inFlightOff.delete(userId);
      lastAutomaticFailure.set(userId, Date.now());
    },
  );
  return operation;
}

/** Only invoked by the Settings UI for a currently authenticated user. */
export function requestAnalyticsConsentChange(userId: string, enabled: boolean): Promise<void> {
  if (!signedInAs(userId)) {
    return Promise.reject(new Error('Analytics consent account is unavailable.'));
  }

  if (!enabled) {
    // Synchronously preserve the OFF intent and block captures before any I/O.
    revokeAnalyticsConsentImmediately();
    return reconcilePendingAnalyticsOptOut(userId, true);
  }

  if (hasPendingAnalyticsOptOut(userId)) {
    return Promise.reject(new Error('Complete pending analytics withdrawal before opting in.'));
  }

  let request: Promise<void>;
  try {
    request = submitPreference(userId, true);
  } catch (error) {
    return Promise.reject(error);
  }
  let pending = inFlightOn.get(userId);
  if (!pending) {
    pending = new Set();
    inFlightOn.set(userId, pending);
  }
  pending.add(request);
  void request.then(
    () => {
      pending.delete(request);
      if (!pending.size) inFlightOn.delete(userId);
      // An ON finishing after OFF must prompt another reconciliation attempt.
      if (hasPendingAnalyticsOptOut(userId) && signedInAs(userId)) {
        void reconcilePendingAnalyticsOptOut(userId, true).catch(() => {});
      }
    },
    () => {
      pending.delete(request);
      if (!pending.size) inFlightOn.delete(userId);
    },
  );
  return request;
}

/** Start once from App's auth lifecycle; return an exact cleanup callback. */
export function observePendingAnalyticsOptOut(): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  const retry = () => {
    const uid = auth?.currentUser?.uid;
    if (uid) void reconcilePendingAnalyticsOptOut(uid).catch(() => {});
  };
  const onVisible = () => { if (document.visibilityState === 'visible') retry(); };
  window.addEventListener('online', retry);
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    window.removeEventListener('online', retry);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
