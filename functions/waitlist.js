'use strict';

/**
 * Marketing-site waitlist: double opt-in signup, confirmation and unsubscribe.
 *
 * Privacy contract (see docs/WAITLIST.md):
 * - Email only. No IP address, name, device or location is written to
 *   waitlist/{id}.
 * - The document ID is HMAC-SHA256(WAITLIST_ID_PEPPER, canonical email), so a
 *   repeat signup lands on the same record and the ID cannot be reversed or
 *   enumerated without the secret.
 * - The confirmation token exists raw only inside the email. Firestore holds
 *   its SHA-256 hash, which is deleted once the token is used.
 * - Every well-formed signup gets the same response whether the address is
 *   new, pending or already subscribed.
 * - Unsubscribe tokens follow the same rule: raw only in the email, SHA-256
 *   hash as the waitlistUnsubscribeTokens document ID, removed once used.
 *
 * The handlers here take their collaborators as arguments so the integration
 * tests can drive them against the emulator without real email or Turnstile.
 */

const { createHash, createHmac, randomBytes } = require('crypto');
const { isIP } = require('net');

const WAITLIST_COLLECTION = 'waitlist';
const CONSENT_VERSION = 'waitlist-2026-09-v1';
const LEGACY_CONSENT_VERSION = 'squarespace-legacy';

const STATUS = Object.freeze({
    PENDING: 'pending_confirmation',
    SUBSCRIBED: 'subscribed',
    UNSUBSCRIBED: 'unsubscribed',
});

const OPT_IN = Object.freeze({
    DOUBLE: 'double-opt-in',
    LEGACY: 'legacy-squarespace',
});

const SOURCE = Object.freeze({
    SITE: 'marketing-site',
    SQUARESPACE: 'squarespace-import',
});

const TOKEN_BYTES = 32;
const TOKEN_TTL_MS = 48 * 60 * 60 * 1000;
const PENDING_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** Minimum gap between confirmation emails to one address. */
const RESEND_COOLDOWN_MS = 60 * 1000;

const JOIN_LIMIT = { limit: 5, windowSec: 600 };
const CONFIRM_LIMIT = { limit: 20, windowSec: 600 };
const UNSUBSCRIBE_LIMIT = { limit: 20, windowSec: 600 };

const UNSUBSCRIBE_TOKEN_COLLECTION = 'waitlistUnsubscribeTokens';
// Commercial email must keep its opt-out working for at least 30 days after
// sending; 60 leaves margin for late reads.
const UNSUBSCRIBE_TOKEN_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const ADDRESS_EMAIL_LIMIT = { limit: 3, windowSec: 3600 };

const TURNSTILE_ACTION = 'waitlist';
const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const SENDGRID_URL = 'https://api.sendgrid.com/v3/mail/send';

// 32 bytes -> 43 base64url characters, no padding.
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

function waitlistDocId(canonicalEmail, pepper) {
    if (!pepper) throw new Error('WAITLIST_ID_PEPPER is not configured');
    return createHmac('sha256', pepper).update(canonicalEmail).digest('hex');
}

function newConfirmToken(randomBytesFn = randomBytes) {
    return randomBytesFn(TOKEN_BYTES).toString('base64url');
}

function hashConfirmToken(token) {
    return createHash('sha256').update(token).digest('hex');
}

function isWellFormedToken(token) {
    return typeof token === 'string' && TOKEN_SHAPE.test(token);
}

/**
 * Best-effort per-client throttle key, or null when there is nothing usable.
 *
 * ABUSE MITIGATION ONLY — NOT AUTHENTICATION. Fastly-Client-IP is used because,
 * on the Firebase Hosting path, the CDN sets it to the connecting client and
 * overwrites a value the client sent. It is still not an identity and not a
 * security boundary: a request sent straight to the function URL (bypassing
 * Hosting) can set it to anything. The controls that hold regardless are, in
 * order: Turnstile verification, then the per-address confirmation-email
 * limit. This throttle only raises the cost of bursts from one client.
 *
 * - X-Forwarded-For (or any other forwarded header) is never consulted: on
 *   this path its visible entry is a Google front-end address, and anywhere
 *   else it is caller-controlled.
 * - An absent or malformed header returns null and the caller skips this
 *   throttle. It must not collapse everyone into one shared bucket, which
 *   would let a header change on Hosting's side throttle every real visitor.
 * - The IP is HMAC'd immediately with the dedicated rate-limit secret. Only
 *   that digest is used, and only as part of an expiring rateLimits counter
 *   ID. The raw IP is never logged, returned or stored.
 */
function clientRateLimitKey(headers, pepper) {
    if (!pepper) throw new Error('WAITLIST_RATE_LIMIT_PEPPER is not configured');
    const raw = headers?.['fastly-client-ip'];
    const ip = typeof raw === 'string' ? raw.trim() : '';
    if (!ip || isIP(ip) === 0) return null;
    return createHmac('sha256', pepper).update(ip).digest('hex');
}

/** Applies the per-client throttle only when a usable client key exists. */
async function withinClientLimit(checkRateLimit, headers, pepper, operation, limits) {
    const key = clientRateLimitKey(headers, pepper);
    if (key === null) return true;
    return withinLimit(checkRateLimit, key, operation, limits);
}

function buildUnsubscribeUrl(baseUrl, token) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    return `${base}/unsubscribe#t=${token}`;
}

function buildConfirmUrl(baseUrl, token) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    // The fragment is never sent to a server, so the token stays out of
    // access logs and Referer headers.
    return `${base}/confirm#t=${token}`;
}

function confirmationEmail(confirmUrl) {
    // Derived, so the copy cannot drift away from the real token lifetime.
    const expiryHours = TOKEN_TTL_MS / (60 * 60 * 1000);
    const expiry = `This link expires in ${expiryHours} hours.`;
    const subject = 'Confirm your spot on the ParQueen waitlist';
    const text = [
        'ParQueen — Early access',
        '',
        'Confirm your spot.',
        '',
        "You're one step away from joining the ParQueen waitlist.",
        '',
        'Confirm your email:',
        confirmUrl,
        '',
        expiry,
        "If you didn't request this, you can ignore this email.",
        '',
        'ParQueen · New York',
    ].join('\n');

    // Email HTML: tables, inline styles, no images, no webfonts, no
    // JavaScript. The brand is set in type, so the email is intact when a
    // client blocks remote content. Dark clients keep the navy; light
    // clients get it too, because every colour is explicit.
    const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark light">
<title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#020b18;color:#e8f1ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">Confirm your email to finish joining the ParQueen waitlist.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#020b18">
<tr><td align="center" style="padding:32px 16px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#071321;border:1px solid #16304d;border-radius:16px">
<tr><td style="padding:40px 32px 0">
<p style="margin:0;font-size:22px;font-weight:bold;letter-spacing:-0.5px;color:#ffffff">ParQueen</p>
</td></tr>
<tr><td style="padding:32px 32px 0">
<p style="margin:0 0 12px;font-size:12px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;color:#45d9ff">Early access</p>
<h1 style="margin:0;font-size:32px;line-height:1.1;font-weight:bold;letter-spacing:-1px;color:#ffffff">Confirm your spot.</h1>
<p style="margin:16px 0 0;font-size:16px;line-height:1.5;color:#a9bfd9">You&rsquo;re one step away from joining the ParQueen waitlist.</p>
</td></tr>
<tr><td style="padding:32px 32px 0">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td bgcolor="#1573ff" style="border-radius:12px">
<a href="${confirmUrl}" style="display:inline-block;padding:16px 28px;font-size:16px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:12px">Confirm my email</a>
</td></tr></table>
</td></tr>
<tr><td style="padding:24px 32px 0">
<p style="margin:0;font-size:13px;line-height:1.5;color:#7e97b5">${expiry}</p>
<p style="margin:8px 0 0;font-size:13px;line-height:1.5;color:#7e97b5">If you didn&rsquo;t request this, you can ignore this email.</p>
</td></tr>
<tr><td style="padding:24px 32px 40px">
<p style="margin:0 0 8px;font-size:12px;line-height:1.6;color:#5d7a9c">If the button does not work, paste this link into your browser:</p>
<p style="margin:0;font-size:12px;line-height:1.6;word-break:break-all"><a href="${confirmUrl}" style="color:#6fb6ff;text-decoration:underline">${confirmUrl}</a></p>
</td></tr>
<tr><td style="padding:0 32px 32px">
<hr style="border:0;border-top:1px solid #16304d;margin:0 0 16px">
<p style="margin:0;font-size:12px;color:#5d7a9c">ParQueen &middot; New York</p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
    return { subject, text, html };
}

/**
 * Sends the confirmation email. Click and open tracking are disabled so
 * SendGrid does not rewrite the link (which would route the token through its
 * redirector) or add a tracking pixel. The response body is never read: it can
 * echo the recipient address.
 */
async function sendConfirmationEmail({ email, confirmUrl, apiKey, fetchFn = fetch }) {
    const { subject, text, html } = confirmationEmail(confirmUrl);
    let status;
    try {
        const res = await fetchFn(SENDGRID_URL, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                personalizations: [{ to: [{ email }] }],
                from: { email: 'hello@parqueen.app', name: 'ParQueen' },
                subject,
                content: [
                    { type: 'text/plain', value: text },
                    { type: 'text/html', value: html },
                ],
                tracking_settings: {
                    click_tracking: { enable: false, enable_text: false },
                    open_tracking: { enable: false },
                },
            }),
            signal: AbortSignal.timeout(10000),
        });
        if (!res || res.ok !== true) {
            if (typeof res?.status === 'number') status = res.status;
            await res?.body?.cancel?.();
            throw new Error('Waitlist email delivery failed');
        }
    } catch {
        const err = new Error('Waitlist email delivery failed');
        if (status !== undefined) err.status = status;
        throw err;
    }
}

/**
 * Server-side Turnstile check. Requires success, the waitlist action and an
 * allowlisted hostname. The visitor IP is deliberately not sent.
 */
async function verifyTurnstileToken({ token, secret, allowedHostnames, fetchFn = fetch }) {
    if (typeof token !== 'string' || !token || token.length > 2048) return false;
    if (!secret) return false;
    try {
        const res = await fetchFn(TURNSTILE_VERIFY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ secret, response: token }).toString(),
            signal: AbortSignal.timeout(10000),
        });
        if (!res || res.ok !== true) return false;
        const outcome = await res.json();
        return outcome?.success === true
            && outcome.action === TURNSTILE_ACTION
            && allowedHostnames.includes(outcome.hostname);
    } catch {
        return false;
    }
}

function parseHostnameList(value) {
    return String(value || '')
        .split(',')
        .map(host => host.trim().toLowerCase())
        .filter(Boolean);
}

/** Maps rateLimiter's resource-exhausted error to a boolean. */
async function withinLimit(checkRateLimit, key, operation, limits) {
    try {
        await checkRateLimit(key, operation, limits);
        return true;
    } catch (error) {
        if (error?.code === 'resource-exhausted') return false;
        throw error;
    }
}

const reply = (status, body) => ({ status, body });

const ACCEPTED = reply(202, { status: 'check_inbox' });

/**
 * POST /api/waitlist  { email, turnstileToken }
 *
 * deps: { db, FieldValue, Timestamp, canonicalizeEmail, checkRateLimit,
 *         verifyTurnstile, deliver, newToken, now, idPepper, rateLimitPepper,
 *         confirmBaseUrl }
 */
async function handleJoin({ body, headers }, deps) {
    let email;
    try {
        email = deps.canonicalizeEmail(body?.email);
    } catch {
        return reply(400, { status: 'invalid_email' });
    }

    // 3rd layer, best effort (see clientRateLimitKey). Checked before Turnstile
    // only so an obvious burst does not spend a siteverify call per request.
    if (!await withinClientLimit(deps.checkRateLimit, headers, deps.rateLimitPepper, 'waitlistJoin', JOIN_LIMIT)) {
        return reply(429, { status: 'rate_limited' });
    }

    // 1st layer: Turnstile.
    if (!await deps.verifyTurnstile(body?.turnstileToken)) {
        return reply(400, { status: 'verification_failed' });
    }

    const docId = waitlistDocId(email, deps.idPepper);
    const ref = deps.db.collection(WAITLIST_COLLECTION).doc(docId);

    // Subscribed addresses never get an email, and nothing about them changes.
    const peek = await ref.get();
    if (peek.exists && peek.data().status === STATUS.SUBSCRIBED) return ACCEPTED;

    // 2nd layer: per-address email limit. Exceeding it is answered exactly like success so
    // the response never hints that someone else recently used this address.
    if (!await withinLimit(deps.checkRateLimit, docId, 'waitlistConfirmEmail', ADDRESS_EMAIL_LIMIT)) {
        return ACCEPTED;
    }

    const nowMs = deps.now();
    const token = deps.newToken();
    const tokenFields = {
        confirmTokenHash: hashConfirmToken(token),
        confirmTokenExpiresAt: deps.Timestamp.fromMillis(nowMs + TOKEN_TTL_MS),
        lastConfirmEmailAt: deps.Timestamp.fromMillis(nowMs),
        updatedAt: deps.FieldValue.serverTimestamp(),
    };

    const shouldSend = await deps.db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) {
            tx.create(ref, {
                email,
                status: STATUS.PENDING,
                optInMethod: OPT_IN.DOUBLE,
                source: SOURCE.SITE,
                consentVersion: CONSENT_VERSION,
                createdAt: deps.FieldValue.serverTimestamp(),
                confirmedAt: null,
                ...tokenFields,
            });
            return true;
        }

        const data = snap.data();
        if (data.status === STATUS.SUBSCRIBED) return false;

        if (data.status === STATUS.PENDING) {
            const lastMs = data.lastConfirmEmailAt?.toMillis?.() ?? 0;
            if (nowMs - lastMs < RESEND_COOLDOWN_MS) return false;
            // Replacing the hash invalidates the previously emailed link.
            tx.update(ref, tokenFields);
            return true;
        }

        // Previously unsubscribed: only an explicit new confirmation resubscribes.
        // source, createdAt, confirmedAt and lastUnsubscribedAt stay as history;
        // confirmation then overwrites confirmedAt with the new consent.
        tx.update(ref, {
            status: STATUS.PENDING,
            optInMethod: OPT_IN.DOUBLE,
            consentVersion: CONSENT_VERSION,
            ...tokenFields,
        });
        return true;
    });

    if (!shouldSend) return ACCEPTED;

    try {
        await deps.deliver(email, buildConfirmUrl(deps.confirmBaseUrl, token));
    } catch {
        // Let the visitor retry straight away instead of waiting out the cooldown.
        await ref.update({ lastConfirmEmailAt: null }).catch(() => {});
        return reply(503, { status: 'try_again' });
    }

    return ACCEPTED;
}

const INVALID_OR_EXPIRED = reply(410, { status: 'invalid_or_expired' });

/**
 * POST /api/waitlist/confirm  { token }
 *
 * deps: { db, FieldValue, checkRateLimit, now, rateLimitPepper }
 */
async function handleConfirm({ body, headers }, deps) {
    const token = body?.token;
    if (!isWellFormedToken(token)) return INVALID_OR_EXPIRED;

    if (!await withinClientLimit(deps.checkRateLimit, headers, deps.rateLimitPepper, 'waitlistConfirm', CONFIRM_LIMIT)) {
        return reply(429, { status: 'rate_limited' });
    }

    const tokenHash = hashConfirmToken(token);
    const matches = await deps.db.collection(WAITLIST_COLLECTION)
        .where('confirmTokenHash', '==', tokenHash)
        .limit(1)
        .get();
    if (matches.empty) return INVALID_OR_EXPIRED;

    const ref = matches.docs[0].ref;
    const nowMs = deps.now();

    const confirmed = await deps.db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists) return false;
        const data = snap.data();
        if (data.status !== STATUS.PENDING || data.confirmTokenHash !== tokenHash) return false;
        const expiresMs = data.confirmTokenExpiresAt?.toMillis?.() ?? 0;
        if (expiresMs <= nowMs) return false;

        tx.update(ref, {
            status: STATUS.SUBSCRIBED,
            optInMethod: OPT_IN.DOUBLE,
            confirmedAt: deps.FieldValue.serverTimestamp(),
            updatedAt: deps.FieldValue.serverTimestamp(),
            // Single use: the hash and its expiry go away with the token.
            confirmTokenHash: deps.FieldValue.delete(),
            confirmTokenExpiresAt: deps.FieldValue.delete(),
            lastConfirmEmailAt: deps.FieldValue.delete(),
        });
        return true;
    });

    return confirmed ? reply(200, { status: 'confirmed' }) : INVALID_OR_EXPIRED;
}

/**
 * For a future launch/marketing sender: issues a fresh unsubscribe token for
 * one subscribed record and returns the raw token (put it only in that
 * message). Returns null when the record is not subscribed; such records must
 * never be emailed.
 *
 * The token lives in waitlistUnsubscribeTokens/{sha256(token)}, valid for
 * UNSUBSCRIBE_TOKEN_TTL_MS, and is tied to the subscription it was issued
 * for through subscriptionConfirmedAt. Neither the raw token nor the email
 * is stored there.
 *
 * deps: { db, FieldValue, Timestamp, newToken, now }
 */
async function issueUnsubscribeToken(ref, deps) {
    const token = deps.newToken();
    const tokenRef = deps.db.collection(UNSUBSCRIBE_TOKEN_COLLECTION).doc(hashConfirmToken(token));
    const issued = await deps.db.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists || snap.data().status !== STATUS.SUBSCRIBED) return false;
        tx.create(tokenRef, {
            waitlistId: ref.id,
            issuedAt: deps.FieldValue.serverTimestamp(),
            validUntil: deps.Timestamp.fromMillis(deps.now() + UNSUBSCRIBE_TOKEN_TTL_MS),
            subscriptionConfirmedAt: snap.data().confirmedAt ?? null,
        });
        return true;
    });
    return issued ? token : null;
}

/** Legacy imports have confirmedAt null; null matches null. */
function sameInstant(a, b) {
    if (a == null || b == null) return a == null && b == null;
    return typeof a.isEqual === 'function' && a.isEqual(b);
}

/**
 * Shared unsubscribe primitive: resolves a raw token and, if it is valid for
 * the record's current subscription, unsubscribes that record. Returns true
 * only when this call performed the opt-out. Meant for both the page's JSON
 * endpoint and a future RFC 8058 one-click endpoint; callers check the token
 * shape first.
 *
 * deps: { db, FieldValue, now }
 */
async function unsubscribeWithToken(token, deps) {
    const tokenRef = deps.db.collection(UNSUBSCRIBE_TOKEN_COLLECTION).doc(hashConfirmToken(token));
    return deps.db.runTransaction(async tx => {
        const tokenSnap = await tx.get(tokenRef);
        if (!tokenSnap.exists) return false;
        const grant = tokenSnap.data();
        if ((grant.validUntil?.toMillis?.() ?? 0) <= deps.now()) return false;

        const ref = deps.db.collection(WAITLIST_COLLECTION).doc(grant.waitlistId);
        const snap = await tx.get(ref);
        if (!snap.exists) return false;
        const data = snap.data();
        if (data.status !== STATUS.SUBSCRIBED) return false;
        // A token from an earlier subscription cannot end a newer one.
        if (!sameInstant(grant.subscriptionConfirmedAt ?? null, data.confirmedAt ?? null)) return false;

        // source, optInMethod, consentVersion, createdAt and confirmedAt are
        // provenance: untouched.
        tx.update(ref, {
            status: STATUS.UNSUBSCRIBED,
            lastUnsubscribedAt: deps.FieldValue.serverTimestamp(),
            updatedAt: deps.FieldValue.serverTimestamp(),
        });
        // Other tokens for this subscription are now harmless: the record is
        // no longer subscribed, and a later confirmation changes confirmedAt.
        tx.delete(tokenRef);
        return true;
    });
}

/**
 * POST /api/waitlist/unsubscribe  { token }
 *
 * No login, email or Turnstile: holding the 256-bit token is the
 * authorization. Opening the emailed link changes nothing; only this POST,
 * sent by the page's "Unsubscribe me" button, mutates. Every failure
 * (malformed, unknown, expired, already used, wrong subscription, record not
 * subscribed) gets the same 410 as confirmation.
 *
 * deps: { db, FieldValue, now, checkRateLimit, rateLimitPepper }
 */
async function handleUnsubscribe({ body, headers }, deps) {
    const token = body?.token;
    // Malformed tokens are rejected before any read, so they cost nothing.
    if (!isWellFormedToken(token)) return INVALID_OR_EXPIRED;

    if (!await withinClientLimit(deps.checkRateLimit, headers, deps.rateLimitPepper, 'waitlistUnsubscribe', UNSUBSCRIBE_LIMIT)) {
        return reply(429, { status: 'rate_limited' });
    }

    return await unsubscribeWithToken(token, deps)
        ? reply(200, { status: 'unsubscribed' })
        : INVALID_OR_EXPIRED;
}

/**
 * Deletes unsubscribe tokens past validUntil. Bounded per run like
 * expireStalePending.
 *
 * deps: { db, Timestamp, now }
 */
async function expireUnsubscribeTokens(deps, batchLimit = 400) {
    const expired = await deps.db.collection(UNSUBSCRIBE_TOKEN_COLLECTION)
        .where('validUntil', '<=', deps.Timestamp.fromMillis(deps.now()))
        .limit(batchLimit)
        .get();
    if (expired.empty) return 0;
    const batch = deps.db.batch();
    for (const doc of expired.docs) batch.delete(doc.ref);
    await batch.commit();
    return expired.size;
}

/**
 * Deletes pending signups older than the retention window. Bounded per run;
 * a backlog drains over successive daily runs.
 *
 * A former subscriber who is rejoining is never deleted: their record holds
 * the opt-out. Once the new link has expired it returns to unsubscribed.
 *
 * deps: { db, Timestamp, FieldValue, now }
 */
async function expireStalePending(deps, batchLimit = 200) {
    const cutoff = deps.Timestamp.fromMillis(deps.now() - PENDING_RETENTION_MS);
    const stale = await deps.db.collection(WAITLIST_COLLECTION)
        .where('status', '==', STATUS.PENDING)
        .where('createdAt', '<', cutoff)
        .limit(batchLimit)
        .get();
    if (stale.empty) return 0;

    let deleted = 0;
    for (const doc of stale.docs) {
        const removed = await deps.db.runTransaction(async tx => {
            const fresh = await tx.get(doc.ref);
            // Re-check: the visitor may have confirmed since the query ran.
            if (!fresh.exists || fresh.data().status !== STATUS.PENDING) return false;
            const data = fresh.data();
            const createdMs = data.createdAt?.toMillis?.() ?? Infinity;
            if (createdMs >= cutoff.toMillis()) return false;
            if (data.lastUnsubscribedAt) {
                const expiresMs = data.confirmTokenExpiresAt?.toMillis?.() ?? 0;
                if (expiresMs > deps.now()) return false;
                tx.update(doc.ref, {
                    status: STATUS.UNSUBSCRIBED,
                    confirmTokenHash: deps.FieldValue.delete(),
                    confirmTokenExpiresAt: deps.FieldValue.delete(),
                    lastConfirmEmailAt: deps.FieldValue.delete(),
                });
                return true;
            }
            tx.delete(doc.ref);
            return true;
        });
        if (removed) deleted++;
    }
    return deleted;
}

module.exports = {
    WAITLIST_COLLECTION,
    CONSENT_VERSION,
    LEGACY_CONSENT_VERSION,
    STATUS,
    OPT_IN,
    SOURCE,
    TOKEN_TTL_MS,
    PENDING_RETENTION_MS,
    RESEND_COOLDOWN_MS,
    JOIN_LIMIT,
    CONFIRM_LIMIT,
    UNSUBSCRIBE_LIMIT,
    UNSUBSCRIBE_TOKEN_COLLECTION,
    UNSUBSCRIBE_TOKEN_TTL_MS,
    ADDRESS_EMAIL_LIMIT,
    TURNSTILE_ACTION,
    waitlistDocId,
    newConfirmToken,
    hashConfirmToken,
    isWellFormedToken,
    clientRateLimitKey,
    buildConfirmUrl,
    buildUnsubscribeUrl,
    confirmationEmail,
    sendConfirmationEmail,
    verifyTurnstileToken,
    parseHostnameList,
    handleJoin,
    handleConfirm,
    handleUnsubscribe,
    issueUnsubscribeToken,
    unsubscribeWithToken,
    expireUnsubscribeTokens,
    expireStalePending,
};
