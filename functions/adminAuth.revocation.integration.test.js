'use strict';

/**
 * True revoked-token enforcement for current admins — the residual left
 * open by fix-admin-session-revocation-hardening (see that branch's
 * functions/adminAuth.js header, since superseded here).
 *
 * Scenario: current Auth account still exists, still enabled, current
 * customClaims.role is still 'admin' — but a security operator calls
 * getAuth().revokeRefreshTokens(uid), and the caller presents an
 * already-issued, still-cryptographically-valid ID token minted BEFORE that
 * revocation. requireCurrentAdmin previously validated current role/exists/
 * disabled state but not this — an already-issued token could keep working
 * until its natural ~1h expiry regardless of the revocation call.
 *
 * Algorithm source of truth (installed firebase-admin 12.7.0, confirmed by
 * direct source read, not memory):
 *   node_modules/firebase-admin/lib/auth/base-auth.js,
 *   BaseAuth.verifyDecodedJWTNotRevokedOrDisabled — compares
 *   `decodedIdToken.auth_time * 1000` (NOT iat — auth_time reflects the
 *   original sign-in and stays constant across token refreshes tied to that
 *   session) against `new Date(user.tokensValidAfterTime).getTime()`;
 *   revoked iff strictly less-than (equal is valid). The callable
 *   framework's own auth population (installed firebase-functions 5.1.1,
 *   firebase-functions/lib/common/providers/https.js, checkAuthToken) calls
 *   verifyIdToken(idToken) with no checkRevoked argument (defaults false) —
 *   confirmed by direct source read — so this is genuinely unenforced
 *   automatically and needed its own implementation.
 *
 * isTokenRevokedForUser (functions/adminAuth.js) implements this exact
 * comparison directly against request.auth.token.auth_time (already
 * present — no raw bearer token re-parsing needed) and a fresh
 * getUser(uid).tokensValidAfterTime.
 *
 * IMPORTANT — what the handler-level tests below do and do NOT prove: the
 * Firebase Auth EMULATOR's own verifyIdToken(token, checkRevoked=true)
 * enforcement was directly diagnosed (via a standalone script, since
 * deleted) and confirmed NOT to enforce tokensValidAfterTime — so this
 * suite does not use or rely on that primitive at all, and does not claim
 * the emulator proves production checkRevoked semantics. What IS
 * empirically verified (see PR description) is that getUser() correctly
 * reports tokensValidAfterTime after a real revokeRefreshTokens() call in
 * the emulator — a plain data-storage/retrieval behavior, not a
 * verification-enforcement one. The handler tests below combine that
 * genuine emulator behavior with a manually-controlled auth_time on a
 * direct-handler (.run()) request — exactly the same fake-request
 * convention already used throughout this repo's admin test suites — to
 * exercise OUR OWN requireCurrentAdmin comparison end to end, independent
 * of the broken emulator primitive.
 *
 * What is proven:
 *   Pure, deterministic isTokenRevokedForUser fixture tests (no emulator
 *   Auth calls at all):
 *     RV-2:  auth_time strictly before validSince -> revoked
 *     RV-3:  auth_time exactly equal to validSince -> valid (SDK's strict less-than)
 *     RV-4:  auth_time after validSince -> valid
 *     RV-5:  malformed/missing auth_time fails closed
 *     RV-6:  tokensValidAfterTime absent -> never revoked (legitimate SDK default);
 *            present-but-unparseable fails closed (defensive; structurally
 *            unreachable via the real UserRecord getter)
 *     RV-15: realistic large epoch-second auth_time converts to ms correctly
 *
 *   Handler-level enforcement tests (real revokeRefreshTokens() + controlled auth_time):
 *     RV-1:  current admin + non-revoked token allowed
 *     RV-2b: current admin + token predating validSince denied (permission-denied)
 *     RV-4b: current admin + token after validSince allowed
 *     RV-7:  disabled admin still denied (regression check, unchanged behavior)
 *     RV-8:  deleted admin still denied (regression check, unchanged behavior)
 *     RV-9:  demoted admin still denied (regression check, unchanged behavior)
 *     RV-10: revoked stale admin cannot call setStaffRole
 *     RV-11: revoked stale admin cannot call adminReadView
 *     RV-12: revoked stale admin cannot call adminBackfillStreetIntelligence
 *     RV-13: revoked stale admin cannot invoke a representative admin mutation (adminUnsuspendUser)
 *     RV-14: reauthenticated current admin after revocation allowed (new token, auth_time after revocation)
 *     RV-16: no sensitive timestamp/Auth data in the client-facing error
 *     RV-18: revoked current admin denied by reconcileLegacyAdminSingleton
 *     RV-19: valid (non-revoked) current admin still satisfies reconciliation's own additional checks
 *
 *   Source contract:
 *     RV-17: every requireCurrentAdmin call site is reachable only through
 *            the shared helper — a privileged callable cannot bypass it by
 *            re-implementing its own current-role check inline (verifies
 *            no duplicate/parallel authorization pattern exists — see
 *            adminSessionAuth.integration.test.js AS-22 for the exact
 *            requireCurrentAdmin usage count / zero-raw-pattern contract).
 */

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const fs = require('fs');
const path = require('path');

const { isTokenRevokedForUser } = require('./adminAuth.js');

let setStaffRole, adminReadView, adminBackfillStreetIntelligence, adminUnsuspendUser, reconcileLegacyAdminSingleton;
try {
    ({ setStaffRole, adminReadView, adminBackfillStreetIntelligence, adminUnsuspendUser, reconcileLegacyAdminSingleton } = require('./index.js'));
} catch (e) {
    console.warn('[adminAuth.revocation] Could not load index.js:', e.message);
}

const { requireEmulatorProjectId } = require('./emulatorProjectId');
const PROJECT_ID = requireEmulatorProjectId();
const APP_NAME = '__adminAuthRevocation_intg__';

const testApp =
    getApps().find(a => a.name === APP_NAME) ??
    initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const adminAuth = getAuth(testApp);

function testUid(label) {
    return `rv_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

async function nuke(uid) {
    await adminAuth.deleteUser(uid).catch(() => {});
}

function nowSec() {
    return Math.floor(Date.now() / 1000);
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

// Direct-handler request with a controlled auth_time — matches the fake-
// request convention already used by bootstrapAdmin.integration.test.js and
// reconcileLegacyAdminSingleton.integration.test.js.
function fakeAdminRequest(uid, authTimeSec, data = {}) {
    return {
        data,
        auth: {
            uid,
            token: { uid, role: 'admin', auth_time: authTimeSec, iat: authTimeSec, exp: nowSec() + 3600 },
        },
        rawRequest: {},
    };
}

async function seedUserDoc(targetId) {
    await db.doc(`users/${targetId}`).set({ id: targetId, status: 'Active' });
}

// ─── Pure, deterministic isTokenRevokedForUser fixture tests ──────────────

describe('isTokenRevokedForUser — deterministic SDK-mirrored boundary tests (no emulator Auth calls)', () => {
    it('RV-2: auth_time strictly before validSince -> revoked', () => {
        const decodedToken = { auth_time: 1700000000 };
        const userRecord = { tokensValidAfterTime: new Date((1700000000 + 1) * 1000).toUTCString() };
        expect(isTokenRevokedForUser(decodedToken, userRecord)).toBe(true);
    });

    it('RV-3: auth_time exactly equal to validSince -> valid (SDK strictly-less-than semantics)', () => {
        const boundarySec = 1700000000;
        const decodedToken = { auth_time: boundarySec };
        const userRecord = { tokensValidAfterTime: new Date(boundarySec * 1000).toUTCString() };
        expect(isTokenRevokedForUser(decodedToken, userRecord)).toBe(false);
    });

    it('RV-4: auth_time after validSince -> valid', () => {
        const decodedToken = { auth_time: 1700000001 };
        const userRecord = { tokensValidAfterTime: new Date(1700000000 * 1000).toUTCString() };
        expect(isTokenRevokedForUser(decodedToken, userRecord)).toBe(false);
    });

    it('RV-5: malformed/missing auth_time fails closed (revoked)', () => {
        const userRecord = { tokensValidAfterTime: new Date().toUTCString() };
        expect(isTokenRevokedForUser({}, userRecord)).toBe(true);
        expect(isTokenRevokedForUser({ auth_time: 'not-a-number' }, userRecord)).toBe(true);
        expect(isTokenRevokedForUser({ auth_time: NaN }, userRecord)).toBe(true);
        expect(isTokenRevokedForUser(null, userRecord)).toBe(true);
        expect(isTokenRevokedForUser(undefined, userRecord)).toBe(true);
    });

    it('RV-6a: tokensValidAfterTime absent -> never revoked (legitimate SDK default representation)', () => {
        expect(isTokenRevokedForUser({ auth_time: 1000 }, {})).toBe(false);
        expect(isTokenRevokedForUser({ auth_time: 1000 }, { tokensValidAfterTime: undefined })).toBe(false);
        expect(isTokenRevokedForUser({ auth_time: 1000 }, { tokensValidAfterTime: null })).toBe(false);
    });

    it('RV-6b: tokensValidAfterTime present but unparseable fails closed (defensive — structurally unreachable via the real UserRecord getter, see firebase-admin/lib/auth/user-record.js parseDate)', () => {
        expect(isTokenRevokedForUser({ auth_time: 1000 }, { tokensValidAfterTime: 'not-a-date' })).toBe(true);
    });

    it('RV-15: realistic large epoch-second auth_time converts to milliseconds correctly (auth_time * 1000, not misscaled)', () => {
        const authTimeSec = 1786200000; // realistic ~2026-era epoch seconds
        const justBefore = { tokensValidAfterTime: new Date(authTimeSec * 1000 + 1000).toUTCString() }; // 1s later -> revoked
        const justAfter = { tokensValidAfterTime: new Date(authTimeSec * 1000 - 1000).toUTCString() }; // 1s earlier -> valid
        expect(isTokenRevokedForUser({ auth_time: authTimeSec }, justBefore)).toBe(true);
        expect(isTokenRevokedForUser({ auth_time: authTimeSec }, justAfter)).toBe(false);
    });
});

// ─── Handler-level enforcement tests ───────────────────────────────────────

describe('requireCurrentAdmin — true revoked-token enforcement (handler-level)', () => {
    let uid, targetUid;

    // adminBootstrap/singleton is shared, serial-run-wide state (maxWorkers: 1
    // means all test files run against the same emulator data). RV-18/RV-19
    // exercise reconcileLegacyAdminSingleton, which is gated on this doc's
    // exact shape — a stray singleton left by another file's tests (or a
    // different execution order) would make RV-18's "doesn't exist" assertion
    // and RV-19's own reconciliation both fail nondeterministically. Clearing
    // it here matches the established convention in
    // reconcileLegacyAdminSingleton.integration.test.js's beforeEach/afterEach.
    async function deleteSingleton() {
        await db.doc('adminBootstrap/singleton').delete().catch(() => {});
    }

    beforeEach(async () => {
        uid = testUid('caller');
        targetUid = testUid('target');
        await deleteSingleton();
    });

    afterEach(async () => {
        await nuke(uid);
        await nuke(targetUid);
        await db.doc(`users/${targetUid}`).delete().catch(() => {});
        await deleteSingleton();
        await db.doc(`adminAuditLog/legacyReconciliation_${uid}`).delete().catch(() => {});
    });

    it('RV-1: current admin + non-revoked token allowed', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await seedUserDoc(targetUid);

        const req = fakeAdminRequest(uid, nowSec() - 10, { userId: targetUid });
        const result = await adminUnsuspendUser.run(req);
        expect(result.success).toBe(true);
    });

    it('RV-2b: current admin + token predating validSince denied (permission-denied), request never reaches the handler', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        // Deliberately do NOT seed the target user doc — if the handler body
        // were reached, adminUnsuspendUser's own .update() on a missing doc
        // would throw a DIFFERENT (internal) error, not permission-denied.
        // Getting exactly permission-denied here is itself proof the
        // handler body was never entered.
        const beforeRevoke = nowSec();
        await sleep(1100);
        await adminAuth.revokeRefreshTokens(uid);

        const req = fakeAdminRequest(uid, beforeRevoke, { userId: targetUid });
        await expect(adminUnsuspendUser.run(req)).rejects.toMatchObject({ code: 'permission-denied' });
    });

    it('RV-4b: current admin + token minted after validSince allowed', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        await adminAuth.revokeRefreshTokens(uid);
        await sleep(1100);
        const afterRevoke = nowSec();
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await seedUserDoc(targetUid);

        const req = fakeAdminRequest(uid, afterRevoke, { userId: targetUid });
        const result = await adminUnsuspendUser.run(req);
        expect(result.success).toBe(true);
    });

    it('RV-14: reauthenticated current admin after revocation allowed (does not permanently lock out the administrator)', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        const staleAuthTime = nowSec();
        await sleep(1100);
        await adminAuth.revokeRefreshTokens(uid);

        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await seedUserDoc(targetUid);

        // Old token still denied...
        await expect(adminUnsuspendUser.run(fakeAdminRequest(uid, staleAuthTime, { userId: targetUid })))
            .rejects.toMatchObject({ code: 'permission-denied' });

        // ...but a fresh reauthentication (new auth_time after the revocation
        // boundary) is allowed — revocation must not be a permanent lockout.
        await sleep(1100);
        const freshAuthTime = nowSec();
        const result = await adminUnsuspendUser.run(fakeAdminRequest(uid, freshAuthTime, { userId: targetUid }));
        expect(result.success).toBe(true);
    });

    it('RV-7: disabled admin still denied (unchanged regression check)', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        await adminAuth.updateUser(uid, { disabled: true });

        const req = fakeAdminRequest(uid, nowSec() - 10, { userId: targetUid });
        await expect(adminUnsuspendUser.run(req)).rejects.toMatchObject({ code: 'permission-denied' });
    });

    it('RV-8: deleted admin still denied (unchanged regression check)', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        await adminAuth.deleteUser(uid).catch(() => {});

        const req = fakeAdminRequest(uid, nowSec() - 10, { userId: targetUid });
        await expect(adminUnsuspendUser.run(req)).rejects.toMatchObject({ code: 'permission-denied' });
    });

    it('RV-9: demoted admin still denied (unchanged regression check)', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'staff' });

        const req = fakeAdminRequest(uid, nowSec() - 10, { userId: targetUid });
        await expect(adminUnsuspendUser.run(req)).rejects.toMatchObject({ code: 'permission-denied' });
    });

    it('RV-10: revoked stale admin cannot call setStaffRole', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        const staleAuthTime = nowSec();
        await sleep(1100);
        await adminAuth.revokeRefreshTokens(uid);
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(targetUid, { role: 'admin' });

        const req = fakeAdminRequest(uid, staleAuthTime, { uid: targetUid, role: 'staff', operationId: `op_${testUid('x')}` });
        await expect(setStaffRole.run(req)).rejects.toMatchObject({ code: 'permission-denied' });

        const target = await adminAuth.getUser(targetUid);
        expect(target.customClaims?.role).toBe('admin'); // untouched
    });

    it('RV-11: revoked stale admin cannot call adminReadView', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        const staleAuthTime = nowSec();
        await sleep(1100);
        await adminAuth.revokeRefreshTokens(uid);

        const req = fakeAdminRequest(uid, staleAuthTime, { view: 'dashboardCounts', params: {} });
        await expect(adminReadView.run(req)).rejects.toMatchObject({ code: 'permission-denied' });
    });

    it('RV-12: revoked stale admin cannot call adminBackfillStreetIntelligence', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        const staleAuthTime = nowSec();
        await sleep(1100);
        await adminAuth.revokeRefreshTokens(uid);

        const req = fakeAdminRequest(uid, staleAuthTime, { dryRun: true });
        await expect(adminBackfillStreetIntelligence.run(req)).rejects.toMatchObject({ code: 'permission-denied' });
    });

    it('RV-13: revoked stale admin cannot invoke a representative admin mutation (adminUnsuspendUser)', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        const staleAuthTime = nowSec();
        await sleep(1100);
        await adminAuth.revokeRefreshTokens(uid);
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await seedUserDoc(targetUid);

        const req = fakeAdminRequest(uid, staleAuthTime, { userId: targetUid });
        await expect(adminUnsuspendUser.run(req)).rejects.toMatchObject({ code: 'permission-denied' });
    });

    it('RV-16: no sensitive timestamp/Auth data appears in the client-facing error', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        const staleAuthTime = nowSec();
        await sleep(1100);
        await adminAuth.revokeRefreshTokens(uid);

        let caught;
        try {
            await adminUnsuspendUser.run(fakeAdminRequest(uid, staleAuthTime, { userId: targetUid }));
        } catch (err) {
            caught = err;
        }
        expect(caught).toBeDefined();
        expect(caught.code).toBe('permission-denied');
        expect(caught.message).not.toMatch(/tokensValidAfterTime|auth_time|validSince/i);
        expect(caught.message).not.toContain(uid);
        expect(caught.message).not.toContain(String(staleAuthTime));
    });

    it('RV-18: revoked current admin denied by reconcileLegacyAdminSingleton', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        const staleAuthTime = nowSec();
        await sleep(1100);
        await adminAuth.revokeRefreshTokens(uid);

        const req = fakeAdminRequest(uid, staleAuthTime, {});
        await expect(reconcileLegacyAdminSingleton.run(req)).rejects.toMatchObject({ code: 'permission-denied' });

        const singleton = await db.doc('adminBootstrap/singleton').get();
        expect(singleton.exists).toBe(false);
    });

    it('RV-19: valid (non-revoked) current admin still satisfies reconciliation\'s own additional checks', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });

        const req = fakeAdminRequest(uid, nowSec() - 10, {});
        const result = await reconcileLegacyAdminSingleton.run(req);
        expect(result.success).toBe(true);

        const singleton = await db.doc('adminBootstrap/singleton').get();
        expect(singleton.exists).toBe(true);
        expect(singleton.data().bootstrappedBy).toBe(uid);

        await db.doc('adminBootstrap/singleton').delete().catch(() => {});
        await db.doc(`adminAuditLog/legacyReconciliation_${uid}`).delete().catch(() => {});
    });
});

// ─── Source contract ────────────────────────────────────────────────────

describe('RV-17: source-contract — no privileged callable re-implements its own current-role check outside requireCurrentAdmin', () => {
    it('every requireCurrentAdmin call site is the shared helper, not a duplicated inline check', () => {
        const authSrc = fs.readFileSync(path.join(__dirname, 'adminAuth.js'), 'utf8');
        // The revocation comparison must live in exactly one place.
        const occurrences = (authSrc.match(/function isTokenRevokedForUser/g) || []).length;
        expect(occurrences).toBe(1);
        // requireCurrentAdmin must call it (directly or via requireCurrentAuthenticatedUser).
        expect(authSrc).toMatch(/requireCurrentAdmin[\s\S]*requireCurrentAuthenticatedUser/);
        expect(authSrc).toMatch(/isTokenRevokedForUser\(/);

        const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        // No callable may inline its own tokensValidAfterTime comparison —
        // that logic must only ever be reached through requireCurrentAdmin/
        // requireCurrentAuthenticatedUser in adminAuth.js. (auth_time alone
        // is not checked here: deleteAccount has its own, unrelated,
        // pre-existing recent-sign-in freshness check using that same JWT
        // claim for a completely different purpose — a legitimate use this
        // contract must not forbid. tokensValidAfterTime is a precise,
        // exclusive signal for "someone inlined the revocation comparison".)
        expect(indexSrc).not.toMatch(/tokensValidAfterTime/);
    });
});
