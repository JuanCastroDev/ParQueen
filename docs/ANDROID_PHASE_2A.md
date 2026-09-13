# Android Phase 2A - signup blockers (validated)

Phase 2A keeps the Capacitor 8 shell and Firebase JS `^10.8.0`. It does not deploy Hosting, Functions, or Firestore rules.

## Physical validation status (2026-09-13)

Validated on Samsung **SM-G981U1 / Android 13** with a local debug APK:

| Check | Result |
| --- | --- |
| Debug APK build / install / launch | Pass |
| Firebase Android app `app.parqueen` registered | Done |
| Debug SHA-1 and SHA-256 registered | Done |
| Local `android/app/google-services.json` (gitignored, not committed) | Present on validation machine |
| Native phone auth end-to-end (SMS -> ParQueen 6-digit OTP -> Firebase JS Auth -> authenticated app) | Pass |
| Keyboard resize on signup | Pass |
| Terms of Use in-app; Back returns to signup | Pass |
| Privacy Policy in-app; Back returns to signup | Pass |
| Mapbox basemap (local ignored `.env.local` + Mapbox token allowlist `https://localhost` / `https://localhost/*`) | Pass |
| Firebase Browser API key allowlist includes `https://localhost` and `https://localhost/*` | Done |
| Production Hosting / Functions / Firestore rules deploy | Not performed |

`google-services.json`, `.env.local`, tokens, API keys, phone numbers, and signing material must stay out of git.

## Phone auth architecture

| Surface | Implementation |
| --- | --- |
| Web / PWA | Unchanged: `RecaptchaVerifier` -> `signInWithPhoneNumber()` |
| Capacitor Android | Native `PhoneAuthProvider.verifyPhoneNumber` -> `verificationId` -> existing 6-digit OTP UI -> `PhoneAuthProvider.credential(verificationId, code)` -> `signInWithCredential(auth, credential)` on the **JS** Auth instance |
| Capacitor iOS | Still the web path (out of this phase) |

Resend uses the same abstraction (`resendPhoneVerification`). The native plugin does **not** show a system OTP dialog.

### Dependency decision: no `@capacitor-firebase/authentication`, no Firebase JS major upgrade

`@capacitor-firebase/authentication` **8.x** is Capacitor-8-compatible, but it peers `firebase ^12.6.0`. That peer is marked optional, so `npm` may install the plugin next to Firebase JS 10, but:

- Completing signup into the **existing JS session** requires `verificationId` + `signInWithCredential`. The plugin's `skipNativeAuth` path does not fire `phoneCodeSent`; the default path signs into **native** Auth, which is a second session.
- A Firebase JS **10 -> 12** major upgrade would touch Auth, App Check, Firestore, Functions, Messaging, recaptcha helpers, emulator tests, and lockfile churn. That is a migration, not this phase.

A narrow custom `PhoneAuth` Capacitor plugin (this repo) is the safer fit: no JS major, no unused social providers, and the OTP UI stays in ParQueen.

## Firebase Android setup (completed for debug validation)

For a new machine or a new signing key, repeat:

1. Firebase Console -> project `parkqueen-46475363-ccf36` -> Project settings -> Your apps -> Android app package `app.parqueen`.
2. Register **debug** SHA-1 and SHA-256 (Play App Signing SHA values later for store builds):

```bash
keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android
```

On Windows the default debug keystore is `%USERPROFILE%\.android\debug.keystore`.

3. Place `google-services.json` at `android/app/google-services.json` (**do not commit**; root and `android/` gitignores already exclude it).
4. Rebuild: `npx cap sync` then Android Studio / `./gradlew :app:assembleDebug`.
5. Keep Phone sign-in enabled. Do **not** disable app verification. Do **not** use `VITE_QA_AUTH=true` as a workaround.

## Keyboard / window

`MainActivity` sets `android:windowSoftInputMode="adjustResize"` explicitly so the WebView height follows the Samsung keyboard. Signup uses `min-h-full` + `shrink-0` content and the app shell uses `h-full` / `min-h-0` so short viewports **scroll** instead of compressing. `@capacitor/keyboard` was not added. Validated on SM-G981U1.

## Backup hardening

`android:allowBackup` is `false`. Authenticated Firebase JS state lives in WebView storage; Android Auto Backup would copy that session off-device. Firestore remains the server source of truth.

## Legal navigation

In-app Terms / Privacy reuse `TermsOfUseView` and `PrivacyPolicyView`. Back (visible and, where history exists, Android hardware Back) returns to the **caller** (signup or Settings/Profile), not `https://parqueen.app`. Public `/privacy` and `/terms` routes are unchanged. Validated: Terms and Privacy open in-app and return to signup.

## Out of scope / next (Phase 2B)

Native geolocation is **not** part of Phase 2A. The Android manifest currently lacks location permissions and the web app still relies on `navigator.geolocation`. Track that as a separate Phase 2B task.
