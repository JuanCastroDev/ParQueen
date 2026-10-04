'use strict';

const fs = require('fs');
const path = require('path');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const { requireEmulatorProjectId } = require('./emulatorProjectId');
const { TWO_HOURS_MS } = require('./handoffSuccessContract');
const PROJECT_ID = requireEmulatorProjectId();
const APP_NAME = '__award_crowns_intg__';
const testApp = getApps().find(app => app.name === APP_NAME) ?? initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const indexModule = require('./index.js');

const RUN = `${process.pid}_${Date.now()}`;
let sequence = 0;
const nextId = label => `ac_${label}_${RUN}_${++sequence}`;

function createdEvent(feedbackId, data, eventId = `event_${feedbackId}`) {
    return {
        id: eventId,
        params: { feedbackId },
        data: { id: feedbackId, data: () => data },
    };
}

async function cleanupUsers(...uids) {
    await Promise.all(uids.map(uid => db.doc(`users/${uid}`).delete()));
}

async function cleanupMarker(pairId) {
    await db.doc(`functionEvents/awardCrowns_${pairId}`).delete();
}

async function seedRewardablePair({
    driverId,
    finderId,
    spotId = nextId('spot'),
    driverCrowns = 0,
    finderCrowns = 0,
    omitDriver = false,
    omitFinder = false,
    omitClaimerDoc = false,
    omitFinderDoc = false,
    claimerOutcome = 'participant_success',
    finderOutcome = 'participant_success',
    claimState = 'arrived_pending_outcome',
    status = 'occupied',
    arrivedAt = Timestamp.fromMillis(Date.now() - 60_000),
    createdAt = Timestamp.fromMillis(Date.now() - 30_000),
    claimerFinderId = finderId,
    finderUserId = driverId,
    spotFinderId = finderId,
    spotClaimerId = driverId,
    claimerRole = 'claimer',
    finderRole = 'finder',
}) {
    const pairId = `${spotId}_${driverId}`;
    if (!omitDriver) await db.doc(`users/${driverId}`).set({ crowns: driverCrowns });
    if (!omitFinder) await db.doc(`users/${finderId}`).set({ crowns: finderCrowns });
    await db.doc(`spots/${spotId}`).set({
        status,
        claimState,
        arrivedAt,
        interestedUserId: spotClaimerId,
        finderId: spotFinderId,
        address: '1 Award St',
    });
    const claimerDoc = {
        spotId,
        userId: driverId,
        finderId: claimerFinderId,
        outcome: claimerOutcome,
        role: claimerRole,
        failureReason: claimerOutcome === 'failed' ? 'Other' : null,
        address: '1 Award St',
        createdAt,
    };
    const finderDoc = {
        spotId,
        userId: finderUserId,
        finderId,
        outcome: finderOutcome,
        role: finderRole,
        failureReason: null,
        address: '1 Award St',
        createdAt,
    };
    if (!omitClaimerDoc) await db.doc(`spotFeedback/${pairId}`).set(claimerDoc);
    if (!omitFinderDoc) await db.doc(`spotFeedback/${pairId}_finder`).set(finderDoc);
    return { spotId, pairId, claimerDoc, finderDoc };
}

// Mutual success is the only award. The pair id `${spotId}_${claimerId}` is
// the exactly-once key for both attestation creates and any retry.
describe('awardCrowns idempotency contract', () => {
    it('AC-1: mutual success awards driver +1, finder +2, trust once, completed_success, and a marker', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const seeded = await seedRewardablePair({ driverId, finderId });

        await indexModule.awardCrowns.run(createdEvent(seeded.pairId, seeded.claimerDoc));

        const [driverSnap, finderSnap, spotSnap] = await Promise.all([
            db.doc(`users/${driverId}`).get(),
            db.doc(`users/${finderId}`).get(),
            db.doc(`spots/${seeded.spotId}`).get(),
        ]);
        expect(driverSnap.data().crowns).toBe(1);
        expect(driverSnap.data().title).toBe('Newcomer');
        expect(finderSnap.data().crowns).toBe(2);
        expect(finderSnap.data().title).toBe('Newcomer');
        expect(finderSnap.data().trustStats.handoffsCompleted).toBe(1);
        expect(spotSnap.data().claimState).toBe('completed_success');
        expect((await db.doc(`functionEvents/awardCrowns_${seeded.pairId}`).get()).data().outcome).toBe('awarded');

        await cleanupUsers(driverId, finderId);
        await cleanupMarker(seeded.pairId);
    });

    it('AC-2: the same event delivered twice sequentially awards crowns only once', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const seeded = await seedRewardablePair({ driverId, finderId });
        const event = createdEvent(seeded.pairId, seeded.claimerDoc);

        await indexModule.awardCrowns.run(event);
        await indexModule.awardCrowns.run(event);

        const [driverSnap, finderSnap] = await Promise.all([
            db.doc(`users/${driverId}`).get(),
            db.doc(`users/${finderId}`).get(),
        ]);
        expect(driverSnap.data().crowns).toBe(1);
        expect(finderSnap.data().crowns).toBe(2);
        expect(finderSnap.data().trustStats.handoffsCompleted).toBe(1);

        await cleanupUsers(driverId, finderId);
        await cleanupMarker(seeded.pairId);
    });

    it('AC-3: the same event delivered concurrently twice awards crowns exactly once', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const seeded = await seedRewardablePair({ driverId, finderId });
        const event = createdEvent(seeded.pairId, seeded.claimerDoc);

        await Promise.all([indexModule.awardCrowns.run(event), indexModule.awardCrowns.run(event)]);

        const [driverSnap, finderSnap] = await Promise.all([
            db.doc(`users/${driverId}`).get(),
            db.doc(`users/${finderId}`).get(),
        ]);
        expect(driverSnap.data().crowns).toBe(1);
        expect(finderSnap.data().crowns).toBe(2);
        expect(finderSnap.data().trustStats.handoffsCompleted).toBe(1);

        await cleanupUsers(driverId, finderId);
        await cleanupMarker(seeded.pairId);
    });

    it('AC-4: the same pair with a different event.id still does not award a second time', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const seeded = await seedRewardablePair({ driverId, finderId });

        await indexModule.awardCrowns.run(createdEvent(seeded.pairId, seeded.claimerDoc, nextId('event')));
        await indexModule.awardCrowns.run(createdEvent(seeded.pairId, seeded.claimerDoc, nextId('event')));

        const [driverSnap, finderSnap] = await Promise.all([
            db.doc(`users/${driverId}`).get(),
            db.doc(`users/${finderId}`).get(),
        ]);
        expect(driverSnap.data().crowns).toBe(1);
        expect(finderSnap.data().crowns).toBe(2);

        await cleanupUsers(driverId, finderId);
        await cleanupMarker(seeded.pairId);
    });

    it('AC-5: two distinct handoffs for the same pair both legitimately award', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const first = await seedRewardablePair({ driverId, finderId });
        const second = await seedRewardablePair({ driverId, finderId });

        await indexModule.awardCrowns.run(createdEvent(first.pairId, first.claimerDoc));
        await indexModule.awardCrowns.run(createdEvent(second.pairId, second.claimerDoc));

        const [driverSnap, finderSnap] = await Promise.all([
            db.doc(`users/${driverId}`).get(),
            db.doc(`users/${finderId}`).get(),
        ]);
        expect(driverSnap.data().crowns).toBe(2);
        expect(finderSnap.data().crowns).toBe(4);
        expect(finderSnap.data().trustStats.handoffsCompleted).toBe(2);

        await cleanupUsers(driverId, finderId);
        await cleanupMarker(first.pairId);
        await cleanupMarker(second.pairId);
    });

    it('AC-6: crossing a title threshold computes the correct post-award title, and a replay does not move it again', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const seeded = await seedRewardablePair({ driverId, finderId, driverCrowns: 9 });
        const event = createdEvent(seeded.pairId, seeded.claimerDoc);

        await indexModule.awardCrowns.run(event);
        let driverSnap = await db.doc(`users/${driverId}`).get();
        expect(driverSnap.data().crowns).toBe(10);
        expect(driverSnap.data().title).toBe('Trusted Driver');

        await indexModule.awardCrowns.run(event);
        driverSnap = await db.doc(`users/${driverId}`).get();
        expect(driverSnap.data().crowns).toBe(10);
        expect(driverSnap.data().title).toBe('Trusted Driver');

        await cleanupUsers(driverId, finderId);
        await cleanupMarker(seeded.pairId);
    });

    it('AC-7: a missing driver user document is a safe terminal no-op — marker written, finder untouched, no throw', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const seeded = await seedRewardablePair({ driverId, finderId, omitDriver: true });

        await expect(
            indexModule.awardCrowns.run(createdEvent(seeded.pairId, seeded.claimerDoc)),
        ).resolves.not.toThrow();

        const marker = (await db.doc(`functionEvents/awardCrowns_${seeded.pairId}`).get()).data();
        expect(marker.outcome).toBe('skipped_missing_user');
        expect((await db.doc(`users/${finderId}`).get()).data().crowns).toBe(0);
        expect((await db.doc(`users/${finderId}`).get()).data().trustStats).toBeUndefined();

        await cleanupUsers(finderId);
        await cleanupMarker(seeded.pairId);
    });

    it('AC-10: a missing finder user document is symmetric — marker written, driver untouched, no throw', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const seeded = await seedRewardablePair({ driverId, finderId, omitFinder: true });

        await expect(
            indexModule.awardCrowns.run(createdEvent(seeded.pairId, seeded.claimerDoc)),
        ).resolves.not.toThrow();

        const marker = (await db.doc(`functionEvents/awardCrowns_${seeded.pairId}`).get()).data();
        expect(marker.outcome).toBe('skipped_missing_user');
        expect((await db.doc(`users/${driverId}`).get()).data().crowns).toBe(0);

        await cleanupUsers(driverId);
        await cleanupMarker(seeded.pairId);
    });

    it('AC-11: both driver and finder missing — terminal marker, no throw, nothing to touch', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const seeded = await seedRewardablePair({ driverId, finderId, omitDriver: true, omitFinder: true });

        await expect(
            indexModule.awardCrowns.run(createdEvent(seeded.pairId, seeded.claimerDoc)),
        ).resolves.not.toThrow();

        const marker = (await db.doc(`functionEvents/awardCrowns_${seeded.pairId}`).get()).data();
        expect(marker.outcome).toBe('skipped_missing_user');

        await cleanupMarker(seeded.pairId);
    });

    it('AC-12: a redelivered missing-user event no-ops on the terminal marker — no repeated work, no throw', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const seeded = await seedRewardablePair({ driverId, finderId, omitDriver: true });
        const event = createdEvent(seeded.pairId, seeded.claimerDoc);

        await indexModule.awardCrowns.run(event);
        await expect(indexModule.awardCrowns.run(event)).resolves.not.toThrow();

        expect((await db.doc(`users/${finderId}`).get()).data().crowns).toBe(0);

        await cleanupUsers(finderId);
        await cleanupMarker(seeded.pairId);
    });

    it('AC-13: concurrent duplicate missing-user event delivery writes exactly one terminal marker, no crowns', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const seeded = await seedRewardablePair({ driverId, finderId, omitDriver: true });
        const event = createdEvent(seeded.pairId, seeded.claimerDoc);

        await Promise.all([indexModule.awardCrowns.run(event), indexModule.awardCrowns.run(event)]);

        const marker = (await db.doc(`functionEvents/awardCrowns_${seeded.pairId}`).get()).data();
        expect(marker.outcome).toBe('skipped_missing_user');
        expect((await db.doc(`users/${finderId}`).get()).data().crowns).toBe(0);

        await cleanupUsers(finderId);
        await cleanupMarker(seeded.pairId);
    });

    it('AC-14: realistic race — driver account deleted between attestation and awardCrowns — terminal no-op, finder untouched', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const seeded = await seedRewardablePair({ driverId, finderId, driverCrowns: 5 });

        await db.recursiveDelete(db.doc(`users/${driverId}`));

        await expect(
            indexModule.awardCrowns.run(createdEvent(seeded.pairId, seeded.claimerDoc)),
        ).resolves.not.toThrow();

        const marker = (await db.doc(`functionEvents/awardCrowns_${seeded.pairId}`).get()).data();
        expect(marker.outcome).toBe('skipped_missing_user');
        expect((await db.doc(`users/${finderId}`).get()).data().crowns).toBe(0);
        expect((await db.doc(`spots/${seeded.spotId}`).get()).data().claimState).toBe('arrived_pending_outcome');

        await cleanupUsers(finderId);
        await cleanupMarker(seeded.pairId);
    });

    it('AC-8: driverId === finderId is a no-op — no crowns, no marker', async () => {
        const uid = nextId('self');
        const feedbackId = `${nextId('spot')}_${uid}`;
        await db.doc(`users/${uid}`).set({ crowns: 0 });

        await indexModule.awardCrowns.run(createdEvent(feedbackId, {
            outcome: 'participant_success',
            userId: uid,
            finderId: uid,
            spotId: feedbackId.split('_')[0],
            role: 'claimer',
        }));

        expect((await db.doc(`users/${uid}`).get()).data().crowns).toBe(0);
        expect((await db.doc(`functionEvents/awardCrowns_${feedbackId}`).get()).exists).toBe(false);

        await cleanupUsers(uid);
    });

    it('AC-15: unconfirmed feedback awards zero Crowns and writes no marker', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const feedbackId = `${nextId('spot')}_${driverId}`;
        await Promise.all([
            db.doc(`users/${driverId}`).set({ crowns: 4 }),
            db.doc(`users/${finderId}`).set({ crowns: 7 }),
        ]);

        await indexModule.awardCrowns.run(createdEvent(feedbackId, {
            outcome: 'unconfirmed',
            userId: driverId,
            finderId,
        }));

        expect((await db.doc(`users/${driverId}`).get()).data().crowns).toBe(4);
        expect((await db.doc(`users/${finderId}`).get()).data().crowns).toBe(7);
        expect((await db.doc(`functionEvents/awardCrowns_${feedbackId}`).get()).exists).toBe(false);

        await cleanupUsers(driverId, finderId);
    });

    it('AC-16: a one-sided attestation awards zero Crowns and zero trust and writes no marker', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const seeded = await seedRewardablePair({ driverId, finderId, omitFinderDoc: true, driverCrowns: 4, finderCrowns: 7 });

        await indexModule.awardCrowns.run(createdEvent(seeded.pairId, seeded.claimerDoc));
        await indexModule.updateTrustOnFeedback.run(createdEvent(seeded.pairId, seeded.claimerDoc));

        expect((await db.doc(`users/${driverId}`).get()).data().crowns).toBe(4);
        expect((await db.doc(`users/${finderId}`).get()).data().crowns).toBe(7);
        expect((await db.doc(`users/${finderId}`).get()).data().trustStats).toBeUndefined();
        expect((await db.doc(`spots/${seeded.spotId}`).get()).data().claimState).toBe('arrived_pending_outcome');
        expect((await db.doc(`functionEvents/awardCrowns_${seeded.pairId}`).get()).exists).toBe(false);

        await cleanupUsers(driverId, finderId);
    });

    it('AC-17: simultaneous claimer and finder deliveries award once', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const seeded = await seedRewardablePair({ driverId, finderId });

        await Promise.all([
            indexModule.awardCrowns.run(createdEvent(seeded.pairId, seeded.claimerDoc)),
            indexModule.updateTrustOnFeedback.run(createdEvent(`${seeded.pairId}_finder`, seeded.finderDoc)),
        ]);

        const [driverSnap, finderSnap] = await Promise.all([
            db.doc(`users/${driverId}`).get(),
            db.doc(`users/${finderId}`).get(),
        ]);
        expect(driverSnap.data().crowns).toBe(1);
        expect(finderSnap.data().crowns).toBe(2);
        expect(finderSnap.data().trustStats.handoffsCompleted).toBe(1);
        expect((await db.doc(`spots/${seeded.spotId}`).get()).data().claimState).toBe('completed_success');

        await cleanupUsers(driverId, finderId);
        await cleanupMarker(seeded.pairId);
    });

    it('AC-18: claimer failure wins over finder success — zero Crowns, not completed_success', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const seeded = await seedRewardablePair({
            driverId,
            finderId,
            driverCrowns: 2,
            finderCrowns: 5,
            claimerOutcome: 'failed',
            claimerRole: 'claimer',
        });

        await indexModule.awardCrowns.run(createdEvent(`${seeded.pairId}_finder`, seeded.finderDoc));

        expect((await db.doc(`users/${driverId}`).get()).data().crowns).toBe(2);
        expect((await db.doc(`users/${finderId}`).get()).data().crowns).toBe(5);
        expect((await db.doc(`users/${finderId}`).get()).data().trustStats).toBeUndefined();
        expect((await db.doc(`spots/${seeded.spotId}`).get()).data().claimState).toBe('arrived_pending_outcome');
        expect((await db.doc(`spotFeedback/${seeded.pairId}`).get()).data().outcome).toBe('failed');
        expect((await db.doc(`functionEvents/awardCrowns_${seeded.pairId}`).get()).data().outcome).toBe('skipped_claimer_failure');

        await cleanupUsers(driverId, finderId);
        await cleanupMarker(seeded.pairId);
    });

    it('AC-19: mismatched participants award nothing', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const seeded = await seedRewardablePair({
            driverId,
            finderId,
            driverCrowns: 1,
            finderCrowns: 1,
            claimerFinderId: nextId('other'),
        });

        await indexModule.awardCrowns.run(createdEvent(seeded.pairId, {
            ...seeded.claimerDoc,
            finderId: seeded.claimerDoc.finderId,
        }));

        expect((await db.doc(`users/${driverId}`).get()).data().crowns).toBe(1);
        expect((await db.doc(`users/${finderId}`).get()).data().crowns).toBe(1);
        expect((await db.doc(`spots/${seeded.spotId}`).get()).data().claimState).toBe('arrived_pending_outcome');
        expect((await db.doc(`functionEvents/awardCrowns_${seeded.pairId}`).get()).data().outcome).toBe('skipped_mismatch');

        await cleanupUsers(driverId, finderId);
        await cleanupMarker(seeded.pairId);
    });

    it('AC-20: a legacy single success outcome awards zero Crowns', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const feedbackId = `${nextId('spot')}_${driverId}`;
        await db.doc(`users/${driverId}`).set({ crowns: 6 });
        await db.doc(`users/${finderId}`).set({ crowns: 8 });

        await indexModule.awardCrowns.run(createdEvent(feedbackId, {
            outcome: 'success',
            userId: driverId,
            finderId,
            spotId: feedbackId,
        }));

        expect((await db.doc(`users/${driverId}`).get()).data().crowns).toBe(6);
        expect((await db.doc(`users/${finderId}`).get()).data().crowns).toBe(8);
        expect((await db.doc(`functionEvents/awardCrowns_${feedbackId}`).get()).exists).toBe(false);

        await cleanupUsers(driverId, finderId);
    });

    it('AC-21: attestations created strictly after the two-hour window are not rewardable', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const arrivedAt = Timestamp.fromMillis(Date.now() - TWO_HOURS_MS - 5_000);
        const createdAt = Timestamp.fromMillis(arrivedAt.toMillis() + TWO_HOURS_MS + 1);
        const seeded = await seedRewardablePair({
            driverId,
            finderId,
            driverCrowns: 1,
            finderCrowns: 1,
            arrivedAt,
            createdAt,
        });

        await indexModule.awardCrowns.run(createdEvent(seeded.pairId, seeded.claimerDoc));

        expect((await db.doc(`users/${driverId}`).get()).data().crowns).toBe(1);
        expect((await db.doc(`users/${finderId}`).get()).data().crowns).toBe(1);
        expect((await db.doc(`spots/${seeded.spotId}`).get()).data().claimState).toBe('arrived_pending_outcome');
        expect((await db.doc(`functionEvents/awardCrowns_${seeded.pairId}`).get()).data().outcome).toBe('skipped_late');

        await cleanupUsers(driverId, finderId);
        await cleanupMarker(seeded.pairId);
    });

    it('AC-9: Runtime-IAM canary config-contract — awardCrowns runs as the dedicated parqueen-system-events identity (Wave 7B-3)', () => {
        const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const start = src.indexOf('exports.awardCrowns = onDocumentCreated(');
        expect(start).toBeGreaterThan(-1);
        const fn = src.slice(start, src.indexOf('exports.adminDeleteSpot', start));
        expect(fn).toMatch(/serviceAccount:\s*'parqueen-system-events@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
        expect(fn).toMatch(/document:\s*"spotFeedback\/\{feedbackId\}"/);
        expect(fn).toMatch(/outcome !== 'participant_success'/);
        expect(fn).toMatch(/joinMutualSuccess\(db, event, mutualSuccessDeps\)/);
        expect(fn).toMatch(/retry:\s*true/);
        const joinSrc = fs.readFileSync(path.join(__dirname, 'mutualSuccessJoin.js'), 'utf8');
        expect(joinSrc).toMatch(/functionEvents\/awardCrowns_\$\{pairId\}/);
    });
});
