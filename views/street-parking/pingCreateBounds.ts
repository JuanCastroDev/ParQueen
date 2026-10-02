import { doc, runTransaction, Timestamp } from 'firebase/firestore';
import { PING_LIVE_TTL_MS } from '../../utils/pingLifecycle';

/** Locked product cap: reportedAt may be at most 12 hours ahead of trusted time. */
export const PING_SCHEDULE_HORIZON_MS = 12 * 60 * 60 * 1000;

/** Locked product cap: 5 Ping creates per rolling hour per user. */
export const PING_CREATE_LIMIT = 5;

/** Rolling window that matches the client checkPingRateLimit hour. */
export const PING_CREATE_WINDOW_MS = 60 * 60 * 1000;

export function isReportedAtWithinHorizon(reportedAtMs: number, nowMs = Date.now()): boolean {
    return Number.isFinite(reportedAtMs) && reportedAtMs <= nowMs + PING_SCHEDULE_HORIZON_MS;
}

/**
 * Same create-time relationship Rules enforce. Honest clients already set
 * expiresAt = reportedAt + PING_LIVE_TTL_MS; this rejects anything wider.
 * Deny, do not clamp.
 */
export function isPingLifetimeWithinBounds(
    reportedAtMs: number,
    expiresAtMs: number,
    nowMs = Date.now(),
): boolean {
    if (!Number.isFinite(reportedAtMs) || !Number.isFinite(expiresAtMs)) return false;
    if (!isReportedAtWithinHorizon(reportedAtMs, nowMs)) return false;
    if (expiresAtMs <= nowMs) return false;
    if (expiresAtMs - reportedAtMs > PING_LIVE_TTL_MS) return false;
    if (reportedAtMs <= nowMs && expiresAtMs - nowMs > PING_LIVE_TTL_MS) return false;
    return true;
}

export type PingCreateRejectReason = 'horizon' | 'ttl' | 'rate' | 'origin';

/** Deny, do not clamp. minutesLeft is set for a rolling-hour rate denial. */
export class PingCreateRejected extends Error {
    readonly reason: PingCreateRejectReason;
    readonly minutesLeft?: number;

    constructor(reason: PingCreateRejectReason, minutesLeft?: number) {
        super(reason);
        this.name = 'PingCreateRejected';
        this.reason = reason;
        this.minutesLeft = minutesLeft;
    }
}

export interface PingRateState {
    spotIds: string[];
    createdAtsMs: number[];
}

/**
 * Drop the expired prefix and append this create. Throws once five creates
 * in the rolling hour would be exceeded. Order matches the Rules carry check:
 * entries are append-only, so expired ones are always a prefix.
 */
export function advancePingRate(state: PingRateState | null, spotId: string, nowMs: number): PingRateState {
    const spotIds = state?.spotIds ?? [];
    const createdAtsMs = state?.createdAtsMs ?? [];
    const windowStart = nowMs - PING_CREATE_WINDOW_MS;
    let start = 0;
    while (start < createdAtsMs.length && createdAtsMs[start] < windowStart) start += 1;
    if (createdAtsMs.length - start >= PING_CREATE_LIMIT) {
        const oldest = createdAtsMs[start];
        const minutesLeft = Math.max(1, Math.ceil((oldest + PING_CREATE_WINDOW_MS - nowMs) / 60000));
        throw new PingCreateRejected('rate', minutesLeft);
    }
    return {
        spotIds: [...spotIds.slice(start), spotId],
        createdAtsMs: [...createdAtsMs.slice(start), nowMs],
    };
}

export interface CommitPingCreateParams {
    uid: string;
    spotRef: any;
    data: Record<string, unknown>;
    deleteRefs?: any[];
    originSpotId?: string | null;
}

/**
 * Atomically writes the Ping, the rolling-hour quota doc, and — for a
 * departure re-ping — the create-once origin marker. Rules are the authority;
 * this helper only builds the same-commit shape they require.
 */
export async function commitPingCreate(db: any, params: CommitPingCreateParams): Promise<void> {
    const reportedAt = params.data.reportedAt as { toMillis?: () => number } | undefined;
    const expiresAt = params.data.expiresAt as { toMillis?: () => number } | undefined;
    const reportedAtMs = reportedAt?.toMillis?.();
    const expiresAtMs = expiresAt?.toMillis?.();
    if (reportedAtMs == null || expiresAtMs == null || !isPingLifetimeWithinBounds(reportedAtMs, expiresAtMs)) {
        throw new PingCreateRejected(
            reportedAtMs != null && !isReportedAtWithinHorizon(reportedAtMs) ? 'horizon' : 'ttl',
        );
    }

    const rateRef = doc(db, 'users', params.uid, 'pingCreateRate', 'current');
    const originRef = params.originSpotId ? doc(db, 'originRePings', params.originSpotId) : null;

    await runTransaction(db, async (tx) => {
        const rateSnap = await tx.get(rateRef);
        const originSnap = originRef ? await tx.get(originRef) : null;
        if (originSnap?.exists()) throw new PingCreateRejected('origin');

        const now = Timestamp.now();
        const prev = rateSnap.exists()
            ? {
                spotIds: (rateSnap.data().spotIds ?? []) as string[],
                createdAtsMs: ((rateSnap.data().createdAts ?? []) as Array<{ toMillis: () => number }>)
                    .map((stamp) => stamp.toMillis()),
            }
            : null;
        const next = advancePingRate(prev, params.spotRef.id, now.toMillis());
        for (const ref of params.deleteRefs ?? []) tx.delete(ref);
        tx.set(params.spotRef, params.data);
        tx.set(rateRef, {
            spotIds: next.spotIds,
            createdAts: next.createdAtsMs.map((ms) => Timestamp.fromMillis(ms)),
        });
        if (originRef) {
            tx.set(originRef, {
                rePingSpotId: params.spotRef.id,
                finderId: params.uid,
                createdAt: now,
            });
        }
    });
}
