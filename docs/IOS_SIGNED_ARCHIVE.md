# Signed iOS archive

`.github/workflows/ios-signed-archive.yml` builds a real production web bundle, copies it into the Capacitor iOS shell, and can archive and export `app.parqueen` on a GitHub-hosted `macos-26` runner.

Pull requests run a secret-free contract check. The signed job does not run on a pull request.

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

Signing stays automatic. `DEVELOPMENT_TEAM` comes from `APPLE_TEAM_ID` on the `xcodebuild` command. The project does not store a Team ID or a provisioning profile.

Export uses Xcode 26 `app-store-connect`, destination `export`, automatic signing, and `manageAppVersionAndBuildNumber` false. The IPA stays on the ephemeral runner. The workflow does not send it to App Store Connect and does not publish it as a GitHub artifact.

The verifier records the IPA filename, byte size, and SHA-256. It checks bundle ID `app.parqueen`, version `1.0`, build `1`, display name `ParQueen`, code signature, and entitlements. `aps-environment` must be absent. An entitlement outside the automatic App Store set (`application-identifier`, `com.apple.developer.team-identifier`, `keychain-access-groups`, `beta-reports-active`) stops the job.

## What this does not do

It does not deploy Firebase, change Street Intelligence, or change application source. A green pull request only means the contract check passed.
