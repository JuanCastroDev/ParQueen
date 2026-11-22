# Onboarding 2.0 + Location Screen: release-candidate execution

**Disposition: PREPARATION ONLY — NOT DEPLOYED.** Prepared 2026-11-21 from `main` commit `170b05f1a34f30fc827d3d3b9d47badb7bf0cc28` (merged PRs #314, #356, #357). This document neither authorizes bypassing security gates nor makes a production change.

## Objective and scope

Ship the **existing** Onboarding 2.0 and redesigned Enable Location screen *before* further optional visual work. The location hint overflow fix was confirmed on a physical Galaxy S20: 360×726 usable CSS pixels, 0 vertical overflow (previously 22px), regular screen unchanged, no location-permission changes. This is targeted device evidence, not full release QA.

- **In scope:** Opt in to `VITE_ONBOARDING_V2=1` at build time, produce separate Android and web/PWA candidates, verify real first-time onboarding and location transition, then publish only after required gates are cleared.
- **Out of scope:** Firebase Functions, Firestore/Storage rules, IAM, App Check configuration, production data writes, S7, A5, account creation/deletion for QA, changes to preview behavior, and any Google Play or Hosting publication without a release gate.
- **Rollback:** Rebuild the relevant client with `VITE_ONBOARDING_V2` unset. This is a build-time switch, not a live remote toggle. Android store rollback requires a new versionCode and republishing, not uninstalling users' apps.

## Release flags (both candidate builds)

| Variable | Value | Reason |
| --- | --- | --- |
| `VITE_ONBOARDING_V2` | `1` | Opts into the integrated new-user path |
| `VITE_OBV2_PREVIEW` | `0` | Disable Android Settings preview entry |
| `VITE_OBV2_DIAG` | `0` | Disable development-only diagnostics |
| `VITE_QA_AUTH` | `false` | Keep QA auth bypass off |
| `VITE_PARQUEEN_APPCHECK_QA` | `false` | Keep App Check QA panel off |
| `VITE_POSTHOG_ENABLED` | `false` | Maintain release analytics freeze |

`VITE_POSTHOG_PROJECT_TOKEN` must remain **unset**: the existing build guard is fail-closed. Use already-approved local environment/configuration for Mapbox and Firebase. Never commit, print, transmit, or regenerate token, signing, or `google-services.json` values.

## Execution from the approved clean source worktree

Use the exact verified commit for the candidate; **do not reset, clean, or overwrite** a working directory with unrelated changes. The working tree and branch identity must be recorded before any build. The commands below package candidates only.

PowerShell environment in a dedicated terminal:

```powershell
$expected = '170b05f1a34f30fc827d3d3b9d47badb7bf0cc28'
if ((git rev-parse HEAD).Trim() -ne $expected) { throw 'Wrong source revision: stop' }
if (git status --porcelain) { throw 'Dirty worktree: stop' }

$env:VITE_ONBOARDING_V2 = '1'
$env:VITE_OBV2_PREVIEW = '0'
$env:VITE_OBV2_DIAG = '0'
$env:VITE_QA_AUTH = 'false'
$env:VITE_PARQUEEN_APPCHECK_QA = 'false'
$env:VITE_POSTHOG_ENABLED = 'false'
if ($env:VITE_POSTHOG_PROJECT_TOKEN) { throw 'PostHog release token is present: stop' }
```

### Android (first priority)

1. Preserve the existing `app.parqueen` application ID, release signing configuration, local `google-services.json`, and approved Android Mapbox token. Do **not** switch on `VITE_OBV2_PREVIEW` or diagnostic flags.
2. Execute from repository root:

   ```powershell
   npm ci
   npm run cap:sync:android
   Push-Location android
   try { .\gradlew.bat :app:bundleRelease } finally { Pop-Location }
   ```

3. The `cap:sync:android` command uses the native-only Vite build path and enforces both `VITE_MAPBOX_TOKEN` and `VITE_MAPBOX_ANDROID_TOKEN`. The existing PostHog release check must pass. The Gradle release signing guard must use the approved external upload key; missing/malformed release keys must fail closed.
4. Record source SHA, build logs (redacted), AAB SHA-256, package ID, versionCode, upload certificate fingerprint, and whether the Play App Signing certificate is registered for Firebase Auth/App Check. An AAB is **not** a device-installed APK; do not call `adb install -r` on it or replace the authenticated S20 debug build with a differently signed APK.
5. Only after release gates pass: upload the verified artifact to the intended Google Play test track through the authenticated founder-controlled console; verify a genuinely fresh user's welcome → story → intention → signup → location prompt → map flow. Existing-account S20 preview evidence does not substitute for that test.

### Web/PWA (separate artifact)

Never deploy the Android-specific `dist/` to Hosting. Build web assets separately, with the same release flags and the existing browser Mapbox/App Check configuration:

```powershell
npm run build
npm run verify:posthog:release
```

Record an independent web `dist/` digest/manifest and review the new-user routing, location prompt, Spanish copy and access behavior. **Do not run a Hosting deployment until release gates pass.** The final approved command must be scoped only to Hosting, with explicit project `parkqueen-46475363-ccf36`:

```powershell
# GATED PUBLICATION STEP — NOT YET AUTHORIZED FOR EXECUTION
firebase deploy --only hosting --project parkqueen-46475363-ccf36
```

Never use an unscoped `firebase deploy`: it could publish Functions or rules. Confirm the currently deployed Hosting version and preserve a rollback artifact before any publish.

## Release gates — fail closed

- [ ] **Source/provenance:** exact source SHA pinned; clean worktree; required CI passes; no unreviewed changes or changed release-sensitive paths
- [ ] **Product reviews:** D21 Spanish native-speaker pass for all Onboarding 2.0 and location copy; D27 review of the Ping availability/non-reservation disclosure
- [ ] **Accessibility:** on-device TalkBack, largest system font, reduced motion; compact viewport with permission hint and EN/ES; verify actual CTA and text remain reachable
- [ ] **Real path:** fresh eligible user journey, all three intentions, OTP/username, permission allow/deny/decline/services-off, map/Ping, Android Back, and re-entry without deleting the founder's account
- [ ] **Binary safety:** flag state verified from produced build; no preview/diag/QA auth or PostHog enabled; correct package/signing; native Mapbox/App Check checks
- [ ] **Backend boundaries:** no Functions, rules, IAM, App Check setting changes; confirm S7/A5 NO_GO release constraints have been explicitly resolved or a separate, documented UI-only release authorization exists that does not bypass them
- [ ] **Publication:** founder approval of exact tested artifact, destination track/site, rollback path and expected affected users; postpublish smoke evidence

## Evidence already available, but not promoted to full release approval

- **PASS:** physical S20 location hint at 360×726 after PR #357, 22px → 0 overflow, no regular-screen/layout or location permission regression, `adb install -r` preserved account.
- **PASS previously:** Onboarding 2.0 visual story, transition, and Android Back smoke testing (see `docs/onboarding-v2/INTEGRATION-QA.md`).
- **NOT VERIFIED for this release:** clean signed distributable AAB, new user end-to-end on release artifact, current D21/D27/A12 signoffs, Play track upload, Firebase Hosting publication, and post-deploy verification.
- **UNCHANGED:** S7 and A5 have outstanding NO_GO dispositions. No release is represented as approved by this document.

## Stop criteria

Stop immediately if source identity differs, worktree is dirty, required environment/signing is missing, forbidden QA/analytics tooling appears, CI or legal/accessibility gates fail, the account/session or signing identity would be destroyed, or any instruction tries to broaden publication beyond client assets. Preserve evidence and report a precise blocked status; do not work around the gate.
