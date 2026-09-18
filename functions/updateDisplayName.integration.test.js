'use strict';

/**
 * Behavioral integration tests — updateDisplayName callable (authoritative
 * display-name write path; closes the direct-Firestore-write moderation
 * bypass for users/{uid}.fullName documented in the profile-identity audit).
 *
 * updateDisplayName has enforceAppCheck:true, and the Firebase Local
 * Emulator Suite has no App Check emulator, so every test except the one
 * HTTP-boundary test (PI-44b) invokes the exported `_updateDisplayNameHandler`
 * test seam directly (bypassing the App Check transport gate) — same
 * pattern as adminReadView (Stage 4A) and sendMessage.
 *
 * Run via: npm run test:functions
 * Requires emulators: functions (5001), firestore (8080), auth (9099)
 */

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const fs = require('fs');
const path = require('path');

const { requireEmulatorProjectId } = require('./emulatorProjectId');
const PROJECT_ID = requireEmulatorProjectId();
const REGION = 'us-central1';
const FUNCTIONS_BASE = `http://localhost:5001/${PROJECT_ID}/${REGION}`;
const AUTH_EMULATOR = 'http://localhost:9099';
const APP_NAME = '__updateDisplayName_intg__';

const testApp =
    getApps().find(a => a.name === APP_NAME) ??
    initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const adminAuth = getAuth(testApp);

let indexModule;
try {
    indexModule = require('./index.js');
} catch (e) {
    console.warn('[updateDisplayName.integration] Could not load index.js:', e.message);
}

// ─── Helpers ────────────────────────────────────────────────────────────

function testUid(label) {
    return `pn_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

/** Fabricates a CallableRequest — updateDisplayName never calls getAuth(),
 * so no real Auth emulator round-trip is needed here. */
function fakeRequest(uid, data = {}) {
    const NOW = Math.floor(Date.now() / 1000);
    return {
        data,
        auth: uid ? { uid, token: { uid, auth_time: NOW - 30, iat: NOW - 30, exp: NOW + 3600 } } : null,
        rawRequest: {},
    };
}

async function callDirect(uid, data) {
    if (!indexModule) return { error: { code: 'unavailable' } };
    try {
        return { result: await indexModule._updateDisplayNameHandler(fakeRequest(uid, data)) };
    } catch (err) {
        return { error: { code: err.code, message: err.message } };
    }
}

async function deleteRateLimitCounter(uid) {
    const wk = Math.floor(Date.now() / (3600 * 1000));
    await db.collection('rateLimits').doc(`updateDisplayName_${wk}_${uid}`).delete().catch(() => {});
}

async function seedRateLimitCounter(uid, count) {
    const wk = Math.floor(Date.now() / (3600 * 1000));
    const docId = `updateDisplayName_${wk}_${uid}`;
    await db.collection('rateLimits').doc(docId).set({
        count, uid, operation: 'updateDisplayName',
        expiresAt: Timestamp.fromMillis(Date.now() + 7200 * 1000),
    });
    return docId;
}

async function signInUser(uid) {
    try { await adminAuth.createUser({ uid }); } catch { /* already exists */ }
    const customToken = await adminAuth.createCustomToken(uid);
    const res = await fetch(
        `${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-key`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: customToken, returnSecureToken: true }),
        },
    );
    const body = await res.json();
    if (!body.idToken) throw new Error(`signInUser failed for ${uid}: ${JSON.stringify(body)}`);
    return body.idToken;
}

async function callFn(name, idToken, data = {}) {
    const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
        },
        body: JSON.stringify({ data }),
    });
    return res.json();
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('updateDisplayName — authoritative display-name write path', () => {
    let uid;

    beforeEach(async () => {
        uid = testUid('a');
        await db.collection('users').doc(uid).set({ id: uid, username: `u_${Date.now()}`, crowns: 0, title: 'Newcomer' });
    });

    afterEach(async () => {
        await db.collection('users').doc(uid).delete().catch(() => {});
        await deleteRateLimitCounter(uid);
    });

    it('PI-30: unauthenticated request is denied with unauthenticated', async () => {
        const { error } = await callDirect(null, { fullName: 'Jay' });
        expect(error.code).toBe('unauthenticated');
    });

    it('PI-31: malformed request (non-string fullName) is rejected with invalid-argument', async () => {
        const { error } = await callDirect(uid, { fullName: 12345 });
        expect(error.code).toBe('invalid-argument');
    });

    it('PI-32: unexpected fields cannot alter the stored schema', async () => {
        const { error } = await callDirect(uid, { fullName: 'Jay Castro', username: 'hijacked', crowns: 999 });
        expect(error).toBeUndefined();
        const doc = await db.collection('users').doc(uid).get();
        expect(doc.data().fullName).toBe('Jay Castro');
        expect(doc.data().username).not.toBe('hijacked');
        expect(doc.data().crowns).toBe(0);
    });

    it('PI-33: empty/whitespace-only name is rejected with invalid-argument', async () => {
        const { error } = await callDirect(uid, { fullName: '   ' });
        expect(error.code).toBe('invalid-argument');
    });

    it('PI-35: an over-100-character name is rejected with invalid-argument', async () => {
        const { error } = await callDirect(uid, { fullName: 'a'.repeat(101) });
        expect(error.code).toBe('invalid-argument');
    });

    it('PI-35b: exactly 100 characters is allowed, 101 is not (boundary)', async () => {
        const { error } = await callDirect(uid, { fullName: 'a'.repeat(100) });
        expect(error).toBeUndefined();
    });

    it('PI-36: banned-word content is rejected server-side with invalid-argument', async () => {
        const { error } = await callDirect(uid, { fullName: 'this is shit' });
        expect(error.code).toBe('invalid-argument');
    });

    it('PI-37: an impersonating name (reserved term) is rejected server-side, mirroring moderateDisplayName()\'s existing policy', async () => {
        const { error } = await callDirect(uid, { fullName: 'ParQueen Official Support' });
        expect(error.code).toBe('invalid-argument');
    });

    it('PI-38: a valid display name is accepted and written', async () => {
        const { result, error } = await callDirect(uid, { fullName: 'Jay Castro' });
        expect(error).toBeUndefined();
        expect(result.success).toBe(true);
        const doc = await db.collection('users').doc(uid).get();
        expect(doc.data().fullName).toBe('Jay Castro');
    });

    it('PI-39/40: sender identity comes from auth — a caller cannot write another user\'s fullName', async () => {
        const other = testUid('other');
        await db.collection('users').doc(other).set({ id: other, username: `u_${Date.now()}_b`, crowns: 0, title: 'Newcomer' });
        const { error } = await callDirect(uid, { fullName: 'Attacker Name' });
        expect(error).toBeUndefined();
        const otherDoc = await db.collection('users').doc(other).get();
        expect(otherDoc.data().fullName).toBeUndefined(); // uid's call never touched `other`'s doc
        await db.collection('users').doc(other).delete();
    });

    it('PI-41: the server writes only the fullName field — no other field is touched', async () => {
        await callDirect(uid, { fullName: 'Jay Castro' });
        const doc = await db.collection('users').doc(uid).get();
        const data = doc.data();
        expect(data.crowns).toBe(0);
        expect(data.title).toBe('Newcomer');
        expect(Object.keys(data).sort()).toEqual(['crowns', 'fullName', 'id', 'title', 'username']);
    });

    it('PI-42: the rate limit is enforced (5/hour) before the write', async () => {
        await seedRateLimitCounter(uid, 5);
        const { error } = await callDirect(uid, { fullName: 'Jay Castro' });
        expect(error.code).toBe('resource-exhausted');
    });

    it('PI-45: a rejected (banned-content) request performs no profile mutation', async () => {
        const before = (await db.collection('users').doc(uid).get()).data();
        const { error } = await callDirect(uid, { fullName: 'this is shit' });
        expect(error.code).toBe('invalid-argument');
        const after = (await db.collection('users').doc(uid).get()).data();
        expect(after).toEqual(before);
    });

    it("PI-43: Runtime-IAM canary config-contract — updateDisplayName's serviceAccount is the dedicated parqueen-user identity; test seam is nondeployable", () => {
        const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const callStart = indexSrc.indexOf('exports.updateDisplayName = onCall(');
        expect(callStart).toBeGreaterThan(-1);
        const optionsSlice = indexSrc.slice(callStart, callStart + 400);
        expect(optionsSlice).toMatch(/serviceAccount:\s*'parqueen-user@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
        expect(indexSrc).toMatch(/exports\._updateDisplayNameHandler\s*=\s*updateDisplayNameHandler;/);
    });

    it("PI-44a: App Check contract — enforceAppCheck:true is present in updateDisplayName's own options slice", () => {
        const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const callStart = indexSrc.indexOf('exports.updateDisplayName = onCall(');
        expect(callStart).toBeGreaterThan(-1);
        const optionsSlice = indexSrc.slice(callStart, callStart + 400);
        expect(optionsSlice).toMatch(/enforceAppCheck:\s*true/);
        expect(optionsSlice).not.toMatch(/consumeAppCheckToken/);
    });

    it('PI-44b: App Check canary HTTP boundary — a valid auth token but no App Check token is rejected before the handler runs', async () => {
        const idToken = await signInUser(uid);
        const resp = await callFn('updateDisplayName', idToken, { fullName: 'Jay Castro' });
        expect(resp.error?.status).toBe('UNAUTHENTICATED');
        expect(resp.result).toBeUndefined();
        const doc = await db.collection('users').doc(uid).get();
        expect(doc.data().fullName).toBeUndefined(); // confirms the rejection stopped before any write
        await adminAuth.deleteUser(uid).catch(() => {});
    });
});
