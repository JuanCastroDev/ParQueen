# Android Phase 2C — native push notifications

Phase 2C adds a single notification abstraction so ParQueen can use official Capacitor push on Android while keeping the existing Web/PWA Firebase Cloud Messaging path. It does not deploy Hosting, Functions, or Firestore rules.

## Depends on #156

This work is stacked on Phase 2B geolocation (`cursor/android-phase-2b-geolocation-a833`, PR #156). **Do not merge until #156 is on main.** After #156 merges, retarget or rebase this branch onto `main`.

Do not merge or deploy this phase ahead of #156.

## Dependency

`@capacitor/push-notifications@^8.1.2` (official Ionic/Capacitor plugin).

Verified against Capacitor 8.5.x: the plugin's peer is `@capacitor/core >= 8.0.0`. This is the supported Capacitor 8 line (8.1.2 as of this phase). No custom native plugin. No `@capacitor-firebase/messaging` and no Firebase JS major upgrade.

## Platform behavior

| Surface | Path |
| --- | --- |
| Web / PWA | Unchanged Firebase Web Messaging (`Notification.requestPermission`, service worker, `PushManager`, VAPID, `getToken` / `onMessage`) |
| Capacitor Android | Official plugin: `checkPermissions`, `requestPermissions`, `register` / `unregister`, `registration` token event, `pushNotificationReceived`, `pushNotificationActionPerformed` |
| Capacitor iOS | **Not in this phase.** JS still uses the browser / Web Messaging path. The plugin is linked by `cap sync` for Android. No APNs, no Push capability, no `AppDelegate` remote-notification hooks. |

App UI must not choose native vs browser itself. All consumers go through `notificationRegistration` (`utils/notificationPlatform.ts` picks the path).

## Android permissions

Added to `android/app/src/main/AndroidManifest.xml`:

- `POST_NOTIFICATIONS` (Android 13+ runtime permission)

The official plugin's own manifest does **not** declare `POST_NOTIFICATIONS`. Without this app-level declaration, `dumpsys package app.parqueen` shows nothing and the OS dialog cannot be granted — the Samsung SM-G981U1 finding that started this phase.

**Not** added: `ACCESS_BACKGROUND_LOCATION`. No background location. Phase 2B foreground location is unchanged.

Also added (packaging only):

- Default FCM channel id `parqueen_parking`
- Status-bar notification icon `@drawable/ic_stat_notify` (white silhouette)

`google-services.json` remains required on the build machine (gitignored). Phase 2A already registered the Android app `app.parqueen` and applies the Google Services plugin when that file is present.

## Permission UX

ParQueen product preference fields are unchanged: `notificationsEnabled`, `notificationRadius`, and the scalar `fcmToken` on `users/{uid}/private/preferences`.

The abstraction distinguishes:

| Runtime state | Product result |
| --- | --- |
| Not yet requested (`prompt` / `prompt-with-rationale`) | Enable is available. Toggle stays off until OS grant **and** FCM registration succeed. |
| Granted | Silent refresh can register. Toggle is enabled only after `registration === 'registered'`. |
| Denied | Recheck / return from Android Settings. No second OS prompt from Enable. |
| Registration failure after grant | Retry. Preference is not marked enabled. |

`requestPermissions()` runs only from the explicit Enable action, and only while the OS state is still `prompt`. Existing grant or denial is returned without re-prompting.

Resume / reopen re-inspects OS permission (visibility change). Recheck after the user changes Android Settings is the recovery path.

## Token / storage (`fcmToken` last-writer-wins)

Phase 2C keeps the existing single `users/{uid}/private/preferences.fcmToken` field.

- Native Android writes the FCM token from the plugin `registration` event to that same field (merge).
- Web/PWA continues to write the Web Messaging token to the same field.
- Account switch unregisters / deletes the device token, then writes the replacement. Owner markers stay `parqueen_fcm_owner_uid` / `parqueen_fcm_owner_version`.
- **Limitation (unchanged, documented):** last writer wins. Signing in on a second device overwrites the stored token. The previous device stops receiving `notifyNearbyUsers` until it registers again. This phase does **not** introduce a multi-device token array.

Notification tokens must not be logged.

## Foreground behavior

Web/PWA: `onMessage` → existing glass-panel toast (5s).

Android native: `presentationOptions: []` so a foreground push does **not** also raise a system banner. `pushNotificationReceived` is normalized to the same `{ notification, data }` shape and uses the same toast. Background / killed-state delivery remains the OS notification via FCM.

Taps use `pushNotificationActionPerformed` through the same intent queue as the service-worker open path.

## Privacy

- No background location.
- No new persistent raw-coordinate storage.
- Tokens are stored on the existing private preferences document only.
- Debug / error logs must not print the FCM token.

## iOS note (not in this phase)

`@capacitor/push-notifications` may be present in the iOS package graph after `cap sync` because Capacitor links official plugins for both platforms. **ParQueen does not use native iOS push, APNs, or Push capability in Phase 2C.** JS on Capacitor iOS stays on the browser Web Messaging path. `AppDelegate.swift` is intentionally unchanged (no `didRegisterForRemoteNotifications` hooks). iOS native push remains out of scope.

## Physical Samsung acceptance (Juan)

Not performed by this change. Validate on **Samsung SM-G981U1 / Android 13** with a local debug APK after `npx cap sync` + `:app:assembleDebug`. `google-services.json` must be present on the validation machine.

1. Fresh install (or clear app data) so notification permission has never been requested. Sign in.
2. Open Notifications Settings (or Nearby). The toggle is **not** enabled. Enable Notifications / Enable parking alerts is available.
3. Tap **Enable parking alerts**. The **Android native** permission dialog appears (`POST_NOTIFICATIONS`). Not a browser `Notification.requestPermission()` sheet.
4. Tap **Allow**.
5. The ParQueen toggle becomes enabled only after permission **and** FCM registration succeed.
6. Force-close and reopen: remains enabled. No second OS prompt.
7. Android Settings → Apps → ParQueen → Notifications → **Deny**. Return to ParQueen (or Recheck / reopen). The app reflects disabled / blocked.
8. Re-enable notifications in Android Settings. Recheck or reopen. ParQueen recovers and can register again.
9. FCM token registration succeeds. Logcat / console must **not** print the token.
10. Send a real test push (nearby Ping or Firebase console to the Android app) and confirm it is received on the Samsung **before merge**.

Confirm `dumpsys package app.parqueen` now lists `POST_NOTIFICATIONS`. Confirm no `ACCESS_BACKGROUND_LOCATION`.

Do not deploy Hosting, Functions, or Firestore rules for this validation.
