# Android Phase 2D — native camera + photo picker (AI Sign Scanner)

Phase 2D replaces the browser-style camera / photo-selection path on Capacitor Android with the official Capacitor Camera plugin, while preserving the existing Web/PWA file-input scanner. It does not deploy Hosting, Functions, or Firestore rules.

## Dependency

`@capacitor/camera@^8.2.4` (official Ionic/Capacitor plugin).

Verified against Capacitor 8.5.x: the plugin's peer is `@capacitor/core >= 8.0.0`. Installed `8.2.4`. No custom native plugin.

Also added `@capacitor/app@^8.1.1` (peer `@capacitor/core >= 8.0.0`, installed `8.1.1`). This is the documented home of `appRestoredResult`, which Capacitor uses when Android kills the WebView while the system camera Activity is open.

The scanner uses the **8.1+ API**: `takePhoto` (Open Camera) and `chooseFromGallery` (Choose Photos). Deprecated `getPhoto` / `CameraSource` are not used.

## Platform behavior

| Surface | Path |
| --- | --- |
| Web / PWA | Unchanged hidden `<input type="file" accept="image/*">` (camera input still has `capture="environment"`) |
| Capacitor Android | Official plugin: `takePhoto` → stock Android camera; `chooseFromGallery` → Android system Photo Picker (Android 13+), with `ACTION_OPEN_DOCUMENT` fallback on older devices |
| Capacitor iOS | **Not in this phase.** JS still uses the browser / file-input path. The plugin is linked by `cap sync` for Android. No `NSCameraUsageDescription` / photo-library usage strings were added. |

App UI must not import `@capacitor/camera` itself. `views/AssistantView.tsx` goes through `utils/signScanner.ts` (`utils/signScannerPlatform.ts` picks the path).

Contract is unchanged:

- Preview `<img>` uses a data URL
- `imageData` is raw base64 passed to `analyzeParkingSign()`
- Explicit **Preview → Analyze** step; capturing a photo does **not** spend an AI request
- Recent-scan history still stores title / verdict / timestamp only — never the photo

## Android permissions

**Not** added to `android/app/src/main/AndroidManifest.xml`:

- `CAMERA` — the plugin launches the stock camera via `ACTION_IMAGE_CAPTURE`. It only requests `CAMERA` if the app manifest declares it. Declaring it would add an extra runtime prompt we do not need.
- `READ_EXTERNAL_STORAGE`
- `WRITE_EXTERNAL_STORAGE`
- `READ_MEDIA_IMAGES`
- `ACCESS_BACKGROUND_LOCATION`

Android 10+ (API 29+) does not require storage permission for the system Photo Picker / `ACTION_OPEN_DOCUMENT`. Samsung SM-G981U1 is Android 13.

`saveToGallery` is **false**. Captured sign photos are not copied into the user gallery.

The official `@capacitor/camera` Android library (`ioncamera-android` 1.0.2) already packages the Photo Picker backport `ModuleDependencies` service. This app manifest does not duplicate it. Android 13 already has the system picker.

## FileProvider

`android/app/src/main/res/xml/file_paths.xml` previously exposed:

```xml
<external-path name="my_images" path="." />
<cache-path name="my_cache_images" path="." />
```

`<external-path path="." />` is the entire shared external storage root (`Environment.getExternalStorageDirectory()`). That is broader than camera capture needs.

**Final paths:**

```xml
<cache-path name="parqueen_camera_cache" path="." />
<external-files-path name="parqueen_camera_pictures" path="Pictures/" />
```

Why these two are required:

1. **`cache-path` `.`** — `@capacitor/camera` copies picker / camera bytes into `context.cacheDir` (`IonCameraUtils`). FileProvider must be able to share those app-private cache files with the camera / editor Activities. This is not shared storage.
2. **`external-files-path` `Pictures/`** — `CameraUtils.createImageFile` writes `EXTRA_OUTPUT` under `getExternalFilesDir(DIRECTORY_PICTURES)` (`Android/data/app.parqueen/files/Pictures/`). That directory is **app-private** external files, not the user gallery and not shared storage. The stock camera Activity needs a FileProvider URI to write the JPEG. Removing this path can fail capture with "Unable to create photo on disk" / `IllegalArgumentException: Failed to find configured root`.

**Removed:** `<external-path path="." />` (shared storage root). Not required for Capacitor Camera with `saveToGallery: false`.

The plugin's in-app editor path uses a **separate** FileProvider from `ioncamera-android` 1.0.2:

- Authority: `${applicationId}.camera.provider` (`app.parqueen.camera.provider`)
- Paths file: library `res/xml/ioncamera_paths.xml` (not this app's `file_paths.xml`)
- `takePhoto` / `chooseFromGallery` use this provider and write through `cacheDir` (`getAbsoluteCachedFilePath`) when `saveToGallery` is false

That library FileProvider's default path list is broader (including `<external-path path="." />`). ParQueen does **not** copy those entries into `android/app/src/main/res/xml/file_paths.xml`. Overriding `ioncamera_paths.xml` from the app was not done in this phase: it is the official plugin's resource, and a wrong override can fail capture (`IllegalArgumentException: Failed to find configured root`) with no Samsung device in this change to re-verify. The app-level FileProvider was still narrowed as requested.

ParQueen sets `editable: 'no'`, so the in-app editor Activity is not on the scanner path.

## Process restoration

Android can terminate ParQueen while the external camera Activity is open. `index.tsx` calls `initSignScannerRestore()` before React mounts. On Capacitor Android that registers `@capacitor/app` `appRestoredResult`.

- `pluginId === 'Camera'` and `takePhoto` / `chooseFromGallery` success → convert to the same preview / base64 contract and hold in memory
- AssistantView subscribes on mount and applies the result as **preview only** (no Analyze)
- User cancel or a failed restore is dropped; the scanner does not enter an error state
- The pending image is **not** written to disk, gallery, or `localStorage`. If the user never returns to Assistant, it is discarded with the JS heap

## Privacy

- No gallery save
- No new persistent photo storage beyond the existing in-memory scanner preview
- Recent scans still do not store photos
- Debug / error logs must not print image or base64 contents
- Gemini / `analyzeSign` semantics are unchanged; only the capture source on Android changed

## iOS note (not in this phase)

`@capacitor/camera` may be present in the iOS package graph after `cap sync` because Capacitor links official plugins for both platforms. **ParQueen does not use native iOS camera or photo-library APIs in Phase 2D.** JS on Capacitor iOS stays on the browser file-input path. `Info.plist` camera / photo-library usage strings were not added. iOS native camera remains out of scope.

## Physical Samsung acceptance (not validated in this change)

Do **not** treat this checklist as done until Juan runs it on device.

**Device:** Samsung SM-G981U1 / Android 13

1. Open ParQueen → Assistant → AI Sign Scanner
2. Tap Open Camera
3. Native Android camera opens
4. Take photo of a sign
5. Return to ParQueen and see the correct preview
6. Tap Analyze; existing analysis flow works
7. Retake another photo
8. Tap Choose Photos; Android system photo picker opens
9. Pick an existing image; preview / analyze works
10. Cancel camera → clean return, no error
11. Cancel photo picker → clean return, no error
12. Force / background / reopen around the camera flow; verify restoration where practical
13. Confirm no unnecessary storage / media permissions
14. Confirm `ACCESS_BACKGROUND_LOCATION` still absent

Confirm `dumpsys package app.parqueen` does **not** list `READ_EXTERNAL_STORAGE`, `WRITE_EXTERNAL_STORAGE`, `READ_MEDIA_IMAGES`, or `ACCESS_BACKGROUND_LOCATION`. `CAMERA` should also be absent unless a later phase justifies it.

Do not deploy Hosting, Functions, or Firestore rules for this validation.

### Local rebuild (Juan)

`google-services.json` remains required on the build machine (gitignored). Then:

```bash
npm ci
npm run cap:sync
# Android Studio / ./gradlew :app:assembleDebug
```
