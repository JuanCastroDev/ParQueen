'use strict';

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const { requireEmulatorProjectId } = require('./emulatorProjectId');
const PROJECT_ID = requireEmulatorProjectId();
const APP_NAME = '__ping_notification_privacy_intg__';
const testApp = getApps().find(app => app.name === APP_NAME) ?? initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const indexModule = require('./index.js');

const RUN = `${process.pid}_${Date.now()}`;
let sequence = 0;
const nextId = label => `pn_${label}_${RUN}_${++sequence}`;

const PAST = Timestamp.fromMillis(Date.now() - 60_000);
const FUTURE = Timestamp.fromMillis(Date.now() + 60 * 60_000);

function createdEvent(spotId, data, eventId = `event_${spotId}`, time = new Date().toISOString()) {
    return {
        id: eventId,
        params: { spotId },
        data: { id: spotId, data: () => data },
        time,
    };
}

async function removeCollectionDocs(collectionName, field, value) {
    const snap = await db.collection(collectionName).where(field, '==', value).get();
    await Promise.all(snap.docs.map(doc => doc.ref.delete()));
}

describe('Ping notification/privacy Function contract', () => {
    beforeEach(() => {
        if (!indexModule._pingNotificationHooks) return;
        indexModule._pingNotificationHooks.sendEach = async messages => ({
            successCount: messages.length,
            failureCount: 0,
            responses: messages.map(() => ({ success: true })),
        });
        indexModule._pingNotificationHooks.send = async () => 'message-id';
        indexModule._pingNotificationHooks.beforeStaleTokenCleanup = null;
        indexModule._pingNotificationHooks.now = null;
    });

    afterEach(() => {
        if (!indexModule._pingNotificationHooks) return;
        indexModule._pingNotificationHooks.sendEach = null;
        indexModule._pingNotificationHooks.send = null;
        indexModule._pingNotificationHooks.beforeStaleTokenCleanup = null;
        indexModule._pingNotificationHooks.now = null;
        vi.restoreAllMocks();
    });

    it('PN-1 increments once for a retry and again when the same Ping ID is genuinely recreated', async () => {
        const spotId = nextId('count');
        const statsRef = db.doc('stats/global');
        await statsRef.set({ totalSpotsPinged: 0 }, { merge: true });

        const firstEvent = createdEvent(spotId, { finderId: 'owner_a', geohash: 'dr5r', lat: 40.7, lng: -73.9 }, nextId('event'));
        await indexModule.incrementTotalSpotsPinged.run(firstEvent);
        await indexModule.incrementTotalSpotsPinged.run(firstEvent);
        await indexModule.incrementTotalSpotsPinged.run(
            createdEvent(spotId, { finderId: 'owner_a', geohash: 'dr5r', lat: 40.7, lng: -73.9 }, nextId('event')),
        );

        expect((await statsRef.get()).data().totalSpotsPinged).toBe(2);
        await removeCollectionDocs('functionEvents', 'spotId', spotId);
    });

    it('PN-2 ignores malformed created Ping documents', async () => {
        const spotId = nextId('malformed');
        const statsRef = db.doc('stats/global');
        await statsRef.set({ totalSpotsPinged: 20 }, { merge: true });
        await indexModule.incrementTotalSpotsPinged.run(createdEvent(spotId, { finderId: '', geohash: null }));
        expect((await statsRef.get()).data().totalSpotsPinged).toBe(20);
    });

    it('PN-11 Runtime-IAM canary config-contract — incrementTotalSpotsPinged runs as the dedicated parqueen-system-events identity (Wave 7B-1)', () => {
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const start = src.indexOf('exports.incrementTotalSpotsPinged = onDocumentCreated(');
        expect(start).toBeGreaterThan(-1);
        const fn = src.slice(start, src.indexOf('exports.notifyNearbyUsers', start));
        expect(fn).toMatch(/serviceAccount:\s*'parqueen-system-events@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
        expect(fn).toMatch(/document:\s*"spots\/\{spotId\}"/);
        expect(fn).toMatch(/functionEvents\/incrementTotalSpotsPinged_\$\{stableId\(event\.id\)\}/);
    });

    it('PN-3 retries do not duplicate nearby push or bell delivery', async () => {
        const spotId = nextId('nearby');
        const ownerId = nextId('owner');
        const recipientId = nextId('recipient');
        const now = Date.now();
        const geohash = require('geofire-common').geohashForLocation([40.7128, -74.006], 9);
        await db.doc(`userLocations/${recipientId}`).set({
            lastGeohash: geohash,
            lastGeohashUpdatedAt: Timestamp.fromMillis(now),
        });
        await db.doc(`users/${recipientId}/private/preferences`).set({
            fcmToken: `token_${recipientId}`,
            notificationsEnabled: true,
            notificationRadius: 1,
        });
        const batches = [];
        indexModule._pingNotificationHooks.sendEach = async messages => {
            batches.push(messages);
            return { successCount: messages.length, failureCount: 0, responses: messages.map(() => ({ success: true })) };
        };

        const prefix = geohash.substring(0, 4);
        const seededLocations = await db.collection('userLocations')
            .where('lastGeohash', '>=', prefix)
            .where('lastGeohash', '<=', `${prefix}\uf8ff`)
            .get();
        expect(seededLocations.docs.some(doc => doc.id === recipientId)).toBe(true);
        expect((await db.doc(`users/${recipientId}/private/preferences`).get()).exists).toBe(true);
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

        const event = createdEvent(spotId, { finderId: ownerId, geohash, lat: 40.7128, lng: -74.006 });
        await indexModule.notifyNearbyUsers.run(event);
        await indexModule.notifyNearbyUsers.run(event);
        await indexModule.notifyNearbyUsers.run(createdEvent(
            spotId,
            { finderId: ownerId, geohash, lat: 40.7128, lng: -74.006 },
            nextId('recreated_event'),
        ));

        expect(errors).not.toHaveBeenCalled();
        expect(batches.flat()).toHaveLength(2);
        const outbound = batches.flat();
        expect(outbound.map(message => message.data)).toEqual([
            expect.objectContaining({
                navigationVersion: '1',
                navigationType: 'ping',
                spotId,
                deliveryId: expect.stringMatching(/^nearby_[a-f0-9]{64}$/),
            }),
            expect.objectContaining({
                navigationVersion: '1',
                navigationType: 'ping',
                spotId,
                deliveryId: expect.stringMatching(/^nearby_[a-f0-9]{64}$/),
            }),
        ]);
        expect(new Set(outbound.map(message => message.data.deliveryId)).size).toBe(2);
        for (const message of outbound) {
            expect(Object.keys(message.data).sort()).toEqual([
                'deliveryId', 'navigationType', 'navigationVersion', 'spotId',
            ]);
            expect(JSON.stringify(message.data)).not.toContain(ownerId);
            expect(JSON.stringify(message.data)).not.toContain(recipientId);
            expect(JSON.stringify(message.data)).not.toContain('40.7128');
            expect(JSON.stringify(message.data)).not.toContain('-74.006');
        }
        const bells = await db.collection('spotNotifications').where('spotId', '==', spotId).get();
        expect(bells.docs).toHaveLength(2);
        expect(new Set(bells.docs.map(doc => doc.id))).toEqual(
            new Set(outbound.map(message => message.data.deliveryId)),
        );
        expect(bells.docs[0].data()).toMatchObject({
            spotId,
            senderId: ownerId,
            targetUserId: recipientId,
            claimId: null,
            type: 'nearby_spot',
        });

        await Promise.all([
            db.doc(`userLocations/${recipientId}`).delete(),
            db.doc(`users/${recipientId}/private/preferences`).delete(),
            ...bells.docs.map(doc => doc.ref.delete()),
            removeCollectionDocs('notificationDeliveries', 'spotId', spotId),
        ]);
    });

    it('PN-4 stale-token cleanup preserves a replacement token written after send', async () => {
        const spotId = nextId('stale');
        const ownerId = nextId('owner');
        const recipientId = nextId('recipient');
        const now = Date.now();
        const geohash = require('geofire-common').geohashForLocation([40.7128, -74.006], 9);
        const prefsRef = db.doc(`users/${recipientId}/private/preferences`);
        await db.doc(`userLocations/${recipientId}`).set({ lastGeohash: geohash, lastGeohashUpdatedAt: Timestamp.fromMillis(now) });
        await prefsRef.set({ fcmToken: 'stale-token', notificationsEnabled: true, notificationRadius: 1 });
        indexModule._pingNotificationHooks.sendEach = async messages => ({
            successCount: 0,
            failureCount: messages.length,
            responses: messages.map(() => ({ success: false, error: { code: 'messaging/registration-token-not-registered' } })),
        });
        indexModule._pingNotificationHooks.beforeStaleTokenCleanup = async () => {
            await prefsRef.update({ fcmToken: 'replacement-token' });
        };

        await indexModule.notifyNearbyUsers.run(createdEvent(spotId, { finderId: ownerId, geohash, lat: 40.7128, lng: -74.006 }));
        expect((await prefsRef.get()).data().fcmToken).toBe('replacement-token');

        await Promise.all([
            db.doc(`userLocations/${recipientId}`).delete(), prefsRef.delete(),
            removeCollectionDocs('spotNotifications', 'spotId', spotId),
            removeCollectionDocs('notificationDeliveries', 'spotId', spotId),
        ]);
    });

    it('PN-5 scheduled reminder uses recipient language and records complete deterministic metadata', async () => {
        const spotId = nextId('reminder');
        const ownerId = nextId('owner');
        const claimerId = nextId('claimer');
        const now = Timestamp.now();
        await db.doc(`users/${claimerId}/private/preferences`).set({ fcmToken: 'reminder-token', lang: 'es' });
        await db.doc(`spots/${spotId}`).set({
            finderId: ownerId,
            finderName: 'Owner',
            status: 'interested',
            claimState: 'committed',
            interestedUserId: claimerId,
            claimReminderAt: Timestamp.fromMillis(now.toMillis() - 1000),
            claimAutoReleaseAt: Timestamp.fromMillis(now.toMillis() + 600000),
            expiresAt: Timestamp.fromMillis(now.toMillis() + 1200000),
        });
        const sent = [];
        indexModule._pingNotificationHooks.send = async message => { sent.push(message); return 'message-id'; };
        await indexModule.processScheduledClaims.run({});
        await indexModule.processScheduledClaims.run({});

        expect(sent).toHaveLength(1);
        expect(sent[0].notification.title).toBe('🅿️ Lugar abriéndose pronto');
        const notifications = await db.collection('spotNotifications').where('spotId', '==', spotId).get();
        expect(notifications.docs).toHaveLength(1);
        const internalClaimId = notifications.docs[0].data().claimId;
        expect(sent[0].data).toEqual({
            navigationVersion: '1',
            navigationType: 'ping',
            spotId,
            deliveryId: expect.stringMatching(/^reminder_[a-f0-9]{64}$/),
        });
        expect(sent[0].data).not.toHaveProperty('claimId');
        expect(sent[0].data.deliveryId).not.toBe(notifications.docs[0].id);
        expect(sent[0].data.deliveryId).not.toContain(internalClaimId);
        expect(JSON.stringify(sent[0].data)).not.toContain(ownerId);
        expect(JSON.stringify(sent[0].data)).not.toContain(claimerId);
        expect(notifications.docs[0].data()).toMatchObject({
            spotId,
            senderId: null,
            actorType: 'system',
            subjectUserId: ownerId,
            targetUserId: claimerId,
            type: 'scheduled_claim_reminder',
        });

        await Promise.all([
            db.doc(`spots/${spotId}`).delete(),
            db.doc(`users/${claimerId}/private/preferences`).delete(),
            ...notifications.docs.map(doc => doc.ref.delete()),
        ]);
    });

    it('PN-5b cleaning reminders carry only a stable hashed My Car route and distinct events do not collide', async () => {
        const sessionId = nextId('cleaning_session');
        const sessionRef = db.doc(`parkingSessions/${sessionId}`);
        const sent = [];
        indexModule._pingNotificationHooks.send = async message => { sent.push(message); return 'message-id'; };

        const firstReminderAt = Timestamp.fromMillis(Date.now() - 120000);
        const firstSavedAt = Timestamp.fromMillis(Date.now() - 240000);
        await sessionRef.set({
            active: true,
            reminderEnabled: true,
            reminderSent: false,
            reminderAt: firstReminderAt,
            savedAt: firstSavedAt,
            fcmToken: `token_${sessionId}`,
            streetName: 'Private Test Street',
            reminderMinutesBefore: 30,
        });
        await indexModule.scheduleCleaningReminders.run({});
        await indexModule.scheduleCleaningReminders.run({});

        expect(sent).toHaveLength(1);
        expect(sent[0].data).toEqual({
            navigationVersion: '1',
            navigationType: 'my_car',
            deliveryId: expect.stringMatching(/^cleaning_[a-f0-9]{64}$/),
        });
        const firstDeliveryId = sent[0].data.deliveryId;
        const serializedFirstData = JSON.stringify(sent[0].data);
        expect(serializedFirstData).not.toContain(sessionId);
        expect(serializedFirstData).not.toContain(String(firstReminderAt.toMillis()));
        expect(serializedFirstData).not.toContain(String(firstSavedAt.toMillis()));
        expect(serializedFirstData).not.toContain('Private Test Street');
        expect(serializedFirstData).not.toContain(`token_${sessionId}`);

        const secondSavedAt = Timestamp.fromMillis(firstSavedAt.toMillis() + 1000);
        await sessionRef.update({ savedAt: secondSavedAt, reminderSent: false });
        await indexModule.scheduleCleaningReminders.run({});
        expect(sent).toHaveLength(2);
        expect(sent[1].data.deliveryId).toMatch(/^cleaning_[a-f0-9]{64}$/);
        expect(sent[1].data.deliveryId).not.toBe(firstDeliveryId);
        expect(JSON.stringify(sent[1].data)).not.toContain(String(secondSavedAt.toMillis()));

        await sessionRef.delete();
    });

    it('PN-6 auto-release transition and both participant notifications commit once', async () => {
        const spotId = nextId('release');
        const ownerId = nextId('owner');
        const claimerId = nextId('claimer');
        const now = Timestamp.now();
        await db.doc(`spots/${spotId}`).set({
            finderId: ownerId,
            status: 'interested',
            claimState: 'committed',
            interestedUserId: claimerId,
            claimReminderAt: null,
            claimAutoReleaseAt: Timestamp.fromMillis(now.toMillis() - 1000),
            expiresAt: Timestamp.fromMillis(now.toMillis() + 600000),
        });
        await indexModule.processScheduledClaims.run({});
        await indexModule.processScheduledClaims.run({});

        expect((await db.doc(`spots/${spotId}`).get()).data()).toMatchObject({
            status: 'available', interestedUserId: null, claimState: null,
        });
        const notifications = await db.collection('spotNotifications').where('spotId', '==', spotId).get();
        expect(notifications.docs).toHaveLength(2);
        expect(notifications.docs.map(doc => doc.data().targetUserId).sort()).toEqual([claimerId, ownerId].sort());
        expect(notifications.docs.every(doc => typeof doc.data().claimId === 'string')).toBe(true);
        expect(notifications.docs.every(doc => doc.data().senderId === null)).toBe(true);

        await Promise.all([db.doc(`spots/${spotId}`).delete(), ...notifications.docs.map(doc => doc.ref.delete())]);
    });

    it('PN-7 invalid self-claim is released without a self-notification', async () => {
        const spotId = nextId('self');
        const ownerId = nextId('owner');
        const now = Timestamp.now();
        await db.doc(`spots/${spotId}`).set({
            finderId: ownerId,
            status: 'interested',
            claimState: 'committed',
            interestedUserId: ownerId,
            claimReminderAt: null,
            claimAutoReleaseAt: Timestamp.fromMillis(now.toMillis() - 1000),
            expiresAt: Timestamp.fromMillis(now.toMillis() + 600000),
        });
        await indexModule.processScheduledClaims.run({});
        const notifications = await db.collection('spotNotifications').where('spotId', '==', spotId).get();
        expect(notifications.empty).toBe(true);
        expect((await db.doc(`spots/${spotId}`).get()).data().status).toBe('available');
        await db.doc(`spots/${spotId}`).delete();
    });

    it('PN-8 leaves one durable bell and does not retry an ambiguous failed push attempt', async () => {
        const spotId = nextId('ambiguous');
        const ownerId = nextId('owner');
        const recipientId = nextId('recipient');
        const geohash = require('geofire-common').geohashForLocation([40.7128, -74.006], 9);
        await db.doc(`userLocations/${recipientId}`).set({ lastGeohash: geohash, lastGeohashUpdatedAt: Timestamp.now() });
        await db.doc(`users/${recipientId}/private/preferences`).set({ fcmToken: 'ambiguous-token', notificationRadius: 1 });
        let attempts = 0;
        indexModule._pingNotificationHooks.sendEach = async () => { attempts += 1; throw new Error('ambiguous provider result'); };
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const event = createdEvent(spotId, { finderId: ownerId, geohash, lat: 40.7128, lng: -74.006 }, nextId('event'));

        await indexModule.notifyNearbyUsers.run(event);
        await indexModule.notifyNearbyUsers.run(event);

        expect(attempts).toBe(1);
        expect(errors).toHaveBeenCalledTimes(1);
        expect((await db.collection('spotNotifications').where('spotId', '==', spotId).get()).docs).toHaveLength(1);
        const deliveries = await db.collection('notificationDeliveries').where('spotId', '==', spotId).get();
        expect(deliveries.docs).toHaveLength(1);
        expect(deliveries.docs[0].data().status).toBe('reserved');
        await Promise.all([
            db.doc(`userLocations/${recipientId}`).delete(),
            db.doc(`users/${recipientId}/private/preferences`).delete(),
            removeCollectionDocs('spotNotifications', 'spotId', spotId),
            removeCollectionDocs('notificationDeliveries', 'spotId', spotId),
        ]);
    });

    it('PN-9 a later claim with the same timeout has a distinct generation and cannot collide', async () => {
        const spotId = nextId('claim_generation');
        const ownerId = nextId('owner');
        const firstClaimerId = nextId('claimer');
        const secondClaimerId = nextId('claimer');
        const timeout = Timestamp.fromMillis(Date.now() - 1000);
        const expiresAt = Timestamp.fromMillis(Date.now() + 600000);
        const spotRef = db.doc(`spots/${spotId}`);
        await spotRef.set({
            finderId: ownerId, status: 'interested', claimState: 'committed', interestedUserId: firstClaimerId,
            claimReminderAt: null, claimAutoReleaseAt: timeout, expiresAt,
        });
        await indexModule.processScheduledClaims.run({});
        await spotRef.update({
            status: 'interested', claimState: 'committed', interestedUserId: secondClaimerId,
            claimReminderAt: null, claimAutoReleaseAt: timeout, expiresAt,
        });
        await indexModule.processScheduledClaims.run({});

        const notifications = await db.collection('spotNotifications').where('spotId', '==', spotId).get();
        expect(notifications.docs).toHaveLength(4);
        expect(new Set(notifications.docs.map(doc => doc.data().claimId)).size).toBe(2);
        expect(notifications.docs.every(doc => doc.data().senderId === null)).toBe(true);
        await Promise.all([spotRef.delete(), ...notifications.docs.map(doc => doc.ref.delete())]);
    });

    it('PN-10 partial multicast success is terminal per recipient and never resends the success', async () => {
        const spotId = nextId('partial');
        const ownerId = nextId('owner');
        const recipientIds = [nextId('recipient'), nextId('recipient')];
        const geohash = require('geofire-common').geohashForLocation([40.7128, -74.006], 9);
        await Promise.all(recipientIds.flatMap((recipientId, index) => [
            db.doc(`userLocations/${recipientId}`).set({ lastGeohash: geohash, lastGeohashUpdatedAt: Timestamp.now() }),
            db.doc(`users/${recipientId}/private/preferences`).set({ fcmToken: `partial-token-${index}`, notificationRadius: 1 }),
        ]));
        let attempts = 0;
        indexModule._pingNotificationHooks.sendEach = async messages => {
            attempts += 1;
            return {
                successCount: 1,
                failureCount: 1,
                responses: messages.map((_, index) => index === 0
                    ? { success: true }
                    : { success: false, error: { code: 'messaging/internal-error' } }),
            };
        };
        const event = createdEvent(spotId, { finderId: ownerId, geohash, lat: 40.7128, lng: -74.006 }, nextId('event'));

        await indexModule.notifyNearbyUsers.run(event);
        await indexModule.notifyNearbyUsers.run(event);

        expect(attempts).toBe(1);
        const deliveries = await db.collection('notificationDeliveries').where('spotId', '==', spotId).get();
        expect(deliveries.docs.map(doc => doc.data().status).sort()).toEqual(['failed', 'sent']);
        expect((await db.collection('spotNotifications').where('spotId', '==', spotId).get()).docs).toHaveLength(2);
        await Promise.all([
            ...recipientIds.flatMap(recipientId => [
                db.doc(`userLocations/${recipientId}`).delete(),
                db.doc(`users/${recipientId}/private/preferences`).delete(),
            ]),
            removeCollectionDocs('spotNotifications', 'spotId', spotId),
            removeCollectionDocs('notificationDeliveries', 'spotId', spotId),
        ]);
    });
});

// ─── Admin spot deletion — trust-penalty exemption contract (Wave 6B-3) ─────
// adminDeleteSpot (functions/index.js) writes source:'admin' on the spot
// immediately before the hard delete specifically so this trigger's
// `if (source === 'admin') return;` guard skips the finder's cancellation
// trust penalty. TD-1..3 prove updateTrustOnSpotDelete's own behavior via
// the same .run(event) seam used above; TD-4 proves the write-before-delete
// ordering adminDeleteSpot's side of the contract depends on.
describe('Admin spot deletion — trust-penalty exemption contract (Wave 6B-3)', () => {
    async function seedUser(uid) {
        await db.doc(`users/${uid}`).set({ createdAt: Timestamp.now() });
    }
    async function cleanupUser(uid, spotId) {
        await db.doc(`users/${uid}`).delete();
        await db.doc(`users/${uid}/processedTrustEvents/${spotId}:finder-cancel`).delete();
    }

    it('TD-1: source:"admin" exempts the finder from the normal cancellation trust penalty', async () => {
        const finderId = nextId('td_finder');
        const spotId = nextId('td_spot');
        await seedUser(finderId);

        await indexModule.updateTrustOnSpotDelete.run(
            createdEvent(spotId, { status: 'interested', finderId, source: 'admin' }, nextId('event')),
        );

        const userSnap = await db.doc(`users/${finderId}`).get();
        expect(userSnap.data().trustStats).toBeUndefined();
        const processedSnap = await db.doc(`users/${finderId}/processedTrustEvents/${spotId}:finder-cancel`).get();
        expect(processedSnap.exists).toBe(false);

        await cleanupUser(finderId, spotId);
    });

    it('TD-2: an ordinary (explicit source:"user") deletion still applies the normal finder cancellation penalty', async () => {
        const finderId = nextId('td_finder');
        const spotId = nextId('td_spot');
        await seedUser(finderId);

        await indexModule.updateTrustOnSpotDelete.run(
            createdEvent(spotId, { status: 'interested', finderId, source: 'user' }, nextId('event')),
        );

        const userSnap = await db.doc(`users/${finderId}`).get();
        expect(userSnap.data().trustStats.handoffsCancelledByFinder).toBe(1);
        const processedSnap = await db.doc(`users/${finderId}/processedTrustEvents/${spotId}:finder-cancel`).get();
        expect(processedSnap.exists).toBe(true);
        expect(processedSnap.data().source).toBe('user');

        await cleanupUser(finderId, spotId);
    });

    it('TD-3: a deletion with no source field at all (the real shape of every non-admin deletion path) still applies the penalty', async () => {
        const finderId = nextId('td_finder');
        const spotId = nextId('td_spot');
        await seedUser(finderId);

        await indexModule.updateTrustOnSpotDelete.run(
            createdEvent(spotId, { status: 'interested', finderId }, nextId('event')),
        );

        const userSnap = await db.doc(`users/${finderId}`).get();
        expect(userSnap.data().trustStats.handoffsCancelledByFinder).toBe(1);

        await cleanupUser(finderId, spotId);
    });

    it('TD-4: source-contract — adminDeleteSpot sets source:"admin" before the hard delete (the exact write updateTrustOnSpotDelete depends on)', () => {
        const fs = require('fs');
        const path = require('path');
        const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const fnStart = src.indexOf('exports.adminDeleteSpot = onCall(');
        expect(fnStart).toBeGreaterThan(-1);
        const fnEnd = src.indexOf('exports.bootstrapAdmin = onCall(', fnStart);
        expect(fnEnd).toBeGreaterThan(fnStart);
        const body = src.slice(fnStart, fnEnd);
        const updateIdx = body.indexOf("spotRef.update({ source: 'admin' })");
        const deleteIdx = body.indexOf('spotRef.delete()');
        expect(updateIdx).toBeGreaterThan(-1);
        expect(deleteIdx).toBeGreaterThan(-1);
        expect(updateIdx).toBeLessThan(deleteIdx);
    });
});

// ─── Natural-expiration trust exemption — system-expiration trust-bug fix ───
// handoffsCancelledByFinder measures cancellation of an ACTIVE handoff. Once
// a spot's own expiresAt has passed, ANY later deletion — by
// cleanupExpiredSpotsHourly, a manual client delete, or anything else — is
// normal removal of an already-dead listing, not an active cancellation,
// regardless of which mechanism physically performs the delete. The
// exemption is derived directly from the deleted snapshot's expiresAt and
// the CloudEvent's own event.time (never Date.now()/handler-start time) and
// fails closed: it only applies when both are genuinely valid and parseable.
describe('Natural-expiration trust exemption — updateTrustOnSpotDelete', () => {
    async function seedUser(uid) {
        await db.doc(`users/${uid}`).set({ createdAt: Timestamp.now() });
    }
    async function cleanupUser(uid, spotId) {
        await db.doc(`users/${uid}`).delete();
        await db.doc(`users/${uid}/processedTrustEvents/${spotId}:finder-cancel`).delete();
    }
    async function expectPenalty(finderId, applied) {
        const userSnap = await db.doc(`users/${finderId}`).get();
        if (applied) {
            expect(userSnap.data().trustStats?.handoffsCancelledByFinder).toBe(1);
        } else {
            expect(userSnap.data().trustStats).toBeUndefined();
        }
    }

    it('CASE 1: active spot (expiresAt in the future), no source — finder cancellation penalty APPLIES', async () => {
        const finderId = nextId('exp_finder');
        const spotId = nextId('exp_spot');
        await seedUser(finderId);
        await indexModule.updateTrustOnSpotDelete.run(
            createdEvent(spotId, { status: 'interested', finderId, expiresAt: FUTURE }, nextId('event')),
        );
        await expectPenalty(finderId, true);
        await cleanupUser(finderId, spotId);
    });

    it('CASE 2: admin delete of an active spot — NO penalty (admin exemption independent of expiration)', async () => {
        const finderId = nextId('exp_finder');
        const spotId = nextId('exp_spot');
        await seedUser(finderId);
        await indexModule.updateTrustOnSpotDelete.run(
            createdEvent(spotId, { status: 'interested', finderId, source: 'admin', expiresAt: FUTURE }, nextId('event')),
        );
        await expectPenalty(finderId, false);
        await cleanupUser(finderId, spotId);
    });

    it('CASE 3: naturally expired spot, no source (the system-cleanup shape) — NO penalty', async () => {
        const finderId = nextId('exp_finder');
        const spotId = nextId('exp_spot');
        await seedUser(finderId);
        await indexModule.updateTrustOnSpotDelete.run(
            createdEvent(spotId, { status: 'interested', finderId, expiresAt: PAST }, nextId('event')),
        );
        await expectPenalty(finderId, false);
        await cleanupUser(finderId, spotId);
    });

    it('CASE 4: deletion event occurs at the EXACT expiration instant — NO penalty (<=, not <)', async () => {
        const finderId = nextId('exp_finder');
        const spotId = nextId('exp_spot');
        await seedUser(finderId);
        const boundaryMs = Date.now();
        const expiresAt = Timestamp.fromMillis(boundaryMs);
        const eventTime = new Date(boundaryMs).toISOString();
        await indexModule.updateTrustOnSpotDelete.run(
            createdEvent(spotId, { status: 'interested', finderId, expiresAt }, nextId('event'), eventTime),
        );
        await expectPenalty(finderId, false);
        await cleanupUser(finderId, spotId);
    });

    it('CASE 5: manual/user delete after expiration — NO penalty (same result as system cleanup; no actor/source complexity added)', async () => {
        const finderId = nextId('exp_finder');
        const spotId = nextId('exp_spot');
        await seedUser(finderId);
        await indexModule.updateTrustOnSpotDelete.run(
            createdEvent(spotId, { status: 'interested', finderId, source: 'user', expiresAt: PAST }, nextId('event')),
        );
        await expectPenalty(finderId, false);
        await cleanupUser(finderId, spotId);
    });

    it('CASE 6: missing expiresAt — penalty behavior is preserved (no exemption merely because expiry is unavailable)', async () => {
        const finderId = nextId('exp_finder');
        const spotId = nextId('exp_spot');
        await seedUser(finderId);
        await indexModule.updateTrustOnSpotDelete.run(
            createdEvent(spotId, { status: 'interested', finderId }, nextId('event')), // no expiresAt at all
        );
        await expectPenalty(finderId, true);
        await cleanupUser(finderId, spotId);
    });

    it('CASE 7: malformed expiresAt (wrong type) — does not crash, penalty behavior is preserved', async () => {
        const finderId = nextId('exp_finder');
        const spotId = nextId('exp_spot');
        await seedUser(finderId);
        // Completing without throwing is itself proof of no crash.
        await indexModule.updateTrustOnSpotDelete.run(
            createdEvent(spotId, { status: 'interested', finderId, expiresAt: 'not-a-timestamp' }, nextId('event')),
        );
        await expectPenalty(finderId, true);
        await cleanupUser(finderId, spotId);
    });

    it('CASE 8: malformed/missing event.time — no exemption is granted, penalty behavior is preserved, no crash', async () => {
        const finderId = nextId('exp_finder');
        const spotId = nextId('exp_spot');
        await seedUser(finderId);
        await indexModule.updateTrustOnSpotDelete.run(
            createdEvent(spotId, { status: 'interested', finderId, expiresAt: PAST }, nextId('event'), 'not-a-real-timestamp'),
        );
        await expectPenalty(finderId, true);
        await cleanupUser(finderId, spotId);
    });

    it('CASE 9: admin delete with malformed/missing expiry — NO penalty (admin exemption independent of expiration parsing)', async () => {
        const finderId = nextId('exp_finder');
        const spotId = nextId('exp_spot');
        await seedUser(finderId);
        await indexModule.updateTrustOnSpotDelete.run(
            createdEvent(spotId, { status: 'interested', finderId, source: 'admin' }, nextId('event')), // no expiresAt
        );
        await expectPenalty(finderId, false);
        await cleanupUser(finderId, spotId);
    });

    it('BUG-REPRO: the confirmed steady-state scenario (system-abandoned interested claim, already-expired listing, no source marker) no longer applies a penalty', async () => {
        const finderId = nextId('exp_finder');
        const spotId = nextId('exp_spot');
        await seedUser(finderId);
        // Exact shape cleanupExpiredInterests leaves behind when a heading
        // claim's interestExpiresAt lapses at/after the Ping's own
        // expiresAt: interestedUserId cleared, status left as 'interested'
        // (never reopened — see cleanupExpiredInterests's own "never reopen
        // an already-expired Ping" branch), finderId untouched — then
        // cleanupExpiredSpotsHourly later hard-deletes it via
        // expiresAt<=now (no status filter, no source marker). Before this
        // fix, handoffsCancelledByFinder fired for this exact shape.
        await indexModule.updateTrustOnSpotDelete.run(
            createdEvent(spotId, {
                status: 'interested',
                finderId,
                interestedUserId: null,
                interestExpiresAt: null,
                expiresAt: PAST,
            }, nextId('event')),
        );
        await expectPenalty(finderId, false);
        await cleanupUser(finderId, spotId);
    });
});

// ─── Wave 7B-2 — trust-event runtime isolation (updateTrustOnFeedback / updateTrustOnSpotDelete) ───
// Runtime-configuration-only migration to the dedicated parqueen-system-events
// identity. Trust calculations, expiration/admin exemptions, and the shared
// applyTrustDelta processedTrustEvents marker are unchanged — see the
// describe blocks above for the exemption matrix, which is unaffected by
// this runtime change.
describe('Trust-event runtimes (Wave 7B-2)', () => {
    const fs = require('fs');
    const path = require('path');
    async function seedUser(uid) {
        await db.doc(`users/${uid}`).set({ createdAt: Timestamp.now() });
    }
    async function cleanupUser(uid, eventId) {
        await db.doc(`users/${uid}`).delete();
        await db.doc(`users/${uid}/processedTrustEvents/${eventId}`).delete();
    }

    it('TB2-1: Runtime-IAM canary config-contract — updateTrustOnFeedback runs as the dedicated parqueen-system-events identity', () => {
        const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const start = src.indexOf('exports.updateTrustOnFeedback = onDocumentCreated(');
        expect(start).toBeGreaterThan(-1);
        const fn = src.slice(start, src.indexOf('exports.scheduleCleaningReminders', start));
        expect(fn).toMatch(/serviceAccount:\s*'parqueen-system-events@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
        expect(fn).toMatch(/document:\s*'spotFeedback\/\{feedbackId\}'/);
        expect(fn).toMatch(/applyTrustDelta\(finderId, 'handoffsCompleted', `\$\{event\.params\.feedbackId\}:finder`\)/);
    });

    it('TB2-2: Runtime-IAM canary config-contract — updateTrustOnSpotDelete runs as the dedicated parqueen-system-events identity', () => {
        const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const start = src.indexOf('exports.updateTrustOnSpotDelete = onDocumentDeleted(');
        expect(start).toBeGreaterThan(-1);
        const fn = src.slice(start, src.indexOf('exports.adminResolveParseFailure', start));
        expect(fn).toMatch(/serviceAccount:\s*'parqueen-system-events@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
        expect(fn).toMatch(/document:\s*'spots\/\{spotId\}'/);
        expect(fn).toMatch(/source === 'admin'/);
        expect(fn).toMatch(/expiresAt\.toMillis\(\) <= deletionTimeMs/);
    });

    it('TB2-3: updateTrustOnFeedback duplicate delivery — the same feedback event applies only one trust delta', async () => {
        const finderId = nextId('tb2_finder');
        const feedbackId = nextId('tb2_feedback');
        await seedUser(finderId);
        const event = createdEvent(feedbackId, { outcome: 'success', finderId }, nextId('event'));

        await indexModule.updateTrustOnFeedback.run(event);
        await indexModule.updateTrustOnFeedback.run(event);

        const userSnap = await db.doc(`users/${finderId}`).get();
        expect(userSnap.data().trustStats.handoffsCompleted).toBe(1);

        await cleanupUser(finderId, `${feedbackId}:finder`);
    });

    it('TB2-4: updateTrustOnSpotDelete duplicate delivery — the same deletion event applies only one trust delta', async () => {
        const finderId = nextId('tb2_finder');
        const spotId = nextId('tb2_spot');
        await seedUser(finderId);
        const event = createdEvent(spotId, { status: 'interested', finderId }, nextId('event'));

        await indexModule.updateTrustOnSpotDelete.run(event);
        await indexModule.updateTrustOnSpotDelete.run(event);

        const userSnap = await db.doc(`users/${finderId}`).get();
        expect(userSnap.data().trustStats.handoffsCancelledByFinder).toBe(1);

        await cleanupUser(finderId, `${spotId}:finder-cancel`);
    });
});
