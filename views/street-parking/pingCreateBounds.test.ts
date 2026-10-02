import { describe, expect, it } from 'vitest';
import { PING_LIVE_TTL_MS } from '../../utils/pingLifecycle';
import {
    PING_CREATE_LIMIT,
    PING_SCHEDULE_HORIZON_MS,
    PingCreateRejected,
    advancePingRate,
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

describe('advancePingRate', () => {
    const NOW = 1_700_000_000_000;

    it('appends the first five creates in the rolling hour', () => {
        let state = advancePingRate(null, 's1', NOW);
        for (let i = 2; i <= 5; i += 1) {
            state = advancePingRate(state, `s${i}`, NOW + i * 1000);
        }
        expect(state.spotIds).toEqual(['s1', 's2', 's3', 's4', 's5']);
    });

    it('denies the 6th create inside the hour', () => {
        let state = advancePingRate(null, 's1', NOW);
        for (let i = 2; i <= 5; i += 1) state = advancePingRate(state, `s${i}`, NOW + i * 1000);
        expect(() => advancePingRate(state, 's6', NOW + 10_000)).toThrow(PingCreateRejected);
        try {
            advancePingRate(state, 's6', NOW + 10_000);
        } catch (error) {
            expect(error).toBeInstanceOf(PingCreateRejected);
            expect((error as PingCreateRejected).reason).toBe('rate');
        }
    });

    it('drops an expired prefix so a later create is allowed', () => {
        const state = advancePingRate({
            spotIds: ['old', 'recent'],
            createdAtsMs: [NOW - 2 * 60 * 60 * 1000, NOW - 1000],
        }, 'new', NOW);
        expect(state.spotIds).toEqual(['recent', 'new']);
    });

    it('does not treat a second origin-style id as free quota', () => {
        let state = advancePingRate(null, 'origin-rep', NOW);
        for (let i = 0; i < 4; i += 1) state = advancePingRate(state, `p${i}`, NOW + i);
        expect(state.spotIds).toHaveLength(5);
        expect(() => advancePingRate(state, 'another-origin', NOW + 50)).toThrow(PingCreateRejected);
    });
});
