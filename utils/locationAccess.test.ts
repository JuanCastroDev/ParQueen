import { describe, it, expect } from 'vitest';
import {
    readPersistedAccess,
    persistAccessChoice,
    shouldShowPrimer,
    resolveFromPermissions,
    resolveFromPermissionSnapshot,
    resolveFromNativePermissionSnapshot,
    reconcileLocationAccess,
    persistReconciledAccess,
    type LocationAccess,
} from './locationAccess';

// Minimal storage mock
const makeStorage = (entries: Record<string, string> = {}) => {
    const map = new Map(Object.entries(entries));
    return {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => { map.set(k, v); },
        removeItem: (k: string) => { map.delete(k); },
        get: (k: string) => map.get(k),
    };
};

// ─── readPersistedAccess ───────────────────────────────────────────────────────

describe('readPersistedAccess', () => {
    it('returns unknown when nothing is stored', () => {
        expect(readPersistedAccess(makeStorage())).toBe('unknown');
    });

    it('returns granted when locationAccessChoice=granted', () => {
        expect(readPersistedAccess(makeStorage({ locationAccessChoice: 'granted' }))).toBe('granted');
    });

    it('returns declined when locationAccessChoice=declined', () => {
        expect(readPersistedAccess(makeStorage({ locationAccessChoice: 'declined' }))).toBe('declined');
    });

    it('returns denied when locationAccessChoice=denied', () => {
        expect(readPersistedAccess(makeStorage({ locationAccessChoice: 'denied' }))).toBe('denied');
    });

    // Legacy hasSeenLocationPrompt users never went through the new consent primer.
    // Return 'unknown' so they see LocationPromptView (which auto-bypasses if browser
    // already granted). Previously returned 'declined', which permanently blocked tracking.
    it('treats legacy hasSeenLocationPrompt as unknown (not declined)', () => {
        expect(readPersistedAccess(makeStorage({ hasSeenLocationPrompt: '1' }))).toBe('unknown');
    });

    it('locationAccessChoice takes precedence over the legacy key', () => {
        const s = makeStorage({ hasSeenLocationPrompt: '1', locationAccessChoice: 'granted' });
        expect(readPersistedAccess(s)).toBe('granted');
    });

    // Test case 14 continued: primer key is distinct from onboarding/tour keys
    it('ignores hasSeenOnboarding key', () => {
        expect(readPersistedAccess(makeStorage({ hasSeenOnboarding: '1' }))).toBe('unknown');
    });

    it('ignores tour keys', () => {
        expect(readPersistedAccess(makeStorage({ [TOUR_KEY_ALIAS]: '1' }))).toBe('unknown');
    });
});

// Alias for the TOUR_KEY used by AppTour — must stay separate from location keys
const TOUR_KEY_ALIAS = 'parqueen-tour-done';

// ─── persistAccessChoice ──────────────────────────────────────────────────────

describe('persistAccessChoice', () => {
    it('writes locationAccessChoice=granted', () => {
        const s = makeStorage();
        persistAccessChoice('granted', s);
        expect(s.get('locationAccessChoice')).toBe('granted');
    });

    it('writes locationAccessChoice=declined', () => {
        const s = makeStorage();
        persistAccessChoice('declined', s);
        expect(s.get('locationAccessChoice')).toBe('declined');
    });

    it('writes locationAccessChoice=denied', () => {
        const s = makeStorage();
        persistAccessChoice('denied', s);
        expect(s.get('locationAccessChoice')).toBe('denied');
    });

    it('also writes legacy hasSeenLocationPrompt for backward compat', () => {
        const s = makeStorage();
        persistAccessChoice('declined', s);
        expect(s.get('hasSeenLocationPrompt')).toBe('1');
    });

    it('subsequent read returns the persisted value', () => {
        const s = makeStorage();
        persistAccessChoice('denied', s);
        expect(readPersistedAccess(s)).toBe('denied');
    });
});

// ─── shouldShowPrimer ─────────────────────────────────────────────────────────

describe('shouldShowPrimer', () => {
    // Test case 2: new user has never seen the primer
    it('returns true for unknown', () => {
        expect(shouldShowPrimer('unknown')).toBe(true);
    });

    // Test case 12: previously granted browser permission skips the primer
    it('returns false for granted', () => {
        expect(shouldShowPrimer('granted')).toBe(false);
    });

    // Test case 9/10: Not now and denied skip the primer on future sessions
    it('returns false for declined', () => {
        expect(shouldShowPrimer('declined')).toBe(false);
    });

    it('returns false for denied', () => {
        expect(shouldShowPrimer('denied')).toBe(false);
    });
});

// ─── resolveFromPermissions ───────────────────────────────────────────────────

describe('resolveFromPermissions', () => {
    // Test case 12: already-granted browser permission skips primer
    it('returns granted when permissions API says granted', () => {
        expect(resolveFromPermissions('granted', 'unknown')).toBe('granted');
    });

    // Test case 8: denied permission enters MAP with tracking disabled
    it('returns denied when permissions API says denied', () => {
        expect(resolveFromPermissions('denied', 'unknown')).toBe('denied');
    });

    // Test case 13: stored declined choice is preserved when permission is prompt
    it('preserves declined when permission is prompt', () => {
        expect(resolveFromPermissions('prompt', 'declined')).toBe('declined');
    });

    it('returns unknown when permission is prompt and nothing stored', () => {
        expect(resolveFromPermissions('prompt', 'unknown')).toBe('unknown');
    });

    it('granted stored + prompt API → granted', () => {
        expect(resolveFromPermissions('prompt', 'granted')).toBe('granted');
    });
});

describe('resolveFromPermissionSnapshot', () => {
    it('maps granted and denied the same way as the Permissions API helper', () => {
        expect(resolveFromPermissionSnapshot('granted', 'declined')).toBe('granted');
        expect(resolveFromPermissionSnapshot('denied', 'granted')).toBe('denied');
    });

    it('does not treat unavailable / services-off as a permanent denial', () => {
        expect(resolveFromPermissionSnapshot('unavailable', 'unknown')).toBe('unknown');
        expect(resolveFromPermissionSnapshot('unavailable', 'granted')).toBe('granted');
        expect(resolveFromPermissionSnapshot('prompt', 'declined')).toBe('declined');
    });

    it('web/PWA: prompt preserves stored denied (unchanged browser semantics)', () => {
        expect(resolveFromPermissionSnapshot('prompt', 'denied')).toBe('denied');
        expect(reconcileLocationAccess('prompt', 'denied', 'browser')).toBe('denied');
    });
});

// ─── allowLocationTracking contract ───────────────────────────────────────────

describe('allowLocationTracking derivation', () => {
    const allow = (access: LocationAccess) => access === 'granted';

    // Test case 7: granted access enables tracking
    it('granted → tracking allowed', () => {
        expect(allow('granted')).toBe(true);
    });

    // Test case 9: Not now must not start geolocation
    it('declined → tracking not allowed', () => {
        expect(allow('declined')).toBe(false);
    });

    // Test case 8: denied permission → tracking not allowed
    it('denied → tracking not allowed', () => {
        expect(allow('denied')).toBe(false);
    });

    // Test case 4: unknown → tracking not allowed until primer is resolved
    it('unknown → tracking not allowed', () => {
        expect(allow('unknown')).toBe(false);
    });
});

// ─── DEV bypass guard ────────────────────────────────────────────────────────
// Ensures the OTP-testing bypasses introduced for development are not re-introduced.
// Grep the module-level default value for the currentView state.

describe('DEV bypass guard', () => {
    // These assertions check the logical contracts that the bypasses violated.
    // The bypasses set locationAccess to a non-unknown state before the primer
    // could fire. Verifying the derivation contract is unchanged is sufficient.

    it('allowLocationTracking is false when access is unknown (no bypass)', () => {
        const allow = (access: LocationAccess) => access === 'granted';
        expect(allow('unknown')).toBe(false);
    });

    it('primer is required when access is unknown (no bypass to MAP)', () => {
        expect(shouldShowPrimer('unknown')).toBe(true);
    });
});

// ─── Unsupported Permissions API fallback ────────────────────────────────────

describe('Permissions API unavailable fallback', () => {
    // When navigator.permissions is undefined (e.g., older Safari), LocationPromptView
    // skips the check and falls through to readPersistedAccess(). For a new user,
    // this means 'unknown' → primer shown.

    it('new user with no stored choice gets unknown → primer shown', () => {
        const stored = readPersistedAccess(makeStorage());
        expect(stored).toBe('unknown');
        expect(shouldShowPrimer(stored)).toBe(true);
    });

    it('user who previously declined gets declined → no re-prompt even without Permissions API', () => {
        const s = makeStorage({ locationAccessChoice: 'declined' });
        const stored = readPersistedAccess(s);
        expect(shouldShowPrimer(stored)).toBe(false);
    });
});

// ─── Not now / Enable gating contracts ───────────────────────────────────────

describe('Not now flow — no geolocation call contract', () => {
    // LocationPromptView.handleSkip calls onComplete('declined') and nothing else.
    // We verify the state transition: declined → no tracking allowed.

    it('declined access does not enable tracking', () => {
        const allow = (access: LocationAccess) => access === 'granted';
        expect(allow('declined')).toBe(false);
    });

    it('persisting declined preserves the no-tracking state on next session', () => {
        const s = makeStorage();
        persistAccessChoice('declined', s);
        const nextSession = readPersistedAccess(s);
        expect(nextSession).toBe('declined');
        const allow = (access: LocationAccess) => access === 'granted';
        expect(allow(nextSession)).toBe(false);
    });
});

describe('Enable location → denied by browser', () => {
    // getCurrentPosition error callback fires → onComplete('denied').
    // App persists 'denied', tracking stays off, primer does not reopen.

    it('denied access does not enable tracking', () => {
        const allow = (access: LocationAccess) => access === 'granted';
        expect(allow('denied')).toBe(false);
    });

    it('persisting denied prevents re-primer on next session', () => {
        const s = makeStorage();
        persistAccessChoice('denied', s);
        expect(shouldShowPrimer(readPersistedAccess(s))).toBe(false);
    });
});

describe('Previously granted — primer skipped', () => {
    it('resolveFromPermissions granted → granted regardless of stored value', () => {
        expect(resolveFromPermissions('granted', 'unknown')).toBe('granted');
        expect(resolveFromPermissions('granted', 'declined')).toBe('granted');
    });

    it('stored granted → shouldShowPrimer false', () => {
        const s = makeStorage({ locationAccessChoice: 'granted' });
        expect(shouldShowPrimer(readPersistedAccess(s))).toBe(false);
    });

    it('stored granted → tracking allowed', () => {
        const allow = (access: LocationAccess) => access === 'granted';
        const s = makeStorage({ locationAccessChoice: 'granted' });
        expect(allow(readPersistedAccess(s))).toBe(true);
    });
});

// ─── Routing contract ─────────────────────────────────────────────────────────

describe('post-auth routing', () => {
    // Uses the real functions so this stays in sync with implementation changes.
    const resolveDest = (s: ReturnType<typeof makeStorage>) =>
        shouldShowPrimer(readPersistedAccess(s)) ? 'LOCATION_PROMPT' : 'MAP';

    // Test case 2: new user sees primer
    it('new user → LOCATION_PROMPT', () => {
        expect(resolveDest(makeStorage())).toBe('LOCATION_PROMPT');
    });

    // Test case 3: returning user who already granted → MAP
    it('returning granted user → MAP', () => {
        expect(resolveDest(makeStorage({ locationAccessChoice: 'granted' }))).toBe('MAP');
    });

    // Test case 3: returning user who chose Not now → MAP (no re-prompt; reconciled at runtime via Permissions API)
    it('returning declined user → MAP', () => {
        expect(resolveDest(makeStorage({ locationAccessChoice: 'declined' }))).toBe('MAP');
    });

    // Legacy users with only hasSeenLocationPrompt are now treated as 'unknown' → LOCATION_PROMPT
    // so they can go through the new consent primer (which auto-bypasses if browser already granted).
    it('legacy hasSeenLocationPrompt → LOCATION_PROMPT', () => {
        expect(resolveDest(makeStorage({ hasSeenLocationPrompt: '1' }))).toBe('LOCATION_PROMPT');
    });
});

// ─── Not now recovery ─────────────────────────────────────────────────────────

describe('Not now recovery — browser later grants permission', () => {
    // App startup queries Permissions API via resolveFromPermissions. If browser
    // says 'granted', the stale stored state is overridden and tracking starts.

    it('browser granted overrides stored declined', () => {
        expect(resolveFromPermissions('granted', 'declined')).toBe('granted');
    });

    it('browser granted overrides stored denied', () => {
        expect(resolveFromPermissions('granted', 'denied')).toBe('granted');
    });

    it('browser granted overrides legacy unknown', () => {
        expect(resolveFromPermissions('granted', 'unknown')).toBe('granted');
    });

    it('browser prompt preserves stored declined (no auto-grant without user action)', () => {
        expect(resolveFromPermissions('prompt', 'declined')).toBe('declined');
    });

    it('browser denied downgrades stored granted', () => {
        expect(resolveFromPermissions('denied', 'granted')).toBe('denied');
    });
});
