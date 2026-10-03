import { describe, expect, it } from 'vitest';
import { getDistance } from './utils';
import {
    ARRIVAL_DISTANCE_KM,
    ARRIVAL_LOCATION_MAX_AGE_MS,
    arrivalFixFromPosition,
    classifyArrivalLocation,
    nextArrivalReading,
    type ArrivalLocationReading,
} from './arrivalLocation';

const NOW = 1_700_000_000_000;
const spot = { lat: 40.82, lng: -73.91 };

function reading(partial: Partial<ArrivalLocationReading> = {}): ArrivalLocationReading {
    return { fix: null, fault: null, ...partial };
}

function fixAt(ageMs: number, lat = spot.lat, lng = spot.lng) {
    return { lat, lng, timestampMs: NOW - ageMs };
}

describe('classifyArrivalLocation', () => {
    it('uses 120 seconds as the stale boundary', () => {
        expect(ARRIVAL_LOCATION_MAX_AGE_MS).toBe(120_000);

        const fresh = classifyArrivalLocation({
            reading: reading({ fix: fixAt(120_000) }),
            spot,
            nowMs: NOW,
        });
        expect(fresh).toEqual({ kind: 'arrive' });

        const stale = classifyArrivalLocation({
            reading: reading({ fix: fixAt(120_001) }),
            spot,
            nowMs: NOW,
        });
        expect(stale).toEqual({ kind: 'override', reason: 'stale' });
    });

    it('keeps a healthy in-range fix on the arrive path with no override payload', () => {
        const decision = classifyArrivalLocation({
            reading: reading({ fix: fixAt(1_000), fault: 'unavailable' }),
            spot,
            nowMs: NOW,
        });
        expect(decision).toEqual({ kind: 'arrive' });
        expect(Object.keys(decision)).toEqual(['kind']);
    });

    it('treats a healthy out-of-range fix as a warning, not an override', () => {
        const far = { lat: spot.lat + 0.01, lng: spot.lng };
        expect(getDistance(far.lat, far.lng, spot.lat, spot.lng)).toBeGreaterThan(ARRIVAL_DISTANCE_KM);
        const decision = classifyArrivalLocation({
            reading: reading({ fix: { ...far, timestampMs: NOW - 5_000 } }),
            spot,
            nowMs: NOW,
        });
        expect(decision).toEqual({ kind: 'out_of_range' });
    });

    it('classifies a stale far fix as stale rather than a fresh out-of-range warning', () => {
        const decision = classifyArrivalLocation({
            reading: reading({
                fix: { lat: spot.lat + 0.01, lng: spot.lng, timestampMs: NOW - 120_001 },
            }),
            spot,
            nowMs: NOW,
        });
        expect(decision).toEqual({ kind: 'override', reason: 'stale' });
    });

    it('shows an override for permission denied or unavailable when there is no healthy fix', () => {
        expect(classifyArrivalLocation({
            reading: reading({ fault: 'permission_denied' }),
            spot,
            nowMs: NOW,
        })).toEqual({ kind: 'override', reason: 'permission_denied' });

        expect(classifyArrivalLocation({
            reading: reading({ fault: 'unavailable' }),
            spot,
            nowMs: NOW,
        })).toEqual({ kind: 'override', reason: 'unavailable' });

        const denied = classifyArrivalLocation({
            reading: reading({ fault: 'permission_denied' }),
            spot,
            nowMs: NOW,
        });
        expect(JSON.stringify(denied)).not.toMatch(/lat|lng|crown/i);
    });

    it('stays pending until the first fix or fault', () => {
        expect(classifyArrivalLocation({
            reading: reading(),
            spot,
            nowMs: NOW,
        })).toEqual({ kind: 'pending' });
    });
});

describe('arrival location updates', () => {
    it('prefers a platform timestamp and falls back to receipt time', () => {
        expect(arrivalFixFromPosition(
            { coords: { latitude: 40.7, longitude: -74 }, timestampMs: NOW - 50_000 },
            NOW,
        )).toEqual({ lat: 40.7, lng: -74, timestampMs: NOW - 50_000 });

        expect(arrivalFixFromPosition(
            { coords: { latitude: 40.7, longitude: -74 } },
            NOW,
        )?.timestampMs).toBe(NOW);
    });

    it('drops the last fix on permission denial and keeps it for other failures', () => {
        const current = reading({ fix: fixAt(1_000) });
        expect(nextArrivalReading(current, { type: 'error', kind: 'permission' })).toEqual({
            fix: null,
            fault: 'permission_denied',
        });
        expect(nextArrivalReading(current, { type: 'error', kind: 'timeout' })).toEqual({
            fix: current.fix,
            fault: 'unavailable',
        });
        expect(nextArrivalReading(current, {
            type: 'fix',
            fix: fixAt(0),
        })).toEqual({ fix: fixAt(0), fault: null });
    });
});
