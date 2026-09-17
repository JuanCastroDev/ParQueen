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
5. The record becomes `subscribed` with `confirmedAt`.
6. Every marketing/launch email carries its own unsubscribe link
   (`/unsubscribe#t=<token>`). Opening it changes nothing; **Unsubscribe me**
   calls `POST /api/waitlist/unsubscribe` (`unsubscribeWaitlist`) and the record
   becomes `unsubscribed`.

**Launch-send rule:** only records with `status === "subscribed"` may receive
marketing or launch email. `pending_confirmation` and `unsubscribed` are never
included.

## Endpoints

| Endpoint | Body | Responses |
|---|---|---|
| `POST /api/waitlist` | `{ email, turnstileToken }` | `202 check_inbox` for every valid address (new, pending or subscribed) · `400 invalid_email` · `400 verification_failed` · `429 rate_limited` · `503 try_again` (email not sent) · `500 try_again` |
| `POST /api/waitlist/confirm` | `{ token }` | `200 confirmed` · `410 invalid_or_expired` (unknown, malformed, used or expired — one answer) · `429 rate_limited` |
| `POST /api/waitlist/unsubscribe` | `{ token }` | `200 unsubscribed` · `410 invalid_or_expired` (unknown, malformed, already used, or the record is not `subscribed` — one answer, same as confirm) · `429 rate_limited` |

All three accept JSON POST only and return `Cache-Control: no-store`. In
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
| `confirmedAt` | server timestamp of the latest confirmation; `null` for legacy imports. Kept (not cleared) while a former subscriber is pending again |
| `confirmTokenHash` | SHA-256 of the raw token; deleted on confirmation |
| `confirmTokenExpiresAt` | 48 hours after issue; deleted on confirmation |
| `lastConfirmEmailAt` | resend cooldown; deleted on confirmation |
| `lastUnsubscribedAt` | server timestamp of the most recent opt-out; kept as history, including after a later resubscription |
| `importedAt`, `originalSignupAt` | legacy imports only; `originalSignupAt` is `null` unless the export had a real date |

Never stored: IP address, name, device, location, raw token.

`firestore.rules` (`match /waitlist/{docId}`) denies all client SDK access:
anonymous, signed-in, and signed-in with an admin role claim. The Cloud
Functions use the Admin SDK, which is not subject to Security Rules, so they
keep full access. Unsubscribe tokens live in a separate collection with the
same protection (see below).

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
- The form does not promise "Unsubscribe anytime" yet. It can once the
  marketing `/unsubscribe` page and its rewrite ship.

## Retention

`expireStaleWaitlistSignups` (daily, 04:30 America/New_York) deletes
`pending_confirmation` records older than 30 days. Uses the
`waitlist (status ASC, createdAt ASC)` composite index.

A pending record that has `lastUnsubscribedAt` is a former subscriber trying to
rejoin. It is never deleted, since it holds their opt-out: while its new link
is live it is left alone, and after that link expires it returns to
`unsubscribed` with the confirmation-token fields removed.

The same job deletes `waitlistUnsubscribeTokens` documents past `validUntil`.

## Squarespace migration

`functions/scripts/importSquarespaceWaitlist.js` — dry run by default. Reads
only the email and (if present) signup-date columns, never overwrites an
existing record, prints counts only, sends no email. Imported people are
`subscribed` / `legacy-squarespace` with `confirmedAt: null`; they are not sent
a reconfirmation. Keep the original export outside the repository as the
migration backup (`.gitignore` blocks common export names).

## Unsubscribe

### Token record: `waitlistUnsubscribeTokens/{SHA-256(raw token)}`

| Field | Notes |
|---|---|
| `waitlistId` | ID of the `waitlist` record (the HMAC ID, never the email) |
| `issuedAt` | server timestamp |
| `validUntil` | `issuedAt` + 60 days |
| `subscriptionConfirmedAt` | the record's `confirmedAt` at issue time; `null` for legacy imports |

Never stored here: raw token, email, IP address. `firestore.rules`
(`match /waitlistUnsubscribeTokens/{tokenHash}`) denies all client SDK access,
including users with an admin role claim; the Functions reach it through the
Admin SDK.

### Token lifecycle

- **Issue:** a future launch sender calls `issueUnsubscribeToken(ref, deps)`
  (in `functions/waitlist.js`) once per message. It returns a fresh raw token
  (32 random bytes, base64url) only when the record is `subscribed`, and
  `null` otherwise.
  - The body link is `buildUnsubscribeUrl(base, token)`, which gives
    `<base>/unsubscribe#t=<token>`. The token is in the URL **fragment** only.
  - The document ID is the token's SHA-256 hash, so lookup is a direct
    document read, not a query.
- **Validity:** 60 days, whatever else is sent in between. That covers the
  requirement that a commercial email's opt-out keeps working for at least
  30 days after sending. There is no count cap.
- **Subscription binding:** a token works only while
  `subscriptionConfirmedAt` equals the record's current `confirmedAt`.
  `null` matches `null`, so legacy Squarespace subscribers can use their
  tokens. A new double opt-in changes `confirmedAt`, which invalidates every
  token from the earlier subscription.
- **Use:** a successful unsubscribe deletes the token that was used. Other
  tokens from the same subscription stay until they expire, but they are
  harmless: the record is no longer `subscribed`, and a later resubscription
  changes `confirmedAt`.
- **Cleanup:** `expireStaleWaitlistSignups` also deletes token documents past
  `validUntil`: **at most 400 token documents per daily run**, with no
  pagination within a run, so a larger backlog drains over later runs. This
  uses Firestore's automatic
  single-field index on `validUntil`.
- **Tracking:** emails that carry a token must keep SendGrid click and open
  tracking disabled, as the confirmation email does, so no link is rewritten
  through a redirector.

> Earlier designs were dropped:
> - A stateless `#id=<docId>&sig=<HMAC>` link exposes the document ID and
>   cannot be single use.
> - A newest-5 hash array on the record cannot guarantee 30 days of validity
>   when more than 5 messages are sent in that window.

### Endpoint (body link)

- **Scanner-safe:** opening `/unsubscribe#t=…` changes nothing, and a GET to
  the endpoint is `405`. Only the POST sent when the person presses
  **Unsubscribe me** changes the record.
- **No friction:** no login, no email re-entry, no Turnstile. Holding the
  256-bit token is the authorization.
- **Abuse control:**
  - Malformed tokens are rejected before any read.
  - Well-formed tokens pass through the same best-effort `Fastly-Client-IP`
    throttle as confirm (20 / 10 min, operation `waitlistUnsubscribe`). It is
    skipped when the header is absent.
- **The change:** `unsubscribeWithToken(token, deps)` is the shared primitive.
  In one transaction it requires:
  - the token document exists and is before `validUntil`;
  - the record is `subscribed`;
  - `subscriptionConfirmedAt` equals the record's `confirmedAt`.

  It then sets `status: "unsubscribed"` and `lastUnsubscribedAt`, and deletes
  the token document. Every failure is the same `410 invalid_or_expired`.
- **Provenance is untouched:** `source`, `optInMethod`, `consentVersion`,
  `createdAt` and `confirmedAt` do not change. A legacy Squarespace subscriber
  stays `legacy-squarespace` / `squarespace-import` after opting out.

### Resubscription

Submitting the form again never silently reactivates an unsubscribed address:

`unsubscribed` → form → `pending_confirmation` → **Confirm my spot** →
`subscribed`

- **On the new signup:**
  - `optInMethod` becomes `double-opt-in` and `consentVersion` becomes the
    current version.
  - A fresh confirmation token is emailed.
  - `source`, `createdAt`, `confirmedAt` and `lastUnsubscribedAt` are kept as
    history.
  - No unsubscribe token can be issued while the record is pending.
- **On confirmation:**
  - `confirmedAt` is set to the new consent time, so old-subscription tokens
    stop working.
  - `lastUnsubscribedAt` is kept as the previous opt-out time.
  - `status` is always the source of truth.

### RFC 8058 one-click (future sender — not built)

The fragment link above is the human-facing body link. It is **not** the
`List-Unsubscribe` header URL. A future marketing sender must also provide
RFC 8058 one-click unsubscribe:

- **Headers:**
  - `List-Unsubscribe: <https://…/api/waitlist/one-click-unsubscribe?t=<token>>`:
    an HTTPS URI with the opaque token in the URI itself. Use a separate
    token issued for the same message.
  - `List-Unsubscribe-Post: List-Unsubscribe=One-Click`
  - Both headers must be covered by the DKIM signature.
- **Reserved endpoint:** `POST /api/waitlist/one-click-unsubscribe`.
  - It reads the token from the query and calls `unsubscribeWithToken`.
  - It opts out immediately, with no confirmation step.
  - It answers directly: no redirect.
  - It accepts the RFC 8058 form body (`List-Unsubscribe=One-Click`).
  - A GET to it must never unsubscribe.
- **Logging:** the token appears in the request URL, so access logs for that
  path must not record the query string, and the function must never log it.

### Before launch

- **Marketing site:**
  - an `/unsubscribe` page that reads the fragment and shows
    **Unsubscribe me**;
  - a Hosting rewrite from `/api/waitlist/unsubscribe` to
    `unsubscribeWaitlist`.
- **Launch sender:**
  - select `status == "subscribed"` only;
  - issue tokens per message;
  - add the RFC 8058 headers and endpoint above.

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
3. Deploy `firestore:rules`, `firestore:indexes`, then the four functions.
4. Deploy the marketing site with the `/api/waitlist*` rewrites (including
   `/api/waitlist/unsubscribe`) and the `/unsubscribe` page.
5. On staging, confirm `Fastly-Client-IP` is present on requests through
   Hosting (log presence only — never the value), then remove the check.
6. One real signup and confirmation to our own inbox.
7. Verify unsubscribe end to end with our own inbox before public launch.
8. At domain cutover, update both values in
   `functions/.env.parkqueen-46475363-ccf36` in a reviewed commit and repeat
   step 6.

## Tests

- `functions/waitlist.test.js` — pure helpers, SendGrid payload, Turnstile,
  unsubscribe input handling (`WL-UU`).
- `functions/waitlist.integration.test.js` — endpoints and cleanup against the
  Firestore emulator; delivery, Turnstile and tokens via `_waitlistHooks`, so
  no real email is sent. `WL-UN` covers unsubscribe and resubscription;
  `WL-XR` covers cleanup of a rejoining former subscriber and of expired
  unsubscribe tokens.
- `firestore.rules.test.ts` `WL-R` — client SDK access (anonymous, signed-in,
  admin-role claim) denied to `waitlist` and `waitlistUnsubscribeTokens`. The
  Admin SDK is not subject to Rules and is exercised by the integration tests.
- `functions/scripts/importSquarespaceWaitlist.test.js` — importer, synthetic
  data only.
