# Onboarding 2.0: integration QA

Branch `feat/onboarding-v2-integration`, based on `origin/main` `47e85fe0a37b8af7233c67a6fd51289f50859148`.
Source of truth: `gateb-freeze-v1.1` (`Documents/ParQueen-Onboarding-Art/GateB/16-baseline-freeze-v1.1`). The rollback freeze is `16-baseline-freeze`.

## Rollback flag

| `VITE_ONBOARDING_V2` | Behaviour |
|---|---|
| unset (default) | **Legacy.** `OnboardingView` carousel; mandatory vehicle step; "of 4" step labels; auto-start map tour. Logout clears everything except the theme. |
| `1` | **Onboarding 2.0.** Lazy `OnboardingV2View`; three intentions; 3-step sign-up; vehicle details offered after the first Ping (D22); no auto tour. Logout also keeps the language and `hasSeenOnboarding` (D13/D14). |

Rollback means rebuilding without the variable. Nothing is written to the server, so there is no data migration either way.

## What was verified (desktop, automated)

- **Unit, behaviour and contract tests** (vitest):
  - intent store: 24 h expiry, single use, account binding, tampered records, storage failure;
  - layout and timeline;
  - view behaviour with fake timers: play, captions at 2.3 s and 6.0 s, choices at 7.7 s, Skip, Replay, Back, Android Back, reduced motion, language, inert panels, live region;
  - Android Back table;
  - EN/ES copy parity;
  - D22 guards;
  - source contracts for routing, rollback, deep-link precedence, logout and deletion, and "leave never publishes".
- **Real browser** (Edge headless, the production component in an isolated harness with no Firebase):
  - **Viewports and states:** 320×568, 360×712, 390×844 and 800×360, each in EN and ES, on arrival and on the choices.
  - **Camera:** the scene camera matches the freeze's recorded `sceneTransform` exactly in 16/16 combinations.
  - **Reachability, normal text:** controls reachable, nothing clipped, Back/EN-ES don't overlap, the Ping stays in view, no tap target under 44 px. 0 issues.
  - **Reachability, 200% text:** 0 issues in 16/16 combinations.
  - **One-tap story:** 8.31 s from tap until all three intentions are fully visible. Median frame 16.7 ms, p95 16.9 ms, no frame over 50 ms. JS heap 4.3 MB.
  - **Layout shift:** 0. The bottom scrim moves with `transform` instead of `top`; the picture is identical.
  - **Reduced motion:** choices appear in under 100 ms, there are no running animations, and choosing is immediate.
  - **Decode:** every art layer decodes in under 1 ms after fetch. The environment SVG is 258 KB raw (about 55 KB gzipped) and is fetched only when onboarding renders.
- **Bundle** (`vite build`, compared with `origin/main`):
  - Flag off: first-paint entry grows by 4.6 KB raw (1.4 KB gzipped).
  - Flag on: the entry is about 19 KB raw (4 KB gzipped) smaller than main, because the legacy carousel leaves the entry.
  - The Onboarding 2.0 chunk is 24.7 KB JS (7.8 KB gzipped) plus 18.5 KB CSS. It contains no map engine.

## Not verified: needs the Galaxy S20

Synthetic tests do not replace device QA. These items need the physical device:
- real frame pacing in Android WebView;
- system font scaling (WebView `textZoom`);
- TalkBack reading order and announcements;
- gesture-nav Back;
- safe areas with the real cut-out;
- phone OTP;
- the map hand-off for each intention.

### Android build: blocked, founder decision needed
- The only applicationId is `app.parqueen`, and there are no flavors. The S20 already has a debug `app.parqueen` (versionName 1.0) with data.
- Installing this branch would **replace** that app. The brief forbids that without explicit consent.
- A side-by-side QA install needs a new applicationId registered in Firebase with its SHA fingerprints. That is a production configuration change, which is out of scope.
- A working build also needs the Mapbox tokens and `google-services.json`. These exist only as local, untracked files in other release worktrees. They were **not** copied, because doing so would wire a test build to production services.

Options for the founder:
- (a) authorize `adb install -r` over the existing debug app, after backing up its data;
- (b) authorize a `qa` product flavor (`app.parqueen.qa`) plus its Firebase registration as a separate, reviewed change;
- (c) test with the web build served locally in Chrome on the S20. This covers the visuals and the story, but not native OTP or Back.

### S20 checklist (once a build is installable)
1. **Fresh install** (or cleared data), language EN:
   - arrival fits;
   - tap the car; the story is readable and smooth;
   - the choices appear by themselves around 8.3 s.
2. **Skip, Replay, the on-screen Back arrow, and the Android Back gesture:**
   - story → arrival;
   - on arrival, the app minimizes.
3. **Choose each intention, then use Back on Create account:**
   - Back returns to the choices;
   - the steps read "Step 1 of 3".
4. **Complete OTP and username:**
   - there is **no vehicle step**;
   - the location prompt appears only when location access is unknown.
5. **On the map:**
   - **Find:** the map only.
   - **Leaving:** the Ping composer opens and **nothing is published** until Confirm.
   - **Exploring:** a "Show me around" chip appears and starts the tour.
6. **Publish a first test Ping in a safe, non-public way** (agree the location first):
   - the car-details card appears once and never blocks;
   - "No thanks" dismisses it.
7. **Kill the app mid-story and reopen:** it starts at arrival.
8. **Sign out:**
   - the onboarding is skipped;
   - the language is kept;
   - the intention is gone.
9. **Open a Ping notification while signed out with a pending intention:** the notification wins.
10. **Repeat 1, 3 and 5 in ES**, at the largest font size, and with Remove animations on.

## Open review items
- **D21:** Spanish copy needs a native-speaker review, including the new `map.vehicle_hint_*` and `map.explore_chip*` strings.
- **D27:** the disclosure "A Ping lets you know a spot may be opening up. Parking isn't guaranteed." needs legal review. The more explicit non-reservation disclosure in the real claim flow is unchanged.
- **Release gates:** this branch does not affect the S7/A5 security NO_GO decisions. Release stays gated on them.
