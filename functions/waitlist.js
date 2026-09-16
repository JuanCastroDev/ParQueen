'use strict';

/**
 * Marketing-site waitlist: double opt-in signup and confirmation.
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

function buildConfirmUrl(baseUrl, token) {
    const base = String(baseUrl || '').replace(/\/+$/, '');
    // The fragment is never sent to a server, so the token stays out of
    // access logs and Referer headers.
    return `${base}/confirm#t=${token}`;
}

function confirmationEmail(confirmUrl) {
    const subject = 'Confirm your spot on the ParQueen waitlist';
    const text = [
        'Thanks for joining the ParQueen waitlist.',
        '',
        'Confirm your spot:',
        confirmUrl,
        '',
        'This link expires in 48 hours.',
        "If you didn't request this, you can ignore this email.",
        '',
        'ParQueen · New York',
    ].join('\n');
    const html = `<!doctype html><html><body style="margin:0;padding:32px;background:#f4f4f1;font-family:Helvetica,Arial,sans-serif;color:#0a0d11">
<p style="margin:0 0 16px;font-size:16px">Thanks for joining the ParQueen waitlist.</p>
<p style="margin:0 0 24px"><a href="${confirmUrl}" style="display:inline-block;padding:12px 20px;background:#087ff5;color:#ffffff;text-decoration:none;font-weight:700;border-radius:10px">Confirm my spot</a></p>
<p style="margin:0 0 8px;font-size:13px;color:#4b5259">This link expires in 48 hours.</p>
<p style="margin:0;font-size:13px;color:#4b5259">If you didn't request this, you can ignore this email.</p>
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
        tx.update(ref, {
            status: STATUS.PENDING,
            optInMethod: OPT_IN.DOUBLE,
            source: SOURCE.SITE,
            consentVersion: CONSENT_VERSION,
            confirmedAt: null,
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
 * Deletes pending signups older than the retention window. Bounded per run;
 * a backlog drains over successive daily runs.
 *
 * deps: { db, Timestamp, now }
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
            const createdMs = fresh.data().createdAt?.toMillis?.() ?? Infinity;
            if (createdMs >= cutoff.toMillis()) return false;
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
    ADDRESS_EMAIL_LIMIT,
    TURNSTILE_ACTION,
    waitlistDocId,
    newConfirmToken,
    hashConfirmToken,
    isWellFormedToken,
    clientRateLimitKey,
    buildConfirmUrl,
    confirmationEmail,
    sendConfirmationEmail,
    verifyTurnstileToken,
    parseHostnameList,
    handleJoin,
    handleConfirm,
    expireStalePending,
};
