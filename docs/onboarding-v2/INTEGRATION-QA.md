# Onboarding 2.0: integration QA

Branch `feat/onboarding-v2-integration`, draft PR #314. Based on `origin/main` `47e85fe`; still merges cleanly with
`origin/main` `399e524`.

**Visual design frozen (founder sign-off, 2026-11-05), at `a6b796b`:**
- the original ParQueen welcome;
- the Revision 3 NYC neighborhood (`env.svg` `ea596281…`, `env-fore.svg` `cc42918c…`);
- the welcome-to-street transition;
- the ~8.3 s story;
- the intention screens.

No further visual redesign unless device testing shows a significant regression.

**Rollback commits:** `77ef7af`, `1ff69cb`, `cadf59f`, `39f6ac0`. The art archives are in
`Documents/ParQueen-Onboarding-Art/GateB/16…21`.

## Build flags

| Flag | Default | Effect |
|---|---|---|
| `VITE_ONBOARDING_V2` | unset → **legacy onboarding** (the rollback) | `1` enables Onboarding 2.0: original welcome → story → three intentions → 3-step sign-up, no vehicle step (offered after the first Ping, D22), no auto map tour. Logout also keeps the language and `hasSeenOnboarding`. |
| `VITE_OBV2_DIAG` | unset → **off** | QA builds only. Logs navigation and lifecycle decisions (view, onboarding return, overlay count, resolved Back action, app lifecycle) to the console and `globalThis.__obv2diag`. Enum values only, never user data. A normal build contains none of this code (verified: 0 bundle files). |

Rollback means rebuilding without `VITE_ONBOARDING_V2`. Nothing is written to the server, so no data migration is needed
either way.

## Verified

**Automated:**
- tsc is clean.
- vitest: all frontend tests pass. Onboarding coverage includes:
  - intent store, layout, timeline, view behaviour, Android Back table, EN/ES parity, D22 guards and diagnostics;
  - lifecycle restart, rapid background cycles and dissolve interruption;
  - source contracts for routing, rollback, deep links, logout and deletion, and "leave never publishes".
- Browser matrix: 320×568, 360×712, 360×726, 390×844 and 800×360, EN/ES, normal and 200% text, reduced motion.
  - The camera matches the freeze.
  - No clipped or unreachable controls.
  - No dark band between the street and the captions.
  - Captions never move.

**On the Galaxy S20** (debug `app.parqueen`, `a6b796b` + `VITE_OBV2_DIAG=1`, APK sha256 `d07c1b0d…`):
- **Welcome:** shown on first launch, without the old carousel dots.
- **Transition:** no welcome-wordmark ghost and no doubled branding. The street header is in place from the first street
  frame (60 fps device recording).
- **Story:** 461–497 ms from tap to story start, then 8.28–8.34 s to the three intentions. Typical frames 16.7 ms; layout
  shift 0 on every run.
- **Background/resume mid-story:** clean restart from the first frame. No duplicated captions, and no caption running
  ahead of the picture. On resume, Android shows the last paused frame for about 250 ms before the restart.
- **Android Back:** 26/26 controlled cycles passed (see OQA-2).
- **Navigation:** Replay, Skip, intention → real Create account ("Step 1 of 3", intention saved), and Spanish all work.

## Open QA items

**OQA-1. First-tap slow frame (known issue, not resolved).**
- **What happens:** one frame of 66–83 ms about 85 ms after Get Started, on 4 of 6 cold starts. It also occurs on warm
  plays. At that moment only the welcome's own content is fading over its dark background; the street is not yet
  visible.
- **Cause (S20 traces):** GPU rasterisation of the welcome content as its fade begins (~30 ms GPU flush).
- **Fixed already (story start, choices reveal):**
  - the street SVG got its own layer;
  - the story layers are pre-rasterised under the welcome;
  - the forced layout was removed.
- **Tried and reverted (worse):**
  - promoting the whole welcome to its own GPU layer;
  - pre-promoting only the welcome's content blocks.
- **Evidence:** `GateB/21-final-device-polish/traces`, `cold-starts`.

**OQA-2. Intermittent Android Back from Create account (under observation).**
- **Seen once:** in 6 manual attempts on `77ef7af`, the app minimized instead of returning to the intentions.
- **Not reproduced:** in 5 further manual attempts, then in 26 controlled cycles on the diagnostics build:
  - system Back ×2;
  - Home and resume on Create account;
  - the header Back arrow;
  - Back 260–440 ms after choosing;
  - the account-link route.
- **What the diagnostics showed every time:** `onboardingReturn: "choose"`, `overlays: 0`, and Back resolving to
  `navigate → onboarding`.
- **No navigation code was changed.**
- **How to capture a repeat:** keep a `VITE_OBV2_DIAG=1` build installed, and on a repeat read the buffer (in a
  `VITE_OBV2_DIAG=1` build only, via Chrome DevTools' `chrome://inspect`):

  ```bash
  adb logcat -d | grep obv2-diag
  ```

  The buffer is `globalThis.__obv2diag`.

## Next phase: authenticated Android QA (not started)

Goal: the full onboarding-to-map experience on the S20 with a real account. Everything below runs against production
Firebase, so no security, IAM, Functions or configuration change is part of it.

### Prerequisites (founder actions or decisions)
1. **App Check debug secret.** The installed debug build is still rejected (`exchangeDebugToken` failures in logcat).
   - Read the secret on the PC (do not paste it into chat or logs):

     ```bash
     adb logcat -d | grep DebugAppCheckProvider
     ```

   - Register it in Firebase console → App Check → Apps → ParQueen Android → Manage debug tokens.
   - The secret survives `adb install -r` updates. It changes after an uninstall or cleared data, so keep updating in
     place.
2. **Test identity.** Choose one:
   - the founder's real number;
   - a dedicated QA SIM.

   Firebase test phone numbers would be an Auth configuration change, which needs separate authorization.
   - OTP entry is done by the founder; the agent never types phone numbers or codes.
   - Screen recording pauses during the phone and OTP screens.
3. **Usernames.** One new account claims one username. To test all three intentions as a *new* user, either:
   - use three numbers or accounts; or
   - test the other two intentions on the returning-user path (choose an intention, then sign in to the existing
     account).
4. **Ping test plan.** "I'm leaving a spot" must open the composer without publishing. Any real publish (for example the
   D22 car-details card after a first Ping) needs a written plan:
   - location;
   - immediate cancel;
   - who might be notified.
5. **Account deletion, account switching, and push-notification precedence:** only with explicit authorization
   (deletion is irreversible).

### Test matrix (in order; record pass/fail with evidence, no personal data in captures)

| # | Scenario | Pass criteria |
|---|---|---|
| A1 | Clear data → welcome → story → **Find parking** → OTP → username | "Step 1/2/3 of 3"; **no vehicle step**; location prompt only when access is unknown |
| A2 | Location: **Allow** | Map loads (Mapbox tiles render, no token errors), centred on the user |
| A3 | Location: **Deny** (repeat with permission revoked) | Map still loads; no crash; the app explains how to enable location |
| A4 | **I'm leaving a spot** (returning-user path or new account) | On the map, the Ping composer opens; **nothing is published** until Confirm; Cancel closes it |
| A5 | **Just exploring** | "Show me around" chip appears; tapping it starts the tour; dismiss works; nothing else auto-opens |
| A6 | App Check | Username claim and map/Ping reads succeed; no App Check errors in logcat |
| A7 | Kill the app mid-story, mid-sign-up and on the map; reopen | Correct resume point; no stale intention applied twice |
| A8 | **Logout** | Next launch skips the welcome (D13), keeps the language (D14), and the pending intention is gone |
| A9 | Sign back in | Lands on the map; no stale intention; profile intact |
| A10 | Android Back on every auth screen (Verify phone → Create account; Create account → intentions) | Matches the Back table; watch for OQA-2 with the diagnostics build |
| A11 | Spanish run of A1/A4/A5 | All copy Spanish; no clipping |
| A12 | Accessibility: TalkBack, largest system font, Remove animations | Readable order; headings announced; reduced-motion path; 200% text usable |

**Exit:** A1–A12 pass, or failures are logged with a cause. Then CI is green, and the PR can be reviewed for merge
(merge only with founder authorization).

## Release requirements (unchanged; all block release)
- **D21:** native-speaker review of all Spanish copy, including `onboarding_v2.*`, `map.explore_chip*` and
  `map.vehicle_hint_*`.
- **D27:** legal review of the disclosure "A Ping lets you know a spot may be opening up. Parking isn't guaranteed."
  The more explicit non-reservation disclosure in the real claim flow is unchanged.
- **Accessibility on the device:** TalkBack, the largest system font and Remove animations (A12).
- **Security gates:** the S7/A5 NO_GO decisions still apply. This branch does not change them.
- **Release mechanics:** no production deployment, store publication or merge to main without founder authorization.
