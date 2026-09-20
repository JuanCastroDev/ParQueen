'use strict';

/**
 * §5 — checkRateLimit integration tests (Firestore emulator).
 *
 * Tests the real Firestore transaction path: counter increment, limit
 * enforcement, TTL field, doc-ID format, isolation across users/operations,
 * and concurrent-request serialization.
 *
 * Run via:  npm run test:functions
 * Emulators required: functions (5001), firestore (8080)
 *
 * checkRateLimit is called directly (not through HTTP) so we can control
 * uid/operation/limit without needing live callable endpoints.
 */

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');

const { requireEmulatorProjectId } = require('./emulatorProjectId');
const PROJECT_ID = requireEmulatorProjectId();
const APP_NAME = '__rateLimiter_intg__';

// Named app for reading test state from Firestore
const testApp =
    getApps().find(a => a.name === APP_NAME) ??
    initializeApp({ projectId: PROJECT_ID }, APP_NAME);

const db = getFirestore(testApp);

// Load index.js so initializeApp() runs for the default app.
// checkRateLimit calls getFirestore() against the default app, which connects
// to the Firestore emulator via FIRESTORE_EMULATOR_HOST.
let checkRateLimit, windowKey;
try {
    require('./index.js');
    ({ checkRateLimit, windowKey } = require('./rateLimiter'));
} catch (e) {
    console.warn('[rateLimiter intg] could not load functions:', e.message);
}

// Each test run uses a unique UID suffix so parallel runs don't share windows.
const RUN = String(process.pid) + '_' + String(Math.trunc(Date.now() / 1000));
function uid(label) { return `rl_${label}_${RUN}`; }

async function getRLDoc(operation, uidStr, windowSec = 3600) {
    const wk = windowKey(Date.now(), windowSec);
    const docId = `${operation}_${wk}_${uidStr}`;
    const snap = await db.collection('rateLimits').doc(docId).get();
    return snap.exists ? { id: docId, ...snap.data() } : null;
}

async function nukeRLDocs(operation, uidStr, windowSec = 3600) {
    const wk = windowKey(Date.now(), windowSec);
    await db.collection('rateLimits').doc(`${operation}_${wk}_${uidStr}`).delete().catch(() => {});
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe('§5 — checkRateLimit (Firestore emulator)', () => {
    const OP = 'testOp';
    const LIMIT = 3;
    const WIN = 3600;

    afterEach(async () => {
        // Best-effort cleanup — leftover docs don't bleed between windows anyway
    });

    // ── basic success / failure ───────────────────────────────────────────────

    it('RL-1: first call within window succeeds', async () => {
        await expect(checkRateLimit(uid('rl1'), OP, { limit: LIMIT, windowSec: WIN })).resolves.toBeUndefined();
    });

    it('RL-2: Nth call (at the limit) succeeds', async () => {
        const u = uid('rl2');
        for (let i = 0; i < LIMIT - 1; i++) {
            await checkRateLimit(u, OP, { limit: LIMIT, windowSec: WIN });
        }
        await expect(checkRateLimit(u, OP, { limit: LIMIT, windowSec: WIN })).resolves.toBeUndefined();
    });

    it('RL-3: (N+1)th call throws resource-exhausted', async () => {
        const u = uid('rl3');
        for (let i = 0; i < LIMIT; i++) {
            await checkRateLimit(u, OP, { limit: LIMIT, windowSec: WIN });
        }
        await expect(checkRateLimit(u, OP, { limit: LIMIT, windowSec: WIN }))
            .rejects.toMatchObject({ code: 'resource-exhausted' });
    });

    it('RL-4: error message is user-facing (not an internal stack trace)', async () => {
        const u = uid('rl4');
        for (let i = 0; i < LIMIT; i++) await checkRateLimit(u, OP, { limit: LIMIT, windowSec: WIN });
        try {
            await checkRateLimit(u, OP, { limit: LIMIT, windowSec: WIN });
            throw new Error('expected throw');
        } catch (e) {
            expect(e.message).toMatch(/too many requests/i);
        }
    });

    // ── Firestore doc structure ───────────────────────────────────────────────

    it('RL-5: rateLimits doc exists after first call', async () => {
        const u = uid('rl5');
        await checkRateLimit(u, OP, { limit: LIMIT, windowSec: WIN });
        const data = await getRLDoc(OP, u, WIN);
        expect(data).not.toBeNull();
    });

    it('RL-6: count field increments correctly', async () => {
        const u = uid('rl6');
        await checkRateLimit(u, OP, { limit: LIMIT, windowSec: WIN });
        await checkRateLimit(u, OP, { limit: LIMIT, windowSec: WIN });
        const data = await getRLDoc(OP, u, WIN);
        expect(data.count).toBe(2);
    });

    it('RL-7: uid field recorded on doc', async () => {
        const u = uid('rl7');
        await checkRateLimit(u, OP, { limit: LIMIT, windowSec: WIN });
        const data = await getRLDoc(OP, u, WIN);
        expect(data.uid).toBe(u);
    });

    it('RL-8: operation field recorded on doc', async () => {
        const u = uid('rl8');
        await checkRateLimit(u, OP, { limit: LIMIT, windowSec: WIN });
        const data = await getRLDoc(OP, u, WIN);
        expect(data.operation).toBe(OP);
    });

    it('RL-9: expiresAt field is set on doc', async () => {
        const u = uid('rl9');
        await checkRateLimit(u, OP, { limit: LIMIT, windowSec: WIN });
        const data = await getRLDoc(OP, u, WIN);
        expect(data.expiresAt).toBeTruthy();
    });

    it('RL-10: expiresAt is after the current window boundary', async () => {
        const u = uid('rl10');
        const nowMs = Date.now();
        await checkRateLimit(u, OP, { limit: LIMIT, windowSec: WIN });
        const data = await getRLDoc(OP, u, WIN);
        const expiresMs = data.expiresAt.toMillis();
        const windowEndMs = (windowKey(nowMs, WIN) + 1) * WIN * 1000;
        expect(expiresMs).toBeGreaterThan(windowEndMs);
    });

    it('RL-11: expiresAt is within 2× window from call time', async () => {
        const u = uid('rl11');
        const before = Date.now();
        await checkRateLimit(u, OP, { limit: LIMIT, windowSec: WIN });
        const data = await getRLDoc(OP, u, WIN);
        const expiresMs = data.expiresAt.toMillis();
        const maxTTL = before + WIN * 2000 + 2000; // +2s tolerance
        expect(expiresMs).toBeLessThanOrEqual(maxTTL);
    });

    it('RL-12: doc ID format is {operation}_{windowKey}_{uid}', async () => {
        const u = uid('rl12');
        const nowMs = Date.now();
        const wk = windowKey(nowMs, WIN);
        await checkRateLimit(u, OP, { limit: LIMIT, windowSec: WIN });
        const data = await getRLDoc(OP, u, WIN);
        expect(data.id).toBe(`${OP}_${wk}_${u}`);
    });

    // ── isolation ─────────────────────────────────────────────────────────────

    it('RL-13: separate users have independent limits', async () => {
        const uA = uid('rl13a');
        const uB = uid('rl13b');
        // Fill A to limit
        for (let i = 0; i < LIMIT; i++) await checkRateLimit(uA, OP, { limit: LIMIT, windowSec: WIN });
        // B should still have a fresh limit
        await expect(checkRateLimit(uB, OP, { limit: LIMIT, windowSec: WIN })).resolves.toBeUndefined();
    });

    it('RL-14: separate operations have independent limits', async () => {
        const u = uid('rl14');
        // Fill OP to limit
        for (let i = 0; i < LIMIT; i++) await checkRateLimit(u, OP, { limit: LIMIT, windowSec: WIN });
        // Different operation should have a fresh limit
        await expect(checkRateLimit(u, 'otherOp', { limit: LIMIT, windowSec: WIN })).resolves.toBeUndefined();
    });

    it('RL-15: different windowSec values produce different doc IDs (independent counters)', async () => {
        const u = uid('rl15');
        const nowMs = Date.now();
        const wk60 = windowKey(nowMs, 60);
        const wk3600 = windowKey(nowMs, 3600);
        await checkRateLimit(u, OP, { limit: 1, windowSec: 60 });
        // 60s window is exhausted; 3600s window is still fresh
        await expect(checkRateLimit(u, OP, { limit: 1, windowSec: 3600 })).resolves.toBeUndefined();
        expect(`${OP}_${wk60}_${u}`).not.toBe(`${OP}_${wk3600}_${u}`);
    });

    it('RL-16: HMAC-style email hash as uid is isolated from UID-keyed limit', async () => {
        const u = uid('rl16_uid');
        const emailHash = 'hmac_sha256_aaabbbccc'; // simulated HMAC hash
        // Exhaust email-hash limit
        for (let i = 0; i < LIMIT; i++) {
            await checkRateLimit(emailHash, 'generateEmailOTP_email', { limit: LIMIT, windowSec: WIN });
        }
        await expect(
            checkRateLimit(emailHash, 'generateEmailOTP_email', { limit: LIMIT, windowSec: WIN }),
        ).rejects.toMatchObject({ code: 'resource-exhausted' });
        // UID-keyed limit is unaffected
        await expect(
            checkRateLimit(u, 'generateEmailOTP', { limit: LIMIT, windowSec: WIN }),
        ).resolves.toBeUndefined();
    });

    // ── concurrent requests ───────────────────────────────────────────────────

    it('RL-17: concurrent requests: exactly LIMIT succeed, the rest are rejected', async () => {
        const u = uid('rl17');
        const CONC_LIMIT = 3;
        const TOTAL = CONC_LIMIT + 2;
        const results = await Promise.allSettled(
            Array.from({ length: TOTAL }, () =>
                checkRateLimit(u, OP, { limit: CONC_LIMIT, windowSec: WIN }),
            ),
        );
        const fulfilled = results.filter(r => r.status === 'fulfilled').length;
        const rejected = results.filter(r => r.status === 'rejected').length;
        expect(fulfilled).toBe(CONC_LIMIT);
        expect(rejected).toBe(TOTAL - CONC_LIMIT);
    });

    it('RL-18: concurrent requests: count equals LIMIT after race', async () => {
        const u = uid('rl18');
        const CONC_LIMIT = 4;
        await Promise.allSettled(
            Array.from({ length: CONC_LIMIT + 3 }, () =>
                checkRateLimit(u, OP, { limit: CONC_LIMIT, windowSec: WIN }),
            ),
        );
        const data = await getRLDoc(OP, u, WIN);
        expect(data.count).toBe(CONC_LIMIT);
    });

    // ── window boundary ───────────────────────────────────────────────────────

    it('RL-19: a very short window (1 s) uses its own doc separate from longer windows', async () => {
        const u = uid('rl19');
        const SHORT_WIN = 1;
        await checkRateLimit(u, OP, { limit: 1, windowSec: SHORT_WIN });
        // Short window is now at limit; 3600s window is untouched
        await expect(checkRateLimit(u, OP, { limit: 1, windowSec: WIN })).resolves.toBeUndefined();
    });

    it('RL-20: limit=1 permits exactly one call', async () => {
        const u = uid('rl20');
        await expect(checkRateLimit(u, OP, { limit: 1, windowSec: WIN })).resolves.toBeUndefined();
        await expect(checkRateLimit(u, OP, { limit: 1, windowSec: WIN }))
            .rejects.toMatchObject({ code: 'resource-exhausted' });
    });
});
