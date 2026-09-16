'use strict';

const { createHash } = require('crypto');
const waitlist = require('./waitlist');

const PEPPER = 'unit-test-pepper';

describe('WL-U — waitlist pure helpers', () => {
    it('WL-U1 derives the same keyed document ID for the same canonical email', () => {
        const a = waitlist.waitlistDocId('driver@example.com', PEPPER);
        expect(a).toMatch(/^[0-9a-f]{64}$/);
        expect(waitlist.waitlistDocId('driver@example.com', PEPPER)).toBe(a);
        expect(waitlist.waitlistDocId('other@example.com', PEPPER)).not.toBe(a);
    });

    it('WL-U2 keys the document ID on the pepper, so it is not a plain email hash', () => {
        const plain = createHash('sha256').update('driver@example.com').digest('hex');
        expect(waitlist.waitlistDocId('driver@example.com', PEPPER)).not.toBe(plain);
        expect(waitlist.waitlistDocId('driver@example.com', 'another-pepper'))
            .not.toBe(waitlist.waitlistDocId('driver@example.com', PEPPER));
    });

    it('WL-U3 refuses to derive an ID without a pepper', () => {
        expect(() => waitlist.waitlistDocId('driver@example.com', '')).toThrow(/WAITLIST_ID_PEPPER/);
    });

    it('WL-U4 creates 32-byte URL-safe tokens that pass the shape check', () => {
        const token = waitlist.newConfirmToken();
        expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(waitlist.isWellFormedToken(token)).toBe(true);
        expect(waitlist.newConfirmToken()).not.toBe(token);
        const fixed = waitlist.newConfirmToken(n => { expect(n).toBe(32); return Buffer.alloc(32, 7); });
        expect(fixed).toBe(Buffer.alloc(32, 7).toString('base64url'));
    });

    it.each([undefined, null, 42, '', 'short', 'x'.repeat(44), `${'a'.repeat(42)}=`, `${'a'.repeat(42)}/`])(
        'WL-U5 rejects malformed token %j', token => {
            expect(waitlist.isWellFormedToken(token)).toBe(false);
        });

    it('WL-U6 stores only a SHA-256 hash of the token', () => {
        const token = waitlist.newConfirmToken();
        const hash = waitlist.hashConfirmToken(token);
        expect(hash).toBe(createHash('sha256').update(token).digest('hex'));
        expect(hash).not.toContain(token);
    });

    it('WL-U7 puts the token in the URL fragment and tolerates a trailing slash', () => {
        expect(waitlist.buildConfirmUrl('https://parqueen-marketing.web.app/', 'abc'))
            .toBe('https://parqueen-marketing.web.app/confirm#t=abc');
        expect(waitlist.buildConfirmUrl('https://parqueen.app', 'abc'))
            .toBe('https://parqueen.app/confirm#t=abc');
    });

    it('WL-U8 keys the client throttle on an HMAC of Fastly-Client-IP only', () => {
        const fromFastly = waitlist.clientRateLimitKey({ 'fastly-client-ip': '203.0.113.9' }, PEPPER);
        expect(fromFastly).toMatch(/^[0-9a-f]{64}$/);
        expect(fromFastly).not.toContain('203.0.113.9');
        // Secret-dependent: the digest cannot be recomputed without the rate-limit pepper.
        expect(waitlist.clientRateLimitKey({ 'fastly-client-ip': '203.0.113.9' }, 'other-pepper'))
            .not.toBe(fromFastly);
        // A forwarded header alongside it changes nothing.
        expect(waitlist.clientRateLimitKey({
            'fastly-client-ip': '203.0.113.9',
            'x-forwarded-for': '198.51.100.1',
        }, PEPPER)).toBe(fromFastly);
    });

    it.each([
        ['absent', {}],
        ['only X-Forwarded-For', { 'x-forwarded-for': '198.51.100.1' }],
        ['only X-Real-IP', { 'x-real-ip': '198.51.100.1' }],
        ['empty', { 'fastly-client-ip': '' }],
        ['not an IP', { 'fastly-client-ip': 'not-an-ip' }],
        ['a list', { 'fastly-client-ip': '203.0.113.9, 198.51.100.1' }],
        ['out of range', { 'fastly-client-ip': '999.1.1.1' }],
    ])('WL-U9 returns no client key when Fastly-Client-IP is %s — never a forwarded fallback', (_label, headers) => {
        expect(waitlist.clientRateLimitKey(headers, PEPPER)).toBeNull();
    });

    it('WL-U13 canonical email is deterministic across case and whitespace', () => {
        const { canonicalizeEmail } = require('./emailAddress');
        const forms = ['Driver@Example.com', '  driver@example.com', 'DRIVER@EXAMPLE.COM  '];
        const canon = forms.map(canonicalizeEmail);
        expect(new Set(canon)).toEqual(new Set(['driver@example.com']));
        const ids = canon.map(e => waitlist.waitlistDocId(e, PEPPER));
        expect(new Set(ids).size).toBe(1);
    });

    it('WL-U14 never uses the raw email as the document ID', () => {
        const id = waitlist.waitlistDocId('driver@example.com', PEPPER);
        expect(id).not.toBe('driver@example.com');
        expect(id).not.toContain('@');
        expect(id).not.toContain('driver');
        expect(id).toMatch(/^[0-9a-f]{64}$/);
    });

    it('WL-U10 accepts IPv6 client addresses', () => {
        expect(waitlist.clientRateLimitKey({ 'fastly-client-ip': '2001:db8::1' }, PEPPER))
            .toMatch(/^[0-9a-f]{64}$/);
    });

    it('WL-U11 parses the hostname allowlist', () => {
        expect(waitlist.parseHostnameList(' Parqueen-Marketing.web.app , parqueen.app,, '))
            .toEqual(['parqueen-marketing.web.app', 'parqueen.app']);
        expect(waitlist.parseHostnameList(undefined)).toEqual([]);
    });

    it('WL-U12 writes a plain confirmation email with the link and the 48-hour expiry', () => {
        const { subject, text, html } = waitlist.confirmationEmail('https://parqueen.app/confirm#t=abc');
        expect(subject).toBe('Confirm your spot on the ParQueen waitlist');
        expect(text).toContain('https://parqueen.app/confirm#t=abc');
        expect(text).toContain('48 hours');
        expect(html).toContain('Confirm my spot');
        expect(html).not.toMatch(/<img/i);
    });
});

describe('WL-S — SendGrid delivery', () => {
    it('WL-S1 disables click and open tracking and sends from hello@parqueen.app', async () => {
        let sent;
        const fetchFn = async (url, init) => { sent = { url, body: JSON.parse(init.body) }; return { ok: true }; };
        await waitlist.sendConfirmationEmail({
            email: 'driver@example.com', confirmUrl: 'https://parqueen.app/confirm#t=abc', apiKey: 'k', fetchFn,
        });
        expect(sent.url).toBe('https://api.sendgrid.com/v3/mail/send');
        expect(sent.body.from.email).toBe('hello@parqueen.app');
        expect(sent.body.tracking_settings.click_tracking.enable).toBe(false);
        expect(sent.body.tracking_settings.open_tracking.enable).toBe(false);
    });

    it('WL-S2 fails with an opaque error that never carries the response body', async () => {
        const fetchFn = async () => ({ ok: false, status: 400, body: { cancel: async () => {} } });
        const error = await waitlist.sendConfirmationEmail({
            email: 'driver@example.com', confirmUrl: 'u', apiKey: 'k', fetchFn,
        }).catch(e => e);
        expect(error.message).toBe('Waitlist email delivery failed');
        expect(error.status).toBe(400);
        expect(JSON.stringify(error)).not.toContain('driver@example.com');
    });
});

describe('WL-T — Turnstile verification', () => {
    const allowed = ['parqueen.app'];
    const respond = outcome => async () => ({ ok: true, json: async () => outcome });

    it('WL-T1 accepts a successful waitlist token from an allowed hostname', async () => {
        await expect(waitlist.verifyTurnstileToken({
            token: 't', secret: 's', allowedHostnames: allowed,
            fetchFn: respond({ success: true, action: 'waitlist', hostname: 'parqueen.app' }),
        })).resolves.toBe(true);
    });

    it.each([
        ['failure', { success: false, action: 'waitlist', hostname: 'parqueen.app' }],
        ['wrong action', { success: true, action: 'login', hostname: 'parqueen.app' }],
        ['unlisted hostname', { success: true, action: 'waitlist', hostname: 'evil.example' }],
    ])('WL-T2 rejects %s', async (_label, outcome) => {
        await expect(waitlist.verifyTurnstileToken({
            token: 't', secret: 's', allowedHostnames: allowed, fetchFn: respond(outcome),
        })).resolves.toBe(false);
    });

    it('WL-T3 rejects missing tokens and secrets without calling Cloudflare', async () => {
        const fetchFn = vi.fn();
        await expect(waitlist.verifyTurnstileToken({ token: '', secret: 's', allowedHostnames: allowed, fetchFn })).resolves.toBe(false);
        await expect(waitlist.verifyTurnstileToken({ token: 't', secret: '', allowedHostnames: allowed, fetchFn })).resolves.toBe(false);
        expect(fetchFn).not.toHaveBeenCalled();
    });

    it('WL-T4 treats network errors as a failed check', async () => {
        await expect(waitlist.verifyTurnstileToken({
            token: 't', secret: 's', allowedHostnames: allowed, fetchFn: async () => { throw new Error('down'); },
        })).resolves.toBe(false);
    });

    it('WL-T5 does not send the visitor IP to Cloudflare', async () => {
        let body;
        const fetchFn = async (_url, init) => { body = init.body; return { ok: true, json: async () => ({ success: false }) }; };
        await waitlist.verifyTurnstileToken({ token: 't', secret: 's', allowedHostnames: allowed, fetchFn });
        expect(new URLSearchParams(body).has('remoteip')).toBe(false);
    });
});

describe('WL-H — handler protection order (no emulator)', () => {
    // A database that fails the test if it is touched at all.
    const untouchableDb = new Proxy({}, { get: (_t, prop) => { throw new Error(`db.${String(prop)} must not be used`); } });

    function deps(overrides = {}) {
        return {
            db: untouchableDb,
            FieldValue: {},
            Timestamp: {},
            canonicalizeEmail: require('./emailAddress').canonicalizeEmail,
            checkRateLimit: vi.fn(async () => {}),
            verifyTurnstile: vi.fn(async () => false),
            deliver: vi.fn(async () => {}),
            newToken: () => waitlist.newConfirmToken(),
            now: () => Date.now(),
            idPepper: PEPPER,
            rateLimitPepper: 'unit-rate-limit-pepper',
            confirmBaseUrl: 'https://parqueen-marketing.web.app',
            ...overrides,
        };
    }

    it('WL-H1 a failed Turnstile check stops before any write or email', async () => {
        const d = deps();
        const res = await waitlist.handleJoin(
            { body: { email: 'driver@example.com', turnstileToken: 'bad' }, headers: { 'fastly-client-ip': '203.0.113.9' } }, d);
        expect(res).toEqual({ status: 400, body: { status: 'verification_failed' } });
        expect(d.verifyTurnstile).toHaveBeenCalledWith('bad');
        expect(d.deliver).not.toHaveBeenCalled();
    });

    it('WL-H2 with a valid Fastly-Client-IP, throttles on its HMAC — never the raw IP', async () => {
        const d = deps();
        await waitlist.handleJoin(
            { body: { email: 'driver@example.com', turnstileToken: 'bad' }, headers: { 'fastly-client-ip': '203.0.113.9' } }, d);
        expect(d.checkRateLimit).toHaveBeenCalledTimes(1);
        const [key, operation, limits] = d.checkRateLimit.mock.calls[0];
        expect(operation).toBe('waitlistJoin');
        expect(limits).toEqual(waitlist.JOIN_LIMIT);
        expect(key).toBe(waitlist.clientRateLimitKey({ 'fastly-client-ip': '203.0.113.9' }, 'unit-rate-limit-pepper'));
        expect(key).not.toContain('203.0.113.9');
    });

    it('WL-H3 without Fastly-Client-IP, skips the client throttle and ignores forwarded headers', async () => {
        const d = deps();
        const res = await waitlist.handleJoin({
            body: { email: 'driver@example.com', turnstileToken: 'bad' },
            headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.9', 'x-real-ip': '198.51.100.1' },
        }, d);
        expect(d.checkRateLimit).not.toHaveBeenCalled();
        // Turnstile still runs: the missing header is not a bypass.
        expect(d.verifyTurnstile).toHaveBeenCalledTimes(1);
        expect(res.status).toBe(400);
    });

    it('WL-H4 a throttled client is refused before Turnstile or the database', async () => {
        const exhausted = Object.assign(new Error('Too many requests.'), { code: 'resource-exhausted' });
        const d = deps({ checkRateLimit: vi.fn(async () => { throw exhausted; }) });
        const res = await waitlist.handleJoin(
            { body: { email: 'driver@example.com', turnstileToken: 'ok' }, headers: { 'fastly-client-ip': '203.0.113.9' } }, d);
        expect(res).toEqual({ status: 429, body: { status: 'rate_limited' } });
        expect(d.verifyTurnstile).not.toHaveBeenCalled();
    });

    it('WL-H5 a malformed email is rejected before throttling, Turnstile or the database', async () => {
        const d = deps();
        const res = await waitlist.handleJoin({ body: { email: 'nope', turnstileToken: 'ok' }, headers: {} }, d);
        expect(res).toEqual({ status: 400, body: { status: 'invalid_email' } });
        expect(d.checkRateLimit).not.toHaveBeenCalled();
        expect(d.verifyTurnstile).not.toHaveBeenCalled();
    });

    it('WL-H6 a malformed confirmation token is refused without a lookup', async () => {
        const d = deps();
        const res = await waitlist.handleConfirm({ body: { token: 'x' }, headers: {} }, d);
        expect(res).toEqual({ status: 410, body: { status: 'invalid_or_expired' } });
        expect(d.checkRateLimit).not.toHaveBeenCalled();
    });
});

// No test in this file may reach Cloudflare or SendGrid: every network path
// above is given an injected fetch. This fails the file if one leaks.
const realFetch = globalThis.fetch;
const leakedCalls = [];
beforeAll(() => {
    globalThis.fetch = async (url, ...rest) => {
        leakedCalls.push(String(url));
        throw new Error(`Unexpected real network call to ${url}`);
    };
});
afterAll(() => {
    globalThis.fetch = realFetch;
    expect(leakedCalls).toEqual([]);
});
