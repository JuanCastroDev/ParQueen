# Loading states

ParQueen has one loading language: the ParQueen logo with a slow pulse. Don't
use generic spinners (Tailwind `animate-spin`, lucide `Loader2`/`LoaderCircle`,
FontAwesome `fa-spin`/`fa-spinner`, hand-rolled rotating rings).
`components/loadingStandard.contract.test.ts` fails CI if one is added to the
client source.

Every loading state comes from `components/LoadingScreen.tsx`:

| Component | Use it for | Looks like |
| --- | --- | --- |
| `LoadingScreen` | App- or screen-level waits: boot, `Suspense` fallbacks, map initialization, a screen whose data isn't ready yet. Pass `className="absolute inset-0 …"` to use it as an overlay. | 160 px crown logo, centered on the app background |
| `SectionLoader` | One region of an otherwise visible screen, such as a list or a panel, optionally with a caption as `children`. | 48–64 px crown logo, plus caption |
| `InlineLoader` | Button- or field-sized work, such as submitting or checking a username. | ParQueen pin glyph in `currentColor`, 13–28 px |

## Rules

- **Pick by scope, not by taste.** A whole screen gets `LoadingScreen`. A part
  of a screen gets `SectionLoader`. A control gets `InlineLoader`. Never put the
  full logo inside a button.
- **Accessibility.** `LoadingScreen` and `SectionLoader` are `role="status"`
  regions. Give `SectionLoader` a `label` when it has no visible caption.
  `InlineLoader` is decorative by default. The control should set `aria-busy`
  or change its text. Pass `label` only when the loader is the only signal,
  for example an icon-only button.
- **Reduced motion.** The pulse (`.pq-brand-pulse` in `index.css`) runs only
  under `prefers-reduced-motion: no-preference`. Otherwise the logo is static.
- **One phase.** Every loader starts its pulse in phase with the document
  clock. A hand-off from one loader to the next (boot frame → `Suspense` →
  map overlay) therefore never visibly restarts the animation.
- **Loaders never own errors or timeouts.** Keep the screen's existing
  timeout, retry and error UI, and swap the loader out for it. Examples:
  `AuthStartupRecovery` and the map's `map.load_failed` state. A loader must
  never be the only thing on screen once the work has failed.
- **No artificial delay.** Show a loader only while real work is pending.
- **Skeletons are fine.** A content-shaped placeholder that pulses, such as
  the Street Intelligence card skeleton, is not a spinner and can stay.

## Boot sequence (cold start)

1. **Native splash.** On Android, AndroidX core-splashscreen (`AppTheme.NoActionBarLaunch`
   in `android/app/src/main/res/values/styles.xml`) draws the ParQueen logo
   (`drawable-nodpi/pq_splash_logo.png`, rendered from `assets/Parqueen_Logo.png`
   at the same 160 dp width and centering as the web loader) on
   `pq_launch_background` (#050d1c, the dark `--color-bg`). The app window and
   the Capacitor WebView (`android.backgroundColor`) use the same color until
   the first web frame, so there is no white flash. `MainActivity` holds the
   launch screen (`setKeepOnScreenCondition`) until the WebView commits its
   first frame (`onPageCommitVisible`), capped at 2.5 s, so the native logo
   hands straight to the identical web boot logo. The splash logo sits 12 dp
   below center because the WebView starts below the status bar.
   Regenerate it with `scripts/android/render-splash-logo.cjs`. iOS still uses its
   storyboard launch screen.
2. **`index.html` boot frame.** `#root` contains the same markup as
   `<LoadingScreen />`. The logo is the same bundled asset, so it is painted
   before the JS bundle downloads or runs. There's no blank frame.
3. **`public/theme-boot.js`.** This same-origin classic script runs before
   first paint (the Hosting CSP forbids inline scripts). It applies the saved
   `dark`/`light` class, so the boot frame never flashes the wrong background.
   It skips the public legal pages, which have always rendered light.
   It also runs a boot watchdog. If the app bundle fails to load, or throws
   before React renders, the logo is replaced with the same "couldn't finish
   starting / Try again" recovery that `AuthStartupRecovery` shows. This
   happens at once on a script load error, or after 15 s. A late load still
   replaces it normally. The logo can never pulse forever.
4. **React's first commit.** React replaces the boot frame with
   `<LoadingScreen />` (auth restore, lazy routes). The logo, size and position
   are identical, and the pulse stays in phase.
5. **Map screen.** The map shows `<LoadingScreen label="Loading map" />` as an
   overlay until Mapbox fires `load`. If Mapbox fails, the overlay shows
   `map.load_failed` with a retry instead.

## Outside our control

The OS draws some loading UI itself. These stay as they are:

- the Android 12+ system splash animation (we only supply its icon and color)
- the Google reCAPTCHA widget used by web phone sign-in
- the browser's own page-load indicator
- the OS location and notification permission sheets
