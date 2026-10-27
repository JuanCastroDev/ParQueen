import {
  NO_ANALYTICS_CONSENT,
  canCollectAnalytics,
  consentFromPreferences,
  type AnalyticsConsentState,
} from './analyticsConsent';

let activeUserId: string | null = null;
let consent: AnalyticsConsentState = NO_ANALYTICS_CONSENT;
// Retains only the last authoritative ON state during this account session.
// This is UI-only history, never permission to collect from cached data.
let lastServerConfirmedOnUserId: string | null = null;

// Local-only safety marker. Never sent to an analytics provider.
const PENDING_OPT_OUT_PREFIX = 'parqueen_analytics_pending_optout_v1_';

// Protects the current running app even if browser storage refuses writes.
const volatilePendingOptOuts = new Set<string>();

function pendingOptOutKey(userId: string): string {
  return `${PENDING_OPT_OUT_PREFIX}${userId}`;
}

function optOutPendingOrStorageUnavailable(userId: string): boolean {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return true;
    if (storage.getItem(pendingOptOutKey(userId)) !== null) return true;
    // Readable-but-unwritable storage cannot preserve an OFF choice across a
    // reload. Fail closed until durable local veto storage is available.
    const probe = 'parqueen_analytics_storage_probe_v1';
    storage.setItem(probe, 'ok');
    const writable = storage.getItem(probe) === 'ok';
    storage.removeItem(probe);
    return !writable;
  } catch {
    // No reliable persistence means we cannot safely grant analytics.
    return true;
  }
}

function clearConfirmedOptOut(userId: string): void {
  try {
    const storage = globalThis.localStorage;
    if (!storage) return;

    storage.removeItem(pendingOptOutKey(userId));
    volatilePendingOptOuts.delete(userId);
  } catch {
    // Keep collection disabled while persistence is unavailable.
  }
}

export function beginAnalyticsConsentSession(userId: string | null): void {
  activeUserId = userId || null;
  consent = NO_ANALYTICS_CONSENT;
  lastServerConfirmedOnUserId = null;
  notifyAnalyticsConsentChanged();
}

export function receiveAnalyticsConsentSnapshot(
  userId: string,
  preferences: unknown,
  metadata: { fromCache: boolean; hasPendingWrites: boolean },
): void {
  if (!activeUserId || activeUserId !== userId) return;

  // Never grant consent from cached or uncommitted preferences.
  if (metadata?.fromCache !== false || metadata?.hasPendingWrites !== false) {
    consent = NO_ANALYTICS_CONSENT;
    notifyAnalyticsConsentChanged();
    return;
  }

  consent = consentFromPreferences(userId, preferences);
  lastServerConfirmedOnUserId = canCollectAnalytics(consent, userId) ? userId : null;

  // Even a server-origin OFF snapshot may predate our most recent attempted
  // withdrawal. The local veto is cleared ONLY by an acknowledged OFF write
  // followed by an explicit fresh server read in the reconciliation module.
  notifyAnalyticsConsentChanged();
}

/**
 * A previously server-confirmed ON value may be displayed as OFF after the
 * Firestore listener moves to cache while disconnected. Remember that state
 * only to interpret an explicit Settings tap as OFF, not to collect telemetry.
 * Reset on account change, and after an authoritative server OFF snapshot.
 */
export function wasAnalyticsConsentLastServerConfirmedOn(userId: string | null): boolean {
  return !!userId && activeUserId === userId && lastServerConfirmedOnUserId === userId;
}

/** A persisted OFF intent for this account; never sent to PostHog. */
export function hasPendingAnalyticsOptOut(userId: string): boolean {
  if (volatilePendingOptOuts.has(userId)) return true;
  try {
    const storage = globalThis.localStorage;
    return !!storage && storage.getItem(pendingOptOutKey(userId)) !== null;
  } catch {
    // Unreadable storage blocks collection, but is not itself proof that the
    // user asked to turn analytics OFF. Do not mutate their server preference.
    return false;
  }
}

/** Called ONLY after an OFF write and fresh server verification. */
export function confirmAnalyticsOptOutReconciled(userId: string): void {
  if (activeUserId !== userId || !hasPendingAnalyticsOptOut(userId)) return;
  // Set the in-memory value to denied *before* removing the veto; otherwise an
  // older granted snapshot could briefly turn collection back on.
  consent = { userId, status: 'denied' };
  lastServerConfirmedOnUserId = null;
  clearConfirmedOptOut(userId);
  notifyAnalyticsConsentChanged();
}

export function revokeAnalyticsConsentImmediately(): void {
  consent = NO_ANALYTICS_CONSENT;

  if (!activeUserId) {
    notifyAnalyticsConsentChanged();
    return;
  }

  volatilePendingOptOuts.add(activeUserId);

  try {
    globalThis.localStorage?.setItem(
      pendingOptOutKey(activeUserId),
      '1',
    );
  } catch {
    // Permission remains revoked. Unavailable storage also blocks grants.
  }
  notifyAnalyticsConsentChanged();
}

export function invalidateAnalyticsConsent(): void {
  consent = NO_ANALYTICS_CONSENT;
  notifyAnalyticsConsentChanged();
}

export function isAnalyticsCollectionAllowed(): boolean {
  if (!activeUserId || optOutPendingOrStorageUnavailable(activeUserId) || volatilePendingOptOuts.has(activeUserId)) {
    return false;
  }
  return canCollectAnalytics(consent, activeUserId);
}
type ConsentListener = () => void;

const consentListeners = new Set<ConsentListener>();

function notifyAnalyticsConsentChanged(): void {
  consentListeners.forEach(listener => listener());
}

export function subscribeAnalyticsConsent(
  listener: ConsentListener,
): () => void {
  consentListeners.add(listener);
  return () => {
    consentListeners.delete(listener);
  };
}

export function getAnalyticsConsentDisplayState(
  userId: string | null,
): 'unavailable' | 'off' | 'on' | 'pending_off' {
  if (!userId || userId !== activeUserId) return 'unavailable';

  if (hasPendingAnalyticsOptOut(userId)) return 'pending_off';
  if (optOutPendingOrStorageUnavailable(userId)) return 'off';

  return canCollectAnalytics(consent, userId) ? 'on' : 'off';
}
