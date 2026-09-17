'use strict';

/**
 * Behavioral integration tests — adminReadView (functions/index.js, view
 * logic in functions/adminReadViews.js).
 *
 * Context: the Admin Dashboard used to read users, reports, adminAuditLog,
 * parkingSessions, parseFailures, and spots (admin-only branch) directly
 * against the client Firestore SDK, authorized solely by firestore.rules'
 * token-only isAdmin() check. Rules cannot re-verify current server-side
 * Auth state, so a demoted/deleted/disabled admin's stale token could keep
 * reading that data until the token naturally expired — the same
 * vulnerability class requireCurrentAdmin closes for callables, applied here
 * to reads instead of writes. firestore.rules now denies all of these
 * direct client reads; adminReadView is the only way to read them.
 *
 * What is proven:
 *   AR-1:  unauthenticated rejected
 *   AR-2:  current admin allowed
 *   AR-3:  stale demoted admin denied
 *   AR-4:  deleted former admin denied
 *   AR-5:  disabled admin denied
 *   AR-6:  stale token predating a later promotion still requires refresh (unchanged intended behavior)
 *   AR-7:  usersList returns only intended fields (data minimization)
 *   AR-8:  userDetail returns only the bundled fields the modal displays, nothing else
 *   AR-9:  reportsList status filter honored + userMap minimized to fullName/username/email
 *   AR-10: auditLogList merges standard+legacy entries, deduplicated
 *   AR-11: userDetail's session is scoped to exactly the requested uid
 *   AR-12: malformed pagination params rejected
 *   AR-13: maximum page size enforced
 *   AR-14: unknown/arbitrary view name rejected — no generic collection proxy
 *   AR-15: arbitrary extra params are silently ignored, never alter the query
 *   AR-16: a garbage/foreign cursor cannot escape the intended collection scope
 *   AR-17: client-requested field lists have no effect — server always returns its fixed minimized shape
 *   AR-18: source-contract — adminReadView is present, requireCurrentAdmin-gated, and the view enum matches
 *   AR-25: App Check canary (Stage 4A) config-contract — adminReadView, sendMessage, updateDisplayName, and deleteChat are the ONLY callables with enforceAppCheck:true (claimUsername deliberately excluded — see docs/PROFILE_IDENTITY_HARDENING.md); consumeAppCheckToken is unused
 *   AR-26: App Check canary — HTTP-level: a request with a valid admin ID token but no App Check token is rejected before the handler runs (proves Layer 1; missing App Check is testable against the emulator without reaching a real attestation provider — INVALID-token verification is not, since that requires the real App Check backend)
 *   AR-27: Runtime-IAM canary config-contract — adminReadView's onCall options declare serviceAccount: parqueen-admin-read@..., and enforceAppCheck/consumeAppCheckToken remain exactly as AR-25 requires alongside it
 *   AR-29: Runtime-IAM canary config-contract — moderateAvatarUpload's onObjectFinalized options declare serviceAccount: parqueen-avatar-moderator@..., with region/memory/retry unaffected and AR-25's fleet-wide App Check invariants unchanged
 *   AR-30: Runtime-IAM canary config-contract — cleanAvatarOrphans's onSchedule options declare serviceAccount: parqueen-avatar@..., with region/schedule/memory unaffected and AR-25's fleet-wide App Check invariants unchanged
 *   AR-31: Runtime-IAM canary config-contract — deleteAccount's onCall options declare serviceAccount: parqueen-account@..., with no enforceAppCheck/consumeAppCheckToken side effect and AR-25's fleet-wide App Check invariants unchanged
 *   AR-32: Runtime-IAM canary config-contract — bootstrapAdmin's onCall options declare serviceAccount: parqueen-admin-auth@..., with no enforceAppCheck/consumeAppCheckToken side effect and AR-25's fleet-wide App Check invariants unchanged
 *   AR-33: Runtime-IAM canary config-contract — reconcileLegacyAdminSingleton's onCall options declare serviceAccount: parqueen-admin-auth@..., with no enforceAppCheck/consumeAppCheckToken side effect and AR-25's fleet-wide App Check invariants unchanged
 *   AR-34: Runtime-IAM canary config-contract — setStaffRole's onCall options declare serviceAccount: parqueen-admin-auth@..., with no enforceAppCheck/consumeAppCheckToken side effect and AR-25's fleet-wide App Check invariants unchanged
 *   AR-35: Runtime-IAM canary config-contract — analyzeSign's onCall options declare serviceAccount: parqueen-ai@..., with secrets/enforceAppCheck:false unaffected and AR-25's fleet-wide App Check invariants unchanged
 *   AR-36: Runtime-IAM canary config-contract — generateSmartReplies's onCall options declare serviceAccount: parqueen-ai@..., with secrets/enforceAppCheck:false unaffected and AR-25's fleet-wide App Check invariants unchanged
 *   AR-37: Runtime-IAM canary config-contract — generateListingDescription's onCall options declare serviceAccount: parqueen-ai@..., with secrets/enforceAppCheck:false unaffected and AR-25's fleet-wide App Check invariants unchanged
 *   AR-38: Runtime-IAM canary config-contract — generateEmailOTP's onCall options declare serviceAccount: parqueen-email@..., with both secrets (SendGrid + pepper) unaffected and AR-25's fleet-wide App Check invariants unchanged
 *   AR-39: Runtime-IAM canary config-contract — verifyEmailOTP's onCall options declare serviceAccount: parqueen-user@... and NO secrets declaration at all (capability-based split from generateEmailOTP, not shared by product grouping) — AR-25's fleet-wide App Check invariants unchanged
 *   AR-40: Runtime-IAM canary config-contract — notifyNearbyUsers's onDocumentCreated options declare serviceAccount: parqueen-messaging@..., with document path/region unaffected
 *   AR-41: Runtime-IAM canary config-contract — processScheduledClaims's onSchedule options declare serviceAccount: parqueen-messaging@..., with schedule/timeZone/memory unaffected
 *   AR-42: Runtime-IAM canary config-contract — scheduleCleaningReminders's onSchedule options declare serviceAccount: parqueen-messaging@..., with schedule unaffected
 *
 *   Wave 4 FCM permission note: parqueen-messaging's exact required FCM
 *   permission is cloudmessaging.messages.create (verified live via
 *   `gcloud iam list-testable-permissions` — GA stage, custom-role
 *   supported; also the sole message-send permission actually included in
 *   the previously-bound predefined roles/firebasecloudmessaging.admin,
 *   which additionally carries 5 topicSubscriptions.* permissions and
 *   fcmdata.deliverydata.list that none of the three messaging functions
 *   use — see the custom role projects/parkqueen-46475363-ccf36/roles/
 *   parqueenMessagingSender). All three call only getMessaging().send()/
 *   .sendEach() — no topic subscribe/unsubscribe, no delivery-data reads.
 *
 * Stage 4A note (AR-1 through AR-24, AR-19 through AR-24): as of the App
 * Check canary, adminReadView enforces App Check (functions/index.js,
 * enforceAppCheck:true) and the Firebase Local Emulator Suite has no App
 * Check emulator — a raw HTTP call from these tests can never supply a
 * token the emulator will accept, so it would be rejected by the transport
 * gate before ever reaching requireCurrentAdmin. These 24 scenarios test
 * Layer 2 (ParQueen's own admin authorization) and were changed from raw
 * HTTP calls to direct invocations of the exported `_adminReadViewHandler`
 * (functions/index.js) — the exact same handler function `onCall` wraps in
 * production, unchanged, including requireCurrentAdmin and live Auth-state
 * revalidation. `request.auth` is built via a small test-local JWT payload
 * decode (decodeEmulatorIdTokenPayload below — no Firebase internal/private
 * API, no signature verification, no production Auth calls) rather than a
 * full verifyIdToken(), for a reason specific to this suite — see that
 * function's comment. This is a handler-level emulator integration test,
 * not a transport-level HTTP test — documented here rather than left
 * implicit. AR-26 is the one test that stays at the HTTP layer,
 * specifically to prove the transport gate itself.
 *
 * reportsList/pingsList pagination (added after integration review found the
 * original flat 500-record cap would have silently truncated results
 * relative to the pre-migration client, which fetched every matching
 * document with no limit() at all — see functions/adminReadViews.js):
 *   AR-19: reportsList first page returns a deterministic nextCursor when more pages exist
 *   AR-20: reportsList second page continues with no duplicate or skipped record
 *   AR-21: malformed cursor rejected for reportsList/pingsList (shared pagination helper)
 *   AR-22: maximum page size enforced for reportsList/pingsList
 *   AR-23: the status filter remains complete across every page, not just the first
 *   AR-24: the final page returns done:true and nextCursor:null
 */

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { HttpsError } = require('firebase-functions/v2/https');
const fs = require('fs');
const path = require('path');

// Test-local JWT payload decoder — NOT a Firebase internal/private import.
// Reconstructs the callable-style request.auth = { uid, token } from a
// genuine Auth-emulator-issued ID token (minted by signInUser below) for
// direct handler invocation. Decodes only; performs no verification, no
// production Auth calls, no token minting, and no authorization decision —
// requireCurrentAdmin (inside _adminReadViewHandler) is the sole authority
// on whether the caller is actually an admin, unchanged and unmocked.
//
// Deliberately not the SDK's own verifyIdToken(): the Auth EMULATOR's
// verifyIdToken (unlike real Firebase Auth, confirmed empirically) rejects a
// deleted user's still-well-formed token outright, which would make every
// scenario below observe UNAUTHENTICATED instead of the actual
// PERMISSION_DENIED the live requireCurrentAuthenticatedUser check inside
// the handler is responsible for producing. Decoding the payload locally —
// the same "trust the emulator-issued token's claims, let the handler's own
// live checks decide" approach the real Functions emulator uses internally
// for its own debug-mode auth population — avoids that emulator-specific
// false rejection without touching Firebase's private APIs.
function decodeEmulatorIdTokenPayload(idToken) {
    const segments = String(idToken).split('.');
    if (segments.length !== 3) {
        throw new Error(`decodeEmulatorIdTokenPayload: expected a 3-segment JWT, got ${segments.length} segment(s).`);
    }
    let payload;
    try {
        payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    } catch (err) {
        throw new Error(`decodeEmulatorIdTokenPayload: token payload segment is not valid JSON (${err.message}).`);
    }
    const uid = payload.sub || payload.user_id || payload.uid;
    if (!uid || typeof uid !== 'string') {
        throw new Error('decodeEmulatorIdTokenPayload: could not derive uid from token payload (no sub/user_id/uid claim).');
    }
    payload.uid = uid; // mirrors DecodedIdToken's uid convenience alias for sub
    return payload;
}

const PROJECT_ID = 'parkqueen-46475363-ccf36';
const REGION = 'us-central1';
const FUNCTIONS_BASE = `http://localhost:5001/${PROJECT_ID}/${REGION}`;
const AUTH_EMULATOR = 'http://localhost:9099';
const APP_NAME = '__adminReadViews_intg__';

const testApp =
    getApps().find(a => a.name === APP_NAME) ??
    initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const adminAuth = getAuth(testApp);

// index.js calls initializeApp() (default app) at module load — safe here
// because this file only ever creates the separately-named `testApp` above,
// so requiring index.js's default-app init doesn't collide with it.
const { _adminReadViewHandler } = require('./index.js');

// ─── Helpers (mirrors adminSessionAuth/adminBackfill integration conventions) ─

// Raw HTTP call to the emulator's callable endpoint — used only by AR-26 to
// prove the enforceAppCheck:true transport gate itself. Every other test
// below goes through callView/callViaHandler instead; see the Stage 4A note
// in the header comment for why.
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

// Invokes the production adminReadView handler directly, bypassing the
// onCall/App-Check HTTP wrapper. request.auth is built from the local JWT
// payload decode above — see its comment for why. This is not a mock of
// requireCurrentAdmin: the token's claims are real (minted by the real Auth
// emulator via signInUser), and requireCurrentAdmin's own live-state checks
// (role claim, then a real requireCurrentAuthenticatedUser → getUser(uid)
// round-trip for disabled/deleted/revoked) run completely unchanged.
async function callViaHandler(idToken, data = {}) {
    let auth;
    if (idToken) {
        const token = decodeEmulatorIdTokenPayload(idToken);
        auth = { uid: token.uid, token };
    }
    try {
        const result = await _adminReadViewHandler({ auth, data });
        return { result };
    } catch (err) {
        if (err instanceof HttpsError) return { error: err.toJSON() }; // same shape the HTTP layer serializes
        throw err;
    }
}

function callView(idToken, view, params = {}) {
    return callViaHandler(idToken, { view, params });
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
    return `ar_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

async function nuke(uid) {
    await adminAuth.deleteUser(uid).catch(() => {});
}

async function adminIdToken(uid) {
    await adminAuth.createUser({ uid }).catch(() => {});
    await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
    return signInUser(uid);
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('adminReadView — coordinated read-side session hardening', () => {
    let uid;
    let cleanupUserIds;

    beforeEach(() => {
        uid = testUid('caller');
        cleanupUserIds = [];
    });

    afterEach(async () => {
        await nuke(uid);
        for (const id of cleanupUserIds) {
            await db.doc(`users/${id}`).delete().catch(() => {});
            await db.doc(`reports/${id}`).delete().catch(() => {});
            await db.doc(`parkingSessions/${id}`).delete().catch(() => {});
        }
    });

    it('AR-1: unauthenticated rejected', async () => {
        const resp = await callView(null, 'usersList');
        expect(resp.error?.status).toBe('UNAUTHENTICATED');
    });

    it('AR-2: current admin allowed', async () => {
        const idToken = await adminIdToken(uid);
        const resp = await callView(idToken, 'usersList');
        expect(resp.error).toBeUndefined();
        expect(Array.isArray(resp.result.users)).toBe(true);
    });

    it('AR-3: stale demoted admin denied', async () => {
        const idToken = await adminIdToken(uid);
        await adminAuth.setCustomUserClaims(uid, { role: 'staff' });
        const resp = await callView(idToken, 'usersList');
        expect(resp.error?.status).toBe('PERMISSION_DENIED');
    });

    it('AR-4: deleted former admin denied', async () => {
        const idToken = await adminIdToken(uid);
        await adminAuth.deleteUser(uid).catch(() => {});
        const resp = await callView(idToken, 'reportsList', { status: 'pending' });
        expect(resp.error?.status).toBe('PERMISSION_DENIED');
    });

    it('AR-5: disabled admin denied', async () => {
        const idToken = await adminIdToken(uid);
        await adminAuth.updateUser(uid, { disabled: true });
        const resp = await callView(idToken, 'auditLogList');
        expect(resp.error?.status).toBe('PERMISSION_DENIED');
    });

    it('AR-6: token predating a later promotion still requires refresh (unchanged intended behavior)', async () => {
        await adminAuth.createUser({ uid }).catch(() => {});
        const idToken = await signInUser(uid); // signed in BEFORE promotion
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        const resp = await callView(idToken, 'usersList');
        expect(resp.error?.status).toBe('PERMISSION_DENIED');
    });

    it('AR-7: usersList returns only intended fields (data minimization)', async () => {
        const idToken = await adminIdToken(uid);
        const targetId = testUid('target');
        cleanupUserIds.push(targetId);
        await db.doc(`users/${targetId}`).set({
            id: targetId, fullName: 'Test User', username: 'testu', email: 't@example.com',
            phone: '555-0100', status: 'Active', createdAt: Timestamp.now(),
            crowns: 42, title: 'Legend', vehicleType: 'sedan', vehicleBrand: 'Honda',
            vehicleColor: 'blue', avatarManifestId: 'm1', avatarAgeGroup: 'adult',
            avatarUpdatedAt: Timestamp.now(),
        });

        // Loop pages until the seeded target is found (collection may hold
        // stray docs from other suites).
        let found = null;
        let cursor = null, done = false, guard = 0;
        while (!done && !found && guard++ < 20) {
            const resp = await callView(idToken, 'usersList', { cursor, limit: 200 });
            expect(resp.error).toBeUndefined();
            found = resp.result.users.find(u => u.id === targetId);
            cursor = resp.result.nextCursor;
            done = resp.result.done;
        }
        expect(found).toBeTruthy();
        expect(found.fullName).toBe('Test User');
        expect('crowns' in found).toBe(false);
        expect('title' in found).toBe(false);
        expect('vehicleType' in found).toBe(false);
        expect('vehicleBrand' in found).toBe(false);
        expect('vehicleColor' in found).toBe(false);
        expect('avatarManifestId' in found).toBe(false);
        expect('avatarAgeGroup' in found).toBe(false);
        expect('avatarUpdatedAt' in found).toBe(false);
    });

    it('AR-8: userDetail returns only the bundled sections the modal displays', async () => {
        const idToken = await adminIdToken(uid);
        const targetId = testUid('target');
        cleanupUserIds.push(targetId);

        const resp = await callView(idToken, 'userDetail', { uid: targetId });
        expect(resp.error).toBeUndefined();
        const keys = Object.keys(resp.result).sort();
        expect(keys).toEqual(
            ['auditEntries', 'errors', 'recentPings', 'reportsAgainst', 'reportsFiled', 'session', 'trustEvents'].sort(),
        );
    });

    it('AR-9: reportsList status filter honored + userMap minimized to fullName/username/email', async () => {
        const idToken = await adminIdToken(uid);
        const reporterId = testUid('reporter');
        const reportedId = testUid('reported');
        const reportId = testUid('report');
        cleanupUserIds.push(reporterId, reportedId);
        await db.doc(`users/${reporterId}`).set({ fullName: 'Reporter', username: 'rep', email: 'r@x.com', phone: '555-1' });
        await db.doc(`reports/${reportId}`).set({
            reporterId, reportedUserId: reportedId, type: 'spam', reason: 'test',
            status: 'pending', createdAt: Timestamp.now(),
        });

        const resp = await callView(idToken, 'reportsList', { status: 'pending' });
        expect(resp.error).toBeUndefined();
        const found = resp.result.reports.find(r => r.id === reportId);
        expect(found).toBeTruthy();
        expect(found.status).toBe('pending');
        const info = resp.result.userMap[reporterId];
        expect(info.fullName).toBe('Reporter');
        expect('phone' in info).toBe(false);

        await db.doc(`reports/${reportId}`).delete().catch(() => {});
    });

    it('AR-10: auditLogList merges standard+legacy entries, deduplicated', async () => {
        const idToken = await adminIdToken(uid);
        const entryId = testUid('entry');
        await db.doc(`adminAuditLog/${entryId}`).set({
            action: 'user.suspend', targetType: 'user', adminId: uid, createdAt: Timestamp.now(),
        });

        const resp = await callView(idToken, 'auditLogList');
        expect(resp.error).toBeUndefined();
        expect(Array.isArray(resp.result.entries)).toBe(true);
        const found = resp.result.entries.find(e => e.id === entryId);
        expect(found).toBeTruthy();

        await db.doc(`adminAuditLog/${entryId}`).delete().catch(() => {});
    });

    it('AR-11: userDetail session is scoped to exactly the requested uid', async () => {
        const idToken = await adminIdToken(uid);
        const targetA = testUid('sessA');
        const targetB = testUid('sessB');
        await db.doc(`parkingSessions/${targetA}`).set({ active: true, streetName: 'A St' });
        await db.doc(`parkingSessions/${targetB}`).set({ active: true, streetName: 'B St' });

        const resp = await callView(idToken, 'userDetail', { uid: targetA });
        expect(resp.error).toBeUndefined();
        expect(resp.result.session.streetName).toBe('A St');

        await db.doc(`parkingSessions/${targetA}`).delete().catch(() => {});
        await db.doc(`parkingSessions/${targetB}`).delete().catch(() => {});
    });

    it('AR-12: malformed pagination params rejected', async () => {
        const idToken = await adminIdToken(uid);
        const badCursor = await callView(idToken, 'usersList', { cursor: 12345 });
        expect(badCursor.error?.status).toBe('INVALID_ARGUMENT');

        const badLimit = await callView(idToken, 'usersList', { limit: -1 });
        expect(badLimit.error?.status).toBe('INVALID_ARGUMENT');

        const badLimitType = await callView(idToken, 'usersList', { limit: 'lots' });
        expect(badLimitType.error?.status).toBe('INVALID_ARGUMENT');
    });

    it('AR-13: maximum page size enforced', async () => {
        const idToken = await adminIdToken(uid);
        const resp = await callView(idToken, 'usersList', { limit: 100000 });
        expect(resp.error?.status).toBe('INVALID_ARGUMENT');
    });

    it('AR-14: unknown/arbitrary view name rejected — no generic collection proxy', async () => {
        const idToken = await adminIdToken(uid);
        const resp = await callView(idToken, 'arbitraryCollectionDump', { collection: 'users' });
        expect(resp.error?.status).toBe('INVALID_ARGUMENT');
    });

    it('AR-15: arbitrary extra params are silently ignored, never alter the query', async () => {
        const idToken = await adminIdToken(uid);
        const resp = await callView(idToken, 'reportsList', {
            status: 'pending', collection: 'users', where: { field: 'role', op: '==', value: 'admin' },
        });
        expect(resp.error).toBeUndefined();
        expect(Array.isArray(resp.result.reports)).toBe(true);
    });

    it('AR-16: a garbage/foreign cursor cannot escape the intended collection scope', async () => {
        const idToken = await adminIdToken(uid);
        // Cursor references a document ID that does not exist in `users` —
        // handler must fall back to starting from the beginning rather than
        // erroring or leaking data from another collection.
        const resp = await callView(idToken, 'usersList', { cursor: 'nonexistent-doc-id-xyz', limit: 5 });
        expect(resp.error).toBeUndefined();
        expect(Array.isArray(resp.result.users)).toBe(true);
    });

    it('AR-17: client-requested field lists have no effect — server always returns its fixed minimized shape', async () => {
        const idToken = await adminIdToken(uid);
        const reporterId = testUid('reporter2');
        const reportId = testUid('report2');
        cleanupUserIds.push(reporterId);
        await db.doc(`users/${reporterId}`).set({ fullName: 'X', username: 'x', email: 'x@x.com', phone: '555-2' });
        await db.doc(`reports/${reportId}`).set({
            reporterId, reportedUserId: testUid('other'), type: 'spam', reason: 'test',
            status: 'pending', createdAt: Timestamp.now(),
        });

        const resp = await callView(idToken, 'reportsList', {
            status: 'pending', fields: ['email', 'phone', 'crowns'], select: '*',
        });
        expect(resp.error).toBeUndefined();
        const info = resp.result.userMap[reporterId];
        expect(Object.keys(info).sort()).toEqual(['email', 'fullName', 'username'].sort());

        await db.doc(`reports/${reportId}`).delete().catch(() => {});
    });

    it('AR-18: source-contract — adminReadView is present, requireCurrentAdmin-gated, and the view enum matches', () => {
        const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        // requireCurrentAdmin lives in adminReadViewHandler (Stage 4A extracted
        // it from the inline onCall callback so it can be tested directly —
        // see AR-25/AR-26 and the handler's own comment in index.js).
        const fnStart = indexSrc.indexOf('async function adminReadViewHandler(request)');
        expect(fnStart).toBeGreaterThan(-1);
        const body = indexSrc.slice(fnStart, fnStart + 1200);
        expect(body).toMatch(/await requireCurrentAdmin\(request\);/);
        expect(body).not.toMatch(/collection\(p\.collection\)/); // no client-supplied collection

        const exportStart = indexSrc.indexOf('exports.adminReadView = onCall(');
        expect(exportStart).toBeGreaterThan(-1);
        expect(indexSrc.slice(exportStart, exportStart + 1200)).toMatch(/adminReadViewHandler/); // wired to the same handler

        const viewsSrc = fs.readFileSync(path.join(__dirname, 'adminReadViews.js'), 'utf8');
        for (const view of ['dashboardCounts', 'usersList', 'userDetail', 'reportsList', 'auditLogList', 'pingsList', 'parseFailuresList']) {
            expect(viewsSrc).toMatch(new RegExp(`\\b${view}\\b`));
        }
    });

    it('AR-25: App Check canary config-contract — adminReadView, sendMessage, updateDisplayName, deleteChat and checkHydrantDistance are the ONLY enforced callables; no replay protection', () => {
        const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

        // adminReadView (Stage 4A) + sendMessage (chat write-path hardening)
        // + updateDisplayName (profile-identity hardening) + deleteChat
        // (server-mediated conversation deletion) + checkHydrantDistance
        // (paid NYC DEP lookup behind the app's Socrata token, enforced from
        // its first deploy rather than retrofitted) are the five enforced
        // callables. claimUsername deliberately is NOT enforced —
        // real production traffic showed App Check MISSING on every sample,
        // insufficient evidence to enforce safely (see
        // docs/PROFILE_IDENTITY_HARDENING.md). Any further growth of this
        // count must be a deliberate, reviewed enforcement decision.
        const enforceTrueMatches = indexSrc.match(/enforceAppCheck:\s*true/g) || [];
        expect(enforceTrueMatches.length).toBe(5);

        const adminReadViewCallStart = indexSrc.indexOf('exports.adminReadView = onCall(');
        expect(adminReadViewCallStart).toBeGreaterThan(-1);
        const optionsSlice = indexSrc.slice(adminReadViewCallStart, adminReadViewCallStart + 1200);
        expect(optionsSlice).toMatch(/enforceAppCheck:\s*true/);
        expect(optionsSlice).not.toMatch(/consumeAppCheckToken/);

        // Pin the fifth slot, so enforcement appearing somewhere unintended
        // cannot silently satisfy the raised count.
        const hydrantStart = indexSrc.indexOf('exports.checkHydrantDistance = onCall(');
        expect(hydrantStart).toBeGreaterThan(-1);
        expect(indexSrc.slice(hydrantStart, hydrantStart + 600)).toMatch(/enforceAppCheck:\s*true/);

        expect(indexSrc.match(/consumeAppCheckToken:\s*true/g) || []).toHaveLength(0);
    });

    it("AR-27: Runtime-IAM canary config-contract — adminReadView's serviceAccount is the dedicated admin-read identity", () => {
        const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const adminReadViewCallStart = indexSrc.indexOf('exports.adminReadView = onCall(');
        expect(adminReadViewCallStart).toBeGreaterThan(-1);
        const optionsSlice = indexSrc.slice(adminReadViewCallStart, adminReadViewCallStart + 1200);

        expect(optionsSlice).toMatch(/serviceAccount:\s*'parqueen-admin-read@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
        // Still enforced — a serviceAccount edit must not accidentally touch
        // the App Check config sitting right next to it. (sendMessage and
        // updateDisplayName are now also enforced; see AR-25 for the
        // fleet-wide count.)
        expect(optionsSlice).toMatch(/enforceAppCheck:\s*true/);
        expect((indexSrc.match(/enforceAppCheck:\s*true/g) || []).length).toBe(5);
        expect(indexSrc.match(/consumeAppCheckToken:\s*true/g) || []).toHaveLength(0);

        // Forty canaries should carry a serviceAccount override — adminReadView
        // (admin-only), sendMessage (authoritative chat write path),
        // claimUsername, updateDisplayName (both authoritative
        // profile-identity write paths), moderateAvatarUpload (dedicated
        // avatar-moderation Storage-trigger runtime — see AR-29),
        // cleanAvatarOrphans (dedicated orphan-cleanup scheduled-trigger
        // runtime — see AR-30), deleteAccount (dedicated account-deletion
        // runtime — see AR-31), bootstrapAdmin/reconcileLegacyAdminSingleton/
        // setStaffRole (Wave 1 admin-auth-runtime migration — see AR-32/33/34),
        // analyzeSign/generateSmartReplies/generateListingDescription
        // (Wave 2 AI-runtime migration — see AR-35/36/37),
        // generateEmailOTP/verifyEmailOTP (Wave 3 email-runtime migration,
        // split across two capability identities — see AR-38/39), and
        // notifyNearbyUsers/processScheduledClaims/scheduleCleaningReminders
        // (Wave 4 messaging-runtime migration — see AR-40/41/42), and
        // createSegmentFromSweepNYC (Wave 5 segment-creation runtime
        // migration — see RL-C-10), and adminAddSegment/adminAddCleaningRule/
        // adminSupersedeRule/adminUpdateSegmentStatus/adminResolveParseFailure/
        // adminReopenParseFailure/adminUpdateReport (Wave 6A admin-write
        // runtime migration, shared parqueen-admin-write identity — see
        // AS-26), adminAddSuspension/adminArchiveSuspension (Wave 6B-1
        // suspension-calendar migration, same shared identity — see AS-27),
        // and adminSuspendUser/adminUnsuspendUser (Wave 6B-2 user-enforcement
        // migration, same shared identity — see AS-28), adminDeleteSpot
        // (Wave 6B-3, same shared identity — see AS-29), and
        // adminBackfillStreetIntelligence (Wave 6C, same shared identity —
        // see AS-30). This closes Wave 6 — every admin-write function now
        // runs on parqueen-admin-write. And cleanupExpiredInterests/
        // cleanupExpiredHolds (Wave 7A-1, dedicated parqueen-cleanup identity
        // — see CEI-13/CEH-8), and cleanupExpiredSpotsHourly (Wave 7A-2,
        // same shared identity — see CESH-1), and initUserPrivateAccount/
        // incrementTotalSpotsPinged (Wave 7B-1, dedicated
        // parqueen-system-events identity, deployed — see OB-10/PN-11), and
        // updateTrustOnFeedback/updateTrustOnSpotDelete (Wave 7B-2, same
        // shared parqueen-system-events identity, deployed — see
        // TB2-1/TB2-2), and awardCrowns (Wave 7B-3, same shared
        // parqueen-system-events identity — see AC-9; source-only, not yet
        // deployed). This closes the Eventarc runtime migration — all five
        // formerly-compute-default functions now declare a dedicated
        // serviceAccount in source.
        // moderateContent was retired (uncalled since deployment; see
        // docs/CHAT_MESSAGE_HARDENING.md) and no longer exists. deleteChat
        // (server-mediated conversation deletion) reuses the existing
        // parqueen-user identity — see DC-07. checkHydrantDistance (NYC DEP
        // hydrant lookup) likewise reuses parqueen-user: it needs the Socrata
        // secret and nothing else, which is the identity that already has it.
        // The marketing waitlist intentionally added two `serviceAccount:`
        // declarations, which is why this count moved from 42 to 44. Both
        // reuse existing identities (see docs/WAITLIST.md):
        //   - parqueen-email@... on the two HTTP endpoints, joinWaitlist and
        //     confirmWaitlist, declared once in their shared options object
        //     (they send the SendGrid confirmation email, the job that
        //     identity already does);
        //   - parqueen-cleanup@... on the expireStaleWaitlistSignups scheduled
        //     job, alongside the other scheduled deletion jobs.
        // This counts serviceAccount declarations, not exported functions.
        const allServiceAccountMatches = indexSrc.match(/serviceAccount:\s*'[^']+'/g) || [];
        expect(allServiceAccountMatches).toHaveLength(44);
    });

    it("AR-29: Runtime-IAM canary config-contract — moderateAvatarUpload's serviceAccount is the dedicated avatar-moderator identity, Storage-trigger config unaffected", () => {
        const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const moderateAvatarUploadCallStart = indexSrc.indexOf('exports.moderateAvatarUpload = onObjectFinalized(');
        expect(moderateAvatarUploadCallStart).toBeGreaterThan(-1);
        const optionsSlice = indexSrc.slice(moderateAvatarUploadCallStart, moderateAvatarUploadCallStart + 400);

        expect(optionsSlice).toMatch(/serviceAccount:\s*'parqueen-avatar-moderator@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
        // A serviceAccount edit must not accidentally touch the trigger's other
        // options — this is a Storage finalize trigger, not a callable, so it
        // carries no App Check config to protect, but region/memory/retry must
        // survive the edit unchanged.
        expect(optionsSlice).toMatch(/region:\s*"us-central1"/);
        expect(optionsSlice).toMatch(/memory:\s*"512MiB"/);
        expect(optionsSlice).toMatch(/retry:\s*true/);
        expect((indexSrc.match(/enforceAppCheck:\s*true/g) || []).length).toBe(5);
        expect(indexSrc.match(/consumeAppCheckToken:\s*true/g) || []).toHaveLength(0);
    });

    it("AR-30: Runtime-IAM canary config-contract — cleanAvatarOrphans's serviceAccount is the dedicated avatar-cleanup identity, schedule/memory config unaffected", () => {
        const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const cleanAvatarOrphansCallStart = indexSrc.indexOf('exports.cleanAvatarOrphans = onSchedule(');
        expect(cleanAvatarOrphansCallStart).toBeGreaterThan(-1);
        const optionsSlice = indexSrc.slice(cleanAvatarOrphansCallStart, cleanAvatarOrphansCallStart + 400);

        expect(optionsSlice).toMatch(/serviceAccount:\s*'parqueen-avatar@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
        // A serviceAccount edit must not accidentally touch the schedule or
        // cleanup runtime config sitting right next to it.
        expect(optionsSlice).toMatch(/region:\s*"us-central1"/);
        expect(optionsSlice).toMatch(/schedule:\s*"every 24 hours"/);
        expect(optionsSlice).toMatch(/memory:\s*"256MiB"/);
        expect((indexSrc.match(/enforceAppCheck:\s*true/g) || []).length).toBe(5);
        expect(indexSrc.match(/consumeAppCheckToken:\s*true/g) || []).toHaveLength(0);
    });

    it("AR-31: Runtime-IAM canary config-contract — deleteAccount's serviceAccount is the dedicated account-deletion identity, App Check invariants unaffected", () => {
        const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const deleteAccountCallStart = indexSrc.indexOf("exports.deleteAccount = onCall(");
        expect(deleteAccountCallStart).toBeGreaterThan(-1);
        const optionsSlice = indexSrc.slice(deleteAccountCallStart, deleteAccountCallStart + 400);

        expect(optionsSlice).toMatch(/serviceAccount:\s*'parqueen-account@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
        // deleteAccount is not an App-Check-enforced canary — a serviceAccount
        // edit must not acquire enforceAppCheck/consumeAppCheckToken as a side
        // effect, and region must survive unchanged.
        expect(optionsSlice).toMatch(/region:\s*'us-central1'/);
        expect(optionsSlice).not.toMatch(/enforceAppCheck/);
        expect(optionsSlice).not.toMatch(/consumeAppCheckToken/);
        expect((indexSrc.match(/enforceAppCheck:\s*true/g) || []).length).toBe(5);
        expect(indexSrc.match(/consumeAppCheckToken:\s*true/g) || []).toHaveLength(0);
    });

    it("AR-32: Runtime-IAM canary config-contract — bootstrapAdmin's serviceAccount is the dedicated admin-auth identity, App Check invariants unaffected", () => {
        const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const callStart = indexSrc.indexOf("exports.bootstrapAdmin = onCall(");
        expect(callStart).toBeGreaterThan(-1);
        const optionsSlice = indexSrc.slice(callStart, callStart + 400);

        expect(optionsSlice).toMatch(/serviceAccount:\s*'parqueen-admin-auth@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
        expect(optionsSlice).toMatch(/region:\s*'us-central1'/);
        expect(optionsSlice).not.toMatch(/enforceAppCheck/);
        expect(optionsSlice).not.toMatch(/consumeAppCheckToken/);
        expect((indexSrc.match(/enforceAppCheck:\s*true/g) || []).length).toBe(5);
        expect(indexSrc.match(/consumeAppCheckToken:\s*true/g) || []).toHaveLength(0);
    });

    it("AR-33: Runtime-IAM canary config-contract — reconcileLegacyAdminSingleton's serviceAccount is the dedicated admin-auth identity, App Check invariants unaffected", () => {
        const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const callStart = indexSrc.indexOf("exports.reconcileLegacyAdminSingleton = onCall(");
        expect(callStart).toBeGreaterThan(-1);
        const optionsSlice = indexSrc.slice(callStart, callStart + 400);

        expect(optionsSlice).toMatch(/serviceAccount:\s*'parqueen-admin-auth@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
        expect(optionsSlice).toMatch(/region:\s*'us-central1'/);
        expect(optionsSlice).not.toMatch(/enforceAppCheck/);
        expect(optionsSlice).not.toMatch(/consumeAppCheckToken/);
        expect((indexSrc.match(/enforceAppCheck:\s*true/g) || []).length).toBe(5);
        expect(indexSrc.match(/consumeAppCheckToken:\s*true/g) || []).toHaveLength(0);
    });

    it("AR-34: Runtime-IAM canary config-contract — setStaffRole's serviceAccount is the dedicated admin-auth identity, App Check invariants unaffected", () => {
        const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const callStart = indexSrc.indexOf("exports.setStaffRole = onCall(");
        expect(callStart).toBeGreaterThan(-1);
        const optionsSlice = indexSrc.slice(callStart, callStart + 400);

        expect(optionsSlice).toMatch(/serviceAccount:\s*'parqueen-admin-auth@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
        expect(optionsSlice).toMatch(/region:\s*'us-central1'/);
        expect(optionsSlice).not.toMatch(/enforceAppCheck/);
        expect(optionsSlice).not.toMatch(/consumeAppCheckToken/);
        expect((indexSrc.match(/enforceAppCheck:\s*true/g) || []).length).toBe(5);
        expect(indexSrc.match(/consumeAppCheckToken:\s*true/g) || []).toHaveLength(0);
    });

    it("AR-35: Runtime-IAM canary config-contract — analyzeSign's serviceAccount is the dedicated AI-runtime identity, secret/App-Check config unaffected", () => {
        const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const callStart = indexSrc.indexOf("exports.analyzeSign = onCall(");
        expect(callStart).toBeGreaterThan(-1);
        const optionsSlice = indexSrc.slice(callStart, callStart + 400);

        expect(optionsSlice).toMatch(/serviceAccount:\s*'parqueen-ai@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
        // A serviceAccount edit must not touch the secret binding or the
        // deliberate non-enforcement of App Check sitting right next to it.
        expect(optionsSlice).toMatch(/secrets:\s*\[geminiApiKey\]/);
        expect(optionsSlice).toMatch(/enforceAppCheck:\s*false/);
        expect(optionsSlice).not.toMatch(/consumeAppCheckToken/);
        expect((indexSrc.match(/enforceAppCheck:\s*true/g) || []).length).toBe(5);
        expect(indexSrc.match(/consumeAppCheckToken:\s*true/g) || []).toHaveLength(0);
    });

    it("AR-36: Runtime-IAM canary config-contract — generateSmartReplies's serviceAccount is the dedicated AI-runtime identity, secret/App-Check config unaffected", () => {
        const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const callStart = indexSrc.indexOf("exports.generateSmartReplies = onCall(");
        expect(callStart).toBeGreaterThan(-1);
        const optionsSlice = indexSrc.slice(callStart, callStart + 400);

        expect(optionsSlice).toMatch(/serviceAccount:\s*'parqueen-ai@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
        expect(optionsSlice).toMatch(/secrets:\s*\[geminiApiKey\]/);
        expect(optionsSlice).toMatch(/enforceAppCheck:\s*false/);
        expect(optionsSlice).not.toMatch(/consumeAppCheckToken/);
        expect((indexSrc.match(/enforceAppCheck:\s*true/g) || []).length).toBe(5);
        expect(indexSrc.match(/consumeAppCheckToken:\s*true/g) || []).toHaveLength(0);
    });

    it("AR-37: Runtime-IAM canary config-contract — generateListingDescription's serviceAccount is the dedicated AI-runtime identity, secret/App-Check config unaffected", () => {
        const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const callStart = indexSrc.indexOf("exports.generateListingDescription = onCall(");
        expect(callStart).toBeGreaterThan(-1);
        const optionsSlice = indexSrc.slice(callStart, callStart + 400);

        expect(optionsSlice).toMatch(/serviceAccount:\s*'parqueen-ai@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
        expect(optionsSlice).toMatch(/secrets:\s*\[geminiApiKey\]/);
        expect(optionsSlice).toMatch(/enforceAppCheck:\s*false/);
        expect(optionsSlice).not.toMatch(/consumeAppCheckToken/);
        expect((indexSrc.match(/enforceAppCheck:\s*true/g) || []).length).toBe(5);
        expect(indexSrc.match(/consumeAppCheckToken:\s*true/g) || []).toHaveLength(0);
    });

    it("AR-38: Runtime-IAM canary config-contract — generateEmailOTP's serviceAccount is the dedicated email identity, secret/App-Check config unaffected", () => {
        const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const callStart = indexSrc.indexOf("exports.generateEmailOTP = onCall(");
        expect(callStart).toBeGreaterThan(-1);
        const optionsSlice = indexSrc.slice(callStart, callStart + 400);

        expect(optionsSlice).toMatch(/serviceAccount:\s*'parqueen-email@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
        // A serviceAccount edit must not touch the secret bindings sitting
        // right next to it — both SendGrid and the rate-limit pepper.
        expect(optionsSlice).toMatch(/secrets:\s*\[sendgridApiKey,\s*emailRateLimitPepper\]/);
        expect(optionsSlice).not.toMatch(/enforceAppCheck/);
        expect(optionsSlice).not.toMatch(/consumeAppCheckToken/);
        expect((indexSrc.match(/enforceAppCheck:\s*true/g) || []).length).toBe(5);
        expect(indexSrc.match(/consumeAppCheckToken:\s*true/g) || []).toHaveLength(0);
    });

    it("AR-39: Runtime-IAM canary config-contract — verifyEmailOTP's serviceAccount is the dedicated parqueen-user identity, and it declares NO secrets (capability-based split from generateEmailOTP)", () => {
        const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const callStart = indexSrc.indexOf("exports.verifyEmailOTP = onCall(");
        expect(callStart).toBeGreaterThan(-1);
        const optionsSlice = indexSrc.slice(callStart, callStart + 400);

        expect(optionsSlice).toMatch(/serviceAccount:\s*'parqueen-user@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
        // verifyEmailOTP never touches SendGrid or the rate-limit pepper —
        // it must not carry a `secrets:` declaration at all. This is the
        // explicit negative proof that the capability split is real, not
        // just the two functions sharing an identity by product grouping.
        expect(optionsSlice).not.toMatch(/secrets:/);
        expect(optionsSlice).not.toMatch(/sendgridApiKey/);
        expect(optionsSlice).not.toMatch(/emailRateLimitPepper/);
        expect(optionsSlice).not.toMatch(/enforceAppCheck/);
        expect(optionsSlice).not.toMatch(/consumeAppCheckToken/);
        expect((indexSrc.match(/enforceAppCheck:\s*true/g) || []).length).toBe(5);
        expect(indexSrc.match(/consumeAppCheckToken:\s*true/g) || []).toHaveLength(0);
    });

    it("AR-40: Runtime-IAM canary config-contract — notifyNearbyUsers's serviceAccount is the dedicated messaging identity, Firestore-trigger config unaffected", () => {
        const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const callStart = indexSrc.indexOf("exports.notifyNearbyUsers = onDocumentCreated(");
        expect(callStart).toBeGreaterThan(-1);
        const optionsSlice = indexSrc.slice(callStart, callStart + 400);

        expect(optionsSlice).toMatch(/serviceAccount:\s*'parqueen-messaging@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
        // A serviceAccount edit must not touch the Firestore trigger's own
        // document path/region sitting right next to it.
        expect(optionsSlice).toMatch(/document:\s*"spots\/\{spotId\}"/);
        expect(optionsSlice).toMatch(/region:\s*"us-central1"/);
        expect((indexSrc.match(/enforceAppCheck:\s*true/g) || []).length).toBe(5);
        expect(indexSrc.match(/consumeAppCheckToken:\s*true/g) || []).toHaveLength(0);
    });

    it("AR-41: Runtime-IAM canary config-contract — processScheduledClaims's serviceAccount is the dedicated messaging identity, schedule/timezone/memory config unaffected", () => {
        const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const callStart = indexSrc.indexOf("exports.processScheduledClaims = onSchedule(");
        expect(callStart).toBeGreaterThan(-1);
        const optionsSlice = indexSrc.slice(callStart, callStart + 400);

        expect(optionsSlice).toMatch(/serviceAccount:\s*'parqueen-messaging@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
        expect(optionsSlice).toMatch(/schedule:\s*"every 5 minutes"/);
        expect(optionsSlice).toMatch(/timeZone:\s*"America\/Toronto"/);
        expect(optionsSlice).toMatch(/memory:\s*"256MiB"/);
        expect((indexSrc.match(/enforceAppCheck:\s*true/g) || []).length).toBe(5);
        expect(indexSrc.match(/consumeAppCheckToken:\s*true/g) || []).toHaveLength(0);
    });

    it("AR-42: Runtime-IAM canary config-contract — scheduleCleaningReminders's serviceAccount is the dedicated messaging identity, schedule config unaffected", () => {
        const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const callStart = indexSrc.indexOf("exports.scheduleCleaningReminders = onSchedule(");
        expect(callStart).toBeGreaterThan(-1);
        const optionsSlice = indexSrc.slice(callStart, callStart + 400);

        expect(optionsSlice).toMatch(/serviceAccount:\s*'parqueen-messaging@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
        expect(optionsSlice).toMatch(/schedule:\s*'every 15 minutes'/);
        expect((indexSrc.match(/enforceAppCheck:\s*true/g) || []).length).toBe(5);
        expect(indexSrc.match(/consumeAppCheckToken:\s*true/g) || []).toHaveLength(0);
    });

    it('AR-26: App Check canary HTTP boundary — valid admin ID token but no App Check token is rejected before the handler runs', async () => {
        const idToken = await adminIdToken(uid);
        // Raw HTTP call (not callView/callViaHandler): the onCall wrapper's
        // enforceAppCheck:true gate only exists at the transport layer.
        // Auth alone (a real, valid, current-admin token) is not enough —
        // if this returned a successful admin response, App Check would not
        // actually be gating this callable.
        const resp = await callFn('adminReadView', idToken, { view: 'usersList', params: {} });
        expect(resp.error?.status).toBe('UNAUTHENTICATED');
        expect(resp.result).toBeUndefined();
    });

    // ─── reportsList/pingsList pagination ───────────────────────────────
    // The pre-migration client queries for these two views had NO limit()
    // at all (see functions/adminReadViews.js's reportsList/pingsList
    // header comments) — a flat cap would have silently truncated results.
    // These tests prove the cursor pagination added in response to
    // integration review reconstructs the complete result set with no
    // duplicate or skipped record.
    describe('reportsList/pingsList pagination', () => {
        let reportIds, spotIds;

        beforeEach(() => { reportIds = []; spotIds = []; });

        afterEach(async () => {
            for (const id of reportIds) await db.doc(`reports/${id}`).delete().catch(() => {});
            for (const id of spotIds) await db.doc(`spots/${id}`).delete().catch(() => {});
        });

        it('AR-19/AR-20/AR-24: reportsList pages through all matching reports with no duplicate or skipped record', async () => {
            const idToken = await adminIdToken(uid);
            const marker = testUid('pgmark');
            for (let i = 0; i < 5; i++) {
                const id = `${marker}_${i}`;
                reportIds.push(id);
                await db.doc(`reports/${id}`).set({
                    reporterId: testUid('r'), reportedUserId: testUid('rd'), type: 'spam',
                    reason: marker, status: 'pending',
                    createdAt: Timestamp.fromMillis(Date.now() - i * 1000), // deterministic distinct order
                });
            }

            const page1 = await callView(idToken, 'reportsList', { status: 'pending', limit: 2 });
            expect(page1.error).toBeUndefined();
            expect(page1.result.reports.length).toBeLessThanOrEqual(2);
            expect(page1.result.done).toBe(false); // AR-19: deterministic nextCursor when more pages exist
            expect(page1.result.nextCursor).toBeTruthy();

            const seen = new Set(page1.result.reports.map(r => r.id));
            let cursor = page1.result.nextCursor;
            let done = false;
            let guard = 0;
            while (!done && guard++ < 20) {
                const page = await callView(idToken, 'reportsList', { status: 'pending', limit: 2, cursor });
                expect(page.error).toBeUndefined();
                for (const r of page.result.reports) {
                    expect(seen.has(r.id)).toBe(false); // AR-20: no duplicate across pages
                    seen.add(r.id);
                }
                cursor = page.result.nextCursor;
                done = page.result.done;
            }
            expect(done).toBe(true);
            expect(cursor).toBeNull(); // AR-24: final page returns done:true/nextCursor:null

            const ourReports = [...seen].filter(id => id.startsWith(marker));
            expect(ourReports.length).toBe(5); // no skipped record among our 5 seeded reports
        });

        it('AR-23: reportsList status filter remains complete across every page, not just the first', async () => {
            const idToken = await adminIdToken(uid);
            const marker = testUid('filtmark');
            for (let i = 0; i < 4; i++) {
                const id = `${marker}_${i}`;
                reportIds.push(id);
                await db.doc(`reports/${id}`).set({
                    reporterId: testUid('r'), reportedUserId: testUid('rd'), type: 'spam',
                    reason: marker, status: i % 2 === 0 ? 'pending' : 'reviewed',
                    createdAt: Timestamp.fromMillis(Date.now() - i * 1000),
                });
            }

            let cursor = null, done = false, guard = 0;
            const found = [];
            while (!done && guard++ < 20) {
                const page = await callView(idToken, 'reportsList', { status: 'pending', limit: 1, cursor });
                expect(page.error).toBeUndefined();
                found.push(...page.result.reports.filter(r => r.reason === marker));
                cursor = page.result.nextCursor;
                done = page.result.done;
            }
            // Only the 2 'pending' reports among our 4 seeded — 'reviewed' ones
            // must never appear, on any page, even though pagination interleaves
            // with other suites' data.
            expect(found.length).toBe(2);
            expect(found.every(r => r.status === 'pending')).toBe(true);
        });

        it('AR-21/AR-22: malformed cursor and oversized limit rejected for pingsList (shared pagination helper)', async () => {
            const idToken = await adminIdToken(uid);
            const badCursor = await callView(idToken, 'pingsList', { filter: 'active', cursor: 999 });
            expect(badCursor.error?.status).toBe('INVALID_ARGUMENT');

            const badLimit = await callView(idToken, 'pingsList', { filter: 'active', limit: 100000 });
            expect(badLimit.error?.status).toBe('INVALID_ARGUMENT');
        });

        it('pingsList (active) pages through all matching spots with no duplicate or skipped record', async () => {
            const idToken = await adminIdToken(uid);
            const marker = testUid('pingmark');
            const future = Timestamp.fromMillis(Date.now() + 60 * 60 * 1000);
            for (let i = 0; i < 3; i++) {
                const id = `${marker}_${i}`;
                spotIds.push(id);
                await db.doc(`spots/${id}`).set({
                    lat: 40.7, lng: -74.0, type: 'free', status: 'available',
                    finderId: testUid('f'), finderName: marker,
                    pingMode: 'now', reportedAt: Timestamp.now(),
                    expiresAt: Timestamp.fromMillis(future.toMillis() + i * 1000),
                    geohash: 'dr5ru', address: marker,
                });
            }

            // The shared spots collection accumulates 'active' (far-future
            // expiresAt) fixtures from many other suites across a full test
            // run — a small page size with a low iteration guard could give
            // up before reaching our 3 marker-tagged docs. Use a generous
            // page size (matches AR-7's usersList precedent) so the loop
            // reliably terminates in a handful of pages regardless of
            // collection size, while still proving no duplicate is ever seen.
            let cursor = null, done = false, guard = 0;
            const seen = new Set();
            while (!done && guard++ < 50) {
                const page = await callView(idToken, 'pingsList', { filter: 'active', limit: 200, cursor });
                expect(page.error).toBeUndefined();
                for (const p of page.result.pings) {
                    expect(seen.has(p.id)).toBe(false);
                    seen.add(p.id);
                }
                cursor = page.result.nextCursor;
                done = page.result.done;
            }
            expect(done).toBe(true);
            const ours = [...seen].filter(id => id.startsWith(marker));
            expect(ours.length).toBe(3);
        });
    });
});
