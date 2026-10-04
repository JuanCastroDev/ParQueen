import { getDistance } from './utils';

/**
 * Client-only arrival confidence. Firestore Rules and markClaimArrived do
 * not read this. Override decisions carry a reason only — never coordinates
 * or Crowns. The arrival write stays the existing arrived_pending_outcome path.
 */
export const ARRIVAL_LOCATION_MAX_AGE_MS = 120_000;
/** ~50 feet. Same threshold the in-range arrive button already used. */
export const ARRIVAL_DISTANCE_KM = 0.015;

export type ArrivalLocationFault = 'permission_denied' | 'unavailable';

export interface ArrivalLocationFix {
    lat: number;
    lng: number;
    timestampMs: number;
}

export interface ArrivalLocationReading {
    fix: ArrivalLocationFix | null;
    fault: ArrivalLocationFault | null;
}

export type ArrivalLocationDecision =
    | { kind: 'pending' }
    | { kind: 'arrive' }
    | { kind: 'out_of_range' }
    | { kind: 'override'; reason: 'stale' | 'unavailable' | 'permission_denied' };

const finiteFix = (fix: ArrivalLocationFix | null): fix is ArrivalLocationFix =>
    !!fix
    && Number.isFinite(fix.lat)
    && Number.isFinite(fix.lng)
    && Number.isFinite(fix.timestampMs);

/**
 * Healthy means a usable fix whose timestamp is not in the future and is
 * not older than 120 seconds. Exactly 120_000 ms old is still healthy.
 * A future device timestamp is not rewritten to "now"; it is not fresh.
 * A fresh fix wins over a stored fault. A missing fix uses the fault.
 * No fix and no fault is still pending — not an override.
 */
export function classifyArrivalLocation(input: {
    reading: ArrivalLocationReading;
    spot: { lat: number; lng: number };
    nowMs: number;
}): ArrivalLocationDecision {
    const { reading, spot, nowMs } = input;
    if (finiteFix(reading.fix)) {
        const ageMs = nowMs - reading.fix.timestampMs;
        if (ageMs < 0 || ageMs > ARRIVAL_LOCATION_MAX_AGE_MS) {
            return { kind: 'override', reason: 'stale' };
        }
        const distanceKm = getDistance(reading.fix.lat, reading.fix.lng, spot.lat, spot.lng);
        if (distanceKm <= ARRIVAL_DISTANCE_KM) return { kind: 'arrive' };
        return { kind: 'out_of_range' };
    }
    if (reading.fault === 'permission_denied') return { kind: 'override', reason: 'permission_denied' };
    if (reading.fault === 'unavailable') return { kind: 'override', reason: 'unavailable' };
    return { kind: 'pending' };
}

/**
 * The map's bounded location wait. A fix or an existing fault is left
 * alone, so a fresh fix still wins and a late fix can replace this.
 * Pending, with nothing usable yet, becomes unavailable.
 */
export function finishArrivalLocationWait(
    current: ArrivalLocationReading,
): ArrivalLocationReading {
    if (finiteFix(current.fix) || current.fault) return current;
    return { fix: null, fault: 'unavailable' };
}

/** Prefer the platform timestamp. A missing or non-positive stamp uses receipt time. */
export function arrivalFixFromPosition(
    position: { coords: { latitude: number; longitude: number }; timestampMs?: number },
    receivedAtMs: number,
): ArrivalLocationFix | null {
    const lat = position.coords.latitude;
    const lng = position.coords.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const reported = position.timestampMs;
    const timestampMs = typeof reported === 'number' && Number.isFinite(reported) && reported > 0
        ? reported
        : receivedAtMs;
    return { lat, lng, timestampMs };
}

/**
 * Permission denial drops the last fix so it cannot stay a healthy arrive.
 * Any other failure keeps a fix the classifier can still treat as fresh.
 */
export function nextArrivalReading(
    current: ArrivalLocationReading,
    event: { type: 'fix'; fix: ArrivalLocationFix } | { type: 'error'; kind: string },
): ArrivalLocationReading {
    if (event.type === 'fix') return { fix: event.fix, fault: null };
    if (event.kind === 'permission') return { fix: null, fault: 'permission_denied' };
    return { fix: current.fix, fault: 'unavailable' };
}
