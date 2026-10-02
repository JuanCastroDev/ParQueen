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
