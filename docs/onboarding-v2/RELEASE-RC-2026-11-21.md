# Onboarding 2.0 + New Location Screen — development rollout

**Status: DEV-ONLY, no app-store submission, no live Hosting publish.** Updated 2026-11-21 after founder clarification: ParQueen has **never** been uploaded to Google Play or the Apple App Store and is still in development. Source baseline: `170b05f1a34f30fc827d3d3b9d47badb7bf0cc28` (merged #314, #356, #357).

## Corrected deployment target

The immediate goal is to use the real new screens in the **Android development build** (Galaxy S20), and optionally a separate web development preview — **not** to create a signed store-release AAB. The existing `app.parqueen` debug keystore/signature is suitable for local development; **release signing is not a blocker**.

**Existing evidence (not a new install in this PR):** the Android debug build from `170b05f` was previously installed in place with `VITE_ONBOARDING_V2=1` and `VITE_OBV2_PREVIEW=1`. The actual location screen preview passed on the physical S20 (360×726 usable viewport, services-off overflow 22px → 0, regular layout unchanged, permissions unchanged). That already makes the redesigned location screen available in the development build. An authenticated account naturally bypasses first-time onboarding, so a separate clean test identity/environment is needed to exercise the **real first-run flow**; using Settings Preview is non-destructive but does not test all signup transitions.

## Android debug build only

From a clean source worktree at the pinned source commit, with the *existing* approved local Mapbox/Firebase configuration and `google-services.json` (never print or commit values):

```powershell
$expected = '170b05f1a34f30fc827d3d3b9d47badb7bf0cc28'
if ((git rev-parse HEAD).Trim() -ne $expected) { throw 'Wrong source revision: stop' }
if (git status --porcelain) { throw 'Dirty worktree: stop' }

$env:VITE_ONBOARDING_V2 = '1'
# Founder-only Settings previews are appropriate on the development S20.
$env:VITE_OBV2_PREVIEW = '1'
$env:VITE_OBV2_DIAG = '0'
$env:VITE_QA_AUTH = 'false'
$env:VITE_PARQUEEN_APPCHECK_QA = 'false'
$env:VITE_POSTHOG_ENABLED = 'false'
if ($env:VITE_POSTHOG_PROJECT_TOKEN) { throw 'PostHog token present: stop' }

npm ci
npm run cap:sync:android
Push-Location android
try { .\gradlew.bat :app:assembleDebug } finally { Pop-Location }
```

- `cap:sync:android` must use the native-specific build path with both approved `VITE_MAPBOX_TOKEN` and `VITE_MAPBOX_ANDROID_TOKEN`. Android-generated `dist/` must **never** be deployed to web Hosting.
- `assembleDebug` is sufficient. **Do not** run `bundleRelease`, request an upload keystore, generate a replacement keystore, use an upload key, or bump `versionCode` for local QA.
- Check artifact SHA-256, package `app.parqueen`, compiled flags, and the debug APK signer SHA-256 against the installed app before considering `adb install -r`. Stop on a signer mismatch. Do not uninstall or clear app data. If the exact candidate is already installed and evidence is current, do not reinstall just to repeat the step.
- The Settings preview is restricted to explicitly opted-in Android development builds. It demonstrates the real Onboarding 2.0 story and location art, but it does not prove live new-account signup or actual permission transitions. The location hint preview must not request OS location permissions or write Firebase data.

## Acceptance on S20

- [x] Source `170b05f` debug location screen + S20 hint/regular layout evidence reported by founder
- [x] Compiled `VITE_ONBOARDING_V2=1` and disabled diagnostic/QA auth/PostHog flags reported by founder; store candidate's compiled assets separately passed pre-signing checks
- [ ] Confirm Onboarding 2.0 welcome, neighborhood story, Replay/Skip, EN/ES, and three intentions **on the actual installed debug build** (Settings preview may be used without changing auth)
- [ ] Test the true first-time welcome → intention → OTP/username → new location screen → map journey on an **isolated development account/profile or emulator** only after an explicit test plan; never clear the founder's S20 account or sign out unexpectedly
- [ ] Verify location Allow/Deny/Not Now, services-off hint, reduced motion, TalkBack, increased font size, and Back routing without unintended Pings or production writes
- [ ] Keep exact source, APK/asset hashes, signing check, redacted device screenshots and permission snapshots in durable local evidence storage rather than temporary scratchpads

## Optional web development preview (separate from Android)

Build a **browser** artifact separately with `VITE_ONBOARDING_V2=1`, `VITE_OBV2_PREVIEW=0` and the approved browser Mapbox token. Use a local Vite preview first, or a private Firebase Hosting **preview channel** with explicit permission. If a preview channel uses the current production Firebase project it can still connect to the production backend; it is **not an isolated staging backend**. Prefer a separately configured staging Firebase project for first-time signup/permission testing. Do not run an unscoped `firebase deploy`, do not deploy native `dist/` to Hosting, and do not modify Functions/rules/IAM/App Check.

## Later milestone, not a current blocker

Before a **first Google Play upload**, confirm Play Console app state and generate/secure an **initial upload key** if no key was ever registered; verify versionCode, release signing and Play App Signing. That process is separate from getting the UI into a local debug build. A new store release or production Hosting publish still requires its own release plan and applicable S7/A5 gates; both remain NO_GO, untouched here.

## Boundaries

This draft changes documentation only. It does not install anything, build on the founder's PC, change credentials, upload to a store, publish Hosting, create accounts, change authorization rules, alter S7/A5 gates, or merge into `main`. 
