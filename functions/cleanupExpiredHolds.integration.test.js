'use strict';

/**
 * cleanupExpiredHolds exercises the real scheduled handler via .run() against
 * the Firestore emulator (no mocks). The accepted-hold pass commits a single
 * db.batch() over the initial query snapshot — idempotency there comes from
 * the QUERY itself excluding already-reverted docs. The pending-hold pass
 * re-reads each candidate in a transaction and clears hold-request fields
 * only; a second run does not select those docs again.
 */

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const fs = require('fs');
const path = require('path');

const { requireEmulatorProjectId } = require('./emulatorProjectId');
const PROJECT_ID = requireEmulatorProjectId();
const APP_NAME = '__cleanup_expired_holds_intg__';
const testApp = getApps().find(app => app.name === APP_NAME) ?? initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const indexModule = require('./index.js');

const RUN = `${process.pid}_${Date.now()}`;
let sequence = 0;
const nextId = label => `ceh_${label}_${RUN}_${++sequence}`;

const PAST = Timestamp.fromMillis(Date.now() - 60_000);
const FUTURE = Timestamp.fromMillis(Date.now() + 60 * 60_000);

function heldSpot(overrides = {}) {
    return {
        finderId: 'finder_x',
        finderName: 'Finder',
        address: '1 Test St',
        lat: 40.7,
        lng: -74.0,
        status: 'claimed',
        holdRequestStatus: 'accepted',
        claimedBy: 'claimant_x',
        holdTimerExpiresAt: PAST, // hold expired
        holdRequestedBy: 'requester_x',
        holdRequestedByName: 'Requester',
        holdRequestExpiresAt: FUTURE,
        ...overrides,
    };
}

async function getSpot(id) {
    return (await db.doc(`spots/${id}`).get()).data();
}

describe('cleanupExpiredHolds Function contract', () => {
    it('CEH-1: query is a bounded (limit 500) scan of spots(status, holdRequestStatus, holdTimerExpiresAt), committed via a single batch', () => {
        const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const start = src.indexOf('exports.cleanupExpiredHolds');
        const fn = src.slice(start, start + 1600);
        expect(fn).toMatch(/\.collection\("spots"\)/);
        expect(fn).toMatch(/\.where\("status",\s*"==",\s*"claimed"\)/);
        expect(fn).toMatch(/\.where\("holdRequestStatus",\s*"==",\s*"accepted"\)/);
        expect(fn).toMatch(/\.where\("holdTimerExpiresAt",\s*"<=",\s*now\)/);
        expect(fn).toMatch(/\.limit\(500\)/);
        expect(fn).not.toMatch(/\.limit\(100\)/);
        expect(fn).toMatch(/db\.batch\(\)/);
    });

    it('CEH-2: an expired hold is reverted — status/holdRequestStatus flip and all hold-request fields are cleared', async () => {
        const id = nextId('revert');
        await db.doc(`spots/${id}`).set(heldSpot());
        await indexModule.cleanupExpiredHolds.run();

        const spot = await getSpot(id);
        expect(spot.status).toBe('available');
        expect(spot.holdRequestStatus).toBe('declined');
        expect(spot.claimedBy).toBeNull();
        expect(spot.holdTimerExpiresAt).toBeNull();
        expect(spot.holdRequestedBy).toBeNull();
        expect(spot.holdRequestedByName).toBeNull();
        expect(spot.holdRequestExpiresAt).toBeNull();
        expect(spot.updatedAt).toBeTruthy();
    });

    it('CEH-3: a hold whose timer has not yet expired is completely untouched', async () => {
        const id = nextId('notexpired');
        await db.doc(`spots/${id}`).set(heldSpot({ holdTimerExpiresAt: FUTURE }));
        await indexModule.cleanupExpiredHolds.run();

        const spot = await getSpot(id);
        expect(spot.status).toBe('claimed');
        expect(spot.holdRequestStatus).toBe('accepted');
        expect(spot.claimedBy).toBe('claimant_x');
    });

    it('CEH-4: a spot not in "claimed" status is untouched even with an expired hold timer', async () => {
        const id = nextId('wrongstatus');
        await db.doc(`spots/${id}`).set(heldSpot({ status: 'available' }));
        await indexModule.cleanupExpiredHolds.run();

        const spot = await getSpot(id);
        expect(spot.status).toBe('available');
        expect(spot.holdRequestStatus).toBe('accepted'); // untouched
    });

    it('CEH-5: a spot whose hold request is not yet "accepted" is untouched', async () => {
        const id = nextId('pending');
        await db.doc(`spots/${id}`).set(heldSpot({ holdRequestStatus: 'pending' }));
        await indexModule.cleanupExpiredHolds.run();

        const spot = await getSpot(id);
        expect(spot.status).toBe('claimed');
        expect(spot.holdRequestStatus).toBe('pending');
    });

    it('CEH-6: a spot with no holdTimerExpiresAt field at all (malformed/legacy) is never touched', async () => {
        const id = nextId('malformed');
        const seed = heldSpot();
        delete seed.holdTimerExpiresAt;
        await db.doc(`spots/${id}`).set(seed);
        await indexModule.cleanupExpiredHolds.run();

        const spot = await getSpot(id);
        expect(spot.status).toBe('claimed');
        expect(spot.holdRequestStatus).toBe('accepted');
    });

    it('CEH-7: retrying the run is idempotent — a second invocation is a safe no-op on an already-reverted spot', async () => {
        const id = nextId('retry');
        await db.doc(`spots/${id}`).set(heldSpot());
        await indexModule.cleanupExpiredHolds.run();
        const afterFirst = await getSpot(id);

        await indexModule.cleanupExpiredHolds.run();
        const afterSecond = await getSpot(id);

        expect(afterFirst.status).toBe('available');
        expect(afterSecond).toEqual(afterFirst); // no further change — no longer matches the query
    });

    it('CEH-8: Runtime-IAM canary config-contract — cleanupExpiredHolds (Wave 7A-1) runs as the dedicated parqueen-cleanup identity', () => {
        const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const start = src.indexOf('exports.cleanupExpiredHolds');
        const fn = src.slice(start, start + 400);
        expect(fn).toMatch(/serviceAccount:\s*'parqueen-cleanup@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
    });

    it('CEH-9: pending-pass source clears hold-request fields only (no status write, no activeIncomingClaims)', () => {
        const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const start = src.indexOf('async function releaseExpiredPendingHoldRequests');
        expect(start).toBeGreaterThan(-1);
        const fn = src.slice(start, src.indexOf('function localizeNotification', start));
        const updateStart = fn.indexOf('tx.update');
        const update = fn.slice(updateStart, fn.indexOf('return true', updateStart));
        expect(update).toMatch(/holdRequestedBy:\s*null/);
        expect(update).toMatch(/holdRequestedByName:\s*null/);
        expect(update).toMatch(/holdRequestExpiresAt:\s*null/);
        expect(update).toMatch(/holdRequestStatus:\s*null/);
        expect(update).not.toMatch(/activeIncomingClaims/);
        expect(update).not.toMatch(/status:/);
        expect(fn).not.toMatch(/activeIncomingClaims/);
        expect(fn).not.toMatch(/status:\s*['"]available['"]/);
        expect(fn).toMatch(/\.limit\(500\)/);
    });

    it('CEH-10: an unexpired pending hold on a live Ping is left in place', async () => {
        const id = nextId('pending-fresh');
        await db.doc(`spots/${id}`).set(livePendingSpot({ holdRequestExpiresAt: FUTURE }));
        await indexModule.cleanupExpiredHolds.run();

        const spot = await getSpot(id);
        expect(spot.status).toBe('available');
        expect(spot.holdRequestStatus).toBe('pending');
        expect(spot.holdRequestedBy).toBe('requester_pending');
        expect(spot.expiresAt.toMillis()).toBe(FUTURE.toMillis());
    });

    it('CEH-11: a stale pending hold with no holdRequestExpiresAt is cleared without reopening or deleting the Ping', async () => {
        const id = nextId('pending-stale');
        const seed = livePendingSpot();
        delete seed.holdRequestExpiresAt;
        await db.doc(`spots/${id}`).set(seed);
        await indexModule.cleanupExpiredHolds.run();

        const spotSnap = await db.doc(`spots/${id}`).get();
        expect(spotSnap.exists).toBe(true);
        const spot = spotSnap.data();
        expect(spot.status).toBe('available');
        expect(spot.expiresAt.toMillis()).toBe(FUTURE.toMillis());
        expect(spot.holdRequestedBy).toBeNull();
        expect(spot.holdRequestedByName).toBeNull();
        expect(spot.holdRequestExpiresAt).toBeNull();
        expect(spot.holdRequestStatus).toBeNull();
        expect(spot.finderId).toBe('finder_pending');
    });

    it('CEH-12: an expired Ping is not reopened — pending hold fields stay, status is not rewritten', async () => {
        const id = nextId('pending-ping-expired');
        await db.doc(`spots/${id}`).set(livePendingSpot({ expiresAt: PAST }));
        await indexModule.cleanupExpiredHolds.run();

        const spotSnap = await db.doc(`spots/${id}`).get();
        expect(spotSnap.exists).toBe(true);
        const spot = spotSnap.data();
        expect(spot.status).toBe('available');
        expect(spot.expiresAt.toMillis()).toBe(PAST.toMillis());
        expect(spot.holdRequestStatus).toBe('pending');
        expect(spot.holdRequestedBy).toBe('requester_pending');
    });

    it('CEH-13: an active claim and its activeIncomingClaims lock are not touched', async () => {
        const id = nextId('pending-active-claim');
        const claimer = `active_${id}`;
        const lock = {
            spotId: id,
            claimStartedAt: PAST,
            claimState: 'heading',
            updatedAt: PAST,
        };
        await db.doc(`spots/${id}`).set(livePendingSpot({
            status: 'interested',
            interestedUserId: claimer,
            claimState: 'heading',
            claimStartedAt: PAST,
        }));
        await db.doc(`users/${claimer}/activeIncomingClaims/current`).set(lock);
        await indexModule.cleanupExpiredHolds.run();

        const spot = await getSpot(id);
        expect(spot.status).toBe('interested');
        expect(spot.interestedUserId).toBe(claimer);
        expect(spot.claimState).toBe('heading');
        expect(spot.holdRequestStatus).toBe('pending');
        expect(spot.holdRequestedBy).toBe('requester_pending');
        const lockAfter = (await db.doc(`users/${claimer}/activeIncomingClaims/current`).get()).data();
        expect(lockAfter.spotId).toBe(id);
        expect(lockAfter.claimState).toBe('heading');
        expect(lockAfter.claimStartedAt.toMillis()).toBe(PAST.toMillis());
    });

    it('CEH-14: a live available Ping that already has a claimer id is not stripped, and its lock stays', async () => {
        const id = nextId('pending-partial-claim');
        const claimer = `partial_${id}`;
        await db.doc(`spots/${id}`).set(livePendingSpot({
            interestedUserId: claimer,
            claimState: 'heading',
            claimStartedAt: PAST,
        }));
        await db.doc(`users/${claimer}/activeIncomingClaims/current`).set({
            spotId: id,
            claimStartedAt: PAST,
            claimState: 'heading',
            updatedAt: PAST,
        });
        await indexModule.cleanupExpiredHolds.run();

        const spot = await getSpot(id);
        expect(spot.status).toBe('available');
        expect(spot.interestedUserId).toBe(claimer);
        expect(spot.holdRequestedBy).toBe('requester_pending');
        expect(spot.holdRequestStatus).toBe('pending');
        const lockAfter = (await db.doc(`users/${claimer}/activeIncomingClaims/current`).get()).data();
        expect(lockAfter.spotId).toBe(id);
        expect(lockAfter.claimState).toBe('heading');
    });

    it('CEH-15: an expired pending hold becomes claimable, and a later cleanup does not disturb that claim', async () => {
        const id = nextId('pending-claim');
        const claimer = `claimer_${id}`;
        const expiresAt = FUTURE;
        await db.doc(`spots/${id}`).set(livePendingSpot({ expiresAt }));
        await db.doc(`users/${claimer}`).set({
            id: claimer,
            username: 'claimerpending',
            crowns: 5,
            vehicleColor: 'red',
            vehicleType: 'suv',
            vehicleBrand: 'Toyota',
        });
        await db.doc('activeIncomingClaimRollout/status').set({
            enforced: true,
            locklessCount: 0,
            duplicateUserCount: 0,
            duplicatePingCount: 0,
        });

        const lockRef = db.doc(`users/${claimer}/activeIncomingClaims/current`);
        expect((await lockRef.get()).exists).toBe(false);
        await expect(claimSpotAs(claimer, id)).rejects.toBeTruthy();

        await indexModule.cleanupExpiredHolds.run();

        const cleared = await getSpot(id);
        expect(cleared.status).toBe('available');
        expect(cleared.expiresAt.toMillis()).toBe(expiresAt.toMillis());
        expect(cleared.holdRequestedBy).toBeNull();
        expect(cleared.holdRequestedByName).toBeNull();
        expect(cleared.holdRequestExpiresAt).toBeNull();
        expect(cleared.holdRequestStatus).toBeNull();
        expect(cleared.interestedUserId == null).toBe(true);
        expect((await lockRef.get()).exists).toBe(false);

        await claimSpotAs(claimer, id);

        const claimed = await getSpot(id);
        expect(claimed.status).toBe('interested');
        expect(claimed.interestedUserId).toBe(claimer);
        expect(claimed.claimState).toBe('heading');
        expect((await lockRef.get()).data().spotId).toBe(id);

        const claimedSnapshot = await getSpot(id);
        const lockSnapshot = (await lockRef.get()).data();
        await indexModule.cleanupExpiredHolds.run();
        expect(await getSpot(id)).toEqual(claimedSnapshot);
        expect((await lockRef.get()).data()).toEqual(lockSnapshot);
    });

    it('CEH-16: clearing an expired pending hold is idempotent', async () => {
        const id = nextId('pending-retry');
        await db.doc(`spots/${id}`).set(livePendingSpot());
        await indexModule.cleanupExpiredHolds.run();
        const afterFirst = await getSpot(id);

        await indexModule.cleanupExpiredHolds.run();
        const afterSecond = await getSpot(id);

        expect(afterFirst.holdRequestedBy).toBeNull();
        expect(afterFirst.status).toBe('available');
        expect(afterSecond).toEqual(afterFirst);
    });
});

function livePendingSpot(overrides = {}) {
    return {
        finderId: 'finder_pending',
        finderName: 'Finder',
        address: '2 Pending St',
        lat: 40.71,
        lng: -74.01,
        type: 'free',
        status: 'available',
        pingMode: 'now',
        reportedAt: PAST,
        expiresAt: FUTURE,
        holdRequestStatus: 'pending',
        holdRequestedBy: 'requester_pending',
        holdRequestedByName: 'Requester',
        holdRequestExpiresAt: PAST,
        ...overrides,
    };
}

async function claimSpotAs(uid, spotId) {
    const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
    const { doc, runTransaction, Timestamp: ClientTimestamp } = require('firebase/firestore');
    const raw = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080';
    const [host, portRaw] = raw.split(':');
    const testEnv = await initializeTestEnvironment({
        projectId: PROJECT_ID,
        firestore: {
            host,
            port: Number(portRaw),
            rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8'),
        },
    });
    try {
        const clientDb = testEnv.authenticatedContext(uid).firestore();
        const claimedAt = ClientTimestamp.now();
        await runTransaction(clientDb, async (tx) => {
            tx.update(doc(clientDb, 'spots', spotId), {
                status: 'interested',
                claimState: 'heading',
                interestedUserId: uid,
                interestedUserName: 'claimerpending',
                interestedUserTitle: 'Newcomer',
                interestedUserVehicleColor: 'red',
                interestedUserVehicleType: 'suv',
                interestedUserVehicleBrand: 'Toyota',
                claimStartedAt: claimedAt,
            });
            tx.set(doc(clientDb, 'users', uid, 'activeIncomingClaims', 'current'), {
                spotId,
                claimStartedAt: claimedAt,
                claimState: 'heading',
                updatedAt: claimedAt,
            });
        });
    } finally {
        await testEnv.cleanup();
    }
}
