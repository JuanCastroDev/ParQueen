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
| Not yet requested (`prompt`) | Primer / Enable still available; stored `declined` is honoured. On **native Android**, a stale stored `denied` from a pre-native WebView build is **not** treated as permanently blocked — OS `prompt` wins and Enable is offered. Web/PWA still preserves stored `denied`. |
| Granted precise | `granted` |
| Granted approximate / coarse | `granted` (usable) |
| Denied | `denied` — no repeated OS prompt. On Android this is only when the **OS** reports denied. |
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

## Physical Samsung acceptance (validated 2026-09-14)

**Validated on Samsung SM-G981U1 / Android 13** against exact head `edc4a045705f8ddf7cf5ccd6cb10f82c92a4eb23`. No Hosting / Functions / Firestore rules deploy.

| Check | Result |
| --- | --- |
| Clean OS location state (coarse/fine not granted) | Pass |
| Migration: Settings showed Not allowed / **Enable location** (not Blocked / Check again) | Pass |
| Enable location -> native Android runtime dialog | Pass |
| Precise + While using the app | Pass |
| Map showed current location immediately | Pass |
| Force-close / reopen: no second OS dialog; marker returned | Pass |
| No `ACCESS_BACKGROUND_LOCATION` declared | Pass |

The stale pre-native denial migration bug is **physically confirmed fixed**.

### Acceptance checklist (completed)

1. Fresh / clean permission state reproduced (coarse and fine not granted).
2. Stale stored denial migration: Location not allowed + Enable location (not Blocked / Check again).
3. Tap Enable location -> Android runtime dialog.
4. Allow Precise + While using the app.
5. Map shows current location; current-location marker returns after force-close/reopen without a second dialog.
6. No `ACCESS_BACKGROUND_LOCATION` in the installed app.

### Migration note (stale pre-native `denied`)

Existing installs that ran WebView/browser geolocation before Phase 2B can have `locationAccessChoice=denied` while Android still reports `prompt`. Native reconciliation treats OS `prompt` as authoritative over that stale denial so Enable can request the OS permission. Web/PWA browser semantics are unchanged.

Do not deploy Hosting, Functions, or Firestore rules for this validation.
