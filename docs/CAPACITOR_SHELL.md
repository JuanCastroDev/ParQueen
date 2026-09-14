# Capacitor native shell (Phase 1)

Phase 1 adds a Capacitor iOS/Android shell around the existing Vite/React web app. The web/Firebase Hosting path is unchanged.

## Provisional application ID

- **Proposed:** `app.parqueen` (reverse-DNS from `parqueen.app`)
- Firebase Console currently has **only** the web app registered; no iOS/Android app IDs were reserved at Phase 1 creation.
- Confirm with Juan before treating this ID as permanent (Apple/Google/Firebase registration).

## Prerequisites

- Node 20+ / npm
- `npm ci` then `npm run build` (writes `dist/`)
- **Android:** Android Studio + SDK (not required for `cap sync` generation)
- **iOS:** macOS + Xcode (not available on Windows CI agents)

## Commands

```bash
npm ci
npm run build          # web/Hosting build — unchanged
npm run cap:sync       # build + copy web assets into ios/ and android/
npm run cap:copy       # build + copy only
npm run cap:open:android
npm run cap:open:ios   # macOS only
```

## Invariants

- `webDir` is `dist` — shell loads the same Vite output Hosting uses.
- Do **not** set `server.url` in `capacitor.config.ts`.
- Do **not** set `VITE_QA_AUTH=true` for store/native release builds.
- Do not commit `GoogleService-Info.plist`, `google-services.json`, keystores, or provisioning profiles.

## Phase 2A (Android signup)

See `docs/ANDROID_PHASE_2A.md` for the phone-auth bridge, legal-return navigation, keyboard/`adjustResize` layout, `allowBackup=false`, and the Firebase Android registration steps Juan must approve.

## Phase 2B (Android foreground geolocation)

See `docs/ANDROID_PHASE_2B.md` for `@capacitor/geolocation`, the shared `utils/geolocation` abstraction, and foreground-only Android permissions.

## Phase 2C (Android native push)

See `docs/ANDROID_PHASE_2C.md` for `@capacitor/push-notifications`, `POST_NOTIFICATIONS`, and the shared `notificationRegistration` abstraction. Stacked on Phase 2B / PR #156.

## Phase 2D (Android native camera / photo picker)

See `docs/ANDROID_PHASE_2D.md` for `@capacitor/camera`, the shared `utils/signScanner` abstraction, FileProvider narrowing, and the physical Samsung AI Sign Scanner checklist.

## Out of scope (later phases)

iOS native push / APNs, iOS native camera, App Check attestation bridge, iOS native auth, Mapbox native SDK, store signing, background location, multi-device FCM token lists.
