'use strict';

/**
 * Waitlist endpoints against the Firestore emulator. Email delivery, Turnstile
 * and token generation go through _waitlistHooks, so no real email is sent and
 * Cloudflare is never called.
 */

process.env.WAITLIST_ID_PEPPER = 'integration-test-waitlist-id-pepper';
process.env.WAITLIST_RATE_LIMIT_PEPPER = 'integration-test-waitlist-rate-limit-pepper';
process.env.TURNSTILE_SECRET_KEY = 'integration-test-turnstile-secret';
process.env.SENDGRID_API_KEY = 'integration-test-sendgrid-key';
process.env.WAITLIST_CONFIRM_BASE_URL = 'https://parqueen-marketing.web.app';
process.env.WAITLIST_ALLOWED_HOSTNAMES = 'parqueen-marketing.web.app,parqueen.app';

const crypto = require('crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const PROJECT_ID = 'parkqueen-46475363-ccf36';
const APP_NAME = '__waitlist_intg__';
const testApp = getApps().find(a => a.name === APP_NAME) ?? initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const indexModule = require('./index.js');
const waitlist = require('./waitlist.js');

const RUN = `${process.pid}_${Date.now()}`;
let seq = 0;
const nextEmail = label => `wl_${label}_${RUN}_${++seq}@example.com`;
// A distinct documentation-range client IP per test keeps rate-limit buckets apart.
const nextIp = () => `203.0.${Math.floor(Math.random() * 250)}.${(++seq % 250) + 1}`;

const docIdFor = email => waitlist.waitlistDocId(email.toLowerCase(), process.env.WAITLIST_ID_PEPPER);
const readDoc = async email => (await db.collection('waitlist').doc(docIdFor(email)).get()).data();

function fakeRes() {
    const res = { statusCode: 200, body: undefined, headers: {} };
    res.set = (k, v) => { res.headers[k.toLowerCase()] = v; return res; };
    res.status = code => { res.statusCode = code; return res; };
    res.json = body => { res.body = body; return res; };
    res.send = body => { res.body = body; return res; };
    return res;
}

async function post(handler, body, { ip = nextIp(), method = 'POST', json = true } = {}) {
    const req = {
        method,
        headers: { 'content-type': json ? 'application/json' : 'text/plain', 'fastly-client-ip': ip },
        body,
        is: type => json && type === 'application/json',
    };
    const res = fakeRes();
    await handler(req, res);
    return res;
}

const join = (email, opts, token = 'turnstile-ok') =>
    post(indexModule.joinWaitlist, { email, turnstileToken: token }, opts);
const confirm = (token, opts) => post(indexModule.confirmWaitlist, { token }, opts);

let sent;
let clock;

beforeEach(() => {
    sent = [];
    clock = Date.now();
    indexModule._waitlistHooks.now = () => clock;
    indexModule._waitlistHooks.verifyTurnstile = async token => token === 'turnstile-ok';
    indexModule._waitlistHooks.newToken = null;
    indexModule._waitlistHooks.deliver = async (email, url) => { sent.push({ email, url }); };
});

afterEach(() => {
    for (const key of Object.keys(indexModule._waitlistHooks)) indexModule._waitlistHooks[key] = null;
    vi.restoreAllMocks();
});

const tokenFrom = url => url.split('#t=')[1];

describe('WL-I — join', () => {
    it('WL-I1 creates a pending double-opt-in record and emails a fragment link', async () => {
        const email = nextEmail('new');
        const res = await join(`  ${email.toUpperCase()}  `);

        expect(res.statusCode).toBe(202);
        expect(res.body).toEqual({ status: 'check_inbox' });
        expect(res.headers['cache-control']).toBe('no-store');

        const data = await readDoc(email);
        expect(data).toMatchObject({
            email,
            status: 'pending_confirmation',
            optInMethod: 'double-opt-in',
            source: 'marketing-site',
            consentVersion: 'waitlist-2026-09-v1',
            confirmedAt: null,
        });
        expect(data.createdAt).toBeInstanceOf(Timestamp);

        expect(sent).toHaveLength(1);
        expect(sent[0].email).toBe(email);
        expect(sent[0].url).toMatch(/^https:\/\/parqueen-marketing\.web\.app\/confirm#t=[A-Za-z0-9_-]{43}$/);

        const token = tokenFrom(sent[0].url);
        expect(data.confirmTokenHash).toBe(crypto.createHash('sha256').update(token).digest('hex'));
        expect(JSON.stringify(data)).not.toContain(token);
        expect(data.confirmTokenExpiresAt.toMillis()).toBe(clock + waitlist.TOKEN_TTL_MS);
    });

    it('WL-I2 stores no IP address in the waitlist record or the rate-limit counters', async () => {
        const ip = '198.51.100.77';
        const email = nextEmail('noip');
        await join(email, { ip });
        expect(JSON.stringify(await readDoc(email))).not.toContain(ip);
        const counters = await db.collection('rateLimits').where('operation', '==', 'waitlistJoin').get();
        for (const doc of counters.docs) {
            expect(doc.id).not.toContain(ip);
            expect(JSON.stringify(doc.data())).not.toContain(ip);
        }
    });

    it('WL-I3 is idempotent: a repeat within the cooldown sends nothing and keeps the token', async () => {
        const email = nextEmail('repeat');
        await join(email);
        const before = await readDoc(email);
        const again = await join(email.toUpperCase());
        expect(again.statusCode).toBe(202);
        expect(sent).toHaveLength(1);
        expect((await readDoc(email)).confirmTokenHash).toBe(before.confirmTokenHash);
    });

    it('WL-I4 a resubmission after the cooldown rotates the token and kills the old link', async () => {
        const email = nextEmail('rotate');
        await join(email);
        const oldToken = tokenFrom(sent[0].url);

        clock += waitlist.RESEND_COOLDOWN_MS + 1;
        await join(email);
        expect(sent).toHaveLength(2);
        const newToken = tokenFrom(sent[1].url);
        expect(newToken).not.toBe(oldToken);

        expect((await confirm(oldToken)).statusCode).toBe(410);
        expect((await confirm(newToken)).statusCode).toBe(200);
    });

    it('WL-I5 answers new, pending and subscribed addresses identically', async () => {
        const email = nextEmail('same');
        const fresh = await join(email);
        const pending = await join(email);
        await confirm(tokenFrom(sent[0].url));
        const subscribed = await join(email);
        for (const res of [fresh, pending, subscribed]) {
            expect(res.statusCode).toBe(202);
            expect(res.body).toEqual({ status: 'check_inbox' });
        }
    });

    it('WL-I6 never emails or changes an already-subscribed address', async () => {
        const email = nextEmail('subscribed');
        await join(email);
        await confirm(tokenFrom(sent[0].url));
        const before = await readDoc(email);

        clock += waitlist.RESEND_COOLDOWN_MS + 1;
        await join(email);
        expect(sent).toHaveLength(1);
        expect(await readDoc(email)).toEqual(before);
    });

    it('WL-I7 rejects malformed email without writing anything', async () => {
        const res = await join('not-an-email');
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ status: 'invalid_email' });
        expect(sent).toHaveLength(0);
    });

    it('WL-I8 rejects a failed Turnstile check without writing or emailing', async () => {
        const email = nextEmail('bot');
        const res = await join(email, undefined, 'turnstile-bad');
        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ status: 'verification_failed' });
        expect(await readDoc(email)).toBeUndefined();
        expect(sent).toHaveLength(0);
    });

    it('WL-I9 limits a single client to five join attempts per window', async () => {
        const ip = nextIp();
        const statuses = [];
        for (let i = 0; i < 6; i++) statuses.push((await join(nextEmail('burst'), { ip })).statusCode);
        expect(statuses.slice(0, 5)).toEqual([202, 202, 202, 202, 202]);
        expect(statuses[5]).toBe(429);
    });

    it('WL-I10 caps confirmation emails per address but still answers 202', async () => {
        const email = nextEmail('cap');
        const statuses = [];
        for (let i = 0; i < 4; i++) {
            statuses.push((await join(email)).statusCode);
            clock += waitlist.RESEND_COOLDOWN_MS + 1;
        }
        expect(statuses).toEqual([202, 202, 202, 202]);
        expect(sent).toHaveLength(waitlist.ADDRESS_EMAIL_LIMIT.limit);
    });

    it('WL-I11 reports a delivery failure as retryable and lets the retry send', async () => {
        const email = nextEmail('sendfail');
        indexModule._waitlistHooks.deliver = async () => { throw new Error('SendGrid down'); };
        const failed = await join(email);
        expect(failed.statusCode).toBe(503);
        expect(failed.body).toEqual({ status: 'try_again' });

        indexModule._waitlistHooks.deliver = async (to, url) => { sent.push({ email: to, url }); };
        const retry = await join(email);
        expect(retry.statusCode).toBe(202);
        expect(sent).toHaveLength(1);
    });

    it('WL-I12 an unsubscribed address must confirm again to rejoin', async () => {
        const email = nextEmail('rejoin');
        await db.collection('waitlist').doc(docIdFor(email)).set({
            email, status: 'unsubscribed', optInMethod: 'legacy-squarespace',
            source: 'squarespace-import', consentVersion: 'squarespace-legacy',
            createdAt: Timestamp.fromMillis(clock - 1000), confirmedAt: null,
        });
        await join(email);
        const data = await readDoc(email);
        expect(data).toMatchObject({ status: 'pending_confirmation', optInMethod: 'double-opt-in', source: 'marketing-site' });
        expect(sent).toHaveLength(1);
    });

    it('WL-I13 accepts only JSON POST requests', async () => {
        expect((await post(indexModule.joinWaitlist, {}, { method: 'GET' })).statusCode).toBe(405);
        expect((await post(indexModule.joinWaitlist, 'email=x', { json: false })).statusCode).toBe(400);
    });
});

describe('WL-C — confirm', () => {
    it('WL-C1 subscribes, stamps confirmedAt and removes the token fields', async () => {
        const email = nextEmail('confirm');
        await join(email);
        const res = await confirm(tokenFrom(sent[0].url));
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ status: 'confirmed' });

        const data = await readDoc(email);
        expect(data).toMatchObject({ status: 'subscribed', optInMethod: 'double-opt-in' });
        expect(data.confirmedAt).toBeInstanceOf(Timestamp);
        expect(data).not.toHaveProperty('confirmTokenHash');
        expect(data).not.toHaveProperty('confirmTokenExpiresAt');
    });

    it('WL-C2 is single use', async () => {
        await join(nextEmail('once'));
        const token = tokenFrom(sent[0].url);
        expect((await confirm(token)).statusCode).toBe(200);
        const second = await confirm(token);
        expect(second.statusCode).toBe(410);
        expect(second.body).toEqual({ status: 'invalid_or_expired' });
    });

    it('WL-C3 refuses an expired token and leaves the record pending', async () => {
        const email = nextEmail('expired');
        await join(email);
        clock += waitlist.TOKEN_TTL_MS + 1;
        expect((await confirm(tokenFrom(sent[0].url))).statusCode).toBe(410);
        expect((await readDoc(email)).status).toBe('pending_confirmation');
    });

    it('WL-C4 gives unknown and malformed tokens the same answer as expired ones', async () => {
        const unknown = await confirm(waitlist.newConfirmToken());
        const malformed = await confirm('nope');
        for (const res of [unknown, malformed]) {
            expect(res.statusCode).toBe(410);
            expect(res.body).toEqual({ status: 'invalid_or_expired' });
        }
    });
});
