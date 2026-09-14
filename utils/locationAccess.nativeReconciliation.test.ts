import { describe, expect, it } from 'vitest';
import {
    nearbyPermissionState,
    locationPermissionCTAKind,
} from './nearbyActivity';
import {
    persistReconciledAccess,
    readPersistedAccess,
    reconcileLocationAccess,
    resolveFromNativePermissionSnapshot,
    resolveFromPermissionSnapshot,
} from './locationAccess';

const makeStorage = (entries: Record<string, string> = {}) => {
    const map = new Map(Object.entries(entries));
    return {
        getItem: (k: string) => map.get(k) ?? null,
        setItem: (k: string, v: string) => { map.set(k, v); },
        removeItem: (k: string) => { map.delete(k); },
        get: (k: string) => map.get(k),
    };
};

const androidCaps = {
    canOpenAppSettings: false,
    canOpenLocationServicesSettings: false,
};

describe('native Android OS snapshot is authoritative', () => {
    it('prompt + stored denied is recoverable / requestable, not permanently_blocked', () => {
        const access = resolveFromNativePermissionSnapshot('prompt', 'denied');
        expect(access).toBe('unknown');
        expect(reconcileLocationAccess('prompt', 'denied', 'native')).toBe('unknown');
        expect(nearbyPermissionState(access)).toBe('not_determined');
        expect(nearbyPermissionState(access)).not.toBe('permanently_blocked');
        expect(locationPermissionCTAKind(nearbyPermissionState(access), androidCaps)).toBe('enable');
    });

    it('prompt + stored declined preserves intentional Not now', () => {
        const access = resolveFromNativePermissionSnapshot('prompt', 'declined');
        expect(access).toBe('declined');
        expect(nearbyPermissionState(access)).toBe('denied_requestable');
        expect(locationPermissionCTAKind(nearbyPermissionState(access), androidCaps)).toBe('enable');
    });

    it('granted overrides stale denied and declined', () => {
        expect(resolveFromNativePermissionSnapshot('granted', 'denied')).toBe('granted');
        expect(resolveFromNativePermissionSnapshot('granted', 'declined')).toBe('granted');
        expect(nearbyPermissionState(resolveFromNativePermissionSnapshot('granted', 'denied'))).toBe('granted');
    });

    it('denied overrides stale granted (genuine Android denial)', () => {
        const access = resolveFromNativePermissionSnapshot('denied', 'granted');
        expect(access).toBe('denied');
        expect(nearbyPermissionState(access)).toBe('permanently_blocked');
        expect(locationPermissionCTAKind(nearbyPermissionState(access), androidCaps)).toBe('recheck');
    });

    it('stale-denial migration exposes Enable, not Check again', () => {
        const migrated = nearbyPermissionState(reconcileLocationAccess('prompt', 'denied', 'native'));
        expect(locationPermissionCTAKind(migrated, androidCaps)).toBe('enable');
        expect(locationPermissionCTAKind(migrated, androidCaps)).not.toBe('recheck');
        expect(locationPermissionCTAKind(nearbyPermissionState('denied'), androidCaps)).toBe('recheck');
    });

    it('clears a stale persisted denied when reconciliation returns unknown', () => {
        const storage = makeStorage({ locationAccessChoice: 'denied', hasSeenLocationPrompt: '1' });
        const next = reconcileLocationAccess('prompt', readPersistedAccess(storage), 'native');
        expect(next).toBe('unknown');
        persistReconciledAccess(next, storage);
        expect(readPersistedAccess(storage)).toBe('unknown');
        expect(storage.get('locationAccessChoice')).toBeUndefined();
    });
});

describe('web/PWA browser semantics stay unchanged', () => {
    it('prompt + stored denied remains denied / permanently_blocked', () => {
        expect(resolveFromPermissionSnapshot('prompt', 'denied')).toBe('denied');
        expect(reconcileLocationAccess('prompt', 'denied', 'browser')).toBe('denied');
        expect(nearbyPermissionState(reconcileLocationAccess('prompt', 'denied', 'browser')))
            .toBe('permanently_blocked');
        expect(locationPermissionCTAKind(
            nearbyPermissionState(reconcileLocationAccess('prompt', 'denied', 'browser')),
            androidCaps,
        )).toBe('recheck');
    });

    it('prompt + stored declined remains declined / denied_requestable', () => {
        expect(reconcileLocationAccess('prompt', 'declined', 'browser')).toBe('declined');
        expect(nearbyPermissionState(reconcileLocationAccess('prompt', 'declined', 'browser')))
            .toBe('denied_requestable');
    });
});
