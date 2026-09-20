'use strict';

/**
 * cleanupExpiredInterests exercises the real scheduled handler via .run()
 * against the Firestore emulator (no mocks). The emulator does NOT enforce
 * production composite-index requirements, so these tests prove query
 * *correctness* and cleanup *safety* semantics only — they cannot prove the
 * required index is deployed or READY in production. That is verified
 * separately (Cloud Logging / Firestore index metadata), not by this suite.
 */

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const fs = require('fs');
const path = require('path');

const { requireEmulatorProjectId } = require('./emulatorProjectId');
const PROJECT_ID = requireEmulatorProjectId();
const APP_NAME = '__cleanup_expired_interests_intg__';
const testApp = getApps().find(app => app.name === APP_NAME) ?? initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const indexModule = require('./index.js');

const RUN = `${process.pid}_${Date.now()}`;
let sequence = 0;
const nextId = label => `cei_${label}_${RUN}_${++sequence}`;

const PAST = Timestamp.fromMillis(Date.now() - 60_000);
const FUTURE = Timestamp.fromMillis(Date.now() + 60 * 60_000);
const FAR_FUTURE = Timestamp.fromMillis(Date.now() + 24 * 60 * 60_000);

function headingSpot(overrides = {}) {
    return {
        finderId: 'finder_x',
        finderName: 'Finder',
        address: '1 Test St',
        lat: 40.7,
        lng: -74.0,
        status: 'interested',
        claimState: 'heading',
        interestedUserId: 'claimant_x',
        interestedUserName: 'Claimant',
        pingMode: 'now',
        reportedAt: PAST,
        expiresAt: FUTURE, // Ping itself still valid unless overridden
        interestExpiresAt: PAST, // claim expired
        ...overrides,
    };
}

async function getSpot(id) {
    return (await db.doc(`spots/${id}`).get()).data();
}

describe('cleanupExpiredInterests Function contract', () => {
    it('CEI-1: query is a conservatively bounded (limit 100), non-paginating scan of spots(status, interestExpiresAt), processed sequentially (no unbounded Promise.all)', () => {
        const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const start = src.indexOf('exports.cleanupExpiredInterests');
        const fn = src.slice(start, src.indexOf('exports.cleanupExpiredHolds', start));
        expect(fn).toMatch(/\.collection\("spots"\)/);
        expect(fn).toMatch(/\.where\("status",\s*"==",\s*"interested"\)/);
        expect(fn).toMatch(/\.where\("interestExpiresAt",\s*"<=",\s*now\)/);
        expect(fn).toMatch(/\.limit\(100\)/);
        expect(fn).not.toMatch(/\.limit\(500\)/);
        // Sequential for-of over the candidates, not Promise.all(snap.docs.map(...)).
        expect(fn).toMatch(/for \(const d of snap\.docs\)/);
        expect(fn).not.toMatch(/Promise\.all\(\s*snap\.docs\.map/);
    });

    it('CEI-2: an expired heading claim on a still-valid Ping is cleared and the Ping reopens to available', async () => {
        const id = nextId('reopen');
        await db.doc(`spots/${id}`).set(headingSpot());
        await indexModule.cleanupExpiredInterests.run();

        const spot = await getSpot(id);
        expect(spot.status).toBe('available');
        expect(spot.interestedUserId).toBeNull();
        expect(spot.claimState).toBeNull();
        expect(spot.claimStartedAt).toBeNull();
        expect(spot.interestExpiresAt).toBeNull();
    });

    it('CEI-3: an expired heading claim on an ALREADY-expired Ping is cleared but the Ping never reopens', async () => {
        const id = nextId('noreopen');
        await db.doc(`spots/${id}`).set(headingSpot({ expiresAt: PAST })); // Ping itself is expired too
        await indexModule.cleanupExpiredInterests.run();

        const spot = await getSpot(id);
        expect(spot.status).toBe('interested'); // untouched — never flipped to available
        expect(spot.interestedUserId).toBeNull(); // stale claim still cleared
        expect(spot.claimState).toBeNull();
    });

    it('CEI-4: a claim whose interestExpiresAt is still in the future is completely untouched', async () => {
        const id = nextId('notexpired');
        await db.doc(`spots/${id}`).set(headingSpot({ interestExpiresAt: FUTURE }));
        await indexModule.cleanupExpiredInterests.run();

        const spot = await getSpot(id);
        expect(spot.status).toBe('interested');
        expect(spot.interestedUserId).toBe('claimant_x');
    });

    it('CEI-5: a spot with no interestExpiresAt field at all (malformed/legacy) is never touched', async () => {
        const id = nextId('malformed');
        const seed = headingSpot();
        delete seed.interestExpiresAt;
        await db.doc(`spots/${id}`).set(seed);
        await indexModule.cleanupExpiredInterests.run();

        const spot = await getSpot(id);
        expect(spot.status).toBe('interested');
        expect(spot.interestedUserId).toBe('claimant_x');
    });

    it('CEI-6: a committed (scheduled) claim not yet at its own expiry is untouched — this Function only acts on expired heading claims', async () => {
        const id = nextId('committed');
        await db.doc(`spots/${id}`).set(headingSpot({
            claimState: 'committed',
            pingMode: 'later',
            expiresAt: FAR_FUTURE,
            interestExpiresAt: FAR_FUTURE, // committed claims mirror the Ping's own expiry
        }));
        await indexModule.cleanupExpiredInterests.run();

        const spot = await getSpot(id);
        expect(spot.status).toBe('interested');
        expect(spot.claimState).toBe('committed');
    });

    it('CEI-7: retrying the run is idempotent — a second invocation is a safe no-op on an already-cleaned spot', async () => {
        const id = nextId('retry');
        await db.doc(`spots/${id}`).set(headingSpot());
        await indexModule.cleanupExpiredInterests.run();
        const afterFirst = await getSpot(id);

        await indexModule.cleanupExpiredInterests.run();
        const afterSecond = await getSpot(id);

        expect(afterFirst.status).toBe('available');
        expect(afterSecond).toEqual(afterFirst); // no further change
    });

    it('CEI-8: a newer claim that replaces the stale one before cleanup runs is fully protected', async () => {
        const id = nextId('newer');
        await db.doc(`spots/${id}`).set(headingSpot()); // starts as an expired candidate
        // Simulate a race: someone re-claims the spot before the sweep executes.
        await db.doc(`spots/${id}`).update({
            interestedUserId: 'newer_claimant',
            interestExpiresAt: FUTURE,
        });

        await indexModule.cleanupExpiredInterests.run();

        const spot = await getSpot(id);
        expect(spot.status).toBe('interested');
        expect(spot.interestedUserId).toBe('newer_claimant');
    });

    it('CEI-9: creates no notification documents (this Function has never sent any — confirms the fix does not introduce new side effects)', async () => {
        const id = nextId('nonotif');
        await db.doc(`spots/${id}`).set(headingSpot());
        await indexModule.cleanupExpiredInterests.run();

        const snap = await db.collection('spotNotifications').where('spotId', '==', id).get();
        expect(snap.empty).toBe(true);
    });

    it('CEI-10: two overlapping invocations processing the same candidate produce exactly one release, no errors, no duplicate effects', async () => {
        const id = nextId('overlap');
        await db.doc(`spots/${id}`).set(headingSpot());

        await Promise.all([
            indexModule.cleanupExpiredInterests.run(),
            indexModule.cleanupExpiredInterests.run(),
        ]);

        const spot = await getSpot(id);
        expect(spot.status).toBe('available');
        expect(spot.interestedUserId).toBeNull();
    }, 30000);

    it('CEI-11: a backlog larger than one processing batch drains across successive invocations without losing candidates', async () => {
        const ids = Array.from({ length: 120 }, () => nextId('backlog'));
        await Promise.all(ids.map(id => db.doc(`spots/${id}`).set(headingSpot())));

        await indexModule.cleanupExpiredInterests.run();
        const afterFirst = await Promise.all(ids.map(getSpot));
        const releasedAfterFirst = afterFirst.filter(s => s.status === 'available').length;
        // The batch is capped at 100 candidates per run, so with 120 seeded,
        // at most 100 can be released in the first pass and at least 20 must
        // still be pending — proving the limit is really being applied.
        expect(releasedAfterFirst).toBeGreaterThan(0);
        expect(releasedAfterFirst).toBeLessThanOrEqual(100);
        expect(releasedAfterFirst).toBeLessThan(ids.length);

        await indexModule.cleanupExpiredInterests.run();
        const afterSecond = await Promise.all(ids.map(getSpot));
        const releasedAfterSecond = afterSecond.filter(s => s.status === 'available').length;
        expect(releasedAfterSecond).toBe(ids.length); // every candidate eventually drained
    }, 60000);

    it('CEI-12: a cleaned expired-Ping claim cannot repeatedly occupy candidate slots (no starvation) — it drops out of the query on the next run once interestExpiresAt is nulled', async () => {
        const staleId = nextId('starve_stale');
        const freshId = nextId('starve_fresh');
        // An expired-Ping "committed" claim: gets cleared but status stays
        // "interested" (never reopened). If this kept matching the query,
        // it could starve out fresh candidates on every subsequent run.
        await db.doc(`spots/${staleId}`).set(headingSpot({
            claimState: 'committed', expiresAt: PAST, interestExpiresAt: PAST,
        }));
        await indexModule.cleanupExpiredInterests.run();
        const staleAfterFirst = await getSpot(staleId);
        expect(staleAfterFirst.status).toBe('interested'); // never reopened
        expect(staleAfterFirst.interestedUserId).toBeNull(); // but cleared
        expect(staleAfterFirst.interestExpiresAt).toBeNull();

        // A second, independent expired candidate arrives after the first run.
        await db.doc(`spots/${freshId}`).set(headingSpot());
        await indexModule.cleanupExpiredInterests.run();

        const staleAfterSecond = await getSpot(staleId);
        const fresh = await getSpot(freshId);
        expect(staleAfterSecond).toEqual(staleAfterFirst); // not reprocessed — no longer a candidate
        expect(fresh.status).toBe('available'); // fresh candidate was not starved out
    });

    it('CEI-13: Runtime-IAM canary config-contract — cleanupExpiredInterests (Wave 7A-1) runs as the dedicated parqueen-cleanup identity', () => {
        const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const start = src.indexOf('exports.cleanupExpiredInterests');
        const fn = src.slice(start, src.indexOf('exports.cleanupExpiredHolds', start));
        expect(fn).toMatch(/serviceAccount:\s*'parqueen-cleanup@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
    });
});
