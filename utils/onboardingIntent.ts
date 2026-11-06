// Onboarding 2.0 intention ("Find parking", "I'm leaving a spot", "Just exploring").
//
// The intention is LOCAL NAVIGATION CONTEXT only (Blueprint D2/D3):
// - stored on this device, never sent to the server, never an authorization signal;
// - expires 24 h after it is chosen;
// - used at most once (taking it removes it);
// - bound to the first account that signs in after it is chosen, so it can never carry over to another account;
// - cleared on logout and account deletion (both clear account-scoped localStorage).

export type OnboardingIntent = 'find' | 'leave' | 'explore';

export const ONBOARDING_INTENT_KEY = 'parqueen_onboarding_intent_v1';
export const ONBOARDING_INTENT_TTL_MS = 24 * 60 * 60 * 1000;

type StoredIntent = { v: 1; intent: OnboardingIntent; createdAt: number; uid?: string };

const INTENTS: readonly OnboardingIntent[] = ['find', 'leave', 'explore'];

export function isOnboardingIntent(value: unknown): value is OnboardingIntent {
  return typeof value === 'string' && (INTENTS as readonly string[]).includes(value);
}

function read(): StoredIntent | null {
  let raw: string | null = null;
  try { raw = localStorage.getItem(ONBOARDING_INTENT_KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredIntent>;
    if (parsed?.v !== 1 || !isOnboardingIntent(parsed.intent) || typeof parsed.createdAt !== 'number') return null;
    if (parsed.uid !== undefined && typeof parsed.uid !== 'string') return null;
    return parsed as StoredIntent;
  } catch {
    return null;
  }
}

function write(value: StoredIntent): void {
  try { localStorage.setItem(ONBOARDING_INTENT_KEY, JSON.stringify(value)); } catch { /* storage unavailable: no intention */ }
}

export function clearPendingIntent(): void {
  try { localStorage.removeItem(ONBOARDING_INTENT_KEY); } catch { /* ignore */ }
}

function isExpired(record: StoredIntent, now: number): boolean {
  return now < record.createdAt || now - record.createdAt > ONBOARDING_INTENT_TTL_MS;
}

/** Called when the user picks an intention (before sign-in). Replaces any earlier choice. */
export function savePendingIntent(intent: OnboardingIntent, now: number = Date.now()): void {
  if (!isOnboardingIntent(intent)) return;
  write({ v: 1, intent, createdAt: now });
}

/**
 * Called whenever an account becomes active on this device. An unbound intention is bound to that account;
 * an intention bound to a different account (or an expired or malformed one) is discarded.
 */
export function bindPendingIntent(uid: string, now: number = Date.now()): void {
  if (!uid) return;
  let raw: string | null = null;
  try { raw = localStorage.getItem(ONBOARDING_INTENT_KEY); } catch { return; }
  if (raw === null) return;
  const record = read();
  if (!record || isExpired(record, now) || (record.uid !== undefined && record.uid !== uid)) {
    clearPendingIntent();
    return;
  }
  if (record.uid === undefined) write({ ...record, uid });
}

/** Single consumption: returns the intention for this account (if valid) and removes it in every case. */
export function takePendingIntent(uid: string, now: number = Date.now()): OnboardingIntent | null {
  const record = read();
  let raw: string | null = null;
  try { raw = localStorage.getItem(ONBOARDING_INTENT_KEY); } catch { return null; }
  if (raw === null) return null;
  clearPendingIntent();
  if (!record || !uid || isExpired(record, now) || record.uid !== uid) return null;
  return record.intent;
}

/** Read-only view for tests and diagnostics; does not consume. */
export function peekPendingIntent(): { intent: OnboardingIntent; createdAt: number; uid?: string } | null {
  const record = read();
  return record ? { intent: record.intent, createdAt: record.createdAt, uid: record.uid } : null;
}
