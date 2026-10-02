# Signed iOS archive

`.github/workflows/ios-signed-archive.yml` builds a real production web bundle, copies it into the Capacitor iOS shell, and can archive and export `app.parqueen` on a GitHub-hosted `macos-26` runner.

Pull requests run a secret-free contract check and an ad-hoc Release archive. They do not receive Apple credentials and they do not export an IPA. The signed job does not run on a pull request.

## Manual run

After this workflow is on `main`, start it with **Run workflow** on `main`.

The confirmation input must be exactly:

`SIGN_PARQUEEN`

The signed job also requires `refs/heads/main` and a passing dispatch guard. Any other branch or confirmation rejects the run before archive.

Rollback is to not dispatch the workflow.

## Secrets

Names only. The signed job stops if any of these are empty. It prints `PRESENT` or `MISSING` and nothing else about them.

- `APPLE_TEAM_ID`
- `ASC_ISSUER_ID`
- `ASC_KEY_ID`
- `ASC_API_KEY_P8_BASE64`
- `VITE_MAPBOX_TOKEN`
- `VITE_FIREBASE_APPCHECK_SITE_KEY`
- `VITE_SENTRY_DSN`
- `VITE_FIREBASE_VAPID_KEY`

`SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT` are not required. The production build leaves source-map upload off. The Sentry DSN can still be compiled into the app.

The `.p8` is decoded into `$RUNNER_TEMP`, mode `600`, checked with `openssl pkey -noout`, and deleted before the job exits. It is not committed and not saved as an artifact.

## Archive and export

The archive step and the export step are separate. The project does not store a Team ID or a provisioning profile.

The Xcode project still inherits the Capacitor default identity `iPhone Developer`. Manual run 3 reached Apple provisioning during archive and requested an iOS App Development profile, which requires a registered device. Manual run 5 forced `Apple Distribution` on the archive command. That identity conflicted with automatic development signing on the App target and on Swift package targets, including IONCameraLib.

The archive command now uses CI ad-hoc signing: `CODE_SIGN_IDENTITY=-`, `AD_HOC_CODE_SIGNING_ALLOWED=YES`, and `CODE_SIGN_STYLE=Automatic`. On the manual job, `DEVELOPMENT_TEAM` still comes from `APPLE_TEAM_ID`. The archive command does not update provisioning and does not pass the App Store Connect API key. No device is registered for this, and the project file is unchanged.

Pull requests create the same ad-hoc archive with the Stage A CI-only web bundle and without a team. The probe checks that the archive and `App.app` exist, with bundle ID `app.parqueen`, version `1.0`, and build `3`. It does not require a distribution signature and it does not upload the archive.

Export remains the distribution step. It uses Xcode 26 `app-store-connect`, destination `export`, automatic signing, and `manageAppVersionAndBuildNumber` false, with provisioning updates and the Team API key. The IPA stays on the ephemeral runner. The workflow does not send it to App Store Connect and does not publish it as a GitHub artifact.

Manual run 7 archived and exported a signed IPA. The workflow then failed because the verifier treated any `get-task-allow` key as unexpected. Distribution signing can set that key to false. Development signing sets it to true. The verifier now accepts an absent key and boolean false, and it rejects boolean true or any other value. It also checks the embedded provisioning profile for the app identifier, the team, and `get-task-allow` false. It does not print the profile.

The verifier records the IPA filename, byte size, and SHA-256. It checks bundle ID `app.parqueen`, version `1.0`, build `3`, display name `ParQueen`, code signature, team match, and the production web bundle. `aps-environment` must be absent. An entitlement outside the automatic App Store set (`application-identifier`, `com.apple.developer.team-identifier`, `keychain-access-groups`, `beta-reports-active`, `get-task-allow`) stops the job.

Manual run 9 archived, exported, codesigned, and validated the distribution profile and the production configuration. The only failure was the debug-token check. The Firebase SDK can contain a passive read of `FIREBASE_APPCHECK_DEBUG_TOKEN`. That presence is not a debug-token leak. The IPA still fails if `VITE_APPCHECK_DEBUG_TOKEN` survives in the bundle, if `FIREBASE_APPCHECK_DEBUG_TOKEN` is assigned, or if an `appcheck-debug-` bypass marker is present.

Manual run 11 stopped before signing. The production App Check bundle assertion AC-3 treated any literal `VITE_FIREBASE_APPCHECK_SITE_KEY` occurrence as unresolved configuration. A production build can keep that name as text, or as a resolved Vite env-object key next to the substituted value. Corrected AC-3 allows those and rejects an unresolved `import.meta.env.VITE_FIREBASE_APPCHECK_SITE_KEY` access. The signed IPA check still reports whether the production App Check configuration is embedded, without printing the value.

## What this does not do

It does not deploy Firebase, change Street Intelligence, or change application source. A green pull request means the contract check and the ad-hoc archive probe passed. It does not mean an App Store IPA was exported.
