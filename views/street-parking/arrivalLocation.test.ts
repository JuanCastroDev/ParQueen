import { describe, expect, it } from 'vitest';
import { getDistance } from './utils';
import {
    ARRIVAL_DISTANCE_KM,
    ARRIVAL_EXIT_DISTANCE_KM,
    ARRIVAL_LOCATION_MAX_AGE_MS,
    ARRIVAL_RANGE_CONFIRMATIONS,
    arrivalFixFromPosition,
    classifyArrivalLocation,
    finishArrivalLocationWait,
    nextArrivalReading,
    stabilizeArrivalLocation,
    INITIAL_ARRIVAL_RANGE_MEMORY,
    type ArrivalLocationReading,
    type ArrivalRangeStabilityMemory,
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

    it('keeps a fix exactly 120_000 ms old healthy', () => {
        expect(classifyArrivalLocation({
            reading: reading({ fix: fixAt(120_000) }),
            spot,
            nowMs: NOW,
        })).toEqual({ kind: 'arrive' });
    });

    it('treats a fix 120_001 ms old as stale', () => {
        expect(classifyArrivalLocation({
            reading: reading({ fix: fixAt(120_001) }),
            spot,
            nowMs: NOW,
        })).toEqual({ kind: 'override', reason: 'stale' });
    });

    it('does not treat a future timestamp as healthy', () => {
        const decision = classifyArrivalLocation({
            reading: reading({
                fix: { lat: spot.lat, lng: spot.lng, timestampMs: NOW + 60_000 },
            }),
            spot,
            nowMs: NOW,
        });
        expect(decision.kind).not.toBe('arrive');
        expect(decision.kind).not.toBe('out_of_range');
        expect(decision.kind).not.toBe('pending');
        expect(decision).toEqual({ kind: 'override', reason: 'stale' });
    });

    it('treats a normal current timestamp as healthy', () => {
        expect(classifyArrivalLocation({
            reading: reading({
                fix: { lat: spot.lat, lng: spot.lng, timestampMs: NOW },
            }),
            spot,
            nowMs: NOW,
        })).toEqual({ kind: 'arrive' });
    });
});


describe('stabilizeArrivalLocation', () => {
    const fixAtMeters = (
        meters: number,
        accuracyMeters = 10,
        timestampMs = NOW - 1_000,
    ) => ({
        lat: spot.lat + (meters / 111_000),
        lng: spot.lng,
        timestampMs,
        accuracyMeters,
    });

    const step = (
        memory: ArrivalRangeStabilityMemory,
        meters: number,
        accuracyMeters = 10,
        timestampMs = NOW - 1_000,
        nowMs = NOW,
    ) => stabilizeArrivalLocation({
        reading: reading({ fix: fixAtMeters(meters, accuracyMeters, timestampMs) }),
        spot,
        nowMs,
        previous: memory,
    });

    it('uses a wider exit radius than the strict arrival radius', () => {
        expect(ARRIVAL_EXIT_DISTANCE_KM).toBeGreaterThan(ARRIVAL_DISTANCE_KM);
        expect(ARRIVAL_RANGE_CONFIRMATIONS).toBe(2);
    });

    it('enters immediately on a strict in-range fix', () => {
        const sampleTs = NOW - 1_000;
        const firstNear = step(INITIAL_ARRIVAL_RANGE_MEMORY, 12, 10, sampleTs);
        expect(firstNear.decision).toEqual({ kind: 'arrive' });
        expect(firstNear.next).toEqual({
            stable: 'in_range',
            candidate: null,
            confirmations: 0,
            lastSampleTimestampMs: sampleTs,
        });
    });

    it('does not count the same initial far GPS sample twice across re-render or clock ticks', () => {
        const firstTs = NOW - 3_000;
        const firstFar = step(INITIAL_ARRIVAL_RANGE_MEMORY, 80, 10, firstTs);
        expect(firstFar.decision).toEqual({ kind: 'pending' });
        expect(firstFar.next).toEqual({
            stable: 'unknown',
            candidate: 'out_of_range',
            confirmations: 1,
            lastSampleTimestampMs: firstTs,
        });

        const rerender = step(firstFar.next, 80, 10, firstTs, NOW + 1_000);
        expect(rerender.decision).toEqual({ kind: 'pending' });
        expect(rerender.next).toEqual(firstFar.next);

        const secondTs = NOW - 1_000;
        const secondDistinctFar = step(rerender.next, 82, 10, secondTs, NOW + 1_000);
        expect(secondDistinctFar.decision).toEqual({ kind: 'out_of_range' });
        expect(secondDistinctFar.next).toEqual({
            stable: 'out_of_range',
            candidate: null,
            confirmations: 0,
            lastSampleTimestampMs: secondTs,
        });
    });

    it('does not hide an established out-of-range warning on one near GPS spike', () => {
        const initial: ArrivalRangeStabilityMemory = {
            stable: 'out_of_range',
            candidate: null,
            confirmations: 0,
            lastSampleTimestampMs: NOW - 5_000,
        };

        const firstNearTs = NOW - 3_000;
        const firstNear = step(initial, 12, 10, firstNearTs);
        expect(firstNear.decision).toEqual({ kind: 'out_of_range' });
        expect(firstNear.next).toEqual({
            stable: 'out_of_range',
            candidate: 'in_range',
            confirmations: 1,
            lastSampleTimestampMs: firstNearTs,
        });

        const sameNearRerender = step(firstNear.next, 12, 10, firstNearTs, NOW + 500);
        expect(sameNearRerender.decision).toEqual({ kind: 'out_of_range' });
        expect(sameNearRerender.next).toEqual(firstNear.next);

        const farAgain = step(sameNearRerender.next, 80, 10, NOW - 1_000);
        expect(farAgain.decision).toEqual({ kind: 'out_of_range' });
        expect(farAgain.next).toEqual({
            stable: 'out_of_range',
            candidate: null,
            confirmations: 0,
            lastSampleTimestampMs: NOW - 1_000,
        });
    });

    it('requires two distinct near fixes to clear an established out-of-range warning', () => {
        const initial: ArrivalRangeStabilityMemory = {
            stable: 'out_of_range',
            candidate: null,
            confirmations: 0,
            lastSampleTimestampMs: NOW - 5_000,
        };

        const firstNear = step(initial, 12, 10, NOW - 3_000);
        expect(firstNear.decision).toEqual({ kind: 'out_of_range' });

        const secondNear = step(firstNear.next, 11, 10, NOW - 1_000);
        expect(secondNear.decision).toEqual({ kind: 'arrive' });
        expect(secondNear.next).toEqual({
            stable: 'in_range',
            candidate: null,
            confirmations: 0,
            lastSampleTimestampMs: NOW - 1_000,
        });
    });

    it('does not let one far GPS sample eject an in-range driver through repeated renders', () => {
        const initialTs = NOW - 5_000;
        const initial: ArrivalRangeStabilityMemory = {
            stable: 'in_range',
            candidate: null,
            confirmations: 0,
            lastSampleTimestampMs: initialTs,
        };

        const farTs = NOW - 3_000;
        const firstFar = step(initial, 80, 10, farTs);
        expect(firstFar.decision).toEqual({ kind: 'arrive' });
        expect(firstFar.next).toEqual({
            stable: 'in_range',
            candidate: 'out_of_range',
            confirmations: 1,
            lastSampleTimestampMs: farTs,
        });

        const reactRerender = step(firstFar.next, 80, 10, farTs, NOW + 500);
        expect(reactRerender.decision).toEqual({ kind: 'arrive' });
        expect(reactRerender.next).toEqual(firstFar.next);

        const clockTick = step(reactRerender.next, 80, 10, farTs, NOW + 1_500);
        expect(clockTick.decision).toEqual({ kind: 'arrive' });
        expect(clockTick.next).toEqual(firstFar.next);

        const secondFarTs = NOW - 1_000;
        const secondDistinctFar = step(clockTick.next, 82, 10, secondFarTs, NOW + 1_500);
        expect(secondDistinctFar.decision).toEqual({ kind: 'out_of_range' });
        expect(secondDistinctFar.next).toEqual({
            stable: 'out_of_range',
            candidate: null,
            confirmations: 0,
            lastSampleTimestampMs: secondFarTs,
        });
    });

    it('does not flicker when distinct fixes alternate around the 15 m boundary', () => {
        let memory = INITIAL_ARRIVAL_RANGE_MEMORY;
        const decisions: string[] = [];
        const meters = [12, 18, 13, 20, 11, 19, 12];

        meters.forEach((distanceMeters, index) => {
            const timestampMs = NOW - 10_000 + (index * 1_000);
            const stabilized = step(memory, distanceMeters, 10, timestampMs);
            decisions.push(stabilized.decision.kind);
            memory = stabilized.next;
        });

        expect(decisions).not.toContain('out_of_range');
        expect(decisions).toContain('arrive');
        expect(memory.stable).toBe('in_range');
    });

    it('recovers immediately when a strict in-range fix follows one far outlier', () => {
        const initial: ArrivalRangeStabilityMemory = {
            stable: 'in_range',
            candidate: null,
            confirmations: 0,
            lastSampleTimestampMs: NOW - 5_000,
        };

        const firstFar = step(initial, 80, 10, NOW - 3_000);
        expect(firstFar.decision).toEqual({ kind: 'arrive' });
        expect(firstFar.next.candidate).toBe('out_of_range');
        expect(firstFar.next.confirmations).toBe(1);

        const recovered = step(firstFar.next, 12, 10, NOW - 1_000);
        expect(recovered.decision).toEqual({ kind: 'arrive' });
        expect(recovered.next).toEqual({
            stable: 'in_range',
            candidate: null,
            confirmations: 0,
            lastSampleTimestampMs: NOW - 1_000,
        });
    });

    it('uses reported accuracy so an uncertain fix does not eject an in-range driver', () => {
        const initial: ArrivalRangeStabilityMemory = {
            stable: 'in_range',
            candidate: null,
            confirmations: 0,
            lastSampleTimestampMs: NOW - 5_000,
        };
        const uncertain = step(initial, 45, 25, NOW - 1_000);
        expect(uncertain.decision).toEqual({ kind: 'arrive' });
        expect(uncertain.next.stable).toBe('in_range');
        expect(uncertain.next.candidate).toBeNull();
        expect(uncertain.next.lastSampleTimestampMs).toBe(NOW - 1_000);
    });

    it('does not hide stale or unavailable location behind the range memory', () => {
        const previous: ArrivalRangeStabilityMemory = {
            stable: 'in_range',
            candidate: null,
            confirmations: 0,
            lastSampleTimestampMs: NOW - 5_000,
        };

        expect(stabilizeArrivalLocation({
            reading: reading({ fix: { ...fixAtMeters(10), timestampMs: NOW - 120_001 } }),
            spot,
            nowMs: NOW,
            previous,
        }).decision).toEqual({ kind: 'override', reason: 'stale' });

        expect(stabilizeArrivalLocation({
            reading: reading({ fix: null, fault: 'unavailable' }),
            spot,
            nowMs: NOW,
            previous,
        }).decision).toEqual({ kind: 'override', reason: 'unavailable' });
    });
});

describe('finishArrivalLocationWait', () => {
    it('moves a still-pending reading to unavailable when the bounded wait ends', () => {
        const settled = finishArrivalLocationWait(reading());
        expect(settled).toEqual({ fix: null, fault: 'unavailable' });
        expect(classifyArrivalLocation({ reading: settled, spot, nowMs: NOW })).toEqual({
            kind: 'override',
            reason: 'unavailable',
        });
    });

    it('keeps a stale fix stale when the wait ends with nothing fresher', () => {
        const current = reading({ fix: fixAt(120_001) });
        expect(classifyArrivalLocation({
            reading: finishArrivalLocationWait(current),
            spot,
            nowMs: NOW,
        })).toEqual({ kind: 'override', reason: 'stale' });
    });

    it('keeps a fresh fix that arrived before the wait ended', () => {
        const current = reading({ fix: fixAt(1_000) });
        const settled = finishArrivalLocationWait(current);
        expect(settled).toEqual(current);
        expect(classifyArrivalLocation({ reading: settled, spot, nowMs: NOW })).toEqual({ kind: 'arrive' });
    });

    it('does not clamp a future platform timestamp onto the receipt time', () => {
        const fix = arrivalFixFromPosition(
            { coords: { latitude: spot.lat, longitude: spot.lng }, timestampMs: NOW + 60_000 },
            NOW,
        );
        expect(fix?.timestampMs).toBe(NOW + 60_000);
        expect(classifyArrivalLocation({
            reading: reading({ fix }),
            spot,
            nowMs: NOW,
        })).toEqual({ kind: 'override', reason: 'stale' });
    });

    it('leaves a late fix free to replace the unavailable fault', () => {
        const late = fixAt(500);
        expect(nextArrivalReading(
            { fix: null, fault: 'unavailable' },
            { type: 'fix', fix: late },
        )).toEqual({ fix: late, fault: null });
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

    it('preserves platform horizontal accuracy when it is available', () => {
        expect(arrivalFixFromPosition(
            { coords: { latitude: 40.7, longitude: -74, accuracy: 8.5 }, timestampMs: NOW },
            NOW,
        )).toEqual({ lat: 40.7, lng: -74, timestampMs: NOW, accuracyMeters: 8.5 });
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
