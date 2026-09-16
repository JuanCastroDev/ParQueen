# Marketing waitlist

Double opt-in email waitlist for the public marketing site
(`parqueen-marketing` Hosting target, same Firebase project).

## Flow

1. The visitor enters an email on the marketing site and completes the
   Cloudflare Turnstile widget.
2. The site calls `POST /api/waitlist`, which Hosting rewrites to
   `joinWaitlist`.
3. `joinWaitlist` creates `waitlist/{id}` as `pending_confirmation` and emails a
   confirmation link through SendGrid.
4. The link opens `/confirm#t=<token>` on the marketing site. Opening the page
   does **not** confirm anything; the visitor presses **Confirm my spot**,
   which calls `POST /api/waitlist/confirm` (`confirmWaitlist`).
5. The record becomes `subscribed` with `confirmedAt`. Only `subscribed`
   records may receive the launch email.

## Endpoints

| Endpoint | Body | Responses |
|---|---|---|
| `POST /api/waitlist` | `{ email, turnstileToken }` | `202 check_inbox` for every valid address (new, pending or subscribed) · `400 invalid_email` · `400 verification_failed` · `429 rate_limited` · `503 try_again` (email not sent) · `500 try_again` |
| `POST /api/waitlist/confirm` | `{ token }` | `200 confirmed` · `410 invalid_or_expired` (unknown, malformed, used or expired — one answer) · `429 rate_limited` |

Both accept JSON POST only and return `Cache-Control: no-store`. In
production they are same-origin through Hosting and send no CORS headers; the
emulator allows `localhost:4321` for local end-to-end testing only.

## Record: `waitlist/{HMAC-SHA256(WAITLIST_ID_PEPPER, canonical email)}`

| Field | Notes |
|---|---|
| `email` | canonical (trimmed, lowercased; `functions/emailAddress.js`) |
| `status` | `pending_confirmation` · `subscribed` · `unsubscribed` |
| `optInMethod` | `double-opt-in` · `legacy-squarespace` |
| `source` | `marketing-site` · `squarespace-import` |
| `consentVersion` | `waitlist-2026-09-v1` · `squarespace-legacy` |
| `createdAt`, `updatedAt` | server timestamps |
| `confirmedAt` | server timestamp on confirmation; `null` for legacy imports |
| `confirmTokenHash` | SHA-256 of the raw token; deleted on confirmation |
| `confirmTokenExpiresAt` | 48 hours after issue; deleted on confirmation |
| `lastConfirmEmailAt` | resend cooldown; deleted on confirmation |
| `importedAt`, `originalSignupAt` | legacy imports only; `originalSignupAt` is `null` unless the export had a real date |

Never stored: IP address, name, device, location, raw token.

Client access is denied completely by `firestore.rules`
(`match /waitlist/{docId}`); only the Admin SDK writes.

## Confirmation token lifecycle

- 32 random bytes, base64url. The raw token exists only in the email.
- Firestore keeps its SHA-256 hash and a 48-hour expiry.
- The link carries it in the URL **fragment**, so it never reaches a server
  log or a Referer header. SendGrid click/open tracking is disabled for this
  email so the link is not rewritten through a redirector.
- A pending resubmission (after the 60 s cooldown) issues a new token and
  replaces the hash, which invalidates the previous link.
- Confirmation is a transaction that requires `pending_confirmation`, a
  matching hash and an unexpired token, then deletes the token fields — single
  use.

## Abuse controls

- **Turnstile**, verified server-side: `success`, `action === "waitlist"`, and a
  hostname in `WAITLIST_ALLOWED_HOSTNAMES`. The visitor IP is not sent to
  Cloudflare.
- **Per-client limit:** 5 joins / 10 min, 20 confirms / 10 min, keyed by
  `HMAC(WAITLIST_RATE_LIMIT_PEPPER, Fastly-Client-IP)` in the expiring
  `rateLimits` counters. Behind Firebase Hosting the CDN sets
  `Fastly-Client-IP` to the real caller and overwrites a forged value.
  `X-Forwarded-For` is **not** used: on this path its visible entry is a
  Google front-end address. A direct call to the function URL can forge
  `Fastly-Client-IP`, so this limit is defence in depth; Turnstile and the
  per-address limit are the controls that cannot be spoofed. Requests without
  a usable header share one bucket.
- **Per-address limit:** 3 confirmation emails / hour, keyed by the record ID.
  Exceeding it still answers `202` so the response never reveals activity on
  an address.

## Retention

`expireStaleWaitlistSignups` (daily, 04:30 America/New_York) deletes
`pending_confirmation` records older than 30 days. Uses the
`waitlist (status ASC, createdAt ASC)` composite index.

## Squarespace migration

`functions/scripts/importSquarespaceWaitlist.js` — dry run by default. Reads
only the email and (if present) signup-date columns, never overwrites an
existing record, prints counts only, sends no email. Imported people are
`subscribed` / `legacy-squarespace` with `confirmedAt: null`; they are not sent
a reconfirmation. Keep the original export outside the repository as the
migration backup (`.gitignore` blocks common export names).

## Unsubscribe (required before public launch — not yet implemented)

The CTA promises "Unsubscribe anytime", so this must ship before the launch
email or public cutover.

- Stateless signed link in every launch email:
  `https://parqueen.app/unsubscribe#id=<docId>&sig=<HMAC(WAITLIST_UNSUBSCRIBE_SECRET, docId)>`
  — no stored token, nothing to expire.
- `POST /api/waitlist/unsubscribe { id, sig }` → constant-time signature
  check → `status: "unsubscribed"`, `unsubscribedAt`, token fields removed.
  Same `200` for already-unsubscribed or unknown IDs with a valid signature.
- `List-Unsubscribe` and `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
  headers on the launch email (RFC 8058), pointing at the same endpoint.
- Launch sends select `status == "subscribed"` only.

## Configuration

| Name | Kind | Value |
|---|---|---|
| `SENDGRID_API_KEY` | secret | existing |
| `WAITLIST_ID_PEPPER` | secret | new, random 32-byte hex — **never rotate** without re-keying records |
| `WAITLIST_RATE_LIMIT_PEPPER` | secret | new, random 32-byte hex |
| `TURNSTILE_SECRET_KEY` | secret | Cloudflare Turnstile secret |
| `WAITLIST_CONFIRM_BASE_URL` | param | `https://parqueen-marketing.web.app` for staging; `https://parqueen.app` at cutover |
| `WAITLIST_ALLOWED_HOSTNAMES` | param | `parqueen-marketing.web.app,parqueen.app` |

## Deploy checklist (not yet approved)

1. Create the three new secrets.
2. Confirm `parqueen-email@` can read them (deploy grants secret access) and
   `parqueen-cleanup@` can delete from `waitlist`.
3. Deploy `firestore:rules`, `firestore:indexes`, then the three functions.
4. Deploy the marketing site with the `/api/waitlist*` rewrites.
5. On staging, confirm `Fastly-Client-IP` is present on requests through
   Hosting (log presence only — never the value), then remove the check.
6. One real signup and confirmation to our own inbox.
7. Implement and verify unsubscribe before public launch.
8. At domain cutover, set `WAITLIST_CONFIRM_BASE_URL=https://parqueen.app` and
   repeat step 6.

## Tests

- `functions/waitlist.test.js` — pure helpers, SendGrid payload, Turnstile.
- `functions/waitlist.integration.test.js` — endpoints and cleanup against the
  Firestore emulator; delivery, Turnstile and tokens via `_waitlistHooks`, so
  no real email is sent.
- `firestore.rules.test.ts` `WL-R` — client access denied.
- `functions/scripts/importSquarespaceWaitlist.test.js` — importer, synthetic
  data only.
