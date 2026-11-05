// The original ParQueen welcome (first slide of the legacy onboarding), as a standalone screen that opens
// Onboarding 2.0. Same emblem, beacon ring, shimmer, "WELCOME TO" / ParQueen wordmark / slogan / supporting line
// and blue Get Started button as views/OnboardingView.tsx (which stays untouched as the rollback path); the
// animation classes are the same global ones in index.css. Differences: the controls sit in normal flow (so large
// text scrolls instead of overlapping), the three dots now stand for Welcome · Example · Choose, and a quiet
// "Already have an account?" link keeps the existing-account route.
import React, { useLayoutEffect, useRef } from 'react';
import Logo from '../../assets/Parqueen_Logo.png';

type Props = {
  tr: (key: string) => string;
  reduce: boolean;
  leaving: boolean;
  onGetStarted: () => void;
  onAccount: () => void;
  headingRef?: React.Ref<HTMLHeadingElement>;
  extra?: Record<string, unknown>;
};

/** Keeps the one-word wordmark on one line inside the column, also at large system text sizes. */
function useFitWidth(ref: React.RefObject<HTMLElement>) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof getComputedStyle !== 'function') return;
    const fit = () => {
      el.style.fontSize = '';
      const box = el.parentElement?.parentElement;   // h1 -> lockup column
      if (!box) return;
      const cs = getComputedStyle(box);
      const avail = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      for (let i = 0; i < 3 && el.scrollWidth > avail + 0.5; i++) {
        el.style.fontSize = (parseFloat(getComputedStyle(el).fontSize) * avail / el.scrollWidth) + 'px';
      }
    };
    fit();
    const RO = (window as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    const ro = RO ? new RO(fit) : null;
    if (ro && el.parentElement?.parentElement) ro.observe(el.parentElement.parentElement);
    return () => ro?.disconnect();
  }, [ref]);
}

export const WelcomeScreen = ({ tr, reduce, leaving, onGetStarted, onAccount, headingRef, extra }: Props) => {
  const wordmarkRef = useRef<HTMLSpanElement>(null);
  useFitWidth(wordmarkRef);
  return (
  <div className={`obv2-welcome pq-hero-midnight${leaving ? ' leaving' : ''}`} data-testid="obv2-welcome" {...extra}>
    {/* quiet midnight-city atmosphere (unchanged) */}
    <div className="absolute inset-0 pointer-events-none overflow-hidden" aria-hidden="true">
      <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse 70% 55% at 50% 34%, rgba(29,78,216,0.18) 0%, rgba(15,23,42,0) 72%)' }} />
      <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse 38% 28% at 50% 34%, rgba(56,189,248,0.18) 0%, rgba(37,99,235,0.10) 55%, transparent 80%)' }} />
      <div className="absolute inset-0" style={{ background: 'radial-gradient(ellipse 95% 90% at 50% 48%, transparent 32%, rgba(3,8,20,0.80) 100%)' }} />
    </div>

    <div className="obv2-welcome-top" aria-hidden="true" />

    {/* brand lockup */}
    <div className="obv2-welcome-lockup">
      <div className={`obv2-welcome-logo relative flex items-center justify-center mb-5${reduce ? '' : ' logo-rise'}`}>
        <div className={`absolute inset-0 rounded-full pointer-events-none${reduce ? ' opacity-0' : ' beacon-ring-1'}`} style={{ border: '1.5px solid rgba(96,165,250,0.40)' }} aria-hidden="true" />
        <div className="obv2-welcome-emblem relative z-10 overflow-hidden">
          <img src={Logo} alt="" className="object-contain w-full h-full" draggable={false} />
          {!reduce && (
            <div
              className="logo-shimmer-once"
              aria-hidden="true"
              style={{
                maskImage: `url(${Logo})`, WebkitMaskImage: `url(${Logo})`,
                maskSize: 'contain', WebkitMaskSize: 'contain',
                maskRepeat: 'no-repeat', WebkitMaskRepeat: 'no-repeat',
                maskPosition: 'center', WebkitMaskPosition: 'center',
              }}
            />
          )}
        </div>
        <div
          className={`absolute pointer-events-none${reduce ? '' : ' beacon-dot-anim'}`}
          aria-hidden="true"
          style={{ width: 7, height: 7, borderRadius: '50%', background: 'rgba(96,165,250,0.88)', boxShadow: '0 0 8px 2px rgba(96,165,250,0.28)', bottom: 14, left: '50%', transform: 'translateX(-50%)', zIndex: 12 }}
        />
      </div>

      <h1 className="relative text-center" ref={headingRef} tabIndex={-1} id="obv2-h-welcome">
        <span
          className={`block text-[11px] font-semibold uppercase tracking-[0.26em] mb-2${reduce ? '' : ' hero-welcome'}`}
          style={{ color: 'rgba(147,197,253,0.85)' }}
        >
          {tr('onboarding.slide1.headline_prefix')}
        </span>
        <span
          ref={wordmarkRef}
          className="obv2-welcome-wordmark inline-block whitespace-nowrap font-black leading-[0.95] tracking-tight"
          style={{
            background: 'linear-gradient(90deg, #2563eb 0%, #3b82f6 20%, #93c5fd 38%, #e0f2fe 50%, #93c5fd 62%, #3b82f6 80%, #2563eb 100%)',
            backgroundSize: '200% auto', backgroundRepeat: 'repeat',
            WebkitBackgroundClip: 'text', backgroundClip: 'text', WebkitTextFillColor: 'transparent',
            animation: reduce ? 'none' : 'hero-fade-up 320ms cubic-bezier(0.22,1,0.36,1) 500ms both, wordmark-glimmer 2.8s linear 820ms infinite',
          }}
        >
          ParQueen
        </span>
      </h1>

      <p className={`mt-3 text-center text-[18px] italic tracking-wide leading-snug max-w-[260px]${reduce ? '' : ' hero-tagline'}`} style={{ color: 'rgba(196,235,255,0.92)' }}>
        {tr('onboarding.slide1.body')}
      </p>
      <p className={`mt-2.5 text-center text-[13px] leading-relaxed max-w-[280px]${reduce ? '' : ' hero-supporting'}`} style={{ color: 'rgba(147,197,253,0.68)' }}>
        {tr('onboarding.slide1.supporting')}
      </p>
    </div>

    {/* dots + Get Started (+ existing-account route) */}
    <div className={`obv2-welcome-actions${reduce ? '' : ' hero-bottom-fade'}`}>
      {/* three stages of the new flow: Welcome · Example · Choose (decorative; the screen reader hears the heading) */}
      <div className="flex gap-2 items-center" aria-hidden="true">
        {[0, 1, 2].map(i => (
          <span
            key={i}
            className={`block rounded-full${i === 0 ? ' h-[8px] w-8' : ' h-[6px] w-[6px]'}`}
            style={i === 0 ? { background: '#3b82f6', boxShadow: '0 0 7px rgba(59,130,246,0.55)' } : { background: 'rgba(255,255,255,0.28)' }}
          />
        ))}
      </div>
      <button
        type="button"
        onClick={onGetStarted}
        className="obv2-get-started w-full text-white font-bold py-[17px] rounded-full text-[15px] transition-all duration-[160ms] active:scale-[0.985]"
        style={{
          background: 'linear-gradient(160deg, #2563eb 0%, #1d4ed8 52%, #1e40af 100%)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.13), 0 6px 20px rgba(29,78,216,0.20), 0 2px 6px rgba(29,78,216,0.11)',
        }}
      >
        {tr('onboarding.get_started')}
      </button>
      <button type="button" onClick={onAccount} className="obv2-welcome-account">
        {tr('onboarding_v2.account')}
      </button>
    </div>
  </div>
  );
};
