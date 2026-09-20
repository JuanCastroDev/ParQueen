'use strict';

/**
 * cleanupExpiredHolds exercises the real scheduled handler via .run() against
 * the Firestore emulator (no mocks). Unlike cleanupExpiredInterests (per-doc
 * transactions with a fresh-state re-check), this Function commits a single
 * db.batch() over the initial query snapshot — idempotency here comes from
 * the QUERY itself excluding already-reverted docs on any subsequent run
 * (every written value is a fixed literal, not a counter), not from a
 * per-doc transactional re-verification.
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
});
