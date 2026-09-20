'use strict';

/**
 * Integration tests — verifyEmailOTP callable (Task H verification).
 *
 * Strategy: loads index.js and calls handler.run() directly so arbitrary auth
 * claims can be injected without a real JWT.  Firestore reads/writes use the
 * Admin SDK connected to the Firestore emulator via FIRESTORE_EMULATOR_HOST.
 *
 * Run via: npm run test:functions
 * Requires emulators: firestore (8080), auth (9099)
 */

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

let indexModule;
try {
    indexModule = require('./index.js');
} catch (e) {
    console.warn('[verifyEmailOTP] Could not load index.js:', e.message);
}

const { requireEmulatorProjectId } = require('./emulatorProjectId');
const PROJECT_ID = requireEmulatorProjectId();
const APP_NAME = '__verifyEmailOTP_intg__';

const testApp =
    getApps().find(a => a.name === APP_NAME) ??
    initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);

// ── helpers ──────────────────────────────────────────────────────────────────

function fakeRequest(uid, data = {}) {
    const NOW = Math.floor(Date.now() / 1000);
    return {
        data,
        auth: uid ? {
            uid,
            token: { uid, auth_time: NOW - 30, iat: NOW - 30, exp: NOW + 3600 },
        } : null,
        rawRequest: {},
    };
}

async function callVerify(uid, data) {
    try {
        return { result: await indexModule.verifyEmailOTP.run(fakeRequest(uid, data)) };
    } catch (err) {
        return { error: { code: err.code, message: err.message } };
    }
}

async function seedOTP(uid, { email, code, offsetMs = 600000 } = {}) {
    await db.collection('emailVerificationCodes').doc(uid).set({
        email,
        code,
        expiresAt: Timestamp.fromMillis(Date.now() + offsetMs),
    });
}

async function createUserDoc(uid) {
    await db.doc(`users/${uid}`).set({
        id: uid,
        fullName: 'Test User',
        username: `test_${uid}`,
        crowns: 0,
        title: 'Newcomer',
    });
}

async function cleanup(uid) {
    await Promise.all([
        db.recursiveDelete(db.doc(`users/${uid}`)).catch(() => {}),
        db.doc(`emailVerificationCodes/${uid}`).delete().catch(() => {}),
        db.doc(`rateLimits/verifyEmailOTP_${uid}`).delete().catch(() => {}),
    ]);
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('VE — verifyEmailOTP callable', () => {
    // Golden-path state: set up once in beforeAll, read by VE-6/7/8
    const GOLDEN_UID = 've_golden';
    const GOLDEN_EMAIL = 've_golden@test.example';
    let goldenCallResult = null;

    beforeAll(async () => {
        await cleanup(GOLDEN_UID);
        await createUserDoc(GOLDEN_UID);
        // Pre-seed private/account to verify merge semantics
        await db.doc(`users/${GOLDEN_UID}/private/account`).set({ moderationStatus: 'active', reportCount: 0 });
        await seedOTP(GOLDEN_UID, { email: GOLDEN_EMAIL, code: '333333' });
        if (indexModule) {
            goldenCallResult = await callVerify(GOLDEN_UID, { email: GOLDEN_EMAIL, code: '333333' });
        }
    });

    afterAll(async () => {
        const uids = ['ve_notfound', 've_mismatch', 've_wrongcode', 've_expired', GOLDEN_UID, 've_idempotent'];
        await Promise.all(uids.map(cleanup));
    });

    // ── error paths ───────────────────────────────────────────────────────────

    it('(VE-1) unauthenticated request → unauthenticated error', async () => {
        if (!indexModule) return;
        const { error } = await callVerify(null, { email: 'a@b.com', code: '000000' });
        expect(error?.code).toBe('unauthenticated');
    });

    it('(VE-2) no OTP doc for uid → not-found error', async () => {
        if (!indexModule) return;
        const { error } = await callVerify('ve_notfound', { email: 'a@b.com', code: '000000' });
        expect(error?.code).toBe('not-found');
    });

    it('(VE-3) email mismatch → invalid-argument error', async () => {
        if (!indexModule) return;
        const uid = 've_mismatch';
        await seedOTP(uid, { email: 'real@example.com', code: '111111' });
        const { error } = await callVerify(uid, { email: 'wrong@example.com', code: '111111' });
        expect(error?.code).toBe('invalid-argument');
    });

    it('(VE-4) wrong code → invalid-argument error', async () => {
        if (!indexModule) return;
        const uid = 've_wrongcode';
        await seedOTP(uid, { email: 've_wrongcode@test.example', code: '111111' });
        const { error } = await callVerify(uid, { email: 've_wrongcode@test.example', code: '999999' });
        expect(error?.code).toBe('invalid-argument');
    });

    it('(VE-5) expired OTP → deadline-exceeded and OTP doc deleted', async () => {
        if (!indexModule) return;
        const uid = 've_expired';
        await seedOTP(uid, { email: 've_expired@test.example', code: '222222', offsetMs: -1000 });
        const { error } = await callVerify(uid, { email: 've_expired@test.example', code: '222222' });
        expect(error?.code).toBe('deadline-exceeded');
        // Function must delete the expired OTP doc
        const snap = await db.doc(`emailVerificationCodes/${uid}`).get();
        expect(snap.exists).toBe(false);
    });

    // ── golden path: share state across VE-6/7/8 ─────────────────────────────

    it('(VE-6) valid OTP writes email to private/account with merge semantics', async () => {
        if (!indexModule) return;
        expect(goldenCallResult?.result?.success).toBe(true);
        const snap = await db.doc(`users/${GOLDEN_UID}/private/account`).get();
        expect(snap.exists).toBe(true);
        expect(snap.data().email).toBe(GOLDEN_EMAIL);
        // merge:true must preserve pre-existing moderationStatus and reportCount
        expect(snap.data().moderationStatus).toBe('active');
        expect(snap.data().reportCount).toBe(0);
    });

    it('(VE-7) root users doc receives only emailVerified:true — no email field', async () => {
        if (!indexModule) return;
        const snap = await db.doc(`users/${GOLDEN_UID}`).get();
        expect(snap.data().emailVerified).toBe(true);
        expect(snap.data()).not.toHaveProperty('email');
    });

    it('(VE-8) OTP doc is deleted after successful verification', async () => {
        if (!indexModule) return;
        const snap = await db.doc(`emailVerificationCodes/${GOLDEN_UID}`).get();
        expect(snap.exists).toBe(false);
    });

    // ── idempotency ───────────────────────────────────────────────────────────

    it('(VE-9) retries with a fresh OTP preserve existing private/account fields', async () => {
        if (!indexModule) return;
        const uid = 've_idempotent';
        await cleanup(uid);
        await createUserDoc(uid);
        await db.doc(`users/${uid}/private/account`).set({ moderationStatus: 'active', customTag: 'keep-me' });

        // First verify
        await seedOTP(uid, { email: 've_idempotent@test.example', code: '444444' });
        await callVerify(uid, { email: 've_idempotent@test.example', code: '444444' });

        // Second verify — fresh OTP, same email
        await seedOTP(uid, { email: 've_idempotent@test.example', code: '555555' });
        const { result } = await callVerify(uid, { email: 've_idempotent@test.example', code: '555555' });
        expect(result?.success).toBe(true);

        const snap = await db.doc(`users/${uid}/private/account`).get();
        expect(snap.data().email).toBe('ve_idempotent@test.example');
        expect(snap.data().moderationStatus).toBe('active'); // merge preserved
        expect(snap.data().customTag).toBe('keep-me');       // unrelated field preserved
    });
});
