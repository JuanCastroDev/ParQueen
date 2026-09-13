# Android Phase 2A — signup blockers

Phase 2A keeps the Capacitor 8 shell and Firebase JS `^10.8.0`. It does not deploy Hosting, Functions, or Firestore rules.

## Phone auth architecture

| Surface | Implementation |
| --- | --- |
| Web / PWA | Unchanged: `RecaptchaVerifier` → `signInWithPhoneNumber()` |
| Capacitor Android | Native `PhoneAuthProvider.verifyPhoneNumber` → `verificationId` → existing 6-digit OTP UI → `PhoneAuthProvider.credential(verificationId, code)` → `signInWithCredential(auth, credential)` on the **JS** Auth instance |
| Capacitor iOS | Still the web path (out of this phase) |

Resend uses the same abstraction (`resendPhoneVerification`). The native plugin does **not** show a system OTP dialog.

### Dependency decision: no `@capacitor-firebase/authentication`, no Firebase JS major upgrade

`@capacitor-firebase/authentication` **8.x** is Capacitor-8-compatible, but it peers `firebase ^12.6.0`. That peer is marked optional, so `npm` may install the plugin next to Firebase JS 10, but:

- Completing signup into the **existing JS session** requires `verificationId` + `signInWithCredential`. The plugin’s `skipNativeAuth` path does not fire `phoneCodeSent`; the default path signs into **native** Auth, which is a second session.
- A Firebase JS **10 → 12** major upgrade would touch Auth, App Check, Firestore, Functions, Messaging, recaptcha helpers, emulator tests, and lockfile churn. That is a migration, not this phase.

A narrow custom `PhoneAuth` Capacitor plugin (this repo) is the safer fit: no JS major, no unused social providers, and the OTP UI stays in ParQueen.

## Firebase Android registration (required for real Samsung SMS)

Package ID `app.parqueen` is still **provisional**. Native Firebase Android is **not** registered yet. Code is ready; SMS will fail on device until Juan approves and performs the console steps. Do **not** disable app verification. Do **not** use `VITE_QA_AUTH=true` as a workaround.

### Manual steps Juan must approve / perform

1. Firebase Console → project `parkqueen-46475363-ccf36` → Project settings → Your apps → **Add app** → Android.
2. Android package name: `app.parqueen` (confirm before treating as permanent).
3. Register the **debug** signing certificates (Play App Signing SHA values later for store builds):

```bash
keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android
```

On Windows the default debug keystore is `%USERPROFILE%\.android\debug.keystore`. Copy **SHA-1** and **SHA-256** into the Android app’s SHA certificate fingerprints.

4. Download `google-services.json` and place it at `android/app/google-services.json`.
5. **Do not commit** `google-services.json` (root and `android/` gitignores already exclude it).
6. Rebuild the debug APK (`npx cap sync` then Android Studio / `./gradlew :app:assembleDebug`).
7. Enable Phone as a sign-in provider if it is not already (web already uses it).
8. Install the debug build, enter a real number, receive SMS, enter the code in ParQueen’s 6-digit UI.

Until step 4–6 succeed, the native plugin rejects with a configuration error instead of sending SMS.

## Keyboard / window

`MainActivity` sets `android:windowSoftInputMode="adjustResize"` explicitly so the WebView height follows the Samsung keyboard. Signup uses `min-h-full` + `shrink-0` content and the app shell uses `h-full` / `min-h-0` so short viewports **scroll** instead of compressing. `@capacitor/keyboard` was not added.

## Backup hardening

`android:allowBackup` is `false`. Authenticated Firebase JS state lives in WebView storage; Android Auto Backup would copy that session off-device. Firestore remains the server source of truth.

## Legal navigation

In-app Terms / Privacy reuse `TermsOfUseView` and `PrivacyPolicyView`. Back (visible and, where history exists, Android hardware Back) returns to the **caller** (signup or Settings/Profile), not `https://parqueen.app`. Public `/privacy` and `/terms` routes are unchanged.
