# Sign Scanner

The Sign Scanner replaced the **Parking Tools** hub (Scan a Parking Sign, Hydrant Distance,
Am I Safe Here?, Recent parking checks). It is a single-purpose screen: photograph a parking
sign, then read ParQueen's interpretation of it. Approved design reference:
`docs/prototypes/sign-scanner/index.html` (Phase 1).

Status: implemented on `feat/sign-scanner-20261123`. Not committed, merged, or deployed.

## Architecture

### Before

```
Map header "Scan" ──► AppView.AI_ASSISTANT ──► views/AssistantView.tsx  (mode: hub | scan | hydrant | check)
                                                ├─ hub: featured Scan card, Hydrant + Am I Safe tiles, Recent (with empty panel)
                                                ├─ scan: idle → preview → analyzing → done (inline)
                                                ├─ views/assistant/HydrantDistanceTool.tsx ── checkHydrantDistance callable
                                                │     └─ utils/hydrantDistance.ts
                                                └─ views/assistant/ParkingCheckTool.tsx ── Firestore street rules + hydrant lookup
                                                      └─ utils/parkingCheck.ts, savedSpot.effectiveParkingSide
Android Back: App → delegateAssistant → resolveAssistantAndroidBack(isOnHub): nested tool → hub, hub → map
Styles: ~550 lines of pq-assist / pq-tool* / pq-tools* / pq-result* / pq-distance* rules in index.css
Copy: 113 assistant.* / hydrant.* / check.* keys per language
```

### After

```
Map header "Scan" ──► AppView.AI_ASSISTANT ──► views/sign-scanner/SignScannerView.tsx  (phase: home | preview | reading | result | error)
                                                ├─ SignScannerArt.tsx            original SVG hero + localized annotation chips
                                                ├─ signScannerPresentation.ts    pure rules: verdicts, timing, reminders, error kind, formatting
                                                ├─ signScanner.css               scoped .pq-scan styles (lazy chunk)
                                                ├─ utils/signScanner.ts          unchanged camera-only capture → base64
                                                ├─ services/geminiService.ts     unchanged analyzeSign call; adds isSignAnalysisUnavailable()
                                                ├─ utils/recentScans.ts          unchanged store; adds restoreRecentScans() for Undo
                                                └─ street-parking/useParkingTimer unchanged reminder timer
Android Back: App → delegateAssistant → resolveSignScannerAndroidBack(isOnScannerHome): any scan phase → scanner home, home → map
Copy: 67 scanner.* keys per language (EN/ES parity enforced by i18n/signScannerParity.test.ts)
```

The route key `AppView.AI_ASSISTANT` and the App-level `delegateAssistant` action keep their names.
Renaming them would touch shared navigation code (`useAndroidSystemBack`, the route enum) for no
behaviour change.

## Flow

| Phase | What the user sees | Primary | Secondary |
|---|---|---|---|
| Home, first visit | Illustration with "Days & hours" / "Time limits" chips, "Know before you park.", tip about stacked signs | **Scan a Sign** (opens the phone camera directly) | — |
| Home, returning | Compact illustration, Recent scans (on this phone, max 5) with Clear + Undo | **Scan a Sign** | Clear |
| Camera returned nothing | Calm inline hint; covers cancel and a blocked camera (detected via window `focus` + 1.2 s grace, and the input's `cancel` event) | **Scan a Sign** | Dismiss |
| Preview | "Is the whole sign readable?" with the photo (object-fit: contain) and two self-checks. No model call yet. | **Read this sign** | Retake |
| Reading | Photo with scan sweep, polite live region, rotating sub-line | — | Cancel (drops the late result) |
| Result | "What the sign appears to say", hedged verdict pill, the model's sentence, timing strip (only for a valid future time), advice + reminder, AI/legal boundary | **Back to map** | Scan another sign |
| Result: CONDITIONAL | Same, plus "may depend on the day or time, or part of the sign may be hard to read" and an optional "Photo unclear? Retake it" | **Back to map** | Scan another sign |
| Error: unreadable | Glare illustration, retake guidance; nothing saved | **Retake photo** | Try this photo again |
| Error: unavailable (outage, quota, 30/h rate limit, thrown call) | "That's on our end, not your photo" | **Try again** (same photo) | Retake photo |

Every non-home phase's back control (and Android system Back) returns to the scanner home.
Home's back control (and Android Back) returns to the map.

### Interpretation boundary

- Verdicts always hedge: "Parking appears allowed / prohibited", "Depends on conditions".
- Every result ends with: **"An AI reading of your photo, not verified legal permission.** It can be
  incomplete or wrong. The posted signs, curb markings, and local rules always apply."
- `CONDITIONAL` is never re-labelled as unreadable, with or without timestamps. The server uses it for
  both time-dependent rules and ambiguous or partly legible signs, and the response does not say which.
- Errors show no AI disclaimer (nothing was interpreted) and are never recorded.
- The service's English error strings are never shown; each error kind has translated copy.

### Reminders

Timing is unchanged (see `docs/SIGN_SCANNER_REMINDER_LEAD_PROPOSAL.md` for the proposed 10-minute
lead). The one shipped change: no reminder is offered when parking appears prohibited. The button
now states its time ("Remind me at 9:55 PM" / "Remind me in 1 hour"). "Reminder set" now reflects
the reminder started from this result, while the timer still exists. Before, it showed for any
running timer, including My Car's.

## Files

### Added

| File | Purpose |
|---|---|
| `views/sign-scanner/SignScannerView.tsx` | The screen: phases, camera handling, focus, Android Back |
| `views/sign-scanner/SignScannerArt.tsx` | Hero illustration, tip glyph, unreadable-error glyph |
| `views/sign-scanner/signScannerPresentation.ts` | Pure presentation rules |
| `views/sign-scanner/signScanner.css` | Scoped styles, light/dark tokens, safe areas, opt-in motion |
| `views/sign-scanner/SignScannerView.test.tsx` | 37 flow tests (home, camera, preview/reading, results, reminders, errors, Android Back, Spanish) |
| `views/sign-scanner/signScannerPresentation.test.ts` | 12 tests incl. reminder timing vs. a verbatim copy of the old code |
| `i18n/signScannerParity.test.ts` | EN/ES parity, no untranslated strings, hedging, no retired tools |
| `utils/recentScans.test.ts` | Store tests ported from the old suite + Undo restore |
| `utils/savedSpot.test.ts` | `readSavedSpot` tests moved verbatim out of the retired `assistantTools.test.ts` |
| `docs/SIGN_SCANNER.md`, `docs/SIGN_SCANNER_REMINDER_LEAD_PROPOSAL.md` | This record and the reminder proposal |
| `docs/previews/sign-scanner/*` | Dev-only preview harness (see below). Excluded from the build and from knip. |

### Modified

| File | Change |
|---|---|
| `App.tsx` | Route renders `SignScannerView`; Android Back ref renamed; `onOpenMyCar` wiring dropped (only the retired tools used it) |
| `utils/androidBackNavigation.ts` | `resolveAssistantAndroidBack` → `resolveSignScannerAndroidBack` |
| `services/geminiService.ts` | Error strings exported as constants + `isSignAnalysisUnavailable()`; call and contract unchanged |
| `utils/recentScans.ts` | `restoreRecentScans()` (same shape filter as load; cannot widen what is stored) |
| `views/street-parking/HeaderBar.tsx` | Scan entry point label/aria now translated (was hard-coded English) |
| `i18n/en.ts`, `i18n/es.ts` | +67 `scanner.*` keys, −113 retired keys each |
| `index.css` | Retired rules removed; shared `.pq-hero-midnight`, `.pq-cta`, `.pq-tool-icon` kept |
| `utils/savedSpot.ts` | Removed `effectiveParkingSide` (see below) |
| `package.json` | `test:street-intel` runs `utils/savedSpot.test.ts` instead of the deleted `utils/assistantTools.test.ts` |
| `knip.json` | `!docs/previews/**` (dev harness has no app entry) |
| `HANDOFF.md` | Feature table points at the new view |
| Tests repointed | `androidBackNavigation.test.ts`, `signScanner.consumers.contract.test.ts`, `signScannerCameraOnly.contract.test.ts`, `useParkingTimer.integration.contract.test.ts`, `mobileShell.contract.test.ts`, `geolocation.consumers.contract.test.ts`, `geminiService.test.ts`, `streetIntelligenceSafetyCopy.test.ts` |

## Dead code removed

Each item was confirmed unused outside the retired hub by searching the live source (excluding
`.worktrees/`, `docs/`), and knip reports no new unused files after removal.

| Removed | Rationale |
|---|---|
| `views/AssistantView.tsx` (495 lines) | Replaced by `views/sign-scanner/SignScannerView.tsx` |
| `views/assistant/HydrantDistanceTool.tsx` | Hydrant Distance UI; retired from this experience, no other importer |
| `views/assistant/ParkingCheckTool.tsx` | Am I Safe Here? UI; retired, no other importer |
| `views/assistant/HydrantIcon.tsx` | Only imported by the two tools above |
| `utils/hydrantDistance.ts` | Only imported by the two tools and `parkingCheck.ts` |
| `utils/parkingCheck.ts` | Only imported by `ParkingCheckTool` |
| `utils/savedSpot.effectiveParkingSide` + its 2 tests | Only caller was `ParkingCheckTool`. The map resolves curb side through its own street-intelligence path. |
| `views/AssistantView.scanner.test.tsx`, `.safety.test.tsx`, `.androidBack.test.tsx` | Every assertion was ported to `SignScannerView.test.tsx` / `recentScans.test.ts` (camera-only input, explicit read, double-tap guards, live region, AI disclaimer placement, no disclaimer on errors, conditional never lawful, Android Back, history shape/cap/storage failure). Hub-layout assertions were retired with the hub. |
| `utils/assistantTools.test.ts` | Hydrant and parking-check cases retired with their modules; the 10 `readSavedSpot`/`effectiveParkingSide` cases moved to `utils/savedSpot.test.ts` (8 remain after removing `effectiveParkingSide`) |
| 113 i18n keys per language (40 `assistant.*`, 37 `hydrant.*`, 36 `check.*`) | No remaining reference; dynamic key construction ruled out. `assistant.disclaimer`'s parity test now checks the scanner's boundary copy instead, with exact strings in both languages. |
| 76 CSS rules + 2 selectors from shared rules + `@keyframes pq-scan-sweep`, `pq-pulse` | `pq-assist*`, `pq-tool*` (except `.pq-tool-icon`, used by Messages), `pq-tools-*`, `pq-result*`, `pq-distance-*`, `pq-scan-card`, `pq-scan-orb*`, `pq-scanline`, `pq-pulse-ring`, `pq-recent-dot`, `pq-tip-dot`, `pq-soon-*`, `pq-step`, and their light-mode / reduced-motion overrides. Six of these (`pq-assist-hero`, `pq-assist-skyline`, `pq-scan-card`, `pq-soon-*`, `pq-step`) were already unused before this change. |

### Kept on purpose

- `AppView.AI_ASSISTANT`, `delegateAssistant`: route and App wiring, now pointing at the scanner.
- `pendingMyCarOpen` in App: still used by notifications and onboarding deep links.
- `utils/savedSpot.ts` (`readSavedSpot`, etc.), `utils/geolocation.ts`, street-intelligence utils: used by the map.
- `.pq-hero-midnight` (onboarding), `.pq-cta` (Notifications), `.pq-tool-icon` (Messages).
- **Server: `checkHydrantDistance` callable** (`functions/index.js`) and its tests. It now has no client
  caller, but removing it changes deployed production Functions and App Check configuration. It needs
  a separate, approved server change.

## Tests and verification

- `npx tsc --noEmit`: 0 errors.
- Focused suite (all touched areas, 23 files): 249 passed.
- Root suite (`vitest run`, `.worktrees/` excluded): 4629 passed, 18 failed. All 18 are unrelated to
  this change. 4 fail identically on a clean `origin/main` worktree. The rest come from this local
  checkout: `data/runtime-source/runtime-source-artifact.json` has a CRLF working copy (1 byte over
  its pinned digest), `provenance-evidence` fails on any uncommitted file, and two repo-walking tests
  time out because of the untracked `.worktrees/`.
- Production build (`run-production-build.mjs`): passes. The scanner is a lazy chunk (7.7 kB JS / 4.0 kB
  CSS gzipped). `dist` contains no retired UI and none of the preview harness.
- knip (preflight env): no new unused files.
- No linter is configured in this repo (no ESLint / ast-grep rules), so type check + knip are the static gates.
- Layout validated against the implementation preview with headless Chromium (Playwright,
  `deviceScaleFactor: 2`): 28 screenshots (kept locally in `docs/previews/sign-scanner/screenshots/`,
  not committed; regenerate them from the preview harness) covering
  360×800, 390×844 and 320×568, 100% and 130% text, dark and light, English and Spanish, every
  phase, the camera-cancel hint and the Clear/Undo toast. Each capture was also measured: no console
  errors, no horizontal overflow, no touch target under 44 px, primary action on screen.
- Reduced motion: captured with Playwright's real `reducedMotion: 'reduce'` emulation, 0 running
  animations on every screen (including reading). With motion allowed, only the reading sweep and
  progress bar loop.
- Text contrast measured on rendered colours: ≥ 5.1:1 in both themes (lowest: white on the CTA
  gradient's end colour).
- Pinned footer: at 320×568 / 130% text the result body scrolls 881 px beneath it and the last line
  clears the footer's fade.
- Fixed during validation: CTA below the fold at 320×568 / 130% (short-screen hero), hero cropping
  the sign frame (top-anchored art), title truncation in Spanish (now wraps), flex children
  shrinking in the scrolling column, focus loss after Clear (now moves to Undo, then back).

### Galaxy S20 (SM-G981U1, Android, 360×800 CSS px at the phone's display zoom), 2026-11-23

Two passes, neither touching production: Chrome on the phone loading the preview harness (mocked
reader), then this branch's `app.parqueen.qa` build against local Auth/Firestore emulators. The
installed QA app was backed up first (APK + its full data folder via `run-as`) and restored
afterwards byte-for-byte; permissions unchanged. `analyzeSign` was never reachable from the phone
(port 5001 unmapped), so no photo left the device.

| Check | Chrome | QA app |
| --- | --- | --- |
| Map → Scan opens the scanner directly | n/a | ✅ |
| Scan a Sign opens the camera directly (no chooser, no gallery, no permission prompt) | ✅ | ✅ |
| Cancelling the camera shows "No photo was taken" | ✅ | ✅ |
| Real photo → preview, no false "cancel" hint | ✅ | ✅ |
| CONDITIONAL result shows "Depends on conditions" (not unreadable) | ✅ (mock) | n/a |
| Spanish preview + unavailable error | ✅ (mock) | n/a |
| Backend unreachable → "Sign reading is unavailable right now", Try again first | ✅ (mock) | ✅ after fix below |
| Android Back: preview → scanner home, error → scanner home, home → map | n/a | ✅ |
| 130% system font: home, preview and error fit, CTA above the fold | Chrome ignores it | ✅ |
| Five-tab bottom bar intact on return to the map | n/a | ✅ |

**Bug found and fixed on device.** With the backend unreachable, the app said "We couldn't read
that sign" (retake). The Firebase SDK reports callable errors as `functions/<code>` (a dropped
connection is `functions/internal`), but `analyzeParkingSign` compared bare codes, so *every*
callable failure (rate limit, outage, offline) was classified as a bad photo. This predates the
scanner (same on `main`). `analyzeParkingSign` now strips the `functions/` prefix; a new test uses
the SDK's real error shape. Re-verified on the S20 with the rebuilt QA APK.

Not covered on device: a real Gemini reading (YES/NO/CONDITIONAL from a real sign) and the reminder
it offers, TalkBack, iOS, light theme, and the Android reduced-motion setting.

## Preview (dev only)

```
npx vite --config docs/previews/sign-scanner/vite.config.ts      # http://127.0.0.1:5182
```

Renders the real `SignScannerView` with the real `index.css`/Tailwind, replacing only
`services/geminiService` with a mock. Query params: `theme=light`, `lang=es`, `history=1`,
`phase=preview|result`, `result=yes|no|conditional|conditional-timed|unreadable|unavailable`,
`delay=<ms>`, `still=1` (jump animations to their end state for screenshots).
`window.__scanSample()` simulates a captured photo.

## Limitations

- **Partly device-tested** (Galaxy S20, Android only; see the table above). Still untested on a
  device: a live `analyzeSign` reading and its reminder, TalkBack, iOS (camera, cancel detection,
  safe areas), and the light theme.
- Reduced motion was verified with browser emulation, not by toggling the Android system setting.
- The model writes explanations and advice in English (server prompt), so Spanish users see Spanish UI
  around an English sentence. Fixing that needs an `analyzeSign` change (out of scope: contract frozen).
- `CONDITIONAL` cannot distinguish "depends on time" from "partly legible" without a server field.
- Recent scans are not tappable: the store keeps only title, verdict, and time (privacy by design).
- `useParkingTimer` is a single global timer; a scanner reminder replaces a My Car reminder (unchanged).
