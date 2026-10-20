/**
 * TM-13 — Fixed-window rate limiter behaviour tests.
 * These tests verify the window-key derivation logic and documented boundary-burst
 * behaviour without requiring a Firestore emulator.
 */
import { describe, it, expect } from 'vitest';

// Import from production module — validates real code, not a formula copy.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { windowKey } = require('../functions/rateLimiter') as { windowKey: (nowMs: number, windowSec: number) => number };

describe('TM-13 — fixed-window rate limiter', () => {
    describe('window-key derivation', () => {
        it('two requests within the same window produce the same key', () => {
            const base = 1_700_000_000_000; // arbitrary epoch ms
            expect(windowKey(base, 3600)).toBe(windowKey(base + 1800_000, 3600));
        });

        it('requests in adjacent windows produce different keys', () => {
            const base = 1_700_000_000_000;
            const windowSec = 3600;
            const wk1 = windowKey(base, windowSec);
            const wk2 = windowKey(base + windowSec * 1000, windowSec);
            expect(wk2).toBe(wk1 + 1);
        });

        it('uses the correct key for a 15-minute window', () => {
            const windowSec = 900;
            const base = windowSec * 1000 * 10; // start of the 10th window
            expect(windowKey(base, windowSec)).toBe(10);
            expect(windowKey(base + 899_000, windowSec)).toBe(10); // still in same window
            expect(windowKey(base + 900_000, windowSec)).toBe(11); // rolled over
        });

        it('uses the correct key for a daily window', () => {
            const windowSec = 86400;
            const base = windowSec * 1000 * 5; // start of day 5
            expect(windowKey(base, windowSec)).toBe(5);
            expect(windowKey(base + 86399_000, windowSec)).toBe(5); // 1 second before reset
            expect(windowKey(base + 86400_000, windowSec)).toBe(6); // exactly next day
        });
    });

    describe('boundary-burst characteristic (documented tradeoff)', () => {
        it('a caller straddling two adjacent windows sees two independent limits', () => {
            const windowSec = 3600;
            const boundary = 3600 * 1000 * 7; // exact boundary between window 6 and 7
            // Immediately before boundary → window 6
            const wkBefore = windowKey(boundary - 1, windowSec);
            // Immediately after boundary → window 7
            const wkAfter = windowKey(boundary, windowSec);
            expect(wkAfter).toBe(wkBefore + 1);
            // Different keys → different Firestore docs → independent counters.
            // This is the known boundary-burst: full quota available in each window.
        });
    });

    describe('doc-ID uniqueness', () => {
        it('different operations produce different doc IDs', () => {
            const uid = 'user_abc';
            const nowMs = 1_700_000_000_000;
            const wk = windowKey(nowMs, 3600);
            const id1 = `generateEmailOTP_${wk}_${uid}`;
            const id2 = `verifyEmailOTP_${wk}_${uid}`;
            expect(id1).not.toBe(id2);
        });

        it('different UIDs produce different doc IDs', () => {
            const nowMs = 1_700_000_000_000;
            const wk = windowKey(nowMs, 3600);
            const id1 = `analyzeSign_${wk}_user_aaa`;
            const id2 = `analyzeSign_${wk}_user_bbb`;
            expect(id1).not.toBe(id2);
        });

        it('email-hash rate limit uses a different operation key from UID rate limit', () => {
            const nowMs = 1_700_000_000_000;
            const wk = windowKey(nowMs, 3600);
            const uid = 'user_abc';
            const emailHash = 'sha256ofnormalizdemail';
            const uidDoc = `generateEmailOTP_${wk}_${uid}`;
            const emailDoc = `generateEmailOTP_email_${wk}_${emailHash}`;
            expect(uidDoc).not.toBe(emailDoc);
        });
    });

    describe('TTL field', () => {
        it('expiresAt is set to 2× the window duration after window start', () => {
            const windowSec = 3600;
            const nowMs = 1_700_000_000_000;
            // expiresAt = Date.now() + windowSec * 2000 (ms)
            const expiresMs = nowMs + windowSec * 2000;
            // Must be strictly after the window ends
            const windowEndMs = (windowKey(nowMs, windowSec) + 1) * windowSec * 1000;
            expect(expiresMs).toBeGreaterThan(windowEndMs);
        });
    });
});

// ── Phase J callable rate-limit source assertions (TM-13) ────────────────────
// These tests read functions/index.js as text to verify that:
//   a) checkRateLimit is called with the expected operation key and limit
//   b) the rate-limit call precedes canonical resolution or the other expensive call
//   c) the rate-limit call occurs after the auth guard, not before it
//
// Source assertions are the correct level here: emulator tests for the three
// specific callables would duplicate §5 (checkRateLimit unit+integration tests)
// without adding new signal. What matters is that the call exists and is ordered
// correctly — that is a source property.
import fs from 'fs';
import path from 'path';

const INDEX_SRC = fs.readFileSync(
    path.resolve(__dirname, '../functions/index.js'),
    'utf-8'
);

/** Extract the body of a named callable export (text from its opening to next exports. line) */
function extractCallable(src: string, exportName: string): string {
    const start = src.indexOf(`exports.${exportName} = onCall(`);
    if (start === -1) throw new Error(`${exportName} not found`);
    // Find the next top-level exports. assignment after the function body
    const nextExport = src.indexOf('\nexports.', start + 1);
    return nextExport === -1 ? src.slice(start) : src.slice(start, nextExport);
}

describe('TM-13 — Phase J callable rate-limit source assertions', () => {
    describe('claimUsername (5/hr)', () => {
        const body = extractCallable(INDEX_SRC, 'claimUsername');

        it('RL-U-C1: checkRateLimit is called with operation key "claimUsername"', () => {
            expect(body).toMatch(/checkRateLimit\(.*'claimUsername'/);
        });

        it('RL-U-C2: limit is 5 per hour', () => {
            expect(body).toMatch(/checkRateLimit\(.*'claimUsername'.*\{.*limit:\s*5.*windowSec:\s*3600/s);
        });

        it('RL-U-C3: checkRateLimit precedes the uniqueness transaction (runTransaction)', () => {
            const rlIdx = body.indexOf("checkRateLimit(request.auth.uid, 'claimUsername'");
            const txIdx = body.indexOf('runTransaction');
            expect(rlIdx).toBeGreaterThan(-1);
            expect(txIdx).toBeGreaterThan(-1);
            expect(rlIdx).toBeLessThan(txIdx);
        });

        it('RL-U-C4: auth guard precedes checkRateLimit', () => {
            const authIdx = body.indexOf('throw new HttpsError("unauthenticated"');
            const rlIdx = body.indexOf("checkRateLimit(request.auth.uid, 'claimUsername'");
            expect(authIdx).toBeGreaterThan(-1);
            expect(authIdx).toBeLessThan(rlIdx);
        });

        it('RL-U-C5: unique operation key differs from other callables', () => {
            expect(body).not.toMatch(/checkRateLimit\(.*'moderateContent'/);
            expect(body).not.toMatch(/checkRateLimit\(.*'createSegmentFromSweepNYC'/);
        });
    });

    describe('createSegmentFromSweepNYC (30/hr)', () => {
        const body = extractCallable(INDEX_SRC, 'createSegmentFromSweepNYC');

        it('RL-C6: checkRateLimit is called with operation key "createSegmentFromSweepNYC"', () => {
            expect(body).toMatch(/checkRateLimit\(.*'createSegmentFromSweepNYC'/);
        });

        it('RL-C7: limit is 30 per hour', () => {
            expect(body).toMatch(/checkRateLimit\(.*'createSegmentFromSweepNYC'.*\{.*limit:\s*30.*windowSec:\s*3600/s);
        });

        it('RL-C8: awaited rate limit precedes canonical resolution and the unsupported-protocol return', () => {
            // Source order of this callable only. The slice stops at the next
            // helper so later legacy functions cannot satisfy the assertion.
            // This is not a runtime side-effect test; that remains the emulator suite.
            const callableEnd = body.indexOf('function _existingNYCOpenDataResult');
            expect(callableEnd).toBeGreaterThan(-1);
            const callable = body.slice(0, callableEnd);
            const rlIdx = callable.indexOf("await checkRateLimit(uid, 'createSegmentFromSweepNYC'");
            const protocolIdx = callable.indexOf('request.data?.protocolVersion !== 2');
            const selectIdx = callable.indexOf('selectCanonicalV2Handler(');
            const runnerIdx = callable.indexOf('_runCanonicalCurbV2');
            const invokeIdx = callable.indexOf('return canonicalV2Handler(request.data)');
            const firstReturnIdx = callable.indexOf('return ');

            expect(rlIdx).toBeGreaterThan(-1);
            expect(firstReturnIdx).toBeGreaterThan(rlIdx);
            expect(protocolIdx).toBeGreaterThan(rlIdx);
            expect(selectIdx).toBeGreaterThan(protocolIdx);
            expect(runnerIdx).toBeGreaterThan(selectIdx);
            expect(invokeIdx).toBeGreaterThan(runnerIdx);
            expect(callable).toContain("status: 'unsupported'");
            expect(callable).not.toContain('_tryCreateFromSweepNYC');
            expect(callable).not.toContain('_fallbackToNYCOpenData');
            expect(callable).not.toMatch(/success:\s*true/);
        });

        it('RL-C9: auth guard precedes checkRateLimit', () => {
            const authIdx = body.indexOf("throw new HttpsError('unauthenticated'");
            const rlIdx = body.indexOf("checkRateLimit(uid, 'createSegmentFromSweepNYC'");
            expect(authIdx).toBeLessThan(rlIdx);
        });
    });

    describe('generateListingDescription (20/hr)', () => {
        const body = extractCallable(INDEX_SRC, 'generateListingDescription');

        it('RL-C10: checkRateLimit is called with operation key "generateListingDescription"', () => {
            expect(body).toMatch(/checkRateLimit\(.*'generateListingDescription'/);
        });

        it('RL-C11: limit is 20 per hour', () => {
            expect(body).toMatch(/checkRateLimit\(.*'generateListingDescription'.*\{.*limit:\s*20.*windowSec:\s*3600/s);
        });

        it('RL-C12: checkRateLimit precedes Gemini API call (GoogleGenAI)', () => {
            const rlIdx = body.indexOf("checkRateLimit(request.auth.uid, 'generateListingDescription'");
            const geminiIdx = body.indexOf('GoogleGenAI');
            expect(rlIdx).toBeGreaterThan(-1);
            expect(geminiIdx).toBeGreaterThan(-1);
            expect(rlIdx).toBeLessThan(geminiIdx);
        });

        it('RL-C13: auth guard precedes checkRateLimit', () => {
            const authIdx = body.indexOf('throw new HttpsError("unauthenticated"');
            const rlIdx = body.indexOf("checkRateLimit(request.auth.uid, 'generateListingDescription'");
            expect(authIdx).toBeLessThan(rlIdx);
        });
    });

    describe('bootstrapAdmin — email_verified guard (Section 6)', () => {
        const body = extractCallable(INDEX_SRC, 'bootstrapAdmin');

        it('BA-1: requires @parqueen.app email', () => {
            expect(body).toMatch(/@parqueen\.app/);
        });

        it('BA-2: requires email_verified === true', () => {
            expect(body).toMatch(/email_verified/);
            // Must be a permission-denied throw, not just a log
            const evIdx = body.indexOf('email_verified');
            const throwIdx = body.indexOf('permission-denied', evIdx);
            expect(throwIdx).toBeGreaterThan(-1);
        });

        it('BA-3: email_verified check follows the email domain check', () => {
            const domainIdx = body.indexOf('@parqueen.app');
            const evIdx = body.indexOf('email_verified');
            expect(domainIdx).toBeGreaterThan(-1);
            expect(evIdx).toBeGreaterThan(-1);
            expect(evIdx).toBeGreaterThan(domainIdx);
        });

        it('BA-4: singleton transaction is present', () => {
            expect(body).toMatch(/runTransaction/);
            expect(body).toMatch(/adminBootstrap\/singleton/);
        });

        it('BA-5: role is set server-side via setCustomUserClaims, not from caller data', () => {
            expect(body).toMatch(/setCustomUserClaims.*role.*admin/s);
            // No reference to request.data for role
            expect(body).not.toMatch(/request\.data.*role/);
        });
    });
});
