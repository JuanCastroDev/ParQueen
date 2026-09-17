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
process.env.WAITLIST_ALLOWED_HOSTNAMES = 'parqueen-marketing.web.app';

const crypto = require('crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');

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

async function post(handler, body, { ip = nextIp(), method = 'POST', json = true, headers = {} } = {}) {
    const req = {
        method,
        headers: {
            'content-type': json ? 'application/json' : 'text/plain',
            ...(ip === null ? {} : { 'fastly-client-ip': ip }),
            ...headers,
        },
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

// Hooks replace every external call. This guard fails the suite if a real
// request to Cloudflare or SendGrid is ever attempted.
const realFetch = globalThis.fetch;
const leakedCalls = [];
beforeAll(() => {
    globalThis.fetch = async (url, ...rest) => {
        const target = String(url);
        if (/challenges.cloudflare.com|api.sendgrid.com/.test(target)) {
            leakedCalls.push(target);
            throw new Error('Real Cloudflare/SendGrid call attempted in tests');
        }
        return realFetch(url, ...rest);
    };
});
afterAll(() => {
    globalThis.fetch = realFetch;
    expect(leakedCalls).toEqual([]);
});

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

        // Keyed by HMAC, never by the address itself.
        expect(docIdFor(email)).toMatch(/^[0-9a-f]{64}$/);
        expect((await db.collection('waitlist').doc(email).get()).exists).toBe(false);
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
        // New consent is double opt-in; where the address came from is history and stays.
        expect(data).toMatchObject({ status: 'pending_confirmation', optInMethod: 'double-opt-in', source: 'squarespace-import' });
        expect(sent).toHaveLength(1);
    });

    it('WL-I14 without Fastly-Client-IP, never throttles on forwarded headers', async () => {
        const statuses = [];
        for (let i = 0; i < waitlist.JOIN_LIMIT.limit + 2; i++) {
            const res = await join(nextEmail('noheader'), {
                ip: null,
                headers: { 'x-forwarded-for': '198.51.100.23', 'x-real-ip': '198.51.100.23' },
            });
            statuses.push(res.statusCode);
        }
        // Turnstile and the per-address limit still apply; the client throttle is skipped.
        expect(statuses.every(s => s === 202)).toBe(true);
        const forwardedKey = crypto.createHmac('sha256', process.env.WAITLIST_RATE_LIMIT_PEPPER)
            .update('198.51.100.23').digest('hex');
        const counters = await db.collection('rateLimits').where('operation', '==', 'waitlistJoin').get();
        expect(counters.docs.some(d => d.data().uid === forwardedKey)).toBe(false);
    });

    it('WL-I15 a missing Fastly-Client-IP is not a Turnstile bypass', async () => {
        const email = nextEmail('noheaderbot');
        const res = await join(email, { ip: null }, 'turnstile-bad');
        expect(res.statusCode).toBe(400);
        expect(await readDoc(email)).toBeUndefined();
        expect(sent).toHaveLength(0);
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

describe('WL-X — expireStaleWaitlistSignups', () => {
    it('WL-X1 deletes only pending signups older than 30 days', async () => {
        const old = Timestamp.fromMillis(Date.now() - waitlist.PENDING_RETENTION_MS - 60_000);
        const recent = Timestamp.fromMillis(Date.now() - 60_000);
        const seedDoc = (label, data) => {
            const email = nextEmail(label);
            return db.collection('waitlist').doc(docIdFor(email)).set({ email, confirmedAt: null, ...data })
                .then(() => email);
        };
        const stale = await seedDoc('stale', { status: 'pending_confirmation', createdAt: old });
        const fresh = await seedDoc('fresh', { status: 'pending_confirmation', createdAt: recent });
        const oldSubscriber = await seedDoc('oldsub', { status: 'subscribed', createdAt: old });

        indexModule._waitlistHooks.now = null;
        await indexModule.expireStaleWaitlistSignups.run({});

        expect(await readDoc(stale)).toBeUndefined();
        expect(await readDoc(fresh)).toBeDefined();
        expect(await readDoc(oldSubscriber)).toBeDefined();
    });
});

describe('WL-UN — unsubscribe', () => {
    const unsubscribe = (token, opts) => post(indexModule.unsubscribeWaitlist, { token }, opts);
    const refFor = email => db.collection('waitlist').doc(docIdFor(email));
    const sha = token => crypto.createHash('sha256').update(token).digest('hex');
    const tokenDoc = async token => (await db.collection('waitlistUnsubscribeTokens').doc(sha(token)).get()).data();
    const issue = email => waitlist.issueUnsubscribeToken(refFor(email), {
        db, FieldValue, Timestamp, newToken: () => waitlist.newConfirmToken(), now: () => clock,
    });
    const LEGACY = {
        optInMethod: 'legacy-squarespace', source: 'squarespace-import',
        consentVersion: 'squarespace-legacy', confirmedAt: null,
    };
    const seedSubscriber = async (label, extra = {}) => {
        const email = nextEmail(label);
        await refFor(email).set({
            email, status: 'subscribed', optInMethod: 'double-opt-in', source: 'marketing-site',
            consentVersion: 'waitlist-2026-09-v1', createdAt: Timestamp.fromMillis(clock - 5000),
            confirmedAt: Timestamp.fromMillis(clock - 4000), ...extra,
        });
        return email;
    };
    const INVALID = { status: 'invalid_or_expired' };

    let logs;
    beforeEach(() => {
        logs = [];
        for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
            vi.spyOn(console, level).mockImplementation((...args) => { logs.push(args.map(String).join(' ')); });
        }
    });

    it('WL-UN1 keys the token doc by SHA-256 of the raw token and stores neither the token nor the email', async () => {
        const email = await seedSubscriber('hash');
        const token = await issue(email);
        expect(waitlist.isWellFormedToken(token)).toBe(true);

        const grant = await tokenDoc(token);
        expect(Object.keys(grant).sort()).toEqual(['issuedAt', 'subscriptionConfirmedAt', 'validUntil', 'waitlistId']);
        expect(grant.waitlistId).toBe(docIdFor(email));
        expect(grant.issuedAt).toBeInstanceOf(Timestamp);
        expect(grant.validUntil.toMillis()).toBe(clock + waitlist.UNSUBSCRIBE_TOKEN_TTL_MS);
        expect(waitlist.UNSUBSCRIBE_TOKEN_TTL_MS).toBe(60 * 24 * 60 * 60 * 1000);
        expect(grant.subscriptionConfirmedAt.toMillis()).toBe(clock - 4000);

        const stored = JSON.stringify([grant, await readDoc(email)]);
        expect(stored).not.toContain(token);
        expect(JSON.stringify(grant)).not.toContain(email);
        expect(waitlist.buildUnsubscribeUrl(process.env.WAITLIST_CONFIRM_BASE_URL, token))
            .toBe(`https://parqueen-marketing.web.app/unsubscribe#t=${token}`);
    });

    it('WL-UN2 refuses to issue a token for a record that is not subscribed', async () => {
        const email = nextEmail('pendingissue');
        await join(email);
        expect(await issue(email)).toBeNull();
        const grants = await db.collection('waitlistUnsubscribeTokens').where('waitlistId', '==', docIdFor(email)).get();
        expect(grants.empty).toBe(true);
    });

    it('WL-UN3 unsubscribes, stamps lastUnsubscribedAt, spends the token and keeps provenance', async () => {
        const email = await seedSubscriber('valid');
        const token = await issue(email);
        const other = await issue(email);
        const before = await readDoc(email);

        const res = await unsubscribe(token);
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ status: 'unsubscribed' });
        expect(res.headers['cache-control']).toBe('no-store');

        const data = await readDoc(email);
        expect(data.status).toBe('unsubscribed');
        expect(data.lastUnsubscribedAt).toBeInstanceOf(Timestamp);
        expect(data).not.toHaveProperty('unsubscribedAt');
        for (const field of ['email', 'optInMethod', 'source', 'consentVersion', 'createdAt', 'confirmedAt']) {
            expect(data[field]).toEqual(before[field]);
        }
        expect(await tokenDoc(token)).toBeUndefined();
        // Single use; another token for the same subscription is now harmless.
        expect(await unsubscribe(token)).toMatchObject({ statusCode: 410, body: INVALID });
        expect(await unsubscribe(other)).toMatchObject({ statusCode: 410, body: INVALID });
        expect((await readDoc(email)).lastUnsubscribedAt).toEqual(data.lastUnsubscribedAt);
    });

    it('WL-UN4 an early token still works after many later sends, until validUntil', async () => {
        const email = await seedSubscriber('many');
        const first = await issue(email);
        for (let i = 0; i < 8; i++) {
            clock += 24 * 60 * 60 * 1000;
            await issue(email);
        }
        // Day 59 after the first send: still valid.
        clock = (await tokenDoc(first)).validUntil.toMillis() - 1;
        expect((await unsubscribe(first)).statusCode).toBe(200);
    });

    it('WL-UN5 a token stops working once its validity window ends', async () => {
        const email = await seedSubscriber('expired');
        const token = await issue(email);
        clock += waitlist.UNSUBSCRIBE_TOKEN_TTL_MS;
        expect(await unsubscribe(token)).toMatchObject({ statusCode: 410, body: INVALID });
        expect((await readDoc(email)).status).toBe('subscribed');
    });

    it('WL-UN6 answers malformed and unknown tokens with the generic 410', async () => {
        for (const token of ['nope', '', 42, waitlist.newConfirmToken()]) {
            const res = await unsubscribe(token);
            expect(res.statusCode).toBe(410);
            expect(res.body).toEqual(INVALID);
        }
    });

    it('WL-UN7 a confirmation token cannot unsubscribe, and a pending record stays pending', async () => {
        const email = nextEmail('pending');
        await join(email);
        expect(await unsubscribe(tokenFrom(sent[0].url))).toMatchObject({ statusCode: 410, body: INVALID });

        // Even a token document aimed at a pending record does nothing.
        const stray = waitlist.newConfirmToken();
        await db.collection('waitlistUnsubscribeTokens').doc(sha(stray)).set({
            waitlistId: docIdFor(email), issuedAt: Timestamp.fromMillis(clock),
            validUntil: Timestamp.fromMillis(clock + 60_000), subscriptionConfirmedAt: null,
        });
        expect(await unsubscribe(stray)).toMatchObject({ statusCode: 410, body: INVALID });
        const data = await readDoc(email);
        expect(data.status).toBe('pending_confirmation');
        expect(data).not.toHaveProperty('lastUnsubscribedAt');
    });

    it('WL-UN8 an already-unsubscribed record gets the generic 410', async () => {
        const email = await seedSubscriber('twice');
        const token = await issue(email);
        await refFor(email).update({ status: 'unsubscribed', lastUnsubscribedAt: Timestamp.fromMillis(clock) });
        expect(await unsubscribe(token)).toMatchObject({ statusCode: 410, body: INVALID });
        expect((await readDoc(email)).lastUnsubscribedAt.toMillis()).toBe(clock);
    });

    it('WL-UN9 a legacy subscriber (confirmedAt null) can unsubscribe and keeps its provenance', async () => {
        const email = await seedSubscriber('legacy', LEGACY);
        const token = await issue(email);
        expect((await tokenDoc(token)).subscriptionConfirmedAt).toBeNull();
        expect((await unsubscribe(token)).statusCode).toBe(200);
        expect(await readDoc(email)).toMatchObject({ status: 'unsubscribed', ...LEGACY });
    });

    it('WL-UN10 rejoining needs a fresh confirmation, and old-subscription tokens cannot end the new one', async () => {
        const email = await seedSubscriber('rejoin', LEGACY);
        const used = await issue(email);
        const leftover = await issue(email);
        expect((await unsubscribe(used)).statusCode).toBe(200);
        const optedOutAt = (await readDoc(email)).lastUnsubscribedAt.toMillis();

        expect((await join(email)).statusCode).toBe(202);
        expect(sent).toHaveLength(1);
        let data = await readDoc(email);
        expect(data).toMatchObject({
            status: 'pending_confirmation', optInMethod: 'double-opt-in',
            consentVersion: 'waitlist-2026-09-v1', source: 'squarespace-import', confirmedAt: null,
        });
        expect(data.lastUnsubscribedAt.toMillis()).toBe(optedOutAt);
        expect(await issue(email)).toBeNull();

        expect((await confirm(tokenFrom(sent[0].url))).statusCode).toBe(200);
        data = await readDoc(email);
        expect(data).toMatchObject({ status: 'subscribed', optInMethod: 'double-opt-in', source: 'squarespace-import' });
        expect(data.confirmedAt).toBeInstanceOf(Timestamp);
        expect(data.lastUnsubscribedAt.toMillis()).toBe(optedOutAt);

        // The leftover token belongs to the legacy subscription (null/null) and
        // is still inside its window, but cannot end the new subscription.
        expect(await unsubscribe(leftover)).toMatchObject({ statusCode: 410, body: INVALID });
        expect((await readDoc(email)).status).toBe('subscribed');

        // A token issued for the new subscription works.
        expect((await unsubscribe(await issue(email))).statusCode).toBe(200);
    });

    it('WL-UN11 a GET (page load or link scanner) changes nothing', async () => {
        const email = await seedSubscriber('scanner');
        const token = await issue(email);
        const res = await post(indexModule.unsubscribeWaitlist, { token }, { method: 'GET' });
        expect(res.statusCode).toBe(405);
        expect((await post(indexModule.unsubscribeWaitlist, 't=x', { json: false })).statusCode).toBe(400);
        expect((await readDoc(email)).status).toBe('subscribed');
        expect(await tokenDoc(token)).toBeDefined();
        expect((await unsubscribe(token)).statusCode).toBe(200);
    });

    it('WL-UN12 never logs the address or a token', async () => {
        const email = await seedSubscriber('logs');
        const token = await issue(email);
        await unsubscribe(token);
        await unsubscribe(token);
        await join(email);
        const confirmToken = tokenFrom(sent[0].url);
        await confirm(confirmToken);
        const all = logs.join('\n');
        for (const secret of [email, token, sha(token), confirmToken]) expect(all).not.toContain(secret);
    });
});

describe('WL-XR — scheduled cleanup and former subscribers', () => {
    it('WL-XR1 keeps a rejoining record while its link is live, then returns it to unsubscribed', async () => {
        const email = nextEmail('xrejoin');
        const old = Timestamp.fromMillis(Date.now() - waitlist.PENDING_RETENTION_MS - 60_000);
        const ref = db.collection('waitlist').doc(docIdFor(email));
        await ref.set({
            email, status: 'unsubscribed', optInMethod: 'legacy-squarespace', source: 'squarespace-import',
            consentVersion: 'squarespace-legacy', createdAt: old, confirmedAt: null, lastUnsubscribedAt: old,
        });
        indexModule._waitlistHooks.now = null;
        await join(email);

        await indexModule.expireStaleWaitlistSignups.run({});
        expect((await readDoc(email)).status).toBe('pending_confirmation');

        await ref.update({ confirmTokenExpiresAt: Timestamp.fromMillis(Date.now() - 1000) });
        await indexModule.expireStaleWaitlistSignups.run({});
        const data = await readDoc(email);
        expect(data).toMatchObject({ status: 'unsubscribed', source: 'squarespace-import' });
        expect(data.lastUnsubscribedAt.toMillis()).toBe(old.toMillis());
        expect(data).not.toHaveProperty('confirmTokenHash');
    });

    it('WL-XR2 deletes expired unsubscribe tokens and keeps valid ones', async () => {
        const tokens = db.collection('waitlistUnsubscribeTokens');
        const expiredId = crypto.randomBytes(32).toString('hex');
        const validId = crypto.randomBytes(32).toString('hex');
        const grant = validUntil => ({
            waitlistId: 'x'.repeat(64), issuedAt: Timestamp.now(), validUntil, subscriptionConfirmedAt: null,
        });
        await tokens.doc(expiredId).set(grant(Timestamp.fromMillis(Date.now() - 1000)));
        await tokens.doc(validId).set(grant(Timestamp.fromMillis(Date.now() + 60_000)));

        indexModule._waitlistHooks.now = null;
        await indexModule.expireStaleWaitlistSignups.run({});

        expect((await tokens.doc(expiredId).get()).exists).toBe(false);
        expect((await tokens.doc(validId).get()).exists).toBe(true);
    });
});
