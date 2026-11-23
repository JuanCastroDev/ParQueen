'use strict';

const { createHash } = require('crypto');
const waitlist = require('./waitlist');
// Loaded here, not inside a test: it pulls in firebase-functions, whose first
// load can exceed a synchronous test's timeout on a cold disk.
const { canonicalizeEmail } = require('./emailAddress');

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

    it('WL-U12 writes a branded confirmation email with the link and the real expiry', () => {
        const url = 'https://join.parqueen.app/confirm#t=abc';
        const { subject, text, html } = waitlist.confirmationEmail(url);
        expect(subject).toBe('Confirm your spot on the ParQueen waitlist');

        // The plain-text alternative stays a usable email on its own.
        expect(text).toContain('ParQueen');
        expect(text).toContain('Confirm your spot.');
        expect(text).toContain(url);
        expect(text).toContain('This link expires in 48 hours.');
        expect(text).toContain("If you didn't request this");

        // The copy states the lifetime the backend actually enforces.
        expect(waitlist.TOKEN_TTL_MS / 3600000).toBe(48);
        expect(html).toContain('This link expires in 48 hours.');

        // A waitlist confirmation, never an account verification.
        expect(html).toContain('Confirm my email');
        expect(html).not.toMatch(/verify (your )?account/i);
        expect(text).not.toMatch(/verify (your )?account/i);

        // Readable with remote content blocked, and safe in every client.
        expect(html).not.toMatch(/<img/i);
        expect(html).not.toMatch(/<script/i);
        expect(html).not.toMatch(/fonts\.googleapis|@font-face|@import/i);
        expect(html).toContain('>ParQueen<');
        expect(html).toContain('Early access');

        // The link is the confirm URL, in the button and as pasteable text.
        expect(html.match(new RegExp(`href="${url.replace('#', '#')}"`, 'g'))).toHaveLength(2);
        expect(html).toContain(`>${url}</a>`);
    });

    it('WL-U13 keeps the confirmation link on the configured base and in the fragment', () => {
        const token = 'z'.repeat(43);
        const url = waitlist.buildConfirmUrl('https://join.parqueen.app', token);
        expect(url).toBe(`https://join.parqueen.app/confirm#t=${token}`);
        // The token must never reach a server as a query parameter.
        expect(url).not.toContain('?');
        expect(waitlist.confirmationEmail(url).html).toContain(url);
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
            canonicalizeEmail,
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

    it('WL-H1b a failed Turnstile check counts nothing: no rate-limit write, whatever the headers', async () => {
        for (const headers of [{}, { 'fastly-client-ip': '203.0.113.9' }, { 'fastly-client-ip': '198.51.100.200' }, { 'fastly-client-ip': 'junk' }]) {
            const d = deps();
            const res = await waitlist.handleJoin({ body: { email: 'driver@example.com', turnstileToken: 'bad' }, headers }, d);
            expect(res.status).toBe(400);
            expect(d.checkRateLimit).not.toHaveBeenCalled();
        }
    });

    it('WL-H2 with a valid Fastly-Client-IP, throttles on its HMAC — never the raw IP', async () => {
        const d = deps({ verifyTurnstile: vi.fn(async () => true) });
        await waitlist.handleJoin(
            { body: { email: 'driver@example.com', turnstileToken: 'ok' }, headers: { 'fastly-client-ip': '203.0.113.9' } }, d).catch(() => {});
        expect(d.checkRateLimit).toHaveBeenCalledTimes(2);
        const [key, operation, limits] = d.checkRateLimit.mock.calls[0];
        expect(operation).toBe('waitlistJoin');
        expect(limits).toEqual(waitlist.JOIN_LIMIT);
        expect(key).toBe(waitlist.clientRateLimitKey({ 'fastly-client-ip': '203.0.113.9' }, 'unit-rate-limit-pepper'));
        expect(key).not.toContain('203.0.113.9');
    });

    it('WL-H3 without Fastly-Client-IP, skips the client throttle, ignores forwarded headers, and is still counted globally', async () => {
        const d = deps({ verifyTurnstile: vi.fn(async () => true) });
        await waitlist.handleJoin({
            body: { email: 'driver@example.com', turnstileToken: 'ok' },
            headers: { 'x-forwarded-for': '198.51.100.1, 203.0.113.9', 'x-real-ip': '198.51.100.1' },
        }, d).catch(() => {}); // the untouchable db stops it after the limits
        // Turnstile still runs: the missing header is not a bypass.
        expect(d.verifyTurnstile).toHaveBeenCalledTimes(1);
        expect(d.checkRateLimit.mock.calls.map(c => c.slice(0, 2))).toEqual([['all', 'waitlistJoinAll']]);
    });

    it('WL-H4 a throttled client is refused after Turnstile and before the database', async () => {
        const exhausted = Object.assign(new Error('Too many requests.'), { code: 'resource-exhausted' });
        const d = deps({ checkRateLimit: vi.fn(async () => { throw exhausted; }), verifyTurnstile: vi.fn(async () => true) });
        const res = await waitlist.handleJoin(
            { body: { email: 'driver@example.com', turnstileToken: 'ok' }, headers: { 'fastly-client-ip': '203.0.113.9' } }, d);
        expect(res).toEqual({ status: 429, body: { status: 'rate_limited' } });
        expect(d.verifyTurnstile).toHaveBeenCalledTimes(1);
        expect(d.checkRateLimit).toHaveBeenCalledTimes(1); // the global counter is not touched
    });

    it('WL-H4b every verified join is counted under one key, whatever Fastly-Client-IP says', async () => {
        const seen = new Set();
        for (const headers of [{}, { 'fastly-client-ip': '203.0.113.1' }, { 'fastly-client-ip': '2001:db8::7' }, { 'fastly-client-ip': 'junk' }]) {
            const d = deps({ verifyTurnstile: vi.fn(async () => true) });
            await waitlist.handleJoin({ body: { email: 'driver@example.com', turnstileToken: 'ok' }, headers }, d).catch(() => {});
            const global = d.checkRateLimit.mock.calls.filter(c => c[1] === 'waitlistJoinAll');
            expect(global).toHaveLength(1);
            expect(global[0][2]).toEqual(waitlist.GLOBAL_JOIN_LIMIT);
            seen.add(global[0][0]);
        }
        expect([...seen]).toEqual(['all']);
    });

    it('WL-H4c a full global window answers 429 before the database', async () => {
        const exhausted = Object.assign(new Error('Too many requests.'), { code: 'resource-exhausted' });
        const d = deps({
            verifyTurnstile: vi.fn(async () => true),
            checkRateLimit: vi.fn(async (_k, op) => { if (op === 'waitlistJoinAll') throw exhausted; }),
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const res = await waitlist.handleJoin({ body: { email: 'driver@example.com', turnstileToken: 'ok' }, headers: { 'fastly-client-ip': '203.0.113.9' } }, d);
        expect(res).toEqual({ status: 429, body: { status: 'rate_limited' } });
        // One line for an alert, carrying nothing about the visitor.
        expect(warn.mock.calls).toEqual([['Waitlist global join limit reached']]);
        warn.mockRestore();
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

describe('WL-UU — unsubscribe helpers (no emulator)', () => {
    it('WL-UU1 puts the unsubscribe token in the URL fragment only', () => {
        expect(waitlist.buildUnsubscribeUrl('https://parqueen-marketing.web.app/', 'abc'))
            .toBe('https://parqueen-marketing.web.app/unsubscribe#t=abc');
    });

    it.each([undefined, null, '', 'short', 'x'.repeat(44), { token: 'x' }])(
        'WL-UU2 answers malformed token %j with the generic 410 before touching Firestore or the throttle', async token => {
            const fail = () => { throw new Error('must not be called'); };
            const res = await waitlist.handleUnsubscribe(
                { body: { token }, headers: { 'fastly-client-ip': '203.0.113.9' } },
                { db: { collection: fail, runTransaction: fail }, checkRateLimit: fail, rateLimitPepper: PEPPER },
            );
            expect(res).toEqual({ status: 410, body: { status: 'invalid_or_expired' } });
        });

    it('WL-UU3 never asks for Turnstile', async () => {
        const verifyTurnstile = vi.fn();
        const db = {
            // get: the handler now reads the token doc before counting (wave 2).
            collection: () => ({ doc: id => ({ id, get: async () => ({ exists: false }) }) }),
            runTransaction: fn => fn({ get: async () => ({ exists: false }) }),
        };
        const res = await waitlist.handleUnsubscribe(
            { body: { token: waitlist.newConfirmToken() }, headers: {} },
            { db, now: () => 0, checkRateLimit: vi.fn(), rateLimitPepper: PEPPER, verifyTurnstile },
        );
        expect(res.status).toBe(410);
        expect(verifyTurnstile).not.toHaveBeenCalled();
    });
});

// Remediation wave 2.
describe('WL-W2 — client networks; confirm and unsubscribe check the link before counting', () => {
    it('WL-W2-U1 throttles IPv4 by address, IPv6 by /64, and IPv4-mapped IPv6 as its IPv4 address', () => {
        expect(waitlist.clientNetwork('203.0.113.9')).toBe('203.0.113.9');
        expect(waitlist.clientNetwork('::ffff:203.0.113.9')).toBe('203.0.113.9');
        expect(waitlist.clientNetwork('2001:db8::1')).toBe('2001:db8:0:0::/64');
        expect(waitlist.clientNetwork('2001:DB8:0000:0000:ffff::9')).toBe('2001:db8:0:0::/64');
        expect(waitlist.clientNetwork('2001:db8:0:1::1')).toBe('2001:db8:0:1::/64');
        const key = ip => waitlist.clientRateLimitKey({ 'fastly-client-ip': ip }, PEPPER);
        expect(key('2001:db8:5:6::1')).toBe(key('2001:db8:5:6:aaaa:bbbb:cccc:dddd'));
        expect(key('2001:db8:5:6::1')).not.toBe(key('2001:db8:5:7::1'));
        expect(key('::ffff:198.51.100.4')).toBe(key('198.51.100.4'));
        expect(key('198.51.100.4')).not.toBe(key('198.51.100.5'));
    });

    const exhausted = () => vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'resource-exhausted' }); });
    const confirmDb = docs => ({ collection: () => ({ where: () => ({ limit: () => ({ get: async () => ({ empty: !docs.length, docs: docs.map(data => ({ ref: {}, data: () => data })) }) }) }) }) });
    const unsubDb = grant => ({ collection: () => ({ doc: () => ({ get: async () => ({ exists: !!grant, data: () => grant }) }) }) });
    const ts = ms => ({ toMillis: () => ms });
    const token = waitlist.newConfirmToken();
    const headers = { 'fastly-client-ip': '203.0.113.9' };

    it.each([
        ['unknown', []],
        ['already confirmed', [{ status: 'subscribed' }]],
        ['expired', [{ status: 'pending_confirmation', confirmTokenExpiresAt: ts(999) }]],
    ])('WL-W2-H1 a %s confirmation link gets 410 without touching the throttle', async (_l, docs) => {
        const checkRateLimit = exhausted();
        const res = await waitlist.handleConfirm({ body: { token }, headers }, { db: confirmDb(docs), now: () => 1000, checkRateLimit, rateLimitPepper: PEPPER });
        expect(res).toEqual({ status: 410, body: { status: 'invalid_or_expired' } });
        expect(checkRateLimit).not.toHaveBeenCalled();
    });

    it('WL-W2-H2 a live confirmation link is throttled per client (429 when the bucket is full)', async () => {
        const checkRateLimit = exhausted();
        const res = await waitlist.handleConfirm({ body: { token }, headers },
            { db: confirmDb([{ status: 'pending_confirmation', confirmTokenExpiresAt: ts(5000) }]), now: () => 1000, checkRateLimit, rateLimitPepper: PEPPER });
        expect(res).toEqual({ status: 429, body: { status: 'rate_limited' } });
        expect(checkRateLimit).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['unknown', null],
        ['expired', { validUntil: ts(999) }],
    ])('WL-W2-H3 an %s unsubscribe link gets 410 without touching the throttle', async (_l, grant) => {
        const checkRateLimit = exhausted();
        const res = await waitlist.handleUnsubscribe({ body: { token }, headers }, { db: unsubDb(grant), now: () => 1000, checkRateLimit, rateLimitPepper: PEPPER });
        expect(res).toEqual({ status: 410, body: { status: 'invalid_or_expired' } });
        expect(checkRateLimit).not.toHaveBeenCalled();
    });

    it('WL-W2-H4 a live unsubscribe link is throttled per client (429 when the bucket is full)', async () => {
        const checkRateLimit = exhausted();
        const res = await waitlist.handleUnsubscribe({ body: { token }, headers }, { db: unsubDb({ validUntil: ts(5000) }), now: () => 1000, checkRateLimit, rateLimitPepper: PEPPER });
        expect(res).toEqual({ status: 429, body: { status: 'rate_limited' } });
    });
});

// Issue #354: under contention the emulator (gRPC) can fail a waiting
// unsubscribe transaction with code 3 "Transaction is invalid or closed",
// which the SDK does not retry. It used to escape as HTTP 500.
describe('WL-354 — unsubscribe survives one closed transaction', () => {
    const ts = ms => ({ toMillis: () => ms });
    const token = waitlist.newConfirmToken();
    const headers = { 'fastly-client-ip': '203.0.113.9' };
    const closedTx = () => Object.assign(new Error('3 INVALID_ARGUMENT: Transaction is invalid or closed.'), { code: 3 });
    // runTransaction plays the given outcomes in order (Error = reject, else resolve).
    const run = (outcomes, checkRateLimit = vi.fn(async () => {})) => {
        const runTransaction = vi.fn(async () => {
            const next = outcomes.shift();
            if (next instanceof Error) throw next;
            return next;
        });
        const db = { collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ validUntil: ts(5000) }) }) }) }), runTransaction };
        const res = waitlist.handleUnsubscribe({ body: { token }, headers }, { db, now: () => 1000, checkRateLimit, rateLimitPepper: PEPPER });
        return { res, runTransaction, checkRateLimit };
    };

    it('WL-354-1 retries once and answers 200 when the retry unsubscribes, counting the client once', async () => {
        const { res, runTransaction, checkRateLimit } = run([closedTx(), true]);
        expect(await res).toEqual({ status: 200, body: { status: 'unsubscribed' } });
        expect(runTransaction).toHaveBeenCalledTimes(2);
        expect(checkRateLimit).toHaveBeenCalledTimes(1);
    });

    it('WL-354-2 answers the generic 410 when the retry finds the token already used', async () => {
        const { res, runTransaction } = run([closedTx(), false]);
        expect(await res).toEqual({ status: 410, body: { status: 'invalid_or_expired' } });
        expect(runTransaction).toHaveBeenCalledTimes(2);
    });

    it('WL-354-3 still fails when the retry hits the same error (no masking as 410)', async () => {
        const { res, runTransaction } = run([closedTx(), closedTx()]);
        await expect(res).rejects.toMatchObject({ code: 3 });
        expect(runTransaction).toHaveBeenCalledTimes(2);
    });

    it.each([
        ['other INVALID_ARGUMENT', Object.assign(new Error('3 INVALID_ARGUMENT: bad field'), { code: 3 })],
        ['ABORTED', Object.assign(new Error('10 ABORTED: Transaction lock timeout'), { code: 10 })],
        ['string-coded', Object.assign(new Error('Transaction is invalid or closed'), { code: 'invalid-argument' })],
    ])('WL-354-4 does not retry an unrelated error (%s)', async (_l, err) => {
        const { res, runTransaction } = run([err, true]);
        await expect(res).rejects.toBe(err);
        expect(runTransaction).toHaveBeenCalledTimes(1);
    });
});
