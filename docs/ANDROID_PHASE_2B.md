# Android Phase 2B — foreground geolocation

Phase 2B adds a single location abstraction so ParQueen can use native Capacitor geolocation on Android while keeping the existing Web/PWA browser path. It does not deploy Hosting, Functions, or Firestore rules.

## Dependency

`@capacitor/geolocation@^8.2.1` (official Ionic/Capacitor plugin).

Verified against Capacitor 8.5.x: the plugin's peer is `@capacitor/core >= 8.0.0`. This is the supported Capacitor 8 line (8.2.1 as of this phase). No custom native plugin.

## Platform behavior

| Surface | Path |
| --- | --- |
| Web / PWA | Unchanged browser `navigator.geolocation` (via the abstraction) |
| Capacitor Android | Official plugin: `getCurrentPosition`, `watchPosition` / `clearWatch`, `checkPermissions`, `requestPermissions`. Foreground only. |
| Capacitor iOS | **Not validated in this phase.** JS still uses the browser path. The plugin is linked by `cap sync`, so `Info.plist` includes the usage strings the official plugin requires (see below). |

App code must not choose native vs browser itself. All consumers go through `utils/geolocation.ts` (`utils/geolocationPlatform.ts` picks the path).

## Android permissions

Added to `android/app/src/main/AndroidManifest.xml`:

- `ACCESS_COARSE_LOCATION`
- `ACCESS_FINE_LOCATION`

**Not** added: `ACCESS_BACKGROUND_LOCATION`. No background tracking.

Approximate/coarse grants (Android 12+) are treated as usable `granted`. Precise is used when the OS grants fine location and a call already requested `enableHighAccuracy` (map watch, nearby feed, hydrant, ping fallback).

## Permission UX

ParQueen allow / deny / Not now product state is unchanged (`locationAccessChoice`: `granted` | `declined` | `denied`).

The abstraction distinguishes:

| Runtime state | Product result |
| --- | --- |
| Not yet requested (`prompt`) | Primer / Enable still available; stored `declined` is honoured |
| Granted precise | `granted` |
| Granted approximate / coarse | `granted` (usable) |
| Denied | `denied` — no repeated OS prompt |
| Location services off | Not persisted as a denial; primer can retry; Nearby can show `services_disabled` |
| Timeout / position failure | Transient error — **not** a permanent denial |

`requestLocationPermission` only shows an OS dialog when the OS state is still `prompt`. Existing grant or denial is returned without re-prompting.

## Map / data

After an Android grant: `watchPosition` feeds `userLocation` (`[lng, lat]`), the blue user marker, recenter (`handleLocateMe`), route redraw, and the existing `userLocations/{uid}` geohash persister. Distance / arrival / ETA keep the same coordinate shape. Firestore write semantics are unchanged.

## Privacy

- Foreground only. No background location permission or tracking.
- No new persistent raw-coordinate storage.
- Existing geohash persistence only.
- Debug / error logs must not print exact coordinates.

## iOS note (not in this phase)

`ios/App/App/Info.plist` includes `NSLocationWhenInUseUsageDescription` and `NSLocationAlwaysAndWhenInUseUsageDescription` because the official plugin's iOS dependency (`ion-ios-geolocation`) can report location in the background and Apple requires both strings when the binary is linked. **ParQueen does not use native iOS geolocation or background location in Phase 2B.** The Always string is not a ParQueen background-tracking feature. iOS native auth and iOS location validation remain out of scope.

## Physical Samsung acceptance (Juan)

Not performed by this change. Validate on **Samsung SM-G981U1 / Android 13** with a local debug APK after `npx cap sync` + `:app:assembleDebug`.

1. Fresh install (or clear app data). Sign in. Location primer appears.
2. Tap **Not now**. Map opens without an OS location dialog. No user marker. Recenter does not invent a GPS fix.
3. Settings → Location → Enable location. OS dialog appears **once**. Allow **precise**.
4. Map shows a blue user marker near the real position. Recenter flies to it. Walking / waiting updates the marker (`watchPosition`).
5. Nearby Activity / Notifications uses the same grant and shows nearby Pings (or empty, not a permission wall).
6. Force-stop and reopen: no second OS dialog; marker returns.
7. App info → Permissions → Location → **Allow approximate**. Marker / recenter / nearby still work (coarser).
8. App info → Permissions → Location → **Deny**. App does not re-prompt the OS. Nearby shows blocked / enable-from-settings. Transient GPS timeout while still allowed must **not** flip the app to permanently denied.
9. Turn off device Location. Enable in-app should not store a permanent denial; turning Location back on and retrying works.
10. Confirm no `ACCESS_BACKGROUND_LOCATION` in the installed app's permission list.

Do not deploy Hosting, Functions, or Firestore rules for this validation.
