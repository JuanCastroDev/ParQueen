import { describe, it, expect, vi } from 'vitest';
import { deriveNearbyState, nearbyPermissionState, resolveBlockedCTA, type NearbyStateParams, type LocationCallbacks } from './nearbyActivity';
import en from '../i18n/en';

const t = (key: string) => en[key] ?? key;

const base: NearbyStateParams = {
    permissionState: 'granted',
    locating: false,
    locationError: false,
    userLocation: [40.7, -74.0],
    spotsLoading: false,
    spotsError: false,
    nearbyCount: 0,
};

// ─── nearbyPermissionState (web adapter) ──────────────────────────────────────

describe('nearbyPermissionState', () => {
    it('granted → granted', () => expect(nearbyPermissionState('granted')).toBe('granted'));
    it('denied → permanently_blocked', () => expect(nearbyPermissionState('denied')).toBe('permanently_blocked'));
    it('declined → denied_requestable', () => expect(nearbyPermissionState('declined')).toBe('denied_requestable'));
    it('unknown → not_determined', () => expect(nearbyPermissionState('unknown')).toBe('not_determined'));

    it('device Location Services off beats a stored grant', () => {
        expect(nearbyPermissionState('granted', { locationServicesEnabled: false })).toBe('services_disabled');
    });

    it('unknown services state leaves the stored mapping unchanged', () => {
        expect(nearbyPermissionState('granted', { locationServicesEnabled: null })).toBe('granted');
    });
});

// ─── deriveNearbyState — permission gates ─────────────────────────────────────

describe('deriveNearbyState — permission gates', () => {
    it('services_disabled', () => {
        expect(deriveNearbyState({ ...base, permissionState: 'services_disabled' })).toBe('services_disabled');
    });

    it('permanently_blocked', () => {
        expect(deriveNearbyState({ ...base, permissionState: 'permanently_blocked' })).toBe('permanently_blocked');
    });

    it('denied_requestable — same CTA as not_determined but distinct OS state', () => {
        expect(deriveNearbyState({ ...base, permissionState: 'denied_requestable' })).toBe('denied_requestable');
    });

    it('not_determined', () => {
        expect(deriveNearbyState({ ...base, permissionState: 'not_determined' })).toBe('not_determined');
    });
});

// ─── deriveNearbyState — granted flow ─────────────────────────────────────────

describe('deriveNearbyState — granted flow', () => {
    it('location_error when granted + locationError', () => {
        expect(deriveNearbyState({ ...base, locationError: true })).toBe('location_error');
    });

    it('locating when granted + locating', () => {
        expect(deriveNearbyState({ ...base, locating: true })).toBe('locating');
    });

    it('query_error when granted + location + spotsError', () => {
        expect(deriveNearbyState({ ...base, spotsError: true })).toBe('query_error');
    });

    it('pings_loading when granted + location + loading', () => {
        expect(deriveNearbyState({ ...base, spotsLoading: true })).toBe('pings_loading');
    });

    it('empty when granted + location + loaded + 0 spots', () => {
        expect(deriveNearbyState({ ...base, nearbyCount: 0 })).toBe('empty');
    });

    it('results when granted + location + loaded + spots', () => {
        expect(deriveNearbyState({ ...base, nearbyCount: 3 })).toBe('results');
    });
});

// ─── deriveNearbyState — priority ordering ────────────────────────────────────

describe('deriveNearbyState — priority ordering', () => {
    it('services_disabled beats permanently_blocked', () => {
        expect(deriveNearbyState({ ...base, permissionState: 'services_disabled' }))
            .toBe('services_disabled');
    });

    it('permanently_blocked beats denied_requestable', () => {
        // not possible in practice but confirms priority
        expect(deriveNearbyState({ ...base, permissionState: 'permanently_blocked' }))
            .toBe('permanently_blocked');
    });

    it('not_determined beats locating (no geolocation before permission)', () => {
        expect(deriveNearbyState({ ...base, permissionState: 'not_determined', locating: true }))
            .toBe('not_determined');
    });

    it('location_error beats locating', () => {
        expect(deriveNearbyState({ ...base, locationError: true, locating: true }))
            .toBe('location_error');
    });

    it('locating beats pings_loading', () => {
        expect(deriveNearbyState({ ...base, locating: true, spotsLoading: true }))
            .toBe('locating');
    });

    it('pings_loading beats empty', () => {
        expect(deriveNearbyState({ ...base, spotsLoading: true, nearbyCount: 0 }))
            .toBe('pings_loading');
    });

    it('empty never fires without a completed location-based query', () => {
        // spotsLoading must be false for empty to appear
        const loading = deriveNearbyState({ ...base, spotsLoading: true, nearbyCount: 0 });
        const done = deriveNearbyState({ ...base, spotsLoading: false, nearbyCount: 0 });
        expect(loading).toBe('pings_loading');
        expect(done).toBe('empty');
    });
});

// ─── nearbyPermissionState — never emits services_disabled ───────────────────

describe('nearbyPermissionState — web adapter contract', () => {
    const allInputs = ['granted', 'declined', 'denied', 'unknown'] as const;
    for (const access of allInputs) {
        it(`${access} never maps to services_disabled`, () => {
            expect(nearbyPermissionState(access)).not.toBe('services_disabled');
        });
    }
});

// ─── resolveBlockedCTA ────────────────────────────────────────────────────────

const webCaps: Pick<LocationCallbacks, 'canOpenAppSettings' | 'canOpenLocationServicesSettings'> = {
    canOpenAppSettings: false,
    canOpenLocationServicesSettings: false,
};
const nativeCaps: Pick<LocationCallbacks, 'canOpenAppSettings' | 'canOpenLocationServicesSettings'> = {
    canOpenAppSettings: true,
    canOpenLocationServicesSettings: true,
};

describe('resolveBlockedCTA', () => {
    it('permanently_blocked + web caps → recheck (not openSettings)', () => {
        expect(resolveBlockedCTA('permanently_blocked', webCaps)).toBe('recheck');
    });

    it('permanently_blocked + native caps → openSettings', () => {
        expect(resolveBlockedCTA('permanently_blocked', nativeCaps)).toBe('openSettings');
    });

    it('services_disabled + web caps → recheck (not openLocationServices)', () => {
        expect(resolveBlockedCTA('services_disabled', webCaps)).toBe('recheck');
    });

    it('services_disabled + native caps → openLocationServices', () => {
        expect(resolveBlockedCTA('services_disabled', nativeCaps)).toBe('openLocationServices');
    });

    it('returns null for non-blocked states', () => {
        expect(resolveBlockedCTA('not_determined', webCaps)).toBeNull();
        expect(resolveBlockedCTA('denied_requestable', webCaps)).toBeNull();
        expect(resolveBlockedCTA('results', webCaps)).toBeNull();
        expect(resolveBlockedCTA('empty', webCaps)).toBeNull();
    });

    it('web: permanently_blocked never wires to openAppSettings (no-op guard)', () => {
        const action = resolveBlockedCTA('permanently_blocked', webCaps);
        expect(action).not.toBe('openSettings');
        // openSettings on web is a no-op; recheck is the correct action
        expect(action).toBe('recheck');
    });

    it('location failure on web maps to location_error, not services_disabled', () => {
        // Web geolocation failures flow through locationError=true → location_error
        const errorState = deriveNearbyState({ ...base, locationError: true });
        expect(errorState).toBe('location_error');
        // resolveBlockedCTA returns null for location_error (not a permission block)
        expect(resolveBlockedCTA(errorState, webCaps)).toBeNull();
    });
});

// ─── i18n coverage ────────────────────────────────────────────────────────────

describe('nearby_activity i18n — English keys present', () => {
    const keys = [
        'nearby_activity.enable_headline',
        'nearby_activity.enable_body',
        'nearby_activity.enable_cta',
        'nearby_activity.enable_requesting',
        'nearby_activity.enable_reassurance',
        'nearby_activity.open_settings',
        'nearby_activity.turn_on_services',
        'nearby_activity.check_again',
        'nearby_activity.blocked_web_hint',
        'nearby_activity.locating_headline',
        'nearby_activity.locating_body',
        'nearby_activity.error_headline',
        'nearby_activity.error_body',
        'nearby_activity.error_retry',
        'nearby_activity.loading_headline',
        'nearby_activity.empty_title',
        'nearby_activity.empty_body',
        'nearby_activity.query_error_headline',
        'nearby_activity.query_error_retry',
    ] as const;

    for (const key of keys) {
        it(`${key} is defined and non-empty`, () => {
            const val = t(key as string);
            expect(val).toBeTruthy();
            expect(val).not.toBe(key);
        });
    }

    it('the empty state leads with "No live Pings nearby"', () => {
        // Renamed from empty_headline with the radar redesign; the sibling
        // empty_watching line carries the radius alongside it.
        expect(t('nearby_activity.empty_title')).toBe('No live Pings nearby');
        expect(t('nearby_activity.empty_watching')).toContain('{radius}');
    });

    it('open_settings says "Open Settings"', () => {
        expect(t('nearby_activity.open_settings')).toBe('Open Settings');
    });

    it('turn_on_services says "Turn on Location Services"', () => {
        expect(t('nearby_activity.turn_on_services')).toBe('Turn on Location Services');
    });
});
