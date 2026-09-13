import type { LocationAccess } from './locationAccess';

/**
 * Native OS permission state — distinct from the web-only LocationAccess enum.
 *
 * `services_disabled` is only emitted by native adapters when device-wide
 * Location Services is off. The web adapter never emits it because the browser
 * Permissions API cannot reliably distinguish "app denied" from "services off".
 * Web geolocation failures map to location_error instead.
 */
export type LocationPermissionState =
    | 'not_determined'      // never asked
    | 'denied_requestable'  // denied but OS allows re-request (Android pattern)
    | 'permanently_blocked' // permanently denied — must go to app Settings
    | 'services_disabled'   // device-wide Location Services off (native only)
    | 'granted';

/**
 * Callback surface supplied by the platform adapter.
 *
 * `canOpenAppSettings` and `canOpenLocationServicesSettings` describe what
 * the adapter can genuinely do. The view uses these to pick a CTA label and
 * action that is always actionable — never an "Open Settings" button wired
 * to a no-op. Native adapters set both to true; the web adapter sets both
 * to false (no deep-link to system settings from a browser).
 *
 * Native lifecycle note: when `permanently_blocked` or `services_disabled`,
 * the native adapter must call `recheckPermission()` from the native
 * AppState/foreground event (e.g. AppState.addEventListener('change', ...))
 * rather than relying on the web visibilitychange event. The view does NOT
 * own lifecycle logic; the adapter does.
 */
export interface LocationCallbacks {
    requestLocationPermission: () => void;
    openAppSettings: () => void;
    openLocationServicesSettings: () => void;
    recheckPermission: () => void;
    /** true only when the adapter can genuinely open app-level permission settings */
    canOpenAppSettings: boolean;
    /** true only when the adapter can open device-wide Location Services settings */
    canOpenLocationServicesSettings: boolean;
}

export type NearbyRenderState =
    | 'not_determined'
    | 'denied_requestable'
    | 'permanently_blocked'
    | 'services_disabled'
    | 'locating'
    | 'location_error'
    | 'pings_loading'
    | 'empty'
    | 'results'
    | 'query_error';

export interface NearbyStateParams {
    permissionState: LocationPermissionState;
    locating: boolean;
    locationError: boolean;
    userLocation: [number, number] | null;
    spotsLoading: boolean;
    spotsError: boolean;
    nearbyCount: number;
}

/** Priority-ordered derivation — pure and testable. */
export function deriveNearbyState(p: NearbyStateParams): NearbyRenderState {
    if (p.permissionState === 'services_disabled') return 'services_disabled';
    if (p.permissionState === 'permanently_blocked') return 'permanently_blocked';
    if (p.permissionState === 'denied_requestable') return 'denied_requestable';
    if (p.permissionState !== 'granted') return 'not_determined';
    if (p.locationError) return 'location_error';
    if (p.locating) return 'locating';
    if (p.spotsError) return 'query_error';
    if (p.spotsLoading) return 'pings_loading';
    if (p.nearbyCount === 0) return 'empty';
    return 'results';
}

/** Maps persisted LocationAccess (and optional runtime extras) to the nearby permission model.
 *  `services_disabled` is only emitted when the location abstraction reports device
 *  Location Services off. The web Permissions API cannot detect that on its own. */
export function nearbyPermissionState(
    access: LocationAccess,
    extras?: { locationServicesEnabled?: boolean | null },
): LocationPermissionState {
    if (extras?.locationServicesEnabled === false) return 'services_disabled';
    if (access === 'granted') return 'granted';
    if (access === 'denied') return 'permanently_blocked';
    if (access === 'declined') return 'denied_requestable';
    return 'not_determined'; // 'unknown'
}

/** What CTA action to wire for blocked permission states.
 *  Derived from capabilities so the view never labels a button with an action
 *  the adapter cannot perform. */
export type BlockedCTAAction = 'openSettings' | 'openLocationServices' | 'recheck';

export function resolveBlockedCTA(
    renderState: NearbyRenderState,
    caps: Pick<LocationCallbacks, 'canOpenAppSettings' | 'canOpenLocationServicesSettings'>
): BlockedCTAAction | null {
    if (renderState === 'permanently_blocked') {
        return caps.canOpenAppSettings ? 'openSettings' : 'recheck';
    }
    if (renderState === 'services_disabled') {
        return caps.canOpenLocationServicesSettings ? 'openLocationServices' : 'recheck';
    }
    return null;
}
