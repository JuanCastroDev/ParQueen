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

In order of strength:

1. **Turnstile**, verified server-side: `success`, `action === "waitlist"`,
   and a hostname in `WAITLIST_ALLOWED_HOSTNAMES`. The visitor IP is not sent
   to Cloudflare.
2. **Per-address limit:** 3 confirmation emails / hour, keyed by the record
   ID. Exceeding it still answers `202` so the response never reveals
   activity on an address.
3. **Best-effort per-client limit:** 5 joins / 10 min, 20 confirms / 10 min.
   - Input is `Fastly-Client-IP`, which the Firebase Hosting CDN sets to the
     connecting client (overwriting a value the client sent). This is **abuse
     mitigation on the Hosting path, not authentication**: a request sent
     straight to the function URL can set the header to anything.
   - The IP is immediately HMAC'd with `WAITLIST_RATE_LIMIT_PEPPER`; only that
     digest is used, only inside expiring `rateLimits` counter IDs. The raw IP
     is never logged, returned or stored.
   - `X-Forwarded-For`, `X-Real-IP` and other forwarded headers are **never**
     consulted.
   - If `Fastly-Client-IP` is absent or malformed, this layer is **skipped**
     (not collapsed into a shared bucket, which would let a Hosting header
     change throttle every real visitor). Layers 1 and 2 still apply.

The per-client check runs first only so an obvious burst does not spend a
Turnstile `siteverify` call per request; it is not the primary control.

## Marketing-site copy constraints

- Privacy link under the form: **`https://parqueen.app/privacy-policy`**
  (verified live). Do not use `/privacy`, which redirects to the web app.
- Before public domain cutover the marketing site needs its own stable privacy
  route under the ParQueen domain.
- The form promises "Unsubscribe anytime" — see the unsubscribe section below.

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
| `WAITLIST_CONFIRM_BASE_URL` | param | `https://parqueen-marketing.web.app` (staging, pre-launch) |
| `WAITLIST_ALLOWED_HOSTNAMES` | param | `parqueen-marketing.web.app` (staging, pre-launch) |

The two params have **no code default**. Their values live in the tracked
`functions/.env.parkqueen-46475363-ccf36`, which the Functions emulator (with or
without `--project`, since `.firebaserc` has a single project) and `firebase
deploy` both read. A code default would not help: the CLI treats it as a prompt
suggestion, so an unset value still stops non-interactive runs. That file holds
public configuration only — never secrets. `functions/.env.local` stays
ignored and is only for personal local overrides.

At domain cutover, change both values to the final host in one reviewed commit
(e.g. `https://parqueen.app` and `parqueen.app`) and repeat the confirmation
test.

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
8. At domain cutover, update both values in
   `functions/.env.parkqueen-46475363-ccf36` in a reviewed commit and repeat
   step 6.

## Tests

- `functions/waitlist.test.js` — pure helpers, SendGrid payload, Turnstile.
- `functions/waitlist.integration.test.js` — endpoints and cleanup against the
  Firestore emulator; delivery, Turnstile and tokens via `_waitlistHooks`, so
  no real email is sent.
- `firestore.rules.test.ts` `WL-R` — client access denied.
- `functions/scripts/importSquarespaceWaitlist.test.js` — importer, synthetic
  data only.
