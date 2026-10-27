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

/**
 * S7 — error-path / partial-outcome regression tests (failure injection).
 *
 * Drives the production adminSuspendUser / adminUnsuspendUser callables
 * in-process via `.run()` (same convention as adminAuth.revocation RV-*),
 * so the default-app Auth / Firestore instances that functions/index.js
 * uses can be stubbed to throw at one exact step. Stubs are restored after
 * every test. Emulators only.
 *
 *   EP-G   admin gate first: non-admin and demoted-admin callers get
 *          permission-denied before any Auth/Firestore mutation step runs
 *   EP-S0  suspend happy path unchanged ({success:true}; one plain 'user.suspend')
 *   EP-S1  disable fails          → "Nothing was changed" (true); no mutation; retry converges
 *   EP-S2  revoke fails           → 'aborted' partial; disabled + recorded Suspended;
 *                                   'user.suspend.partial' in the batch; retry → exactly one 'user.suspend'
 *   EP-S3  record batch fails     → 'aborted' partial; disabled + revoked, not recorded;
 *                                   standalone 'user.suspend.partial'; retry converges
 *   EP-S4  revoke + record fail   → as S3 with revoked:false; retry converges
 *   EP-S5  record + partial audit fail → auditWritten:false + one structured log line; retry converges
 *   EP-U0  unsuspend happy path: status batch (pending audit) commits BEFORE
 *          Auth enable; exactly one completed 'user.unsuspend' after enable
 *   EP-U1  Auth lookup fails / Auth user missing → nothing changed, no write
 *   EP-U2  record batch fails     → "Nothing was changed" (true); enable never attempted;
 *                                   no completed success audit; retry converges
 *   EP-U3  enable fails           → 'aborted' partial; recorded Active, still CANNOT sign in;
 *                                   zero completed 'user.unsuspend'; pending + partial evidence;
 *                                   retry writes exactly one completion
 *   EP-U4  enable + partial-audit fail → auditWritten:false; zero completions; retry writes one
 *   EP-U5  enable succeeds, completion-audit write fails → Auth stays enabled, no completed
 *          'user.unsuspend', no rollback; retry writes exactly one completion
 * Every injected row asserts the S7 invariant: never (Auth enabled AND recorded Suspended).
 * A completed 'user.unsuspend' row exists only after enable returns and that audit write lands.
 */
const { adminSuspendUser, adminUnsuspendUser } = require('./index.js');

describe('S7 — suspension error paths (failure injection)', () => {
    const fnAuth = getAuth();          // default app: the instance functions/index.js uses
    const fnDb = getFirestore();       // default app: the instance functions/index.js uses
    const restore = [];
    let admin, target, cleanup;

    const nowSec = () => Math.floor(Date.now() / 1000);
    const reqAs = (uid, role, data) => ({
        data,
        auth: { uid, token: { uid, ...(role ? { role } : {}), auth_time: nowSec(), iat: nowSec(), exp: nowSec() + 3600 } },
        rawRequest: {},
    });
    const req = (data) => reqAs(admin, 'admin', data);
    const injected = (label) => Object.assign(new Error(`injected failure: ${label}`), { code: 'auth/internal-error' });

    function stub(obj, key, impl) {
        const orig = obj[key];
        obj[key] = impl(orig.bind(obj));
        restore.push(() => { obj[key] = orig; });
    }
    const unstubAll = () => { while (restore.length) restore.pop()(); };
    const failAuth = (method, onlyUid) => stub(fnAuth, method, (orig) => async (uid, ...rest) => {
        if (onlyUid && uid !== onlyUid) return orig(uid, ...rest);
        throw injected(method);
    });
    const failBatchCommit = () => stub(fnDb, 'batch', (orig) => () => {
        const b = orig();
        b.commit = async () => { throw Object.assign(new Error('injected failure: batch.commit'), { code: 14 }); };
        return b;
    });
    const failAuditDocSet = () => stub(fnDb, 'collection', (orig) => (p) => {
        const c = orig(p);
        if (p !== 'adminAuditLog') return c;
        const origDoc = c.doc.bind(c);
        c.doc = (...a) => {
            const d = origDoc(...a);
            d.set = async () => { throw Object.assign(new Error('injected failure: audit set'), { code: 14 }); };
            return d;
        };
        return c;
    });
    function captureConsoleError() {
        const logged = [];
        const orig = console.error;
        console.error = (...a) => { logged.push(a); };
        restore.push(() => { console.error = orig; });
        return logged;
    }

    async function runCall(fn, data, request) {
        try { return { result: await fn.run(request || req(data)) }; } catch (err) { return { error: err }; }
    }
    async function state(uid = target) {
        const user = await adminAuth.getUser(uid);
        const pub = (await db.doc(`users/${uid}`).get()).data();
        const modSnap = await db.doc(`users/${uid}/private/moderation`).get();
        const logs = (await db.collection('adminAuditLog').where('targetUserId', '==', uid).get()).docs.map(d => d.data());
        return { disabled: user.disabled, tokensValidAfterTime: user.tokensValidAfterTime, status: pub?.status,
            mod: modSnap.exists ? modSnap.data() : null, logs };
    }
    const count = (s, action) => s.logs.filter(l => l.action === action).length;
    function expectInvariant(s) {
        expect(!s.disabled && s.status === 'Suspended').toBe(false);
    }
    async function expectCannotSignIn(uid = target) {
        const body = await signInRaw(uid);
        expect(body.idToken).toBeUndefined();
        expect(String(body.error?.message || '')).toMatch(/USER_DISABLED/);
    }
    function expectNoPiiOrRaw(err) {
        const blob = JSON.stringify({ m: err.message, d: err.details });
        expect(blob).not.toMatch(/injected failure|@|tgt|spam/); // no upstream text, email, username or reason
        expect(blob).not.toContain(target);
    }
    const actions = (s) => s.logs.map(l => l.action).sort();
    const PARTIAL_KEYS = ['outcome', 'failedStep', 'errorCode', 'authDisabled', 'revoked', 'recordWritten', 'revokeErrorCode'];
    const SUSPEND_AUDIT_KEYS = ['action', 'adminId', 'createdAt', 'reason', 'targetId', 'targetType', 'targetUserId'];

    beforeEach(async () => {
        admin = uidOf('epadmin'); target = uidOf('eptarget'); cleanup = [admin, target];
        await adminAuth.createUser({ uid: admin });
        await adminAuth.setCustomUserClaims(admin, { role: 'admin' });
        await adminAuth.createUser({ uid: target });
        await db.doc(`users/${target}`).set({ id: target, username: 'tgt', status: 'Active' });
    });

    afterEach(async () => {
        unstubAll();
        for (const u of cleanup) {
            await adminAuth.deleteUser(u).catch(() => {});
            await db.recursiveDelete(db.doc(`users/${u}`)).catch(() => {});
            const logs = await db.collection('adminAuditLog').where('targetUserId', '==', u).get();
            await Promise.all(logs.docs.map(d => d.ref.delete()));
        }
    });

    // ── admin gate ──────────────────────────────────────────────────────────

    it('EP-G: non-admin and demoted-admin callers are rejected before any mutation step runs', async () => {
        await adminAuth.updateUser(target, { disabled: true });
        await db.doc(`users/${target}`).update({ status: 'Suspended' });
        const calls = [];
        stub(fnAuth, 'updateUser', () => async () => { calls.push('updateUser'); throw injected('updateUser'); });
        stub(fnAuth, 'revokeRefreshTokens', () => async () => { calls.push('revoke'); throw injected('revoke'); });
        stub(fnDb, 'batch', () => () => { calls.push('batch'); throw new Error('injected failure: batch'); });

        const plain = uidOf('epplain'); cleanup.push(plain);
        await adminAuth.createUser({ uid: plain });
        const demoted = uidOf('epdemoted'); cleanup.push(demoted);
        await adminAuth.createUser({ uid: demoted }); // current claims: none; presented token still says admin
        const callers = [reqAs(plain, null, {}), reqAs(plain, 'admin', {}), reqAs(demoted, 'admin', {})];
        for (const base of callers) {
            const s1 = await runCall(adminSuspendUser, null, { ...base, data: { userId: target, reason: 'x' } });
            expect(s1.error?.code).toBe('permission-denied');
            const u1 = await runCall(adminUnsuspendUser, null, { ...base, data: { userId: target } });
            expect(u1.error?.code).toBe('permission-denied');
        }
        expect(calls).toEqual([]);
        const s = await state();
        expect(s).toMatchObject({ disabled: true, status: 'Suspended', mod: null });
        expect(s.logs).toHaveLength(0);
    });

    // ── adminSuspendUser ────────────────────────────────────────────────────

    it('EP-S0: suspend happy path is unchanged (in-process): {success:true}, one plain user.suspend audit entry', async () => {
        const r = await runCall(adminSuspendUser, { userId: target, reason: ' spam ' });
        expect(r.error).toBeUndefined();
        expect(r.result).toEqual({ success: true });
        const s = await state();
        expect(s).toMatchObject({ disabled: true, status: 'Suspended' });
        expect(s.tokensValidAfterTime).toBeTruthy();
        expect(s.mod).toMatchObject({ status: 'Suspended', suspendedBy: admin, suspensionReason: 'spam' });
        expect(actions(s)).toEqual(['user.suspend']);
        expect(Object.keys(s.logs[0]).sort()).toEqual(SUSPEND_AUDIT_KEYS);
    });

    it('EP-S1: disable fails → "Nothing was changed" is true: no mutation, no audit; retry converges', async () => {
        failAuth('updateUser');
        const logged = captureConsoleError();
        const r = await runCall(adminSuspendUser, { userId: target, reason: 'spam' });
        expect(r.error?.code).toBe('internal');
        expect(r.error?.message).toMatch(/Nothing was changed/);
        expect(logged).toHaveLength(1);
        let s = await state();
        expect(s).toMatchObject({ disabled: false, status: 'Active', mod: null });
        expect(s.tokensValidAfterTime).toBeFalsy();
        expect(s.logs).toHaveLength(0);
        expectInvariant(s);

        unstubAll();
        expect((await runCall(adminSuspendUser, { userId: target, reason: 'spam' })).result).toEqual({ success: true });
        s = await state();
        expect(s).toMatchObject({ disabled: true, status: 'Suspended' });
        expect(actions(s)).toEqual(['user.suspend']);
    });

    it('EP-S2: revoke fails → partial (aborted), disabled AND recorded Suspended, user.suspend.partial; retry → exactly one user.suspend', async () => {
        failAuth('revokeRefreshTokens');
        const logged = captureConsoleError();
        const r = await runCall(adminSuspendUser, { userId: target, reason: 'spam' });
        expect(r.error?.code).toBe('aborted');
        expect(r.error?.message).not.toMatch(/Nothing was changed/);
        expect(r.error?.message).toMatch(/disabled and recorded as Suspended, but revoking its existing sessions failed/);
        expect(r.error?.details).toEqual({ partial: true, authDisabled: true, revoked: false, recordWritten: true, auditWritten: true });
        expectNoPiiOrRaw(r.error);
        expect(logged).toHaveLength(1);
        expect(logged[0][0]).toBe('adminSuspendUser: partial outcome');
        expect(logged[0][1]).toMatchObject({ step: 'revoke', code: 'auth/internal-error', revoked: false, recordWritten: true });
        expect(JSON.stringify(logged)).not.toContain(target);
        expect(JSON.stringify(logged)).not.toContain('spam');
        let s = await state();
        expect(s).toMatchObject({ disabled: true, status: 'Suspended' });
        expect(s.tokensValidAfterTime).toBeFalsy();
        expect(s.mod).toMatchObject({ status: 'Suspended', suspendedBy: admin, suspensionReason: 'spam' });
        expect(actions(s)).toEqual(['user.suspend.partial']);
        expect(s.logs[0]).toMatchObject({ outcome: 'partial', failedStep: 'revoke', errorCode: 'auth/internal-error',
            authDisabled: true, revoked: false, recordWritten: true, adminId: admin, reason: 'spam', targetType: 'user' });
        expectInvariant(s);
        await expectCannotSignIn();

        unstubAll();
        expect((await runCall(adminSuspendUser, { userId: target, reason: 'spam' })).result).toEqual({ success: true });
        s = await state();
        expect(s).toMatchObject({ disabled: true, status: 'Suspended' });
        expect(s.tokensValidAfterTime).toBeTruthy();
        expect(count(s, 'user.suspend')).toBe(1);
        expect(count(s, 'user.suspend.partial')).toBe(1);
    });

    it('EP-S3: record batch fails after disable+revoke → partial, fail closed (no re-enable), standalone user.suspend.partial; retry converges', async () => {
        failBatchCommit();
        const enableCalls = [];
        stub(fnAuth, 'updateUser', (orig) => async (uid, props) => { enableCalls.push(props); return orig(uid, props); });
        const logged = captureConsoleError();
        const r = await runCall(adminSuspendUser, { userId: target, reason: 'spam' });
        expect(r.error?.code).toBe('aborted');
        expect(r.error?.message).not.toMatch(/Nothing was changed/);
        expect(r.error?.message).toMatch(/disabled and cannot sign in, and its existing sessions were revoked, but the suspension could not be saved/);
        expect(r.error?.message).toMatch(/written to the audit log/);
        expect(r.error?.details).toEqual({ partial: true, authDisabled: true, revoked: true, recordWritten: false, auditWritten: true });
        expectNoPiiOrRaw(r.error);
        expect(enableCalls).toEqual([{ disabled: true }]); // never re-enabled
        expect(logged).toHaveLength(1);
        expect(logged[0][1]).toMatchObject({ step: 'record', authDisabled: true, revoked: true, recordWritten: false, auditWritten: true });
        let s = await state();
        expect(s).toMatchObject({ disabled: true, status: 'Active', mod: null });
        expect(s.tokensValidAfterTime).toBeTruthy();
        expect(actions(s)).toEqual(['user.suspend.partial']);
        expect(s.logs[0]).toMatchObject({ outcome: 'partial', failedStep: 'record', authDisabled: true, revoked: true,
            recordWritten: false, adminId: admin, reason: 'spam', targetType: 'user' });
        expect(s.logs[0].createdAt).toBeInstanceOf(Timestamp);
        expectInvariant(s);
        await expectCannotSignIn();

        unstubAll();
        expect((await runCall(adminSuspendUser, { userId: target, reason: 'spam' })).result).toEqual({ success: true });
        s = await state();
        expect(s).toMatchObject({ disabled: true, status: 'Suspended' });
        expect(s.mod).toMatchObject({ status: 'Suspended' });
        expect(count(s, 'user.suspend')).toBe(1);
    });

    it('EP-S4: revoke AND record fail → partial with revoked:false; retry converges', async () => {
        failAuth('revokeRefreshTokens');
        failBatchCommit();
        const r = await runCall(adminSuspendUser, { userId: target, reason: 'spam' });
        expect(r.error?.code).toBe('aborted');
        expect(r.error?.message).toMatch(/revoking its existing sessions also failed/);
        expect(r.error?.details).toEqual({ partial: true, authDisabled: true, revoked: false, recordWritten: false, auditWritten: true });
        let s = await state();
        expect(s).toMatchObject({ disabled: true, status: 'Active', mod: null });
        expect(s.tokensValidAfterTime).toBeFalsy();
        expect(actions(s)).toEqual(['user.suspend.partial']);
        expect(s.logs[0]).toMatchObject({ failedStep: 'record', revoked: false, recordWritten: false, revokeErrorCode: 'auth/internal-error' });
        expectInvariant(s);
        await expectCannotSignIn();

        unstubAll();
        expect((await runCall(adminSuspendUser, { userId: target, reason: 'spam' })).result).toEqual({ success: true });
        s = await state();
        expect(s).toMatchObject({ disabled: true, status: 'Suspended' });
        expect(s.tokensValidAfterTime).toBeTruthy();
        expect(count(s, 'user.suspend')).toBe(1);
    });

    it('EP-S5: record AND partial-audit fail → still partial, auditWritten:false, exactly one log line; retry converges', async () => {
        failBatchCommit();
        failAuditDocSet();
        const logged = captureConsoleError();
        const r = await runCall(adminSuspendUser, { userId: target, reason: 'spam' });
        expect(r.error?.code).toBe('aborted');
        expect(r.error?.message).toMatch(/audit log entry could not be written/);
        expect(r.error?.details).toEqual({ partial: true, authDisabled: true, revoked: true, recordWritten: false, auditWritten: false });
        expect(logged).toHaveLength(1);
        expect(logged[0]).toEqual(['adminSuspendUser: partial outcome',
            { step: 'record', code: '14', authDisabled: true, revoked: true, recordWritten: false, auditWritten: false }]);
        let s = await state();
        expect(s).toMatchObject({ disabled: true, status: 'Active', mod: null });
        expect(s.logs).toHaveLength(0);
        expectInvariant(s);

        unstubAll();
        expect((await runCall(adminSuspendUser, { userId: target, reason: 'spam' })).result).toEqual({ success: true });
        s = await state();
        expect(s).toMatchObject({ disabled: true, status: 'Suspended' });
        expect(actions(s)).toEqual(['user.suspend']);
    });

    // ── adminUnsuspendUser ──────────────────────────────────────────────────

    async function suspendFirst() {
        const r = await runCall(adminSuspendUser, { userId: target, reason: 'spam' });
        expect(r.result).toEqual({ success: true });
        const logs = await db.collection('adminAuditLog').where('targetUserId', '==', target).get();
        await Promise.all(logs.docs.map(d => d.ref.delete())); // isolate the unsuspend audit trail
    }
    function expectUnsuspendInvariant(s) {
        expectInvariant(s);
        if (!s.disabled) expect(count(s, 'user.unsuspend')).toBeGreaterThanOrEqual(1);
    }

    it('EP-U0: unsuspend happy path is unchanged (in-process) and commits record+audit BEFORE re-enabling Auth', async () => {
        await suspendFirst();
        const order = [];
        stub(fnDb, 'batch', (orig) => () => {
            const b = orig(); const c = b.commit.bind(b);
            b.commit = async () => { const out = await c(); order.push('firestore.commit'); return out; };
            return b;
        });
        stub(fnAuth, 'updateUser', (orig) => async (uid, props) => { order.push(`auth.updateUser:${JSON.stringify(props)}`); return orig(uid, props); });
        const r = await runCall(adminUnsuspendUser, { userId: target });
        expect(r.error).toBeUndefined();
        expect(r.result).toEqual({ success: true });
        expect(order).toEqual(['firestore.commit', 'auth.updateUser:{"disabled":false}']);
        const s = await state();
        expect(s).toMatchObject({ disabled: false, status: 'Active' });
        expect(s.mod).toMatchObject({ status: 'Active', unsuspendedBy: admin, suspendedBy: null, suspensionReason: null });
        expect(count(s, 'user.unsuspend')).toBe(1);
        expect(actions(s)).toEqual(['user.unsuspend', 'user.unsuspend.pending']);
        const completed = s.logs.find(l => l.action === 'user.unsuspend');
        expect(Object.keys(completed).sort()).toEqual(['action', 'adminId', 'createdAt', 'targetId', 'targetType', 'targetUserId']);
        for (const k of PARTIAL_KEYS) expect(completed).not.toHaveProperty(k);
        expect(s.logs.find(l => l.action === 'user.unsuspend.pending')).toMatchObject({
            outcome: 'pending', pendingStep: 'enable', authDisabled: true, recordWritten: true, adminId: admin,
        });
    });

    it('EP-U1: Auth lookup failure or missing Auth user → nothing changed, no Firestore write', async () => {
        await suspendFirst();
        failAuth('getUser', target);  // admin lookups (requireCurrentAdmin) still succeed
        const r1 = await runCall(adminUnsuspendUser, { userId: target });
        expect(r1.error?.code).toBe('internal');
        expect(r1.error?.message).toMatch(/Nothing was changed/);
        unstubAll();
        let s = await state();
        expect(s).toMatchObject({ disabled: true, status: 'Suspended' });
        expect(s.logs).toHaveLength(0);
        expect((await runCall(adminUnsuspendUser, { userId: target })).result).toEqual({ success: true });
        s = await state();
        expect(s).toMatchObject({ disabled: false, status: 'Active' });

        const ghost = uidOf('epghost'); cleanup.push(ghost);
        await db.doc(`users/${ghost}`).set({ id: ghost, status: 'Suspended' }); // doc but no Auth user
        const r2 = await runCall(adminUnsuspendUser, { userId: ghost });
        expect(r2.error?.code).toBe('not-found');
        expect((await db.doc(`users/${ghost}`).get()).data().status).toBe('Suspended');
        expect((await db.doc(`users/${ghost}/private/moderation`).get()).exists).toBe(false);
        expect(await auditFor(ghost, 'user.unsuspend')).toHaveLength(0);
    });

    it('EP-U2: record batch fails → "Nothing was changed" is true: still disabled + Suspended, enable never attempted; retry converges', async () => {
        await suspendFirst();
        failBatchCommit();
        const enableCalls = [];
        stub(fnAuth, 'updateUser', (orig) => async (uid, props) => { enableCalls.push(props); return orig(uid, props); });
        const r = await runCall(adminUnsuspendUser, { userId: target });
        expect(r.error?.code).toBe('internal');
        expect(r.error?.message).toMatch(/Nothing was changed/);
        expect(r.error?.message).toMatch(/still suspended and cannot sign in/);
        expect(enableCalls).toHaveLength(0);
        let s = await state();
        expect(s).toMatchObject({ disabled: true, status: 'Suspended' });
        expect(s.mod).toMatchObject({ status: 'Suspended' });
        expect(s.logs).toHaveLength(0);
        expect(count(s, 'user.unsuspend')).toBe(0);
        expect(count(s, 'user.unsuspend.pending')).toBe(0);
        expectUnsuspendInvariant(s);
        await expectCannotSignIn();

        unstubAll();
        expect((await runCall(adminUnsuspendUser, { userId: target })).result).toEqual({ success: true });
        s = await state();
        expect(s).toMatchObject({ disabled: false, status: 'Active' });
        expect(count(s, 'user.unsuspend')).toBe(1);
        expect(actions(s)).toEqual(['user.unsuspend', 'user.unsuspend.pending']);
        expectUnsuspendInvariant(s);
    });

    it('EP-U3: enable fails → partial (aborted), recorded Active but still cannot sign in, user.unsuspend.partial; retry converges', async () => {
        await suspendFirst();
        failAuth('updateUser');
        const logged = captureConsoleError();
        const r = await runCall(adminUnsuspendUser, { userId: target });
        expect(r.error?.code).toBe('aborted');
        expect(r.error?.message).not.toMatch(/Nothing was changed/);
        expect(r.error?.message).toMatch(/recorded as Active, but re-enabling sign-in failed, so they still cannot sign in/);
        expect(r.error?.details).toEqual({ partial: true, authDisabled: true, recordWritten: true, auditWritten: true });
        expectNoPiiOrRaw(r.error);
        expect(logged).toEqual([['adminUnsuspendUser: partial outcome',
            { step: 'enable', code: 'auth/internal-error', authDisabled: true, recordWritten: true, auditWritten: true }]]);
        let s = await state();
        expect(s).toMatchObject({ disabled: true, status: 'Active' });
        expect(count(s, 'user.unsuspend')).toBe(0);
        expect(actions(s)).toEqual(['user.unsuspend.partial', 'user.unsuspend.pending']);
        expect(s.logs.find(l => l.action === 'user.unsuspend.pending')).toMatchObject({
            outcome: 'pending', pendingStep: 'enable', authDisabled: true, recordWritten: true, adminId: admin,
        });
        expect(s.logs.find(l => l.action === 'user.unsuspend.partial')).toMatchObject({
            outcome: 'partial', failedStep: 'enable', errorCode: 'auth/internal-error',
            authDisabled: true, recordWritten: true, adminId: admin, targetType: 'user' });
        expectUnsuspendInvariant(s);
        await expectCannotSignIn();

        unstubAll();
        expect((await runCall(adminUnsuspendUser, { userId: target })).result).toEqual({ success: true });
        s = await state();
        expect(s).toMatchObject({ disabled: false, status: 'Active' });
        expectUnsuspendInvariant(s);
        expect(count(s, 'user.unsuspend')).toBe(1);
        expect(count(s, 'user.unsuspend.partial')).toBe(1);
        expect(count(s, 'user.unsuspend.pending')).toBe(2);
        expect((await signInRaw(target)).idToken).toBeTruthy();
    });

    it('EP-U4: enable AND partial-audit fail → partial with auditWritten:false; retry converges', async () => {
        await suspendFirst();
        failAuth('updateUser');
        failAuditDocSet();
        const logged = captureConsoleError();
        const r = await runCall(adminUnsuspendUser, { userId: target });
        expect(r.error?.code).toBe('aborted');
        expect(r.error?.message).toMatch(/still cannot sign in/);
        expect(r.error?.message).toMatch(/audit log entry could not be written/);
        expect(r.error?.message).not.toMatch(/Nothing was changed/);
        expect(r.error?.details).toEqual({ partial: true, authDisabled: true, recordWritten: true, auditWritten: false });
        expectNoPiiOrRaw(r.error);
        expect(logged).toEqual([['adminUnsuspendUser: partial outcome',
            { step: 'enable', code: 'auth/internal-error', authDisabled: true, recordWritten: true, auditWritten: false }]]);
        let s = await state();
        expect(s).toMatchObject({ disabled: true, status: 'Active' });
        expect(count(s, 'user.unsuspend')).toBe(0);
        expect(actions(s)).toEqual(['user.unsuspend.pending']);
        expect(s.logs[0]).toMatchObject({ outcome: 'pending', pendingStep: 'enable', authDisabled: true, recordWritten: true });
        expectUnsuspendInvariant(s);
        await expectCannotSignIn();

        unstubAll();
        expect((await runCall(adminUnsuspendUser, { userId: target })).result).toEqual({ success: true });
        s = await state();
        expect(s).toMatchObject({ disabled: false, status: 'Active' });
        expect(count(s, 'user.unsuspend')).toBe(1);
        expectUnsuspendInvariant(s);
    });

    it('EP-U5: enable succeeds but the completion audit fails → Auth stays enabled, no completed user.unsuspend; retry writes exactly one', async () => {
        await suspendFirst();
        failAuditDocSet();
        const logged = captureConsoleError();
        const r = await runCall(adminUnsuspendUser, { userId: target });
        expect(r.error?.code).toBe('aborted');
        expect(r.error?.message).not.toMatch(/Nothing was changed/);
        expect(r.error?.message).not.toMatch(/cannot sign in|still disabled|remains disabled/);
        expect(r.error?.message).toMatch(/sign-in was re-enabled/);
        expect(r.error?.message).toMatch(/completion audit entry could not be written/);
        expect(r.error?.details).toEqual({ partial: true, authDisabled: false, recordWritten: true, auditWritten: false });
        expectNoPiiOrRaw(r.error);
        expect(logged).toEqual([['adminUnsuspendUser: partial outcome', {
            step: 'audit', code: '14', authDisabled: false, recordWritten: true,
            auditWritten: false, diagnosticWritten: false,
        }]]);
        let s = await state();
        expect(s).toMatchObject({ disabled: false, status: 'Active' });
        expect(count(s, 'user.unsuspend')).toBe(0);
        expect(count(s, 'user.unsuspend.partial')).toBe(0);
        expect(actions(s)).toEqual(['user.unsuspend.pending']);
        expect((await signInRaw(target)).idToken).toBeTruthy();

        unstubAll();
        expect((await runCall(adminUnsuspendUser, { userId: target })).result).toEqual({ success: true });
        s = await state();
        expect(s).toMatchObject({ disabled: false, status: 'Active' });
        expect(count(s, 'user.unsuspend')).toBe(1);
        expect(count(s, 'user.unsuspend.pending')).toBe(2);
        expectUnsuspendInvariant(s);
    });
});
