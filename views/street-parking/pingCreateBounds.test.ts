import { describe, expect, it } from 'vitest';
import { PING_LIVE_TTL_MS } from '../../utils/pingLifecycle';
import {
    PING_CREATE_LIMIT,
    PING_SCHEDULE_HORIZON_MS,
    isPingLifetimeWithinBounds,
    isReportedAtWithinHorizon,
} from './pingCreateBounds';

const NOW = 1_700_000_000_000;

describe('ping create lifetime bounds', () => {
    it('accepts an honest 30-minute live Ping', () => {
        expect(isPingLifetimeWithinBounds(NOW, NOW + PING_LIVE_TTL_MS, NOW)).toBe(true);
    });

    it('rejects expiresAt more than 30 minutes after reportedAt', () => {
        expect(isPingLifetimeWithinBounds(NOW, NOW + PING_LIVE_TTL_MS + 1, NOW)).toBe(false);
    });

    it('accepts a shortened live window when reportedAt is already in the past', () => {
        const reportedAt = NOW - 10 * 60 * 1000;
        expect(isPingLifetimeWithinBounds(reportedAt, reportedAt + PING_LIVE_TTL_MS, NOW)).toBe(true);
    });

    it('accepts a scheduled Ping whose departure is inside 12 hours and whose live window is 30 minutes', () => {
        const reportedAt = NOW + PING_SCHEDULE_HORIZON_MS;
        expect(isReportedAtWithinHorizon(reportedAt, NOW)).toBe(true);
        expect(isPingLifetimeWithinBounds(reportedAt, reportedAt + PING_LIVE_TTL_MS, NOW)).toBe(true);
    });

    it('rejects reportedAt beyond the 12-hour horizon', () => {
        const reportedAt = NOW + PING_SCHEDULE_HORIZON_MS + 1;
        expect(isReportedAtWithinHorizon(reportedAt, NOW)).toBe(false);
        expect(isPingLifetimeWithinBounds(reportedAt, reportedAt + PING_LIVE_TTL_MS, NOW)).toBe(false);
    });

    it('keeps the server create cap at the existing client number', () => {
        expect(PING_CREATE_LIMIT).toBe(5);
    });
});
