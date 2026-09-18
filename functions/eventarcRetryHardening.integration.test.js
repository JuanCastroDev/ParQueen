'use strict';

/**
 * Eventarc retry hardening — parqueen-system-events handlers.
 *
 * Confirms retry: true is enabled on all five handlers proven safe:
 * incrementTotalSpotsPinged, updateTrustOnFeedback, updateTrustOnSpotDelete
 * (marker-protected, atomic), initUserPrivateAccount (fill-only-missing-
 * fields, transactional, root-user-existence guarded — see
 * initUserPrivateAccount.integration.test.js's "retry-safety contract" suite,
 * particularly RS-4), and awardCrowns (missing-user condition is now a
 * durable terminal marker instead of a permanent tx.update()-on-missing-doc
 * throw — see awardCrowns.integration.test.js AC-7/AC-10 through AC-14).
 * Proves duplicate Eventarc delivery is safe for each of the three handlers
 * tested directly here.
 *
 * Confirms retry remains OFF on:
 *  - notifyNearbyUsers — separate messaging retry analysis, not in scope
 *    here.
 */

const fs = require('fs');
const path = require('path');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const { requireEmulatorProjectId } = require('./emulatorProjectId');
const PROJECT_ID = requireEmulatorProjectId();
const APP_NAME = '__eventarc_retry_hardening_intg__';
const testApp = getApps().find(app => app.name === APP_NAME) ?? initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const indexModule = require('./index.js');

const RUN = `${process.pid}_${Date.now()}`;
let sequence = 0;
const nextId = label => `erh_${label}_${RUN}_${++sequence}`;

function createdEvent(id, params, data, eventId = `event_${id}`) {
    return { id: eventId, params, data: { id, data: () => data } };
}

function deletedEvent(id, params, data, time) {
    return { id: `event_${id}`, params, data: { id, data: () => data }, time };
}

async function cleanup(...refs) {
    await Promise.all(refs.map(ref => ref.delete().catch(() => {})));
}

// ── Config-contract: retry enabled/excluded exactly as decided ───────────────
describe('Eventarc retry configuration — parqueen-system-events handlers', () => {
    const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

    function sliceFn(exportName, nextExportName) {
        const start = src.indexOf(`exports.${exportName} = `);
        expect(start).toBeGreaterThan(-1);
        const end = nextExportName ? src.indexOf(`exports.${nextExportName}`, start) : start + 2000;
        return src.slice(start, end);
    }

    it('initUserPrivateAccount has retry enabled (fill-only-missing-fields design proven retry-safe — see initUserPrivateAccount.integration.test.js RS-4)', () => {
        expect(sliceFn('initUserPrivateAccount', 'cleanupExpiredSpotsHourly')).toMatch(/retry:\s*true/);
    });

    it('incrementTotalSpotsPinged has retry enabled', () => {
        expect(sliceFn('incrementTotalSpotsPinged', 'notifyNearbyUsers')).toMatch(/retry:\s*true/);
    });

    it('updateTrustOnFeedback has retry enabled', () => {
        expect(sliceFn('updateTrustOnFeedback', 'scheduleCleaningReminders')).toMatch(/retry:\s*true/);
    });

    it('updateTrustOnSpotDelete has retry enabled', () => {
        expect(sliceFn('updateTrustOnSpotDelete', 'adminResolveParseFailure')).toMatch(/retry:\s*true/);
    });

    it('awardCrowns has retry enabled (missing-user condition now a durable terminal marker — see AC-7/AC-10 through AC-14)', () => {
        expect(sliceFn('awardCrowns', 'adminDeleteSpot')).toMatch(/retry:\s*true/);
    });

    it('notifyNearbyUsers remains WITHOUT retry — out of scope, requires separate FCM partial-delivery retry analysis', () => {
        expect(sliceFn('notifyNearbyUsers', 'generateEmailOTP')).not.toMatch(/retry:\s*true/);
    });

    it('moderateAvatarUpload (already retry-enabled, out of scope for this change) is unaffected', () => {
        expect(sliceFn('moderateAvatarUpload', '_isAllowedImageHeader')).toMatch(/retry:\s*true/);
    });
});

// ── incrementTotalSpotsPinged: duplicate delivery ─────────────────────────────
describe('incrementTotalSpotsPinged duplicate-delivery safety', () => {
    it('the same event delivered twice sequentially increments stats/global by exactly 1', async () => {
        const spotId = nextId('spot');
        const finderId = nextId('finder');
        const statsRef = db.doc('stats/global');
        const before = (await statsRef.get()).data()?.totalSpotsPinged || 0;
        const event = createdEvent(spotId, { spotId }, { finderId });

        await indexModule.incrementTotalSpotsPinged.run(event);
        await indexModule.incrementTotalSpotsPinged.run(event);

        const after = (await statsRef.get()).data()?.totalSpotsPinged || 0;
        expect(after - before).toBe(1);

        const markerId = require('crypto').createHash('sha256').update(event.id).digest('hex');
        await cleanup(db.doc(`functionEvents/incrementTotalSpotsPinged_${markerId}`));
    });

    it('the same event delivered concurrently twice increments stats/global by exactly 1', async () => {
        const spotId = nextId('spot');
        const finderId = nextId('finder');
        const statsRef = db.doc('stats/global');
        const before = (await statsRef.get()).data()?.totalSpotsPinged || 0;
        const event = createdEvent(spotId, { spotId }, { finderId });

        await Promise.all([
            indexModule.incrementTotalSpotsPinged.run(event),
            indexModule.incrementTotalSpotsPinged.run(event),
        ]);

        const after = (await statsRef.get()).data()?.totalSpotsPinged || 0;
        expect(after - before).toBe(1);

        const markerId = require('crypto').createHash('sha256').update(event.id).digest('hex');
        await cleanup(db.doc(`functionEvents/incrementTotalSpotsPinged_${markerId}`));
    });
});

// ── updateTrustOnFeedback: duplicate delivery ─────────────────────────────────
describe('updateTrustOnFeedback duplicate-delivery safety', () => {
    it('the same feedback-created event delivered twice applies handoffsCompleted only once', async () => {
        const finderId = nextId('finder');
        const feedbackId = `${nextId('spot')}_${nextId('driver')}`;
        await db.doc(`users/${finderId}`).set({ crowns: 0 });

        const event = createdEvent(feedbackId, { feedbackId }, { outcome: 'success', finderId });
        await indexModule.updateTrustOnFeedback.run(event);
        await indexModule.updateTrustOnFeedback.run(event);

        const userSnap = await db.doc(`users/${finderId}`).get();
        expect(userSnap.data().trustStats.handoffsCompleted).toBe(1);

        await cleanup(
            db.doc(`users/${finderId}`),
            db.doc(`users/${finderId}/processedTrustEvents/${feedbackId}:finder`),
        );
    });

    it('a finder deleted before the event fires is a safe no-op — no throw, no marker (this is why retry-enabling this handler creates no poison-event risk: the only realistic missing-document precondition already terminates cleanly instead of throwing)', async () => {
        const finderId = nextId('finder'); // deliberately never created
        const feedbackId = `${nextId('spot')}_${nextId('driver')}`;
        const event = createdEvent(feedbackId, { feedbackId }, { outcome: 'success', finderId });

        await expect(indexModule.updateTrustOnFeedback.run(event)).resolves.not.toThrow();
        expect((await db.doc(`users/${finderId}/processedTrustEvents/${feedbackId}:finder`).get()).exists).toBe(false);
    });
});

// ── updateTrustOnSpotDelete: duplicate delivery ───────────────────────────────
describe('updateTrustOnSpotDelete duplicate-delivery safety', () => {
    it('the same spot-deleted event delivered twice applies the cancellation penalty only once', async () => {
        const finderId = nextId('finder');
        const spotId = nextId('spot');
        await db.doc(`users/${finderId}`).set({ crowns: 0 });

        const futureExpiry = Timestamp.fromMillis(Date.now() + 60 * 60 * 1000);
        const event = deletedEvent(
            spotId,
            { spotId },
            { status: 'interested', finderId, expiresAt: futureExpiry },
            new Date().toISOString(),
        );

        await indexModule.updateTrustOnSpotDelete.run(event);
        await indexModule.updateTrustOnSpotDelete.run(event);

        const userSnap = await db.doc(`users/${finderId}`).get();
        expect(userSnap.data().trustStats.handoffsCancelledByFinder).toBe(1);

        await cleanup(
            db.doc(`users/${finderId}`),
            db.doc(`users/${finderId}/processedTrustEvents/${spotId}:finder-cancel`),
        );
    });

    it('duplicate delivery of an already-expired spot deletion still applies zero penalty (expiration exemption preserved under retry)', async () => {
        const finderId = nextId('finder');
        const spotId = nextId('spot');
        await db.doc(`users/${finderId}`).set({ crowns: 0 });

        const now = Date.now();
        const event = deletedEvent(
            spotId,
            { spotId },
            { status: 'interested', finderId, expiresAt: Timestamp.fromMillis(now - 1000) },
            new Date(now).toISOString(),
        );

        await indexModule.updateTrustOnSpotDelete.run(event);
        await indexModule.updateTrustOnSpotDelete.run(event);

        const userSnap = await db.doc(`users/${finderId}`).get();
        expect(userSnap.data().trustStats?.handoffsCancelledByFinder || 0).toBe(0);

        await cleanup(db.doc(`users/${finderId}`));
    });
});
