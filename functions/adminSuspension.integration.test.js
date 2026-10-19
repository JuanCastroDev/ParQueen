'use strict';

/**
 * F3 — server-authoritative suspension (adminSuspendUser / adminUnsuspendUser).
 *
 * Emulators required: functions (5001), firestore (8080), auth (9099).
 *
 *   SU-01  non-admin caller rejected; target Auth + docs untouched           (negative authz)
 *   SU-02  admin suspend: Auth disabled, refresh tokens revoked, public doc
 *          carries only status, who/why lives in private/moderation, audit   (positive authz)
 *   SU-03  suspended user can no longer sign in (USER_DISABLED)
 *   SU-04  RESIDUAL (documented, not a fix): an ID token minted BEFORE
 *          suspension is still accepted by sendMessage until it expires
 *          (≤1h) — this PR does not touch sendMessage (PRESERVE)
 *   SU-05  legacy user doc (no status field) suspends correctly; an
 *          unrelated user's Auth record and doc are untouched
 *   SU-06  unsuspend: Auth re-enabled, fresh sign-in works,
 *          public doc has no suspension fields (unsuspendedBy/At private)
 *   SU-07  legacy public suspension fields are scrubbed on suspend/unsuspend
 *   SU-08  admin cannot suspend themself (lockout guard)
 *   SU-09  target missing → not-found, no Auth/Firestore change
 *   SU-10  adminReadView usersList surfaces moderation fields (and legacy fallback)
 *   SU-11  stale/demoted admin token cannot unsuspend                        (negative authz)
 */

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const { requireEmulatorProjectId } = require('./emulatorProjectId');
const PROJECT_ID = requireEmulatorProjectId();
const FUNCTIONS_BASE = `http://localhost:5001/${PROJECT_ID}/us-central1`;
const AUTH_EMULATOR = 'http://localhost:9099';
const APP_NAME = '__adminSuspension_intg__';

const testApp = getApps().find(a => a.name === APP_NAME) ?? initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const adminAuth = getAuth(testApp);

const SUSPENSION_FIELDS = ['suspendedAt', 'suspendedBy', 'suspensionReason', 'unsuspendedAt', 'unsuspendedBy'];

async function callFn(name, idToken, data = {}) {
    const res = await fetch(`${FUNCTIONS_BASE}/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}) },
        body: JSON.stringify({ data }),
    });
    return res.json();
}

async function signInRaw(uid) {
    const customToken = await adminAuth.createCustomToken(uid);
    const res = await fetch(
        `${AUTH_EMULATOR}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-key`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: customToken, returnSecureToken: true }) },
    );
    return res.json();
}

async function signInUser(uid) {
    try { await adminAuth.createUser({ uid }); } catch { /* exists */ }
    const body = await signInRaw(uid);
    if (!body.idToken) throw new Error(`signIn failed: ${JSON.stringify(body)}`);
    return body.idToken;
}

async function adminToken(uid) {
    try { await adminAuth.createUser({ uid }); } catch { /* exists */ }
    await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
    return signInUser(uid);
}

const { _adminReadViewHandler } = require('./index.js');
const { HttpsError } = require('firebase-functions/v2/https');

async function callAdminReadViewHandler(idToken, data) {
    const payload = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
    const token = { ...payload, uid: payload.user_id || payload.sub };
    try {
        return { result: await _adminReadViewHandler({ auth: { uid: token.uid, token }, data }) };
    } catch (err) {
        if (err instanceof HttpsError) return { error: err.toJSON() };
        throw err;
    }
}

const uidOf = (l) => `su_${l}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
const sendProbe = (token) => callFn('sendMessage', token, {
    chatId: `nochat_${Date.now()}`, clientRequestId: `req_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, text: 'hi',
});

async function auditFor(target, action) {
    const snap = await db.collection('adminAuditLog').where('targetUserId', '==', target).get();
    return snap.docs.map(d => d.data()).filter(d => d.action === action);
}

describe('F3 — server-authoritative suspension', () => {
    let admin, target, cleanup;

    beforeEach(async () => {
        admin = uidOf('admin'); target = uidOf('target'); cleanup = [admin, target];
        await adminAuth.createUser({ uid: target });
        await db.doc(`users/${target}`).set({ id: target, username: 'tgt', status: 'Active' });
    });

    afterEach(async () => {
        for (const u of cleanup) {
            await adminAuth.deleteUser(u).catch(() => {});
            await db.recursiveDelete(db.doc(`users/${u}`)).catch(() => {});
            const logs = await db.collection('adminAuditLog').where('targetUserId', '==', u).get();
            await Promise.all(logs.docs.map(d => d.ref.delete()));
        }
    });

    it('SU-01: non-admin caller is rejected and the target is untouched', async () => {
        const caller = uidOf('plain'); cleanup.push(caller);
        const token = await signInUser(caller);
        const resp = await callFn('adminSuspendUser', token, { userId: target, reason: 'x' });
        expect(resp.error?.status).toBe('PERMISSION_DENIED');
        expect((await adminAuth.getUser(target)).disabled).toBe(false);
        expect((await db.doc(`users/${target}`).get()).data().status).toBe('Active');
        expect((await db.doc(`users/${target}/private/moderation`).get()).exists).toBe(false);
        const unauth = await callFn('adminSuspendUser', null, { userId: target, reason: 'x' });
        expect(unauth.error?.status).toBe('UNAUTHENTICATED');
    });

    it('SU-02: admin suspend disables Auth, revokes tokens, keeps who/why private, writes audit', async () => {
        const before = await adminAuth.getUser(target);
        await new Promise(r => setTimeout(r, 1100)); // tokensValidAfterTime has 1s resolution
        const token = await adminToken(admin);
        const resp = await callFn('adminSuspendUser', token, { userId: target, reason: '  spam  ' });
        expect(resp.error).toBeUndefined();
        expect(resp.result?.success).toBe(true);

        const after = await adminAuth.getUser(target);
        expect(after.disabled).toBe(true);
        // revokeRefreshTokens sets tokensValidAfterTime to "now" (it may be unset before).
        expect(after.tokensValidAfterTime).toBeTruthy();
        if (before.tokensValidAfterTime) {
            expect(Date.parse(after.tokensValidAfterTime)).toBeGreaterThan(Date.parse(before.tokensValidAfterTime));
        }
        expect(Date.now() - Date.parse(after.tokensValidAfterTime)).toBeLessThan(60_000);

        const pub = (await db.doc(`users/${target}`).get()).data();
        expect(pub.status).toBe('Suspended');
        for (const f of SUSPENSION_FIELDS) expect(pub).not.toHaveProperty(f);
        expect(JSON.stringify(pub)).not.toContain(admin);
        expect(JSON.stringify(pub)).not.toContain('spam');

        const mod = (await db.doc(`users/${target}/private/moderation`).get()).data();
        expect(mod).toMatchObject({ status: 'Suspended', suspendedBy: admin, suspensionReason: 'spam',
            unsuspendedAt: null, unsuspendedBy: null });
        expect(mod.suspendedAt).toBeInstanceOf(Timestamp);

        const audit = await auditFor(target, 'user.suspend');
        expect(audit).toHaveLength(1);
        expect(audit[0]).toMatchObject({ adminId: admin, reason: 'spam', targetType: 'user' });
    });

    it('SU-03: a suspended user can no longer sign in', async () => {
        const token = await adminToken(admin);
        expect((await callFn('adminSuspendUser', token, { userId: target, reason: 'x' })).result?.success).toBe(true);
        const body = await signInRaw(target);
        expect(body.idToken).toBeUndefined();
        expect(String(body.error?.message || '')).toMatch(/USER_DISABLED/);
    });

    it('SU-04: RESIDUAL — an ID token minted before suspension is still accepted by sendMessage (no suspension gate in this PR)', async () => {
        // Documents the known residual (PR body "Residual risk"): this PR does
        // not edit sendMessage, so an already-issued ID token keeps working on
        // it (and on other callables / Firestore) until it expires (≤1h).
        // The probe gets past auth and fails at chat lookup (NOT_FOUND), i.e.
        // it is NOT refused for suspension. If a future reviewed change adds a
        // callable-side gate, flip this expectation to PERMISSION_DENIED.
        const userToken = await signInUser(target);
        expect((await sendProbe(userToken)).error?.status).toBe('NOT_FOUND');
        const token = await adminToken(admin);
        expect((await callFn('adminSuspendUser', token, { userId: target, reason: 'x' })).result?.success).toBe(true);
        expect((await adminAuth.getUser(target)).disabled).toBe(true);
        const resp = await sendProbe(userToken);
        expect(resp.error?.status).toBe('NOT_FOUND');
    });

    it('SU-05: a legacy user doc with no status field suspends correctly; an unrelated user is untouched', async () => {
        const legacy = uidOf('legacy'); const bystander = uidOf('bystander'); cleanup.push(legacy, bystander);
        await adminAuth.createUser({ uid: legacy });
        await adminAuth.createUser({ uid: bystander });
        await db.doc(`users/${legacy}`).set({ id: legacy, username: 'old' }); // no status
        await db.doc(`users/${bystander}`).set({ id: bystander, username: 'by', status: 'Active' });
        const token = await adminToken(admin);
        expect((await callFn('adminSuspendUser', token, { userId: legacy, reason: 'x' })).result?.success).toBe(true);
        expect((await adminAuth.getUser(legacy)).disabled).toBe(true);
        expect((await db.doc(`users/${legacy}`).get()).data()).toMatchObject({ status: 'Suspended', username: 'old' });
        expect((await adminAuth.getUser(bystander)).disabled).toBe(false);
        expect((await db.doc(`users/${bystander}`).get()).data().status).toBe('Active');
        expect((await db.doc(`users/${bystander}/private/moderation`).get()).exists).toBe(false);
    });

    it('SU-06: unsuspend re-enables Auth and keeps unsuspendedBy/At private', async () => {
        const token = await adminToken(admin);
        expect((await callFn('adminSuspendUser', token, { userId: target, reason: 'x' })).result?.success).toBe(true);
        const resp = await callFn('adminUnsuspendUser', token, { userId: target });
        expect(resp.error).toBeUndefined();
        expect((await adminAuth.getUser(target)).disabled).toBe(false);

        const pub = (await db.doc(`users/${target}`).get()).data();
        expect(pub.status).toBe('Active');
        for (const f of SUSPENSION_FIELDS) expect(pub).not.toHaveProperty(f);
        expect(JSON.stringify(pub)).not.toContain(admin);

        const mod = (await db.doc(`users/${target}/private/moderation`).get()).data();
        expect(mod).toMatchObject({ status: 'Active', unsuspendedBy: admin, suspendedBy: null, suspensionReason: null });
        expect(mod.unsuspendedAt).toBeInstanceOf(Timestamp);
        expect(await auditFor(target, 'user.unsuspend')).toHaveLength(1);

        // Fresh sign-in works again after re-enable.
        const body = await signInRaw(target);
        expect(body.idToken).toBeTruthy();
        expect(body.error).toBeUndefined();
    });

    it('SU-07: legacy public suspension fields are scrubbed', async () => {
        await db.doc(`users/${target}`).set({
            id: target, status: 'Suspended', suspendedAt: Timestamp.now(), suspendedBy: 'old-admin-uid',
            suspensionReason: 'legacy reason', unsuspendedAt: null, unsuspendedBy: 'older-admin-uid',
        });
        const token = await adminToken(admin);
        expect((await callFn('adminUnsuspendUser', token, { userId: target })).result?.success).toBe(true);
        const pub = (await db.doc(`users/${target}`).get()).data();
        for (const f of SUSPENSION_FIELDS) expect(pub).not.toHaveProperty(f);
        expect(JSON.stringify(pub)).not.toMatch(/old-admin-uid|older-admin-uid|legacy reason/);
    });

    it('SU-08: an admin cannot suspend themself', async () => {
        const token = await adminToken(admin);
        await db.doc(`users/${admin}`).set({ id: admin, status: 'Active' });
        const resp = await callFn('adminSuspendUser', token, { userId: admin, reason: 'x' });
        expect(resp.error?.status).toBe('FAILED_PRECONDITION');
        expect((await adminAuth.getUser(admin)).disabled).toBe(false);
    });

    it('SU-09: missing target → NOT_FOUND with no Auth or Firestore change', async () => {
        const token = await adminToken(admin);
        const ghost = uidOf('ghost'); cleanup.push(ghost);
        const r1 = await callFn('adminSuspendUser', token, { userId: ghost, reason: 'x' });
        expect(r1.error?.status).toBe('NOT_FOUND');
        expect((await db.doc(`users/${ghost}`).get()).exists).toBe(false);
        // Firestore doc exists but Auth user does not → fail closed before any write.
        await db.doc(`users/${ghost}`).set({ id: ghost, status: 'Active' });
        const r2 = await callFn('adminSuspendUser', token, { userId: ghost, reason: 'x' });
        expect(r2.error?.status).toBe('NOT_FOUND');
        expect((await db.doc(`users/${ghost}`).get()).data().status).toBe('Active');
        expect((await db.doc(`users/${ghost}/private/moderation`).get()).exists).toBe(false);
        expect(await auditFor(ghost, 'user.suspend')).toHaveLength(0);
    });

    it('SU-10: adminReadView usersList surfaces moderation fields, with legacy fallback', async () => {
        const token = await adminToken(admin);
        expect((await callFn('adminSuspendUser', token, { userId: target, reason: 'abuse' })).result?.success).toBe(true);
        const legacy = uidOf('legacy'); cleanup.push(legacy);
        await db.doc(`users/${legacy}`).set({ id: legacy, status: 'Suspended', suspendedBy: 'old-admin', suspensionReason: 'old' });
        const found = {};
        let cursor = null, done = false, guard = 0;
        while (!done && guard++ < 50) {
            // adminReadView is enforceAppCheck:true, so (as in adminReadViews.integration
            // AR-*) drive the production handler directly with the real emulator token.
            const r = await callAdminReadViewHandler(token, { view: 'usersList', params: { cursor, limit: 200 } });
            expect(r.error).toBeUndefined();
            for (const u of r.result.users) if (u.id === target || u.id === legacy) found[u.id] = u;
            cursor = r.result.nextCursor; done = r.result.done;
        }
        expect(found[target]).toMatchObject({ status: 'Suspended', suspendedBy: admin, suspensionReason: 'abuse' });
        expect(found[legacy]).toMatchObject({ status: 'Suspended', suspendedBy: 'old-admin', suspensionReason: 'old' });
    });

    it('SU-11: a demoted admin token cannot unsuspend', async () => {
        const token = await adminToken(admin);
        expect((await callFn('adminSuspendUser', token, { userId: target, reason: 'x' })).result?.success).toBe(true);
        await adminAuth.setCustomUserClaims(admin, { role: 'staff' });
        const resp = await callFn('adminUnsuspendUser', token, { userId: target });
        expect(resp.error?.status).toBe('PERMISSION_DENIED');
        expect((await adminAuth.getUser(target)).disabled).toBe(true);
        expect((await db.doc(`users/${target}`).get()).data().status).toBe('Suspended');
    });
});
