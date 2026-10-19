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
        const claimer = nextId('claimer');
        await db.doc(`spots/${id}`).set(headingSpot({ interestExpiresAt: FUTURE, interestedUserId: claimer }));
        await indexModule.cleanupExpiredInterests.run();

        const spot = await getSpot(id);
        expect(spot.status).toBe('interested');
        expect(spot.interestedUserId).toBe(claimer);
    });

    it('CEI-5: a spot with no interestExpiresAt field at all (malformed/legacy) is never touched', async () => {
        const id = nextId('malformed');
        const claimer = nextId('claimer');
        const seed = headingSpot({ interestedUserId: claimer });
        delete seed.interestExpiresAt;
        await db.doc(`spots/${id}`).set(seed);
        await indexModule.cleanupExpiredInterests.run();

        const spot = await getSpot(id);
        expect(spot.status).toBe('interested');
        expect(spot.interestedUserId).toBe(claimer);
    });

    it('CEI-6: a committed (scheduled) claim not yet at its own expiry is untouched — this Function only acts on expired heading claims', async () => {
        const id = nextId('committed');
        await db.doc(`spots/${id}`).set(headingSpot({
            claimState: 'committed',
            pingMode: 'later',
            expiresAt: FAR_FUTURE,
            interestExpiresAt: FAR_FUTURE, // committed claims mirror the Ping's own expiry
            interestedUserId: nextId('claimer'),
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
        const newerClaimer = nextId('newer_claimer');
        await db.doc(`spots/${id}`).set(headingSpot()); // starts as an expired candidate
        // Simulate a race: someone re-claims the spot before the sweep executes.
        await db.doc(`spots/${id}`).update({
            interestedUserId: newerClaimer,
            interestExpiresAt: FUTURE,
        });

        await indexModule.cleanupExpiredInterests.run();

        const spot = await getSpot(id);
        expect(spot.status).toBe('interested');
        expect(spot.interestedUserId).toBe(newerClaimer);
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
        // Distinct claimers: the active-claim reconciler releases a second
        // interested Ping for the same uid, which would collapse this backlog.
        await Promise.all(ids.map(id => db.doc(`spots/${id}`).set(headingSpot({ interestedUserId: id }))));

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

// ─── S-SPOT-1: phantom-claim sweep (status available + retained claimer) ───
describe('S-SPOT-1 phantomClaimSweep (runs inside cleanupExpiredInterests)', () => {
    const SUMMARY_RE = /^phantomClaimSweep: examined=\d+ cleared=\d+ errors=\d+$/;

    function phantomSpot(overrides = {}) {
        return headingSpot({
            status: 'available',
            claimState: 'heading',
            interestExpiresAt: FUTURE,
            interestedUserVehicleType: 'sedan',
            etaMinutes: 5,
            claimStartedAt: PAST,
            ...overrides,
        });
    }

    async function captureLogs(fn) {
        const lines = [];
        const orig = console.log;
        console.log = (...args) => { lines.push(args.map(String).join(' ')); };
        try { await fn(); } finally { console.log = orig; }
        return lines;
    }

    it('PCS-1: a phantom-available Ping is fully cleared and the matching lock is released', async () => {
        const id = nextId('phantom');
        const holder = nextId('holder');
        await db.doc(`spots/${id}`).set(phantomSpot({ interestedUserId: holder }));
        await db.doc(`users/${holder}/activeIncomingClaims/current`).set({ spotId: id, claimState: 'heading', claimStartedAt: PAST, updatedAt: PAST });

        await indexModule.cleanupExpiredInterests.run();

        const spot = await getSpot(id);
        expect(spot.status).toBe('available');
        for (const f of ['interestedUserId', 'interestedUserName', 'interestedUserVehicleType', 'claimState',
            'claimStartedAt', 'etaMinutes', 'interestExpiresAt']) {
            expect(spot[f]).toBeNull();
        }
        expect(spot.finderId).toBe('finder_x');
        expect((await db.doc(`users/${holder}/activeIncomingClaims/current`).get()).exists).toBe(false);
    });

    it('PCS-2: a lock naming a DIFFERENT Ping is preserved while the phantom is cleared', async () => {
        const id = nextId('phantom2');
        const holder = nextId('holder2');
        await db.doc(`spots/${id}`).set(phantomSpot({ interestedUserId: holder }));
        await db.doc(`users/${holder}/activeIncomingClaims/current`).set({ spotId: 'some_other_spot', claimState: 'heading', claimStartedAt: PAST, updatedAt: PAST });
        await indexModule.cleanupExpiredInterests.run();
        expect((await getSpot(id)).interestedUserId).toBeNull();
        expect((await db.doc(`users/${holder}/activeIncomingClaims/current`).get()).data().spotId).toBe('some_other_spot');
    });

    it('PCS-3: healthy states are untouched — clean available, live interested claim, occupied/arrived handoff', async () => {
        const clean = nextId('clean');
        const live = nextId('live');
        const arrived = nextId('arrived');
        await db.doc(`spots/${clean}`).set(headingSpot({ status: 'available', interestedUserId: null, claimState: null, interestExpiresAt: null }));
        await db.doc(`spots/${live}`).set(headingSpot({ interestExpiresAt: FUTURE }));
        await db.doc(`spots/${arrived}`).set(headingSpot({ status: 'occupied', claimState: 'arrived_pending_outcome', interestExpiresAt: FUTURE }));
        await indexModule.cleanupExpiredInterests.run();
        expect((await getSpot(live)).interestedUserId).toBe('claimant_x');
        expect((await getSpot(live)).status).toBe('interested');
        expect((await getSpot(arrived)).interestedUserId).toBe('claimant_x');
        expect((await getSpot(arrived)).claimState).toBe('arrived_pending_outcome');
        expect((await getSpot(clean)).status).toBe('available');
    });

    it('PCS-4: exactly one value-free summary line per run (counts only, no IDs)', async () => {
        const id = nextId('phantom4');
        const holder = nextId('holder4');
        await db.doc(`spots/${id}`).set(phantomSpot({ interestedUserId: holder }));
        const lines = await captureLogs(() => indexModule.cleanupExpiredInterests.run());
        const summaries = lines.filter((l) => l.startsWith('phantomClaimSweep'));
        expect(summaries).toHaveLength(1);
        expect(summaries[0]).toMatch(SUMMARY_RE);
        expect(Number(/cleared=(\d+)/.exec(summaries[0])[1])).toBeGreaterThanOrEqual(1);
        for (const l of lines.filter((x) => x.startsWith('phantomClaimSweep'))) {
            expect(l).not.toContain(id);
            expect(l).not.toContain(holder);
            expect(l).not.toContain('finder_x');
        }
    });

    it('PCS-5: one failing candidate is isolated (errors=1) and the others are still cleared', async () => {
        const bad = nextId('phantomBad');
        const good = nextId('phantomGood');
        await db.doc(`spots/${bad}`).set(phantomSpot({ interestedUserId: nextId('hb') }));
        await db.doc(`spots/${good}`).set(phantomSpot({ interestedUserId: nextId('hg') }));
        const realTx = db.runTransaction.bind(db);
        const fakeDb = new Proxy(db, {
            get(target, prop) {
                if (prop === 'runTransaction') {
                    return (fn) => realTx(async (tx) => {
                        const wrapped = new Proxy(tx, {
                            get(t, p) {
                                if (p === 'update') {
                                    return (ref, data) => {
                                        if (ref.id === bad) throw new Error('injected');
                                        return t.update(ref, data);
                                    };
                                }
                                const v = t[p];
                                return typeof v === 'function' ? v.bind(t) : v;
                            },
                        });
                        return fn(wrapped);
                    });
                }
                const v = target[prop];
                return typeof v === 'function' ? v.bind(target) : v;
            },
        });
        let result;
        const lines = await captureLogs(async () => {
            result = await indexModule._sweepPhantomClaims(fakeDb, Timestamp.now());
        });
        expect(result.errors).toBe(1);
        expect(result.cleared).toBeGreaterThanOrEqual(1);
        expect((await getSpot(good)).interestedUserId).toBeNull();
        expect((await getSpot(bad)).interestedUserId).not.toBeNull();
        expect(lines.filter((l) => l.startsWith('phantomClaimSweep'))).toHaveLength(1);
        expect(lines.join('\n')).not.toContain(bad);
        await db.doc(`spots/${bad}`).delete();
    });

    it('PCS-6: a query failure still emits one summary with errors=1 and never throws', async () => {
        const brokenDb = { collection: () => { throw new Error('query down'); } };
        let result;
        const lines = await captureLogs(async () => {
            result = await indexModule._sweepPhantomClaims(brokenDb, Timestamp.now());
        });
        expect(result).toEqual({ examined: 0, cleared: 0, errors: 1 });
        expect(lines).toEqual(['phantomClaimSweep: examined=0 cleared=0 errors=1']);
    });

    it('PCS-7: an expired phantom Ping is outside the sweep (not claimable; deleted hourly)', async () => {
        const id = nextId('phantomExpired');
        await db.doc(`spots/${id}`).set(phantomSpot({ expiresAt: PAST }));
        await indexModule.cleanupExpiredInterests.run();
        expect((await getSpot(id)).interestedUserId).toBe('claimant_x');
        await db.doc(`spots/${id}`).delete();
    });
});
