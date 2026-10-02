# iOS signing readiness (Stage B)

Stage B prepares GitHub-hosted signing for ParQueen. It does not sign, archive, export an IPA, upload to TestFlight, or submit to App Store Connect.

The company Mac is out of scope. Stage C, when authorized, runs on a GitHub-hosted macOS runner.

## Current Xcode project

Confirmed on `main` after Stage A:

| Setting | Value |
| --- | --- |
| Project | `ios/App/App.xcodeproj` |
| Scheme | `App` (resolved by `xcodebuild -list`; no shared `.xcscheme` is committed) |
| Bundle ID | `app.parqueen` |
| Marketing version | `1.0` |
| Build number | `1` |
| Deployment target | `15.0` |
| Signing style | Automatic (`CODE_SIGN_STYLE` and target `ProvisioningStyle`) |
| `DEVELOPMENT_TEAM` | Absent. Do not commit it. |
| Provisioning profile | Absent |
| Entitlements file | Absent |
| `aps-environment` | Absent |

`CODE_SIGN_IDENTITY` at the project level remains the Capacitor default `iPhone Developer`. Stage B does not change it. Distribution re-signing belongs to the Stage C export.

Native plugins linked from `ios/App/CapApp-SPM/Package.swift`: Capacitor, Cordova, App, Camera, Geolocation, Push Notifications. iOS product code still uses the browser path for camera, location, push, and App Check. No entitlement file is required for the first TestFlight.

## Identifiers

These are different values. Do not substitute one for another.

| Name | What it is | Where JC reads it |
| --- | --- | --- |
| Team ID | 10-character Apple Developer team identifier | Apple Developer account → Membership details |
| Issuer ID | App Store Connect API issuer, a UUID | Users and Access → Integrations → App Store Connect API, above the key list |
| Key ID | Identifier of one API key | The key row after Generate |
| Apple ID | The account email used to sign in | Not used by `xcodebuild` authentication flags |
| Bundle ID | `app.parqueen` | Already on the Xcode target and the App Store Connect app record |

The Team ID is not known to this repository. Do not invent one, and do not commit one.

## App Store Connect actions for JC

Do this in the browser. Do not paste the private key into chat, Cursor, or git.

1. Sign in to [App Store Connect](https://appstoreconnect.apple.com) as a user who can open Users and Access. Generating a team key requires Account Holder or Admin.
2. Open **Users and Access → Integrations**. The page opens on **App Store Connect API**.
3. If the page offers **Request Access** instead of team keys, stop. The Account Holder has to submit that request and wait until Apple enables API access. Nobody else can generate a team key before that.
4. Open **Team Keys**. Do not create an Individual key. Apple documents that individual keys cannot call Provisioning endpoints, so they cannot drive `xcodebuild -allowProvisioningUpdates`.
5. Choose **Generate API Key** (or **+** if a key already exists).
6. Set the role to **Admin**. That is the minimum role that can create distribution certificates and App Store provisioning profiles. App Manager can manage TestFlight later, but cannot create those signing assets. Developer can create development certificates and development profiles, not App Store distribution assets. Account Holder is a person, not a key role.
7. Generate the key. Download `AuthKey_XXXXXXXXXX.p8` immediately. Apple shows that file once.
8. Store three things offline, outside the repository:
   - Issuer ID
   - Key ID
   - the `.p8` file
9. Read the Team ID separately from [Apple Developer](https://developer.apple.com/account) → **Membership details**. It is not the Issuer ID and not the Key ID.

No API key is created by this stage.

## Future GitHub Actions contract

Create these only when Stage C is authorized. This stage does not create them.

Signing secrets:

| Name | Contents |
| --- | --- |
| `APPLE_TEAM_ID` | Team ID from Membership details |
| `ASC_KEY_ID` | Team API key ID |
| `ASC_ISSUER_ID` | Issuer ID from the Integrations page |
| `ASC_API_KEY_P8_BASE64` | Base64 of the `.p8` file, one line, no extra whitespace |

Production build inputs for the signed archive. Names only:

| Name | Kind | Stage C iOS build |
| --- | --- | --- |
| `VITE_MAPBOX_TOKEN` | Actions variable. PR Gate already uses `vars.VITE_MAPBOX_TOKEN`. | Required. `vite build` fails closed without it. |
| `VITE_FIREBASE_APPCHECK_SITE_KEY` | Actions variable | Required for the iOS bundle. Capacitor iOS initializes App Check with `ReCaptchaEnterpriseProvider` only when this is set. |
| `VITE_SENTRY_DSN` | Actions variable | Optional for compilation. Supply it when the TestFlight bundle should include Sentry. |
| `VITE_FIREBASE_VAPID_KEY` | Actions variable | Not required for the first iOS TestFlight. The iOS shell does not register for push. |
| `SENTRY_AUTH_TOKEN` | Secret | Optional. Source-map upload runs only when this, `SENTRY_ORG`, and `SENTRY_PROJECT` are all set. |
| `SENTRY_ORG` | Variable | Optional. Same rule as the auth token. |
| `SENTRY_PROJECT` | Variable | Optional. Same rule as the auth token. |

The Stage C job must run a real `npm run build` and then `npx cap copy ios`. The Stage A placeholder `dist/index.html` must not be used.

On the runner, the `.p8` handling is:

- decode `ASC_API_KEY_P8_BASE64` into `$RUNNER_TEMP` only
- `chmod 600` the temp file
- pass that path as `-authenticationKeyPath`
- delete the file before the job exits, including on failure
- never echo the key, the base64, or the file
- never upload it as an artifact
- never commit it

macOS decode is `base64 -D`. Do not print the decoded bytes.

## Stage C commands

Not run in Stage B. `DEVELOPMENT_TEAM` is an `xcodebuild` build setting from `APPLE_TEAM_ID` because automatic signing needs a team and the project must not hard-code one.

```bash
xcodebuild \
  -project ios/App/App.xcodeproj \
  -scheme App \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$RUNNER_TEMP/ParQueen.xcarchive" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$RUNNER_TEMP/AuthKey.p8" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID" \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
  archive
```

`xcodebuild -help` is the source for export keys. The readiness workflow requires it to document `app-store-connect`, `signingStyle`, and `teamID`. The export plist is generated on the runner:

- `method` = `app-store-connect`
- `destination` = `export` (write the IPA locally; do not upload)
- `signingStyle` = `automatic`
- `teamID` = the `APPLE_TEAM_ID` secret
- `manageAppVersionAndBuildNumber` = false, so version `1.0` and build `3` stay as they are in the project

```bash
xcodebuild \
  -exportArchive \
  -archivePath "$RUNNER_TEMP/ParQueen.xcarchive" \
  -exportPath "$RUNNER_TEMP/export" \
  -exportOptionsPlist "$RUNNER_TEMP/ExportOptions.plist" \
  -allowProvisioningUpdates \
  -authenticationKeyPath "$RUNNER_TEMP/AuthKey.p8" \
  -authenticationKeyID "$ASC_KEY_ID" \
  -authenticationKeyIssuerID "$ASC_ISSUER_ID"
```

`-allowProvisioningUpdates` with that team key is the supported headless model: Xcode creates or updates the distribution certificate and App Store provisioning profile. No `.p12` and no checked-in profile are required.

## First TestFlight capabilities

No capability is added in Stage B.

| Surface | First TestFlight |
| --- | --- |
| Camera | Info.plist usage string only. iOS capture stays on the browser file input. No camera entitlement. |
| Photo library | No entitlement. No photo-library usage string. iOS gallery stays on the browser file input. |
| Location | Info.plist when-in-use and always strings are already present because the Geolocation plugin is linked. iOS location stays on browser geolocation. No location entitlement and no background mode. |
| Push | Not required. `aps-environment` stays absent. iOS notifications stay on the browser path and are classified unavailable in the native shell. |
| Sign in with Apple, associated domains, Keychain sharing, background modes, App Attest | Not required. |

App Check on Capacitor iOS uses the existing web reCAPTCHA Enterprise site key. Do not add App Attest for this build. Whether reCAPTCHA succeeds inside the device WebView is a later device test, not a signing change.

An app-level `PrivacyInfo.xcprivacy` is still absent. That is not an entitlement and is not part of this signing setup.

## Readiness workflow

`.github/workflows/ios-signing-readiness.yml` boots `macos-26`, requires Xcode 26 or newer, runs `npm ci` and `tsc --noEmit`, checks the Release settings above, lists scheme `App`, and reads `xcodebuild -help`. It does not take Apple secrets and does not run `archive` or `exportArchive`.
