'use strict';

process.env.EMAIL_RATE_LIMIT_PEPPER = 'integration-test-email-rate-limit-pepper';

const crypto = require('crypto');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');

const { requireEmulatorProjectId } = require('./emulatorProjectId');
const PROJECT_ID = requireEmulatorProjectId();
const APP_NAME = '__generateEmailOTP_intg__';
const testApp = getApps().find(a => a.name === APP_NAME) ?? initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const indexModule = require('./index.js');

const RUN = `${process.pid}_${Date.now()}`;
let seq = 0;
const nextUid = label => `ge_${label}_${RUN}_${++seq}`;
const request = (uid, data) => ({
    data,
    auth: uid ? { uid, token: { uid, auth_time: 1, iat: 1, exp: 9999999999 } } : null,
    rawRequest: {},
});

async function call(handler, uid, data) {
    try { return { result: await handler.run(request(uid, data)) }; }
    catch (error) { return { error }; }
}

function emailHash(email) {
    return crypto.createHmac('sha256', process.env.EMAIL_RATE_LIMIT_PEPPER)
        .update(indexModule._canonicalizeEmail(email)).digest('hex');
}

async function cleanup(uid, emails = []) {
    await db.doc(`emailVerificationCodes/${uid}`).delete().catch(() => {});
    const wk = Math.floor(Date.now() / 3600000);
    await db.doc(`rateLimits/generateEmailOTP_${wk}_${uid}`).delete().catch(() => {});
    await db.doc(`rateLimits/verifyEmailOTP_${Math.floor(Date.now() / 900000)}_${uid}`).delete().catch(() => {});
    for (const email of emails) {
        await db.doc(`rateLimits/generateEmailOTP_email_${wk}_${emailHash(email)}`).delete().catch(() => {});
    }
}

describe('GE — email OTP security contract', () => {
    beforeEach(() => {
        indexModule._emailOtpHooks.deliver = async () => {};
        indexModule._emailOtpHooks.now = null;
        indexModule._emailOtpHooks.generateCode = null;
    });

    afterEach(() => {
        indexModule._emailOtpHooks.deliver = null;
        indexModule._emailOtpHooks.now = null;
        indexModule._emailOtpHooks.generateCode = null;
        vi.restoreAllMocks();
    });

    it('GE-1 rejects unauthenticated requests', async () => {
        const { error } = await call(indexModule.generateEmailOTP, null, { email: 'user@example.com' });
        expect(error.code).toBe('unauthenticated');
    });

    it.each([
        '', '   ', 'plainaddress', '@example.com', 'user@', 'a@@example.com',
        'user @example.com', 'user@exa mple.com', 'user\n@example.com',
        'user@example', 'user@-example.com', 'user@example-.com', 'user@example..com',
        `${'a'.repeat(65)}@example.com`, `a@${'b'.repeat(250)}.com`, 'üser@example.com',
    ])('GE-2 rejects malformed email %j', email => {
        expect(() => indexModule._canonicalizeEmail(email)).toThrow(/valid email/i);
    });

    it('GE-3 canonicalizes equivalent forms without provider-specific rewriting', () => {
        expect(indexModule._canonicalizeEmail('  User.Name+tag@EXAMPLE.COM  ')).toBe('user.name+tag@example.com');
        expect(indexModule._canonicalizeEmail('UserName@gmail.com')).toBe('username@gmail.com');
        expect(indexModule._canonicalizeEmail('user.name@gmail.com')).toBe('user.name@gmail.com');
    });

    it('GE-4 generates an unbiased six-digit decimal string through crypto.randomInt bounds', () => {
        expect(indexModule._generateEmailOtpCode()).toMatch(/^\d{6}$/);
        expect(indexModule._generateEmailOtpCode((min, max) => { expect([min, max]).toEqual([100000, 1000000]); return min; })).toBe('100000');
        expect(indexModule._generateEmailOtpCode(() => 999999)).toBe('999999');
    });

    it('GE-5 stores the canonical recipient, six-digit code, active status, and ten-minute expiry after delivery', async () => {
        const uid = nextUid('store');
        const raw = '  Mixed.Case+tag@Example.COM ';
        indexModule._emailOtpHooks.generateCode = () => '123456';
        const before = Date.now();
        const { result, error } = await call(indexModule.generateEmailOTP, uid, { email: raw });
        expect(error).toBeUndefined();
        expect(result).toEqual({ success: true });
        const snap = await db.doc(`emailVerificationCodes/${uid}`).get();
        expect(snap.data()).toMatchObject({ email: 'mixed.case+tag@example.com', code: '123456', status: 'active' });
        expect(snap.data().expiresAt.toMillis()).toBeGreaterThanOrEqual(before + 600000);
        expect(snap.data().expiresAt.toMillis()).toBeLessThanOrEqual(Date.now() + 600000);
        expect(snap.data()).not.toHaveProperty('pepper');
        expect(snap.data()).not.toHaveProperty('token');
        await cleanup(uid, [raw]);
    });

    it('GE-6 replaces a prior code and the old code cannot verify', async () => {
        const uid = nextUid('replace');
        const email = 'replace@example.com';
        let now = Date.now();
        indexModule._emailOtpHooks.now = () => now;
        indexModule._emailOtpHooks.generateCode = () => '111111';
        await call(indexModule.generateEmailOTP, uid, { email });
        now += 61000;
        indexModule._emailOtpHooks.generateCode = () => '222222';
        await call(indexModule.generateEmailOTP, uid, { email });
        expect((await db.doc(`emailVerificationCodes/${uid}`).get()).data().code).toBe('222222');
        expect((await call(indexModule.verifyEmailOTP, uid, { email, code: '111111' })).error.code).toBe('invalid-argument');
        await cleanup(uid, [email]);
    });

    it('GE-7 successful verification consumes the code and reuse fails', async () => {
        const uid = nextUid('consume');
        const email = 'consume@example.com';
        await db.doc(`users/${uid}`).set({ id: uid });
        indexModule._emailOtpHooks.generateCode = () => '333333';
        await call(indexModule.generateEmailOTP, uid, { email });
        expect((await call(indexModule.verifyEmailOTP, uid, { email, code: '333333' })).result).toEqual({ success: true });
        expect((await call(indexModule.verifyEmailOTP, uid, { email, code: '333333' })).error.code).toBe('not-found');
        expect((await db.doc(`users/${uid}/private/account`).get()).data().email).toBe(email);
        await db.recursiveDelete(db.doc(`users/${uid}`));
        await cleanup(uid, [email]);
    });

    it('GE-8 provider failure removes the pending OTP and returns a sanitized error', async () => {
        const uid = nextUid('provider');
        const email = 'private.recipient@example.com';
        const secret = 'SG.private-secret';
        const authToken = 'firebase-auth-token-private';
        const hash = emailHash(email);
        indexModule._emailOtpHooks.deliver = async () => { throw new Error(`provider rejected ${email} ${secret} ${authToken} ${hash}`); };
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { error } = await call(indexModule.generateEmailOTP, uid, { email });
        expect(error).toMatchObject({ code: 'internal', message: 'Failed to send verification email.' });
        expect((await db.doc(`emailVerificationCodes/${uid}`).get()).exists).toBe(false);
        const renderedLogs = JSON.stringify(log.mock.calls);
        expect(renderedLogs).not.toContain(email);
        expect(renderedLogs).not.toContain(secret);
        expect(renderedLogs).not.toContain(authToken);
        expect(renderedLogs).not.toContain(hash);
        expect(renderedLogs).not.toMatch(/\b\d{6}\b/);
        await cleanup(uid, [email]);
    });

    it('GE-8a logs the numeric SendGrid status and nothing else from the response', async () => {
        // The status is the whole point: 403 (rejected key / unverified sender)
        // must be distinguishable from 400 (bad payload) and 5xx (outage).
        const uid = nextUid('status403');
        const email = 'status.recipient@example.com';
        const bodyText = 'The from address does not match a verified Sender Identity ' + email;
        let cancelled = false;
        const fakeFetch = async () => ({
            ok: false,
            status: 403,
            body: { cancel: async () => { cancelled = true; } },
            text: async () => bodyText,
            json: async () => ({ errors: [{ message: bodyText }] }),
        });
        indexModule._emailOtpHooks.deliver = (to, code) =>
            indexModule._deliverEmailOtp(to, code, fakeFetch);
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});

        const { error } = await call(indexModule.generateEmailOTP, uid, { email });

        expect(error).toMatchObject({ code: 'internal', message: 'Failed to send verification email.' });
        // structured field, not string interpolation
        expect(log).toHaveBeenCalledWith('Email OTP delivery failed', { status: 403 });
        // the body was discarded unread, exactly as before
        expect(cancelled).toBe(true);
        const rendered = JSON.stringify(log.mock.calls);
        expect(rendered).not.toContain(bodyText);
        expect(rendered).not.toContain('verified Sender Identity');
        expect(rendered).not.toContain(email);
        expect(rendered).not.toContain('Bearer');
        expect(rendered).not.toContain('api.sendgrid.com');
        expect(rendered).not.toMatch(/\d{6}/);   // no OTP
        // rollback still removes the pending code
        expect((await db.doc(`emailVerificationCodes/${uid}`).get()).exists).toBe(false);
        await cleanup(uid, [email]);
    });

    it('GE-8b omits the status when the failure had no HTTP response', async () => {
        // Network error / AbortSignal timeout: there is no status to report, so the
        // log line stays exactly what it was before this change.
        const uid = nextUid('statusnone');
        const email = 'timeout.recipient@example.com';
        const fakeFetch = async () => { throw new Error('network down'); };
        indexModule._emailOtpHooks.deliver = (to, code) =>
            indexModule._deliverEmailOtp(to, code, fakeFetch);
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});

        const { error } = await call(indexModule.generateEmailOTP, uid, { email });

        expect(error).toMatchObject({ code: 'internal', message: 'Failed to send verification email.' });
        expect(log).toHaveBeenCalledWith('Email OTP delivery failed');
        expect(JSON.stringify(log.mock.calls)).not.toContain(email);
        expect((await db.doc(`emailVerificationCodes/${uid}`).get()).exists).toBe(false);
        await cleanup(uid, [email]);
    });

    it('GE-8c a 2xx response still succeeds and logs no delivery error', async () => {
        const uid = nextUid('status200');
        const email = 'ok.recipient@example.com';
        const fakeFetch = async () => ({ ok: true, status: 202, body: null });
        indexModule._emailOtpHooks.deliver = (to, code) =>
            indexModule._deliverEmailOtp(to, code, fakeFetch);
        indexModule._emailOtpHooks.generateCode = () => '456789';
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});

        const { result, error } = await call(indexModule.generateEmailOTP, uid, { email });

        expect(error).toBeUndefined();
        expect(result).toMatchObject({ success: true });
        expect(log).not.toHaveBeenCalledWith('Email OTP delivery failed', expect.anything());
        expect(log).not.toHaveBeenCalledWith('Email OTP delivery failed');
        const snap = await db.doc(`emailVerificationCodes/${uid}`).get();
        expect(snap.exists).toBe(true);
        expect(snap.data()).toMatchObject({ status: 'active' });   // not rolled back
        await cleanup(uid, [email]);
    });

    it('GE-9 concurrent requests for one UID leave exactly one authoritative code', async () => {
        const uid = nextUid('race');
        const email = 'race@example.com';
        let deliveries = 0;
        indexModule._emailOtpHooks.deliver = async () => { deliveries++; };
        const results = await Promise.allSettled([
            indexModule.generateEmailOTP.run(request(uid, { email })),
            indexModule.generateEmailOTP.run(request(uid, { email: email.toUpperCase() })),
        ]);
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
        expect(deliveries).toBe(1);
        expect((await db.doc(`emailVerificationCodes/${uid}`).get()).data().status).toBe('active');
        await cleanup(uid, [email]);
    });

    it('GE-10 canonical equivalents share an HMAC bucket while distinct emails do not', () => {
        expect(emailHash(' User@Example.com ')).toBe(emailHash('user@example.COM'));
        expect(emailHash('user@example.com')).not.toBe(emailHash('other@example.com'));
    });

    it('GE-11 verification accepts canonical equivalents and legacy mixed-case records', async () => {
        const uid = nextUid('legacy');
        await db.doc(`users/${uid}`).set({ id: uid });
        await db.doc(`emailVerificationCodes/${uid}`).set({
            email: 'Legacy.User@Example.COM', code: '444444',
            createdAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 600000),
        });
        const { result } = await call(indexModule.verifyEmailOTP, uid, { email: ' legacy.user@example.com ', code: '444444' });
        expect(result).toEqual({ success: true });
        expect((await db.doc(`users/${uid}/private/account`).get()).data().email).toBe('legacy.user@example.com');
        await db.recursiveDelete(db.doc(`users/${uid}`));
        await cleanup(uid, ['legacy.user@example.com']);
    });

    it('GE-12 wrong and malformed codes share one safe error while expired codes retain intended expiry behavior', async () => {
        const uid = nextUid('compare');
        const email = 'compare@example.com';
        await db.doc(`emailVerificationCodes/${uid}`).set({ email, code: '555555', expiresAt: Timestamp.fromMillis(Date.now() + 600000), status: 'active' });
        const wrong = await call(indexModule.verifyEmailOTP, uid, { email, code: '000000' });
        const malformed = await call(indexModule.verifyEmailOTP, uid, { email, code: '55x' });
        expect([wrong.error.code, wrong.error.message]).toEqual([malformed.error.code, malformed.error.message]);
        await db.doc(`emailVerificationCodes/${uid}`).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1) });
        expect((await call(indexModule.verifyEmailOTP, uid, { email, code: '555555' })).error.code).toBe('deadline-exceeded');
        expect((await db.doc(`emailVerificationCodes/${uid}`).get()).exists).toBe(false);
        await cleanup(uid, [email]);
    });

    it('GE-13 delivery adapter handles acceptance and rejects provider/network/timeout/malformed outcomes generically', async () => {
        const ok = vi.fn(async () => ({ ok: true, status: 202, body: null }));
        await expect(indexModule._deliverEmailOtp('user@example.com', '123456', ok)).resolves.toBeUndefined();
        for (const fetchFn of [
            async () => ({ ok: false, status: 400, body: { cancel: async () => {} } }),
            async () => { throw new Error('network details'); },
            async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); },
            async () => null,
        ]) {
            await expect(indexModule._deliverEmailOtp('user@example.com', '123456', fetchFn))
                .rejects.toThrow('Email delivery failed');
        }
    });

    it('GE-14 enforces exactly ten UID requests per hour', async () => {
        const uid = nextUid('uidlimit');
        const email = 'uid-limit@example.com';
        const wk = Math.floor(Date.now() / 3600000);
        const ref = db.doc(`rateLimits/generateEmailOTP_${wk}_${uid}`);
        await ref.set({ count: 9, uid, operation: 'generateEmailOTP', expiresAt: Timestamp.fromMillis(Date.now() + 7200000) });
        expect((await call(indexModule.generateEmailOTP, uid, { email })).result).toEqual({ success: true });
        expect((await ref.get()).data().count).toBe(10);
        expect((await call(indexModule.generateEmailOTP, uid, { email })).error.code).toBe('resource-exhausted');
        await cleanup(uid, [email]);
    });

    it('GE-15 enforces ten requests per canonical email HMAC without a raw-email key', async () => {
        const uid = nextUid('emaillimit');
        const email = ' Hmac.Target@Example.COM ';
        const hash = emailHash(email);
        const wk = Math.floor(Date.now() / 3600000);
        const ref = db.doc(`rateLimits/generateEmailOTP_email_${wk}_${hash}`);
        await ref.set({ count: 10, uid: hash, operation: 'generateEmailOTP_email', expiresAt: Timestamp.fromMillis(Date.now() + 7200000) });
        expect((await call(indexModule.generateEmailOTP, uid, { email })).error.code).toBe('resource-exhausted');
        expect((await db.doc(`emailVerificationCodes/${uid}`).get()).exists).toBe(false);
        const rateDoc = await ref.get();
        expect(rateDoc.id).not.toContain('hmac.target');
        expect(JSON.stringify(rateDoc.data())).not.toContain('hmac.target@example.com');
        await cleanup(uid, [email]);
    });

    it('GE-16 one actor cannot consume another authenticated UID bucket', async () => {
        const blockedUid = nextUid('blocked');
        const allowedUid = nextUid('allowed');
        const wk = Math.floor(Date.now() / 3600000);
        await db.doc(`rateLimits/generateEmailOTP_${wk}_${blockedUid}`).set({
            count: 10, uid: blockedUid, operation: 'generateEmailOTP', expiresAt: Timestamp.fromMillis(Date.now() + 7200000),
        });
        expect((await call(indexModule.generateEmailOTP, blockedUid, { email: 'blocked@example.com' })).error.code).toBe('resource-exhausted');
        expect((await call(indexModule.generateEmailOTP, allowedUid, { email: 'allowed@example.com' })).result).toEqual({ success: true });
        await cleanup(blockedUid, ['blocked@example.com']);
        await cleanup(allowedUid, ['allowed@example.com']);
    });

    it('GE-17 stale-window rate documents cannot affect the active window', async () => {
        const uid = nextUid('window');
        const email = 'window@example.com';
        const wk = Math.floor(Date.now() / 3600000);
        await db.doc(`rateLimits/generateEmailOTP_${wk - 1}_${uid}`).set({
            count: 10, uid, operation: 'generateEmailOTP', expiresAt: Timestamp.fromMillis(Date.now() + 7200000),
        });
        expect((await call(indexModule.generateEmailOTP, uid, { email })).result).toEqual({ success: true });
        await db.doc(`rateLimits/generateEmailOTP_${wk - 1}_${uid}`).delete();
        await cleanup(uid, [email]);
    });

    it('GE-18 account-write failure rolls back OTP consumption', async () => {
        const uid = nextUid('atomic');
        const email = 'atomic@example.com';
        await db.doc(`emailVerificationCodes/${uid}`).set({
            email, code: '666666', status: 'active',
            createdAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 600000),
        });
        const { error } = await call(indexModule.verifyEmailOTP, uid, { email, code: '666666' });
        expect(error).toBeTruthy();
        const otp = await db.doc(`emailVerificationCodes/${uid}`).get();
        expect(otp.exists).toBe(true);
        expect(otp.data().code).toBe('666666');
        expect((await db.doc(`users/${uid}/private/account`).get()).exists).toBe(false);
        await cleanup(uid, [email]);
    });

    it('GE-19 a delayed older delivery cannot overwrite or delete a newer successful OTP', async () => {
        const uid = nextUid('stale');
        const email = 'stale@example.com';
        let now = Date.now();
        let releaseFirst;
        const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });
        let deliveryCount = 0;
        indexModule._emailOtpHooks.now = () => now;
        indexModule._emailOtpHooks.generateCode = () => deliveryCount === 0 ? '111111' : '222222';
        indexModule._emailOtpHooks.deliver = async () => {
            deliveryCount++;
            if (deliveryCount === 1) await firstBlocked;
        };

        const older = indexModule.generateEmailOTP.run(request(uid, { email }));
        while (deliveryCount === 0) await new Promise(resolve => setTimeout(resolve, 5));
        now += 61000;
        const newer = await indexModule.generateEmailOTP.run(request(uid, { email }));
        expect(newer).toEqual({ success: true });
        releaseFirst();
        await expect(older).rejects.toMatchObject({ code: 'internal' });

        const authoritative = await db.doc(`emailVerificationCodes/${uid}`).get();
        expect(authoritative.data()).toMatchObject({ code: '222222', status: 'active' });
        await cleanup(uid, [email]);
    });

    it('GE-20 failed replacement invalidates both the old and undelivered new code', async () => {
        const uid = nextUid('failedreplace');
        const email = 'failed-replacement@example.com';
        const oldCreated = Date.now() - 61000;
        await db.doc(`emailVerificationCodes/${uid}`).set({
            email, code: '777777', status: 'active',
            createdAt: Timestamp.fromMillis(oldCreated), expiresAt: Timestamp.fromMillis(Date.now() + 300000),
        });
        indexModule._emailOtpHooks.generateCode = () => '888888';
        indexModule._emailOtpHooks.deliver = async () => { throw new Error('provider failure'); };
        vi.spyOn(console, 'error').mockImplementation(() => {});
        expect((await call(indexModule.generateEmailOTP, uid, { email })).error.code).toBe('internal');
        expect((await db.doc(`emailVerificationCodes/${uid}`).get()).exists).toBe(false);
        expect((await call(indexModule.verifyEmailOTP, uid, { email, code: '777777' })).error.code).toBe('not-found');
        expect((await call(indexModule.verifyEmailOTP, uid, { email, code: '888888' })).error.code).toBe('not-found');
        await cleanup(uid, [email]);
    });

    it('GE-21 admits exactly ten distinct UIDs to one canonical email bucket', async () => {
        const email = `shared-${RUN}@example.com`;
        const uids = Array.from({ length: 11 }, (_, i) => nextUid(`shared${i}`));
        for (let i = 0; i < 10; i++) {
            expect((await call(indexModule.generateEmailOTP, uids[i], { email })).result).toEqual({ success: true });
        }
        expect((await call(indexModule.generateEmailOTP, uids[10], { email: email.toUpperCase() })).error.code)
            .toBe('resource-exhausted');
        await Promise.all(uids.map(uid => cleanup(uid, [email])));
    });
});
