'use strict';

/**
 * cleanupExpiredSpotsHourly — runtime-identity canary plus B1 durability.
 *
 * General expiry still deletes available, interested, and other non-arrival
 * Pings, including legacy occupied rows that are not arrived_pending_outcome.
 * occupied + arrived_pending_outcome is kept even after expiresAt. The page
 * cursor must advance past kept rows so a full page of them cannot loop.
 *
 * The cross-function trust-safety guarantee this function depends on — that
 * deleting an expired, still-'interested' spot does NOT trigger
 * updateTrustOnSpotDelete's handoffsCancelledByFinder penalty — is proved
 * at the trigger level in pingNotificationPrivacy.integration.test.js
 * ("Natural-expiration trust exemption" describe block, especially CASE 3
 * and BUG-REPRO). Every document this function deletes still satisfies
 * expiresAt <= query time, so that exemption still applies to its deletes.
 */

const fs = require('fs');
const path = require('path');

describe('cleanupExpiredSpotsHourly Function contract', () => {
    it('CESH-1: Runtime-IAM canary config-contract — cleanupExpiredSpotsHourly (Wave 7A-2) runs as the dedicated parqueen-cleanup identity', () => {
        const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const start = src.indexOf('exports.cleanupExpiredSpotsHourly = onSchedule(');
        expect(start).toBeGreaterThan(-1);
        const fn = src.slice(start, src.indexOf('exports.cleanupExpiredInterests', start));
        expect(fn).toMatch(/serviceAccount:\s*'parqueen-cleanup@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
    });

    it('CESH-2: source-contract — hourly expiry still pages by expiresAt and advances past kept arrivals', () => {
        const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const start = src.indexOf('exports.cleanupExpiredSpotsHourly = onSchedule(');
        const fn = src.slice(start, src.indexOf('exports.cleanupExpiredInterests', start));
        expect(fn).toMatch(/schedule:\s*"every 1 hours"/);
        expect(fn).toMatch(/timeZone:\s*"America\/Toronto"/);
        expect(fn).toMatch(/\.collection\("spots"\)/);
        expect(fn).toMatch(/\.where\("expiresAt",\s*"<=",\s*now\)/);
        expect(fn).toMatch(/\.orderBy\("expiresAt",\s*"asc"\)/);
        expect(fn).toMatch(/\.limit\(500\)/);
        expect(fn).toMatch(/\.startAfter\(cursor\)/);
        expect(fn).toMatch(/while \(true\)/);
        expect(fn).toMatch(/db\.batch\(\)/);
        expect(fn).toMatch(/isDurableArrivedPendingOutcome/);
        expect(fn).not.toMatch(/source:\s*['"]system['"]/);
    });
});

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { requireEmulatorProjectId } = require('./emulatorProjectId');

const PROJECT_ID = requireEmulatorProjectId();
const APP_NAME = '__cleanup_expired_spots_hourly_intg__';
const testApp = getApps().find((app) => app.name === APP_NAME) ?? initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const indexModule = require('./index.js');

const RUN = `${process.pid}_${Date.now()}`;
const PAST = Timestamp.fromMillis(Date.now() - 60_000);
const FUTURE = Timestamp.fromMillis(Date.now() + 60 * 60_000);
const ANCIENT = Timestamp.fromMillis(Date.UTC(2001, 0, 1));

function spot(overrides) {
    return {
        finderId: 'finder_x',
        finderName: 'Finder',
        address: '1 Expiry St',
        lat: 40.7,
        lng: -74.0,
        pingMode: 'now',
        reportedAt: PAST,
        expiresAt: PAST,
        testRun: RUN,
        ...overrides,
    };
}

describe('cleanupExpiredSpotsHourly durability', () => {
    it('CESH-3: keeps an expired arrived_pending_outcome Ping and still deletes ordinary expired Pings', async () => {
        const arrivedId = `cesh_arrived_${RUN}`;
        const availableId = `cesh_available_${RUN}`;
        const interestedId = `cesh_interested_${RUN}`;
        const legacyOccupiedId = `cesh_legacy_occupied_${RUN}`;
        const liveId = `cesh_live_${RUN}`;
        const arrivedAt = Timestamp.fromMillis(Date.now() - 30_000);

        await db.doc(`spots/${arrivedId}`).set(spot({
            status: 'occupied',
            claimState: 'arrived_pending_outcome',
            arrivedAt,
            interestedUserId: 'claimer_x',
        }));
        await db.doc(`spots/${availableId}`).set(spot({ status: 'available', claimState: null }));
        await db.doc(`spots/${interestedId}`).set(spot({
            status: 'interested',
            claimState: 'heading',
            interestedUserId: 'claimer_y',
        }));
        await db.doc(`spots/${legacyOccupiedId}`).set(spot({
            status: 'occupied',
            claimState: 'heading',
            interestedUserId: 'claimer_z',
        }));
        await db.doc(`spots/${liveId}`).set(spot({ status: 'available', expiresAt: FUTURE }));

        await indexModule.cleanupExpiredSpotsHourly.run();

        const arrived = await db.doc(`spots/${arrivedId}`).get();
        expect(arrived.exists).toBe(true);
        expect(arrived.data().status).toBe('occupied');
        expect(arrived.data().claimState).toBe('arrived_pending_outcome');
        expect(arrived.data().arrivedAt.toMillis()).toBe(arrivedAt.toMillis());
        expect((await db.doc(`spots/${availableId}`).get()).exists).toBe(false);
        expect((await db.doc(`spots/${interestedId}`).get()).exists).toBe(false);
        expect((await db.doc(`spots/${legacyOccupiedId}`).get()).exists).toBe(false);
        expect((await db.doc(`spots/${liveId}`).get()).exists).toBe(true);

        await indexModule.cleanupExpiredSpotsHourly.run();
        const stillThere = await db.doc(`spots/${arrivedId}`).get();
        expect(stillThere.exists).toBe(true);
        expect(stillThere.data().claimState).toBe('arrived_pending_outcome');
    });

    it('CESH-4: a full page of expired arrived rows does not stall cleanup of a later expired Ping', async () => {
        const pageIds = Array.from({ length: 500 }, (_, i) => `cesh_page_${RUN}_${i}`);
        const laterId = `cesh_after_page_${RUN}`;
        let batch = db.batch();
        pageIds.forEach((id, index) => {
            batch.set(db.doc(`spots/${id}`), spot({
                status: 'occupied',
                claimState: 'arrived_pending_outcome',
                arrivedAt: ANCIENT,
                interestedUserId: 'claimer_page',
                expiresAt: ANCIENT,
                address: `page ${index}`,
            }));
        });
        await batch.commit();
        batch = db.batch();
        batch.set(db.doc(`spots/${laterId}`), spot({
            status: 'available',
            claimState: null,
            expiresAt: Timestamp.fromMillis(ANCIENT.toMillis() + 1),
        }));
        await batch.commit();

        await indexModule.cleanupExpiredSpotsHourly.run();

        const kept = await db.getAll(...pageIds.map((id) => db.doc(`spots/${id}`)));
        expect(kept.every((snap) => snap.exists && snap.data().claimState === 'arrived_pending_outcome')).toBe(true);
        expect((await db.doc(`spots/${laterId}`).get()).exists).toBe(false);
    }, 60000);

    it('CESH-5: keeps a closed unconfirmed handoff and still deletes a legacy occupied Ping', async () => {
        const closedId = `cesh_unconfirmed_${RUN}`;
        const legacyId = `cesh_legacy_still_${RUN}`;
        const arrivedAt = Timestamp.fromMillis(Date.now() - 3 * 60 * 60_000);

        await db.doc(`spots/${closedId}`).set(spot({
            status: 'occupied',
            claimState: 'unconfirmed',
            arrivedAt,
            interestedUserId: 'claimer_closed',
        }));
        await db.doc(`spots/${legacyId}`).set(spot({
            status: 'occupied',
            claimState: 'heading',
            interestedUserId: 'claimer_legacy',
        }));

        await indexModule.cleanupExpiredSpotsHourly.run();

        const closed = await db.doc(`spots/${closedId}`).get();
        expect(closed.exists).toBe(true);
        expect(closed.data().claimState).toBe('unconfirmed');
        expect(closed.data().status).toBe('occupied');
        expect(closed.data().arrivedAt.toMillis()).toBe(arrivedAt.toMillis());
        expect((await db.doc(`spots/${legacyId}`).get()).exists).toBe(false);
    });
});
