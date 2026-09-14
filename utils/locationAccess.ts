import type { GeolocationPath } from './geolocationPlatform';

export type LocationAccess = 'unknown' | 'granted' | 'declined' | 'denied';
export type LocationPermissionSnapshotStatus = 'prompt' | 'granted' | 'denied' | 'unavailable';

const CHOICE_KEY = 'locationAccessChoice';
const LEGACY_KEY = 'hasSeenLocationPrompt';

type MinStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Read persisted location access choice from storage. */
export function readPersistedAccess(storage: MinStorage = localStorage): LocationAccess {
    const stored = storage.getItem(CHOICE_KEY);
    if (stored === 'granted' || stored === 'declined' || stored === 'denied') return stored;
    // Backward compat: old hasSeenLocationPrompt means user saw the old overlay but did not go
    // through the new consent primer. Treat as 'unknown' so they see the primer; if the browser
    // has already granted, LocationPromptView's Permissions API check auto-bypasses immediately.
    if (storage.getItem(LEGACY_KEY)) return 'unknown';
    return 'unknown';
}

/** Persist a user-made access choice; also writes legacy key for backward compat. */
export function persistAccessChoice(
    access: 'granted' | 'declined' | 'denied',
    storage: MinStorage = localStorage
): void {
    storage.setItem(CHOICE_KEY, access);
    storage.setItem(LEGACY_KEY, '1');
}

/** True when the location primer should be shown (access not yet resolved). */
export function shouldShowPrimer(access: LocationAccess): boolean {
    return access === 'unknown';
}

/**
 * Derive LocationAccess from the Permissions API result combined with the stored choice.
 * Call this on mount in LocationPromptView as a best-effort enhancement.
 */
export function resolveFromPermissions(
    permState: PermissionState,
    stored: LocationAccess
): LocationAccess {
    if (permState === 'granted') return 'granted';
    if (permState === 'denied') return 'denied';
    // 'prompt' — honour the stored choice (e.g. 'declined' from a previous Not now)
    return stored;
}

/**
 * Same product mapping as `resolveFromPermissions`, for the location abstraction
 * snapshot (`unavailable` behaves like `prompt`: do not invent a denial).
 * Web/PWA only — do not use this for Capacitor Android.
 */
export function resolveFromPermissionSnapshot(
    status: LocationPermissionSnapshotStatus,
    stored: LocationAccess,
): LocationAccess {
    if (status === 'unavailable') return stored;
    return resolveFromPermissions(status, stored);
}

/**
 * Native Android: OS permission is authoritative over stale pre-native
 * `locationAccessChoice` values written by older WebView/browser builds.
 *
 * `prompt` means the OS has not resolved the runtime permission. A stored
 * `denied` from that older path must not become permanently_blocked.
 * Intentional "Not now" (`declined`) is preserved and does not auto-prompt.
 */
export function resolveFromNativePermissionSnapshot(
    status: LocationPermissionSnapshotStatus,
    stored: LocationAccess,
): LocationAccess {
    if (status === 'granted') return 'granted';
    if (status === 'denied') return 'denied';
    if (status === 'unavailable') return stored;
    if (stored === 'declined') return 'declined';
    return 'unknown';
}

/** Platform-aware mapping. Web keeps browser semantics; Android uses the native helper. */
export function reconcileLocationAccess(
    status: LocationPermissionSnapshotStatus,
    stored: LocationAccess,
    path: GeolocationPath,
): LocationAccess {
    return path === 'native'
        ? resolveFromNativePermissionSnapshot(status, stored)
        : resolveFromPermissionSnapshot(status, stored);
}

/**
 * Persist a reconciled product choice. `unknown` clears a stale stored denial
 * so it cannot resurrect on the next read.
 */
export function persistReconciledAccess(
    access: LocationAccess,
    storage: MinStorage = localStorage,
): void {
    if (access === 'granted' || access === 'denied' || access === 'declined') {
        persistAccessChoice(access, storage);
        return;
    }
    storage.removeItem(CHOICE_KEY);
}
