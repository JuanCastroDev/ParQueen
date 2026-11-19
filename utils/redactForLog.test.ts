/**
 * TM-17 — Direct tests for functions/redactForLog.js.
 * Tests the server helper against the same fixture set used for client reasoning,
 * preventing silent drift between the two implementations.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { redactForLog } = require(path.resolve('./functions/redactForLog.js'));

describe('TM-17 — redactForLog server helper', () => {
    it('redacts sensitive keys', () => {
        const r = redactForLog({ email: 'a@b.com', fcmToken: 'tok', username: 'alice' });
        expect(r.email).toBe('[REDACTED]');
        expect(r.fcmToken).toBe('[REDACTED]');
        expect(r.username).toBe('alice');
    });

    it('passes through non-sensitive scalars', () => {
        expect(redactForLog({ crowns: 5, username: 'bob', status: 'active' }))
            .toEqual({ crowns: 5, username: 'bob', status: 'active' });
    });

    it('shallow mode does not redact nested objects', () => {
        const r = redactForLog({ meta: { email: 'a@b.com', crowns: 5 } });
        expect(r.meta).toEqual({ email: 'a@b.com', crowns: 5 }); // nested untouched
    });

    it('deep=true redacts nested sensitive keys', () => {
        const r = redactForLog({ meta: { email: 'a@b.com', crowns: 5 } }, true);
        expect(r.meta.email).toBe('[REDACTED]');
        expect(r.meta.crowns).toBe(5);
    });

    it('returns non-objects unchanged', () => {
        expect(redactForLog(null)).toBeNull();
        expect(redactForLog('string')).toBe('string');
        expect(redactForLog(42)).toBe(42);
        expect(redactForLog([1, 2])).toEqual([1, 2]);
    });

    it('redacts all SENSITIVE regex variants', () => {
        const obj = {
            phone: '555', email: 'x', token: 't', fcm: 'f',
            lat: 1, lng: 2, lon: 3, coordinate: [0, 0],
            message: 'hi', body: 'b', text: 't', content: 'c',
            prompt: 'p', response: 'r', reply: 'x', password: 'pw',
            secret: 's', credential: 'c', apikey: 'k', api_key: 'k2',
            auth: 'a', otp: '123456', code: '654321',
        };
        const r = redactForLog(obj);
        for (const key of Object.keys(obj)) {
            expect(r[key], `key '${key}' should be redacted`).toBe('[REDACTED]');
        }
    });

    it('does not mutate the input object', () => {
        const input = { email: 'a@b.com', crowns: 5 };
        redactForLog(input);
        expect(input.email).toBe('a@b.com');
    });
});

// ─── §7: utils/redactForLog.ts (TypeScript client version) ───────────────────
// Tests the TypeScript implementation directly via ESM import.
// The TS version has the same SENSITIVE regex but no null guard
// (TypeScript enforces T extends object at compile time).
import { redactForLog as redactTs } from './redactForLog';

describe('§7 — utils/redactForLog.ts (TypeScript version)', () => {
    it('redacts the same sensitive keys as the JS version', () => {
        const r = redactTs({ email: 'a@b.com', fcmToken: 'tok', username: 'alice' });
        expect(r.email).toBe('[REDACTED]');
        expect(r.fcmToken).toBe('[REDACTED]');
        expect(r.username).toBe('alice');
    });

    it('passes through non-sensitive scalars', () => {
        expect(redactTs({ crowns: 5, status: 'active', username: 'bob' }))
            .toEqual({ crowns: 5, status: 'active', username: 'bob' });
    });

    it('shallow mode does not redact nested objects', () => {
        const r = redactTs({ meta: { email: 'a@b.com', crowns: 5 } });
        expect(r.meta).toEqual({ email: 'a@b.com', crowns: 5 });
    });

    it('deep=true redacts nested sensitive keys', () => {
        const r = redactTs({ meta: { email: 'a@b.com', crowns: 5 } }, true);
        expect((r.meta as { email: string }).email).toBe('[REDACTED]');
    });

    it('does not mutate the input object', () => {
        const input = { email: 'x@y.com', crowns: 3 };
        redactTs(input);
        expect(input.email).toBe('x@y.com');
    });

    it('redacts all SENSITIVE regex variants (mirrors JS version)', () => {
        const obj = {
            phone: '555', email: 'x', token: 't', fcm: 'f',
            lat: 1, lng: 2, lon: 3, coordinate: [0, 0],
            message: 'hi', body: 'b', text: 't', content: 'c',
            prompt: 'p', response: 'r', reply: 'x', password: 'pw',
            secret: 's', credential: 'c', apikey: 'k', api_key: 'k2',
            auth: 'a', otp: '123456', code: '654321',
        };
        const r = redactTs(obj);
        for (const key of Object.keys(obj)) {
            expect(r[key as keyof typeof obj], `key '${key}' should be redacted`).toBe('[REDACTED]');
        }
    });

    it('Vision API error pattern: message is redacted, status passes through', () => {
        // Mirrors the call site added in functions/index.js for moderateAvatarUpload
        const errorLike = { name: 'Error', message: 'RESOURCE_EXHAUSTED: quota exceeded', status: 429 };
        const r = redactTs(errorLike);
        expect(r.name).toBe('Error');
        expect(r.message).toBe('[REDACTED]'); // message key is in SENSITIVE regex
        expect(r.status).toBe(429);
    });
});

// ─── §7: static call-site assertion ──────────────────────────────────────────
import { readFileSync } from 'node:fs';

describe('§7 — redactForLog call-site audit', () => {
    const fnSrc = readFileSync(path.resolve('./functions/index.js'), 'utf-8');

    it('redactForLog is imported in functions/index.js', () => {
        expect(fnSrc).toMatch(/require.*redactForLog/);
    });

    it('sanitizeError or redactForLog is called at least once (not just imported)', () => {
        const callCount = (fnSrc.match(/(?:sanitizeError|redactForLog)\s*\(/g) || []).length;
        expect(callCount, 'a log sanitizer must have at least one call site').toBeGreaterThanOrEqual(1);
    });
});

// ─── §7: log-redaction regression (TM-17) ────────────────────────────────────
// Scans functions/index.js for console.error calls that pass raw error objects
// or .message/.stack properties instead of sanitizeError(). A violation here
// means structured log redaction was bypassed and error context (which may
// contain user data, stack paths, or API response bodies) reaches Cloud Logging.

describe('§7 — TM-17 log-redaction regression: no raw error in console.error', () => {
    const lines = readFileSync(path.resolve('./functions/index.js'), 'utf-8').split('\n');

    it('no console.error passes raw .message or .stack without sanitizeError', () => {
        const violations: string[] = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            if (!line.includes('console.error(')) continue;
            // Allow lines that go through an approved sanitizer
            if (/sanitizeError|redactForLog/.test(line)) continue;
            // Flag raw error property access
            if (/\b\w+\.(message|stack)\b/.test(line)) {
                violations.push(`line ${i + 1}: ${line.trim()}`);
            }
        }
        expect(violations, violations.join('\n')).toHaveLength(0);
    });

    it('sanitizeError is exported from functions/redactForLog.js', () => {
        const rfl = readFileSync(path.resolve('./functions/redactForLog.js'), 'utf-8');
        expect(rfl).toMatch(/sanitizeError/);
        expect(rfl).toMatch(/module\.exports.*sanitizeError/);
    });
});

// Issue #354: gRPC errors carry a numeric code; it used to be dropped.
describe('sanitizeError numeric gRPC codes', () => {
    const { sanitizeError } = require(path.resolve('./functions/redactForLog.js'));
    it('keeps an integer gRPC code', () => {
        expect(sanitizeError(Object.assign(new Error('secret detail'), { code: 3 }))).toBe('Error/3');
    });
    it('drops a non-integer numeric code', () => {
        expect(sanitizeError(Object.assign(new Error('x'), { code: 3.5 }))).toBe('Error');
    });
});
