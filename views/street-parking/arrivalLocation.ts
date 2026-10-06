import { getDistance } from './utils';

/**
 * Client-only arrival confidence. Firestore Rules and markClaimArrived do
 * not read this. Override decisions carry a reason only — never coordinates
 * or Crowns. The arrival write stays the existing arrived_pending_outcome path.
 */
export const ARRIVAL_LOCATION_MAX_AGE_MS = 120_000;
/** ~50 feet. Same threshold the in-range arrive button already used. */
export const ARRIVAL_DISTANCE_KM = 0.015;
/**
 * Exit hysteresis for a driver who has already reached the arrival radius.
 * We do not flip back to "too far" on ordinary GPS drift around the 15 m edge.
 */
export const ARRIVAL_EXIT_DISTANCE_KM = 0.03;

export type ArrivalLocationFault = 'permission_denied' | 'unavailable';
export type ArrivalRangeMemory = 'unknown' | 'in_range' | 'out_of_range';
export type ArrivalRangeCandidate = 'in_range' | 'out_of_range';

export interface ArrivalRangeStabilityMemory {
    stable: ArrivalRangeMemory;
    candidate: ArrivalRangeCandidate | null;
    confirmations: number;
    /** Last distinct platform GPS sample consumed by the range state machine. */
    lastSampleTimestampMs: number | null;
}

export const INITIAL_ARRIVAL_RANGE_MEMORY: ArrivalRangeStabilityMemory = {
    stable: 'unknown',
    candidate: null,
    confirmations: 0,
    lastSampleTimestampMs: null,
};

/** Two consecutive fixes are required before the handoff UI changes range state. */
export const ARRIVAL_RANGE_CONFIRMATIONS = 2;

export interface ArrivalLocationFix {
    lat: number;
    lng: number;
    timestampMs: number;
    /** Horizontal accuracy radius reported by the platform, when available. */
    accuracyMeters?: number | null;
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
 * Stabilize the binary arrival boundary across successive GPS samples.
 *
 * Entering the arrival radius remains strict at 15 m. Once a driver has
 * reached it, ordinary drift does not immediately switch the UI back to the
 * warning state. We only exit the latched in-range state when the fix is
 * clearly beyond the 30 m exit radius after accounting for the platform's
 * reported horizontal accuracy.
 *
 * Stale / unavailable / denied readings are never hidden by the latch.
 */
export function stabilizeArrivalLocation(input: {
    reading: ArrivalLocationReading;
    spot: { lat: number; lng: number };
    nowMs: number;
    previous: ArrivalRangeStabilityMemory;
}): { decision: ArrivalLocationDecision; next: ArrivalRangeStabilityMemory } {
    const decision = classifyArrivalLocation(input);

    // Location faults/staleness remain immediate safety states. Do not let a
    // previous proximity latch hide them.
    if (decision.kind === 'override' || decision.kind === 'pending') {
        return { decision, next: INITIAL_ARRIVAL_RANGE_MEMORY };
    }

    const fix = input.reading.fix;
    if (!finiteFix(fix)) {
        return { decision: { kind: 'pending' }, next: INITIAL_ARRIVAL_RANGE_MEMORY };
    }

    const distanceKm = getDistance(fix.lat, fix.lng, input.spot.lat, input.spot.lng);
    const accuracyKm = Number.isFinite(fix.accuracyMeters as number) && (fix.accuracyMeters as number) > 0
        ? (fix.accuracyMeters as number) / 1000
        : 0;
    const definitelyOutsideKm = Math.max(0, distanceKm - accuracyKm);

    // Entering is intentionally strict at 15 m. Leaving an already in-range
    // state is intentionally stricter: one noisy fix cannot eject the driver
    // unless it is clearly beyond the 30 m exit radius after accounting for
    // horizontal accuracy.
    let signal: ArrivalRangeCandidate;
    if (distanceKm <= ARRIVAL_DISTANCE_KM) {
        signal = 'in_range';
    } else if (input.previous.stable === 'in_range' && definitelyOutsideKm <= ARRIVAL_EXIT_DISTANCE_KM) {
        signal = 'in_range';
    } else {
        signal = 'out_of_range';
    }

    const heldDecision = (): ArrivalLocationDecision => input.previous.stable === 'in_range'
        ? { kind: 'arrive' }
        : input.previous.stable === 'out_of_range'
            ? { kind: 'out_of_range' }
            : { kind: 'pending' };

    // React renders and the one-second freshness clock can re-run this function
    // many times for the exact same GeolocationPosition. A duplicate platform
    // timestamp is not new GPS evidence and must never advance confirmation.
    if (input.previous.lastSampleTimestampMs === fix.timestampMs) {
        return { decision: heldDecision(), next: input.previous };
    }

    // From the initial unknown state, a strict in-range fix is enough to make
    // arrival responsive. Once the UI has committed to either visible state,
    // however, require distinct consecutive evidence before crossing the
    // boundary in either direction. This prevents a single near GPS spike from
    // hiding the "not in range" warning only for it to reappear a moment later.
    if (input.previous.stable === 'unknown' && signal === 'in_range') {
        return {
            decision: { kind: 'arrive' },
            next: {
                stable: 'in_range',
                candidate: null,
                confirmations: 0,
                lastSampleTimestampMs: fix.timestampMs,
            },
        };
    }

    // A distinct sample that agrees with the visible state cancels any pending
    // transition and keeps the current decision stable.
    if (input.previous.stable === signal) {
        return {
            decision: signal === 'in_range' ? { kind: 'arrive' } : { kind: 'out_of_range' },
            next: {
                stable: signal,
                candidate: null,
                confirmations: 0,
                lastSampleTimestampMs: fix.timestampMs,
            },
        };
    }

    const confirmations = input.previous.candidate === signal
        ? input.previous.confirmations + 1
        : 1;

    // One contradictory GPS sample is never enough to change what the user
    // sees. This applies both to leaving an in-range state and to clearing an
    // already-visible out-of-range warning.
    if (confirmations < ARRIVAL_RANGE_CONFIRMATIONS) {
        return {
            decision: heldDecision(),
            next: {
                stable: input.previous.stable,
                candidate: signal,
                confirmations,
                lastSampleTimestampMs: fix.timestampMs,
            },
        };
    }

    return {
        decision: signal === 'in_range' ? { kind: 'arrive' } : { kind: 'out_of_range' },
        next: {
            stable: signal,
            candidate: null,
            confirmations: 0,
            lastSampleTimestampMs: fix.timestampMs,
        },
    };
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
    position: { coords: { latitude: number; longitude: number; accuracy?: number | null }; timestampMs?: number },
    receivedAtMs: number,
): ArrivalLocationFix | null {
    const lat = position.coords.latitude;
    const lng = position.coords.longitude;
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const reported = position.timestampMs;
    const timestampMs = typeof reported === 'number' && Number.isFinite(reported) && reported > 0
        ? reported
        : receivedAtMs;
    const fix: ArrivalLocationFix = { lat, lng, timestampMs };
    if (Number.isFinite(position.coords.accuracy as number)) {
        fix.accuracyMeters = position.coords.accuracy as number;
    }
    return fix;
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
