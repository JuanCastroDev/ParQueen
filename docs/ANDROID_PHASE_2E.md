# Android Phase 2E — native App Check Play Integrity / Debug bridge (spike)

Phase 2E adds a narrow Capacitor Android App Check bridge so Firebase JS can
attach Play Integrity (release) or Debug (DEBUG APK) tokens. It does **not**
deploy Hosting, Functions, Firestore/Storage rules, or change Firebase Console.

Web/PWA reCAPTCHA Enterprise in `firebaseConfig.ts` / `utils/appCheck.ts` is
unchanged: still `ReCaptchaEnterpriseProvider`, still gated on
`VITE_FIREBASE_APPCHECK_SITE_KEY`, still `isTokenAutoRefreshEnabled: true`.

## Why not `@capacitor-firebase/app-check`

That plugin peers `firebase ^12.6.0`. ParQueen is `firebase ^10.8.0`. A JS
major upgrade is out of this spike (same reason Phase 2A did not take
`@capacitor-firebase/authentication`). This repo implements a local
`AppCheckBridge` plugin instead.

## Native dependencies

Existing Android Firebase resolution is kept:

| Artifact | How it is resolved | Why |
| --- | --- | --- |
| `com.google.firebase:firebase-bom:33.16.0` | already in `android/app/build.gradle` (Phase 2A auth) | **Not bumped.** BoM 33.16.0 maps `firebase-messaging` to **24.1.2**, while `@capacitor/push-notifications` pins **25.0.1** via `variables.gradle` `firebaseMessagingVersion`. Bumping the BoM to pull a newer App Check line would risk that messaging pin. |
| `com.google.firebase:firebase-auth` | BoM-managed (`23.2.1` at BoM 33.16.0) | Unchanged |
| `com.google.firebase:firebase-messaging` | `firebaseMessagingVersion = 25.0.1` (Phase 2C plugin) | Unchanged |
| `com.google.firebase:firebase-appcheck-playintegrity` | BoM-managed, **18.0.0** at BoM 33.16.0 | Release / non-debug provider |
| `com.google.firebase:firebase-appcheck-debug` | BoM-managed, **18.0.0** at BoM 33.16.0 | DEBUG provider. Listed as `implementation` (not `debugImplementation`) so a single Java source file can compile `BuildConfig.DEBUG` against both factories. |

`buildFeatures.buildConfig = true` is enabled so `BuildConfig.DEBUG` exists
under AGP 8.13.

## Architecture

```
Application.onCreate
  └─ AppCheckProviderInstaller
       DEBUG  → DebugAppCheckProviderFactory
       else   → PlayIntegrityAppCheckProviderFactory

JS initializeParQueenAppCheck (exactly once)
  Android → initializeAppCheck(CustomProvider({ getToken: native getToken }))
  Web/PWA → initializeAppCheck(ReCaptchaEnterpriseProvider(siteKey))  [gated]
  iOS     → same as Web/PWA (no App Attest)
```

Deterministic: Capacitor Android never silently falls back to WebView
reCAPTCHA, including when `VITE_FIREBASE_APPCHECK_SITE_KEY` is unset.

`AppCheckBridge.getToken()` returns `{ token, expireTimeMillis }` from the
real Firebase `AppCheckToken`. JS does not invent a TTL.

Native failures reject with a sanitized message and do not crash the
activity. Token strings are never written to ParQueen logs. The Firebase
**Debug** SDK may still print a debug secret to **local logcat** on a DEBUG
install — that is SDK behavior on Juan's device only.

## Android permissions

**Unchanged.** Play Integrity does not add a `uses-permission`. Still present
from earlier phases:

- `INTERNET`
- `ACCESS_COARSE_LOCATION` / `ACCESS_FINE_LOCATION` (foreground only)
- `POST_NOTIFICATIONS`

**Not** added: `CAMERA`, storage / media, `ACCESS_BACKGROUND_LOCATION`.

## Enforcement (unchanged)

This phase does **not** add `enforceAppCheck` anywhere. Current production
enforcement remains the five callables already in `functions/index.js`. See
`docs/APP_CHECK_ROLLOUT.md`.

## iOS note (not in this phase)

No App Attest provider, no DeviceCheck, no iOS native plugin. Capacitor iOS
keeps the web reCAPTCHA path.

## DEBUG TOKEN SECURITY

The Debug App Check SDK can print a debug secret to logcat on a DEBUG APK.
That is allowed **only** on Juan's physically attached device.

Never:

- commit the secret
- print it in tests or CI
- put it in PR text
- return it from the Capacitor plugin as a dedicated debug field
- log it from ParQueen app code

Registering that secret in Firebase Console is **not** part of this PR.

## Physical Samsung validation (not performed in this change)

**Device:** Samsung SM-G981U1 / Android 13

Do **not** treat this checklist as done until Juan runs it on device. Do not
paste any debug secret into chat, CI, or this document.

### Local rebuild (Juan)

`google-services.json` remains required on the build machine (gitignored).

```bash
npm ci
npm run cap:sync
# Android Studio / ./gradlew :app:assembleDebug
```

Install the **debug** APK (`BuildConfig.DEBUG` → Debug provider).

### Debug-token steps (device-local only)

1. Launch ParQueen on the Samsung.
2. On the machine physically USB-attached to that phone, inspect **logcat**
   for the Firebase Debug App Check SDK's own debug-secret line. Copy it only
   into Firebase Console → App Check → Apps → Android `app.parqueen` →
   Manage debug tokens. Do not screenshot it into tickets.
3. Force-close and relaunch after the Console allow-list update.
4. Sign in and exercise an already-enforced callable (for example send a
   chat message / `sendMessage`). It should succeed once the debug secret is
   registered.
5. Confirm ParQueen's `ParQueenAppCheck` log tag never prints token material.
6. Confirm `dumpsys package app.parqueen` still lists only
   `INTERNET`, `ACCESS_COARSE_LOCATION`, `ACCESS_FINE_LOCATION`,
   `POST_NOTIFICATIONS`. No `CAMERA`, storage, or `ACCESS_BACKGROUND_LOCATION`.

Release / Play Integrity attestation is a later, Play-signed build. This
debug APK will not exercise Play Integrity.

Do not deploy Hosting, Functions, or rules for this validation. Do not enable
new `enforceAppCheck` flags.
