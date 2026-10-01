import { describe, expect, it } from 'vitest';
import { filterVisibleSpots } from './filterVisibleSpots';

function spot(overrides: Partial<{ status: string; expiresAtMs: number; finderId: string; interestedUserId: string }>) {
    return {
        id: 'x',
        status: 'available',
        expiresAtMs: Date.now() + 60_000,
        finderId: 'other',
        interestedUserId: null,
        ...overrides,
    };
}

const now = Date.now();
const FUTURE = now + 60_000;
const PAST = now - 60_000;

// Minimal Firestore-Timestamp-shaped fake for the fields this function reads.
function withExpiresAt(s: ReturnType<typeof spot>) {
    return { ...s, expiresAt: { toMillis: () => s.expiresAtMs } };
}

describe('filterVisibleSpots', () => {
    it('CASE 17: an available nearby spot appears', () => {
        const docs = [withExpiresAt(spot({ status: 'available', expiresAtMs: FUTURE }))];
        const result = filterVisibleSpots(docs, 'me', [], now);
        expect(result).toHaveLength(1);
    });

    it('CASE 18: an interested nearby spot appears when it belongs to the current user (finder or interested party)', () => {
        const asFinder = withExpiresAt(spot({ status: 'interested', expiresAtMs: FUTURE, finderId: 'me' }));
        const asInterested = withExpiresAt(spot({ status: 'interested', expiresAtMs: FUTURE, finderId: 'other', interestedUserId: 'me' }));
        expect(filterVisibleSpots([asFinder], 'me', [], now)).toHaveLength(1);
        expect(filterVisibleSpots([asInterested], 'me', [], now)).toHaveLength(1);
    });

    it('CASE 19: a wrong-status spot (occupied) is excluded', () => {
        const docs = [withExpiresAt(spot({ status: 'occupied', expiresAtMs: FUTURE }))];
        expect(filterVisibleSpots(docs, 'me', [], now)).toHaveLength(0);
    });

    it("an 'interested' spot belonging to someone else entirely is excluded", () => {
        const docs = [withExpiresAt(spot({ status: 'interested', expiresAtMs: FUTURE, finderId: 'other', interestedUserId: 'someone-else' }))];
        expect(filterVisibleSpots(docs, 'me', [], now)).toHaveLength(0);
    });

    it('CASE 20: an expired spot is excluded per the current subscription-time client check', () => {
        const docs = [withExpiresAt(spot({ status: 'available', expiresAtMs: PAST }))];
        expect(filterVisibleSpots(docs, 'me', [], now)).toHaveLength(0);
    });

    it('excludes a spot from a blocked user', () => {
        const docs = [withExpiresAt(spot({ status: 'available', expiresAtMs: FUTURE, finderId: 'blocked-user' }))];
        expect(filterVisibleSpots(docs, 'me', ['blocked-user'], now)).toHaveLength(0);
    });

    it('BU-16: a blocked user Ping stays hidden while blocked', () => {
        const docs = [withExpiresAt(spot({ status: 'available', expiresAtMs: FUTURE, finderId: 'blocked-user' }))];
        expect(filterVisibleSpots(docs, 'me', ['blocked-user'], now)).toHaveLength(0);
    });

    it('BU-17: removing the UID lets an otherwise-eligible Ping become visible again', () => {
        const docs = [withExpiresAt(spot({ status: 'available', expiresAtMs: FUTURE, finderId: 'blocked-user' }))];
        expect(filterVisibleSpots(docs, 'me', [], now)).toHaveLength(1);
    });

    it('preserves all fields on the returned spot (id, status, etc.)', () => {
        const docs = [withExpiresAt(spot({ status: 'available', expiresAtMs: FUTURE }))];
        const [result] = filterVisibleSpots(docs, 'me', [], now);
        expect(result.id).toBe('x');
        expect(result.status).toBe('available');
    });
});
