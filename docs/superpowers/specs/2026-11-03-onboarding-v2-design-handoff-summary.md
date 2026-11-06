# DESIGN_HANDOFF_SUMMARY: ParQueen Onboarding 2.0, Interactive Neighborhood

**For: final visual mockups (Design gate B) · November 3, 2026**
**Source of truth:** [Blueprint v1.2](2026-11-03-onboarding-v2-interactive-neighborhood-design.md). Section numbers below (§) refer to it. If this summary and the blueprint disagree, the blueprint wins.

**Scope.** Visual design only. No implementation is authorized. All copy is draft until the native Spanish editorial review and the legal review (D21) are done; neither has started.

---

## 1. Non-negotiables for every frame

- **One continuous street scene.** Phases change emphasis, never the camera or the composition. No slides and no pagination dots.
- **"Illustrative example · Not live activity"** is visible in every onboarding frame. It is emphasized in N2.
- **Nothing implies a guarantee.** No reserved curb, cones, gates, checkmarks on the curb, countdowns, addresses, distances, counts, or a car pulling into the space.
- **Original art.** No real addresses, brands, readable plates, or landmarks. No words inside the artwork; every word is live text.
- **Fixed night palette** for the scene. Panels and controls use the app's semantic tokens and must work over the scene in both the light and dark app themes.
- **No blur effects.** Panels sit on a solid semi-opaque scrim.

---

## 2. Visual states to mock up

### 2.1 Onboarding scene (§2.2, §3.1)

| ID | State | Must show |
|---|---|---|
| N0 | Arrival | Header (logo; EN/ES switch; "Already have an account?"), scene at rest, example badge, headline, supporting line, "See how it works", "Skip example" |
| N1 | Departing driver | Halo on the parked car (L3); instruction line; "Show an example Ping" button. The car itself is also tappable. |
| N2-mid | Example Ping in progress | Ping rising above the car (L4); **a partly lit segmented signal** (L5: 4–6 separate segments or dots, not a continuous line); trust line visible |
| N2-end | Example Ping complete | Ping, every signal segment lit, "heads-up received" cue on the searching car (L6, not a checkmark or a P symbol); headline, explanation, trust line, "Continue" |
| N3-seen | Choose purpose (demo seen) | N2-end scene frozen; panel risen with heading, supporting line, three intention buttons, trust line |
| N3-skipped | Choose purpose (skipped) | N0 scene; same panel; badge visible |
| RM | Reduced motion | N2-end with every signal segment shown as a **static dotted path**. This frame must read clearly with no animation. |
| ART-FAIL | Poster failed or loading | Solid night background plus only the foreground SVGs; all text and actions present |

### 2.2 Product surfaces touched by onboarding

| ID | State | Must show |
|---|---|---|
| A1 | Phone screen | "Step 1 of 3", new headline and helper, EN/ES switch, **Terms and Privacy notice with links (must remain)** |
| A2 | Code screen | "Step 2 of 3" (layout otherwise unchanged) |
| A3 | Username screen | "Step 3 of 3" (layout otherwise unchanged) |
| L-B | Composer: locating (case B) | Composer open, location row shows "Locating…", publish enabled once a location exists |
| L-C | Composer: location needed (case C) | Row "Location needed to place this Ping" with "Use my location"; publish **disabled**, with the reason visibly tied to the row |
| L-R | Location reason sheet | Title, body, "Continue", "Not now" |
| L-X | "Not now" result | Composer still open, publish disabled, "No Ping was shared. You can try again anytime." |
| L-D | Permission denied (case D) | Inline guidance (separate iOS, Android, and web variants), "Check again" |
| L-E | Services off or unavailable (case E) | Inline message and "Check again" |
| L-F | Location timed out | "Couldn't get your location" and "Try again" |
| M-F0 | Map, find, zero Pings | Empty card: title, body, "move the map" affordance, street-cleaning rules entry, "Get notified about Pings". **No pins.** |
| M-FD | Map, find, location declined | Map centered on the NYC default; card links to location settings |
| M-E | Map, explore | Real map with a dismissible "Show me around" chip; **no automatic tour** |
| V-S | Vehicle suggestion | Non-modal card after the first Ping: "Add car details (optional)", future-Pings-only explanation, "Add details", "No thanks" |

---

## 3. Required frame matrix

For **N0, N1, N2-end, N3-seen, A1, L-C, L-R, M-F0, V-S**:

| Axis | Values |
|---|---|
| Size | 320×568 · 375×667 · 430×932 · landscape 667×375 |
| Language | EN · ES (Spanish runs about 25–30% longer; use it to test the layout) |
| App theme | Dark · Light (the scene stays night; controls switch) |
| Text size | 100% · 200% (at least for 375×667 portrait) |

All other states: 375×667 EN dark plus 375×667 ES light, at minimum.

**Layout rules (§2.3):**
- **Normal portrait:** the scene fills about the upper 55–65%.
- **Short screens:** the panel has priority and the scene may shrink to about 38%. The panel scrolls with a visible fade edge. CTAs and all three intention buttons are never clipped.
- **Landscape:** the scene takes the left 50–55% and the panel the right.
- **Focal safe zone:** the departing car and the Ping must stay inside the center 60% width × middle 50% height of every crop.

---

## 4. Assets to produce (§7.2)

| Asset | Deliverable | Budget / spec |
|---|---|---|
| Master neighborhood illustration | Layered source; departing car (near curb) and searching car (far lane) on a locked grid | Original; blue hour; brick, stoops, trees, warm windows, public curb |
| Portrait poster | 4:5 crop at widths 390 / 780 / 1170 | **≤ 120 KB transferred** for the chosen variant (WebP q≈70; AVIF too) |
| Landscape poster | 16:9 crop at widths 667 / 1334 / 2001 | Same budget |
| L1 departing car and driver | SVG | Part of the ≤ 25 KB foreground total |
| L2 searching car (headlights) | SVG | ″ |
| L3 halo | SVG or CSS shape | ″ |
| L4 Ping marker | Reuse the production Ping shape (single shared primitive) | ″ |
| L5 signal | **4–6 separate segments or dots** on one path, each its own layer | ″; no continuous stroke |
| L6 awareness cue | SVG glyph (notification-dot style) | ″ |
| Optional detail overlays (window glow, foliage) | Separate layers | Loaded after first paint; never required |
| Static dotted-path variant of L5 | For reduced motion | — |

Background color sample: provide the average sky color to use as the placeholder, to avoid a flash on load.

---

## 5. Interactions and motion to prototype (§3.1, §3.2)

Only position/scale (`transform`) and fade (`opacity`) may animate. No blur, masks, clip paths, stroke drawing, or path morphing.

| Trigger | Result | Timing |
|---|---|---|
| Load N0 | Panel fades in and settles 8 px | 220–300 ms |
| "See how it works" | N1: halo appears once, then holds | 160–220 ms |
| "Show an example Ping" or tap the car | Ping rises 14 px and fades in | 220–280 ms |
| ″ continued | Signal segments light one by one (each ≤ 4 px drift) | 70–100 ms stagger; 450–600 ms total |
| ″ continued | Awareness cue scales 0.9→1 and fades in | 180–220 ms; whole sequence about 0.9–1.4 s |
| "Continue" (even mid-sequence) | Scene snaps to its end state; N3 panel rises (up in portrait, from the right in landscape) | 220–280 ms |
| "Skip example" | Straight to N3 (no intention chosen) | 220–280 ms |
| Back | N3→N2 (or N0 if skipped) → N1 → N0 → app minimizes; no reverse animation | instant state swap |
| Intention button | Press feedback, then leaves to the phone screen | ≤ 130 ms |
| EN/ES | Text swaps in place; phase, focus and scroll stay | instant |
| Rotate | Layout swaps; phase and choices stay; motion snaps to its end | instant |

**Rules:**
- No automatic advance, no infinite loops, no flashing.
- Text and buttons never wait for animation.
- Every animated moment needs a reduced-motion frame (RM).

---

## 6. Accessibility annotations to include in the mockups (§9.1)

- **Touch targets:** at least 44 pt (iOS) and 48 dp (Android). This includes the header links and the EN/ES switch.
- **Text:** body ≥ 15 px, supporting ≥ 13 px. The badge may be ≥ 12 px only at 4.5:1 contrast.
- **Contrast:** text 4.5:1; large text and essential boundaries 3:1. Check it **over the scene** in both themes.
- **Focus:** visible focus ring (≥ 3:1). Annotate where focus moves on each phase change (to the phase heading).
- **Screen-reader descriptions:** annotate the scene's alt text, the intention-group label, and the reason a disabled publish button is disabled (L-C).
- **Don't rely on color alone:** the location states and the example badge must not depend on color.

---

## 7. Copy to place

Use the EN/ES table in Blueprint §8, verbatim. Every string is a **draft pending D21 reviews**. Banned phrases: "reserve", "guaranteed spot", "a spot just opened near you" (in the illustration), and "you're covered until…".

---

## 8. Design gate B exit criteria

1. Every state in §2 is mocked at the §3 matrix.
2. A clickable N0→N3 prototype with the §5 timings, plus a reduced-motion variant.
3. Asset exports meet the §4 budgets (sizes measured and recorded).
4. Comprehension testing with Bronx street-parking drivers. Confirm that:
   - nobody believes the example shows live activity;
   - nobody believes a Ping reserves or guarantees a space;
   - the segmented signal reads as "a heads-up travels".
5. Founder approval of the visual direction. The Spanish editorial and legal reviews are scheduled.
