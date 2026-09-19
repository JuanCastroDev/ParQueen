'use strict';

/**
 * Behavioral integration tests — reconcileLegacyAdminSingleton callable.
 *
 * Context: a real production administrator was granted role === 'admin' via an
 * out-of-band mechanism that predates bootstrapAdmin/adminBootstrap entirely, so
 * adminBootstrap/singleton was never created for them. While the singleton is
 * missing, bootstrapAdmin's own singleton-only gate means ANY other authenticated
 * @parqueen.app account with a verified email could self-promote to admin —
 * reconcileLegacyAdminSingleton exists to close that drift without ever touching
 * the existing admin's claim or granting admin to anyone.
 *
 * What is proven:
 *   RA-1:  reconciling, then bootstrapAdmin from a third party, closes the exposure end-to-end
 *   RA-2:  existing admin + no singleton reconciles successfully
 *   RA-3:  existing admin's own role claim is left untouched
 *   RA-4:  unrelated custom claims survive reconciliation
 *   RA-5:  exactly one singleton document is created, correctly owned
 *   RA-6:  exactly one audit record, tagged as reconciliation — never 'bootstrapAdmin'
 *   RA-7:  retry by the same admin is idempotent (no duplicate singleton/audit doc)
 *   RA-8:  concurrent reconciliation attempts by the same admin produce one result
 *   RA-9:  a non-admin eligible @parqueen.app caller cannot claim legacy ownership
 *   RA-10: two existing admin-role accounts makes ownership ambiguous — fails closed
 *   RA-11: zero existing admins — normal bootstrapAdmin behavior is unaffected
 *   RA-12: singleton already claimed by someone else — reconcile is rejected, unchanged
 *   RA-13: partial-failure recovery (singleton committed, audit missing) is safe to retry
 *   RA-16: no raw identity (email/uid) is ever written to console output
 *
 * RA-14/RA-15 (existing bootstrapAdmin suite unaffected / setStaffRole unaffected) are
 * verified by the full functions-gate run, not as cases in this file.
 */

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

let bootstrapAdmin, reconcileLegacyAdminSingleton;
try {
    ({ bootstrapAdmin, reconcileLegacyAdminSingleton } = require('./index.js'));
} catch (e) {
    console.warn('[reconcileLegacyAdminSingleton.integration] Could not load index.js:', e.message);
}

const { requireEmulatorProjectId } = require('./emulatorProjectId');
const PROJECT_ID = requireEmulatorProjectId();
const APP_NAME = '__reconcileLegacyAdmin_intg__';

const testApp =
    getApps().find(a => a.name === APP_NAME) ??
    initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const adminAuth = getAuth(testApp);

// ─── Helpers ─────────────────────────────────────────────────────────────

function fakeRequest(uid, role, data = {}) {
    const NOW = Math.floor(Date.now() / 1000);
    return {
        data,
        auth: uid ? {
            uid,
            token: {
                uid,
                role: role || undefined,
                auth_time: NOW - 30,
                iat: NOW - 30,
                exp: NOW + 3600,
            },
        } : null,
        rawRequest: {},
    };
}

async function callReconcile(uid, role) {
    if (!reconcileLegacyAdminSingleton) throw new Error('reconcileLegacyAdminSingleton not loaded');
    try {
        return { result: await reconcileLegacyAdminSingleton.run(fakeRequest(uid, role)) };
    } catch (err) {
        return { error: { code: err.code, message: err.message } };
    }
}

async function callBootstrap(uid, email, emailVerified) {
    if (!bootstrapAdmin) throw new Error('bootstrapAdmin not loaded');
    const NOW = Math.floor(Date.now() / 1000);
    const req = {
        data: {},
        auth: { uid, token: { uid, email, email_verified: emailVerified, auth_time: NOW - 30, iat: NOW - 30, exp: NOW + 3600 } },
        rawRequest: {},
    };
    try {
        return { result: await bootstrapAdmin.run(req) };
    } catch (err) {
        return { error: { code: err.code, message: err.message } };
    }
}

function testUid() {
    return `ra_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

async function deleteSingleton() {
    await db.doc('adminBootstrap/singleton').delete().catch(() => {});
}

async function deleteAuditLogsFor(uid) {
    const snap = await db.collection('adminAuditLog').where('adminUid', '==', uid).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
}

async function nukeUser(uid) {
    await adminAuth.deleteUser(uid).catch(() => {});
}

// This suite's exactness assumptions (e.g. RA-10's "exactly two admins") only hold if
// no stray admin-claimed user from another concurrently-loaded test file's incomplete
// cleanup is left in the shared Auth emulator. maxWorkers: 1 makes file execution
// serial, so this is safe to run once per test and not a race with other suites.
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

// ─── Tests ───────────────────────────────────────────────────────────────

describe('reconcileLegacyAdminSingleton — emulator behavioral tests', () => {
    let uid;

    beforeEach(async () => {
        uid = testUid();
        await deleteSingleton();
        await wipeAllStrayAdmins();
    });

    afterEach(async () => {
        await deleteSingleton();
        await deleteAuditLogsFor(uid);
        await nukeUser(uid);
    });

    it('RA-1: reconciling the existing admin, then a third party calling bootstrapAdmin, is rejected end-to-end', async () => {
        if (!reconcileLegacyAdminSingleton || !bootstrapAdmin) return;
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });

        const { result, error } = await callReconcile(uid, 'admin');
        expect(error).toBeUndefined();
        expect(result.success).toBe(true);

        const thirdParty = testUid();
        await adminAuth.createUser({ uid: thirdParty }).catch(() => {});
        const attempt = await callBootstrap(thirdParty, 'someone-else@parqueen.app', true);
        expect(attempt.error?.code).toBe('already-exists');

        const thirdPartyUser = await adminAuth.getUser(thirdParty);
        expect(thirdPartyUser.customClaims?.role).not.toBe('admin');

        await nukeUser(thirdParty);
    });

    it('RA-2: existing admin with no singleton reconciles successfully', async () => {
        if (!reconcileLegacyAdminSingleton) return;
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });

        const { result, error } = await callReconcile(uid, 'admin');
        expect(error).toBeUndefined();
        expect(result.success).toBe(true);

        const singleton = await db.doc('adminBootstrap/singleton').get();
        expect(singleton.exists).toBe(true);
        expect(singleton.data().bootstrappedBy).toBe(uid);
        expect(singleton.data().reconciledLegacyAdmin).toBe(true);
    });

    it('RA-3: the existing admin role claim is left untouched by reconciliation', async () => {
        if (!reconcileLegacyAdminSingleton) return;
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        const before = await adminAuth.getUser(uid);

        const { error } = await callReconcile(uid, 'admin');
        expect(error).toBeUndefined();

        const after = await adminAuth.getUser(uid);
        expect(after.customClaims?.role).toBe('admin');
        expect(after.customClaims).toEqual(before.customClaims);
    });

    it('RA-4: unrelated custom claims survive reconciliation', async () => {
        if (!reconcileLegacyAdminSingleton) return;
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin', betaTester: true });

        const { error } = await callReconcile(uid, 'admin');
        expect(error).toBeUndefined();

        const user = await adminAuth.getUser(uid);
        expect(user.customClaims?.role).toBe('admin');
        expect(user.customClaims?.betaTester).toBe(true);
    });

    it('RA-5: exactly one singleton document is created, owned by the reconciling admin', async () => {
        if (!reconcileLegacyAdminSingleton) return;
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });

        await callReconcile(uid, 'admin');

        const singleton = await db.doc('adminBootstrap/singleton').get();
        expect(singleton.exists).toBe(true);
        expect(singleton.data().bootstrappedBy).toBe(uid);
        expect(typeof singleton.data().bootstrappedAt).not.toBe('undefined');
    });

    it('RA-6: exactly one audit record is created, tagged as reconciliation — never bootstrapAdmin', async () => {
        if (!reconcileLegacyAdminSingleton) return;
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });

        await callReconcile(uid, 'admin');

        const snap = await db.collection('adminAuditLog').where('adminUid', '==', uid).get();
        expect(snap.size).toBe(1);
        expect(snap.docs[0].data().action).toBe('legacy_admin_bootstrap_reconciliation');
        expect(snap.docs[0].data().action).not.toBe('bootstrapAdmin');
        expect(snap.docs[0].id).toBe(`legacyReconciliation_${uid}`);
    });

    it('RA-7: retry by the same admin is idempotent — no duplicate singleton or audit record', async () => {
        if (!reconcileLegacyAdminSingleton) return;
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });

        const first = await callReconcile(uid, 'admin');
        expect(first.result.success).toBe(true);
        const second = await callReconcile(uid, 'admin');
        expect(second.error).toBeUndefined();
        expect(second.result.success).toBe(true);

        const snap = await db.collection('adminAuditLog').where('adminUid', '==', uid).get();
        expect(snap.size).toBe(1);
    });

    it('RA-8: concurrent reconciliation attempts by the same admin produce exactly one result', async () => {
        if (!reconcileLegacyAdminSingleton) return;
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });

        const [a, b] = await Promise.all([
            callReconcile(uid, 'admin'),
            callReconcile(uid, 'admin'),
        ]);
        expect(a.error).toBeUndefined();
        expect(b.error).toBeUndefined();
        expect(a.result.success).toBe(true);
        expect(b.result.success).toBe(true);

        const snap = await db.collection('adminAuditLog').where('adminUid', '==', uid).get();
        expect(snap.size).toBe(1);
    });

    it('RA-9: a non-admin eligible @parqueen.app caller cannot claim legacy ownership', async () => {
        if (!reconcileLegacyAdminSingleton) return;
        // uid is a normal signed-in @parqueen.app account with no role claim at all —
        // exactly the profile of an account that could exploit bootstrapAdmin's own gap.
        await adminAuth.createUser({ uid }).catch(() => {});

        const { error } = await callReconcile(uid, undefined);
        expect(error.code).toBe('permission-denied');

        const singleton = await db.doc('adminBootstrap/singleton').get();
        expect(singleton.exists).toBe(false);
    });

    it('RA-10: two existing admin-role accounts makes ownership ambiguous and fails closed', async () => {
        if (!reconcileLegacyAdminSingleton) return;
        const uidB = testUid();
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.createUser({ uid: uidB }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        await adminAuth.setCustomUserClaims(uidB, { role: 'admin' });

        const { error } = await callReconcile(uid, 'admin');
        expect(error.code).toBe('failed-precondition');

        const singleton = await db.doc('adminBootstrap/singleton').get();
        expect(singleton.exists).toBe(false);

        await nukeUser(uidB);
    });

    it('RA-11: zero existing admins leaves bootstrapAdmin behaving exactly as before', async () => {
        if (!bootstrapAdmin) return;
        await adminAuth.createUser({ uid }).catch(() => {});
        const { result, error } = await callBootstrap(uid, 'jay@parqueen.app', true);
        expect(error).toBeUndefined();
        expect(result.success).toBe(true);
        const user = await adminAuth.getUser(uid);
        expect(user.customClaims?.role).toBe('admin');
    });

    it('RA-12: singleton already claimed by someone else — reconcile is rejected and state is unchanged', async () => {
        if (!reconcileLegacyAdminSingleton) return;
        const otherUid = testUid();
        await db.doc('adminBootstrap/singleton').set({
            bootstrappedAt: Timestamp.now(),
            bootstrappedBy: otherUid,
        });
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });

        const { error } = await callReconcile(uid, 'admin');
        expect(error.code).toBe('already-exists');

        const singleton = await db.doc('adminBootstrap/singleton').get();
        expect(singleton.data().bootstrappedBy).toBe(otherUid);
    });

    it('RA-13: partial-failure recovery — singleton committed but audit record missing is safe to retry', async () => {
        if (!reconcileLegacyAdminSingleton) return;
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        // Simulate a prior invocation that won the singleton transaction but crashed
        // before the audit write below it — the retry must not error or re-scan-fail.
        await db.doc('adminBootstrap/singleton').set({
            bootstrappedAt: Timestamp.now(),
            bootstrappedBy: uid,
            reconciledLegacyAdmin: true,
        });
        const preSnap = await db.collection('adminAuditLog').where('adminUid', '==', uid).get();
        expect(preSnap.empty).toBe(true);

        const { result, error } = await callReconcile(uid, 'admin');
        expect(error).toBeUndefined();
        expect(result.success).toBe(true);

        const snap = await db.collection('adminAuditLog').where('adminUid', '==', uid).get();
        expect(snap.size).toBe(1);
        expect(snap.docs[0].data().action).toBe('legacy_admin_bootstrap_reconciliation');
    });

    it('RA-16: no raw identity is ever written to console output', async () => {
        if (!reconcileLegacyAdminSingleton) return;
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });

        const originalLog = console.log;
        const originalError = console.error;
        const captured = [];
        console.log = (...args) => captured.push(args.join(' '));
        console.error = (...args) => captured.push(args.join(' '));
        try {
            await callReconcile(uid, 'admin');
            await callReconcile('not-a-real-uid-eligible-check', undefined);
        } finally {
            console.log = originalLog;
            console.error = originalError;
        }

        const joined = captured.join('\n');
        expect(joined).not.toMatch(/@parqueen\.app/);
        expect(joined.includes(uid)).toBe(false);
    });

    it('RA-14: unauthenticated caller is rejected', async () => {
        if (!reconcileLegacyAdminSingleton) return;
        const { error } = await callReconcile(null, undefined);
        expect(error.code).toBe('unauthenticated');
    });

    it('RA-15: caller token claims admin but Auth-wide truth has zero admins — fails closed', async () => {
        if (!reconcileLegacyAdminSingleton) return;
        // The token is the only place asserting 'admin' here (e.g. stale/forged) —
        // Auth-side reality (no customClaims set) must be what actually decides.
        // Now migrated to requireCurrentAdmin (true-revocation hardening pass):
        // the fresh current-role check catches this BEFORE the function's own
        // exhaustive listUsers scan is ever reached, so the error is
        // permission-denied (requireCurrentAdmin) rather than
        // failed-precondition (the function's own ambiguity check) — both are
        // fail-closed, but requireCurrentAdmin is now the earlier, more
        // general gate that fires first.
        await adminAuth.createUser({ uid }).catch(() => {});

        const { error } = await callReconcile(uid, 'admin');
        expect(error.code).toBe('permission-denied');

        const singleton = await db.doc('adminBootstrap/singleton').get();
        expect(singleton.exists).toBe(false);
    });

    it('RA-17: exactly one existing admin exists but it is not the caller — fails closed', async () => {
        if (!reconcileLegacyAdminSingleton) return;
        const realAdminUid = testUid();
        await adminAuth.createUser({ uid: realAdminUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(realAdminUid, { role: 'admin' });
        await adminAuth.createUser({ uid }).catch(() => {});

        // Now migrated to requireCurrentAdmin: uid's own current role isn't
        // admin, so requireCurrentAdmin rejects before the function's own
        // exhaustive scan (which would have separately rejected with
        // failed-precondition) is ever reached. See RA-15.
        const { error } = await callReconcile(uid, 'admin');
        expect(error.code).toBe('permission-denied');

        const singleton = await db.doc('adminBootstrap/singleton').get();
        expect(singleton.exists).toBe(false);

        await nukeUser(realAdminUid);
    });

    it('RA-18: pagination exhaustively scans beyond the first page and detects a second admin', async () => {
        if (!reconcileLegacyAdminSingleton) return;
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });

        // Seed just over one listUsers page (1000) of ordinary users via bulk import,
        // plus one extra admin-claimed account, so the second admin is only found if
        // the pagination loop actually follows pageToken past the first page.
        const extraAdminUid = testUid();
        const bulkUsers = [];
        for (let i = 0; i < 1005; i++) {
            bulkUsers.push({ uid: `ra_bulk_${Date.now()}_${i}` });
        }
        bulkUsers.push({ uid: extraAdminUid, customClaims: { role: 'admin' } });
        for (let i = 0; i < bulkUsers.length; i += 1000) {
            await adminAuth.importUsers(bulkUsers.slice(i, i + 1000));
        }

        try {
            const { error } = await callReconcile(uid, 'admin');
            expect(error.code).toBe('failed-precondition');

            const singleton = await db.doc('adminBootstrap/singleton').get();
            expect(singleton.exists).toBe(false);
        } finally {
            const uidsToDelete = bulkUsers.map(u => u.uid);
            for (let i = 0; i < uidsToDelete.length; i += 1000) {
                await adminAuth.deleteUsers(uidsToDelete.slice(i, i + 1000)).catch(() => {});
            }
        }
    }, 60000);

    it('RA-19: a malformed singleton document fails closed rather than being overwritten', async () => {
        if (!reconcileLegacyAdminSingleton) return;
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        // Malformed: exists, but missing bootstrappedBy entirely — must never be
        // treated as "ours" or silently replaced.
        await db.doc('adminBootstrap/singleton').set({ note: 'unexpected shape' });

        const { error } = await callReconcile(uid, 'admin');
        expect(error.code).toBe('already-exists');

        const singleton = await db.doc('adminBootstrap/singleton').get();
        expect(singleton.data()).toEqual({ note: 'unexpected shape' });
    });

    it('RA-20: concurrent calls from two different admin-role accounts cannot take ownership while ambiguous', async () => {
        if (!reconcileLegacyAdminSingleton) return;
        const uidB = testUid();
        await adminAuth.createUser({ uid }).catch(() => {});
        await adminAuth.createUser({ uid: uidB }).catch(() => {});
        await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
        await adminAuth.setCustomUserClaims(uidB, { role: 'admin' });

        const [a, b] = await Promise.all([
            callReconcile(uid, 'admin'),
            callReconcile(uidB, 'admin'),
        ]);
        expect(a.error?.code).toBe('failed-precondition');
        expect(b.error?.code).toBe('failed-precondition');

        const singleton = await db.doc('adminBootstrap/singleton').get();
        expect(singleton.exists).toBe(false);

        await nukeUser(uidB);
    });
});
