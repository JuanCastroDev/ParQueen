'use strict';

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const { requireEmulatorProjectId } = require('./emulatorProjectId');
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

async function seedUser(uid, crowns = 0) {
    await db.doc(`users/${uid}`).set({ crowns });
}

async function cleanupUsers(...uids) {
    await Promise.all(uids.map(uid => db.doc(`users/${uid}`).delete()));
}

async function cleanupMarker(feedbackId) {
    await db.doc(`functionEvents/awardCrowns_${feedbackId}`).delete();
}

// ─── awardCrowns idempotency contract ────────────────────────────────────────
// Confirmed pre-existing bug (Wave 7B audit): the same spotFeedback creation
// event delivered twice awarded crowns twice — no transaction, no processed
// marker existed. feedbackId is the correct exactly-once key: Firestore rules
// derive it deterministically as `${spotId}_${userId}` and forbid update/delete
// on spotFeedback docs, so the same feedbackId can never be legitimately
// recreated (the one server-side deletion path, deleteAccount, also
// permanently retires that Auth uid via getAuth().deleteUser, so the exact
// pair can never recur under a "new" account either).
describe('awardCrowns idempotency contract', () => {
    it('AC-1: normal delivery awards driver +1, finder +2, correct titles, and records a marker', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const feedbackId = `${nextId('spot')}_${driverId}`;
        await Promise.all([seedUser(driverId), seedUser(finderId)]);

        await indexModule.awardCrowns.run(createdEvent(feedbackId, { outcome: 'success', userId: driverId, finderId }));

        const [driverSnap, finderSnap] = await Promise.all([db.doc(`users/${driverId}`).get(), db.doc(`users/${finderId}`).get()]);
        expect(driverSnap.data().crowns).toBe(1);
        expect(driverSnap.data().title).toBe('Newcomer');
        expect(finderSnap.data().crowns).toBe(2);
        expect(finderSnap.data().title).toBe('Newcomer');
        expect((await db.doc(`functionEvents/awardCrowns_${feedbackId}`).get()).data().outcome).toBe('awarded');

        await cleanupUsers(driverId, finderId);
        await cleanupMarker(feedbackId);
    });

    it('AC-2: the same event delivered twice sequentially awards crowns only once', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const feedbackId = `${nextId('spot')}_${driverId}`;
        await Promise.all([seedUser(driverId), seedUser(finderId)]);
        const event = createdEvent(feedbackId, { outcome: 'success', userId: driverId, finderId });

        await indexModule.awardCrowns.run(event);
        await indexModule.awardCrowns.run(event);

        const [driverSnap, finderSnap] = await Promise.all([db.doc(`users/${driverId}`).get(), db.doc(`users/${finderId}`).get()]);
        expect(driverSnap.data().crowns).toBe(1);
        expect(finderSnap.data().crowns).toBe(2);

        await cleanupUsers(driverId, finderId);
        await cleanupMarker(feedbackId);
    });

    it('AC-3: the same event delivered concurrently twice awards crowns exactly once', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const feedbackId = `${nextId('spot')}_${driverId}`;
        await Promise.all([seedUser(driverId), seedUser(finderId)]);
        const event = createdEvent(feedbackId, { outcome: 'success', userId: driverId, finderId });

        await Promise.all([indexModule.awardCrowns.run(event), indexModule.awardCrowns.run(event)]);

        const [driverSnap, finderSnap] = await Promise.all([db.doc(`users/${driverId}`).get(), db.doc(`users/${finderId}`).get()]);
        expect(driverSnap.data().crowns).toBe(1);
        expect(finderSnap.data().crowns).toBe(2);

        await cleanupUsers(driverId, finderId);
        await cleanupMarker(feedbackId);
    });

    it('AC-4: the same feedbackId with a different event.id still does not award a second time', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const feedbackId = `${nextId('spot')}_${driverId}`;
        await Promise.all([seedUser(driverId), seedUser(finderId)]);

        await indexModule.awardCrowns.run(createdEvent(feedbackId, { outcome: 'success', userId: driverId, finderId }, nextId('event')));
        await indexModule.awardCrowns.run(createdEvent(feedbackId, { outcome: 'success', userId: driverId, finderId }, nextId('event')));

        const [driverSnap, finderSnap] = await Promise.all([db.doc(`users/${driverId}`).get(), db.doc(`users/${finderId}`).get()]);
        expect(driverSnap.data().crowns).toBe(1);
        expect(finderSnap.data().crowns).toBe(2);

        await cleanupUsers(driverId, finderId);
        await cleanupMarker(feedbackId);
    });

    it('AC-5: two distinct feedback documents for the same pair both legitimately award', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const feedbackIdA = `${nextId('spot')}_${driverId}`;
        const feedbackIdB = `${nextId('spot')}_${driverId}`;
        await Promise.all([seedUser(driverId), seedUser(finderId)]);

        await indexModule.awardCrowns.run(createdEvent(feedbackIdA, { outcome: 'success', userId: driverId, finderId }));
        await indexModule.awardCrowns.run(createdEvent(feedbackIdB, { outcome: 'success', userId: driverId, finderId }));

        const [driverSnap, finderSnap] = await Promise.all([db.doc(`users/${driverId}`).get(), db.doc(`users/${finderId}`).get()]);
        expect(driverSnap.data().crowns).toBe(2);
        expect(finderSnap.data().crowns).toBe(4);

        await cleanupUsers(driverId, finderId);
        await cleanupMarker(feedbackIdA);
        await cleanupMarker(feedbackIdB);
    });

    it('AC-6: crossing a title threshold computes the correct post-award title, and a replay does not move it again', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const feedbackId = `${nextId('spot')}_${driverId}`;
        await seedUser(driverId, 9); // one crown below the 10-crown 'Trusted Driver' threshold
        await seedUser(finderId, 0);
        const event = createdEvent(feedbackId, { outcome: 'success', userId: driverId, finderId });

        await indexModule.awardCrowns.run(event);
        let driverSnap = await db.doc(`users/${driverId}`).get();
        expect(driverSnap.data().crowns).toBe(10);
        expect(driverSnap.data().title).toBe('Trusted Driver');

        await indexModule.awardCrowns.run(event); // replay must not move it further
        driverSnap = await db.doc(`users/${driverId}`).get();
        expect(driverSnap.data().crowns).toBe(10);
        expect(driverSnap.data().title).toBe('Trusted Driver');

        await cleanupUsers(driverId, finderId);
        await cleanupMarker(feedbackId);
    });

    it('AC-7: a missing driver user document is a safe terminal no-op — marker written, finder untouched, no throw', async () => {
        const driverId = nextId('driver'); // deliberately never seeded
        const finderId = nextId('finder');
        const feedbackId = `${nextId('spot')}_${driverId}`;
        await seedUser(finderId, 0);

        await expect(
            indexModule.awardCrowns.run(createdEvent(feedbackId, { outcome: 'success', userId: driverId, finderId })),
        ).resolves.not.toThrow();

        const marker = (await db.doc(`functionEvents/awardCrowns_${feedbackId}`).get()).data();
        expect(marker.outcome).toBe('skipped_missing_user');
        expect((await db.doc(`users/${finderId}`).get()).data().crowns).toBe(0);

        await cleanupUsers(finderId);
        await cleanupMarker(feedbackId);
    });

    it('AC-10: a missing finder user document is symmetric — marker written, driver untouched, no throw', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder'); // deliberately never seeded
        const feedbackId = `${nextId('spot')}_${driverId}`;
        await seedUser(driverId, 0);

        await expect(
            indexModule.awardCrowns.run(createdEvent(feedbackId, { outcome: 'success', userId: driverId, finderId })),
        ).resolves.not.toThrow();

        const marker = (await db.doc(`functionEvents/awardCrowns_${feedbackId}`).get()).data();
        expect(marker.outcome).toBe('skipped_missing_user');
        expect((await db.doc(`users/${driverId}`).get()).data().crowns).toBe(0);

        await cleanupUsers(driverId);
        await cleanupMarker(feedbackId);
    });

    it('AC-11: both driver and finder missing — terminal marker, no throw, nothing to touch', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const feedbackId = `${nextId('spot')}_${driverId}`;

        await expect(
            indexModule.awardCrowns.run(createdEvent(feedbackId, { outcome: 'success', userId: driverId, finderId })),
        ).resolves.not.toThrow();

        const marker = (await db.doc(`functionEvents/awardCrowns_${feedbackId}`).get()).data();
        expect(marker.outcome).toBe('skipped_missing_user');

        await cleanupMarker(feedbackId);
    });

    it('AC-12: a redelivered missing-user event no-ops on the terminal marker — no repeated work, no throw', async () => {
        const driverId = nextId('driver'); // deliberately never seeded
        const finderId = nextId('finder');
        const feedbackId = `${nextId('spot')}_${driverId}`;
        await seedUser(finderId, 0);
        const event = createdEvent(feedbackId, { outcome: 'success', userId: driverId, finderId });

        await indexModule.awardCrowns.run(event);
        await expect(indexModule.awardCrowns.run(event)).resolves.not.toThrow();

        expect((await db.doc(`users/${finderId}`).get()).data().crowns).toBe(0);

        await cleanupUsers(finderId);
        await cleanupMarker(feedbackId);
    });

    it('AC-13: concurrent duplicate missing-user event delivery writes exactly one terminal marker, no crowns', async () => {
        const driverId = nextId('driver'); // deliberately never seeded
        const finderId = nextId('finder');
        const feedbackId = `${nextId('spot')}_${driverId}`;
        await seedUser(finderId, 0);
        const event = createdEvent(feedbackId, { outcome: 'success', userId: driverId, finderId });

        await Promise.all([indexModule.awardCrowns.run(event), indexModule.awardCrowns.run(event)]);

        const marker = (await db.doc(`functionEvents/awardCrowns_${feedbackId}`).get()).data();
        expect(marker.outcome).toBe('skipped_missing_user');
        expect((await db.doc(`users/${finderId}`).get()).data().crowns).toBe(0);

        await cleanupUsers(finderId);
        await cleanupMarker(feedbackId);
    });

    it('AC-14: realistic race — driver account deleted (recursiveDelete) between feedback creation and awardCrowns execution — terminal no-op, finder untouched', async () => {
        const driverId = nextId('driver');
        const finderId = nextId('finder');
        const feedbackId = `${nextId('spot')}_${driverId}`;
        await seedUser(driverId, 5);
        await seedUser(finderId, 0);

        // Simulates deleteAccount's recursiveDelete step, which runs long before
        // its spotFeedback cleanup step — the feedback doc (and this event's
        // captured payload) can legitimately outlive the driver's account.
        await db.recursiveDelete(db.doc(`users/${driverId}`));

        await expect(
            indexModule.awardCrowns.run(createdEvent(feedbackId, { outcome: 'success', userId: driverId, finderId })),
        ).resolves.not.toThrow();

        const marker = (await db.doc(`functionEvents/awardCrowns_${feedbackId}`).get()).data();
        expect(marker.outcome).toBe('skipped_missing_user');
        expect((await db.doc(`users/${finderId}`).get()).data().crowns).toBe(0);

        await cleanupUsers(finderId);
        await cleanupMarker(feedbackId);
    });

    it('AC-8: driverId === finderId is a no-op (pre-existing guard) — no crowns, no marker', async () => {
        const uid = nextId('self');
        const feedbackId = `${nextId('spot')}_${uid}`;
        await seedUser(uid, 0);

        await indexModule.awardCrowns.run(createdEvent(feedbackId, { outcome: 'success', userId: uid, finderId: uid }));

        expect((await db.doc(`users/${uid}`).get()).data().crowns).toBe(0);
        expect((await db.doc(`functionEvents/awardCrowns_${feedbackId}`).get()).exists).toBe(false);

        await cleanupUsers(uid);
    });

    it('AC-9: Runtime-IAM canary config-contract — awardCrowns runs as the dedicated parqueen-system-events identity (Wave 7B-3)', () => {
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const start = src.indexOf('exports.awardCrowns = onDocumentCreated(');
        expect(start).toBeGreaterThan(-1);
        const fn = src.slice(start, src.indexOf('exports.adminDeleteSpot', start));
        expect(fn).toMatch(/serviceAccount:\s*'parqueen-system-events@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
        expect(fn).toMatch(/document:\s*"spotFeedback\/\{feedbackId\}"/);
        expect(fn).toMatch(/functionEvents\/awardCrowns_\$\{feedbackId\}/);
        expect(fn).toMatch(/retry:\s*true/);
    });
});
