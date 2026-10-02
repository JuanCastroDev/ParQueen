import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Pre-creates the composite index required by the future bounded
// spots-listener migration (geoQuery.ts / #57), proven against real
// production Firestore during a geoquery-feasibility audit: combining
// where(status in [...]) + where(expiresAt > now) + where(geohash range)
// returns FAILED_PRECONDITION without exactly this index. Not wired into
// any live query yet — this PR only pre-creates the index so it can reach
// READY before a future client depends on it.
describe('firestore.indexes.json — spots geoquery index', () => {
    const config = JSON.parse(readFileSync(new URL('./firestore.indexes.json', import.meta.url), 'utf8'));
    const spotsIndexes = config.indexes.filter((i: any) => i.collectionGroup === 'spots');

    const geoIndex = spotsIndexes.find((i: any) =>
        i.fields.some((f: any) => f.fieldPath === 'geohash'),
    );

    it('exists exactly once for the spots collection group', () => {
        const matches = spotsIndexes.filter((i: any) => i.fields.some((f: any) => f.fieldPath === 'geohash'));
        expect(matches).toHaveLength(1);
    });

    it('has COLLECTION query scope', () => {
        expect(geoIndex.queryScope).toBe('COLLECTION');
    });

    it('orders fields as status, geohash, expiresAt (matching the production-decoded requirement)', () => {
        expect(geoIndex.fields.map((f: any) => f.fieldPath)).toEqual(['status', 'geohash', 'expiresAt']);
    });

    it('every field is ASCENDING (matching the query — an IN filter and two range filters all read ascending)', () => {
        for (const f of geoIndex.fields) {
            expect(f.order).toBe('ASCENDING');
        }
    });

    it('does not declare an explicit __name__ field (all-ascending index relies on the implicit default)', () => {
        expect(geoIndex.fields.some((f: any) => f.fieldPath === '__name__')).toBe(false);
    });

    it('does not remove or reorder any pre-existing spots index', () => {
        const otherSpotsIndexFieldSets = spotsIndexes
            .filter((i: any) => i !== geoIndex)
            .map((i: any) => i.fields.map((f: any) => f.fieldPath).join(','));
        expect(otherSpotsIndexFieldSets).toEqual([
            'finderId,reportedAt',
            'status,expiresAt',
            'status,interestExpiresAt',
            'status,claimState,claimReminderAt',
            'status,claimState,claimAutoReleaseAt',
            'holdRequestStatus,status,holdTimerExpiresAt',
        ]);
    });
});

// Pre-creates the composite index the future bounded ProfileView
// RecentActivity query will need: where(userId == uid).orderBy(createdAt,
// 'desc').limit(3). RecentActivity's spotFeedback-derived items are not
// outcome-filtered (every feedback doc becomes a "Parked" item regardless of
// success/failure — this index must not change that), so the index is only
// (userId, createdAt), not (userId, outcome, createdAt). Not wired into any
// live query yet — this PR only pre-creates the index so it can reach READY
// before a future client depends on it.
describe('firestore.indexes.json — spotFeedback recent-activity index', () => {
    const config = JSON.parse(readFileSync(new URL('./firestore.indexes.json', import.meta.url), 'utf8'));
    const feedbackIndexes = config.indexes.filter((i: any) => i.collectionGroup === 'spotFeedback');

    it('exists exactly once for the spotFeedback collection group', () => {
        expect(feedbackIndexes).toHaveLength(1);
    });

    it('has COLLECTION query scope', () => {
        expect(feedbackIndexes[0].queryScope).toBe('COLLECTION');
    });

    it('orders fields as userId, createdAt (matching where(userId==).orderBy(createdAt))', () => {
        expect(feedbackIndexes[0].fields.map((f: any) => f.fieldPath)).toEqual(['userId', 'createdAt']);
    });

    it('userId is ASCENDING and createdAt is DESCENDING (matching orderBy(createdAt, "desc"))', () => {
        expect(feedbackIndexes[0].fields).toEqual([
            { fieldPath: 'userId', order: 'ASCENDING' },
            { fieldPath: 'createdAt', order: 'DESCENDING' },
        ]);
    });

    it('does not declare an explicit __name__ field', () => {
        expect(feedbackIndexes[0].fields.some((f: any) => f.fieldPath === '__name__')).toBe(false);
    });
});
