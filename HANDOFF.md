# ParQueen Engineering Handoff

## Centered-Ping portrait control clearance hotfix — 2026-09-02

- Branch: `fix/centered-ping-control-clearance`; base: `5671d426bb71f632cfc87c9208965205b66198d4`.
- Scope is limited to viewport-anchoring the portrait Car/Locate utility stack above the existing safe-area-aware centered-Ping footprint. No centered-Ping, dock, desktop, backend, notification, credential, legal, dependency, Squarespace, or Parsona behavior changed.
- RED reproduced the deployed defect: the portrait rule lacked `position: fixed` and did not derive its bottom edge from `--mobile-primary-nav-space`.
- GREEN uses `bottom: calc(var(--mobile-primary-nav-space) + 16px)` with safe-area-aware right alignment and a specificity-safe selector; the landscape override uses the same specificity and retains its existing `+ 10px` compact reservation.
- Temporary rendered harness evidence (removed before commit): portrait Locate-to-dock clearance 26px at 320x568, 375x667, and 375x812; Car/Locate gap 10px; equal sizes and horizontal centers; zero dock or expanded-halo overlap. Landscape 568x320 retains 16px clearance with 44px controls. No ancestor established an unintended fixed-position containing block.
- Verification: focused shell/navigation/accessibility 4 files / 33 tests; full client 107 files / 1,579 tests; Firestore Rules 286; TypeScript clean; no-upload build 2,060 modules; zero final `.map`, `sourceMappingURL`, Sentry-token-name, or private-key-marker files; current-tree Gitleaks clean.
- Merge and deployment were not authorized and were not performed. Independent exact-head review and protected PR creation remain the next gates.

## Email-OTP security hardening — 2026-08-03

- Branch: `codex/fix-generate-email-otp-secure-rng`, created from production `main` at `182e0e432029b57800301d454952b64251b5bbc1`; this milestone began at `da1e018c7c941d05e0cdb88d9f05c806350480d9`.
- Root cause: `generateEmailOTP` accepted almost any string containing `@`, generated codes with `Math.random()`, and used inconsistent email identity across rate limiting, storage, delivery, verification, and the private account. Delivery also made a newly stored code usable before SendGrid confirmed success, and verification compared codes normally and consumed the OTP before its account writes were known to succeed.
- The canonical email contract trims and lowercases the full ASCII address, validates practical length/local/domain/label rules, preserves dots and plus tags, and performs no provider-specific rewriting. Generation, HMAC rate-limit identity, OTP records, SendGrid delivery, verification, and the owner-only private account all use it. Verification canonicalizes legacy stored mixed-case addresses for backward compatibility.
- Six-digit codes use Node `crypto.randomInt(100000, 1000000)`. Verification requires exactly six decimal digits and uses equal-length buffers with `crypto.timingSafeEqual`.
- OTP replacement is request-ID guarded: a code remains `pending` until delivery succeeds, failed delivery removes only its matching pending record, and a delayed older request cannot activate or delete a newer code. Provider responses, bodies, addresses, codes, HMACs, and secrets are not logged; provider failures return one generic client error.
- Successful verification atomically deletes the OTP, merges the canonical address into `users/{uid}/private/account`, and updates only public `emailVerified`; any account-write failure rolls the entire transaction back. Legacy records without a status remain verifiable.
- Rate controls retain the 10-per-hour UID bucket, add a 10-per-hour canonical-email HMAC bucket, retain the 60-second per-UID cooldown and 10-per-15-minute verification bucket, and are covered at exact boundaries and under concurrency.
- Read-only production inspection found no Firestore TTL policy on the `rateLimits` collection group. This is non-blocking for enforcement because rate-limit document IDs contain fixed-window keys; enabling TTL later is recommended only for storage cleanup.
- Added a 36-case focused security contract covering validation/canonicalization, secure generation, record privacy, delivery errors, replacement/failure ordering, constant-time comparison behavior, legacy compatibility, atomic rollback, concurrency races, and exact rate limits. Independent re-review approved the final delta with no blocking correctness or security findings.
- Fresh gates: TypeScript passed; unit tests 922/922; Firestore Rules tests 176/176; Functions integration tests 181/181 (including focused email-OTP 36/36); Function syntax passed; production build completed with 1,682 modules. Gitleaks 8.28.0 found zero leaks in the 50.34 MB working tree, 402 commits/52.93 MB in `origin/main`, and 428 commits/53.49 MB across all reachable history. Existing Vite warnings plus the Functions Node 24 host/requested Node 20 and outdated `firebase-functions` warnings remain unchanged.
- No Firebase target, secret version, production data, provider configuration, `main`, Hosting, Rules, or Parsona worktree was changed. After protected integration and explicit deployment authorization, deploy `generateEmailOTP` and `verifyEmailOTP` together; do not roll out only one side of this shared contract.

## Scheduled Ping live-transition fix — 2026-08-03

- Branch: `codex/fix-scheduled-ping-live-transition`, created from production `origin/main` at `1171e2305a55d07024f94c140f4255c240349e83`.
- Root cause: marker rendering compared `reportedAt` to the current clock, but the open card, stack rows, nearby ordering, and activity summary treated persisted `pingMode: 'later'` as a permanent current state. A coarse 30-second map tick repainted markers only; no shared boundary lifecycle updated every consumer. Scheduled creation also used a separate 60-minute TTL despite the normal live TTL being 30 minutes.
- Added one client lifecycle selector for serialized/Firestore timestamps. It derives scheduled/live, claimed/unclaimed, owner/claimant, claim eligibility, and expired state. `pingMode` now remains creation intent/history only.
- Added a boundary clock that wakes exactly at the next `reportedAt` or `expiresAt`, refreshes minute-level countdown copy, reconciles on window focus or visible-document resume, and cancels pending timers on cleanup.
- Markers, stack color/rows, nearby ordering, open-card badge/copy/CTA, owner card, parking-activity counts, expiration filtering, and selected/stack cleanup now consume the shared clock and selector. Unclaimed scheduled Pings become normal live Pings at `reportedAt`; committed/heading claims retain their claimant and handoff state.
- Every creation path now sets `expiresAt = reportedAt + 30 minutes`, including My Car, manual Ping, and post-handoff scheduled Ping creation. Backend cleanup continues to honor the stored `expiresAt`; no Function, Rules, index, notification, or production-data change was required.
- Added 24 focused behavioral/rendered tests for five-minutes/one-second/exact/after boundaries, an actually mounted open-card transition, selected-Ping reschedule cleanup, immediate and overdue Pings, timestamp forms/timezones, multiple boundaries and clients, resume, cleanup, expiration, TTL, owner/third-party CTA safety, committed-claim preservation, and English/Spanish card semantics. React Test Renderer is a test-only dependency for the mounted lifecycle proof.
- Rendered browser evidence kept the same details card open across an eight-second boundary: `SCHEDULED / Soon / Leaving at / Claim for …` changed in place to `LIVE / Free / Leaving now / I'm heading there`; the countdown changed from 30 to 29 minutes. No navigation, refresh, snapshot, or Firestore write occurred. The temporary harness and server log were removed.
- Fresh gates: TypeScript passed; unit tests 922/922; Firestore Rules tests 176/176; Functions integration tests 145/145; Functions syntax check passed; production build completed with 1,682 modules. Existing Vite CJS/esbuild-option, mixed Firestore import, and large-chunk warnings remain. Existing Functions Node 24 host/requested Node 20 and outdated `firebase-functions` warnings remain.
- Gitleaks 8.30.1 found zero leaks across the 50.31 MB working tree, 401 commits in `origin/main`, and all 426 reachable commits.
- Deployment scope after protected integration is Hosting only. Nothing was deployed; `main`, Parsona, Functions, Rules, indexes, notifications, and production data were untouched.

---

## userLocations geohash first-write fix — 2026-08-02

- Branch: `codex/fix-userlocation-lastgeohash-initialization`, created from production `origin/main` at `73dd4db3b2dad8f9a9c7e280a761458727f416ac`.
- Root cause: TM-04 moved the GPS geohash write from `users/{uid}` to `userLocations/{uid}` but retained `updateDoc`, while runtime account creation never creates `userLocations/{uid}`. A new or recreated account therefore reached its first consented GPS callback with no target document, and `updateDoc` failed with `No document to update`. The old dedupe comparison also read the removed root-user `lastGeohash`, allowing repeated attempts.
- The map now delegates to a session-local persister that requires granted tracking, a current Auth UID, and matching rendered-owner UID. It serializes writes, deduplicates an owner/geohash-prefix only after success, and leaves failures retryable.
- The write is one Rules-compatible `setDoc(..., { merge: true })` containing both `lastGeohash` and `lastGeohashUpdatedAt: serverTimestamp()`. No root user field, consent document, global cache, backend, Function, or Rules change was introduced.
- Added eight unit behaviors for first write, synchronous concurrency suppression, prefix dedupe, retry after failure, denied permission, null Auth, owner mismatch/missing owner, and deleted/recreated UID separation.
- Added four Firestore emulator behaviors proving missing-document creation, existing-document merge, concurrent first merges, and separate old/new UID ownership. Existing Rules coverage continues to reject anonymous, wrong-owner, and unexpected-field writes.
- Fresh gates: TypeScript passed; unit tests 898/898; Firestore Rules tests 176/176; Functions integration tests 145/145; production build completed with 1,680 modules; `node --check functions/index.js` passed. Existing Functions Node 24 host/requested Node 20 and outdated `firebase-functions` warnings remain; Vite retains its existing CJS, mixed dynamic/static import, and large-chunk warnings.
- Gitleaks found zero leaks across the completed 50.29 MB working tree, 400 commits in `origin/main`, and all 425 reachable commits.
- No Firebase resource was deployed. `main`, the canonical Rules, backend behavior, notification behavior, and the separate Parsona worktree were not modified.

---

## Phone-auth reCAPTCHA lifecycle fix — 2026-08-02

- Branch: `codex/fix-phone-auth-recaptcha-lifecycle`, created from production `main` at `6fe405690d691843e340717e09866cfaa6510d64`.
- Root cause: phone-auth views nulled verifier refs without calling `clear()`, so React StrictMode mount/cleanup/remount leaked the first verifier; the deletion flow also retained App-level verifier and `ConfirmationResult` state after successful or cancelled reauthentication.
- Added a shared caller-owned, ref-based lifecycle utility. Every flow keeps its own verifier ref and unique container; there is no global verifier singleton.
- All create/replace, failure, successful OTP-send, successful confirmation, cancellation, and unmount paths now clear and null the applicable verifier. Successful and cancelled deletion reauthentication reset all App-level reauthentication state through `clearReauthState()`.
- Synchronous refs prevent duplicate phone-send, resend, OTP-confirmation, and deletion-reauth submissions before React state can render.
- Added localized English and Spanish retry messaging for expired or invalid app verification.
- Behavioral coverage includes clear-before-replace, clear error isolation, missing-container rejection, fresh verifier recreation, flow ownership, success/failure cleanup, App-level deletion cleanup, unique containers, and synchronous duplicate guards.
- Rendered React StrictMode harness evidence: mount/remount produced `created=2, cleared=1, live=1`; a forced failure followed by two simultaneous retries produced `created=3, cleared=2, live=1, attempts=1`. The temporary harness was removed.
- Fresh gates: TypeScript passed; unit tests 890/890; Firestore Rules tests 172/172; Functions integration tests 145/145; production build completed with 1,679 modules. Functions tests retain the existing Node 24 host versus requested Node 20 and outdated `firebase-functions` warnings; Vite retains existing dynamic-import and large-chunk warnings.
- Gitleaks passed with zero findings for the 50.27 MB working directory, 399 commits in `origin/main`, and all 424 reachable commits.
- No Hosting, Functions, Rules, indexes, Storage, or other Firebase resource was deployed. Production `main` was not modified.

---

## Firestore Ping synchronization fix — 2026-07-24

- Root cause: the live `spots` listener queried every unexpired status, but the July 21 private-history Rules allow cross-user reads only for `available` and `interested` Pings. Firestore rejected the entire listener with `Missing or insufficient permissions`.
- Fix branch: `fix/firestore-ping-sync`.
- The listener now uses the Rules-compatible indexed query shape: `status in ['available', 'interested']` plus `expiresAt > now`.
- Own manual Pings remain visible; only the separate My Car-linked Ping suppression remains intentional.
- A focused regression test prevents the production listener from losing its public-status constraint. Existing Rules tests already verify that this query returns public Pings and excludes occupied history.
- Quality gates pass: TypeScript, 672 unit tests, production build (1,673 modules), and 58 Firestore Rules tests.
- No Firebase resource was deployed. Merge and Rules deployment remain separate approved actions.

---

Generated: 2026-07-15

---

## Security checkpoint — 2026-07-23

- Work is isolated on `security/browser-key-remediation`, created from `origin/main`.
- Mapbox requires `VITE_MAPBOX_TOKEN`; no hard-coded fallback or credential logging remains.
- The dormant Google Places garage-discovery path and `VITE_GOOGLE_MAPS_API_KEY` were removed. Mapbox is the only browser mapping provider.
- First-party private parking listings remain intact. Future nearby-garage discovery should use Mapbox POI search or first-party ParQueen listings.
- Vite no longer injects the obsolete generic `API_KEY` into frontend code.
- `.env.example` contains empty placeholders only. `SECURITY.md` documents separate development/production credentials, provider restrictions, and local Gitleaks usage.
- `.github/workflows/secret-scan.yml` runs an immutable-pinned Gitleaks action with read-only repository permissions.
- No provider credential was created, rotated, inspected, or deployed.
- Restricted development and production Mapbox values are present in ignored, untracked `.env.local` and `.env.production.local` files. Their contents were not read, printed, fingerprinted, or copied.
- Merge-readiness gates passed: TypeScript, 671 unit tests, production build (1,673 modules), and 58 Firestore Rules tests.
- The production bundle contains no SendGrid-key pattern, Gemini frontend secret name, Google Maps browser-key dependency, or Google Places endpoint. The old hard-coded Mapbox fallback is absent from source.
- Missing-token behavior was verified with the isolated credential-helper test, without modifying or reading the real environment files.
- A temporary localhost-only DEV harness completed the authentication-free Mapbox smoke pass at `http://localhost:5174` and was removed afterward. Dark/light basemaps, pan/zoom, forward search and result centering, reverse geocoding, walking directions, route rendering, and standard/origin/destination markers all passed.
- Mapbox produced no HTTP 401/403 responses or console errors at the allowed localhost origin, and no credential value appeared in the harness UI or captured console output. The prior `127.0.0.1` failure was caused by Mapbox URL restrictions not supporting IP-address origins.

---

## 1. Project Overview

**ParQueen** is a community-driven street parking app for New York City. Users report when they're leaving a parking spot ("ping"), and nearby drivers get notified so they can claim the spot before it's taken by someone else.

**Product vision:** Replace the experience of circling the block looking for parking with a real-time, neighbor-powered notification system. ParQueen is NOT a social media platform — it's a utility. Every feature should serve the core goal: helping someone find and park in a street spot faster.

**Core user flow:**
1. Driver 1 (finder) is about to leave their parking spot
2. They open ParQueen and tap "Ping Parking"
3. They choose "Leaving Now" (blue pin) or "Leaving Later" (yellow pin with scheduled time)
4. Nearby users within their notification radius receive a push notification
5. Driver 2 sees the pin on the map, taps it, and selects "I'm heading there" with an ETA
6. The pin disappears from all other users' maps (only finder + Driver 2 see it)
7. Navigation starts automatically for Driver 2
8. When Driver 2 arrives within 200ft, they confirm arrival
9. The spot is marked occupied and removed from the map

**Current status:** Functional MVP deployed at https://parkqueen-46475363-ccf36.web.app. Real phone authentication, real push notifications, real-time Firestore sync, content moderation, username system, light/dark theme. Single developer (ParQueen founder) testing in the Bronx, NY.

---

## 2. Current Architecture

### Authentication
- **Firebase Phone Auth** via `signInWithPhoneNumber` + `RecaptchaVerifier` (invisible)
- No email/password auth — passwords have been completely removed from the app
- Phone OTP is the sole auth method
- Test phone numbers configured in Firebase Console for development
- `views/CreateAccountView.tsx` handles phone entry + OTP send
- `views/VerifyPhoneView.tsx` handles OTP verification with auto-submit on 6th digit
- After OTP, the app checks Firestore for existing user → returns them to map, or routes new users to username selection

### Firestore Collections
- `users/{uid}` — user profiles (username, phone, email, avatar, preferences, moderation fields)
- `usernames/{lowercase}` — reverse lookup for username uniqueness (doc ID = lowercase username, value = uid)
- `spots/{spotId}` — active parking pings (lat/lng, status, finder info, interest fields)
- `chats/{chatId}` — conversations (participants array, last message)
- `chats/{chatId}/messages/{msgId}` — individual messages
- `emailVerificationCodes/{uid}` — temporary OTP codes for email verification
- `avatarModeration/{uid}` — Vision SafeSearch results for avatar uploads
- `spotNotifications/{notifId}` — real-time notifications between finder/driver (cancel, delay messages)
- `spotFeedback/{feedbackId}` — post-arrival feedback
- `reports/{reportId}` — user reports (harassment, spam, etc.)
- `moderationLog/{logId}` — server-side moderation audit trail
- `stats/global` — aggregate statistics (totalSpotsPinged)
- `streetSegments/{segId}` — cached street cleaning segments (provider, status, geometry, needsReview)
- `streetSegments/{segId}/streetRules/{ruleId}` — parsed cleaning schedules per segment
- `parseFailures/{docId}` — unrecognized sign texts from Street Intelligence parsing (admin review queue)
- `suspensions/{suspId}` — user suspension records (admin-managed)

### Cloud Functions (functions/index.js)
All deployed to `us-central1`, Node.js 20, Firebase Functions v5 (v2 API):
1. `cleanupExpiredSpotsHourly` — scheduled, deletes expired spots
2. `cleanupExpiredInterests` — scheduled every 1 minute, reverts expired interest reservations to available
3. `incrementTotalSpotsPinged` — Firestore trigger on spot creation
4. `notifyNearbyUsers` — Firestore trigger on spot creation, sends FCM push notifications with distance-based filtering
5. `generateEmailOTP` — callable, sends email verification codes via SendGrid REST API
6. `verifyEmailOTP` — callable, verifies email OTP codes
7. `moderateAvatarUpload` — Storage trigger, runs Google Cloud Vision SafeSearch on avatar uploads
8. `claimUsername` — callable, validates + claims usernames atomically via Firestore transaction

### Notification System
- **Push notifications** via Firebase Cloud Messaging (FCM)
- FCM token saved to user document on auth, refreshed on app load
- `notifyNearbyUsers` Cloud Function fires on spot creation
- Uses geohash prefix (4 chars ≈ 20km) as coarse filter, then computes actual haversine distance
- Each user has a `notificationRadius` preference (0.5/1/2/5 miles, default 1)
- Only notifies if actual distance ≤ user's radius
- Excludes: the finder, users with `notificationsEnabled === false`, users without FCM tokens
- **In-app notifications** via `spotNotifications` Firestore collection with `onSnapshot` listener (for cancel/delay real-time messages between finder and driver)
- **Foreground push** handled by `onMessage` in App.tsx, rendered as a glass-panel toast banner (not a blocking alert)

### Map Architecture
- **Mapbox GL JS** with dark-v11 or light-v11 style based on theme
- Map waits for GPS fix before initializing (no Manhattan flash on load)
- Falls back to NYC_CENTER after 5 seconds if GPS unavailable
- Markers created via `createMarkerElement(scheduled)` — blue for "now", yellow for "later"
- Marker click handler reads fresh data from `itemsRef.current` to avoid stale closures
- Map style is set at initialization based on theme; does not swap dynamically mid-session
- User location shown as a pulsating blue GPS dot

### Geolocation
- Shared `utils/geolocation` abstraction: browser `navigator.geolocation` on Web/PWA (and Capacitor iOS); official `@capacitor/geolocation` on Capacitor Android (foreground only)
- `watchPosition` with high accuracy where the map already watched
- `lastGeohash` (geofire-common) written to user's Firestore document for notification targeting
- `searchCenter` state drives the spot query radius (2 miles from map center)
- `userLocation` state used for distance calculations, arrival confirmation, ETA gating

### State Management
- React useState/useEffect throughout (no Redux, no context providers)
- Custom hooks: `useSpotData`, `useInterestFlow`, `useSearch`, `useUnreadMessages`, `useHoldFlow` (deprecated)
- `selectedItem` in StreetParkingView is the currently selected/viewed spot
- `user` state in App.tsx maintained via `onSnapshot` on the user's Firestore document

### Navigation
- `AppView` enum in `types.ts` with `currentView` state in App.tsx
- No router library — simple switch/case in `renderView()`
- Views: CREATE_ACCOUNT, VERIFY_PHONE, SETUP_PROFILE, MAP, PROFILE, SETTINGS, EDIT_PROFILE, COMPLETE_PROFILE, MESSAGES, NOTIFICATIONS, AI_ASSISTANT, ONBOARDING, and more

### Important Reusable Components
- `BottomSheet.tsx` — shared slide-up sheet with drag handle, drag-to-dismiss (>80px), backdrop tap dismiss. Used by SpotModal, SpotDetailsCard, ETA picker, and feedback prompt.
- `SpotDetailsCard.tsx` — state-driven card showing different UI based on user's relationship to the spot (5 states: available, my_claim, my_ping_available, my_ping_claimed, third_party)
- `SpotModal.tsx` — ping creation/editing (Leaving Now / Leaving Later with TimePicker)

---

## 3. Features Already Implemented

### Parking Flow
- **Ping Parking button** with blue-to-teal gradient, pulsing glow animation, centered text with left-aligned icon
- **Leaving Now** (blue pin) — spot available immediately
- **Leaving Later** (yellow pin) — scheduled departure time, auto-transitions to blue when time arrives
- **Bottom sheet modal** for ping creation with drag-to-dismiss
- **TimePicker** sub-view for selecting departure time (hour/minute/AM-PM)
- **Past-time validation** — cannot select a departure time in the past
- **One active ping per finder** enforced via Firestore query before creation
- **Spot address resolution** via Mapbox reverse geocoding, falls back to user's GPS when no spot selected
- **Edit/Delete** existing pings (finder only)

### Claim/Interest System
- **"I'm heading there"** button with ETA picker (2/5/8/10 min options)
- **Firestore transaction** ensures first-wins when two users race for the same spot
- **One active interest per user** enforced before allowing a new claim
- **Distance/ETA gate** — max 7 minutes estimated driving time (straight-line × 25 km/h city speed)
- **Claimed pings hidden** from all other users' maps (only finder + interested user see it)
- **Auto navigation** starts on claim (route drawn via Mapbox Directions API)
- **Arrival confirmation** — "I've arrived" button enabled within 200ft (60m) of spot
- **Post-arrival feedback** prompt ("Thank the driver", "Spot wasn't available", "Other")
- **Occupied spots** immediately removed from map
- **Cancel by claimer** — reverts spot to available, notifies finder
- **Cancel by finder** — deletes spot entirely, notifies interested user
- **Quick-reply messaging** — finder can send preset messages to interested user ("On my way out", etc.)

### User System
- **Phone authentication** (Firebase signInWithPhoneNumber)
- **Username system** with Cloud Function validation (length, characters, profanity, reserved words, l33tspeak normalization)
- **Real-time username availability check** (debounced 400ms)
- **30-day username change cooldown** (skipped for generated `user_` usernames)
- **"Set up later"** generates temporary username (`user_{timestamp}`)
- **"Complete your profile"** link on Profile screen for users with generated usernames
- **Profile photo upload** with Vision SafeSearch moderation
- **Edit Profile** — username (with full validation), name, DOB, gender

### Email Verification
- **SendGrid-powered** email OTP (Cloud Functions call SendGrid REST API directly)
- **6-digit code** with 10-minute expiry, 60-second rate limit
- **OTP entry UI** in Settings with real-time verification
- **"Verified" / "Unverified"** badge next to email in Settings

### Messaging
- **Chat system** between users (Firestore `chats` collection with `messages` subcollection)
- **Chat ID convention**: `[userId1, userId2].sort().join("_")`
- **Smart replies** via Gemini API
- **Content moderation** — profanity, hate speech, contact info (phone/email/URL/social media) blocked before sending
- **Block user** — removes from conversations, hides their spots from map
- **Report user** — in-app modal with preset reasons, stored with pending status for admin review
- **Delete chat** functionality

### Notifications
- **Push notifications** for nearby spot creation (FCM)
- **Per-user notification radius** (0.5/1/2/5 miles, configurable in Settings)
- **Precise distance filtering** (haversine calculation in Cloud Function)
- **In-app toast** for foreground push messages (glass-panel banner, auto-dismiss 5s)
- **Real-time spot notifications** (cancel, delay) via Firestore onSnapshot

### Settings
- **Dark/Light theme** toggle with CSS custom properties
- **Notifications** toggle (persisted to Firestore)
- **Notification radius** selector (0.5/1/2/5 mi)
- **Share precise location** toggle
- **Email address** management with OTP verification
- **Edit Profile** navigation
- **Log out** / **Delete account**

### Map & UI
- **Map centered on GPS** at load (no Manhattan flash)
- **Loading spinner** while waiting for GPS
- **Light/dark map styles** (Mapbox light-v11 / dark-v11)
- **Pulsating blue GPS dot** for user location
- **Stat pill** showing count of nearby spots (excludes own pings)
- **Nearest spot preview strip** with distance + time ago (excludes own pings)
- **Locate-me button** repositioned above Ping Parking button

### Parking Activity Explorer (Search)
- **Search bar** placeholder "Check parking near..." (was "Search location...")
- **Destination preview** — selecting a geocode result shows a bottom sheet with parking activity stats instead of immediately moving the map
- **Activity stats shown:** active pings count, leaving-later pings count, most recent ping time
- **"Explore [destination] area"** button animates map to the searched location
- **Empty state:** "No parking activity near [destination] right now" with Explore button still available
- **One-shot Firestore query** against `spots` collection filtered by distance (1 mile radius) — NOT a live listener

### Crowns & Titles
- **Crowns** replace the old reputation/streak/tier system — earned by contributing to the community
- **Crown values:** driver gets +1 on successful park, finder gets +2 for helping
- **Awarded server-side** via `awardCrowns` Cloud Function triggered on `spotFeedback` creation with `outcome: 'success'`
- **Title progression:** Newcomer (0) → Trusted Driver (10) → Street Scout (50) → Neighborhood Guide (150) → Parking Expert (400) → Block Captain (750) → Parking Veteran (1500) → Urban Legend (3000)
- **Profile header** shows username → title → crown count (crowns hidden at zero)
- **Title unlock celebration** — toast notification when user earns a new title
- **Title thresholds** defined in `utils/crowns.ts` (client) and `functions/index.js` (server) — must stay in sync

### Parking History
- **Accessible from Profile** → "Parking Space" row navigates to `ActivitiesView`
- **Unified timeline** merging two data sources: `spots` (as finder) and `spotFeedback` (as driver)
- **Status labels:** Parked (success), Unsuccessful (failed), Helped a driver (occupied finder ping), Active, Expired
- **Role indicators:** blue icon for "You pinged", green for "You parked"
- **Pagination:** last 20 items with "Load more" button, client-side cursor
- **Privacy:** spotFeedback reads restricted to creator via Firestore rules
- **No new collections** — queries existing data only (Phase 1 approach)

### Onboarding
- **3-screen value proposition** slides with full-bleed images, gradient overlay, swipe/tap to advance
- **First-launch only** (localStorage flag `hasSeenOnboarding`)
- **"Get Started"** button on final screen

### Street Intelligence

- **Street cleaning schedule lookup** from the "My Car" bottom sheet — user taps "Check street rules" to trigger the pipeline
- **SweepNYC API** queried first for the user's lat/lng (radius 0.1 mi); returns sign texts, ObjectId, side-of-street
- **NYC Open Data fallback** (`nfid-uabd` dataset) if SweepNYC returns no usable data — queries Socrata for ASP signs by street name + borough, with pagination up to 3000 rows
- **Block-face-aware selection** — cross-street context fetched via Overpass; scoring: +3 per matched cross street; requires score ≥ 3, strictly best candidate; ties → `nyc_open_data_ambiguous_block`; never first-group-wins
- **Street name normalization** (`functions/nycOpenDataNormalizer.js`) — `osmNameToDOT()` converts OSM mixed-case names to NYC DOT all-caps format ("East 85th Street" → "EAST 85 STREET"); handles ordinals, abbreviations, directional words
- **Sign parser** (`_parseSweepNYCSign` in CF) — case-insensitive, handles "(SANITATION BROOM SYMBOL)" token, structured day/time extraction, side-of-street context
- **Parking side detection** — `_detectCardinalSide()` uses cross-product of street bearing vs user position; low-confidence prompts side confirmation UX ("Which side of the street is your car on?")
- **GPS accuracy model** — `SavedSpot` records `gpsAccuracy` and `parkingSideConfidence`; high accuracy + strong geometry → auto-confirm side; low accuracy → ask user
- **Segment caching** — writes to `streetSegments/{id}` + `streetRules` subcollection; SweepNYC segments use deterministic `nyc_{objectId}` ID; NYC Open Data segments use block-face keyed ID (`nyc_od_{borough}_{street}_{from}_{to}_{side}`); dedup prevents re-querying
- **Provider trust levels** — `provider: 'sweepnyc'` (confidence 0.95 with OSM geometry), `provider: 'nyc_open_data'` (`needsReview: true`, confidence 0.5), `provider: 'manual_admin'` (admin-seeded, `needsReview: false` only if physically verified)
- **StreetIntelligenceCard** — displays safe-until time, side indicator, needs-review badge, side confirmation prompt; integrated into My Car session sheet
- **Retry/Check Again** — `unavailable` state shows a "Try Again" button; `needs_review` shows "Check Again"; retry triggers a fresh SweepNYC + fallback cycle
- **Try Again for unavailable** — CF returns `success: false, reason: 'no_sweepnyc_data'` and client surfaces the button; `nyc_open_data_ambiguous_block` also shows Check Again
- **Parse failure logging** — unrecognized sign texts logged to `parseFailures` collection for admin review; non-ASP signs pre-filtered by `_isASPSign()` and silently skipped

### Internationalization (i18n)

- **English/Spanish bilingual support** throughout Street Intelligence, notification banners, and settings
- **Language preference** — stored in user Firestore doc (`language: 'en' | 'es'`), persisted across sessions
- **All Street Intelligence copy** i18n-covered: schedule display, side confirmation, unavailable, needs-review, retry CTAs
- **Bilingual push notifications** — claim reminders and nearby-spot alerts sent in user's preferred language
- **`_localizedStrings(lang)`** helper in CF produces bilingual notification bodies for `scheduleCleaningReminders`

### Vehicle Icon Redesign

- **Premium flat 2D style** — all 9 vehicle types redrawn with consistent stroke weight, clean silhouettes, wheel clipping bug fixed
- **Compact type added** — new vehicle type between Sedan and Hatchback; includes i18n labels in English and Spanish
- **`EditVehicleView.tsx`** TYPES array updated with 'compact'; `typeLabels` in all languages updated

### Notification Banners

- **Premium contextual banners** — spot notifications (cancel, delay, claimer messages) now render with variant-specific titles ("Your driver is on the way", "Spot update", etc.)
- **Glass-panel style** with icon variants by notification type
- **Nearby pill** — map pill showing nearby ping count; tapping when count ≥ 2 opens a Nearby Spots bottom sheet listing active pings with distance

### Trust System

- **Server-side trust helpers** — `_incrementTrust`, `_decrementTrust` Cloud Functions update `users/{uid}.trustScore`
- **`updateTrustOnFeedback`** — triggered on `spotFeedback` creation; awards trust to finder on success outcome
- **`updateTrustOnSpotDelete`** — decrements trust when a spot is deleted prematurely (potential no-show signal)
- **Locked fields** — Firestore rules prevent clients from writing `trustScore`, `moderationStatus`, `crowns`, `title` directly

### Light Theme
- **CSS custom properties** for all colors (--color-bg, --color-surface, --color-text, etc.)
- **Theme toggle** in Settings, persisted to localStorage
- **All views** converted to use theme-aware variables

---

## 4. Major Product Decisions

| Decision | Reasoning |
|---|---|
| **No red pings** | Red was previously used for "claimed" status. Removed because the claim system was redesigned — claimed spots now disappear from other users' maps entirely instead of showing as red. |
| **Claimed spots hidden from others** | Showing "Someone is heading there" encouraged racing. Hiding the pin eliminates the race condition — only the finder and interested user see it. |
| **Navigation starts automatically on claim** | The Track button was redundant — if you tapped "I'm heading there", you obviously want navigation. Auto-track eliminates a pointless extra tap. |
| **No separate Login screen** | Login and signup are unified into one phone-entry flow. After OTP verification, the app auto-detects new vs returning users. No "login vs signup" choice for the user. |
| **Usernames replaced real names** | ParQueen is not a social platform. Phone numbers identify accounts; usernames are the public identity. Real names are optional and never required. |
| **Passwords completely removed** | Phone OTP is the sole auth method. No password fields anywhere. Placeholder email/password auth was fully replaced with real Firebase phone auth. |
| **Notification radius separate from map radius** | Map display radius (2 miles) is what you browse. Notification radius (user-selectable) is what interrupts you. Different intents deserve different controls. |
| **Profanity filter uses substring matching with normalization** | L33tspeak substitutions (@ → a, 0 → o, etc.) are normalized before checking. The filter is aggressive because legitimate parking messages rarely contain profanity substrings. |
| **Contact info blocked in messages** | Phone numbers, emails, URLs, social media handles are blocked to prevent scams and keep coordination on-platform. |
| **State-driven SpotDetailsCard** | The card renders different buttons based on the user's relationship to the spot (5 states), not conditional button visibility. This eliminates bugs where wrong buttons appear. |
| **Bottom sheet for all interactions** | Every parking interaction uses the same BottomSheet component for visual consistency. |
| **Finder never sees own spots in counts/notifications** | `spotCount`, `nearestSpot` preview, and push notifications all exclude spots where `finderId === user.id`. |

---

## 5. Current Database Structure

### users/{uid}
```
id: string (Firebase Auth UID)
username: string
fullName: string (optional, often blank)
phone: string (digits only)
email: string (optional)
emailVerified: boolean
avatarUrl: string (Firebase Storage URL)
createdAt: Timestamp
reputationScore: number (default 0)
currentStreak: number (default 0)
tier: string (default 'Newcomer')
lastGeohash: string (geofire geohash, updated by GPS watch)
fcmToken: string (FCM push token)
notificationsEnabled: boolean (default true)
notificationRadius: number (miles, default 1)
sharePreciseLocation: boolean (default true)
moderationStatus: 'active' | 'warned' | 'suspended' | 'banned'
reportCount: number (default 0)
blockedUsers: string[] (array of UIDs)
usernameChangedAt: Timestamp (for 30-day cooldown)
```

### usernames/{lowercase_username}
```
uid: string
claimedAt: Timestamp
```

### spots/{spotId}
```
lat: number
lng: number
type: 'free'
status: 'available' | 'interested' | 'occupied'
finderId: string (UID)
finderName: string (username at time of creation)
pingMode: 'now' | 'later'
reportedAt: Timestamp (departure time — now or scheduled future)
expiresAt: Timestamp (reportedAt + 1 hour)
geohash: string (for notification targeting)
address: string (reverse geocoded, optional)
interestedUserId: string | null
interestedUserName: string | null
etaMinutes: number | null (2/5/8/10)
interestExpiresAt: Timestamp | null (ETA + 3 min grace)
```

### chats/{chatId}
```
id: string ([uid1, uid2].sort().join("_"))
participants: string[] (two UIDs)
participantNames: { [uid]: string }
relatedSpotTitle: string
lastMessage: string
lastMessageTimestamp: Timestamp
lastSenderId: string
```

### chats/{chatId}/messages/{msgId}
```
senderId: string
text: string
timestamp: Timestamp
```

### reports/{reportId}
```
reporterId: string
reportedUserId: string
type: 'behavior' | 'username' | 'message'
reason: string
status: 'pending' | 'reviewed' | 'actioned'
conversationId: string (optional)
createdAt: Timestamp
```

### spotNotifications/{notifId}
```
targetUserId: string
type: 'cancelled' | 'delayed' | 'claimer_cancelled'
message: string
createdAt: Timestamp
```

### spotFeedback/{feedbackId}
```
spotId: string
userId: string
finderId: string
feedback: string
createdAt: Timestamp
```

---

## 5b. Current Data Model (Flexible / Subject to Change)

This section is intentionally NOT a fixed schema.

ParQueen is currently in active experimentation phase, so data structures may evolve.

---

### Observed Collections (Current Implementation)

#### parkingSpots
Represents real-world parking locations shown on the map.

Fields may include:
- lat
- lng
- geohash
- status

#### parkingEvents
Represents driver interaction lifecycle:
- arrival
- success / failure decision
- connection to finder

Used primarily for:
- handoff tracking
- analytics
- system state transitions

#### departurePings
Represents future availability created after successful parking.

These generate yellow map pins and act as supply signals.

Fields may vary as UX evolves.

#### users
User profiles including:
- username
- notificationRadius
- basic stats

#### notifications
Event-driven messages sent to users:
- finder rewards
- parking success updates
- system alerts

### Important Note

These structures are evolving.

Do NOT assume strict schema enforcement when implementing features.

Prefer:
- flexibility
- minimal coupling
- iteration speed over rigidity

---

## 6. Cloud Functions (Detail)

### cleanupExpiredSpotsHourly
- **Purpose:** Delete spots past their expiration time
- **Trigger:** Scheduled every 1 hour
- **Logic:** Query spots where `expiresAt <= now`, batch delete up to 500 at a time

### cleanupExpiredInterests
- **Purpose:** Revert expired interest reservations back to available
- **Trigger:** Scheduled every 1 minute
- **Logic:** Query spots where `status == 'interested'` AND `interestExpiresAt <= now`, batch update to clear interest fields and set status to 'available'

### incrementTotalSpotsPinged
- **Purpose:** Track total spots pinged (all-time counter)
- **Trigger:** `onDocumentCreated` on `spots/{spotId}`
- **Logic:** Increment `stats/global.totalSpotsPinged` by 1

### notifyNearbyUsers
- **Purpose:** Send push notifications to nearby users when a new spot is created
- **Trigger:** `onDocumentCreated` on `spots/{spotId}`
- **Logic:**
  1. Get spot's geohash, take 4-char prefix (~20km coarse filter)
  2. Query users by geohash range
  3. For each candidate: skip finder, skip no-FCM, skip notifications-disabled
  4. Decode user's `lastGeohash` to lat/lng via geofire
  5. Compute haversine distance in miles
  6. Compare against user's `notificationRadius` (default 1 mile)
  7. Send FCM with distance in the body text

### generateEmailOTP
- **Purpose:** Send email verification code via SendGrid
- **Trigger:** Callable (onCall)
- **Logic:** Generate 6-digit code, store in `emailVerificationCodes/{uid}` with 10-min expiry, call SendGrid REST API, rate limit 1 per 60 seconds
- **Dependencies:** SENDGRID_API_KEY environment variable

### verifyEmailOTP
- **Purpose:** Verify email OTP and mark email as verified
- **Trigger:** Callable (onCall)
- **Logic:** Check code matches + not expired, update user doc with `emailVerified: true`, delete used code

### moderateAvatarUpload
- **Purpose:** Check uploaded profile photos for inappropriate content
- **Trigger:** `onObjectFinalized` on Storage (avatars/ path)
- **Logic:** Call Google Cloud Vision SafeSearch, reject if adult/racy is LIKELY or VERY_LIKELY, write result to `avatarModeration/{uid}`
- **Dependencies:** @google-cloud/vision npm package

### claimUsername
- **Purpose:** Validate and atomically claim a username
- **Trigger:** Callable (onCall)
- **Logic:** Validate length/chars/profanity/reserved, Firestore transaction to check uniqueness + claim, enforce 30-day cooldown (skip for `user_` prefixed names)

### awardCrowns
- **Purpose:** Award crowns to finder and driver on successful parking handoff
- **Trigger:** `onDocumentCreated` on `spotFeedback/{feedbackId}`
- **Logic:** If `outcome == 'success'`, driver +1 crown, finder +2 crowns. Checks title thresholds, writes `titleUnlockedAt` if new title earned. Uses same thresholds as `utils/crowns.ts` (must stay in sync).

### updateTrustOnFeedback
- **Purpose:** Increment finder trust score on successful handoff
- **Trigger:** `onDocumentCreated` on `spotFeedback/{feedbackId}`
- **Logic:** `outcome == 'success'` → increment `trustScore` for finder by 1 via `_incrementTrust` helper

### updateTrustOnSpotDelete
- **Purpose:** Decrement finder trust when spot deleted prematurely (possible no-show)
- **Trigger:** `onDocumentDeleted` on `spots/{spotId}`
- **Logic:** If spot was in `'interested'` status at deletion → decrement finder's `trustScore` via `_decrementTrust`

### createSegmentFromSweepNYC
- **Purpose:** Server-controlled lazy cache population for Street Intelligence. Owns full pipeline: SweepNYC → parse → optional NYC Open Data fallback → geometry → write segment + rules.
- **Trigger:** Callable (onCall), authenticated users only
- **Logic:**
  1. Validate lat/lng in NYC bounds
  2. Call `_tryCreateFromSweepNYC(lat, lng)` — queries SweepNYC API, deduplicates by `cslSegmentId`/doc ID, parses sign texts, fetches OSM geometry, writes `streetSegments/{nyc_{objectId}}` + `streetRules/sweepnyc_v1`
  3. If SweepNYC reason is in `_SWEEPNYC_FALLBACK_REASONS` (`no_sweepnyc_data`, `no_sweepnyc_notes`, `no_signs`, `parse_failed`), call `_fallbackToNYCOpenData(lat, lng)`
  4. Fallback: Nominatim reverse geocode → DOT name normalization → Socrata query (paginated 3×1000) → cross-street detection (Overpass) → `selectBlockFace` scoring → deterministic doc ID → write with `needsReview: true`
- **Returns:** `{ success, segmentId, parkingSide, streetName, _diag }`
- **Dependencies:** `nycOpenDataNormalizer.js`, optional `SOCRATA_APP_TOKEN` env var

### processScheduledClaims / scheduleCleaningReminders
- **Purpose:** Scheduled reminder pipeline for claim deadlines and street cleaning windows
- **Trigger:** Scheduled (cron)
- **Logic:** Queries active claims nearing expiry or cleaning windows; sends bilingual FCM push notifications via `_localizedStrings(lang)` helper

### adminAddSegment / adminUpdateSegmentStatus / adminAddCleaningRule / adminSupersedeRule
- **Purpose:** Admin-only segment and rule management for Street Intelligence
- **Trigger:** Callable (onCall), admin custom claim required
- **Logic:** Write/update `streetSegments` and `streetRules` documents with `provider: 'manual_admin'`; `needsReview: false` only for physically verified records

### adminSuspendUser / adminUnsuspendUser / adminAddSuspension / adminArchiveSuspension
- **Purpose:** User suspension management
- **Trigger:** Callable (onCall), admin custom claim required

### adminResolveParseFailure / adminReopenParseFailure
- **Purpose:** Manage `parseFailures` collection — unrecognized sign texts logged during Street Intelligence parsing
- **Trigger:** Callable (onCall), admin/staff role required

### setStaffRole
- **Purpose:** Grant or revoke staff custom claim on a user
- **Trigger:** Callable (onCall), admin custom claim required

### deleteAccount
- **Purpose:** Full account deletion — removes user doc, username reservation, FCM token, and queues Storage cleanup
- **Trigger:** Callable (onCall), owner only

### cleanupExpiredHolds
- **Purpose:** Release any expired claim holds not caught by `cleanupExpiredInterests`
- **Trigger:** Scheduled

---

## 7. Firestore Security Rules

All rules require `signedIn()` (i.e., `request.auth != null`) unless noted. An `isAdmin()` helper checks `request.auth.token.admin == true` (custom claim).

| Collection | Read | Write | Notes |
|---|---|---|---|
| `users/{userId}` | Any signed-in user | Owner only (`auth.uid == userId`) | Users can read each other's profiles (for chat, spot details) |
| `spots/{spotId}` | Any signed-in user | Create: owner (`finderId == auth.uid`). Delete: owner. Update: any signed-in user. | Update is open so the claimer can set interest fields |
| `usernames/{id}` | Any signed-in user | Server only (`allow write: if false`) | Claimed via `claimUsername` Cloud Function |
| `chats/{chatId}` + `messages` | Any signed-in user | Any signed-in user | No participant check — relies on client-side filtering |
| `reports/{reportId}` | Admin only | Create: any signed-in user. Update: admin only. | Users submit reports; admins review |
| `moderationLog/{logId}` | Server only | Server only | Audit trail, no client access |
| `emailVerificationCodes/{uid}` | Server only | Server only | Managed by Cloud Functions |
| `avatarModeration/{userId}` | Owner only | Server only | Vision SafeSearch results |
| `spotNotifications/{notifId}` | Any signed-in user | Create/delete: any signed-in user | Real-time cancel/delay messages |
| `spotFeedback/{feedbackId}` | Nobody | Create: any signed-in user | Write-only from client |
| `stats/{docId}` | Admin only | Server only | Aggregate counters |
| `listings/{listingId}` | Public (no auth) | Any signed-in user | Legacy garage rental collection |

**Security notes:**
- `spots` update is broadly permissive — any authenticated user can update any spot. This is intentional for the claim flow but means a malicious user could modify someone else's spot fields.
- `chats` has no participant-level restriction — any signed-in user could theoretically read/write any chat if they know the chat ID. The sorted-UID chat ID convention provides obscurity, not security.
- `spotNotifications` has no target-user restriction — any signed-in user can create/delete any notification doc.

---

## 8. Inactive & Placeholder Views

Several `AppView` enum values and their views exist in the codebase but are **not part of the active product flow**:

| View | File | Status |
|---|---|---|
| `AI_ASSISTANT` | `views/AssistantView.tsx` | Routed in App.tsx, accessible via nav. Calls `analyzeSign` Firebase Cloud Function for parking sign analysis. No client-side API key required. |
| `GARAGE_LIST` | `views/GarageRentalView.tsx` | Routed. Legacy garage rental feature with un-converted dark-mode classes. Hidden from main nav. |
| `HOST_DASHBOARD` | `views/HostDashboardView.tsx` | Routed. Companion to garage rentals. Not actively used. |
| `ADMIN_DASHBOARD` | `views/AdminDashboardView.tsx` | Routed. Only shown when `isAdmin` custom claim is true. No admin users currently exist. |
| `PARKING_SPACE` | `views/ActivitiesView.tsx` | Routed. Accessible from Profile. Parking history/activity — exists but no data feeds it yet. |
| `SPLASH` | `views/SplashView.tsx` | **Dead code** — not imported or referenced. Should be deleted. |
| N/A | `views/LoginView.tsx` | **Dead code** — not imported or referenced. Should be deleted. |

### Gemini AI Usage
- **Smart replies in chat** (`services/geminiService.ts`) — calls `generateSmartReplies` Firebase Cloud Function when the last message in a conversation is from the other user. Used in `MessagesView.tsx`. No client-side API key.
- **Parking sign analysis** (`AssistantView.tsx`) — calls `analyzeSign` Firebase Cloud Function. Supports image + text input via `gemini-3.5-flash`.
- **Listing description** (`views/HostDashboardView.tsx`) — calls `generateListingDescription` Cloud Function. Backend-deployed, UI surface is the host dashboard.
- Gemini API key is stored in Firebase Secret Manager (version 3). The frontend uses `httpsCallable` only — no SDK, no key in the browser bundle.
- Model: `gemini-3.5-flash` (centralized in `functions/index.js` as `GEMINI_MODEL`).

---

## 9. Development Setup

### Prerequisites
- Node.js 20+ (required by Cloud Functions)
- npm
- Firebase CLI (`npm install -g firebase-tools`)
- A Firebase project with Phone Auth, Firestore, Cloud Functions, Cloud Storage, and Cloud Messaging enabled

### Initial Setup
```bash
# Clone and install
git clone <repo-url>
cd ParkQueen
npm install
cd functions && npm install && cd ..

# Firebase login and project selection
firebase login
firebase use parkqueen-46475363-ccf36
```

### Environment Variables
| Variable | Location | Purpose |
|---|---|---|
| `SENDGRID_API_KEY` | Firebase Secret Manager (`defineSecret`) | Email OTP delivery via SendGrid REST API |
| `EMAIL_RATE_LIMIT_PEPPER` | Firebase Secret Manager (`defineSecret`) | HMAC pepper for per-inbox OTP rate-limit keys |
| `GEMINI_API_KEY` | Firebase Secret Manager (`defineSecret`) | Gemini AI — accessed server-side only via Cloud Functions; not present in frontend |
| `SOCRATA_APP_TOKEN` | Not configured (`process.env`, unset) | NYC Open Data app token. Optional: `functions/index.js` falls back to unauthenticated access, rate-limited to 1000 req/day, and logs a warning |
| `VITE_MAPBOX_TOKEN` | Root `.env.local` for development; approved production environment for releases | Map rendering, geocoding, and directions |
| `VITE_FIREBASE_APPCHECK_SITE_KEY`, `VITE_SENTRY_DSN`, `VITE_FIREBASE_VAPID_KEY` | Root `.env.production.local` (build time) | App Check, Sentry, and FCM push. Absent at build time means the corresponding feature is silently compiled out — see `firebaseConfig.ts` |

There is **no `functions/.env`**, and one should not be created. Every Cloud Functions
secret is declared with `defineSecret(...)` in `functions/index.js` and resolved from
Firebase Secret Manager at deploy time; the function is redeployed to bind a new
version. To add or rotate one:

```bash
firebase functions:secrets:set SENDGRID_API_KEY --project parkqueen-46475363-ccf36
```

### Local Development
```bash
npm run dev          # Vite dev server (localhost:5173)
```
This connects to the **production** Firebase project (Firestore, Auth, Functions). There are no emulator configurations in use.

### Build & Deploy
```bash
# Build frontend
npm run build                    # outputs to dist/

# Deploy everything (hosting + functions + firestore rules)
firebase deploy --project parkqueen-46475363-ccf36

# Deploy only hosting
firebase deploy --only hosting --project parkqueen-46475363-ccf36

# Deploy only functions
firebase deploy --only functions --project parkqueen-46475363-ccf36

# Deploy only firestore rules
firebase deploy --only firestore:rules --project parkqueen-46475363-ccf36
```

The deployed app is at: https://parkqueen-46475363-ccf36.web.app

### Firebase Project Alias
`.firebaserc` maps the alias `"ParQueen App"` to project `parkqueen-46475363-ccf36`. Using `--project` explicitly is recommended over the alias.

---

## 10. Known Issues

### High Priority
- **`useHoldFlow.ts` still exists on disk** — deprecated, no longer imported anywhere. Should be deleted.
- **`LoginView.tsx` and `SplashView.tsx` still exist on disk** — not imported or referenced. Should be deleted (see Section 8).

### Medium Priority
- **Map style doesn't swap dynamically when theme changes** — style is set at map initialization. Toggling theme while on the map screen doesn't change the Mapbox style until the next app load. Would need `map.setStyle()` + re-add custom layers.
- **Scunthorpe problem** — the profanity substring filter may false-positive on legitimate names containing profanity substrings (e.g., "Dickens", "Hancock"). No allowlist exists yet.
- **GarageRentalView has un-converted dark-mode classes** — this view is disabled/hidden but still has `bg-dark-900` etc. classes that aren't theme-aware. Not visible to users.
- **`chats` security rules too permissive** — any authenticated user can read/write any chat. Should add participant-level checks (see Section 7).

### Street Intelligence Known Gaps
- **NYC Open Data ambiguous block** — on long avenues (Broadway, Grand Concourse) where multiple block faces are returned and cross-street scoring doesn't resolve a winner, the fallback returns `nyc_open_data_ambiguous_block`. UI shows unavailable/Check Again. Cross-street context from Overpass helps but doesn't guarantee resolution.
- **`segmentId` retry** — when My Car sheet opens before the `createSegmentFromSweepNYC` call completes, `segmentId` can be null. No retry is implemented yet.
- **Client archived segment filtering** — `matchNearestSegment` does not yet filter out archived candidates before calling the CF.
- **SOCRATA_APP_TOKEN not set in production** — fallback works unauthenticated but is rate-limited to 1000 req/day. Set it via Firebase Secret Manager (and read it through `defineSecret`/`defineString` rather than bare `process.env`) before scaling.
- **Block-face selection Phase 1.2 ceiling** — partial cross-street match (score 3–5) selected only when that candidate is uniquely best. Cross-street data comes from Overpass within 130m; this may miss cross streets at wide intersections.

### Low Priority
- **`package-lock.json` has been modified but never committed** — shows up in every `git status`. Harmless but noisy.
- **Vite CJS deprecation warning** on every build — cosmetic, doesn't affect functionality.

---

## 11. Future Roadmap

### Street Intelligence — Next Phases
- **Phase 1.3 (cross-street scoring improvement)** — use Nominatim's `/search` endpoint or street intersection queries for more reliable cross-street names on wide avenues
- **Phase 2 (admin review UI)** — admin dashboard view for `parseFailures` and `needsReview` segments; one-click promote/archive/correct
- **Phase 3 (community verification)** — let users confirm/deny a cached schedule; increment `communityConfirmations`; graduate to `needsReview: false` after threshold

### Discussed and Designed (specs exist)
- **Notification debouncing** — skip if user was notified within last 60 seconds (prevents spam from rapid nearby pings)
- **Search Phase 2** — add parking success rate (from handoff outcome data) and activity level label to destination preview
- **Search Phase 3** — "Notify me when someone pings near [destination]" (location subscriptions), historical trends, busy times, frequently searched locations

### Discussed but Not Designed
- **User profiles** — public profile pages viewable by other users
- **Premium features** — potential monetization (priority notifications, extended radius, etc.)
- **Username change UI in Settings** — currently only available via Edit Profile
- **Non-English profanity expansion** — current filter covers English + Spanish, needs broader coverage for NYC's multilingual population
- **AI-based content moderation** — Google Perspective API or similar for context-aware harassment detection beyond keyword matching

### Not Yet Discussed
- **Favorites/saved locations** — save frequently parked areas
- **Scheduled notifications** — "notify me when a spot opens near home after 6 PM"
- **Paid parking/meter integration**

---

## 12. Technical Debt

- **StreetParkingView.tsx is ~700+ lines** — the largest file, handles map init, geolocation, spot creation, marker rendering, address resolution, and UI overlays. Would benefit from extracting more into hooks (map init, address resolution).
- **Duplicate profanity/moderation lists** — the banned word list exists in both `functions/index.js` (server) and `utils/moderation.ts` (client). They should stay in sync but are maintained separately.
- **`handleSaveSpot` in StreetParkingView has 3 nearly identical `addDoc` call sites** — the new-spot creation logic is duplicated for "has userLocation", "needs getCurrentPosition", and "editing existing spot" paths.
- **`radiusFilteredItems` useMemo doesn't include `blockedUsers` in its dependency array** — blocked user filtering happens at the snapshot level, not the memo level, so it works, but the architecture is fragile.
- **The `firebase/` importmap in index.html is gone** — it was removed when CSP moved to enforcement, because it was the app's only inline script. It resolved nothing (Vite bundles every dependency), so the historical version-mismatch class of bug is no longer reachable from it.
- **Several views still import from `../firebase` while others import from `../firebaseConfig`** — these are two different files (`firebase.ts` re-exports `db`, `firebaseConfig.ts` exports `auth`, `db`, `getFCM`). Should be consolidated.

---

## 13. Development Principles

1. **Discuss UX before implementation.** Every major feature started with a product discussion where assumptions were challenged. Don't skip this step.
2. **Fix root causes, not symptoms.** When three bugs share one root cause (e.g., the Manhattan flash / false empty state / self-notification all traced to `searchCenter` initializing from NYC_CENTER), fix the underlying problem once.
3. **State-driven UI over conditional rendering.** The SpotDetailsCard uses 5 named states (available, my_claim, my_ping_available, my_ping_claimed, third_party) rather than a web of `if/else` button visibility checks.
4. **Ponytail mode (laziest working solution).** The codebase follows the "ponytail" plugin philosophy: stdlib before libraries, one line before fifty, no premature abstractions. The shortest working diff wins.
5. **No unrequested features.** Don't add settings, toggles, or options that weren't asked for. Ship the minimal version, let the user request more.
6. **Deploy after every feature.** Every commit is deployed to Firebase Hosting immediately. The user tests on the live deployed app, not localhost.
7. **Branch per feature, merge to main, delete branch.** Clean git history with descriptive commit messages.
8. **Product decisions are documented in conversation, not just code.** The "why" behind design choices matters as much as the implementation.

---

## 14. Important Files

| File | Responsibility |
|---|---|
| `App.tsx` | Root component, auth state management, view routing, push notification toast |
| `types.ts` | AppView enum, StreetSpot interface |
| `database.ts` | `saveUserProfile`, `logoutUser`, `updateUser`, `deleteUser` |
| `firebaseConfig.ts` | Firebase app init, auth, db, FCM exports |
| `index.html` | Document shell and one inline `<style>` block. Tailwind is compiled at build time (`tailwind.config.js` + `postcss.config.js`); the esm.sh importmap has been removed |
| `index.css` | CSS custom properties (light/dark theme), glass effects, ping-glow animation |
| `utils/crowns.ts` | Title thresholds and lookup functions (getTitleForCrowns, getNextTitle) — must stay in sync with CF |
| `utils/sweepnyc.ts` | Client-side SweepNYC sign parser (simpler than CF version; no streetCtx, strict regex) |
| `utils/streetIntelligence.ts` | `parseSweepNYCSign`, `computeSafeUntil`, `detectParkingSide`, `detectCardinalSide`, backfill utilities |
| `utils/streetIntelligence.test.ts` | Vitest tests for street intelligence client utilities |
| `utils/moderation.ts` | Shared banned word list, normalization, contact info patterns, `moderateUsername()`, `moderateMessage()` |
| `functions/index.js` | All Cloud Functions (~2500 lines; SweepNYC pipeline, NYC Open Data fallback, trust, admin, crowns, notifications) |
| `functions/nycOpenDataNormalizer.js` | Street name normalization (`osmNameToDOT`, `streetNameToLikePattern`, `selectBlockFace`, `nycOdSegmentDocId`) |
| `functions/nycOpenDataNormalizer.test.js` | 103 unit tests for normalizer + block-face selection |
| Firebase Secret Manager | SENDGRID_API_KEY, EMAIL_RATE_LIMIT_PEPPER, GEMINI_API_KEY — bound via `defineSecret` at deploy time (see Section 9) |
| `firestore.rules` | Security rules for all collections (see Section 7) |
| `services/geminiService.ts` | Client-side Gemini AI for smart replies + sign analysis |
| `.firebaserc` | Firebase project alias mapping |
| **Views:** | |
| `views/StreetParkingView.tsx` | Main map screen — map init, GPS, markers, spot creation, overlays |
| `views/street-parking/SpotDetailsCard.tsx` | State-driven spot interaction card (inside BottomSheet) |
| `views/street-parking/SpotModal.tsx` | Ping creation/editing (inside BottomSheet) |
| `views/street-parking/BottomSheet.tsx` | Shared slide-up sheet component |
| `views/street-parking/useInterestFlow.ts` | Claim/interest flow logic (express interest, cancel, arrive, feedback) |
| `views/street-parking/useSpotData.ts` | Firestore spot listener, radius filtering, blocked user filtering |
| `views/street-parking/utils.ts` | `createMarkerElement`, `getDistance`, `drawRoute`, `clearRoute` |
| `views/street-parking/ParkingActivitySheet.tsx` | Destination parking activity preview (search result bottom sheet) |
| `views/street-parking/TimePicker.tsx` | Hour/minute/AM-PM picker for scheduled departure |
| `views/ProfileView.tsx` | Profile screen (avatar, stats, navigation) |
| `views/SettingsView.tsx` | Settings (toggles, email, notification radius, danger zone) |
| `views/EditProfileView.tsx` | Username + name + DOB + gender editing |
| `views/MessagesView.tsx` | Chat system with moderation, block, report |
| `views/OnboardingView.tsx` | 3-screen first-launch onboarding |
| `views/CreateAccountView.tsx` | Phone entry + RecaptchaVerifier |
| `views/VerifyPhoneView.tsx` | OTP verification with auto-submit |
| `views/NameEntryView.tsx` | Username selection during signup |

---

## 15. Next Recommended Tasks

### Street Intelligence (immediate)
1. **`segmentId` retry** — when My Car sheet opens before `createSegmentFromSweepNYC` completes, `segmentId` is null. Add a retry/poll after 1–2 seconds.
2. **Client archived segment filtering** — `matchNearestSegment` should filter out `status: 'archived'` candidates before calling the CF.
3. **Add `SOCRATA_APP_TOKEN`** via Firebase Secret Manager to raise the NYC Open Data rate limit above 1000 req/day before field testing at scale.
4. **Admin parse failure review** — build a simple admin UI card for the `parseFailures` collection so unrecognized signs can be triaged.

### General
5. **Delete dead files** — `useHoldFlow.ts`, `LoginView.tsx`, `SplashView.tsx` are unused. Clean them up.
6. **Test two-user flow end-to-end** — deployed app with two browser sessions (one incognito) to test the full claim/cancel/arrive cycle.
7. **Notification debouncing** — implement the 60-second skip to prevent rapid notification spam.
8. **Dynamic map theme switching** — call `map.setStyle()` when theme changes so the map matches without requiring a full reload.
9. **Profanity filter allowlist** — explicit allowlist for false positives (legitimate names containing profanity substrings).

---

## 16. Advice for the Next Claude Code Session

### Deployment Pattern
The user expects `commit → merge to main → push → build → deploy` as one atomic operation. See Section 9 for full build/deploy commands. Always use `--project parkqueen-46475363-ccf36`.

### Firebase SDK Version
Firebase resolves to a single version from `package-lock.json` (currently **10.14.1**), because Vite bundles it — there is no importmap to keep in sync any more. Historically the importmap could pin a different major than the installed package, and that mismatch caused a critical phone-auth bug ("operation-not-allowed") that took significant debugging to find. `public/firebase-messaging-sw.js` is the one place still pinning a version by hand, and `utils/pwaInstall.test.ts` asserts it matches the installed SDK.

### The User's Working Style
- Prefers product/UX discussion before implementation ("I don't want to implement anything yet")
- Expects you to challenge assumptions and suggest alternatives
- Tests on the live deployed app (not just localhost)
- Wants features committed, merged to main, and deployed immediately after testing
- References specific line numbers and console errors when reporting bugs
- Prefers one branch per feature, deleted after merge

### Common Gotchas
- **Firestore Timestamp serialization** — `selectedItem` objects may have Timestamps that lose their `.toMillis()` method after passing through React state/refs. Always handle both `toMillis()` and `{seconds, nanoseconds}` forms.
- **Marker click closures** — markers capture `item` at creation time. Use `itemsRef.current` (a ref holding latest `radiusFilteredItems`) to read fresh data on click.
- **`onCall` Cloud Functions need public IAM** — v2 `onCall` functions require the Cloud Run service to allow unauthenticated invocations. The user has Cloud Functions Admin role but deployment may still fail on IAM if the role was revoked.
- **The `useEffect` sync for `selectedItem`** clears the selection when a spot disappears from data (occupied/expired/deleted), but skips clearing if `interestFlow.showFeedback` is true (so the feedback prompt retains the spot reference).
- **Firebase Secret Manager** — see Section 9. `SENDGRID_API_KEY` and `EMAIL_RATE_LIMIT_PEPPER` must be set and bound to `generateEmailOTP` for email OTP to work; there is no `functions/.env`.

### Active Plugins
- **Ponytail** (full mode) — enforces laziest working solution
- **Superpowers** — brainstorming, planning, verification skills
- **Claude-mem** — cross-session memory (observation system)

---

## 17. Ping notification/privacy rollout blocker (2026-08-04)

- Review base: clean `main` and `origin/main` at `260f50b12c791bd0851a1c228fcc49d1fe744b21`.
- Remediation branch: `codex/fix-ping-notification-privacy-idempotency`.
- Production deployment was stopped before mutation because current source contained material blockers in all three proposed targets:
  - `processScheduledClaims` referenced undefined `userData.lang`, split reminder/release notification writes from state transitions, omitted actor/Ping/claim metadata, and could duplicate notifications after partial failure.
  - `incrementTotalSpotsPinged` used an unguarded increment and could count a repeated Firestore delivery twice.
  - `notifyNearbyUsers` called nonexistent `geofire-common.geohashToLocation` (silently excluding every candidate), had no delivery idempotency/bell record, and could delete a newly replaced FCM token during stale-token cleanup.
- Branch remediation adds deterministic transaction markers, atomic scheduled-claim bell records, complete actor/recipient/Ping/claim metadata, creator/self exclusion, recipient/token deduplication, a local geohash-center decoder, conditional stale-token cleanup, and ten emulator-backed lifecycle contracts.
- Integration review strengthened the identities before PR creation:
  - Firestore create-trigger effects use a bounded SHA-256 key derived from the immutable event ID, so retries collide while a genuine recreation of the same Ping document ID does not.
  - Scheduled effects use the Firestore document update generation plus Ping and recipient identity, preventing a later claim from colliding even when its timeout timestamp is reused.
  - `functionEvents` and `notificationDeliveries` are server-only durable idempotency records. They are intentionally retained indefinitely for this private-beta rollout; a separately reviewed retention job may prune them only after the platform retry window and operational audit window are defined.
- Nearby delivery intentionally provides a durable exactly-once bell plus an at-most-once FCM attempt. States are `reserved`, `sent`, and terminal `failed`; an ambiguous crash/send remains `reserved`, is visible in state/logs, and is not automatically resent. This prevents knowingly duplicated pushes, while acknowledging that provider-level duplicate display remains outside application control.
- Scheduled timeout notifications use `senderId: null`, `actorType: system`, and `subjectUserId` rather than falsely attributing an automatic action to either participant.
- Geohash distance filtering subtracts the decoded cell half-diagonal from center distance, conservatively accounting for location uncertainty at radius boundaries without storing or logging raw coordinates.
- Fresh gates after implementation:
  - `npx.cmd tsc --noEmit`: pass.
  - `npm.cmd test`: 933 passed in 37 files.
  - `npm.cmd run test:rules`: 176 passed.
  - `npm.cmd run test:functions`: 191 passed in 9 files.
  - `node --check functions/index.js`: pass.
  - `npm.cmd run build`: pass; existing large-chunk/dynamic-import warnings only.
  - Gitleaks 8.30.1 directory, `origin/main` history (404 commits), and all history (430 commits): zero findings in every scope.
- No Firebase resource, secret, provider, migration, Hosting target, Rules target, Function, or Parsona file/worktree was changed or deployed. Protected integration review is required before any production rollout.
