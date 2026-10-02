# Android sign scanner — camera-only capture

The Sign Scanner is camera-only on Web, PWA, Android, and iOS. Each surface uses the same hidden file input:

```html
<input type="file" accept="image/*" capture="environment" />
```

`@capacitor/camera` is not a dependency. The scanner does not offer a gallery, an existing-photo upload, or the Android system Photo Picker.

Profile photos are a separate user-initiated file input in `views/ProfileView.tsx` and `views/SetupProfileView.tsx`. They do not import `@capacitor/camera` and they do not request Photos-library authorization.

Physical camera behavior is not proven here. iOS WKWebView capture and Android WebView capture stay device QA items.

## Why the plugin was removed

Apple accepted delivery of TestFlight upload 1.0 (1) and then failed processing with ITMS-90683 because `NSPhotoLibraryUsageDescription` was missing. The Photos-capable Camera plugin was linked into the iOS binary even though sign scanning does not need the gallery. The product decision is to remove that plugin, not to add an unused Photos purpose string. Processing success is not claimed until a later upload finishes processing.

## Android camera permission

`android.permission.CAMERA` stays undeclared.

Capacitor's WebView file chooser (`BridgeWebChromeClient`) launches `ACTION_IMAGE_CAPTURE` when `capture` is set. `isMediaCaptureSupported()` treats a camera permission that is **not** declared in the manifest as able to open that system camera without a runtime prompt. Declaring `CAMERA` would add that prompt. Photo-library and storage permissions stay absent:

- `READ_EXTERNAL_STORAGE`
- `WRITE_EXTERNAL_STORAGE`
- `READ_MEDIA_IMAGES`
- `ACCESS_BACKGROUND_LOCATION`

## FileProvider

The app FileProvider stays. Capacitor core, not the removed camera plugin, writes the capture file with `getExternalFilesDir(DIRECTORY_PICTURES)` and shares it as `${applicationId}.fileprovider`.

`android/app/src/main/res/xml/file_paths.xml` keeps only that app-private Pictures path. The cache path that existed for `@capacitor/camera` is gone. Shared external storage (`external-path`) stays absent.

## Capture contract

- Preview uses a data URL
- `imageData` is raw base64 passed to `analyzeParkingSign()`
- Preview comes before Analyze. Capturing a photo does not spend an AI request
- Recent-scan history stores title, verdict, and timestamp only

`@capacitor/app` remains. It is used by Android system Back and is not part of the removed camera plugin.
