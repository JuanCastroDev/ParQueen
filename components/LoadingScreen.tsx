import React, { useState } from 'react';
import ParQueenLogo from '../assets/Parqueen_Logo.png';
import ParQueenPin from '../assets/Parqueen_Pin.png';

/**
 * ParQueen's one loading language. Every loading state uses one of these
 * three components instead of a generic spinner (see docs/LOADING_STATES.md):
 *
 * - LoadingScreen   app- or screen-level wait (boot, lazy routes, map init,
 *                   a screen whose data is not ready yet)
 * - SectionLoader   one region of an otherwise visible screen (a list, a
 *                   panel), optionally with a caption
 * - InlineLoader    button/field-sized work (submit, availability check),
 *                   drawn in currentColor so it fits the surrounding control
 *
 * All three share one pulse (.pq-brand-pulse in index.css) kept in phase with
 * the document clock, so a hand-off between two loaders (index.html boot →
 * Suspense fallback → map overlay) never visibly restarts the animation.
 * Under prefers-reduced-motion the mark is static. Loaders never time out on
 * their own: the owner keeps its existing timeout/error handling and swaps the
 * loader for its error UI.
 */

// Must match the pq-brand-pulse duration in index.css.
const PULSE_PERIOD_MS = 2000;

let pulseOrigin: number | null = null;

/**
 * performance.now() value at which the shared pulse started. The first
 * loader React renders adopts the index.html boot logo's running animation
 * (it is still in the DOM until React commits), so the boot → React hand-off
 * continues the pulse exactly. Without a boot logo it falls back to 0.
 */
function resolvePulseOrigin(now: number): number {
  if (pulseOrigin !== null) return pulseOrigin;
  pulseOrigin = 0;
  try {
    const bootLogo = typeof document !== 'undefined'
      ? document.querySelector('[data-pq-boot] [data-pq-loader]')
      : null;
    const running = bootLogo?.getAnimations?.()[0]?.currentTime;
    if (typeof running === 'number') pulseOrigin = now - running;
  } catch {
    // Web Animations API unavailable: the document-clock phase is close enough.
  }
  return pulseOrigin;
}

/** Test-only: forget the adopted pulse origin. */
export function resetPulseOriginForTests(): void {
  pulseOrigin = null;
}

function usePulsePhase(): React.CSSProperties {
  const [style] = useState<React.CSSProperties>(() => {
    const now = typeof performance !== 'undefined' ? performance.now() : 0;
    const elapsed = now - resolvePulseOrigin(now);
    const phase = ((elapsed % PULSE_PERIOD_MS) + PULSE_PERIOD_MS) % PULSE_PERIOD_MS;
    return { animationDelay: `-${Math.round(phase)}ms` };
  });
  return style;
}

// Parqueen_Logo.png is 818×669; size the box to it so nothing shifts on decode.
const LOGO_ASPECT = 669 / 818;

const DEFAULT_LABEL = 'Loading ParQueen';

/** The full crown logo, pulsing. Decorative: the owner carries the status role. */
const BrandedLogoMark = ({ size }: { size: number }) => {
  const phase = usePulsePhase();
  return (
    <img
      src={ParQueenLogo}
      alt=""
      aria-hidden="true"
      width={size}
      height={Math.round(size * LOGO_ASPECT)}
      decoding="sync"
      className="pq-brand-pulse select-none pointer-events-none"
      style={{ width: size, height: 'auto', ...phase }}
      draggable={false}
      data-pq-loader="logo"
    />
  );
};

/**
 * Full-area branded loader. Fills its parent and paints the app background,
 * so it works as a Suspense fallback, a whole-screen state, or an overlay
 * (`className="absolute inset-0 z-20"`). index.html renders the same markup
 * before the JS bundle runs, so keep the two in sync.
 */
export const LoadingScreen = ({ label = DEFAULT_LABEL, className = '' }: { label?: string; className?: string }) => (
  <div
    className={`pq-loading-screen ${className}`.trim()}
    role="status"
    aria-live="polite"
    aria-label={label}
  >
    <BrandedLogoMark size={160} />
  </div>
);

/**
 * Region-level branded loader: a smaller logo with an optional caption.
 * Pass `label` when there is no visible caption so screen readers still
 * announce the wait. `className` sets spacing/sizing (default `gap-3`).
 */
export const SectionLoader = ({
  label,
  size = 64,
  className = 'gap-3',
  children,
}: {
  label?: string;
  size?: number;
  className?: string;
  children?: React.ReactNode;
}) => (
  <div
    role="status"
    aria-live="polite"
    aria-label={label}
    className={`flex flex-col items-center justify-center ${className}`.trim()}
  >
    <BrandedLogoMark size={size} />
    {children}
  </div>
);

// Parqueen_Pin.png is 303×334.
const PIN_ASPECT = 303 / 334;

/**
 * Control-sized branded indicator: the ParQueen pin glyph in currentColor.
 * Decorative by default; the control it sits in should expose aria-busy or a
 * text change. Pass `label` only when it is the sole signal.
 */
export const InlineLoader = ({ size = 16, label, className = '' }: { size?: number; label?: string; className?: string }) => {
  const phase = usePulsePhase();
  const mask = `url("${ParQueenPin}")`;
  const a11y = label ? { role: 'status', 'aria-label': label } : { 'aria-hidden': true as const };
  return (
    <span
      {...a11y}
      className={`pq-brand-pulse inline-block shrink-0 bg-current ${className}`.trim()}
      style={{
        width: Math.round(size * PIN_ASPECT),
        height: size,
        WebkitMaskImage: mask,
        maskImage: mask,
        WebkitMaskSize: 'contain',
        maskSize: 'contain',
        WebkitMaskRepeat: 'no-repeat',
        maskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        maskPosition: 'center',
        ...phase,
      }}
      data-pq-loader="inline"
    />
  );
};
