# TestFlight upload

`.github/workflows/ios-testflight-upload.yml` builds the exact `main` commit selected for the run, exports one signed App Store IPA, verifies it, asks Apple to validate that same file, and only then uploads it to App Store Connect.

The workflow is manual. Merging it does not upload a build. Pull requests do not start it, and they do not receive Apple credentials. Secret Scan and PR Gate still run on the pull request that adds the workflow.

`.github/workflows/ios-signed-archive.yml` stays the no-upload signed IPA proof. This workflow reuses that archive, export, and IPA verification path.

## Manual run

After this workflow is on `main`, start it with **Run workflow** on `main`.

The confirmation input must be exactly:

`UPLOAD_PARQUEEN_TESTFLIGHT`

The upload job also requires `refs/heads/main`, that confirmation phrase, and a passing dispatch guard. Any other branch or confirmation rejects the run before secrets are read.

The job checks out `github.sha` for that dispatch. It rebuilds that commit. It does not reuse an IPA from an earlier run.

Rollback is to not dispatch the workflow.

Manual run 1 (`37029996875`) stopped in the upload contract before any build or Apple call. The dispatch guard passed. The static checker then rejected the workflow because it global-counted a checkout-pin literal that also appeared in its own source. No archive, IPA, Apple validation, or TestFlight upload was attempted.

The contract now finds the two real checkout steps and reads only each step's `with:` block. Both must pin `ref` to the dispatched commit and set `persist-credentials` to false. A third checkout step is rejected. The checker builds those match tokens dynamically, so it does not count its own source.

## Secrets

Names only. The upload job stops if any of these are empty. It prints `PRESENT` or `MISSING` and nothing else about them.

- `APPLE_TEAM_ID`
- `ASC_ISSUER_ID`
- `ASC_KEY_ID`
- `ASC_API_KEY_P8_BASE64`
- `VITE_MAPBOX_TOKEN`
- `VITE_FIREBASE_APPCHECK_SITE_KEY`
- `VITE_SENTRY_DSN`
- `VITE_FIREBASE_VAPID_KEY`

`SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, and `SENTRY_PROJECT` are not required. The production build leaves source-map upload off.

## Verified IPA, then Apple, then upload

The archive step uses the Stage C ad-hoc settings: `CODE_SIGN_IDENTITY=-`, `AD_HOC_CODE_SIGNING_ALLOWED=YES`, and `CODE_SIGN_STYLE=Automatic`, with `DEVELOPMENT_TEAM` taken from `APPLE_TEAM_ID`. It does not update provisioning and does not pass the App Store Connect API key.

Export is local. `destination` is `export`. `manageAppVersionAndBuildNumber` stays false, so this workflow does not change the marketing version or the build number.

The IPA verifier must pass before Apple is contacted. It requires one IPA, bundle ID `app.parqueen`, version `1.0`, build `2`, display name `ParQueen`, a valid code signature, a distribution profile, team match, and the production web bundle. `aps-environment` must be absent. `get-task-allow` must be absent or boolean false on the app, and boolean false on the profile. Mapbox, production App Check, and the Sentry DSN must be embedded. Debug App Check wiring must be absent. The rules match the signed-archive workflow.

The verifier records the IPA path and SHA-256. Validation and upload both recompute that hash and stop if the file changed. Upload also requires the validation step to have accepted that same digest. The workflow does not repack the IPA between those steps.

`xcrun altool --help` is read on the runner before validation. The command uses the file, platform, API key, and issuer spellings that help actually prints, preferring `--file`, `--type`, `--apiKey`, and `--apiIssuer`. `--p8-file-path` is passed only when help documents it for validate or upload. Otherwise the temporary key is copied to `$HOME/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8` with mode `600`. The key id is not printed.

Apple validation runs first. If it fails, or if the result is not a clear pass, the workflow stops and does not upload.

There is one upload command. It is `xcrun altool --upload-app` with API-key authentication, aimed at the verified IPA. The workflow does not loop and does not start a second upload.

## Ambiguous upload

The workflow does not increment the project build number.

If the upload times out, the runner is disconnected, the network fails after the transfer starts, or Apple does not clearly accept or reject the delivery, the final status is:

`UPLOAD STATUS AMBIGUOUS — CHECK APP STORE CONNECT BEFORE RETRY`

Do not dispatch the workflow again until App Store Connect shows whether that build arrived. A second upload of the same version and build can be rejected as a duplicate when the first delivery was accepted. This workflow will not make that second attempt by itself.

A clear rejection is `UPLOAD FAILED`. A clear acceptance is `UPLOAD ACCEPTED`. A delivery or request id is printed when Apple provides one. Credentials are not printed.

## What acceptance means

`UPLOAD ACCEPTED` means Apple accepted the binary delivery.

It does not mean processing has finished, the build is available in TestFlight, export compliance is complete, a testing group was assigned, external testing was approved, or the app was submitted for App Store review. Those steps stay manual.

## TestFlight history

Upload #2 delivered marketing version 1.0, build 1. Apple accepted the delivery, then failed post-processing with ITMS-90683 because `NSPhotoLibraryUsageDescription` was missing. The Photos-capable `@capacitor/camera` plugin was linked into that binary.

D2 removed `@capacitor/camera` and made Sign Scanner camera-only. The gallery path was removed. The IPA verifier requires a non-empty `NSCameraUsageDescription` and rejects packaged `CapacitorCamera` or `IONCameraLib` bundle names. It does not require a Photos-library purpose string.

Upload #3 delivered the same marketing version 1.0, build 1, after that camera-only change. Apple accepted the delivery and post-processing completed. App Store Connect shows 1.0 (1) as Complete. That completed processing is the evidence that ITMS-90683 is resolved. Build 1 used the simplified pin mark, not the crowned ParQueen icon.

The next upload is marketing version 1.0, build 2. The build number changed because a processed build number cannot be reused. The change in that build is the canonical crowned iOS app icon. This document does not dispatch that upload.

## Cleanup

The cleanup step always deletes the temporary private key, the lookup-key copy, the export options plist, the IPA, the unpacked IPA, the xcarchive, the decoded provisioning profile, and the validation and upload logs. It then checks that the private key files, the IPA directory, and the archive are gone. Nothing is saved as a GitHub artifact.

## What this does not do

It does not deploy Firebase, change Street Intelligence, change application source, add external testers, or make the app public. A green pull request means the workflow file is present and the normal PR checks passed. It does not mean a build was uploaded.
