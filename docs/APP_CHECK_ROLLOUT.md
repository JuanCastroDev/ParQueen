# App Check Rollout Plan (TM-12)

This document separates **what is already enforced in production source**
from **future** client and callable work. Phase 2E (Android native App Check
bridge) does not change enforcement.

## Current enforcement (source of truth: `functions/index.js`)

Exactly **five** callables currently declare `enforceAppCheck: true`. Do not
treat this list as “all callables” or “none”:

| Callable | Status |
| --- | --- |
| `deleteChat` | **Enforced now** |
| `sendMessage` | **Enforced now** |
| `updateDisplayName` | **Enforced now** |
| `adminReadView` | **Enforced now** (Stage 4A admin canary) |
| `checkHydrantDistance` | **Enforced now** |

`consumeAppCheckToken` is unused on every callable.

Everything else stays unenforced until a later, explicit Functions change.
Examples that are **not** enforced today (non-exhaustive): `claimUsername`,
`analyzeSign`, `generateSmartReplies`, `generateListingDescription`,
`generateEmailOTP`, `deleteAccount`, `bootstrapAdmin`. `claimUsername` is
deliberately still off — see `docs/PROFILE_IDENTITY_HARDENING.md`.

**This Phase 2E PR must not flip any of those flags.**

## Current client initialization

| Surface | Provider | Gate |
| --- | --- | --- |
| Web / PWA | `ReCaptchaEnterpriseProvider` | `VITE_FIREBASE_APPCHECK_SITE_KEY` (unchanged) |
| Capacitor Android | Native Play Integrity (release) or Debug (`BuildConfig.DEBUG`), fed to Firebase JS via `CustomProvider` | Not the reCAPTCHA site key. No WebView reCAPTCHA fallback. See `docs/ANDROID_PHASE_2E.md`. |
| Capacitor iOS | Same as Web / PWA | App Attest is **future** / out of Phase 2E |

`initializeAppCheck` runs **exactly once**.
`isTokenAutoRefreshEnabled: true` on both the native and reCAPTCHA paths.

Web debug tokens (`VITE_APPCHECK_DEBUG_TOKEN` / `FIREBASE_APPCHECK_DEBUG_TOKEN`)
remain DEV-only and tree-shaken from production web bundles. Android DEBUG
APKs use the native `DebugAppCheckProviderFactory` instead; that SDK may
print a debug secret to **local logcat** on Juan's device. Never commit,
CI-print, or PR-paste that secret.

## Why some callables are still unenforced

Premature enforcement on callables without observed valid-token traffic
locks out legitimate clients (web without a site key, Android without a
registered Play Integrity app / debug token, iOS still on reCAPTCHA). The
five enforced callables were turned on in earlier hardening canaries; the
rest wait for metrics.

## Future enforcement (not this phase)

Do **not** combine these with the Android bridge spike:

1. Register / confirm App Check apps in Firebase Console (web reCAPTCHA,
   Android Play Integrity). **Not done by this PR.**
2. Keep `VITE_FIREBASE_APPCHECK_SITE_KEY` in the production web build
   environment.
3. Watch Firebase Console → App Check → Metrics until invalid-token rate
   is acceptable on each remaining callable.
4. Flip `enforceAppCheck: true` in `functions/index.js` **one callable at a
   time**. Candidates after the current five include:
   - `analyzeSign`
   - `generateSmartReplies`
   - `generateEmailOTP`
   - `claimUsername` (only after fresh post-App-Check-client traffic)
5. Deploy Functions only after that observation window.
   `firebase deploy --only functions` — not part of Phase 2E.
6. iOS App Attest remains a later native phase.

Rollback for a newly enforced callable: set that callable's
`enforceAppCheck` back to `false` and redeploy Functions. Do not roll back
the five current canaries as a bundle unless metrics show they are blocking
legitimate traffic.

## Dev debug token (web only)

Set `VITE_APPCHECK_DEBUG_TOKEN=<token>` in `.env.local`. Obtain a debug
token from Firebase Console → App Check → Apps → overflow menu → Manage
debug tokens.

The token is only read when `import.meta.env.DEV` is true and is never
included in production web bundles.

## Blocking items

- [ ] Operator: register Play Integrity for Android `app.parqueen` (and
      keep the web reCAPTCHA site key configured) — Console work, not this PR
- [ ] Operator: Samsung debug-APK App Check validation per
      `docs/ANDROID_PHASE_2E.md` (device-local debug secret; do not paste it)
- [ ] Product: decide the next callable to enforce after the current five
- [ ] Future: iOS App Attest
