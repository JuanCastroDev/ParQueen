import { AppView } from '../types';
import type { LocationAccess } from './locationAccess';
import { shouldShowPrimer } from './locationAccess';
import { isTimeoutError, withTimeout } from './withTimeout';

/**
 * Maximum overall authenticated-bootstrap window (token + profile + optional location).
 * Sequential stages share this single deadline via remaining time — they do not each reset it.
 */
export const AUTH_BOOTSTRAP_TIMEOUT_MS = 6_000;

/** Soft sub-cap for location reconciliation; still clipped to remaining overall deadline. */
export const AUTH_BOOTSTRAP_LOCATION_TIMEOUT_MS = 2_500;

export type ProfileBootstrapStatus = 'exists' | 'missing' | 'unavailable';

export type AuthenticatedConsumerBootstrapDecision = {
  view: AppView;
  /** When true, App should seed `{ id: uid }` if user state is still empty. */
  seedMinimalUser: boolean;
};

export type BootstrapDeadline = {
  readonly startedAt: number;
  readonly totalMs: number;
  /** Milliseconds left in the overall bootstrap window (never negative). */
  remainingMs: (now?: number) => number;
  isExpired: (now?: number) => boolean;
  /**
   * Budget for the next await: min(remaining, subCap ?? remaining).
   * Returns 0 when the overall deadline is exhausted.
   */
  budgetMs: (subCap?: number, now?: number) => number;
};

/**
 * Shared overall deadline for one authenticated bootstrap attempt.
 * Pass an injectable `clock` in tests (fake timers / fixed now).
 */
export function createBootstrapDeadline(
  totalMs: number = AUTH_BOOTSTRAP_TIMEOUT_MS,
  clock: () => number = () => Date.now(),
): BootstrapDeadline {
  const startedAt = clock();
  const remainingMs = (now = clock()) => Math.max(0, totalMs - (now - startedAt));
  const isExpired = (now = clock()) => remainingMs(now) <= 0;
  const budgetMs = (subCap?: number, now = clock()) => {
    const remaining = remainingMs(now);
    if (remaining <= 0) return 0;
    if (subCap == null) return remaining;
    return Math.max(0, Math.min(remaining, subCap));
  };
  return { startedAt, totalMs, remainingMs, isExpired, budgetMs };
}

/**
 * Decide startup route for an authenticated non-admin consumer.
 * - confirmed missing profile -> SETUP_PROFILE
 * - confirmed exists OR unavailable/timeout -> LOCATION_PROMPT or MAP from persisted access
 *   (never treat offline/unavailable as a new account)
 */
export function decideAuthenticatedConsumerBootstrap(
  profileStatus: ProfileBootstrapStatus,
  locationAccess: LocationAccess,
): AuthenticatedConsumerBootstrapDecision {
  if (profileStatus === 'missing') {
    return { view: AppView.SETUP_PROFILE, seedMinimalUser: false };
  }

  return {
    view: shouldShowPrimer(locationAccess) ? AppView.LOCATION_PROMPT : AppView.MAP,
    seedMinimalUser: profileStatus === 'unavailable',
  };
}

/** Logged-out startup routing (normal vs admin marketing domain). */
export function decideLoggedOutStartupView(opts: {
  isAdminDomain: boolean;
  hasSeenOnboarding: boolean;
}): AppView {
  if (opts.isAdminDomain) return AppView.ADMIN_LOGIN;
  return opts.hasSeenOnboarding ? AppView.CREATE_ACCOUNT : AppView.ONBOARDING;
}

export type AdminDomainTokenStatus = 'admin' | 'non_admin' | 'unavailable';

/** Authenticated traffic on the admin domain — never leave the loader hanging. */
export function decideAdminDomainAuthenticatedView(
  tokenStatus: AdminDomainTokenStatus,
): AppView {
  if (tokenStatus === 'admin') return AppView.ADMIN_DASHBOARD;
  return AppView.ADMIN_LOGIN;
}

export function isExpectedBootstrapUnavailable(error: unknown): boolean {
  if (isTimeoutError(error)) return true;
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string') return false;
  return (
    code === 'unavailable'
    || code === 'deadline-exceeded'
    || code === 'network-request-failed'
    || code.endsWith('/unavailable')
    || code.endsWith('/network-request-failed')
  );
}

/**
 * Classify a Firestore getDoc-style snapshot into exists | missing.
 * Call only when the read actually settled.
 */
export function classifyProfileSnapshot(exists: boolean): Exclude<ProfileBootstrapStatus, 'unavailable'> {
  return exists ? 'exists' : 'missing';
}

/**
 * Bound a profile getDoc to the caller's remaining deadline budget.
 * Settled missing/exists are authoritative; timeout/unavailable/error become `unavailable`.
 */
export async function lookupProfileBootstrapStatus(
  readProfile: () => Promise<{ exists: () => boolean }>,
  options: {
    /** Required remaining budget from the shared overall deadline (ms). */
    timeoutMs: number;
    label?: string;
    onUnexpectedError?: (error: unknown) => void;
  },
): Promise<ProfileBootstrapStatus> {
  const timeoutMs = options.timeoutMs;
  const label = options.label ?? 'profile-lookup';
  if (timeoutMs <= 0) {
    return 'unavailable';
  }
  try {
    const snap = await withTimeout(readProfile(), timeoutMs, label);
    return classifyProfileSnapshot(snap.exists());
  } catch (error) {
    if (isExpectedBootstrapUnavailable(error)) {
      return 'unavailable';
    }
    options.onUnexpectedError?.(error);
    return 'unavailable';
  }
}

export type BootstrapGeneration = {
  readonly id: number;
  isCurrent: () => boolean;
};

/** Monotonic generation guard so late bootstrap completions cannot clobber newer auth work. */
export function createBootstrapGenerationTracker() {
  let current = 0;
  return {
    begin(): BootstrapGeneration {
      const id = ++current;
      return {
        id,
        isCurrent: () => id === current,
      };
    },
    get currentId() {
      return current;
    },
  };
}
