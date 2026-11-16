# ParQueen Street Intelligence RC02

Status: READY_FOR_REVIEW
Base: origin/main `399e524e302fd92c305be0cbcc9f735c056ea7ee`
Review candidate. Not merged, deployed, or published.
Built from reviewed RC01 without modifying RC01 or the working QA checkouts.

## Reconciliation

- `package.json`: `test:street-intel` is the RC01 list. `cap:sync`, `cap:sync:android`, `cap:copy`, and `verify:posthog:release` remain the current-main commands.
- `functions/curbIntelligence/lionRelationshipIndex.js` comment now says the request path does not scan the FileGDB. Runtime behavior is unchanged.
- PostHog files from `399e524e` are unmodified: `productionBuildConfig.ts`, `vite.config.ts`, `scripts/release-preflight/assert-posthog-release-disabled.mjs`, and the PR, signed-archive, and TestFlight workflows.
- Firestore rules tests read `FIRESTORE_EMULATOR_HOST` and use that endpoint for the rules client and Admin SDK. They fail if it is missing or malformed. Port 8080 is rejected only when `PARQUEEN_RULES_ISOLATED=1`. Rules and assertions are unchanged.

## Tracked changes

- android/app/build.gradle
- android/app/src/main/AndroidManifest.xml
- android/app/src/main/java/app/parqueen/AppCheckProviderInstaller.java
- android/app/src/main/java/app/parqueen/PhoneAuthPlugin.java
- capacitor.config.ts
- firebase.ts
- firebaseConfig.ts
- firestore.rules.finder-notice.31ag.test.ts
- firestore.rules.test.candidate-aware.ts
- firestore.rules.test.original-suite.ts
- firestore.rules.test.ts
- functions/curbIntelligence/canonicalCurbIdentity.js
- functions/curbIntelligence/canonicalCurbIdentityProof.js
- functions/curbIntelligence/canonicalCurbOrchestrator.js
- functions/curbIntelligence/canonicalCurbOrchestrator.test.js
- functions/curbIntelligence/canonicalCurbPersistence.js
- functions/curbIntelligence/canonicalCurbResolver.js
- functions/curbIntelligence/canonicalCurbResolver.test.js
- functions/curbIntelligence/canonicalDotLookup.js
- functions/curbIntelligence/canonicalRuleSources.js
- functions/curbIntelligence/csclSocrataAdapter.js
- functions/curbIntelligence/csclSocrataAdapter.test.js
- functions/curbIntelligence/officialLionPrimaryTopology.js
- functions/curbIntelligence/officialLionPrimaryTopology.test.js
- functions/curbIntelligence/ruleConflictPolicy.js
- functions/curbIntelligence/ruleConflictPolicy.test.js
- functions/curbIntelligence/runtimeSourceArtifact.js
- functions/curbIntelligence/runtimeSourceArtifact.test.js
- functions/curbIntelligence/sideConfirmation.js
- functions/curbIntelligence/sideConfirmation.test.js
- functions/index.js
- i18n/en.ts
- i18n/es.ts
- index.css
- package.json
- utils/appCheck.ts
- utils/canonicalCurbClient.test.ts
- utils/canonicalCurbClient.ts
- utils/demoFirebase.test.ts
- utils/demoFirebase.ts
- utils/demoFirebaseAppCheck.ts
- utils/geolocation.test.ts
- utils/geolocation.ts
- utils/locationBurst.test.ts
- utils/locationBurst.ts
- utils/notificationPlatform.ts
- utils/phoneAuthPlatform.ts
- utils/savedSpot.ts
- utils/streetIntelRelease.test.ts
- views/StreetParkingView.tsx
- views/street-parking/CurbSideCrossSection.layout.test.tsx
- views/street-parking/CurbSideCrossSection.test.tsx
- views/street-parking/CurbSideCrossSection.tsx
- views/street-parking/StreetIntelligenceCard.test.tsx
- views/street-parking/StreetIntelligenceCard.tsx
- views/street-parking/StreetParkingView.streetIntel.test.tsx

## Untracked source, tests, and this manifest

- PARQUEEN_SI_RC02.md
- firestoreRulesEmulator.ts
- android/app/src/debug/AndroidManifest.xml
- android/app/src/debug/res/xml/network_security_config.xml
- functions/curbIntelligence/demoResolutionDiagnostic.js
- functions/curbIntelligence/demoResolutionDiagnostic.test.js
- functions/curbIntelligence/drivingChoice.test.js
- functions/curbIntelligence/lionRelationshipIndex.js
- functions/curbIntelligence/lionRelationshipIndex.test.js
- scripts/android/build-street-intel-qa.mjs
- utils/curbOrientation.ts
- utils/qaCurbFieldTest.test.ts
- utils/qaCurbFieldTest.ts
- views/street-parking/QaCurbFieldTest.test.tsx
- views/street-parking/QaCurbFieldTest.tsx

## Not in this candidate

No `.env.local`, App Token file, production secret, or LION archive or relationship index. Generated `node_modules` junctions and the Capacitor plugin directory are local test/build aids, not source.
