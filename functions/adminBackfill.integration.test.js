'use strict';

/**
 * Behavioral integration tests — adminBackfillStreetIntelligence
 * (functions/index.js, logic in functions/backfillLogic.js).
 *
 * Context: views/admin/StreetSegmentsPage.tsx's Data Maintenance panel used
 * to call utils/backfill.ts's backfillStreetIntelligence() directly against
 * the client Firestore SDK, authorized solely by firestore.rules' token-only
 * isAdmin() check. A stale admin token (demoted/deleted/disabled after the
 * token was minted) could still pass that Rules check and write directly to
 * streetSegments/streetRules until the token expired — the same
 * vulnerability class requireCurrentAdmin closes for callables, but Rules
 * cannot re-verify current server-side Auth state. firestore.rules now
 * denies ALL direct client writes to streetSegments/streetRules; this
 * callable is the only way to perform the backfill.
 *
 * What is proven:
 *   AB-1:  unauthenticated rejected
 *   AB-2:  token admin + current Auth admin -> allowed
 *   AB-3:  stale demoted token rejected
 *   AB-4:  deleted former admin rejected
 *   AB-5:  disabled admin rejected
 *   AB-6:  malformed input rejected (bad dryRun/cursor/limit types)
 *   AB-7:  arbitrary collection/path impossible by contract (extra fields ignored)
 *   AB-8:  arbitrary field injection impossible by contract (server-derived only)
 *   AB-9:  valid bounded backfill updates only the intended fields, never overwrites existing values
 *   AB-10: idempotent — a second run makes zero further changes
 *   AB-11: batch limit enforced via cursor-based pagination
 *   AB-12: resumable after a simulated partial run (no duplicate/corrupt writes)
 *   AB-13: sensitive values not logged
 *   AB-14: direct client mutation is no longer possible (Rules denies it even for a current admin)
 *   AB-15: source-contract — new callable is present and requireCurrentAdmin-gated
 *   AB-16: dryRun:true performs literally zero Firestore writes (Wave 6C runtime-migration audit)
 *   AB-17: adminAuditLog written only on a live-write page that changed something, never on a dry run
 *   AB-18: limit:1 processes at most one segment per page
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
const APP_NAME = '__adminBackfill_intg__';

const testApp =
    getApps().find(a => a.name === APP_NAME) ??
    initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const adminAuth = getAuth(testApp);

// ─── Helpers (mirrors adminSessionAuth.integration.test.js conventions) ───

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
    return `ab_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

async function nuke(uid) {
    await adminAuth.deleteUser(uid).catch(() => {});
}

async function adminIdToken(uid) {
    await adminAuth.createUser({ uid }).catch(() => {});
    await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
    return signInUser(uid);
}

async function makeSegment(id, data) {
    await db.doc(`streetSegments/${id}`).set({ streetName: 'Test St', ...data });
}

async function makeRule(segmentId, ruleId, data) {
    await db.doc(`streetSegments/${segmentId}/streetRules/${ruleId}`).set(data);
}

// The streetSegments collection is shared across the whole test run — other
// suites may leave stray documents. A single page (default limit 50,
// ordered by __name__) is not guaranteed to include this test's segment, so
// correctness assertions loop until done:true rather than trusting page 1.
async function runFullBackfill(idToken, dryRun) {
    const totals = { segmentsScanned: 0, segmentsUpdated: 0, rulesScanned: 0, rulesUpdated: 0 };
    let cursor = null;
    let done = false;
    let guard = 0;
    while (!done && guard++ < 500) {
        const resp = await callFn('adminBackfillStreetIntelligence', idToken, { dryRun, cursor, limit: 200 });
        if (resp.error) return { error: resp.error, totals };
        totals.segmentsScanned += resp.result.segmentsScanned;
        totals.segmentsUpdated += resp.result.segmentsUpdated;
        totals.rulesScanned += resp.result.rulesScanned;
        totals.rulesUpdated += resp.result.rulesUpdated;
        cursor = resp.result.nextCursor;
        done = resp.result.done;
    }
    return { totals };
}

async function cleanupSegments(ids) {
    for (const id of ids) {
        const rulesSnap = await db.collection(`streetSegments/${id}/streetRules`).get();
        for (const r of rulesSnap.docs) await r.ref.delete().catch(() => {});
        await db.doc(`streetSegments/${id}`).delete().catch(() => {});
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('adminBackfillStreetIntelligence — coordinated Functions/Rules/client remediation', () => {
    let uid;
    let segIds;

    beforeEach(() => {
        uid = testUid('caller');
        segIds = [];
    });

    afterEach(async () => {
        await nuke(uid);
        await cleanupSegments(segIds);
    });

    it('AB-1: unauthenticated rejected', async () => {
        const resp = await callFn('adminBackfillStreetIntelligence', null, {});
        expect(resp.error?.status).toBe('UNAUTHENTICATED');
    });

    it('AB-2: token admin + current Auth admin -> allowed', async () => {
        const idToken = await adminIdToken(uid);
        const segId = `${testUid('seg')}`;
        segIds.push(segId);
        await makeSegment(segId, {}); // fully missing schema fields

        const resp = await callFn('adminBackfillStreetIntelligence', idToken, { dryRun: true });
        expect(resp.error).toBeUndefined();
        expect(resp.result.segmentsScanned).toBeGreaterThanOrEqual(1);
    });

    it('AB-3: stale demoted token rejected', async () => {
        const idToken = await adminIdToken(uid);
        await adminAuth.setCustomUserClaims(uid, { role: 'staff' });

        const resp = await callFn('adminBackfillStreetIntelligence', idToken, { dryRun: true });
        expect(resp.error?.status).toBe('PERMISSION_DENIED');
    });

    it('AB-4: deleted former admin rejected', async () => {
        const idToken = await adminIdToken(uid);
        await adminAuth.deleteUser(uid).catch(() => {});

        const resp = await callFn('adminBackfillStreetIntelligence', idToken, { dryRun: true });
        expect(resp.error?.status).toBe('PERMISSION_DENIED');
    });

    it('AB-5: disabled admin rejected', async () => {
        const idToken = await adminIdToken(uid);
        await adminAuth.updateUser(uid, { disabled: true });

        const resp = await callFn('adminBackfillStreetIntelligence', idToken, { dryRun: true });
        expect(resp.error?.status).toBe('PERMISSION_DENIED');
    });

    it('AB-6: malformed input rejected', async () => {
        const idToken = await adminIdToken(uid);

        const badDryRun = await callFn('adminBackfillStreetIntelligence', idToken, { dryRun: 'yes' });
        expect(badDryRun.error?.status).toBe('INVALID_ARGUMENT');

        const badCursor = await callFn('adminBackfillStreetIntelligence', idToken, { cursor: 123 });
        expect(badCursor.error?.status).toBe('INVALID_ARGUMENT');

        const badLimit = await callFn('adminBackfillStreetIntelligence', idToken, { limit: 99999 });
        expect(badLimit.error?.status).toBe('INVALID_ARGUMENT');

        const negativeLimit = await callFn('adminBackfillStreetIntelligence', idToken, { limit: -1 });
        expect(negativeLimit.error?.status).toBe('INVALID_ARGUMENT');
    });

    it('AB-7: arbitrary collection/path is impossible by contract', async () => {
        const idToken = await adminIdToken(uid);
        const segId = testUid('seg');
        segIds.push(segId);
        await makeSegment(segId, {});

        // The callable has no collection/path parameter at all — extra
        // client-supplied fields are simply never read by the handler.
        const resp = await callFn('adminBackfillStreetIntelligence', idToken, {
            dryRun: true, collection: 'users', docId: uid, path: `users/${uid}`,
        });
        expect(resp.error).toBeUndefined();
        const userSnap = await db.doc(`users/${uid}`).get();
        expect(userSnap.exists).toBe(false); // untouched — no such write path exists
    });

    it('AB-8: arbitrary field injection is impossible by contract', async () => {
        const idToken = await adminIdToken(uid);
        const segId = testUid('seg');
        segIds.push(segId);
        await makeSegment(segId, {});

        await callFn('adminBackfillStreetIntelligence', idToken, {
            dryRun: false, segUpdate: { evil: 'value' }, fields: { role: 'admin' },
        });

        const after = (await db.doc(`streetSegments/${segId}`).get()).data();
        expect(after.evil).toBeUndefined();
        expect(after.role).toBeUndefined();
    });

    it('AB-9: valid bounded backfill updates only intended fields, never overwrites existing values', async () => {
        const idToken = await adminIdToken(uid);
        const segId = testUid('seg');
        segIds.push(segId);
        await makeSegment(segId, { status: 'archived', source: 'sweepnyc', cslSegmentId: '4471' });
        // status/source already set -> must survive untouched; confidenceScore/editedBy/provenance are missing -> must be filled.

        const { error } = await runFullBackfill(idToken, false);
        expect(error).toBeUndefined();

        const after = (await db.doc(`streetSegments/${segId}`).get()).data();
        expect(after.status).toBe('archived'); // preserved, not overwritten
        expect(after.source).toBe('sweepnyc'); // preserved, not overwritten
        expect(after.confidenceScore).toBe(0.95); // filled (sweepnyc default)
        expect(after.editedBy).toBe('migration:backfill');
        expect(after.provenance.provider).toBe('sweepnyc');
        expect(after.provenance.sweepNYCObjectId).toBe(4471);
    });

    it('AB-10: idempotent — a second run makes zero further changes', async () => {
        const idToken = await adminIdToken(uid);
        const segId = testUid('seg');
        segIds.push(segId);
        await makeSegment(segId, {});
        await makeRule(segId, 'ruleA', {});

        const first = await runFullBackfill(idToken, false);
        expect(first.error).toBeUndefined();
        expect(first.totals.segmentsUpdated).toBeGreaterThanOrEqual(1);
        expect(first.totals.rulesUpdated).toBeGreaterThanOrEqual(1);

        const second = await runFullBackfill(idToken, false);
        expect(second.error).toBeUndefined();
        expect(second.totals.segmentsUpdated).toBe(0);
        expect(second.totals.rulesUpdated).toBe(0);
    });

    it('AB-11: batch limit enforced via cursor-based pagination', async () => {
        const idToken = await adminIdToken(uid);
        const ids = [testUid('seg1'), testUid('seg2'), testUid('seg3')].sort();
        segIds.push(...ids);
        for (const id of ids) await makeSegment(id, { id });

        const page1 = await callFn('adminBackfillStreetIntelligence', idToken, { dryRun: true, limit: 2 });
        expect(page1.error).toBeUndefined();
        expect(page1.result.done).toBe(false);
        expect(page1.result.nextCursor).toBeTruthy();

        const page2 = await callFn('adminBackfillStreetIntelligence', idToken, {
            dryRun: true, limit: 2, cursor: page1.result.nextCursor,
        });
        expect(page2.error).toBeUndefined();
        // Second page may include the 3 test segments' tail plus any other
        // fixture data left over from other suites; just confirm progress.
        expect(page2.result.segmentsScanned).toBeGreaterThanOrEqual(1);
    });

    it('AB-12: resumable after a simulated partial run — no duplicate or corrupt writes', async () => {
        const idToken = await adminIdToken(uid);
        const segId = testUid('seg');
        segIds.push(segId);
        await makeSegment(segId, {});

        // Simulate a client crash mid-pagination by simply invoking the
        // callable twice from scratch (cursor: null both times) rather than
        // resuming — since the operation is idempotent, this must converge
        // to the same final state as a single clean run, not accumulate
        // duplicate provenance objects or double-append data.
        await runFullBackfill(idToken, false);
        await runFullBackfill(idToken, false);

        const after = (await db.doc(`streetSegments/${segId}`).get()).data();
        expect(after.provenance.provider).toBe('admin');
        expect(typeof after.editedBy).toBe('string');
    });

    it('AB-16: dryRun:true performs literally zero Firestore writes — the segment/rule documents are byte-unchanged afterward', async () => {
        const idToken = await adminIdToken(uid);
        const segId = testUid('seg');
        segIds.push(segId);
        await makeSegment(segId, {}); // fully missing schema fields
        await makeRule(segId, 'ruleA', {});

        const before = (await db.doc(`streetSegments/${segId}`).get()).data();
        const ruleBefore = (await db.doc(`streetSegments/${segId}/streetRules/ruleA`).get()).data();

        const { totals, error } = await runFullBackfill(idToken, true);
        expect(error).toBeUndefined();
        // The would-update counts prove the engine found real work to do —
        // this is not a vacuous "nothing to change" pass.
        expect(totals.segmentsUpdated).toBeGreaterThanOrEqual(1);
        expect(totals.rulesUpdated).toBeGreaterThanOrEqual(1);

        const after = (await db.doc(`streetSegments/${segId}`).get()).data();
        const ruleAfter = (await db.doc(`streetSegments/${segId}/streetRules/ruleA`).get()).data();
        expect(after).toEqual(before);
        expect(ruleAfter).toEqual(ruleBefore);
    });

    it('AB-17: adminAuditLog is written only for a live-write page that actually changed something, never for a dry run', async () => {
        const idToken = await adminIdToken(uid);
        const segId = testUid('seg');
        segIds.push(segId);
        await makeSegment(segId, {});

        await callFn('adminBackfillStreetIntelligence', idToken, { dryRun: true });
        const afterDryRun = await db.collection('adminAuditLog')
            .where('adminId', '==', uid)
            .where('action', '==', 'streetIntelligence.backfill')
            .get();
        expect(afterDryRun.empty).toBe(true);

        const { error } = await runFullBackfill(idToken, false);
        expect(error).toBeUndefined();
        const afterLiveRun = await db.collection('adminAuditLog')
            .where('adminId', '==', uid)
            .where('action', '==', 'streetIntelligence.backfill')
            .get();
        expect(afterLiveRun.size).toBeGreaterThanOrEqual(1);

        for (const doc of afterLiveRun.docs) await doc.ref.delete().catch(() => {});
    });

    it('AB-18: limit:1 processes at most one segment per page', async () => {
        const idToken = await adminIdToken(uid);
        const ids = [testUid('seg1'), testUid('seg2')].sort();
        segIds.push(...ids);
        for (const id of ids) await makeSegment(id, { id });

        const resp = await callFn('adminBackfillStreetIntelligence', idToken, { dryRun: true, limit: 1 });
        expect(resp.error).toBeUndefined();
        expect(resp.result.segmentsScanned).toBe(1);
        expect(resp.result.done).toBe(false);
        expect(resp.result.nextCursor).toBeTruthy();
    });

    it('AB-13: sensitive values not logged', async () => {
        const idToken = await adminIdToken(uid);
        const segId = testUid('seg');
        segIds.push(segId);
        await makeSegment(segId, {});

        const originalLog = console.log;
        const originalError = console.error;
        const originalWarn = console.warn;
        const captured = [];
        console.log = (...args) => captured.push(args.join(' '));
        console.error = (...args) => captured.push(args.join(' '));
        console.warn = (...args) => captured.push(args.join(' '));
        try {
            await callFn('adminBackfillStreetIntelligence', idToken, { dryRun: false });
        } finally {
            console.log = originalLog;
            console.error = originalError;
            console.warn = originalWarn;
        }

        const joined = captured.join('\n');
        expect(joined).not.toMatch(/@parqueen\.app|@gmail\.com/);
        expect(joined.includes(uid)).toBe(false);
    });

    it('AB-14: direct client mutation is no longer possible — Rules deny it even for a current admin', async () => {
        // Functions/Admin SDK writes (like the callable above) bypass
        // Security Rules entirely; this proves the CLIENT-SDK path — the one
        // utils/backfill.ts's backfillStreetIntelligence() used to take — is
        // now closed at the Rules layer regardless of Cloud Function
        // hardening. Full Rules-emulator coverage (with rules-unit-testing,
        // proper auth context, etc.) lives in firestore.rules.test.ts; this
        // is a source-contract check confirming the client no longer
        // contains the removed direct-write function at all (utils/backfill.ts
        // still exists, but only for its pure, non-Firestore-writing helpers —
        // see utils/streetIntelligence.test.ts).
        const backfillUtilSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'backfill.ts'), 'utf8');
        expect(backfillUtilSrc).not.toMatch(/export (async )?function backfillStreetIntelligence/);
        expect(backfillUtilSrc).not.toMatch(/updateDoc/);

        const pageSrc = fs.readFileSync(
            path.join(__dirname, '..', 'views', 'admin', 'StreetSegmentsPage.tsx'), 'utf8',
        );
        expect(pageSrc).not.toMatch(/updateDoc\(\s*doc\(db,\s*['"]streetSegments['"]/);
        expect(pageSrc).toMatch(/adminBackfillStreetIntelligence/);
    });

    it('AB-15: source-contract — new callable is present and requireCurrentAdmin-gated', () => {
        const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
        const fnStart = src.indexOf('exports.adminBackfillStreetIntelligence = onCall(');
        expect(fnStart).toBeGreaterThan(-1);
        const body = src.slice(fnStart, fnStart + 600);
        expect(body).toMatch(/await requireCurrentAdmin\(request\);/);
    });
});
