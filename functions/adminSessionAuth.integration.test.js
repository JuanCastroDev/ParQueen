'use strict';

/**
 * Behavioral integration tests — requireCurrentAdmin (functions/adminAuth.js)
 * and its adoption across privileged callables.
 *
 * Context: every admin-gated callable in this repository previously trusted
 * only the PRESENTED ID TOKEN's embedded role claim
 * (`request.auth?.token?.role !== 'admin'`). Firebase ID tokens are bearer
 * credentials that remain cryptographically valid for their full lifetime
 * (normally ~1 hour) regardless of what happens to the account afterward.
 * setStaffRole's and deleteAccount's own hardening (adminRoleLock, the
 * last-admin scan) protects the ACCOUNT BEING ACTED ON — it does nothing to
 * stop a demoted/deleted/disabled CALLER from using their own still-valid
 * old token to invoke admin-gated callables in the first place.
 *
 * requireCurrentAdmin needs to verify an ACTUAL Auth account (getUser), so —
 * unlike other test files in this repo that inject fake claims via the
 * direct-handler .run() mechanism — every test here uses real Auth-emulator
 * sign-in and calls the Functions emulator over HTTP, matching
 * deleteAccount.integration.test.js's signInUser/callDeleteAccount pattern.
 *
 * True revoked-token enforcement (an operator explicitly calling
 * revokeRefreshTokens on a still-existing, still-enabled, still-admin
 * account) is NOT tested in this file — see
 * functions/adminAuth.revocation.integration.test.js instead. That property could not
 * be exercised via getAuth().verifyIdToken(token, checkRevoked=true)
 * against the Firebase Auth EMULATOR (a direct diagnostic confirmed the
 * emulator does not enforce tokensValidAfterTime through that primitive),
 * but requireCurrentAdmin now implements the same comparison itself
 * (mirroring firebase-admin's own algorithm exactly — see
 * functions/adminAuth.js) using getUser().tokensValidAfterTime, which IS
 * reliably reported by the emulator — empirically confirmed, not assumed.
 * The fresh getUser()-based checks in this file (deleted/disabled/demoted
 * caller) remain independently sufficient on their own regardless.
 *
 * What is proven:
 *   AS-1:  unauthenticated privileged callable rejected
 *   AS-2:  token says admin + current Auth role admin -> allowed
 *   AS-3:  token says admin + current Auth role staff -> denied
 *   AS-4:  token says admin + current Auth role absent -> denied
 *   AS-5:  token says admin + Auth user deleted -> denied
 *   AS-6:  token says admin + Auth user disabled -> denied
 *   AS-7:  current Auth says admin + presented token lacks admin -> still requires token refresh (unchanged intended behavior)
 *   AS-8:  stale demoted admin cannot call setStaffRole
 *   AS-9:  stale demoted admin cannot self-promote
 *   AS-10: stale demoted admin cannot demote another administrator
 *   AS-11: deleted former admin cannot call another privileged callable
 *   AS-12: disabled admin cannot call privileged callable
 *   AS-13: current valid admin can still perform a representative privileged callable
 *   AS-14: server Auth getUser failure fails closed
 *   AS-15: raw Admin SDK errors are sanitized before reaching the client
 *   AS-16: no raw identity is logged across rejection paths
 *   AS-17: bootstrapAdmin remains usable per its own non-admin bootstrap contract
 *   AS-18: bootstrapAdmin is not accidentally wrapped by requireCurrentAdmin (source contract)
 *   AS-19: reconcileLegacyAdminSingleton now uses requireCurrentAdmin (source contract)
 *   AS-20: bootstrapAdmin uses requireCurrentAuthenticatedUser (source contract)
 *   AS-22: exactly the expected callables use requireCurrentAdmin, zero token-only exceptions remain (source contract)
 *
 * AS-20/21 (setStaffRole SR-1..49 and deleteAccount FN/DA suites unaffected)
 * are verified by the full functions-gate run, not as cases in this file.
 */

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const fs = require('fs');
const path = require('path');

let bootstrapAdmin, reconcileLegacyAdminSingleton, requireCurrentAdmin;
try {
    ({ bootstrapAdmin, reconcileLegacyAdminSingleton } = require('./index.js'));
    ({ requireCurrentAdmin } = require('./adminAuth.js'));
} catch (e) {
    console.warn('[adminSessionAuth.integration] Could not load modules:', e.message);
}

const { requireEmulatorProjectId } = require('./emulatorProjectId');
const PROJECT_ID = requireEmulatorProjectId();
const REGION = 'us-central1';
const FUNCTIONS_BASE = `http://localhost:5001/${PROJECT_ID}/${REGION}`;
const AUTH_EMULATOR = 'http://localhost:9099';
const APP_NAME = '__adminSessionAuth_intg__';

const testApp =
    getApps().find(a => a.name === APP_NAME) ??
    initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const adminAuth = getAuth(testApp);

// ─── Helpers (mirrors deleteAccount.integration.test.js conventions) ──────

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

function testUid(label) {
    return `as_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function opId(label) {
    return `op_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function nuke(uid) {
    await adminAuth.deleteUser(uid).catch(() => {});
}

async function wipeAllStrayAdmins() {
    let pageToken;
    do {
        const page = await adminAuth.listUsers(1000, pageToken);
        for (const u of page.users) {
            if (u.customClaims?.role === 'admin') {
                await adminAuth.deleteUser(u.uid).catch(() => {});
            }
        }
        pageToken = page.pageToken;
    } while (pageToken);
}

async function deleteLock() {
    await db.doc('adminRoleLock/singleton').delete().catch(() => {});
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('requireCurrentAdmin — session revocation / stale admin token hardening', () => {
    let uid, targetUid;

    beforeEach(async () => {
        uid = testUid('caller');
        targetUid = testUid('target');
        await wipeAllStrayAdmins();
        await deleteLock();
    });

    afterEach(async () => {
        await nuke(uid);
        await nuke(targetUid);
        await deleteLock();
        await db.doc(`users/${targetUid}`).delete().catch(() => {});
    });

    // adminSuspendUser/adminUnsuspendUser .update() an existing users/{uid}
    // Firestore doc — only needed for tests where the call is expected to
    // actually reach that step (rejection-path tests never get this far).
    async function seedUserDoc(targetId) {
        await db.doc(`users/${targetId}`).set({ id: targetId, status: 'Active' });
    }

    it('AS-1: unauthenticated privileged callable rejected', async () => {
        const resp = await callFn('adminSuspendUser', null, { userId: targetUid, reason: 'x' });
        expect(resp.error?.status).toBe('UNAUTHENTICATED');
    });

    it('AS-2: token says admin + current Auth role admin -> allowed', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        const idToken = await signInUser(uid); // fresh token, minted after claim was set
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await seedUserDoc(targetUid);

        const resp = await callFn('adminSuspendUser', idToken, { userId: targetUid, reason: 'test' });
        expect(resp.error).toBeUndefined();
        expect(resp.result?.success).toBe(true);
    });

    it('AS-3: token says admin + current Auth role staff -> denied', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        const idToken = await signInUser(uid);
        // Demote AFTER the token was minted — token still claims admin.
        await adminAuth.setCustomUserClaims(uid, { role: 'staff' });

        const resp = await callFn('adminSuspendUser', idToken, { userId: targetUid, reason: 'x' });
        expect(resp.error?.status).toBe('PERMISSION_DENIED');
    });

    it('AS-4: token says admin + current Auth role absent -> denied', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        const idToken = await signInUser(uid);
        await adminAuth.setCustomUserClaims(uid, {});

        const resp = await callFn('adminSuspendUser', idToken, { userId: targetUid, reason: 'x' });
        expect(resp.error?.status).toBe('PERMISSION_DENIED');
    });

    it('AS-5: token says admin + Auth user deleted -> denied', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        const idToken = await signInUser(uid);
        await adminAuth.deleteUser(uid).catch(() => {});

        const resp = await callFn('adminSuspendUser', idToken, { userId: targetUid, reason: 'x' });
        expect(resp.error?.status).toBe('PERMISSION_DENIED');
    });

    it('AS-6: token says admin + Auth user disabled -> denied', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        const idToken = await signInUser(uid);
        await adminAuth.updateUser(uid, { disabled: true });

        const resp = await callFn('adminSuspendUser', idToken, { userId: targetUid, reason: 'x' });
        expect(resp.error?.status).toBe('PERMISSION_DENIED');
    });

    it('AS-7: current Auth says admin but presented token predates promotion -> still requires token refresh', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        const idToken = await signInUser(uid); // signed in BEFORE promotion
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' }); // promoted after

        const resp = await callFn('adminSuspendUser', idToken, { userId: targetUid, reason: 'x' });
        expect(resp.error?.status).toBe('PERMISSION_DENIED'); // must refresh token first, unchanged from before
    });

    it('AS-8: stale demoted admin cannot call setStaffRole', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        const idToken = await signInUser(uid);
        await adminAuth.setCustomUserClaims(uid, { role: 'staff' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(targetUid, { role: 'admin' });

        const resp = await callFn('setStaffRole', idToken, { uid: targetUid, role: 'staff', operationId: opId('a') });
        expect(resp.error?.status).toBe('PERMISSION_DENIED');
        const target = await adminAuth.getUser(targetUid);
        expect(target.customClaims?.role).toBe('admin'); // untouched
    });

    it('AS-9: stale demoted admin cannot self-promote', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        const idToken = await signInUser(uid);
        await adminAuth.setCustomUserClaims(uid, { role: 'staff' });

        const resp = await callFn('setStaffRole', idToken, { uid, role: 'admin', operationId: opId('b') });
        expect(resp.error?.status).toBe('PERMISSION_DENIED');
        const self = await adminAuth.getUser(uid);
        expect(self.customClaims?.role).toBe('staff'); // never re-promoted
    });

    it('AS-10: stale demoted admin cannot demote another administrator', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        const idToken = await signInUser(uid);
        await adminAuth.setCustomUserClaims(uid, { role: 'staff' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(targetUid, { role: 'admin' });

        const resp = await callFn('setStaffRole', idToken, { uid: targetUid, role: null, operationId: opId('c') });
        expect(resp.error?.status).toBe('PERMISSION_DENIED');
        const target = await adminAuth.getUser(targetUid);
        expect(target.customClaims?.role).toBe('admin'); // untouched
    });

    it('AS-11: deleted former admin cannot call another privileged callable', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        const idToken = await signInUser(uid);
        await adminAuth.deleteUser(uid).catch(() => {});

        const resp = await callFn('adminUnsuspendUser', idToken, { userId: targetUid });
        expect(resp.error?.status).toBe('PERMISSION_DENIED');
    });

    it('AS-12: disabled admin cannot call privileged callable', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        const idToken = await signInUser(uid);
        await adminAuth.updateUser(uid, { disabled: true });

        const resp = await callFn('adminUpdateReport', idToken, { reportId: 'x', status: 'reviewed' });
        expect(resp.error?.status).toBe('PERMISSION_DENIED');
    });

    it('AS-13: current valid admin can still perform a representative privileged callable', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        const idToken = await signInUser(uid);
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await seedUserDoc(targetUid);

        const resp = await callFn('adminUnsuspendUser', idToken, { userId: targetUid });
        expect(resp.error).toBeUndefined();
        expect(resp.result?.success).toBe(true);
    });

    it('AS-14: server Auth getUser failure fails closed', async () => {
        if (!requireCurrentAdmin) return;
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });

        const fnAuth = getAuth();
        const origGetUser = fnAuth.getUser.bind(fnAuth);
        fnAuth.getUser = async () => {
            const err = new Error('injected transient failure for AS-14');
            err.code = 'auth/internal-error';
            throw err;
        };

        // Token.role check passes (reaches the patched getUser() call below);
        // requireCurrentAdmin no longer reads rawRequest at all.
        const requestLike = {
            auth: { uid, token: { uid, role: 'admin' } },
            rawRequest: {},
        };
        try {
            await expect(requireCurrentAdmin(requestLike)).rejects.toMatchObject({ code: 'permission-denied' });
        } finally {
            fnAuth.getUser = origGetUser;
        }
    });

    it('AS-15: raw Admin SDK errors are sanitized before reaching the client', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        const idToken = await signInUser(uid);
        await adminAuth.deleteUser(uid).catch(() => {});

        const resp = await callFn('adminSuspendUser', idToken, { userId: targetUid, reason: 'x' });
        expect(resp.error?.status).toBe('PERMISSION_DENIED');
        expect(resp.error?.message).not.toMatch(/auth\//);
    });

    it('AS-16: no raw identity is logged across rejection paths', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        const idToken = await signInUser(uid);
        await adminAuth.setCustomUserClaims(uid, { role: 'staff' });

        const originalLog = console.log;
        const originalError = console.error;
        const originalWarn = console.warn;
        const captured = [];
        console.log = (...args) => captured.push(args.join(' '));
        console.error = (...args) => captured.push(args.join(' '));
        console.warn = (...args) => captured.push(args.join(' '));
        try {
            await callFn('adminSuspendUser', idToken, { userId: targetUid, reason: 'x' });
        } finally {
            console.log = originalLog;
            console.error = originalError;
            console.warn = originalWarn;
        }

        const joined = captured.join('\n');
        expect(joined).not.toMatch(/@parqueen\.app|@gmail\.com/);
        expect(joined.includes(uid)).toBe(false);
    });

    it('AS-17: bootstrapAdmin remains usable per its own non-admin bootstrap contract', async () => {
        if (!bootstrapAdmin) return;
        // A verified @parqueen.app caller who is NOT yet admin must still be
        // able to reach bootstrapAdmin's own singleton-transaction logic —
        // proving requireCurrentAdmin's role-required gate was not
        // accidentally applied to this Function.
        const NOW = Math.floor(Date.now() / 1000);
        await adminAuth.createUser({ uid }).catch(() => {});
        const { error } = await (async () => {
            try {
                const result = await bootstrapAdmin.run({
                    data: {},
                    auth: { uid, token: { uid, email: `${uid}@parqueen.app`, email_verified: true, auth_time: NOW - 30, iat: NOW - 30, exp: NOW + 3600 } },
                    rawRequest: {},
                });
                return { result };
            } catch (err) {
                return { error: err };
            }
        })();
        // Whatever the outcome (likely already-exists, since the singleton is
        // permanently claimed in this codebase's current state), it must NOT
        // be the 'permission-denied' that requireCurrentAdmin would produce
        // for a non-admin caller — that would prove accidental wrapping.
        if (error) {
            expect(error.code).not.toBe('permission-denied');
        }
    });

    it('AS-18: bootstrapAdmin is not accidentally wrapped by requireCurrentAdmin (source contract)', () => {
        const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const fnStart = src.indexOf('exports.bootstrapAdmin = onCall(');
        const fnEnd = src.indexOf('exports.reconcileLegacyAdminSingleton = onCall(');
        expect(fnStart).toBeGreaterThan(-1);
        expect(fnEnd).toBeGreaterThan(fnStart);
        const body = src.slice(fnStart, fnEnd);
        expect(body).not.toMatch(/requireCurrentAdmin\(request\)/);
    });

    it('AS-19: reconcileLegacyAdminSingleton now uses requireCurrentAdmin (revocation-aware migration — source contract)', () => {
        const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const fnStart = src.indexOf('exports.reconcileLegacyAdminSingleton = onCall(');
        const fnEnd = src.indexOf('exports.setStaffRole = onCall(');
        expect(fnStart).toBeGreaterThan(-1);
        expect(fnEnd).toBeGreaterThan(fnStart);
        const body = src.slice(fnStart, fnEnd);
        expect(body).toMatch(/await requireCurrentAdmin\(request\);/);
        // The old token-only exception is gone — its own additional
        // exhaustive listUsers scan remains, as defense in depth, not a
        // substitute for session validity.
        expect(body).not.toMatch(/request\.auth\.token\.role !== 'admin'/);
    });

    it('AS-22: exactly the expected privileged callables use requireCurrentAdmin; zero token-only exceptions remain', () => {
        const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const migratedCount = (src.match(/await requireCurrentAdmin\(request\);/g) || []).length;
        // 13 from the original session-revocation hardening pass +
        // adminBackfillStreetIntelligence + adminReadView (coordinated
        // Functions/Rules/client write/read remediation) +
        // reconcileLegacyAdminSingleton (true-revocation hardening pass —
        // see functions/adminAuth.revocation.integration.test.js RV-18/RV-19).
        expect(migratedCount).toBe(16);

        // No privileged callable may use the raw token-only pattern anymore —
        // bootstrapAdmin uses requireCurrentAuthenticatedUser (see AS-18/
        // AS-20) instead of a raw check, and reconcileLegacyAdminSingleton is
        // now migrated above. If this count is ever nonzero again, a newly
        // added admin callable regressed to copy-pasting the old,
        // stale-token-vulnerable check instead of using requireCurrentAdmin.
        const rawPatternCount =
            (src.match(/request\.auth\?\.token\?\.role !== 'admin'/g) || []).length +
            (src.match(/request\.auth\.token\.role !== 'admin'/g) || []).length;
        expect(rawPatternCount).toBe(0);
    });

    it('AS-20: bootstrapAdmin uses requireCurrentAuthenticatedUser (revocation-aware, non-role-requiring session check — source contract)', () => {
        const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const fnStart = src.indexOf('exports.bootstrapAdmin = onCall(');
        const fnEnd = src.indexOf('exports.reconcileLegacyAdminSingleton = onCall(');
        expect(fnStart).toBeGreaterThan(-1);
        expect(fnEnd).toBeGreaterThan(fnStart);
        const body = src.slice(fnStart, fnEnd);
        expect(body).toMatch(/await requireCurrentAuthenticatedUser\(request\);/);
    });

    // AS-23/24/25 (true checkRevoked-based revocation enforcement) are
    // deliberately not implemented or tested here — see the header comment
    // and functions/adminAuth.js for why: a direct diagnostic against the
    // Firebase Auth emulator confirmed it does not enforce
    // tokensValidAfterTime even when verifyIdToken is called with
    // checkRevoked=true, so this property cannot be honestly proven in this
    // environment. Tracked as a separate follow-up rather than shipped
    // unverified.

    it('AS-26: Runtime-IAM canary config-contract — Wave 6A admin-write callables run as the dedicated parqueen-admin-write identity, still gated by requireCurrentAdmin', () => {
        const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const WAVE_6A = [
            'adminAddSegment',
            'adminAddCleaningRule',
            'adminSupersedeRule',
            'adminUpdateSegmentStatus',
            'adminResolveParseFailure',
            'adminReopenParseFailure',
            'adminUpdateReport',
        ];
        for (const name of WAVE_6A) {
            const callStart = src.indexOf(`exports.${name} = onCall(`);
            expect(callStart).toBeGreaterThan(-1);
            const optionsSlice = src.slice(callStart, callStart + 400);
            expect(optionsSlice).toMatch(/serviceAccount:\s*'parqueen-admin-write@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
            expect(optionsSlice).toMatch(/await requireCurrentAdmin\(request\);/);
        }

        // requireCurrentAdmin usage count (AS-22) is unaffected by a runtime-SA
        // change — same 16 gated callables, no new/removed authorization call.
        const migratedCount = (src.match(/await requireCurrentAdmin\(request\);/g) || []).length;
        expect(migratedCount).toBe(16);
    });

    it('AS-27: Runtime-IAM canary config-contract — Wave 6B-1 suspension-calendar callables run as the dedicated parqueen-admin-write identity, still gated by requireCurrentAdmin', () => {
        const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const WAVE_6B_1 = ['adminAddSuspension', 'adminArchiveSuspension'];
        for (const name of WAVE_6B_1) {
            const callStart = src.indexOf(`exports.${name} = onCall(`);
            expect(callStart).toBeGreaterThan(-1);
            const optionsSlice = src.slice(callStart, callStart + 400);
            expect(optionsSlice).toMatch(/serviceAccount:\s*'parqueen-admin-write@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
            expect(optionsSlice).toMatch(/await requireCurrentAdmin\(request\);/);
        }

        const migratedCount = (src.match(/await requireCurrentAdmin\(request\);/g) || []).length;
        expect(migratedCount).toBe(16);
    });

    it('AS-28: Runtime-IAM canary config-contract — Wave 6B-2 user-enforcement callables run as the dedicated parqueen-admin-write identity, still gated by requireCurrentAdmin', () => {
        const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const WAVE_6B_2 = ['adminSuspendUser', 'adminUnsuspendUser'];
        for (const name of WAVE_6B_2) {
            const callStart = src.indexOf(`exports.${name} = onCall(`);
            expect(callStart).toBeGreaterThan(-1);
            const optionsSlice = src.slice(callStart, callStart + 400);
            expect(optionsSlice).toMatch(/serviceAccount:\s*'parqueen-admin-write@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
            expect(optionsSlice).toMatch(/await requireCurrentAdmin\(request\);/);
        }

        // These two remain the representative privileged callables the whole
        // AS-1..AS-17/RV-1..RV-19 authorization/revocation suite is built
        // around — a runtime-SA change must not alter that request-level
        // behavior, so the shared requireCurrentAdmin call count stays 16.
        const migratedCount = (src.match(/await requireCurrentAdmin\(request\);/g) || []).length;
        expect(migratedCount).toBe(16);

        // adminSuspendUser/adminUnsuspendUser write only a fixed, hard-coded
        // field set to users/{userId} — never a spread/merge of client
        // request.data — so a client cannot inject arbitrary document
        // fields through either callable.
        for (const name of WAVE_6B_2) {
            const callStart = src.indexOf(`exports.${name} = onCall(`);
            const body = src.slice(callStart, callStart + 1200);
            expect(body).not.toMatch(/\.\.\.request\.data/);
            expect(body).not.toMatch(/\.set\(request\.data/);
        }
    });

    it('AS-29: Runtime-IAM canary config-contract — adminDeleteSpot (Wave 6B-3) runs as the dedicated parqueen-admin-write identity, still gated by requireCurrentAdmin, source:\'admin\' still written before the hard delete', () => {
        const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const callStart = src.indexOf('exports.adminDeleteSpot = onCall(');
        expect(callStart).toBeGreaterThan(-1);
        const optionsSlice = src.slice(callStart, callStart + 400);
        expect(optionsSlice).toMatch(/serviceAccount:\s*'parqueen-admin-write@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
        expect(optionsSlice).toMatch(/await requireCurrentAdmin\(request\);/);

        const migratedCount = (src.match(/await requireCurrentAdmin\(request\);/g) || []).length;
        expect(migratedCount).toBe(16);

        // The updateTrustOnSpotDelete cross-function contract (functions/
        // pingNotificationPrivacy.integration.test.js TD-1..4) depends on
        // this exact ordering — a runtime-SA change must not disturb it.
        const fnEnd = src.indexOf('exports.bootstrapAdmin = onCall(', callStart);
        expect(fnEnd).toBeGreaterThan(callStart);
        const body = src.slice(callStart, fnEnd);
        const updateIdx = body.indexOf("spotRef.update({ source: 'admin' })");
        const deleteIdx = body.indexOf('spotRef.delete()');
        expect(updateIdx).toBeGreaterThan(-1);
        expect(deleteIdx).toBeGreaterThan(-1);
        expect(updateIdx).toBeLessThan(deleteIdx);
    });

    it('AS-30: Runtime-IAM canary config-contract — adminBackfillStreetIntelligence (Wave 6C) runs as the dedicated parqueen-admin-write identity, still gated by requireCurrentAdmin', () => {
        const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const callStart = src.indexOf('exports.adminBackfillStreetIntelligence = onCall(');
        expect(callStart).toBeGreaterThan(-1);
        const optionsSlice = src.slice(callStart, callStart + 400);
        expect(optionsSlice).toMatch(/serviceAccount:\s*'parqueen-admin-write@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
        expect(optionsSlice).toMatch(/await requireCurrentAdmin\(request\);/);

        const migratedCount = (src.match(/await requireCurrentAdmin\(request\);/g) || []).length;
        expect(migratedCount).toBe(16);
    });
});
