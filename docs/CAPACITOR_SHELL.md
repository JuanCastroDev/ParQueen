# Capacitor native shell (Phase 1)

Phase 1 adds a Capacitor iOS/Android shell around the existing Vite/React web app. The web/Firebase Hosting path is unchanged.

## Application ID

- **Locked:** `app.parqueen`
- The Apple Developer explicit App ID `app.parqueen` is registered. Do not change this identifier.
- The Android package `app.parqueen` is already registered in Firebase. See `docs/ANDROID_PHASE_2A.md`.
- An iOS Firebase app registration is still a separate console step. It is not implied by the locked Apple bundle identifier.

## Prerequisites

- Node 20+ / npm
- `npm ci` then `npm run build` (writes `dist/`)
- **Android:** Android Studio + SDK (not required for `cap sync` generation)
- **iOS:** macOS + Xcode (not available on Windows CI agents)

## Commands

```bash
npm ci
npm run build          # production Vite build; requires VITE_MAPBOX_TOKEN
npm run cap:sync       # build + copy web assets into ios/ and android/
npm run cap:sync:android # Android build + sync; also requires VITE_MAPBOX_ANDROID_TOKEN
npm run android:dev:sync # local Android sync with Onboarding 2.0 + Settings previews ON
npm run android:dev:apk  # same flags, then assembleDebug; never installs or publishes
npm run cap:copy       # build + copy only
npm run cap:open:android
npm run cap:open:ios   # macOS only
```


## Local Android development (Onboarding 2.0)

**Use `npm run android:dev:apk` for normal Android debug APK builds.** It opts in to the already-integrated live Onboarding 2.0 and the redesigned Enable Location view, with the optional Settings founder previews enabled. `npm run android:dev:sync` only builds/syncs the native project.

The scripts force `VITE_ONBOARDING_V2=1` and `VITE_OBV2_PREVIEW=1`, while disabling diagnostics, QA auth, demo-Firebase, Street Intelligence QA package mode and PostHog; approved Mapbox/Firebase config stays inherited. The usual `cap:sync:android` and release commands are unchanged; they **do not** default to V2. Use the dedicated dev command intentionally.

This is an **Android debug build**, using Gradle `assembleDebug`. There is no upload keystore, Google Play AAB, iOS packaging, Firebase deployment, data clear, sign-out or ADB installation. If a developer later elects to install on the already-authenticated S20, compare the APK signer with the installed `app.parqueen` package first; do not uninstall or clear data to make signatures match.

Release/store builds must keep the opt-in V2 decision explicit and must not accidentally include founder-only preview tooling. A future public release remains subject to its separate gates (including S7/A5); this debug convenience does not authorize one.

## Invariants

- `webDir` is `dist` — shell loads the same Vite output Hosting uses.
- Production `npm run build` (including `cap:copy` / `cap:sync`) fails closed without `VITE_MAPBOX_TOKEN`. Android packaging must not proceed from a token-less `dist/`.
- Android packaging must use `npm run cap:sync:android`; its Android-only build guard additionally fails closed without `VITE_MAPBOX_ANDROID_TOKEN`.
- Treat the `dist/` produced by `build:android` as native-only input; do not deploy it to Web/PWA hosting.
- `VITE_FIREBASE_APPCHECK_SITE_KEY` is not required to build Android web assets; native App Check uses Play Integrity / Debug.
- Do **not** set `server.url` in `capacitor.config.ts`.
- Do **not** set `VITE_QA_AUTH=true` for store/native release builds.
- Do not commit `GoogleService-Info.plist`, `google-services.json`, keystores, signing properties, or provisioning profiles.
- Android release AABs are signed from `~/.android-keys/parqueen-signing.properties` (or `PARQUEEN_SIGNING_PROPERTIES`). See `docs/ANDROID_PHASE_2A.md`. Debug builds do not need that file.

## Phase 2A (Android signup)

See `docs/ANDROID_PHASE_2A.md` for the phone-auth bridge, legal-return navigation, keyboard/`adjustResize` layout, `allowBackup=false`, and the Firebase Android registration steps Juan must approve.

## Phase 2B (Android foreground geolocation)

See `docs/ANDROID_PHASE_2B.md` for `@capacitor/geolocation`, the shared `utils/geolocation` abstraction, and foreground-only Android permissions.

## Phase 2C (Android native push)

See `docs/ANDROID_PHASE_2C.md` for `@capacitor/push-notifications`, `POST_NOTIFICATIONS`, and the shared `notificationRegistration` abstraction. Stacked on Phase 2B / PR #156.

## Phase 2D (camera-only Sign Scanner)

The Sign Scanner uses one camera file input (`accept="image/*"` `capture="environment"`) on Web, PWA, Android, and iOS. `@capacitor/camera` is not installed. Profile photos stay a separate file input. See `docs/ANDROID_PHASE_2D.md`.

## Phase 2E (Android App Check Play Integrity / Debug bridge)

See `docs/ANDROID_PHASE_2E.md` for the narrow native App Check Capacitor bridge, `CustomProvider` JS wiring, and the Samsung debug-token operator steps. iOS App Attest remains out of scope.

## Out of scope (later phases)

iOS native push / APNs, iOS App Attest, iOS native auth, Mapbox native SDK, Play Console upload, background location, multi-device FCM token lists.
