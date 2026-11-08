'use strict';

require('./isolatedEmulatorGuard').assertIsolatedEmulator();

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
const createdSpotIds = [];

async function createSpot(id, data) {
    spotsCreated += 1;
    createdSpotIds.push(id);
    await db.doc(`spots/${id}`).set(data);
}

function queueSpot(batch, id, data) {
    spotsCreated += 1;
    createdSpotIds.push(id);
    batch.set(db.doc(`spots/${id}`), data);
}

function assessSpotCreateCompletion({ baseline, current, expectedIds, receiptSpotIds }) {
    const delta = current - baseline;
    const counts = new Map();
    for (const id of receiptSpotIds) {
        counts.set(id, (counts.get(id) || 0) + 1);
    }
    const missing = [];
    let duplicateSpotIds = 0;
    let completed = 0;
    for (const id of expectedIds) {
        const seen = counts.get(id) || 0;
        if (seen === 0) missing.push(id);
        else {
            completed += 1;
            if (seen > 1) duplicateSpotIds += seen - 1;
        }
    }
    if (delta < expectedIds.length) {
        return { status: 'pending', stage: 'DRAIN', missing, duplicateSpotIds, completed };
    }
    if (delta !== expectedIds.length || missing.length > 0 || duplicateSpotIds > 0) {
        return { status: 'fail', stage: 'DRAIN', missing, duplicateSpotIds, completed };
    }
    return { status: 'complete', stage: 'DRAIN', verifiedTotal: current, missing, duplicateSpotIds, completed };
}

function nextQuietObservation({ verifiedTotal, observation, streak }) {
    if (observation !== verifiedTotal) {
        return { status: 'fail', stage: 'POST_COMPLETION_QUIET', streak };
    }
    const next = streak + 1;
    if (next >= 4) return { status: 'pass', stage: 'POST_COMPLETION_QUIET', streak: next };
    return { status: 'pending', stage: 'POST_COMPLETION_QUIET', streak: next };
}

function settlementError({ stage, baseline, spotsCreated: expected, current, samples, completed, duplicateSpotIds, missing }) {
    return new Error(
        `spot-create counter did not settle at ${current} after ${expected} creates from ${baseline}; `
        + `stage=${stage}; samples=${samples.join(',')}; eventDocs=${completed}; duplicateSpotIds=${duplicateSpotIds}; `
        + `missingCreates=${missing.length}; missingIds=${missing.slice(0, 8).join(',')}`
    );
}

async function incrementReceiptSpotIds() {
    const events = await db.collection('functionEvents').get();
    const ids = [];
    for (const eventDoc of events.docs) {
        const data = eventDoc.data() || {};
        if (data.functionName === 'incrementTotalSpotsPinged' && typeof data.spotId === 'string') ids.push(data.spotId);
    }
    return ids;
}

async function settleSpotCreateCounter(baseline) {
    if (spotsCreated === 0) return;
    const statsRef = db.doc('stats/global');
    const samples = [];
    let verdict = { status: 'pending', stage: 'DRAIN', missing: createdSpotIds.slice(), duplicateSpotIds: 0, completed: 0 };
    let current = baseline;
    for (let attempt = 0; attempt < 200; attempt++) {
        current = (await statsRef.get()).data()?.totalSpotsPinged || 0;
        if (samples.length === 0 || samples[samples.length - 1] !== current) samples.push(current);
        if (current - baseline >= spotsCreated) {
            verdict = assessSpotCreateCompletion({
                baseline,
                current,
                expectedIds: createdSpotIds,
                receiptSpotIds: await incrementReceiptSpotIds(),
            });
            if (verdict.status !== 'pending') break;
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (verdict.status !== 'complete') {
        if (verdict.status === 'pending') {
            verdict = assessSpotCreateCompletion({
                baseline,
                current,
                expectedIds: createdSpotIds,
                receiptSpotIds: await incrementReceiptSpotIds(),
            });
            if (verdict.status === 'pending') verdict = { ...verdict, status: 'fail' };
        }
        throw settlementError({
            stage: 'DRAIN',
            baseline,
            spotsCreated,
            current,
            samples,
            completed: verdict.completed,
            duplicateSpotIds: verdict.duplicateSpotIds,
            missing: verdict.missing,
        });
    }
    let streak = 0;
    while (streak < 4) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        current = (await statsRef.get()).data()?.totalSpotsPinged || 0;
        if (samples.length === 0 || samples[samples.length - 1] !== current) samples.push(current);
        const step = nextQuietObservation({ verifiedTotal: verdict.verifiedTotal, observation: current, streak });
        if (step.status === 'fail') {
            throw settlementError({
                stage: 'POST_COMPLETION_QUIET',
                baseline,
                spotsCreated,
                current,
                samples,
                completed: verdict.completed,
                duplicateSpotIds: 0,
                missing: [],
            });
        }
        streak = step.streak;
    }
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

    it('CESH-6: keeps occupied completed_success when arrivedAt is real and deletes it when arrivedAt is missing', async () => {
        const keptId = `cesh_completed_${RUN}`;
        const missingId = `cesh_completed_missing_${RUN}`;
        const arrivedAt = Timestamp.fromMillis(Date.now() - 3 * 60 * 60_000);
        await createSpot(keptId, spot({
            status: 'occupied',
            claimState: 'completed_success',
            arrivedAt,
            interestedUserId: 'claimer_done',
        }));
        const missing = spot({
            status: 'occupied',
            claimState: 'completed_success',
            interestedUserId: 'claimer_done_missing',
        });
        delete missing.arrivedAt;
        await createSpot(missingId, missing);

        await indexModule.cleanupExpiredSpotsHourly.run();

        const kept = await db.doc(`spots/${keptId}`).get();
        expect(kept.exists).toBe(true);
        expect(kept.data().claimState).toBe('completed_success');
        expect(kept.data().status).toBe('occupied');
        expect(kept.data().arrivedAt.toMillis()).toBe(arrivedAt.toMillis());
        expect((await db.doc(`spots/${missingId}`).get()).exists).toBe(false);
    });
});

describe('spot-create settlement barrier', () => {
    it('passes when the exact total and receipts arrive on the last drain poll and four quiet reads follow', () => {
        const expectedIds = ['a', 'b'];
        let verdict = { status: 'pending' };
        for (let attempt = 0; attempt < 200; attempt++) {
            const current = attempt === 199 ? 2 : 0;
            const receipts = attempt === 199 ? ['a', 'b'] : [];
            if (current - 0 >= expectedIds.length) {
                verdict = assessSpotCreateCompletion({ baseline: 0, current, expectedIds, receiptSpotIds: receipts });
                if (verdict.status !== 'pending') break;
            }
        }
        expect(verdict.status).toBe('complete');
        let streak = 0;
        for (const observation of [2, 2, 2, 2]) {
            const step = nextQuietObservation({ verifiedTotal: 2, observation, streak });
            streak = step.streak;
            if (step.status === 'pass') break;
        }
        expect(streak).toBe(4);
    });

    it('fails the drain when the counter and receipts stay short', () => {
        const verdict = assessSpotCreateCompletion({
            baseline: 0,
            current: 1,
            expectedIds: ['s1', 's2'],
            receiptSpotIds: ['s1'],
        });
        expect(verdict.status).toBe('pending');
        expect(verdict.stage).toBe('DRAIN');
        expect(verdict.missing).toEqual(['s2']);
    });

    it('fails when the counter matches but an expected receipt is missing', () => {
        const verdict = assessSpotCreateCompletion({
            baseline: 0,
            current: 2,
            expectedIds: ['s1', 's2'],
            receiptSpotIds: ['s1', 'other'],
        });
        expect(verdict.status).toBe('fail');
        expect(verdict.stage).toBe('DRAIN');
        expect(verdict.missing).toEqual(['s2']);
    });

    it('fails when two receipts name the same expected spot', () => {
        const verdict = assessSpotCreateCompletion({
            baseline: 0,
            current: 1,
            expectedIds: ['s1'],
            receiptSpotIds: ['s1', 's1'],
        });
        expect(verdict.status).toBe('fail');
        expect(verdict.duplicateSpotIds).toBe(1);
    });

    it('fails when the counter moves after completion is proved', () => {
        const step = nextQuietObservation({ verifiedTotal: 4, observation: 5, streak: 2 });
        expect(step.status).toBe('fail');
        expect(step.stage).toBe('POST_COMPLETION_QUIET');
    });

    it('passes when completion is proved before the drain budget ends and four quiet reads follow', () => {
        const verdict = assessSpotCreateCompletion({
            baseline: 10,
            current: 12,
            expectedIds: ['s1', 's2'],
            receiptSpotIds: ['s1', 's2'],
        });
        expect(verdict.status).toBe('complete');
        let streak = 0;
        let last = null;
        for (const observation of [12, 12, 12, 12]) {
            last = nextQuietObservation({ verifiedTotal: verdict.verifiedTotal, observation, streak });
            streak = last.streak;
        }
        expect(last.status).toBe('pass');
    });
});
