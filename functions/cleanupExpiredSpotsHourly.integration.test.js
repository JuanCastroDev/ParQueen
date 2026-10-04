'use strict';

/**
 * cleanupExpiredSpotsHourly — runtime-identity canary plus B1 durability.
 *
 * General expiry still deletes available, interested, and other non-arrival
 * Pings, including legacy occupied rows that are not arrived_pending_outcome.
 * occupied + arrived_pending_outcome is kept even after expiresAt. A closed
 * unconfirmed handoff is kept only when arrivedAt is a real timestamp.
 * Occupied + unconfirmed with no real arrivedAt still expires. The page
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
        expect(fn).toMatch(/isTerminalUnconfirmedHandoff/);
        expect(fn).not.toMatch(/source:\s*['"]system['"]/);
        const helperStart = src.indexOf('function isDurableArrivedPendingOutcome');
        const helper = src.slice(helperStart, start);
        expect(helper).toMatch(/function isDurableArrivedPendingOutcome/);
        expect(helper).toMatch(/claimState === "arrived_pending_outcome"/);
        expect(helper).toMatch(/isTimestampLike\(spot\.arrivedAt\)/);
        expect(helper).not.toMatch(/TWO_HOURS_MS/);
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

// Vitest runs larger files first. This file is larger than
// eventarcRetryHardening.integration.test.js, so these spot creates now
// finish immediately before that file. Each create still invokes
// incrementTotalSpotsPinged, which writes the shared stats/global counter
// after this file returns. That file's duplicate-delivery tests diff the
// same counter and expect exactly 1. The trigger backlog can sit quiet for
// a moment and then run, so a quiet counter is not enough: wait until this
// file's creates have all been counted, then until the counter stops. The
// expected delta stays 1.
let spotsCreated = 0;

async function createSpot(id, data) {
    spotsCreated += 1;
    await db.doc(`spots/${id}`).set(data);
}

function queueSpot(batch, id, data) {
    spotsCreated += 1;
    batch.set(db.doc(`spots/${id}`), data);
}

async function settleSpotCreateCounter(baseline) {
    if (spotsCreated === 0) return;
    const statsRef = db.doc('stats/global');
    let last = null;
    let stableReads = 0;
    for (let attempt = 0; attempt < 200; attempt++) {
        const current = (await statsRef.get()).data()?.totalSpotsPinged || 0;
        const caughtUp = current - baseline >= spotsCreated;
        if (caughtUp && current === last) {
            stableReads += 1;
            if (stableReads >= 4) return;
        } else {
            stableReads = 0;
            last = current;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const current = (await statsRef.get()).data()?.totalSpotsPinged || 0;
    throw new Error(`spot-create counter did not settle at ${current} after ${spotsCreated} creates from ${baseline}`);
}

describe('cleanupExpiredSpotsHourly durability', () => {
    let counterBaseline = 0;

    beforeAll(async () => {
        counterBaseline = (await db.doc('stats/global').get()).data()?.totalSpotsPinged || 0;
    });

    afterAll(async () => {
        await settleSpotCreateCounter(counterBaseline);
    }, 60000);

    it('CESH-3: keeps an expired arrived_pending_outcome Ping and still deletes ordinary expired Pings', async () => {
        const arrivedId = `cesh_arrived_${RUN}`;
        const availableId = `cesh_available_${RUN}`;
        const interestedId = `cesh_interested_${RUN}`;
        const legacyOccupiedId = `cesh_legacy_occupied_${RUN}`;
        const liveId = `cesh_live_${RUN}`;
        const arrivedAt = Timestamp.fromMillis(Date.now() - 30_000);

        await createSpot(arrivedId, spot({
            status: 'occupied',
            claimState: 'arrived_pending_outcome',
            arrivedAt,
            interestedUserId: 'claimer_x',
        }));
        await createSpot(availableId, spot({ status: 'available', claimState: null }));
        await createSpot(interestedId, spot({
            status: 'interested',
            claimState: 'heading',
            interestedUserId: 'claimer_y',
        }));
        await createSpot(legacyOccupiedId, spot({
            status: 'occupied',
            claimState: 'heading',
            interestedUserId: 'claimer_z',
        }));
        await createSpot(liveId, spot({ status: 'available', expiresAt: FUTURE }));

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
            queueSpot(batch, id, spot({
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
        queueSpot(batch, laterId, spot({
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

    it('CESH-5: keeps a real unconfirmed close and deletes occupied unconfirmed with no real arrivedAt', async () => {
        const closedId = `cesh_unconfirmed_${RUN}`;
        const missingId = `cesh_unconfirmed_missing_${RUN}`;
        const nulledId = `cesh_unconfirmed_null_${RUN}`;
        const malformedId = `cesh_unconfirmed_malformed_${RUN}`;
        const legacyId = `cesh_legacy_still_${RUN}`;
        const arrivedAt = Timestamp.fromMillis(Date.now() - 3 * 60 * 60_000);

        await createSpot(closedId, spot({
            status: 'occupied',
            claimState: 'unconfirmed',
            arrivedAt,
            interestedUserId: 'claimer_closed',
        }));
        const missing = spot({
            status: 'occupied',
            claimState: 'unconfirmed',
            interestedUserId: 'claimer_forged_missing',
        });
        delete missing.arrivedAt;
        await createSpot(missingId, missing);
        await createSpot(nulledId, spot({
            status: 'occupied',
            claimState: 'unconfirmed',
            arrivedAt: null,
            interestedUserId: 'claimer_forged_null',
        }));
        await createSpot(malformedId, spot({
            status: 'occupied',
            claimState: 'unconfirmed',
            arrivedAt: 'not-a-timestamp',
            interestedUserId: 'claimer_forged_string',
        }));
        await createSpot(legacyId, spot({
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
        expect((await db.doc(`spots/${missingId}`).get()).exists).toBe(false);
        expect((await db.doc(`spots/${nulledId}`).get()).exists).toBe(false);
        expect((await db.doc(`spots/${malformedId}`).get()).exists).toBe(false);
        expect((await db.doc(`spots/${legacyId}`).get()).exists).toBe(false);
    });
});
