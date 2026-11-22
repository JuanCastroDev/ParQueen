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
- [x] Confirm Onboarding 2.0 welcome, neighborhood story, Replay/Skip, EN/ES, and three intentions **on the actual installed debug build** (non-destructive Settings preview only; not an end-to-end signup)
- [ ] Test the true first-time welcome → intention → OTP/username → new location screen → map journey on an **isolated development account/profile or emulator** only after an explicit test plan; never clear the founder's S20 account or sign out unexpectedly
- [ ] Verify location Allow/Deny/Not Now, services-off hint, reduced motion, TalkBack, increased font size, and Back routing without unintended Pings or production writes
- [ ] Keep exact source, APK/asset hashes, signing check, redacted device screenshots and permission snapshots in durable local evidence storage rather than temporary scratchpads

## Optional web development preview (separate from Android)

Build a **browser** artifact separately with `VITE_ONBOARDING_V2=1`, `VITE_OBV2_PREVIEW=0` and the approved browser Mapbox token. Use a local Vite preview first, or a private Firebase Hosting **preview channel** with explicit permission. If a preview channel uses the current production Firebase project it can still connect to the production backend; it is **not an isolated staging backend**. Prefer a separately configured staging Firebase project for first-time signup/permission testing. Do not run an unscoped `firebase deploy`, do not deploy native `dist/` to Hosting, and do not modify Functions/rules/IAM/App Check.

## Later milestone, not a current blocker

Before a **first Google Play upload**, confirm Play Console app state and generate/secure an **initial upload key** if no key was ever registered; verify versionCode, release signing and Play App Signing. That process is separate from getting the UI into a local debug build. A new store release or production Hosting publish still requires its own release plan and applicable S7/A5 gates; both remain NO_GO, untouched here.

## Boundaries

This draft changes documentation only. It does not install anything, build on the founder's PC, change credentials, upload to a store, publish Hosting, create accounts, change authorization rules, alter S7/A5 gates, or merge into `main`.

## S20 non-destructive preview QA protocol

**Purpose:** Verify the installed Android development experience using an already-authenticated founder account. The agent running on the founder's Windows machine may use an attached S20 and authenticated WebView DevTools. This protocol **does not** authorize a new account, backend writes, permission changes, sign-out, app-data clear, reinstall, or Play/Hosting publish.

**Preflight and stop conditions**

1. Confirm Android Debug Bridge sees the Galaxy S20 and `app.parqueen` is installed. Capture installed APK signer fingerprint and a non-sensitive package/permission snapshot; do not dump application private storage, user tokens or identifying phone data.
2. Check the installed app for both **Preview Onboarding 2.0** and **Preview location screen** under Profile → Settings. If either is absent, record `BLOCKED_PREVIEW_FLAG_OR_VERSION`; only propose a same-signer `adb install -r` after verifying the installed debug key matches the candidate. Do not uninstall or clear data.
3. Keep notification shade closed. Never tap system Settings blindly. Prefer scoped WebView DevTools interactions; do not make screenshots of Android notifications/account panels. Do not save phone numbers, OTP, exact location or usernames in evidence.
4. Record baseline language (English), signed-in state (boolean only), and location permission values. Do **not** change Android permissions or system accessibility settings in this pass.

**Test A — Onboarding 2.0 preview (no signup)**

1. Enter Settings → **Preview Onboarding 2.0**. Verify original branded welcome appears and does not show legacy carousel.
2. Tap Get Started **once**; verify transition, NYC vector block, readable timed captions and three intentions. Record whether the expected approximately 8.3-second story progression is understandable, not just whether it plays.
3. Exercise Replay, Skip, Back, and a normal preview exit. Use a new preview entry for each independent path when appropriate.
4. Confirm choosing each intention, if exercised, **exits preview only**: no signup, Ping composer, publication, account change or saved intention.
5. Use the in-app language control to inspect the Spanish layout and restore the original English setting before finishing. If language change cannot be restored, stop and report without additional changes.

**Test B — redesigned location preview**

1. Enter Settings → **Preview location screen**. Verify ParQueen branding, editable top-down neighborhood art, example dot/radius and three example Pings, primary Enable location and Not now, and reassurance text.
2. Check the normal screen against the previously captured S20 baseline, including zero scroll overflow. The earlier services-off hint at 360×726 already passed; do not inject a hint again unless a regression is visible and the same non-destructive method is available.
3. In preview, both Enable location and Not now should **close preview only** and must not display a system permission dialog. Do not use the real permission screen for this interaction.
4. Return to Settings from inside the WebView. Verify no Android settings were changed.

**Post-test reconciliation**

- Signed-in account remains present; app language is restored to its baseline; installed package and signer unchanged.
- Android location permission status matches the preflight snapshot.
- No destructive operation, Ping publish, new account, sign-out, reinstall, or permission request was performed.
- Capture only privacy-safe, redacted UI evidence in a **durable** directory outside temporary Claude/Codex scratchpads.
- Report distinct `PASS` / `FAIL` / `NOT_TESTED` / `BLOCKED` for Test A and Test B; list exact viewport and remaining accessibility checks. Do not mark the full new-user journey verified based on preview.

**Follow-up, not part of this pass:** Full first-time onboarding → signup → real location permission must use a separately approved development identity/environment. An Android emulator with its own app storage is **not** automatically an isolated Firebase backend; check project, Auth and App Check config before entering or generating phone credentials. Existing S7/A5 NO_GO dispositions remain unchanged.

## S20 physical preview execution result — 2026-11-21

**Test A: PASS — Onboarding 2.0 founder preview.** Actual installed `app.parqueen` debug APK from source `170b05f`; APK SHA-256 reported as `911510df…3208`, debug signing SHA-256 `269fd3fd…27af`; viewport `360×726` CSS px. No reinstall. Branded welcome without legacy carousel, one-tap story progression with three captions (~0.5s, ~2.8s, ~6.5s), choices by ~8.2s, Replay/Skip, in-app Back, Android Back and X exit confirmed. All three intention selections **exit preview only**, without signup/Ping/composer or local intention storage mutation. Spanish visual pass had no clipping/overflow; original English restored. **D21 copy-review note:** `BIENVENIDA A` is feminine phrasing; determine whether intentional or replace with an inclusive alternative after review. It is not a verified translation defect.

**Test B: PASS — Location founder preview.** Artwork, example location dot/radius, three illustrative Pings, legend, controls and reassurance agree with previously accepted S20 layout; normal-screen overflow 0. Enable location, Not now, X and Android Back close preview to Settings without Android permission UI. Previous services-off hint regression PASS remains applicable to this exact installed APK; hint was not re-injected in this execution.

**Post-test: PASS.** Existing signed-in session, app package/signer/install timestamps, English language, local storage and Android location permissions unchanged. No install, sign-out, account creation, Ping publish, Firebase writes, or permission request. Safe screenshots (status bars redacted), package/permission snapshots and `RESULTS.md` in the founder's local `C:\Users\jayca\ParQueen-QA-Evidence\s20-preview-qa-20261121\` directory; private local evidence was **not** uploaded to GitHub.

**Remaining NOT_TESTED:** genuine first-user flow (OTP, username, location consent, map), 320×568 physical viewport, Spanish location screen, TalkBack, largest font and reduced motion. Full user-flow QA can use a debug build, not a signed release AAB. A fresh Android profile/emulator isolates *local app state* only; before any signup, verify its Firebase project and use an approved separate development identity/backend. Do not clear or log out the founder's S20 session. S7/A5 remain NO_GO and no public release is authorized.
