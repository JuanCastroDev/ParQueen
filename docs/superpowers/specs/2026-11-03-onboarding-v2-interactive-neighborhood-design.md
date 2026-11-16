# ParQueen Onboarding 2.0 — Interactive Neighborhood

**Blueprint v1.2 · Provisional design review complete · Founder decisions closed (Q1–Q9) · November 3, 2026**

| | |
|---|---|
| Status | Blueprint closed for **visual design**. Design and planning only. **No implementation is authorized.** Decision closure, the Q7 security review, and contract verification are recorded in §15. |
| Supersedes | Blueprint v1.1 (draft, same date), which superseded v1.0 (founder-approved policy defaults) |
| Repository | `C:\Users\jayca\Projects\ParQueen-Onboarding` · branch `design/onboarding-v2-20261103` · baseline `bff07e9` |
| Authorization boundary | No changes to application source, authentication, Firestore/Storage rules, Cloud Functions, App Check, IAM, configuration, or dependencies. No commit, push, merge, deploy, equipment purchase, or dependency install. |

**Notation.** **[Verified]** means checked against the code at `bff07e9`, with file references. **[Proposed]** means a design or engineering proposal not yet built. **[Security review]** means a proposed change to authentication-adjacent client behavior that needs its own security review before implementation. **[Gate]** means a validation that has **not** happened yet and must happen before release.

---

## Contents

1. Product and experience architecture
2. Visual storyboard and scene states
3. Interaction behavior and transitions
4. First-time and returning-user journeys
5. Authentication, language, location, vehicle, and notification behavior
6. Navigation precedence and recovery model
7. UI component and asset specifications
8. English and Spanish copy
9. Accessibility and performance requirements
10. Error, interruption, and empty-neighborhood states
11. Engineering implementation plan
12. Test matrix and acceptance criteria
13. Change log
14. Outstanding review gates, unresolved risks, and open questions

---

## 1. Product and experience architecture

### 1.1 North star

**Show the possibility, choose a purpose, enter the real product.**

One illustrated street replaces the three-slide intro. A departing driver sends an *example* Ping, and a searching driver learns that a space *might* open. The user picks an immediate intention. Phone verification and the required username stay exactly as they are. The intention then leads to one real in-app action, which the user must confirm.

### 1.2 Non-goals

- No guest mode and no anonymous authentication.
- No live Ping data before sign-in, and no fabricated pins on the real map.
- No mandatory vehicle step, notification prompt, or map tour.
- No changes to authentication, rules, App Check, Cloud Functions, IAM, or the frozen analytics allowlist.
- No animation framework or heavy rendering dependency.

### 1.3 Founder decisions in force

| # | Decision | Source |
|---|---|---|
| D1 | "Just exploring" requires a verified phone account; there is no guest mode. | v1.0 |
| D2 | The intention is stored on the device only and is never an authorization signal. | v1.0 |
| D3 | The intention expires after 24 h, is used at most once, is cleared on logout and deletion, and may apply to a returning user on the same journey. | v1.0 |
| D4 | Vehicle details are optional and never block first entry or Ping publication. Profile editing stays. | v1.0 |
| D5 | Portrait and landscape are both supported; no app-wide orientation lock. | v1.0 |
| D6 | The first screen has an EN/ES switch, and the choice is remembered. | v1.0 |
| D7 | Fixed night artwork; controls are accessible in light and dark themes. | v1.0 |
| D8 | The example is visibly labelled. A Ping is a heads-up, not a reservation or guarantee. Legal review is required. | v1.0 |
| D9 | No onboarding analytics before a separate privacy decision. | v1.0 |
| D10 | Performance budgets are targets until measured. | v1.0 |
| D11 | The old onboarding stays behind a build-time flag during QA; it is not silently enabled in production. | v1.0 |
| D12 | The compulsory tour becomes contextual help for find/leave and an optional tour for explore. | v1.0 |
| D13 | `parqueen_lang` survives logout. Language syncs with `private/preferences.lang`, with a defined precedence. | v1.1 |
| D14 | After an explicit logout, the user goes straight to phone sign-in. A new install still sees the neighborhood. Deletion keeps the agreed reset. | v1.1 |
| D15 | A Ping-specific in-app explanation appears before any OS location request. Declining publishes nothing. An OS denial shows settings guidance. | v1.1 |
| D16 | A valid notification link beats the onboarding intention once required steps are complete. A handled link discards the intention. | v1.1 |
| D17 | Provisional budgets: first-paint art ≤ 120 KB, extra JS ≤ 15 KB gzipped, FCP < 2.5 s; first scene < 1 s is aspirational. | v1.1 |
| **D18** | A malformed link that only yields the generic fallback does **not** override a valid pending intention; the intention applies. A valid, actionable link keeps priority after required steps. | **v1.2 (Q1)** |
| **D19** | "Not now" on the Ping location sheet cancels **that Ping attempt only**. No global `locationAccess = declined` is written. OS state and the first-use primer are unchanged. The user can retry later. No Ping is published. | **v1.2 (Q2)** |
| **D20** | An explicit device language choice made during the current sign-in journey beats the account language. Otherwise the account's saved language wins. Hydration must not overwrite an explicit choice before precedence is resolved. | **v1.2 (Q3)** |
| **D21** | Spanish copy is reviewed by a native Spanish editor familiar with NYC audiences. Parking trust statements and Terms/Privacy implications get legal review before public release. The founder keeps final product, design, and editorial approval. | **v1.2 (Q4)** |
| **D22** | After the user's **first** successfully published Ping, if no vehicle details exist, show one optional, non-blocking, dismissible suggestion. It explains that details apply to **future** Pings only. Never block a Ping. Profile editing stays. | **v1.2 (Q5)** |
| **D23** | Provisional reference devices: Samsung Galaxy S20 5G (SM-G981U1, available); Moto G Play (2024), 4 GB (proposed low-end); iPhone SE (2nd generation, proposed older iOS). Record the actual hardware, OS versions, and conditions in QA. Make no performance claim without measurement. | **v1.2 (Q6)** |
| **D24** | A separate **read-only** security review covers profile confirmation, the missing-profile redirect, and notification-link gating. Its findings are binding design requirements (§15.2). No implementation. | **Closure (Q7)** |
| **D25** | The 24 h expiry applies **only** to the temporary explicit-language precedence marker. The saved language preference itself (device `parqueen_lang` and account `private/preferences.lang`) survives restart and logout. Expiry during offline or interrupted sync must be tested. | **Closure (Q8)** |
| **D26** | The founder owns device availability. The existing Galaxy S20 is the initial Android reference. Lower-end Android and an older supported iPhone are **required before final release QA approval**. No purchases are authorized. | **Closure (Q9)** |
| **D27** | The onboarding disclosure becomes "A Ping lets you know a spot may be opening up. Parking isn't guaranteed." (§8), shown as a quiet line with an info icon in the example and intention states. It no longer says that a Ping is not a reservation, so the real Ping-claiming experience (a finder acting on a Ping, the `claimSpot` path) **must** state that a Ping does not reserve or hold public parking, before or at the moment of claiming. This updates D8. **[Legal review required]** for both statements. | **2026-11-03 (founder)** |
| **D28** | The "Illustrative example · Not live activity" label is removed from onboarding; the interactive "See how it works" framing carries that meaning. No other prominent disclaimer replaces it. The inline disclosure (D27) stays. Simulated Pings must still never be presented as live parking activity, and the claiming-flow statement (D27) still applies. Screen-reader descriptions call the scene an example. This updates D8. | **2026-11-04 (founder)** |

### 1.4 Conflict check

There is **no conflict** between D1–D23 and any verified security or technical constraint. Three of the four required v1.2 corrections overturn **v1.1 proposals**, not founder decisions:

1. **The v1.1 Ping location gate was too broad.** It ran before every new-Ping composer. v1.2 runs it only when a new OS location request would be needed (§5.4).
2. **The v1.1 language model had no guard against the hydration effect.** Once `lang` is copied into `user`, the existing effect would apply the account value immediately, possibly before precedence is resolved, and overwrite an explicit device choice. v1.2 defines a single sequence with one owner (§5.3).
3. **The v1.1 resolver treated an `unavailable` profile as complete.** v1.2 requires a **confirmed** profile before any link or intention runs (§6). That needs one behavioral change, flagged for security review.

The fourth correction is a **v1.1 specification error**: the signal was specified as a stroke reveal, which repaints and so is not transform/opacity-only. §3.2 and §2.1 now replace it with discrete segments that only fade and move.

D19 also **replaces** v1.1's recommendation to persist `declined` (which was v1.1's Q2).

### 1.5 Verified baseline

- **App shell:** React 18.2, Vite 8, TypeScript, Tailwind 3. Wrapped in Capacitor 8 (iOS deployment target **15.0**, from `ios/App/App.xcodeproj/project.pbxproj`) and shipped as a web/PWA build.
- **Navigation:** a single `currentView: AppView` state switched in `App.tsx`. No router library.
- **Authentication:**
  - Firebase phone-only authentication, with three platform paths.
  - `users/{uid}` can only be created by the `claimUsername` callable.
- **Firestore cache:** initialized with `getFirestore(app)` ([firebaseConfig.ts:64](../../../firebaseConfig.ts)), which uses the **default in-memory cache**. Offline writes queue only for the current session and **do not survive an app restart**.
- **Translations:** `en` and `es` dictionaries with 1,152 keys each. Device language is stored in `parqueen_lang`.

---

## 2. Visual storyboard and scene states

### 2.1 The scene: one continuous environment

The scene is a fictional Bronx-inspired residential block at blue hour: brick façades, stoops, warm windows, trees, textured asphalt, a public curb, and parked cars. All art is original. It contains no real addresses, brands, readable plates, landmarks, or location claims. Nothing on the curb suggests ownership: no cones, gates, or "reserved" markings.

| Layer | Content | Format |
|---|---|---|
| L0 Backdrop | Sky, façades, street, curb, trees, background parked cars | Raster poster (§7.3) |
| L1 Departing car | The primary interactive vehicle on the near curb, with its driver | Inline SVG |
| L2 Searching car | A vehicle on the far lane, headlights on | Inline SVG |
| L3 Halo | A soft emphasis ring around L1 | SVG or CSS element (opacity only) |
| L4 Example Ping | The ParQueen Ping marker above L1 (shared primitive) | Inline SVG |
| L5 Signal | **4–6 discrete pre-drawn segments or dots along a fixed path from L4 to L2.** Each is its own element. There is no animated stroke. | Inline SVG `<g>` elements |
| L6 Awareness cue | A small "heads-up received" glyph near L2 (not a checkmark, not a parking symbol) | Inline SVG |
| L7 Example badge | "Illustrative example · Not live activity" | Live HTML |
| L8 UI panel | Heading, copy, actions | Live HTML with tokens |
| L9 Header | Logo, EN/ES, "Already have an account?" | Live HTML |

**No layer may show a completed parking event, a claimed curb, a curb checkmark, a countdown, an address, a distance, or a count.**

### 2.2 Phase storyboard

| Phase | Scene | Panel | Badge |
|---|---|---|---|
| **N0 Arrival** | L0–L2 at rest; L2 static | Headline, supporting line, "See how it works", "Skip example" | Visible |
| **N1 Departing driver** | L3 halo on L1 (one emphasis, then holds steady) | Instruction line, "Show an example Ping". Tapping L1 does the same thing. | Visible |
| **N2 Example Ping** | After the user acts: L4 rises, L5 segments light in sequence, L6 appears | Headline, explanation, trust line, "Continue" | Visible, emphasized |
| **N3 Choose purpose** | Holds the N2 end state (if the demo was seen) or the N0 state; never re-animates | Heading, supporting line, three intention buttons; trust line while L4 is visible | Visible |

### 2.3 Layout

Unchanged from v1.1:

- **Normal portrait:** the scene fills about the upper 55–65%, with a bottom panel on a solid scrim (no `backdrop-filter`).
- **Short portrait (320×568, 375×667):** the panel has priority, the scene can shrink to about 38% while keeping the focal safe zone visible, and the panel scrolls with a visible affordance. CTAs are never clipped.
- **Large portrait (430×932):** the panel's maximum width is 440 px.
- **Landscape (667×375 and up):** the scene takes the left 50–55%, the panel takes the right and scrolls, and header controls stay in the safe area.
- **Rotation** never resets the phase, the language, or the pending choice.
- **Theme:** the scene is always the night palette, and the controls use semantic tokens.

---

## 3. Interaction behavior and transitions

### 3.1 State machine **[Proposed]**

`utils/onboardingPhase.ts` holds `{ phase: 'N0'|'N1'|'N2'|'N3', demoSeen: boolean }`.

| From | Event | To | Side effects |
|---|---|---|---|
| N0 | `SEE_HOW` | N1 | — |
| N0, N1, N2 | `SKIP` | N3 | No intention is chosen automatically |
| N1 | `SHOW_PING` (button or car) | N2 | `demoSeen = true` |
| N2 | `CONTINUE` | N3 | — |
| N3 | `CHOOSE(intent)` | exit | Write the intention (§5.6), set `hasSeenOnboarding`, `onComplete(intent)`, go to `CREATE_ACCOUNT` |
| any | `HAVE_ACCOUNT` | exit | **No intention.** Set `hasSeenOnboarding`, go to `CREATE_ACCOUNT` |
| N3 | `BACK` | N2 if `demoSeen`, otherwise N0 | — |
| N2 | `BACK` | N1 | N1 static state |
| N1 | `BACK` | N0 | — |
| N0 | `BACK` | minimize the app (Android) | Existing `'minimize'` contract |
| any | `SET_LANG(x)` | same phase | `setLang(x)` and mark the explicit choice (§5.3) |
| any | rotate / resize | same phase | — |

The Android Back handle keeps its current shape, `handleAndroidBack(): 'handled' | 'minimize'`. The demo never replays automatically within a session.

### 3.2 Motion specification: transform and opacity only

| Moment | Property animated | Duration | Easing |
|---|---|---|---|
| N0 panel arrival | `opacity` 0→1, `transform: translateY(8px→0)` | 220–300 ms | `cubic-bezier(0.22,1,0.36,1)` |
| N1 halo | `opacity` 0→0.9→0.6, one cycle, then holds | 160–220 ms | ease-out |
| N2 Ping rise | `transform: translateY(14px→0)`, `opacity` 0→1 | 220–280 ms | ease-out |
| **N2 signal** | **Each L5 segment: `opacity` 0→1 and `transform: translate(…)` of ≤ 4 px along the path direction, staggered by 70–100 ms** | Each segment 120–160 ms; whole signal 450–600 ms | ease-out |
| N2 awareness cue | `opacity` 0→1, `transform: scale(0.9→1)` | 180–220 ms | ease-out |
| N2 total | — | about 0.9–1.4 s | — |
| N3 panel rise | `transform` translateY 24 px→0 (portrait) or translateX 24 px→0 (landscape), `opacity` | 220–280 ms | ease-out |
| Button press | `transform: scale(0.985)` and/or `opacity` | ≤ 130 ms | ease-out |

**Signal reconciliation (correction 4):**
- v1.1 specified a "stroke reveal". That animates `stroke-dashoffset`, which forces the SVG to repaint and is **not** compositor-only.
- v1.2 draws the signal as separate pre-drawn segments. Each segment is its own element and only changes `opacity` and `transform`, so the browser can promote and composite it.
- **Prohibited in the new view:** animating `stroke-dashoffset`, `d`, `offset-distance`, filters, `clip-path`, masks, or any layout property.
- **[Verified]** The legacy onboarding already animates a stroke (`onb3-route-draw` with `strokeDasharray` in `views/OnboardingView.tsx`). That code stays as it is behind the flag and is not a precedent for the new view.

**Other rules:**
- Text and controls render immediately.
- Nothing navigates automatically while motion is playing. "Continue" can be pressed during N2, and the scene snaps to its end state.
- No flashing and no infinite loops. L2 stays static by default; any cruise motion is optional and transform-only.
- **Reduced motion:** each phase shows its final frame immediately, with every L5 segment fully visible as a static dotted path. No timers. All actions still work.

### 3.3 Focus management

Unchanged from v1.1:
- On a user-triggered phase change, focus moves to the phase heading.
- On Back, focus returns to the control that opened the phase.
- The language switch never moves focus.
- Phase text is announced once through a polite live region.

---

## 4. First-time and returning-user journeys

| # | Situation | Path | End |
|---|---|---|---|
| J1 | New install, new person | N0–N3, choose → phone → code → username (`claimUsername`) → first-use location primer if access is `unknown` | Map. The intention applies once **after the profile is confirmed** (§6). |
| J2 | New install, existing account, via an intention | N0–N3, choose → phone → code → location primer if needed | Map. The intention applies once (D3). |
| J3 | New install, existing account, via "Already have an account?" | → phone → code | Normal landing. No intention. |
| J4 | Explicit logout, then reopen | `hasSeenOnboarding` kept (D14) → phone screen | As J3 |
| J5 | Account deleted, then reopen | `hasSeenOnboarding` cleared → N0 | As J1 |
| J6 | Killed during the code step | Logged out. The intention persists (< 24 h). The verification session is lost, so a new code is required. | J1/J2. Verification is never bypassed. |
| J7 | Killed after verification, before username | **[Verified]** The bootstrap reaches `SETUP_PROFILE` when the profile read confirms it is missing | Username, then J1 |
| J8 | Killed after username, before the location primer | **[Verified]** `LOCATION_PROMPT` | Map, then the intention |
| J9 | Killed on the map before the intention surface opened | The intention is not consumed | It applies once if < 24 h |
| J10 | **Profile read timed out or unavailable at startup** | **[Verified]** The existing bootstrap routes to `LOCATION_PROMPT` or `MAP` with a minimal user | Map usable as today. **Links and intentions are held until the profile is confirmed** (§6.2). If it is later confirmed **missing**, see §6.3. |
| J11 | Suspended or blocked account | **[Verified]** `claimUsername` returns `permission-denied` | Existing error. The intention expires naturally. |
| J12 | Account switch on the same device | Logout clears intention, language marker, and account keys (§5.2); the next sign-in starts a new journey | — |

**Authentication and profile boundaries are unchanged** (v1.1 §4.2):
- Only `claimUsername` creates `users/{uid}`.
- `assertProductAccess`, rate limits, moderation, and the rename cooldown stay on the server.
- The reCAPTCHA containers, the three platform authentication paths, the iOS UID-mismatch sign-out, the resend cooldown, one-time-code autofill, and the double-submit guards all stay.

---

## 5. Authentication, language, location, vehicle, and notification behavior

### 5.1 Pre-existing defects to fix first **[Verified]**

1. **Duplicate `claimUsername`.** It is called in `NameEntryView.handleSubmit` ([views/NameEntryView.tsx:122](../../../views/NameEntryView.tsx)) and again in `App.handleNameComplete` ([App.tsx:726](../../../App.tsx)). Each sign-up uses 2 of the 5 calls allowed per hour. **Fix (S0a):** `handleNameComplete` routes only.
2. **Two routers act after the code is verified.** `VerifyPhoneView.onVerify` ([App.tsx:1055](../../../App.tsx)) and the `onAuthStateChanged` bootstrap both set the view. **Fix (S0b):** the bootstrap is the only owner of the authenticated landing view.

### 5.2 Device state across logout and deletion (D13, D14)

**[Verified] behavior today:**
- `logoutUser()` ([database.ts:11](../../../database.ts)) calls `localStorage.clear()`. It then restores `theme`, plus `parqueen_fcm_owner_uid` only when Firestore cleanup fails.
- Deletion (`clearLocalAccountState`, [App.tsx:107](../../../App.tsx)) keeps `theme` and `parqueen_lang`.
- **[Verified]** `docs/THREAT_MODEL.md` TM-23 ("calls `signOut(auth)` only") is **out of date**.

**[Proposed]** One module, `utils/deviceStatePolicy.ts`, defines two frozen keep-lists. Nothing is kept unless it is on a list.

| Key | Logout today | **Logout v1.2** | Deletion today | **Deletion v1.2** |
|---|---|---|---|---|
| `theme` | keep | keep | keep | keep |
| `parqueen_lang` | clear | **keep** | keep | keep |
| `hasSeenOnboarding` | clear | **keep** | clear | clear |
| `parqueen_onboarding_intent_v1` (new) | — | clear | — | clear |
| `parqueen_lang_explicit_v1` (new, §5.3) | — | clear | — | clear |
| `locationAccessChoice`, `hasSeenLocationPrompt` | clear | clear | clear | clear |
| `parqueenAppTourSeen_v1` | clear | clear | clear | clear |
| `parqueen_fcm_owner_uid` | conditional restore | unchanged | clear | clear |
| `parqueen_vehicle_hint_done_v1` (new, §5.5) | — | **keep** | — | clear |
| all other keys | clear | clear | clear | clear |

The reasons for keeping or clearing each key are unchanged from v1.1. Three points:
- The location choice is not kept because the OS re-derives granted/denied on each authenticated start.
- Logout's `signOut`, FCM cleanup, and conditional marker restore are untouched. **[Security review]**
- `parqueen_vehicle_hint_done_v1` is a single device-level bit (`'1'`). It contains no UID or account identifier, so keeping it through logout leaves no account trace.

### 5.3 Language: one deterministic sequence (D6, D13, D20; correction 2)

**[Verified] current mechanics:**
- `setLang()` writes `parqueen_lang` and notifies subscribers ([i18n/index.ts](../../../i18n/index.ts)).
- `LanguageSettingsView` writes `users/{uid}/private/preferences.lang`. The rules allow only `'en'|'es'` for that field.
- The App effect `useEffect(..., [user?.lang])` calls `getLanguageHydrationAction(user.lang, getLang())` and runs `setLang` whenever `user.lang` changes.
- `projectPrivatePreferencesSnapshot` ([utils/authBootstrap.ts](../../../utils/authBootstrap.ts)) **does not copy `lang`**, so today `user.lang` only comes from a legacy public `users/{uid}.lang` field. In practice the account language never reaches the device.
- `claimUsername` creates `private/preferences` with `{ notificationRadius: 1 }` only.
- The private-preferences listener uses `includeMetadataChanges: true`, so snapshot metadata (`fromCache`, `hasPendingWrites`) is available.

**The risk v1.2 corrects:** if `lang` were simply added to the projection, the existing effect would apply the account value on the **first cached snapshot**. That happens before any precedence logic runs, so it would overwrite an explicit device choice.

**[Proposed] Single owner.** A `LanguageSyncController` (a pure state machine in `utils/languagePreference.ts`, driven from App) becomes the **only** code that calls `setLang` because of account data. The existing `[user?.lang]` hydration effect is **removed**. Its logic is absorbed into step 5 below.

**Device marker:** `parqueen_lang_explicit_v1 = { lang: 'en'|'es', at: epochMs }`.
- It is written only by user language choices while **signed out** (the neighborhood header, the phone and code screens).
- It expires after **24 h**, matching the intention TTL. An expired marker is treated as absent.
- It is cleared on logout, on deletion, and after a successful account write.

**Sequence, run once per authenticated UID per app session.** It is protected by the existing bootstrap generation tracker, and every async step re-checks that the UID is still the same.

| Step | State | Action |
|---|---|---|
| 1 | `idle`, signed out | Device language rules. Pre-auth choices write the marker. |
| 2 | `awaiting_profile` | On a new authenticated UID: hydration is **locked**. No `setLang` from account data. Wait for the profile to be **confirmed** (§6.2). For a new account, that means after `claimUsername` succeeds. |
| 3 | `awaiting_prefs` | Wait for the first `private/preferences` snapshot with `!fromCache && !hasPendingWrites` (authoritative), **or** a 4 s timeout, **or** a `navigator.onLine === false` signal. |
| 4 | `resolving` | Apply the precedence table below **exactly once**. |
| 5 | `resolved` | Unlock. From now on, `setLang` from account data happens only when **all** of these hold: the snapshot is authoritative (`!fromCache && !hasPendingWrites`); `lang` is valid; it differs from the current device language; and it differs from the value this controller last wrote. This covers changes made from another device. User changes in `LanguageSettingsView` keep writing both places, as today. |
| — | UID changes or logout | Reset to `idle`. Any in-flight write whose UID no longer matches is ignored on completion. |

**Precedence table (step 4):**

| Valid marker? | Account `lang` (source) | Result | Write |
|---|---|---|---|
| Yes | any or absent | **Device marker language** (`setLang(marker.lang)` if needed) | `updateDoc(private/preferences, { lang })`, limited to that field. Clear the marker **only after** the write succeeds. |
| No | valid, authoritative | **Account language** (`setLang(account)`) | none |
| No | valid, cache-only (timeout or offline) | Keep the **device** language for now. Stay subscribed. The first authoritative snapshot then applies the account language once, unless the user changed the language in the meantime. | none |
| No | absent or invalid (authoritative) | Keep the device language | Write the device language so the account has a value |
| No | unknown (timeout, no snapshot) | Keep the device language | none. Re-run step 3 on the next authoritative snapshot this session. |

**Precedence window (closure contract C2, D20, D25).** The **precedence window** is open while a valid, unexpired `parqueen_lang_explicit_v1` marker exists.
- While it is open, **no code path may call `setLang` because of account data**. That includes authoritative snapshots in step 5.
- The only callers of `setLang` are user choices: `LanguageSwitch`, `LanguageSettingsView`, and the revert in `LanguageSettingsView` after a failed write. **[Verified]** Today the only `setLang` callers are the App hydration effect (to be removed) and `LanguageSettingsView`.
- The window closes when **one** of these happens:
  1. the account write is **acknowledged** (the `updateDoc` promise resolves), and the marker is cleared;
  2. the marker expires (24 h). The account language then applies at the next authoritative snapshot;
  3. logout or deletion clears the marker. The device `parqueen_lang` is kept (D25).
- A signed-in change in `LanguageSettingsView` is a newer explicit choice. It writes the account and clears any marker after the write succeeds.
- **What survives (D25):** the device `parqueen_lang` survives restart, logout, and deletion. The account `private/preferences.lang` persists on the server. Only the marker expires.

**Failure and offline behavior:**
- If the write fails, the marker stays, and the controller retries once on the next authoritative preferences snapshot this session, then on the next app start.
- Because the Firestore cache is **in memory only** (§1.5), a write queued offline is **not** assumed to survive a restart. The marker is the durable record that a write is still owed.

**Required changes (not implemented):**
- Copy a validated `lang` into `user` in `projectPrivatePreferencesSnapshot`.
- Add `utils/languagePreference.ts` (the controller, the precedence function, and a guarded writer limited to `lang`).
- Wire it into App and remove the `[user?.lang]` hydration effect.
- Add the marker key to `deviceStatePolicy` as cleared on logout and deletion.
- **No rules change** is needed: `lang` is already allowed in `private/preferences`.
- **[Security review]**: App state and `logoutUser`.

### 5.4 Location for Ping creation (D15, D19; correction 1)

**[Verified] current mechanics:**
- **Location sources:**
  - Opening the composer for a new Ping copies `userLocation` into `pingLocationSnapshot` whenever `userLocation` exists ([views/StreetParkingView.tsx:1461](../../../views/StreetParkingView.tsx)).
  - `userLocation` comes from position tracking, which runs only when `allowLocationTracking` is true (`locationAccess === 'granted'`, [App.tsx:1013](../../../App.tsx)).
- **What saving does:**
  - `handleSaveSpot` uses `pingLocationSnapshot ?? userLocation`. Only when **both are null** does it call `getCurrentPosition()` ([views/StreetParkingView.tsx:1806, 1838](../../../views/StreetParkingView.tsx)).
  - On Android, the installed plugin (8.2.4) asks the OS for permission inside `getCurrentPosition` if it isn't granted. Web browsers prompt the same way. iOS is expected to behave the same but is **unverified** **[Gate]**.
- **Checking permission never prompts:** `checkLocationPermission()` uses `plugin.checkPermissions()` on native and the Permissions API on web.
- **Paths that need no live location:**
  - Editing an existing Ping uses that Ping's coordinates.
  - The My Car departure Ping (`handleMyCarPing`) uses the saved car's coordinates.

**[Proposed] gate, keyed on whether usable coordinates exist** (not on whether the composer opens):

| Case | Condition when the composer opens | Composer | Location row | Publish ("Ping now" / "Schedule") |
|---|---|---|---|---|
| A | Usable coordinates exist (`pingLocationSnapshot` or `userLocation`) | Opens immediately | Existing address/"Locating…" row | Enabled, as today |
| B | No coordinates; permission `granted`; services on | Opens immediately | "Locating…". One non-prompting `getCurrentPosition` starts when the composer opens (permission is already granted, so no OS dialog is possible). | Enabled once coordinates arrive. On timeout, the row shows "Couldn't get your location" with "Try again". |
| C | No coordinates; permission `prompt` | Opens immediately | "Location needed to place this Ping" with a "Use my location" button | **Disabled** until there are coordinates. "Use my location" opens the **reason sheet** (§8). **Continue** calls `requestLocationPermission()`; if granted, move to case B. If denied, case D. **Not now** closes the sheet; the composer stays open with the button disabled. Closing the composer cancels the attempt. |
| D | Permission `denied` | Opens immediately | Settings guidance inline (platform-specific copy) with "Check again" (`checkLocationPermission()`) | Disabled |
| E | Services off, or location `unavailable` | Opens immediately | "Turn on Location Services" / "Location isn't available" with "Check again" | Disabled |

**Invariants:**
- **No OS location request happens without the reason sheet first.** In case B the permission is already granted, so the system dialog cannot appear.
- **`handleSaveSpot` never calls `getCurrentPosition` unless the permission is `granted`.** This is a second line of defense.
- If a publish tap would need a new OS request, the tap is **cancelled**. After permission is granted, the composer shows the resolved location and the user must tap publish **again**. No Ping is ever published on the strength of a tap made before the location was shown.
- **D19:** "Not now" writes **nothing** global. No `persistAccessChoice`, and `locationAccess` is not changed. The first-use primer (`LOCATION_PROMPT`) and the OS state are untouched. The user can retry at any time.
- If the user grants permission through the reason sheet, App's existing reconcile (`reconcileLocationAccess` with `persistReconciledAccess`) records `granted`, which reflects the OS truth. As a result, map position tracking starts, which matches the app's current meaning of `granted`.
- The duplicate-Ping check, the 5-per-hour limit, the horizon, and the rules checks are unchanged. Edit and My Car paths are unchanged.

**Expected platform behavior** **[Gate]** (confirm on the D23 devices):
- **iOS:** the first request shows the system dialog. After a denial, only Settings can change it.
- **Android:** after two denials, or "Don't ask again", the request returns `denied` without a dialog, and the app shows case D. "Approximate" access counts as granted (the existing `accuracy` field).
- **Web:** the browser prompt. A site-level denial means case D. If the Permissions API is missing, the state is treated as `prompt`.

### 5.5 Vehicle-details suggestion (D4, D22)

**[Verified]**
- Vehicle fields are optional everywhere they are read: the rules use `profile.get(..., null)`, Ping creation writes `user.vehicleX || null`, `claimSpot` uses `textOrNull`, and the display components check `hasVehicle`.
- A Ping copies the vehicle **at save time**.
- `EditVehicleView` saves each sub-step immediately.
- A server trigger (`incrementTotalSpotsPinged`) increments `users/{uid}.impactStats.pingsShared` after each Ping is created ([functions/index.js:858](../../../functions/index.js)). This counter only counts Pings from the time it was introduced.

**[Proposed]**
- `EDIT_VEHICLE` is removed from sign-up. The composer gets **no** vehicle editing.
- **When it shows (closure contract C3).** **All** of the following must be true:
  1. A **new** Ping publication has **succeeded**: the composer's `onSaveSuccess` (called only after `commitPingCreate`'s transaction resolves, **[Verified]** comment at `StreetParkingView.tsx:1726`) or the My Car departure Ping's success path. Edits, failures, and rate-limit denials never qualify.
  2. The user has no `vehicleType`, `vehicleBrand` or `vehicleColor`.
  3. The latest `users/{uid}` snapshot is **authoritative** (`!metadata.fromCache`), and in it `impactStats.pingsShared` is `0` or absent. If only a cached snapshot exists, the suggestion is **skipped**, not deferred. Missing a suggestion is better than repeating it.
  4. The device guard `parqueen_vehicle_hint_done_v1` is **not** set.
  5. An in-memory session flag is not set.
- On **show**, set the session flag **and** `parqueen_vehicle_hint_done_v1 = '1'` immediately. Showing it once counts as done, whether the user adds details, taps "No thanks", or ignores it.
- **What it is:** a small, non-modal card above the map chrome. It doesn't move focus, but it is announced through the polite live region.
  - Copy: "Add car details (optional)" and "They'll appear on your future Pings, not the one you just shared."
  - Actions: "Add details" opens `EditVehicleView` in normal mode. "No thanks" dismisses it.
- **Why three guards (closure correction to v1.2).** v1.2 relied only on the server counter. That is not enough.
  - **[Verified]** `incrementTotalSpotsPinged` is an **asynchronous** Firestore trigger (with `retry: true`). The counter can lag behind the publish.
  - A user who publishes, cancels (finder cancel), and publishes again before the trigger runs would still see `0`.
  - New accounts also start with the counter **absent** (`claimUsername` does not set `impactStats`), so "absent" cannot tell a legacy user from a new one.
  - The device guard prevents repeats on the device. The session flag prevents repeats within one session. The authoritative counter prevents the suggestion on a second device once the first Ping has been counted.
  - None of these needs a rules change.
- **Remaining residual:** if a user published their first Ping on device A, and the trigger had not yet run (or the counter is absent for a legacy user), they may see the suggestion **once** more on a different device B. That is at most once per device. Accepted.
- Profile vehicle editing is unchanged. A Ping is never blocked.

### 5.6 Onboarding intention lifecycle (D2, D3)

| Aspect | Specification |
|---|---|
| Key | `parqueen_onboarding_intent_v1` = `{"v":1,"intent":"find"\|"leave"\|"explore","chosenAt":<ms>}` |
| Write | Only `CHOOSE(intent)` at N3 |
| Read | Schema-validated. Any parse error, unknown version or intent, future time > 5 min, or age > 24 h is treated as absent, and the key is deleted. |
| Consume | Deleted only after its surface actually opened (§6.4) |
| Clear | Logout, deletion, a handled actionable link (D16), expiry |
| Authority | Choosing a screen only. Never used by security code. |

### 5.7 Notifications

**[Verified]** Authentication never requests notification permission. Enabling is gesture-bound through `NotificationEnableCard`. That is unchanged. Link precedence is defined in §6.

---

## 6. Navigation precedence and recovery model

### 6.1 [Verified] current behavior

- **Notification queue:** `createNotificationIntentQueue` runs when `setReady(!loading && !!user?.id)` ([App.tsx:629](../../../App.tsx)). Running it sets `MAP` or `NOTIFICATIONS` **whatever screen is showing**, so it can skip `SETUP_PROFILE` and `LOCATION_PROMPT`.
- **Link sources:**
  - URL fragment: invalid values are dropped.
  - Service-worker message: invalid falls back to `{type:'notifications'}`.
  - Native open event: `normalizeNotificationIntent ?? readNotificationIntentFromPayload`, which also falls back to `notifications`.
- **Profile bootstrap:**
  - `lookupProfileBootstrapStatus` returns `'exists' | 'missing' | 'unavailable'`. Timeouts and network errors become `unavailable`.
  - `decideAuthenticatedConsumerBootstrap` treats `unavailable` like `exists` (`LOCATION_PROMPT` or `MAP`) and seeds a minimal `{ id }` user.
  - The live `users/{uid}` listener keeps running. If it later reports `exists()`, the user object fills in. If it reports the document is **missing**, it only projects an empty profile and **does not change the route**.
- **Rules:** `productAccessDenied()` is `exists(profile) && userRecordDenies(...)` ([firestore.rules:17](../../../firestore.rules)). A **missing** profile is therefore *not* denied. The product's own flows (for example the Ping identity checks, which `get()` the profile) fail for a user with no profile.

### 6.2 Profile confirmation (correction 3)

`profileConfirmed` (per UID, in memory) becomes true only when one of these happens:
1. the bootstrap's bounded `getDoc` returns `exists` **from the server** (`!snap.metadata.fromCache`). **[Verified]** `lookupProfileBootstrapStatus` currently passes only `exists()` to `classifyProfileSnapshot` and discards the metadata. It must also return whether the result came from the server, and a cache-served `exists` counts as **unconfirmed**;
2. the live `users/{uid}` listener delivers a snapshot with `exists() === true` and `!metadata.fromCache`;
3. `claimUsername` resolves successfully in this session.

`unavailable` **never** counts as confirmed. A cache-only `exists()` snapshot also does not count, because the cache is in memory and only reflects this session's earlier server reads.

### 6.3 Behavioral change for a later-confirmed missing profile **[Proposed] [Security review]**

- **Today:** a user whose startup profile read timed out, and who really has no profile (killed after verifying, before choosing a username, then restarted while offline), lands on the map with no username. They stay there even after the listener shows the document is missing.
- **Proposed:** when the live listener delivers a **server-confirmed** (`!fromCache`) snapshot with `exists() === false` for the current UID, and the current view is not an admin view, route to `SETUP_PROFILE`. Links and the intention stay held.
- This changes post-authentication routing, not authorization. The rules and server checks are unaffected. It still needs security review because it alters authenticated navigation.
- **Required safeguards from the Q7 review (§15.2, F1–F3).** The redirect fires only if **all** of these hold:
  - (a) no account deletion is in progress or has completed in this session (`deletePhase === 'idle'` and no `accountDeletedRef`);
  - (b) a forced ID-token refresh (`getIdToken(true)`) succeeds for the same UID. If it fails because the user is not found, disabled, or the token is revoked, the client **signs out** instead of redirecting;
  - (c) the UID and bootstrap generation are unchanged when the refresh completes;
  - (d) the current view is not an admin view.

### 6.4 Landing resolver **[Proposed]**

`utils/landingPrecedence.ts` is pure. App applies the single action it returns.

```
resolveLanding({
  authReady, isAdminDomain, signedIn,
  profileStatus,          // 'exists' | 'missing' | 'unavailable' (bootstrap)
  profileConfirmed,       // §6.2
  locationAccess,         // 'unknown' | 'granted' | 'declined' | 'denied'
  currentView, mapReady, overlayOpen,
  pendingLink,            // { intent, actionable: boolean } | null
  pendingIntent,          // validated onboarding intention | null
}) → Action
```

`mandatoryComplete` = `signedIn && profileConfirmed && locationAccess !== 'unknown'` **and** `currentView ∉ {ONBOARDING, CREATE_ACCOUNT, VERIFY_PHONE, SETUP_PROFILE, LOCATION_PROMPT}`.

The first matching rule wins:

| Priority | Condition | Action | Link | Intention |
|---|---|---|---|---|
| P0 | `!authReady` or startup timeout | Loading or recovery screen (unchanged) | hold | hold |
| P1 | Admin domain | Admin routing (unchanged) | ignore | ignore |
| P2 | Signed out | `ONBOARDING` or `CREATE_ACCOUNT` by `hasSeenOnboarding` | hold (memory) | hold (storage) |
| P3 | `profileStatus === 'missing'`, or §6.3 confirmed missing | `SETUP_PROFILE` | hold | hold |
| P4 | Profile `exists` or `unavailable`, and `locationAccess === 'unknown'` | `LOCATION_PROMPT` | hold | hold |
| P5 | Profile `unavailable` and **not yet confirmed** | `MAP` (existing offline-tolerant behavior); show the map as today | **hold** | **hold** |
| P6 | `mandatoryComplete`, and the pending link is **actionable** | Run the link (`executeNotificationIntent`) | consume | **discard** (D16) |
| P7 | `mandatoryComplete`, the pending link is **not actionable**, and an intention is pending | Drop the generic fallback and go to P8 (D18) | discard | apply |
| P8 | `mandatoryComplete`, intention pending, `mapReady`, `!overlayOpen` | Open the intention surface (§6.5) | — | consume after it opens |
| P9 | `mandatoryComplete`, the pending link is not actionable, and **no** intention | Existing generic fallback (`NOTIFICATIONS`) | consume | — |
| P10 | otherwise | Stay on the current view, or `MAP` by default | — | — |

**Definitions:**
- **Actionable link:** normalized to a `ping` with a valid spot ID, `my_car`, or an **explicit** `notifications` intent from a valid payload. If `openPing` later falls back because the spot is gone, it still counts as handled.
- **Not actionable:** a link whose only meaning is the generic `{type:'notifications'}` produced by a source's fallback. Each source adapter must set `actionable` (a client-only change).
- **The queue's ready flag** becomes `mandatoryComplete` instead of `!loading && !!user?.id`. That is the only behavioral change to link execution. **[Security review]**
- Held links are kept in memory and are lost if the app is killed. That is unchanged from today.
- **From the Q7 review (§15.2, F4–F5):**
  - A held link is **dropped** on explicit logout and whenever the authenticated UID changes from one account to another.
  - A link received while signed out (a cold-start URL fragment) may be held for the next sign-in.
  - Any held link is dropped once it is older than **15 minutes**, so a stale tap never navigates unexpectedly.

### 6.5 Applying the intention on the map

The intention is applied only when the map is ready, there is no selected item, and no sheet or modal is open. It is never combined with the tour, another modal, or the composer.

| Intention | Surface | "Opened" means |
|---|---|---|
| `find` | Real pins and the nearby chip, or the empty-state card (§10.3) | The card or chip is rendered |
| `leave` | The existing composer, following §5.4 cases A–E. Publishing is never automatic. | The composer is open |
| `explore` | A dismissible "Show me around" chip; `AppTour` starts only when it's tapped | The chip is rendered |

`AppTour` gets an `autoStartTour` prop, false for new accounts. Settings → Replay stays.

### 6.6 Recovery model

| Failure | Behavior |
|---|---|
| The first auth event takes > 8 s | Existing `AuthStartupRecovery` |
| Profile `unavailable` | P5: map as today. Links, intention, and language precedence are held until confirmed. |
| Profile later confirmed missing | §6.3: go to `SETUP_PROFILE` (pending security review) |
| `claimUsername` errors | Existing messages and retry. The intention is kept until it expires. |
| Auth send or verify errors | Existing guarded handling |
| Language write fails | Marker kept; retried (§5.3) |
| Malformed or expired intention | Deleted; normal landing |
| Art fails to load | Solid night background plus the SVG foreground; all actions work |
| Rotation during motion | Snap to the end state; no state lost |
| Location request timeout (case B) | "Couldn't get your location" with "Try again"; publish stays disabled |

---

## 7. UI component and asset specifications

### 7.1 Proposed modules

| Module | Responsibility |
|---|---|
| `views/onboarding/NeighborhoodOnboardingView.tsx` | Phase host, header, panel, Back handle, focus. Same `onComplete`/`androidBackRef` contract as today. |
| `views/onboarding/NeighborhoodScene.tsx` | Layers L0–L7, poster, segmented signal, reduced motion |
| `views/onboarding/IntentChooser.tsx` | Labelled group of three buttons |
| `views/onboarding/LanguageSwitch.tsx` | EN/ES control; writes the marker while signed out |
| `components/onboarding/PingMarker.tsx` | Single source for the Ping marker SVG |
| `components/PrimaryCta.tsx` | Token-based primary button |
| `components/location/PingLocationRow.tsx` | §5.4 cases B–E inside the composer |
| `components/location/LocationReasonSheet.tsx` | Reason sheet (Continue / Not now), on the existing `BottomSheet` |
| `components/VehicleSuggestionCard.tsx` | D22 card |
| `utils/onboardingPhase.ts` | Reducer and Android Back mapping |
| `utils/onboardingIntent.ts` | Intention storage contract (§5.6) |
| `utils/landingPrecedence.ts` | §6.4 resolver and `profileConfirmed` helpers |
| `utils/languagePreference.ts` | §5.3 controller, precedence function, guarded writer |
| `utils/deviceStatePolicy.ts` | Logout and deletion keep-lists |
| `utils/pingLocationGate.ts` | Pure mapping from {coordinates, permission, services} to cases A–E |

**Reused [Verified]:** `BottomSheet`, `AccessibleModal`, `useFocusOnMount`, `useModalAccessibility`, `LoadingScreen`, `CountrySelector`, `SignupProgress` (changed to `total=3`), `VehicleIcon`, `EditVehicleView`, `NotificationEnableCard`, `AppTour`, the `t`/`useLang` helpers, and the `checkLocationPermission`/`requestLocationPermission`/`reconcileLocationAccess` functions.

### 7.2 Asset specifications

| Asset | Spec |
|---|---|
| Master art | One original layered illustration; L1 and L2 locked on a shared grid |
| Portrait poster | 4:5 crop. WebP (q≈70) plus AVIF at `srcset` widths 390 / 780 / 1170 |
| Landscape poster | 16:9 crop. Same formats at 667 / 1334 / 2001 |
| First-paint budget | **≤ 120 KB transferred** for the one poster the device chooses |
| After-first-paint detail | Optional; never required |
| Foreground SVG | L1, L2, L4, L5 (segments), L6 ≤ 25 KB total uncompressed, inline, `aria-hidden` |
| Focal safe zone | L1 and the L4 rise area sit within the center 60% width × middle 50% height of every crop |
| Layout shift | The poster box reserves its size with `aspect-ratio`; the background matches the average sky color |
| Text in art | None |

### 7.3 Tokens

The panel and controls use `--color-surface`, `--color-card`, `--color-text`, `--color-text-secondary`, `--color-border`, `--color-brand`, `--color-brand-2`, `--color-accent`, `--color-info`, `--color-danger`, and `--pq-elev-cta`. Scene-only constants are scoped under `.pq-neighborhood`.

---

## 8. English and Spanish copy

> **[Gate] D21, outstanding reviews. None of these has happened yet.**
> - Native Spanish editorial review (NYC audience): **not started**
> - Legal review of parking trust statements and Terms/Privacy implications: **not started**
> - Founder final product, design, and editorial approval: **pending**
>
> All strings below are drafts.

| Key | English | Español (draft) |
|---|---|---|
| `onboarding.v2.n0.headline` | Someone's leaving. Someone's looking. | Alguien se va. Alguien busca dónde estacionar. |
| `onboarding.v2.n0.supporting` | See how drivers can help each other find street parking. | Mira cómo los conductores pueden ayudarse a encontrar estacionamiento en la calle. |
| `onboarding.v2.n0.primary` | See how it works | Mira cómo funciona |
| `onboarding.v2.skip` | Skip example | Omitir ejemplo |
| `onboarding.v2.have_account` | Already have an account? | ¿Ya tienes una cuenta? |
| ~~`onboarding.v2.example_badge`~~ *(removed, D28)* | ~~Illustrative example · Not live activity~~ | ~~Ejemplo ilustrativo · No es actividad en vivo~~ |
| `onboarding.v2.scene_alt` | Illustrative example of a city street at night. One driver is getting ready to leave a parked car while another driver looks for parking. | Ejemplo ilustrativo de una calle de la ciudad de noche. Un conductor se prepara para dejar su auto estacionado mientras otro busca dónde estacionar. |
| `onboarding.v2.n1.line` | A driver is getting ready to leave. | Un conductor se prepara para salir. |
| `onboarding.v2.n1.action` | Show an example Ping | Mostrar un Ping de ejemplo |
| `onboarding.v2.n1.car_label` | Departing driver's car. Show an example Ping | Auto del conductor que se va. Mostrar un Ping de ejemplo |
| `onboarding.v2.n2.headline` | A heads-up can help another driver. | Un aviso puede ayudar a otro conductor. |
| `onboarding.v2.n2.body` | A Ping tells nearby drivers a parking space might open up. | Un Ping avisa a los conductores cercanos que podría quedar un espacio libre. |
| `onboarding.v2.trust` *(changed, D27)* | A Ping lets you know a spot may be opening up. Parking isn't guaranteed. | Un Ping te avisa que podría liberarse un espacio. No se garantiza el estacionamiento. |
| `onboarding.v2.continue` | Continue | Continuar |
| `onboarding.v2.n3.headline` | How can ParQueen help you? | ¿Cómo puede ayudarte ParQueen? |
| `onboarding.v2.n3.supporting` | You can do all three anytime. | Puedes hacer las tres cosas cuando quieras. |
| `onboarding.v2.intent_group` | Choose what you want to do first | Elige qué quieres hacer primero |
| `onboarding.v2.intent.find` | Find parking | Buscar estacionamiento |
| `onboarding.v2.intent.leave` | I'm leaving a spot | Voy a dejar un espacio |
| `onboarding.v2.intent.explore` | Just exploring | Solo quiero explorar |
| `onboarding.v2.lang_label` | Language | Idioma |
| `onboarding.v2.back` | Back | Atrás |
| `create_account.headline` *(changed)* | Continue with your phone number | Continúa con tu número de teléfono |
| `create_account.supporting` *(changed)* | Verify your number to use ParQueen. | Verifica tu número para usar ParQueen. |
| `signup.step_of` | Step {n} of 3 | Paso {n} de 3 |
| `ping_location.row_needed` | Location needed to place this Ping | Se necesita tu ubicación para colocar este Ping |
| `ping_location.use_my_location` | Use my location | Usar mi ubicación |
| `ping_location.reason_title` | Use your location for this Ping? | ¿Usar tu ubicación para este Ping? |
| `ping_location.reason_body` | ParQueen needs your location to place your Ping accurately on the map. | ParQueen necesita tu ubicación para colocar tu Ping con precisión en el mapa. |
| `ping_location.continue` | Continue | Continuar |
| `ping_location.not_now` | Not now | Ahora no |
| `ping_location.cancelled` | No Ping was shared. You can try again anytime. | No se compartió ningún Ping. Puedes intentarlo cuando quieras. |
| `ping_location.locating_failed` | Couldn't get your location. | No pudimos obtener tu ubicación. |
| `ping_location.try_again` | Try again | Intentar de nuevo |
| `ping_location.denied_title` | Location is turned off for ParQueen | La ubicación está desactivada para ParQueen |
| `ping_location.denied_ios` | Open Settings › ParQueen › Location and choose "While Using the App". | Abre Ajustes › ParQueen › Ubicación y elige "Mientras se usa la app". |
| `ping_location.denied_android` | Open Settings › Apps › ParQueen › Permissions › Location and choose "Allow only while using the app". | Abre Ajustes › Aplicaciones › ParQueen › Permisos › Ubicación y elige "Permitir solo mientras se usa la app". |
| `ping_location.denied_web` | Allow location for this site in your browser's site settings, then try again. | Permite la ubicación para este sitio en la configuración del navegador y vuelve a intentarlo. |
| `ping_location.services_off` | Turn on Location Services on your device, then try again. | Activa la ubicación en tu dispositivo y vuelve a intentarlo. |
| `ping_location.unavailable` | Location isn't available on this device or browser. | La ubicación no está disponible en este dispositivo o navegador. |
| `ping_location.check_again` | Check again | Revisar de nuevo |
| `map.empty_find.title` | No active Pings in this area right now. | No hay Pings activos en esta zona por ahora. |
| `map.empty_find.body` | Try another area or check street-cleaning rules. | Prueba otra zona o consulta las reglas de limpieza de calles. |
| `map.empty_find.notify` | Get notified about Pings | Recibir avisos de Pings |
| `map.explore_chip` | Show me around | Muéstrame la app |
| `vehicle_hint.title` | Add car details (optional) | Agregar datos del auto (opcional) |
| `vehicle_hint.body` | They'll appear on your future Pings, not the one you just shared. | Aparecerán en tus próximos Pings, no en el que acabas de compartir. |
| `vehicle_hint.add` | Add details | Agregar datos |
| `vehicle_hint.dismiss` | No thanks | No, gracias |

Copy rules:
- **Never** say "reserve", "claim your guaranteed spot", "a spot just opened near you" (during the illustration), or "you're covered until …" without a real rules source.
- **D27:** the claiming experience (a finder acting on a Ping) must say that a Ping does not reserve or hold public parking. Final wording comes from legal review; the onboarding disclosure does not replace it.
- The existing Terms and Privacy notice and links stay visible before the code is sent.
- The OS settings paths in the guidance strings vary by OS version and manufacturer. Confirm them on the D23 devices **[Gate]**.

---

## 9. Accessibility and performance requirements

### 9.1 Accessibility (release gates)

Unchanged from v1.1, with additions for the new surfaces:
- Real buttons with localized names. The car hotspot is in addition to the text button.
- A single `role="img"` scene description; decorative SVG is `aria-hidden` (this includes every L5 segment).
- A labelled intention group. Phase text is announced once through a polite live region.
- Touch targets ≥ 44 pt on iOS and ≥ 48 dp on Android.
- Visible focus rings (≥ 3:1), logical tab order, focus management as in §3.3.
- Body text ≥ 15 px, supporting text ≥ 13 px; the badge ≥ 12 px only at 4.5:1. Layout works at 200% text size.
- Contrast: text 4.5:1; large text and essential boundaries 3:1.
- No timed actions. Reduced motion honored.
- EN/ES parity for every string and accessibility label, checked at every test size in Spanish.
- **New:** `PingLocationRow` announces its state change (case B→A, C→B) politely. The disabled publish button exposes *why* it is disabled through `aria-describedby` pointing at the location row.
- **New:** `VehicleSuggestionCard` is non-modal, never steals focus, and is reachable by keyboard and screen reader.
- **New:** axe (WCAG 2.0/2.1 A and AA) runs on N0–N3, the phone screen, the composer in cases C and D, the reason sheet, and the vehicle suggestion card.

### 9.2 Performance (D17, D23)

**[Verified]** `docs/PERFORMANCE_AND_COST_BUDGET.md` is dated **2026-07-24**. It records a main bundle of 233 kB gzipped (over budget) and targets of initial transfer < 500 kB gzip and FCP < 2.5 s. Parts are out of date. **No new baseline has been measured** (no `node_modules` in this worktree, and installing is not authorized).

| Metric | Provisional target | Status |
|---|---|---|
| Main bundle gzip | ≤ re-measured baseline + 15 KB | **[Gate]** baseline not measured |
| First-paint art | ≤ 120 KB transferred | **[Gate]** asset not yet produced |
| Total initial transfer | < 500 kB gzip | **[Gate]** |
| First Contentful Paint | < 2.5 s (release gate) | **[Gate]** |
| First scene visible | < 1 s (aspirational, not a gate) | — |
| N2 frame rate | 60 fps target / 45 fps floor | **[Gate]** |
| Mapbox on onboarding | Never loaded | **[Gate]** |

**Reference devices (D23), all provisional:**

| Role | Device | Status |
|---|---|---|
| Android reference | Samsung Galaxy S20 5G (SM-G981U1) | Available. OS and WebView versions to be recorded in QA. |
| Lower-end Android | Moto G Play (2024), 4 GB RAM | Proposed. Not acquired; **do not purchase** under this document. |
| Older iOS | iPhone SE (2nd generation) | Proposed. Its supported iOS must be ≥ the app's deployment target (**15.0**, verified); the exact iOS version is to be recorded. |

**QA must record:** device model, OS version, WebView/Safari version, build hash, network profile, battery and thermal state, and the measurement tool.

**No performance target may be described as met until it has been measured on these devices.**

**Rendering constraints:**
- Only `transform` and `opacity` animate (§3.2).
- No `backdrop-filter` on large surfaces, no SVG filters, no canvas, WebGL, or video.
- No new animation dependency without written justification.
- The scene component is loaded lazily, behind a solid placeholder.

---

## 10. Error, interruption, and empty-neighborhood states

### 10.1 Onboarding view

Unchanged from v1.1:
- Poster loading or failed: solid night background plus the SVG foreground, with every action available.
- A language switch mid-phase keeps phase, focus, and scroll.
- Rotation keeps state and snaps motion to its end.
- Backgrounding during N2 resumes at the N2 end state.
- Killing the app in N0–N3 restarts at N0, with no intention stored.

### 10.2 Sign-up interruptions

J6–J10 (§4) and §6.6. The intention is never consumed during sign-up, and is held while the profile is unconfirmed.

### 10.3 Zero, few, and many Pings

**[Verified]** Reading Pings requires a signed-in user allowed to use the product. Before sign-in, the scene is always illustrative and no live data is read. The map's existing empty chip reads "No active spots nearby".

| Situation | Behavior |
|---|---|
| `find`, zero Pings | Empty card: title and body (§8). Actions: move the map; street-cleaning rules (existing Street Intelligence entry); "Get notified about Pings" opens the existing gesture-bound card. No simulated markers. |
| `find`, Pings present | Existing chip and pins, unchanged |
| `find`, location declined | Map centers on `NYC_CENTER` ([Verified] default). The card links to the existing location settings view. |
| `leave` | §5.4 cases A–E. The Ping count doesn't matter. |
| `explore` | Real map plus the optional chip |
| Outside the service area | The same empty card. No coverage claims. |

---

## 11. Engineering implementation plan

Each slice is its own PR. **None is authorized by this document.** No slice changes rules, Cloud Functions, App Check, IAM, or deployment configuration.

| Slice | Scope | Acceptance criteria |
|---|---|---|
| **S0a** One `claimUsername` | `handleNameComplete` routes only | A test proves one callable invocation per sign-up. **[Security review]** |
| **S0b** One post-verification router | The bootstrap owns landing; `onVerify` marks success only | One view decision each for exists, missing, and unavailable. **[Security review]** |
| **S0c** Docs | Fix TM-23; refresh the performance baseline and conditions | Docs match code; numbers come from a recorded build |
| **S1** Device-state policy | `deviceStatePolicy.ts`; logout and deletion use the keep-lists | §5.2 table fully tested. `signOut` and FCM cleanup unchanged. **[Security review]** |
| **S2** Language controller | `languagePreference.ts`; `lang` projection; remove the `[user?.lang]` effect | §5.3 sequence and table tested, including §12.2 L1–L10. A rules-emulator test confirms the `lang`-only write is allowed for the owner and denied for others. **[Security review]** |
| **S3** Profile confirmation and landing resolver | `profileConfirmed`; `landingPrecedence.ts`; queue ready = `mandatoryComplete`; `actionable` flag on link sources; §6.3 re-route | Every P0–P10 rule tested, plus N1–N10 (§12.2). **[Security review]** |
| **S4** Intention storage | `onboardingIntent.ts` | Validation, TTL, consume-once, clear-on-logout/deletion, future-time rejection |
| **S5** Static neighborhood | Scene end states, panel, chooser, header, language switch, have-account link, flag `VITE_ONBOARDING_V2` (default off) | axe clean on N0–N3; every §2.3 size in EN and ES; Android Back per §3.1; legacy view unchanged with the flag off |
| **S6** Motion | §3.2 including the segmented signal | Only `transform`/`opacity` animate (code review checklist and a lint/grep check for forbidden properties in the new CSS and SVG); reduced motion shows final frames; fps floor measured on D23 devices |
| **S7** Vehicle out of sign-up | Remove `EDIT_VEHICLE` from sign-up; 3-step progress | New user reaches the location primer or map without the vehicle step; a Ping with no vehicle passes the existing rules tests |
| **S8** Ping location gate | `pingLocationGate.ts`, `PingLocationRow`, reason sheet, second check in `handleSaveSpot` | Cases A–E tested. No `getCurrentPosition` while the permission isn't `granted`. "Not now" writes nothing global (D19). Edit and My Car paths unchanged. |
| **S9** Map intention and vehicle suggestion | §6.5 surfaces, `autoStartTour`, empty-find card, D22 card | Consumed after opening; one overlay at a time; no fake markers; suggestion only after the first Ping |
| **S10** QA and launch readiness | Maestro rewrites, D23 device runs, performance measurement, D21 reviews | §12 passes; reviews recorded; founder approval to enable the flag in a shipping build |

**Order:** S0a → S0b → S0c, then S1 → S2 → S3, then S4, then S5 → S6, then S7, S8, then S9 → S10.

**Flag:** confirm the `productionBuildConfig*.test.ts` contracts before adding `VITE_ONBOARDING_V2`. It defaults to off for production.

---

## 12. Test matrix and acceptance criteria

### 12.1 Existing tests that will change **[Verified]**

| Test | Change |
|---|---|
| `views/OnboardingView.test.tsx`, `OnboardingView.androidBack.test.tsx` | Kept for the legacy view (flag off); new equivalents for the neighborhood |
| `App.authStartup.test.tsx` ("Get Started" at lines 263, 298, 306, 325; notification-consent tests) | Becomes flag-aware; the queue readiness change needs new assertions |
| `utils/androidBackNavigation.test.ts`, `hooks/useAndroidSystemBack.test.tsx` | Phase-based onboarding Back; the vehicle-onboarding branch is removed (S7) |
| `views/CreateAccountView.legal.test.tsx` | The legal notice stays; headline expectations change |
| `views/NameEntryView.criticalActions.test.tsx` | One callable call (S0a) |
| `views/street-parking/AppTour.*.test.tsx` | `autoStartTour` |
| `utils/authBootstrap.test.ts` | `lang` projection; `profileConfirmed` helpers |
| `utils/languageHydration.test.ts` | Replaced or absorbed by the controller tests (the effect is removed) |
| `utils/notificationNavigation.test.ts`, `utils/notificationIntent.test.ts` | `actionable` flag; readiness gate |
| `utils/deleteAccountFlow.test.ts`, `utils/locationAccess.test.ts` | Keep-lists; D19 (no global write from the Ping gate) |
| `e2e/accessibility.spec.ts` | Every phase and the new surfaces |
| `.maestro/auth-new-user.yaml`, `auth-existing-user.yaml`, `vehicle-onboarding.yaml` (+ check `core-handoff-*`) | Rewritten. They currently depend on "Get Started", "See spots opening near you", "Save your car. Know the rules.", "Step N of 4", "What's your number?", and the vehicle step. |

### 12.2 New unit and integration scenarios

**Language (S2):**

| # | Scenario | Expected |
|---|---|---|
| L1 | Marker ES, account `en` (authoritative) | ES kept; `lang: 'es'` written; marker cleared after the write succeeds |
| L2 | No marker, account `es` (authoritative) | Device switches to ES once |
| L3 | No marker, account absent | Device language kept and written to the account |
| L4 | Marker set; **the first snapshot is cache-only with account `en`** | No `setLang('en')`. The device language holds until resolution. |
| L5 | **Delayed preferences:** no authoritative snapshot within 4 s | Device language kept. Resolution re-runs when the first authoritative snapshot arrives. |
| L6 | **Offline** (`navigator.onLine === false`), marker set | Device language kept. Write attempted. On failure, the marker survives a simulated restart and resolves on the next online start. |
| L7 | **Interrupted authentication:** marker set, app killed during the code step, relaunched within 24 h | Marker still applies after sign-in |
| L8 | Marker older than 24 h | Treated as absent; the account wins |
| L9 | **Account switch:** a write for UID A is in flight when UID B signs in | A's completion is ignored. B resolves on its own. A's marker was already cleared at logout. |
| L10 | After resolution, another device changes the account language to `es` (authoritative) | Device switches once. Its own echoed write does not trigger a loop. |

**Navigation (S3):**

| # | Scenario | Expected |
|---|---|---|
| N1 | Actionable `ping` link arrives during `SETUP_PROFILE` | Held. Runs after username and location primer. Intention discarded. |
| N2 | Actionable link with profile `unavailable`, not confirmed | Map shown (P5); link held until confirmed, then runs |
| N3 | Profile `unavailable`, later confirmed **missing** by server snapshot | Routed to `SETUP_PROFILE`; link and intention held |
| N4 | Cache-only `exists()` snapshot | Not confirmed; held |
| N5 | Not-actionable link plus a pending `find` intention | Generic fallback dropped; `find` surface opens (D18) |
| N6 | Not-actionable link, no intention | Existing Notifications fallback |
| N7 | Actionable link whose spot is gone | Existing unavailable fallback; still handled; intention discarded |
| N8 | Intention pending while an overlay is open | Waits; applies once after the overlay closes |
| N9 | `locationAccess === 'unknown'` with link and intention | `LOCATION_PROMPT` first; both held |
| N10 | Admin domain | Unchanged admin routing; link and intention ignored |

**Location gate (S8):** cases A–E on each platform adapter (mocked):
- No `requestLocationPermission` call without Continue.
- "Not now" leaves `locationAccessChoice` unchanged.
- A cancelled publish tap does not publish after a later grant.
- Edit and My Car paths are unchanged.

**Vehicle suggestion (S9):**

| # | Scenario | Expected |
|---|---|---|
| V1 | First Ping succeeds; authoritative counter `0` or absent; no vehicle; no guard set | Shown once; the guard is set when it shows |
| V2 | Edit of an existing Ping, failed publish, or rate-limit denial | Not shown |
| V3 | My Car departure Ping succeeds (first Ping) | Shown (same conditions as V1) |
| V4 | Publish → finder cancel → publish again before the trigger runs (counter still `0`) | **Not** shown the second time (guard) |
| V5 | Only a cached user snapshot is available at success | Skipped |
| V6 | Logout and sign in again on the same device with the counter still absent | Not shown (guard kept through logout) |
| V7 | Account deletion, then a new account on the device | Eligible again (guard cleared on deletion) |
| V8 | "No thanks" or ignored | Never re-shown on this device |
| V9 | Copy | States that it affects future Pings only |

**Profile confirmation and redirect (S3, from the Q7 review):**

| # | Scenario | Expected |
|---|---|---|
| P1 | Bootstrap `getDoc` returns `exists` from cache | Unconfirmed; link and intention held |
| P2 | Account deletion in progress; listener reports missing from server | **No** redirect; the deletion flow signs out |
| P3 | Signout fails after a successful `deleteAccount`; listener reports missing | Forced token refresh fails, so the client signs out; no redirect |
| P4 | Disabled Auth account with a still-valid token; profile missing | Token refresh fails, so the client signs out |
| P5 | Genuine missing profile (killed before username, then restarted while offline) | Token refresh succeeds, so the user is redirected to `SETUP_PROFILE` |
| P6 | Link held, then explicit logout, then a different account signs in | Link dropped |
| P7 | Link held more than 15 min | Dropped |

**Language window (S2, D25):**

| # | Scenario | Expected |
|---|---|---|
| W1 | Marker ES present; authoritative snapshot with account `en` arrives **before** the write is acknowledged | No `setLang('en')`; ES holds |
| W2 | Offline; write pending; app restarted; marker still under 24 h | ES holds; write retried; marker cleared only after acknowledgement |
| W3 | Offline or interrupted sync until the marker expires (24 h) | After expiry, the next authoritative snapshot applies the account language. The device `parqueen_lang` still exists, and is updated to the account value. |
| W4 | Restart and logout with no marker | Device `parqueen_lang` and account `lang` both still present |
| W5 | Signed-in change in `LanguageSettingsView` while a marker exists | Write succeeds, then the marker is cleared and the new value persists |

**Motion (S6):** no forbidden animated properties in the new CSS or SVG; reduced motion shows every L5 segment statically.

### 12.3 Scenario matrix (device and E2E)

| # | Scenario | Platforms | Pass criteria |
|---|---|---|---|
| 1 | New install, EN, motion: demo → find → sign up → map | iOS, Android, web | Real map; intention consumed once |
| 2 | New install, ES, reduced motion | iOS, Android | All Spanish; no animation |
| 3 | Leave, permission `prompt` → composer opens → "Use my location" → reason sheet → Not now | iOS, Android, web | No OS dialog; no Ping; `locationAccessChoice` unchanged; retry works |
| 4 | Leave, permission `prompt` → Continue → grant | iOS, Android, web | Location row resolves; publish needs a fresh tap |
| 5 | Leave, OS permission denied | iOS, Android, web | Inline guidance; no dialog; no Ping |
| 6 | Leave, permission granted with coordinates present | all | Composer immediately usable (case A); no extra step |
| 7 | Explore | all | No automatic tour; the chip starts it |
| 8 | "Already have an account?" | all | No intention key |
| 9 | Logout → relaunch | all | Phone screen; language and theme kept; account keys gone |
| 10 | Deletion → relaunch | all | N0; language and theme kept |
| 11 | Kill during the code step, relaunch < 24 h | iOS, Android | New code required; intention and language marker kept |
| 12 | Startup offline after verification, then reconnect | iOS, Android | Map (P5); links and intention held; correct routing once confirmed |
| 13 | Zero Pings, find | all | Honest empty card |
| 14 | Real Pings (test fixtures only), find | all | Existing pins only |
| 15 | Android Back through every phase and surface | Android | Per §3.1; no loops |
| 16 | Rotate during N2 and N3 | iOS, Android | No lost state or clipping |
| 17 | 200% text, 320×568, landscape, ES | iOS, Android | No clipping |
| 18 | VoiceOver, TalkBack, keyboard | iOS, Android, web | Every action reachable |
| 19 | First Ping without a vehicle | all | Suggestion appears once with future-only copy; never again |
| 20 | Low-end performance | D23 devices | FCP < 2.5 s; N2 ≥ 45 fps; first-paint art ≤ 120 KB, **measured and recorded** |

### 12.4 Global acceptance criteria

1. No onboarding PR changes `firestore.rules`, `storage.rules`, `functions/**`, App Check, IAM, or deploy configuration.
2. Zero Ping reads before sign-in. Zero fabricated markers on the real map.
3. One `claimUsername` per sign-up. One owner each for the landing view, account-driven `setLang`, and link execution.
4. No Ping without an explicit publish tap made **after** the location was shown. No OS location dialog without the reason sheet first.
5. No link or intention runs while the profile is unconfirmed, while the username is missing, or before the location primer has resolved.
6. Every phase works with no motion, a screen reader, large text, and Skip and Back.
7. Typecheck, build, unit tests, rules-unit tests (lang write), axe on every surface, and Maestro all pass.
8. The D17 performance gates are **measured** on D23 devices against a fresh baseline.
9. The D21 reviews are recorded as complete before public release.

---

## 13. Change log

### v1.1 → v1.2

| Area | v1.1 | v1.2 | Reason |
|---|---|---|---|
| Decisions | D1–D17, Q1–Q6 open | D18–D23 added; Q1–Q6 resolved | Founder direction |
| Malformed links | Proposed (Q1) | D18; P7/P9 split; `actionable` flag | Q1 |
| Ping "Not now" | Recommended persisting `declined` | Cancels the attempt only; no global write (D19) | Q2 |
| Ping location gate | Gate before every new-Ping composer | Gate only when an OS request is needed; composer always opens; cases A–E; publish disabled until coordinates; a cancelled tap never publishes | Correction 1 |
| Language | Precedence table; existing hydration effect kept | One controller owns account-driven `setLang`; hydration effect removed; lock until profile and authoritative preferences; marker TTL; UID guard; offline handling given the in-memory cache | Correction 2, D20 |
| Profile in the resolver | `unavailable` counted as complete | `profileConfirmed` required; cache-only `exists` does not count; P5 hold; §6.3 re-route when later confirmed missing **[Security review]** | Correction 3 |
| Signal animation | Stroke reveal | Discrete segments animated by `opacity` and `transform` only; forbidden-property list | Correction 4 |
| Vehicle suggestion | Composer hint, first three Pings | One card after the first published Ping, using the server counter; future-only copy; no new storage | Q5, D22 |
| Reviews | Q4 open | D21; explicit "not started" gates | Q4 |
| Devices | Q6 open | D23 table; iOS target 15.0 verified; recording requirements | Q6 |
| Facts added | — | Firestore uses the in-memory cache; `productAccessDenied` treats a missing profile as not denied; the live profile listener doesn't re-route on missing; `pingsShared` counter location | Verification for v1.2 |
| Slices | S0–S9 | S0–S10 (language and resolver split into S2 and S3; new gate and suggestion components) | Scope changes |

### v1.2 decision closure (no version change)

| Area | Change | Reason |
|---|---|---|
| Decisions | D24–D26 added; Q7–Q9 closed; §14.3 has no open questions | Founder closure |
| Profile confirmation | A cache-served bootstrap `exists` no longer confirms (F6) | Q7 review; contract C1 |
| §6.3 redirect | Safeguards: no redirect during or after deletion; forced token refresh; UID and generation re-check | Q7 review F1–F3 |
| Link queue | Drop held links on logout and account switch; 15-minute maximum age | Q7 review F4–F5 |
| Language | Explicit "precedence window"; settings change clears the marker; only the marker expires | Q8, D25; contract C2 |
| Vehicle suggestion | Three guards (authoritative counter, device guard kept through logout, session flag); My Car Ping included; cached snapshot means skip | Contract C3; asynchronous trigger verified |
| Tests | V1–V9, P1–P7, W1–W5 added | Closure |
| New section | §15: closure, security review, contract verification, remaining risks | Founder direction |

### v1.0 → v1.1 (retained)

- Corrected the `logoutUser()` facts and flagged TM-23 as out of date.
- Added explicit device keep-lists, language sync and hydration-gap documentation, logout leading to phone sign-in, the Ping location explanation, the deep-link resolver, and the deferral of vehicle details.
- Made the tour opt-in for explore, revised the performance budgets, and specified the S0 pre-fixes, the exact test dependencies, the expanded copy, and the 3-step sign-up.

---

## 14. Outstanding review gates, unresolved risks, and open questions

### 14.1 Review gates (none completed)

| Gate | Owner | Status |
|---|---|---|
| Native Spanish editorial review (NYC audience) | Editor to be named | **Not started** |
| Legal review: trust statements, Terms/Privacy implications | Counsel to be named | **Not started** |
| Founder product, design, and editorial approval | Founder | **Pending** |
| Security review, **design level (Q7, read-only)**: profile confirmation, missing-profile redirect, link gating | Claude (read-only) | **Done**: §15.2. Findings F1–F6 are now design requirements. |
| Security review, **implementation level**: S0a, S0b, S1, S2, S3 code | Security reviewer | **Not started** (no code exists) |
| Device validation: Galaxy S20 (initial reference) | QA, founder (D26) | **Not started** |
| Device validation: lower-end Android and older supported iPhone | QA, founder (D26) | **Not started. Required before final release QA approval.** Devices not yet available; no purchase authorized. |
| Fresh performance baseline | Engineering | **Not measured** |
| Design gate B: high-fidelity mockups, prototype, comprehension testing with Bronx drivers | Design | **Not started** |

### 14.2 Unresolved risks

1. **Unverified iOS location behavior.** Whether `getCurrentPosition` prompts on iOS is assumed, not verified. The §5.4 design doesn't depend on the answer (no OS request without the reason sheet), but QA must confirm.
2. **The §6.3 re-route is a navigation change after authentication.** Until it is approved, a user whose profile read timed out and who has no profile can still land on a map where product actions fail. This is pre-existing behavior, not introduced by onboarding.
3. **Holding links while the profile is unconfirmed (P5)** may delay a notification tap when the network is slow. This is the price of correction 3, and it is bounded by when the listener confirms.
4. **The language write is lost if the app is killed offline** (in-memory cache). It is mitigated by the durable marker, but a marker older than 24 h falls back to the account language.
5. **Legacy users with no `pingsShared` counter** may see the vehicle suggestion once.
6. **The segmented signal may read differently from a continuous stroke.** Design gate B must confirm it still reads clearly as "a heads-up travels".
7. **The performance budget is tight.** The 233 kB gzip main bundle (July figure) plus 120 KB art against the 500 kB total leaves little headroom until re-measured.
8. **Maestro and test churn** is large because the tests depend on exact copy. Stage the rewrites with S5 to avoid breaking CI.
9. **Missing reference hardware** (Moto G Play 2024, iPhone SE 2) blocks the low-end and older-iOS gates.
10. **TM-23 and the performance doc are out of date**, so reviewers could be misled until S0c lands.

### 14.3 Open questions for the founder

**None. Q1–Q9 are closed** (D18–D26). The new risks from the closure review are in §15.4.

---

## 15. Decision closure, security review, and contract verification

### 15.1 Final decisions recorded

- **Q7 → D24:** approved, as a separate read-only review (§15.2).
- **Q8 → D25:** approved, with the condition that only the precedence marker expires (§5.3).
- **Q9 → D26:** approved. The founder owns device availability (§9.2, §14.1).

The blueprint version stays **v1.2**. These answers are recorded here without a new numbered version, as the founder directed.

### 15.2 Q7 read-only security review: profile confirmation, missing-profile redirect, link gating

**Scope and method:** I inspected the source at `bff07e9`. No code was run and nothing was changed. Files: `App.tsx` (bootstrap, listeners, notification queue, delete flow), `database.ts` (`deleteUser`, `logoutUser`), `utils/authBootstrap.ts`, `utils/notificationNavigation.ts`, `utils/notificationIntent.ts`, `firestore.rules` (`productAccessDenied`, `actorMayUseProduct`), and `functions/index.js` / `functions/productAccess.js` (`claimUsername`, `assertProductAccess`).

| ID | Finding | Evidence | Severity (design) | Required design response |
|---|---|---|---|---|
| **F1** | **Account deletion removes the profile while the client is still signed in.** The proposed §6.3 redirect would fire during deletion and send the user to `SETUP_PROFILE`. | **[Verified]** `deleteUser()` awaits the `deleteAccount` callable (which deletes the `users/{uid}` tree, with Auth deleted last), and only **then** calls `signOut` ([database.ts:57-62](../../../database.ts)). The live `users/{uid}` listener in App stays subscribed throughout. | High (if built without safeguards) | §6.3 safeguard (a): suppress the redirect while deletion is in progress or after it has completed |
| **F2** | **If `signOut` fails after a successful deletion**, a deleted Auth user's still-valid ID token could reach `SETUP_PROFILE` and call `claimUsername`, recreating a `users/{uid}` document for a deleted account. | **[Verified]** `assertProductAccess` allows a missing profile ("first-time onboarding has no profile"), and `claimUsername` bootstraps a new account when none exists. **[Not verified]** Whether callable token verification rejects tokens of deleted users before they expire. I treat it as **not** rejected, since standard ID-token verification does not check revocation unless asked. | High (if built without safeguards) | §6.3 safeguard (b): force a token refresh before redirecting; sign out on failure. **Optional server hardening** (a separate future security proposal; not authorized): have `claimUsername` confirm the Auth user exists and is enabled. |
| **F3** | **A disabled Auth account behaves like F2** until its token expires. | Same evidence as F2 | Medium | Covered by safeguard (b) |
| **F4** | **A held notification link survives logout and could run for the next account.** | **[Verified]** The queue lives for the App's lifetime. `setReady` only flips readiness; `pending` is not cleared on logout ([utils/notificationNavigation.ts:25-53](../../../utils/notificationNavigation.ts)). Impact is limited to navigation: the rules still gate every read. | Low (pre-existing) | Drop held links on logout and on account switch (§6.4) |
| **F5** | **Held links have no age limit.** A link held through a long sign-up or offline period could navigate unexpectedly. | **[Verified]** No timestamp is stored with the held link | Low | 15-minute maximum age (§6.4) |
| **F6** | **The bootstrap's profile existence check discards whether the answer came from the server.** A cache-served `exists` would count as confirmed. | **[Verified]** `lookupProfileBootstrapStatus` → `classifyProfileSnapshot(snap.exists())` ([utils/authBootstrap.ts:194-210](../../../utils/authBootstrap.ts)) | Medium (for contract C1) | Pass `fromCache` through; cache-served `exists` = unconfirmed (§6.2) |

**Confirmed safe properties [Verified]:**
- **Links only navigate.** Links from all three sources normalize to `ping` (sanitized spot ID), `my_car`, or `notifications`, and running one only sets view state and `pendingSpotId`/`pendingMyCarOpen`. A crafted URL fragment cannot write data. Ping reads stay gated by the `spots` rule.
- **The admin domain never runs consumer links.** App does not set `user` on the admin domain, so `!!user?.id` stays false and the queue never becomes ready.
- **Adding `profileConfirmed` and `mandatoryComplete` to the ready flag only removes paths** (it holds links longer). It cannot newly expose any screen or data.
- **The onboarding intention cannot do more than a link.** It is never read by rules, callables, or authorization code. Tampering with it selects among three already-permitted surfaces.

**Residual after safeguards:** deletion is a race between the server deleting the profile and the client signing out. With safeguards (a) and (b) the redirect cannot fire during it. Server-side hardening (F2, optional) would remove the remaining dependency on correct client behavior. It needs its own proposal and authorization.

### 15.3 Contract verification

| Contract | Verdict | Basis |
|---|---|---|
| **C1** Unconfirmed profiles never count as confirmed for link or intention execution | **Holds as designed, after correction F6.** | `profileConfirmed` (§6.2) accepts only: a server-sourced `getDoc` `exists` (F6), a `!fromCache` listener `exists`, or a successful `claimUsername` in this session. `mandatoryComplete` requires `profileConfirmed` (§6.4), and P6–P9 (link, intention, generic fallback) all require `mandatoryComplete`. P5 explicitly **holds** both while the status is `unavailable`. Language resolution (§5.3 step 2) also waits for confirmation. Tests: N2–N4, P1. |
| **C2** Language hydration cannot overwrite an explicit local selection during its precedence window | **Holds as designed.** | **[Verified]** Today only the App hydration effect and `LanguageSettingsView` call `setLang`. The design removes the effect, and the controller is the only account-driven caller. While the marker is valid, account-driven `setLang` is forbidden in every step, including authoritative snapshots that arrive before the write is acknowledged (§5.3 "Precedence window"). Tests: L1, L4–L7, L9, W1–W3, W5. |
| **C3** The vehicle suggestion appears only after successful publication, is dismissible, and does not repeat because of missing or delayed counters | **Holds after the closure correction to §5.5.** | It is triggered only by success callbacks for new Pings. It needs an authoritative counter read (cache means skip). The device guard is set when the card shows and is kept through logout, so a delayed trigger (**[Verified]** asynchronous `incrementTotalSpotsPinged`) or an absent counter cannot cause a repeat on the device. Residual: at most once more per additional device. Tests: V1–V9. |

### 15.4 Remaining risks (supplements §14.2)

1. **F2 server-side dependency.** Until optional server hardening is proposed and authorized, preventing re-creation after deletion depends on correct client behavior (safeguards a and b).
2. **An unverified assumption in F2:** whether callable token verification rejects tokens of deleted users. It should be confirmed in a separate review. The design is safe either way, because of the safeguards.
3. **The vehicle suggestion can appear once per additional device** while the counter lags or is absent. Accepted.
4. **Expiry of the explicit language choice** after 24 h of failed sync means the account language wins. That follows D20 and D25, but the user may notice their pre-sign-in choice revert. QA must confirm the experience feels acceptable.
5. **Reference hardware:** lower-end Android and an older supported iPhone are still unavailable. **Final release QA approval is blocked until they are tested** (D26).
6. **The external reviews in D21 are not started.**
7. **The car-details flag is shared across accounts (flagged at Gate B for later engineering review).** `parqueen_vehicle_hint_done_v1` is one device-level bit and is kept through logout (§5.2). If account A sees the suggestion, account B signing in on the same device never sees it after B's first Ping. That is a cross-account coupling: it is not a data leak, but a product miss.
   - **Option 1:** clear the bit on logout. This removes the coupling, but the same account can see the suggestion once more after signing back in while the server counter lags or is absent.
   - **Option 2:** key the flag per account (for example, a salted hash of the UID). This removes the coupling, but leaves an account-derived marker on the device after logout.
   - Either option needs an engineering and privacy decision before S9. **Not resolved. Out of scope for visual design.**

---

*End of Blueprint v1.2 (decisions closed). This document authorizes no implementation, dependency installation, equipment purchase, or repository change beyond revising this file. The next phase is visual design.*
