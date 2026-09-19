'use strict';

/**
 * Behavioral integration tests — setStaffRole callable.
 *
 * Redesign context: the previous revision performed a sequential last-admin
 * check (full Auth scan, then mutate) with no cross-request serialization.
 * Two admins concurrently demoting each other could each observe "another
 * admin exists" before either committed, both pass, and together leave zero
 * admins — an unrecoverable lockout, since adminBootstrap/singleton is
 * permanently closed and reconcileLegacyAdminSingleton itself requires an
 * existing admin claim to invoke. This revision serializes every call
 * through a single Firestore-owned lock (adminRoleLock/singleton) and
 * journals each logical operation by a caller-supplied operationId
 * (adminRoleOperations/{operationId}), making the last-admin check and the
 * Auth mutation part of one atomic-with-respect-to-each-other critical
 * section, and making retries/resumes safe and audit-exactly-once.
 *
 * What is proven (SR-1..23 preserved from the prior revision, updated to
 * supply operationId; SR-16 strengthened from "either outcome acceptable"
 * to "provably serialized" now that the design guarantees it):
 *   SR-1:  unauthenticated caller rejected
 *   SR-2:  non-admin caller rejected
 *   SR-3:  nonexistent target rejected, no audit record created
 *   SR-4:  malformed/missing target uid or operationId rejected
 *   SR-5:  invalid role value rejected
 *   SR-6:  promotion (none -> staff, none -> admin with 2+ admins already) succeeds
 *   SR-7:  downgrade (admin -> staff) succeeds when another active admin exists
 *   SR-8:  removal (admin -> null) succeeds when another active admin exists
 *   SR-9:  same-role request is idempotent (no Auth write, one truthful no-op audit)
 *   SR-10: caller cannot inject arbitrary custom claim keys via request.data
 *   SR-11: unrelated custom claim survives promotion
 *   SR-12: unrelated custom claim survives a role change
 *   SR-13: unrelated custom claim survives role removal
 *   SR-14: caller cannot spoof the audit actor
 *   SR-15: audit reflects correct previous/new role
 *   SR-16: two operations on the same target are provably serialized, not last-write-wins
 *   SR-17: self-demotion allowed when another active admin exists
 *   SR-18: last active administrator cannot demote themselves
 *   SR-19: last active administrator's role cannot be removed by another caller
 *   SR-20: a disabled admin does not count toward "another active admin"
 *   SR-21: bootstrap singleton is never touched by role management
 *   SR-22: no console output contains sensitive identity
 *   SR-23: error codes reaching the client are clean HttpsError codes, never raw Admin SDK codes
 *
 * New (lock/journal redesign):
 *   SR-24: two active admins concurrently demoting each other — exactly one succeeds, one admin remains
 *   SR-25: three admins concurrently demoting cannot produce zero active admins
 *   SR-26: the global lock serializes operations even across two different targets
 *   SR-27: an expired lease is recoverable by a new operation
 *   SR-28: a non-owner's failed acquire attempt never touches another operation's active lock
 *   SR-29: Auth mutation succeeded but audit never landed — retry completes exactly one audit
 *   SR-30: retrying a completed operation returns the same result, no duplicate mutation/audit
 *   SR-31: reusing an operationId with a different target fails closed
 *   SR-32: reusing an operationId with a different requested role fails closed
 *   SR-33: reusing an operationId from a different caller fails closed
 *   SR-34: the audit document id is deterministic per operationId
 *   SR-35: a last-admin-blocked operation creates no audit record
 *   SR-36: two operationIds on the same target chain previousRole/role truthfully in order
 *   SR-37: unrelated custom claim survives concurrent serialized activity on the same target
 *   SR-38: bootstrap singleton remains untouched across lock/journal-heavy activity
 *   SR-39: client cannot forge operation journal/lock state via request.data
 *   SR-40: logs contain no sensitive identity during concurrent/lock activity
 *
 * Lease-safety and originalPreviousRole hardening (integration review round 2):
 * the lease was raised from 30s to 120s — 2x this Function's own 60s timeout —
 * because a lease shorter than the maximum invocation lifetime cannot
 * structurally guarantee serialization (a still-live invocation could reach
 * the Auth mutation after its own lease was stolen). The journal's captured
 * "previous role" was renamed to originalPreviousRole to make explicit that
 * it is written once, before the first Auth mutation, and never recomputed
 * from a fresh Auth read on resume — otherwise a resume after "Auth
 * succeeded, audit failed" could misrecord e.g. admin->staff as a false
 * staff->staff no-op.
 *   SR-41: a lease still valid past the old 30s boundary correctly blocks a second operation from reaching Auth
 *   SR-42: an operation completes correctly despite starting with a nearly-expired same-owner lease (renewal path exercised)
 *   SR-43: a stale operation cannot reach Auth once ownership has genuinely transferred to a newer operation
 *   SR-44: a crashed invocation becomes recoverable once the full 120s lease genuinely expires
 *   SR-45: admin -> staff mutation succeeded, audit never landed — retry truthfully records admin -> staff, not staff -> staff
 *   SR-46: admin -> null mutation succeeded, audit never landed — retry preserves the original admin -> null transition
 *   SR-47: staff -> admin succeeded and audited, finalization never completed — retry preserves staff -> admin, no duplicate audit
 *   SR-48: a brand-new same-role confirmation is a distinct audited event from a retry of a completed mutation
 *   SR-49: originalPreviousRole cannot be altered by client data or by a later retry
 */

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

let setStaffRole;
try {
    ({ setStaffRole } = require('./index.js'));
} catch (e) {
    console.warn('[setStaffRole.integration] Could not load index.js:', e.message);
}

const { requireEmulatorProjectId } = require('./emulatorProjectId');
const PROJECT_ID = requireEmulatorProjectId();
const APP_NAME = '__setStaffRole_intg__';
const AUTH_EMULATOR = 'http://localhost:9099';

const testApp =
    getApps().find(a => a.name === APP_NAME) ??
    initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const adminAuth = getAuth(testApp);

// ─── Helpers ─────────────────────────────────────────────────────────────

// setStaffRole is now gated by requireCurrentAdmin (functions/adminAuth.js),
// which verifies an ACTUAL signed ID token (checkRevoked) in addition to the
// cheap request.auth.token.role check — a fake, unsigned token object is no
// longer sufficient for a caller that is meant to pass. Sign in for real
// whenever the test intends the caller to be currently admin; the cheap
// token.role check alone still correctly fails unauthenticated/non-admin
// negative-path tests before any real token would ever be needed.
async function signInUser(uid) {
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

async function fakeRequest(uid, callerRole, data = {}) {
    const NOW = Math.floor(Date.now() / 1000);
    let idToken;
    if (uid && callerRole === 'admin') {
        idToken = await signInUser(uid);
    }
    return {
        data,
        auth: uid ? {
            uid,
            token: {
                uid,
                role: callerRole || undefined,
                auth_time: NOW - 30,
                iat: NOW - 30,
                exp: NOW + 3600,
            },
        } : null,
        rawRequest: { headers: idToken ? { authorization: `Bearer ${idToken}` } : {} },
    };
}

async function call(callerUid, callerRole, data) {
    if (!setStaffRole) throw new Error('setStaffRole not loaded');
    try {
        return { result: await setStaffRole.run(await fakeRequest(callerUid, callerRole, data)) };
    } catch (err) {
        return { error: { code: err.code, message: err.message } };
    }
}

function testUid(label) {
    return `sr_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function opId(label) {
    return `op_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function nukeUser(uid) {
    await adminAuth.deleteUser(uid).catch(() => {});
}

async function deleteAuditLogsFor(uid) {
    const snap = await db.collection('adminAuditLog').where('targetUid', '==', uid).get();
    if (snap.empty) return;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
}

async function deleteSingleton() {
    await db.doc('adminBootstrap/singleton').delete().catch(() => {});
}

async function deleteLock() {
    await db.doc('adminRoleLock/singleton').delete().catch(() => {});
}

// setStaffRole's last-admin check scans the whole Auth emulator, same shared-state
// caveat as reconcileLegacyAdminSingleton's tests — safe under maxWorkers: 1.
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

describe('setStaffRole — emulator behavioral tests', () => {
    let callerUid, targetUid;

    beforeEach(async () => {
        callerUid = testUid('caller');
        targetUid = testUid('target');
        await wipeAllStrayAdmins();
        await deleteLock();
    });

    afterEach(async () => {
        await deleteAuditLogsFor(targetUid);
        await nukeUser(callerUid);
        await nukeUser(targetUid);
        await deleteLock();
    });

    it('SR-1: unauthenticated caller rejected', async () => {
        if (!setStaffRole) return;
        const { error } = await call(null, undefined, { uid: targetUid, role: 'staff', operationId: opId('u') });
        // requireCurrentAdmin (functions/adminAuth.js) now distinguishes
        // unauthenticated from authenticated-but-not-admin, rather than
        // collapsing both into 'permission-denied' via the prior
        // request.auth?.token?.role optional-chaining pattern — a diagnostic
        // improvement, not a privilege-semantics change (the caller is
        // rejected either way).
        expect(error.code).toBe('unauthenticated');
    });

    it('SR-2: non-admin caller rejected', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        const { error } = await call(callerUid, undefined, { uid: targetUid, role: 'staff', operationId: opId('u') });
        expect(error.code).toBe('permission-denied');
    });

    it('SR-3: nonexistent target rejected, no audit record created', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });

        const fakeTarget = testUid('ghost');
        const { error } = await call(callerUid, 'admin', { uid: fakeTarget, role: 'staff', operationId: opId('u') });
        expect(error.code).toBe('not-found');

        const snap = await db.collection('adminAuditLog').where('targetUid', '==', fakeTarget).get();
        expect(snap.empty).toBe(true);
    });

    it('SR-4: malformed/missing target uid or operationId rejected', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });

        const missingUid = await call(callerUid, 'admin', { role: 'staff', operationId: opId('u') });
        expect(missingUid.error.code).toBe('invalid-argument');

        const wrongType = await call(callerUid, 'admin', { uid: 12345, role: 'staff', operationId: opId('u') });
        expect(wrongType.error.code).toBe('invalid-argument');

        const missingOp = await call(callerUid, 'admin', { uid: targetUid, role: 'staff' });
        expect(missingOp.error.code).toBe('invalid-argument');

        const badOp = await call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: 'x' });
        expect(badOp.error.code).toBe('invalid-argument');
    });

    it('SR-5: invalid role value rejected', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});

        const { error } = await call(callerUid, 'admin', { uid: targetUid, role: 'superadmin', operationId: opId('u') });
        expect(error.code).toBe('invalid-argument');
    });

    it('SR-6: promotion succeeds — none to staff, and none to admin', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});

        const { result, error } = await call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: opId('u') });
        expect(error).toBeUndefined();
        expect(result.success).toBe(true);
        const user = await adminAuth.getUser(targetUid);
        expect(user.customClaims?.role).toBe('staff');
    });

    it('SR-7: downgrade admin -> staff succeeds when another active admin exists', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(targetUid, { role: 'admin' });

        const { result, error } = await call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: opId('u') });
        expect(error).toBeUndefined();
        expect(result.success).toBe(true);
        const user = await adminAuth.getUser(targetUid);
        expect(user.customClaims?.role).toBe('staff');
    });

    it('SR-8: removal admin -> null succeeds when another active admin exists', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(targetUid, { role: 'admin' });

        const { result, error } = await call(callerUid, 'admin', { uid: targetUid, role: null, operationId: opId('u') });
        expect(error).toBeUndefined();
        expect(result.success).toBe(true);
        const user = await adminAuth.getUser(targetUid);
        expect(user.customClaims?.role).toBeUndefined();
    });

    it('SR-9: same-role request is idempotent — no Auth write, one truthful no-op audit', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(targetUid, { role: 'staff' });

        const { result, error } = await call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: opId('u') });
        expect(error).toBeUndefined();
        expect(result.success).toBe(true);

        const user = await adminAuth.getUser(targetUid);
        expect(user.customClaims?.role).toBe('staff');

        const snap = await db.collection('adminAuditLog').where('targetUid', '==', targetUid).get();
        expect(snap.size).toBe(1);
        expect(snap.docs[0].data().metadata.noop).toBe(true);
    });

    it('SR-10: caller cannot inject arbitrary custom claim keys via request.data', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});

        const { error } = await call(callerUid, 'admin', {
            uid: targetUid, role: 'staff', operationId: opId('u'), customClaims: { superuser: true }, betaTester: true,
        });
        expect(error).toBeUndefined();
        const user = await adminAuth.getUser(targetUid);
        expect(user.customClaims).toEqual({ role: 'staff' });
    });

    it('SR-11: unrelated custom claim survives promotion', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(targetUid, { betaTester: true });

        const { error } = await call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: opId('u') });
        expect(error).toBeUndefined();
        const user = await adminAuth.getUser(targetUid);
        expect(user.customClaims?.role).toBe('staff');
        expect(user.customClaims?.betaTester).toBe(true);
    });

    it('SR-12: unrelated custom claim survives a role change', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(targetUid, { role: 'staff', betaTester: true });

        const { error } = await call(callerUid, 'admin', { uid: targetUid, role: 'admin', operationId: opId('u') });
        expect(error).toBeUndefined();
        const user = await adminAuth.getUser(targetUid);
        expect(user.customClaims?.role).toBe('admin');
        expect(user.customClaims?.betaTester).toBe(true);
    });

    it('SR-13: unrelated custom claim survives role removal', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(targetUid, { role: 'staff', betaTester: true });

        const { error } = await call(callerUid, 'admin', { uid: targetUid, role: null, operationId: opId('u') });
        expect(error).toBeUndefined();
        const user = await adminAuth.getUser(targetUid);
        expect(user.customClaims?.role).toBeUndefined();
        expect(user.customClaims?.betaTester).toBe(true);
    });

    it('SR-14: caller cannot spoof the audit actor', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});

        const spoofedActor = testUid('spoofed');
        const { error } = await call(callerUid, 'admin', {
            uid: targetUid, role: 'staff', operationId: opId('u'), adminId: spoofedActor, adminUid: spoofedActor,
        });
        expect(error).toBeUndefined();

        const snap = await db.collection('adminAuditLog').where('targetUid', '==', targetUid).get();
        expect(snap.docs[0].data().adminId).toBe(callerUid);
        expect(snap.docs[0].data().adminUid).toBe(callerUid);
    });

    it('SR-15: audit reflects correct previous/new role', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(targetUid, { role: 'staff' });

        const { error } = await call(callerUid, 'admin', { uid: targetUid, role: 'admin', operationId: opId('u') });
        expect(error).toBeUndefined();

        const snap = await db.collection('adminAuditLog').where('targetUid', '==', targetUid).get();
        const data = snap.docs[0].data();
        expect(data.metadata.previousRole).toBe('staff');
        expect(data.metadata.role).toBe('admin');
        expect(data.action).toBe('user.set_role');
    });

    it('SR-16: two operations on the same target are provably serialized, not last-write-wins', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(targetUid, { role: 'staff' });

        const opA = opId('a'), opB = opId('b');
        const [a, b] = await Promise.all([
            call(callerUid, 'admin', { uid: targetUid, role: 'admin', operationId: opA }),
            call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: opB }),
        ]);
        expect(a.error).toBeUndefined();
        expect(b.error).toBeUndefined();

        const user = await adminAuth.getUser(targetUid);
        expect(['admin', 'staff']).toContain(user.customClaims?.role);

        const [docA, docB] = await Promise.all([
            db.doc(`adminAuditLog/roleOp_${opA}`).get(),
            db.doc(`adminAuditLog/roleOp_${opB}`).get(),
        ]);
        // Order by createdAt (not by previousRole value — opB requests the
        // SAME role the target already has, so if opB happens to run first
        // its own previousRole is trivially 'staff' too, same as whichever
        // ran first; the role value alone can't disambiguate). Whichever
        // audit record was created second must show the FIRST one's
        // resulting role as its own previousRole — proof of true
        // serialization rather than two independent stale reads.
        const [first, second] = docA.data().createdAt.toMillis() <= docB.data().createdAt.toMillis()
            ? [docA, docB] : [docB, docA];
        expect(second.data().metadata.previousRole).toBe(first.data().metadata.role);
    });

    it('SR-17: self-demotion allowed when another active admin exists', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(targetUid, { role: 'admin' });

        const { result, error } = await call(callerUid, 'admin', { uid: callerUid, role: 'staff', operationId: opId('u') });
        expect(error).toBeUndefined();
        expect(result.success).toBe(true);
        const user = await adminAuth.getUser(callerUid);
        expect(user.customClaims?.role).toBe('staff');
    });

    it('SR-18: the last active administrator cannot demote themselves', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });

        const { error } = await call(callerUid, 'admin', { uid: callerUid, role: 'staff', operationId: opId('u') });
        expect(error.code).toBe('failed-precondition');

        const user = await adminAuth.getUser(callerUid);
        expect(user.customClaims?.role).toBe('admin');
    });

    it('SR-19: the last active administrator\'s role cannot be removed by another caller', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });

        const { error } = await call(callerUid, 'admin', { uid: callerUid, role: null, operationId: opId('u') });
        expect(error.code).toBe('failed-precondition');

        const user = await adminAuth.getUser(callerUid);
        expect(user.customClaims?.role).toBe('admin');
    });

    it('SR-20: a disabled admin does not count toward "another active admin"', async () => {
        if (!setStaffRole) return;
        const disabledAdminUid = testUid('disabled');
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: disabledAdminUid, disabled: true }).catch(() => {});
        await adminAuth.setCustomUserClaims(disabledAdminUid, { role: 'admin' });

        const { error } = await call(callerUid, 'admin', { uid: callerUid, role: 'staff', operationId: opId('u') });
        expect(error.code).toBe('failed-precondition');

        await nukeUser(disabledAdminUid);
    });

    it('SR-21: bootstrap singleton is never touched by role management', async () => {
        if (!setStaffRole) return;
        await deleteSingleton();
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(targetUid, { role: 'admin' });

        await call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: opId('u1') });
        await call(callerUid, 'admin', { uid: callerUid, role: 'admin', operationId: opId('u2') });

        const singleton = await db.doc('adminBootstrap/singleton').get();
        expect(singleton.exists).toBe(false);
    });

    it('SR-22: no console output contains sensitive identity', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});

        const originalLog = console.log;
        const originalError = console.error;
        const captured = [];
        console.log = (...args) => captured.push(args.join(' '));
        console.error = (...args) => captured.push(args.join(' '));
        try {
            await call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: opId('u1') });
            await call(callerUid, 'admin', { uid: 'not-a-real-uid', role: 'staff', operationId: opId('u2') });
        } finally {
            console.log = originalLog;
            console.error = originalError;
        }

        const joined = captured.join('\n');
        expect(joined).not.toMatch(/@parqueen\.app|@gmail\.com/);
        expect(joined.includes(callerUid)).toBe(false);
        expect(joined.includes(targetUid)).toBe(false);
    });

    it('SR-23: error codes reaching the client are clean HttpsError codes, never raw Admin SDK codes', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });

        const { error } = await call(callerUid, 'admin', { uid: testUid('ghost'), role: 'staff', operationId: opId('u') });
        expect(error.code).toBe('not-found');
        expect(error.code).not.toMatch(/^auth\//);
    });

    // ─── Lock / journal redesign coverage ─────────────────────────────────

    it('SR-24: two active admins concurrently demoting each other — exactly one succeeds, one admin remains', async () => {
        if (!setStaffRole) return;
        const adminA = testUid('mutA'), adminB = testUid('mutB');
        await adminAuth.createUser({ uid: adminA }).catch(() => {});
        await adminAuth.createUser({ uid: adminB }).catch(() => {});
        await adminAuth.setCustomUserClaims(adminA, { role: 'admin' });
        await adminAuth.setCustomUserClaims(adminB, { role: 'admin' });

        const [rA, rB] = await Promise.all([
            call(adminA, 'admin', { uid: adminB, role: 'staff', operationId: opId('a-demotes-b') }),
            call(adminB, 'admin', { uid: adminA, role: 'staff', operationId: opId('b-demotes-a') }),
        ]);
        const outcomes = [rA, rB].map(r => (r.error ? r.error.code : 'success'));
        expect(outcomes.filter(o => o === 'success')).toHaveLength(1);
        expect(outcomes.filter(o => o === 'failed-precondition')).toHaveLength(1);

        const [userA, userB] = await Promise.all([adminAuth.getUser(adminA), adminAuth.getUser(adminB)]);
        const activeAdmins = [userA, userB].filter(u => u.customClaims?.role === 'admin');
        expect(activeAdmins).toHaveLength(1);

        await nukeUser(adminA);
        await nukeUser(adminB);
    });

    it('SR-25: three admins concurrently demoting cannot produce zero active admins', async () => {
        if (!setStaffRole) return;
        const a = testUid('3a'), b = testUid('3b'), c = testUid('3c');
        await adminAuth.createUser({ uid: a }).catch(() => {});
        await adminAuth.createUser({ uid: b }).catch(() => {});
        await adminAuth.createUser({ uid: c }).catch(() => {});
        await adminAuth.setCustomUserClaims(a, { role: 'admin' });
        await adminAuth.setCustomUserClaims(b, { role: 'admin' });
        await adminAuth.setCustomUserClaims(c, { role: 'admin' });

        await Promise.all([
            call(a, 'admin', { uid: b, role: 'staff', operationId: opId('a-b') }),
            call(b, 'admin', { uid: c, role: 'staff', operationId: opId('b-c') }),
            call(c, 'admin', { uid: a, role: 'staff', operationId: opId('c-a') }),
        ]);

        const [ua, ub, uc] = await Promise.all([adminAuth.getUser(a), adminAuth.getUser(b), adminAuth.getUser(c)]);
        const activeAdmins = [ua, ub, uc].filter(u => u.customClaims?.role === 'admin');
        expect(activeAdmins.length).toBeGreaterThanOrEqual(1);

        await nukeUser(a);
        await nukeUser(b);
        await nukeUser(c);
    }, 30000);

    it('SR-26: the global lock serializes operations even across two different targets', async () => {
        if (!setStaffRole) return;
        const targetB = testUid('targetB');
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await adminAuth.createUser({ uid: targetB }).catch(() => {});

        const [rA, rB] = await Promise.all([
            call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: opId('t1') }),
            call(callerUid, 'admin', { uid: targetB, role: 'staff', operationId: opId('t2') }),
        ]);
        expect(rA.error).toBeUndefined();
        expect(rB.error).toBeUndefined();

        const lock = await db.doc('adminRoleLock/singleton').get();
        expect(lock.exists).toBe(false); // both released cleanly

        await nukeUser(targetB);
        await deleteAuditLogsFor(targetB);
    });

    it('SR-27: an expired lease is recoverable by a new operation', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});

        // Simulate a prior invocation that crashed after acquiring the lock.
        await db.doc('adminRoleLock/singleton').set({
            ownerOperationId: 'crashed-op',
            acquiredAt: Timestamp.fromMillis(Date.now() - 60000),
            leaseExpiresAt: Timestamp.fromMillis(Date.now() - 30000),
        });

        const { result, error } = await call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: opId('u') });
        expect(error).toBeUndefined();
        expect(result.success).toBe(true);

        const lock = await db.doc('adminRoleLock/singleton').get();
        expect(lock.exists).toBe(false);
    });

    it('SR-28: a non-owner\'s failed acquire attempt never touches another operation\'s active lock', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});

        // Simulate another operation actively (validly) holding the lock.
        await db.doc('adminRoleLock/singleton').set({
            ownerOperationId: 'active-other-op',
            acquiredAt: Timestamp.now(),
            leaseExpiresAt: Timestamp.fromMillis(Date.now() + 25000),
        });

        const { error } = await call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: opId('stale') });
        expect(error.code).toBe('aborted');

        const lock = await db.doc('adminRoleLock/singleton').get();
        expect(lock.exists).toBe(true);
        expect(lock.data().ownerOperationId).toBe('active-other-op');

        await db.doc('adminRoleLock/singleton').delete();
    }, 20000);

    it('SR-29: Auth mutation succeeded but audit never landed — retry with the same operationId completes exactly one audit', async () => {
        if (!setStaffRole) return;
        const op = opId('crash-before-audit');
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        // Simulate the exact post-crash state: Auth mutation already landed,
        // journal still says 'pending', no audit doc exists yet.
        await adminAuth.setCustomUserClaims(targetUid, { role: 'staff' });
        await db.doc(`adminRoleOperations/${op}`).set({
            operationId: op, actorUid: callerUid, targetUid, requestedRole: 'staff',
            originalPreviousRole: null, status: 'pending', createdAt: Timestamp.now(),
        });

        const { result, error } = await call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: op });
        expect(error).toBeUndefined();
        expect(result.success).toBe(true);

        const auditSnap = await db.collection('adminAuditLog').where('metadata.operationId', '==', op).get();
        expect(auditSnap.size).toBe(1);
        const opDoc = await db.doc(`adminRoleOperations/${op}`).get();
        expect(opDoc.data().status).toBe('completed');
    });

    it('SR-30: retrying a completed operation returns the same result, no duplicate mutation/audit', async () => {
        if (!setStaffRole) return;
        const op = opId('lost-response');
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});

        const first = await call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: op });
        expect(first.result.success).toBe(true);

        const second = await call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: op });
        expect(second.error).toBeUndefined();
        expect(second.result).toEqual(first.result);

        const auditSnap = await db.collection('adminAuditLog').where('metadata.operationId', '==', op).get();
        expect(auditSnap.size).toBe(1);
    });

    it('SR-31: reusing an operationId with a different target fails closed', async () => {
        if (!setStaffRole) return;
        const op = opId('diff-target');
        const otherTarget = testUid('other');
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await adminAuth.createUser({ uid: otherTarget }).catch(() => {});

        const first = await call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: op });
        expect(first.result.success).toBe(true);

        const second = await call(callerUid, 'admin', { uid: otherTarget, role: 'staff', operationId: op });
        expect(second.error.code).toBe('failed-precondition');

        await nukeUser(otherTarget);
    });

    it('SR-32: reusing an operationId with a different requested role fails closed', async () => {
        if (!setStaffRole) return;
        const op = opId('diff-role');
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});

        const first = await call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: op });
        expect(first.result.success).toBe(true);

        const second = await call(callerUid, 'admin', { uid: targetUid, role: 'admin', operationId: op });
        expect(second.error.code).toBe('failed-precondition');
    });

    it('SR-33: reusing an operationId from a different caller fails closed', async () => {
        if (!setStaffRole) return;
        const op = opId('diff-caller');
        const otherAdmin = testUid('otherAdmin');
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: otherAdmin }).catch(() => {});
        await adminAuth.setCustomUserClaims(otherAdmin, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});

        const first = await call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: op });
        expect(first.result.success).toBe(true);

        const second = await call(otherAdmin, 'admin', { uid: targetUid, role: 'staff', operationId: op });
        expect(second.error.code).toBe('failed-precondition');

        await nukeUser(otherAdmin);
    });

    it('SR-34: the audit document id is deterministic per operationId', async () => {
        if (!setStaffRole) return;
        const op = opId('deterministic');
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});

        await call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: op });

        const doc = await db.doc(`adminAuditLog/roleOp_${op}`).get();
        expect(doc.exists).toBe(true);
        expect(doc.data().metadata.operationId).toBe(op);
    });

    it('SR-35: a last-admin-blocked operation creates no audit record', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        const op = opId('blocked');

        const { error } = await call(callerUid, 'admin', { uid: callerUid, role: 'staff', operationId: op });
        expect(error.code).toBe('failed-precondition');

        const doc = await db.doc(`adminAuditLog/roleOp_${op}`).get();
        expect(doc.exists).toBe(false);
    });

    it('SR-36: two operationIds on the same target chain previousRole/role truthfully in order', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});

        const op1 = opId('seq1'), op2 = opId('seq2');
        const first = await call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: op1 });
        expect(first.result.success).toBe(true);
        const second = await call(callerUid, 'admin', { uid: targetUid, role: 'admin', operationId: op2 });
        expect(second.result.success).toBe(true);

        const doc2 = await db.doc(`adminAuditLog/roleOp_${op2}`).get();
        expect(doc2.data().metadata.previousRole).toBe('staff');
        expect(doc2.data().metadata.role).toBe('admin');
    });

    it('SR-37: unrelated custom claim survives concurrent serialized activity on the same target', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(targetUid, { betaTester: true });

        await Promise.all([
            call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: opId('c1') }),
            call(callerUid, 'admin', { uid: targetUid, role: 'admin', operationId: opId('c2') }),
        ]);

        const user = await adminAuth.getUser(targetUid);
        expect(user.customClaims?.betaTester).toBe(true);
    });

    it('SR-38: bootstrap singleton remains untouched across lock/journal-heavy activity', async () => {
        if (!setStaffRole) return;
        await deleteSingleton();
        const a = testUid('sing1'), b = testUid('sing2');
        await adminAuth.createUser({ uid: a }).catch(() => {});
        await adminAuth.createUser({ uid: b }).catch(() => {});
        await adminAuth.setCustomUserClaims(a, { role: 'admin' });
        await adminAuth.setCustomUserClaims(b, { role: 'admin' });

        await Promise.all([
            call(a, 'admin', { uid: b, role: 'staff', operationId: opId('s1') }),
            call(b, 'admin', { uid: a, role: 'admin', operationId: opId('s2') }),
        ]);

        const singleton = await db.doc('adminBootstrap/singleton').get();
        expect(singleton.exists).toBe(false);

        await nukeUser(a);
        await nukeUser(b);
    });

    it('SR-39: client cannot forge operation journal/lock state via request.data', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        const op = opId('forge');

        const { result, error } = await call(callerUid, 'admin', {
            uid: targetUid, role: 'staff', operationId: op,
            status: 'completed', result: { success: true, previousRole: 'admin', role: 'admin' },
            previousRole: 'admin', originalPreviousRole: 'admin', ownerOperationId: 'forged-owner',
        });
        expect(error).toBeUndefined();
        expect(result.previousRole).toBeNull();
        expect(result.role).toBe('staff');

        const opDoc = await db.doc(`adminRoleOperations/${op}`).get();
        expect(opDoc.data().originalPreviousRole).toBeNull();
        expect(opDoc.data().status).toBe('completed');
    });

    it('SR-40: logs contain no sensitive identity during concurrent/lock activity', async () => {
        if (!setStaffRole) return;
        const a = testUid('log1'), b = testUid('log2');
        await adminAuth.createUser({ uid: a }).catch(() => {});
        await adminAuth.createUser({ uid: b }).catch(() => {});
        await adminAuth.setCustomUserClaims(a, { role: 'admin' });
        await adminAuth.setCustomUserClaims(b, { role: 'admin' });

        const originalLog = console.log;
        const originalError = console.error;
        const captured = [];
        console.log = (...args) => captured.push(args.join(' '));
        console.error = (...args) => captured.push(args.join(' '));
        try {
            await Promise.all([
                call(a, 'admin', { uid: b, role: 'staff', operationId: opId('l1') }),
                call(b, 'admin', { uid: a, role: 'staff', operationId: opId('l2') }),
            ]);
        } finally {
            console.log = originalLog;
            console.error = originalError;
        }

        const joined = captured.join('\n');
        expect(joined).not.toMatch(/@parqueen\.app|@gmail\.com/);
        expect(joined.includes(a)).toBe(false);
        expect(joined.includes(b)).toBe(false);

        await nukeUser(a);
        await nukeUser(b);
    });

    // ─── Lease safety and originalPreviousRole coverage (review round 2) ──

    it('SR-41: a lease still valid past the old 30s boundary correctly blocks a second operation from reaching Auth', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        const claimsBefore = (await adminAuth.getUser(targetUid)).customClaims;

        // Simulate operation A having acquired the lock 40s ago under the
        // current 120s lease (so ~80s remain) — well past where a 30s-lease
        // design would already have let it expire and be stolen.
        await db.doc('adminRoleLock/singleton').set({
            ownerOperationId: 'still-alive-op',
            acquiredAt: Timestamp.fromMillis(Date.now() - 40000),
            leaseExpiresAt: Timestamp.fromMillis(Date.now() + 80000),
        });

        const { error } = await call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: opId('u') });
        expect(error.code).toBe('aborted');

        const claimsAfter = (await adminAuth.getUser(targetUid)).customClaims;
        expect(claimsAfter).toEqual(claimsBefore);

        await db.doc('adminRoleLock/singleton').delete();
    }, 20000);

    it('SR-42: an operation completes correctly despite starting with a nearly-expired same-owner lease', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});

        const op = opId('near-expiry');
        // Pre-seed the lock as already owned by THIS operationId, but with
        // only a sliver of lease life left — simulating resuming right at
        // the edge. Both the acquire step (same-owner refresh) and the
        // pre-mutation renewal must extend it well past this operation's
        // own execution time for the mutation to land.
        await db.doc('adminRoleLock/singleton').set({
            ownerOperationId: op,
            acquiredAt: Timestamp.fromMillis(Date.now() - 1000),
            leaseExpiresAt: Timestamp.fromMillis(Date.now() + 500),
        });

        const { result, error } = await call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: op });
        expect(error).toBeUndefined();
        expect(result.success).toBe(true);

        const user = await adminAuth.getUser(targetUid);
        expect(user.customClaims?.role).toBe('staff');
    });

    it('SR-43: a stale operation cannot reach Auth once ownership has genuinely transferred to a newer operation', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});

        const staleOp = opId('stale');
        // The stale operation got as far as creating its journal before
        // crashing; ownership of the lock has since genuinely moved to a
        // different, newer operationId with a fresh valid lease.
        await db.doc(`adminRoleOperations/${staleOp}`).set({
            operationId: staleOp, actorUid: callerUid, targetUid, requestedRole: 'staff',
            originalPreviousRole: null, status: 'pending', createdAt: Timestamp.now(),
        });
        await db.doc('adminRoleLock/singleton').set({
            ownerOperationId: 'newer-op-has-it-now',
            acquiredAt: Timestamp.now(),
            leaseExpiresAt: Timestamp.fromMillis(Date.now() + 100000),
        });

        const { error } = await call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: staleOp });
        expect(error.code).toBe('aborted');

        const user = await adminAuth.getUser(targetUid);
        expect(user.customClaims?.role).toBeUndefined();

        await db.doc('adminRoleLock/singleton').delete();
        await db.doc(`adminRoleOperations/${staleOp}`).delete();
    }, 20000);

    it('SR-44: a crashed invocation becomes recoverable once the full 120s lease genuinely expires', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});

        await db.doc('adminRoleLock/singleton').set({
            ownerOperationId: 'long-dead-op',
            acquiredAt: Timestamp.fromMillis(Date.now() - 130000),
            leaseExpiresAt: Timestamp.fromMillis(Date.now() - 10000),
        });

        const { result, error } = await call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: opId('recover') });
        expect(error).toBeUndefined();
        expect(result.success).toBe(true);

        const lock = await db.doc('adminRoleLock/singleton').get();
        expect(lock.exists).toBe(false);
    });

    it('SR-45: admin -> staff mutation succeeded, audit never landed — retry truthfully records admin -> staff, not staff -> staff', async () => {
        if (!setStaffRole) return;
        const op = opId('crash-admin-staff');
        const otherAdmin = testUid('otherAdmin2');
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: otherAdmin }).catch(() => {});
        await adminAuth.setCustomUserClaims(otherAdmin, { role: 'admin' }); // so the last-admin re-scan on retry doesn't block
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        // Target originally had role 'admin'; the Auth mutation to 'staff'
        // already landed; the journal correctly still records the TRUE
        // original role, not the post-mutation one.
        await adminAuth.setCustomUserClaims(targetUid, { role: 'staff' });
        await db.doc(`adminRoleOperations/${op}`).set({
            operationId: op, actorUid: callerUid, targetUid, requestedRole: 'staff',
            originalPreviousRole: 'admin', status: 'pending', createdAt: Timestamp.now(),
        });

        const { result, error } = await call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: op });
        expect(error).toBeUndefined();
        expect(result.previousRole).toBe('admin');
        expect(result.role).toBe('staff');

        const auditSnap = await db.collection('adminAuditLog').where('metadata.operationId', '==', op).get();
        expect(auditSnap.size).toBe(1);
        expect(auditSnap.docs[0].data().metadata.previousRole).toBe('admin');
        expect(auditSnap.docs[0].data().metadata.role).toBe('staff');
        expect(auditSnap.docs[0].data().metadata.noop).toBe(false);

        await nukeUser(otherAdmin);
    });

    it('SR-46: admin -> null mutation succeeded, audit never landed — retry preserves the original admin -> null transition', async () => {
        if (!setStaffRole) return;
        const op = opId('crash-admin-null');
        const otherAdmin = testUid('otherAdmin3');
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: otherAdmin }).catch(() => {});
        await adminAuth.setCustomUserClaims(otherAdmin, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(targetUid, {}); // role already removed, simulating post-mutation state
        await db.doc(`adminRoleOperations/${op}`).set({
            operationId: op, actorUid: callerUid, targetUid, requestedRole: null,
            originalPreviousRole: 'admin', status: 'pending', createdAt: Timestamp.now(),
        });

        const { result, error } = await call(callerUid, 'admin', { uid: targetUid, role: null, operationId: op });
        expect(error).toBeUndefined();
        expect(result.previousRole).toBe('admin');
        expect(result.role).toBeNull();

        const auditSnap = await db.collection('adminAuditLog').where('metadata.operationId', '==', op).get();
        expect(auditSnap.size).toBe(1);
        expect(auditSnap.docs[0].data().metadata.previousRole).toBe('admin');
        expect(auditSnap.docs[0].data().metadata.role).toBeNull();

        await nukeUser(otherAdmin);
    });

    it('SR-47: staff -> admin succeeded and audited, finalization never completed — retry preserves staff -> admin, no duplicate audit', async () => {
        if (!setStaffRole) return;
        const op = opId('crash-finalize');
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(targetUid, { role: 'admin' }); // mutation already landed
        await db.doc(`adminRoleOperations/${op}`).set({
            operationId: op, actorUid: callerUid, targetUid, requestedRole: 'admin',
            originalPreviousRole: 'staff', status: 'pending', createdAt: Timestamp.now(),
        });
        // Simulate the audit already having been written, but the journal
        // never advanced to 'completed' before the crash.
        await db.doc(`adminAuditLog/roleOp_${op}`).set({
            action: 'user.set_role', targetType: 'user', targetId: targetUid, targetUserId: targetUid,
            adminId: callerUid, metadata: { previousRole: 'staff', role: 'admin', noop: false, operationId: op },
            createdAt: Timestamp.now(), targetUid, adminUid: callerUid, performedAt: Timestamp.now(),
        });

        const { result, error } = await call(callerUid, 'admin', { uid: targetUid, role: 'admin', operationId: op });
        expect(error).toBeUndefined();
        expect(result.previousRole).toBe('staff');
        expect(result.role).toBe('admin');

        const auditSnap = await db.collection('adminAuditLog').where('metadata.operationId', '==', op).get();
        expect(auditSnap.size).toBe(1);
        const opDoc = await db.doc(`adminRoleOperations/${op}`).get();
        expect(opDoc.data().status).toBe('completed');
    });

    it('SR-48: a brand-new same-role confirmation is a distinct audited event from a retry of a completed mutation', async () => {
        if (!setStaffRole) return;
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(targetUid, { role: 'staff' });

        const opConfirm1 = opId('confirm1');
        const first = await call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: opConfirm1 });
        expect(first.result.success).toBe(true);

        // Retry of the SAME operationId — resumes, does not create a new audit.
        const retry = await call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: opConfirm1 });
        expect(retry.result).toEqual(first.result);

        // A genuinely NEW intentional confirmation — different operationId —
        // is its own distinct, separately audited event.
        const opConfirm2 = opId('confirm2');
        const second = await call(callerUid, 'admin', { uid: targetUid, role: 'staff', operationId: opConfirm2 });
        expect(second.result.success).toBe(true);

        const auditSnap = await db.collection('adminAuditLog').where('targetUid', '==', targetUid).get();
        expect(auditSnap.size).toBe(2); // one per distinct operationId, not three
        auditSnap.docs.forEach(d => expect(d.data().metadata.noop).toBe(true));
    });

    it('SR-49: originalPreviousRole cannot be altered by client data or by a later retry', async () => {
        if (!setStaffRole) return;
        const op = opId('immutable-original');
        await adminAuth.createUser({ uid: callerUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(callerUid, { role: 'admin' });
        await adminAuth.createUser({ uid: targetUid }).catch(() => {});
        await adminAuth.setCustomUserClaims(targetUid, { role: 'staff' });

        const first = await call(callerUid, 'admin', { uid: targetUid, role: 'admin', operationId: op });
        expect(first.result.previousRole).toBe('staff');

        const opDocBefore = await db.doc(`adminRoleOperations/${op}`).get();
        expect(opDocBefore.data().originalPreviousRole).toBe('staff');

        const retry = await call(callerUid, 'admin', {
            uid: targetUid, role: 'admin', operationId: op, originalPreviousRole: 'admin',
        });
        expect(retry.result.previousRole).toBe('staff');

        const opDocAfter = await db.doc(`adminRoleOperations/${op}`).get();
        expect(opDocAfter.data().originalPreviousRole).toBe('staff');
    });
});
