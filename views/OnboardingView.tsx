import React, { useState, useRef, useEffect } from 'react';
import { resolveOnboardingAndroidBack } from '../utils/androidBackNavigation';
import Logo from '../assets/Parqueen_Logo.png';
import { t, useLang } from '../i18n';

const SLIDE_COUNT = 3;

export type OnboardingAndroidBackHandle = {
  /** Returns whether Back was handled inside onboarding, or root minimize is needed. */
  handleAndroidBack: () => 'handled' | 'minimize';
};

export const OnboardingView = ({
  onComplete,
  initialSlide = 0,
  androidBackRef,
}: {
  onComplete: () => void;
  initialSlide?: number;
  androidBackRef?: React.MutableRefObject<OnboardingAndroidBackHandle | null>;
}) => {
    useLang();
    const [current, setCurrent] = useState(initialSlide);
    const [animating, setAnimating] = useState(false);
    const touchStartX = useRef<number | null>(null);
    const prefersReduced =
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Skip animations when jumping directly to a later slide (e.g. Back from signup)
    const skipAnims = prefersReduced || initialSlide > 0;

    // My Car sequence: fires once when slide 3 becomes active
    const [s3Phase, setS3Phase] = useState(skipAnims ? 5 : 0);
    const s3Started = useRef(skipAnims);
    useEffect(() => {
        if (current !== 2 || s3Started.current || prefersReduced) return;
        s3Started.current = true;
        const timers = [
            setTimeout(() => setS3Phase(1), 200),  // map in
            setTimeout(() => setS3Phase(2), 420),  // My Car circle marker + user dot
            setTimeout(() => setS3Phase(3), 640),  // walking route draws
            setTimeout(() => setS3Phase(4), 820),  // product preview fades in (Safe Until)
            setTimeout(() => setS3Phase(5), 960),  // reminder row fades in
        ];
        return () => timers.forEach(clearTimeout);
    }, [current, prefersReduced]);

    // Demo sequence: fires once when slide 2 becomes active
    const [demoPhase, setDemoPhase] = useState(skipAnims ? 5 : 0);
    const demoStarted = useRef(skipAnims);
    useEffect(() => {
        if (current !== 1 || demoStarted.current || prefersReduced) return;
        demoStarted.current = true;
        const timers = [
            setTimeout(() => setDemoPhase(1), 0),     // location dot (immediate)
            setTimeout(() => setDemoPhase(2), 220),   // primary blue ping
            setTimeout(() => setDemoPhase(3), 460),   // secondary blue ping
            setTimeout(() => setDemoPhase(4), 700),   // yellow leaving-later ping
            setTimeout(() => setDemoPhase(5), 940),   // pill + tooltips
        ];
        return () => timers.forEach(clearTimeout);
    }, [current, prefersReduced]);
    const pingCount = demoPhase >= 5 ? 3 : demoPhase >= 2 ? demoPhase - 1 : 0;

    const goTo = (index: number) => {
        if (animating || index === current) return;
        setAnimating(true);
        setCurrent(index);
        setTimeout(() => setAnimating(false), prefersReduced ? 0 : 350);
    };

    const advance = () => {
        if (current < SLIDE_COUNT - 1) goTo(current + 1);
        else onComplete();
    };

    const goBack = () => {
        if (current > 0) goTo(current - 1);
    };

    // Live slide index for Android Back without re-binding every animation frame.
    const currentSlideRef = useRef(current);
    currentSlideRef.current = current;

    // Android system Back: previous slide when not on the first; otherwise ask App to minimize.
    // Uses setCurrent directly so a Back press is never dropped while goTo's animating lock is set.
    useEffect(() => {
        if (!androidBackRef) return;
        androidBackRef.current = {
            handleAndroidBack: () => {
                const action = resolveOnboardingAndroidBack(currentSlideRef.current);
                if (action === 'previousSlide') {
                    setCurrent((slide) => Math.max(0, slide - 1));
                    return 'handled';
                }
                return 'minimize';
            },
        };
        return () => {
            androidBackRef.current = null;
        };
    }, [androidBackRef]);


    const handleTouchStart = (e: React.TouchEvent) => {
        touchStartX.current = e.touches[0].clientX;
    };

    const handleTouchEnd = (e: React.TouchEvent) => {
        if (touchStartX.current === null) return;
        const dx = e.changedTouches[0].clientX - touchStartX.current;
        touchStartX.current = null;
        if (dx < -40) advance();
        else if (dx > 40) goBack();
    };

    const slides = [
        { isHero: true },
        {
            eyebrow: t('onboarding.slide2.eyebrow'),
            headline: t('onboarding.slide2.headline'),
            body: t('onboarding.slide2.body'),
        },
        {
            eyebrow: t('onboarding.slide3.eyebrow'),
            headline: t('onboarding.slide3.headline'),
            body: t('onboarding.slide3.body'),
        },
    ] as const;

    return (
        <div
            className="h-full w-full relative select-none overflow-hidden bg-[var(--color-bg)]"
            onTouchStart={handleTouchStart}
            onTouchEnd={handleTouchEnd}
        >
            {/* Skip — top-right, 44px min tap target; hidden on first slide */}
            {current > 0 && (
                <button
                    onClick={onComplete}
                    aria-label={t('onboarding.skip')}
                    className="absolute right-4 z-20 px-4 min-h-[44px] flex items-center text-[13px] font-medium"
                    style={{ top: 'calc(env(safe-area-inset-top) + 8px)', color: 'rgba(147,197,253,0.72)' }}
                >
                    {t('onboarding.skip')}
                </button>
            )}

            {/* Slides */}
            {slides.map((slide, i) => (
                <div
                    key={i}
                    className="absolute inset-0 flex flex-col"
                    aria-hidden={i !== current}
                    // Slides sit off-screen via transform, so without this a keyboard user
                    // tabs into the invisible ones. React 18 has no typed `inert`.
                    {...(i !== current ? ({ inert: '' } as Record<string, string>) : {})}
                    style={{
                        transform: i === current
                            ? 'translateX(0)'
                            : i < current ? 'translateX(-100%)' : 'translateX(100%)',
                        transitionDuration: prefersReduced ? '0ms' : '350ms',
                        transitionProperty: 'transform',
                        transitionTimingFunction: 'ease-out',
                    }}
                >
                    {'isHero' in slide ? (
                        <div className="flex-1 relative flex flex-col pq-hero-midnight">
                            {/* ── Background: quiet midnight-city atmosphere ── */}
                            <div className="absolute inset-0 pointer-events-none overflow-hidden">
                                {/* Outer atmosphere — large, very low opacity */}
                                <div className="absolute inset-0" style={{
                                    background: 'radial-gradient(ellipse 70% 55% at 50% 34%, rgba(29,78,216,0.18) 0%, rgba(15,23,42,0) 72%)',
                                }} />
                                {/* Inner halo — compact, brighter, cyan-blue */}
                                <div className="absolute inset-0" style={{
                                    background: 'radial-gradient(ellipse 38% 28% at 50% 34%, rgba(56,189,248,0.18) 0%, rgba(37,99,235,0.10) 55%, transparent 80%)',
                                }} />
                                {/* Edge vignette for depth */}
                                <div className="absolute inset-0" style={{
                                    background: 'radial-gradient(ellipse 95% 90% at 50% 48%, transparent 32%, rgba(3,8,20,0.80) 100%)',
                                }} />
                            </div>

                            {/* ── Zone A: top spacer ── */}
                            <div className="flex-none" style={{ height: 'calc(env(safe-area-inset-top, 0px) + 56px)' }} />

                            {/* ── Zone B: brand lockup ── */}
                            <div className="flex-1 flex flex-col items-center justify-center px-8 min-h-0">
                                {/* Logo + one beacon ring */}
                                <div
                                    className={`relative flex items-center justify-center mb-5${prefersReduced ? '' : ' logo-rise'}`}
                                    style={{ width: 200, height: 200 }}
                                >
                                    {/* Beacon broadcast ring — one only, fades completely */}
                                    <div
                                        className={`absolute inset-0 rounded-full pointer-events-none${prefersReduced ? ' opacity-0' : ' beacon-ring-1'}`}
                                        style={{ border: '1.5px solid rgba(96,165,250,0.40)' }}
                                    />
                                    {/* Crown-pin logo wrapper — overflow-hidden clips shimmer */}
                                    <div className="relative z-10 overflow-hidden" style={{ width: 168, height: 168 }}>
                                        <img
                                            src={Logo}
                                            alt="ParQueen crown emblem"
                                            className="object-contain w-full h-full"
                                        />
                                        {/* Crown shimmer — single pass, logo area only */}
                                        {!prefersReduced && (
                                            <div
                                                className="logo-shimmer-once"
                                                aria-hidden="true"
                                                style={{
                                                    maskImage: `url(${Logo})`,
                                                    WebkitMaskImage: `url(${Logo})`,
                                                    maskSize: 'contain',
                                                    WebkitMaskSize: 'contain',
                                                    maskRepeat: 'no-repeat',
                                                    WebkitMaskRepeat: 'no-repeat',
                                                    maskPosition: 'center',
                                                    WebkitMaskPosition: 'center',
                                                }}
                                            />
                                        )}
                                    </div>
                                    {/* Beacon point — brightens once during broadcast, dims to resting */}
                                    <div
                                        className={`absolute pointer-events-none${prefersReduced ? '' : ' beacon-dot-anim'}`}
                                        style={{
                                            width: 7, height: 7,
                                            borderRadius: '50%',
                                            background: 'rgba(96,165,250,0.88)',
                                            boxShadow: '0 0 8px 2px rgba(96,165,250,0.28)',
                                            bottom: 14,
                                            left: '50%',
                                            transform: 'translateX(-50%)',
                                            zIndex: 12,
                                        }}
                                    />
                                </div>

                                {/* Text lockup */}
                                <div className="relative text-center">
                                    <p
                                        className={`text-[11px] font-semibold uppercase tracking-[0.26em] mb-2${prefersReduced ? '' : ' hero-welcome'}`}
                                        style={{ color: 'rgba(147,197,253,0.85)' }}
                                    >
                                        {t('onboarding.slide1.headline_prefix')}
                                    </p>
                                    <div
                                        className="text-[52px] font-black leading-[0.95] tracking-tight"
                                        style={{
                                            background: 'linear-gradient(90deg, #2563eb 0%, #3b82f6 20%, #93c5fd 38%, #e0f2fe 50%, #93c5fd 62%, #3b82f6 80%, #2563eb 100%)',
                                            backgroundSize: '200% auto',
                                            backgroundRepeat: 'repeat',
                                            WebkitBackgroundClip: 'text',
                                            backgroundClip: 'text',
                                            WebkitTextFillColor: 'transparent',
                                            animation: prefersReduced
                                                ? 'none'
                                                : 'hero-fade-up 320ms cubic-bezier(0.22,1,0.36,1) 500ms both, wordmark-glimmer 2.8s linear 820ms infinite',
                                        }}
                                    >
                                        ParQueen
                                    </div>
                                </div>

                                <p
                                    className={`mt-3 text-center text-[18px] italic tracking-wide leading-snug max-w-[260px]${prefersReduced ? '' : ' hero-tagline'}`}
                                    style={{ color: 'rgba(196,235,255,0.92)' }}
                                >
                                    {t('onboarding.slide1.body')}
                                </p>

                                <p
                                    className={`mt-2.5 text-center text-[13px] leading-relaxed max-w-[280px]${prefersReduced ? '' : ' hero-supporting'}`}
                                    style={{ color: 'rgba(147,197,253,0.68)' }}
                                >
                                    {t('onboarding.slide1.supporting')}
                                </p>
                            </div>

                            {/* ── Zone C: bottom spacer (reduced ~24px to tighten gap) ── */}
                            <div className="flex-none" style={{ height: 'calc(env(safe-area-inset-bottom, 0px) + 112px)' }} />
                        </div>
                    ) : i === 1 ? (
                        /* ── Slide 2: IMMERSIVE LIVE MAP ── */
                        <div className="flex-1 relative overflow-hidden">

                            {/* ── Full-bleed map background ── */}
                            <div className={`absolute inset-0${prefersReduced ? '' : ' onb2-map-in'}`}>
                                <svg aria-hidden="true" className="absolute inset-0 w-full h-full" viewBox="0 0 360 520" preserveAspectRatio="xMidYMid slice">
                                    <rect width="360" height="520" fill="#191b2e"/>
                                    <rect x="58"  y="0" width="9" height="520" fill="#252842"/>
                                    <rect x="132" y="0" width="9" height="520" fill="#282c46"/>
                                    <rect x="206" y="0" width="9" height="520" fill="#252842"/>
                                    <rect x="280" y="0" width="8" height="520" fill="#222540"/>
                                    <rect x="0" y="46"  width="360" height="5" fill="#1f2238"/>
                                    <rect x="0" y="92"  width="360" height="5" fill="#1f2238"/>
                                    <rect x="0" y="138" width="360" height="5" fill="#202340"/>
                                    <rect x="0" y="184" width="360" height="5" fill="#1f2238"/>
                                    <rect x="0" y="230" width="360" height="5" fill="#1f2238"/>
                                    <rect x="0" y="276" width="360" height="5" fill="#202340"/>
                                    <rect x="0" y="322" width="360" height="5" fill="#1f2238"/>
                                    <rect x="0" y="368" width="360" height="5" fill="#1f2238"/>
                                    <rect x="0" y="414" width="360" height="5" fill="#1f2238"/>
                                    <rect x="0" y="460" width="360" height="4" fill="#1e2138"/>
                                    <line x1="0" y1="456" x2="360" y2="136" stroke="#272b44" strokeWidth="10" strokeLinecap="round"/>
                                </svg>
                                <div className="absolute inset-0 pointer-events-none" style={{
                                    background: 'radial-gradient(ellipse 60% 38% at 44% 32%, rgba(30,117,255,0.11) 0%, transparent 68%)',
                                }}/>
                                {/* Gradient merging map into sheet */}
                                <div className="absolute bottom-0 inset-x-0 pointer-events-none" style={{
                                    height: 'clamp(90px, 16dvh, 160px)',
                                    background: 'linear-gradient(to bottom, transparent, rgba(5,13,28,0.82))',
                                }}/>
                                <div className="absolute inset-0 pointer-events-none" style={{ boxShadow: 'inset 0 0 60px rgba(1,4,12,0.48)' }}/>
                            </div>

                            {/* ── User location dot — phase 1 ── */}
                            {demoPhase >= 1 && (
                                <div
                                    className={prefersReduced ? undefined : 'onb2-loc-in'}
                                    style={{ position: 'absolute', left: '52%', top: '43%',
                                        transform: prefersReduced ? 'translate(-50%, -50%)' : undefined, zIndex: 5 }}
                                >
                                    {!prefersReduced && <div className="onb2-loc-ring" style={{ left: '50%', top: '50%' }}/>}
                                    <div className="relative flex items-center justify-center">
                                        <div className="absolute w-6 h-6 bg-blue-500/20 rounded-full"/>
                                        <div className="w-3.5 h-3.5 bg-blue-500 rounded-full border-2 border-white shadow-md"/>
                                    </div>
                                </div>
                            )}

                            {/* ── Primary blue ping — 44px, tip at 40%/24% ── */}
                            {demoPhase >= 2 && (
                                <div style={{ position: 'absolute', left: '40%', top: '24%', zIndex: 6 }}>
                                    {!prefersReduced && <div className="onb2-select-ring" style={{ left: '50%', top: 0 }}/>}
                                    <div
                                        className={prefersReduced ? undefined : 'onb2-pin-drop'}
                                        style={prefersReduced ? { transform: 'translate(-50%, -100%)' } : undefined}
                                    >
                                        <svg viewBox="0 0 24 24" style={{ width: 44, height: 44, display: 'block', filter: 'drop-shadow(0px 3px 8px rgba(0,0,0,0.55))' }} aria-hidden="true">
                                            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="#1e75ff" stroke="rgba(255,255,255,0.20)" strokeWidth="0.5"/>
                                            <rect x="8.5" y="5.5" width="7" height="7" rx="1.5" fill="rgba(255,255,255,0.20)" stroke="rgba(255,255,255,0.50)" strokeWidth="0.8"/>
                                            <text x="12" y="11" fontSize="5.5" fontFamily="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" fontWeight="900" textAnchor="middle" fill="white">P</text>
                                        </svg>
                                    </div>
                                </div>
                            )}

                            {/* ── Secondary blue ping — 38px, tip at 20%/34% ── */}
                            {demoPhase >= 3 && (
                                <div style={{ position: 'absolute', left: '20%', top: '34%', zIndex: 5 }}>
                                    <div
                                        className={prefersReduced ? undefined : 'onb2-pin-drop'}
                                        style={prefersReduced ? { transform: 'translate(-50%, -100%)' } : undefined}
                                    >
                                        <svg viewBox="0 0 24 24" style={{ width: 38, height: 38, display: 'block', filter: 'drop-shadow(0px 3px 8px rgba(0,0,0,0.55))' }} aria-hidden="true">
                                            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="#1e75ff" stroke="rgba(255,255,255,0.20)" strokeWidth="0.5"/>
                                            <rect x="8.5" y="5.5" width="7" height="7" rx="1.5" fill="rgba(255,255,255,0.20)" stroke="rgba(255,255,255,0.50)" strokeWidth="0.8"/>
                                            <text x="12" y="11" fontSize="5.5" fontFamily="-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif" fontWeight="900" textAnchor="middle" fill="white">P</text>
                                        </svg>
                                    </div>
                                </div>
                            )}

                            {/* ── Yellow leaving-later ping — 38px, tip at 72%/16% ── */}
                            {demoPhase >= 4 && (
                                <div style={{ position: 'absolute', left: '72%', top: '16%', zIndex: 5 }}>
                                    <div
                                        className={prefersReduced ? undefined : 'onb2-pin-drop'}
                                        style={prefersReduced ? { transform: 'translate(-50%, -100%)' } : undefined}
                                    >
                                        <svg viewBox="0 0 24 24" style={{ width: 38, height: 38, display: 'block', filter: 'drop-shadow(0px 3px 8px rgba(0,0,0,0.55))' }} aria-hidden="true">
                                            <path d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7z" fill="#eab308" stroke="rgba(255,255,255,0.20)" strokeWidth="0.5"/>
                                            <circle cx="12" cy="9.5" r="3.5" fill="none" stroke="white" strokeWidth="1.6"/>
                                            <line x1="12" y1="7.5" x2="12" y2="9.5" stroke="white" strokeWidth="1.6" strokeLinecap="round"/>
                                            <line x1="12" y1="9.5" x2="13.5" y2="10.5" stroke="white" strokeWidth="1.6" strokeLinecap="round"/>
                                        </svg>
                                    </div>
                                </div>
                            )}

                            {/* ── Leaving later tooltip — above yellow pin ── */}
                            {demoPhase >= 5 && (
                                <div
                                    className={prefersReduced ? '' : 'onb2-preview-in'}
                                    style={{
                                        position: 'absolute', left: '62%', top: '17%', transform: 'translateX(-50%)', zIndex: 12,
                                        background: 'rgba(5,13,28,0.93)',
                                        backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
                                        border: '1px solid rgba(234,179,8,0.42)', borderRadius: 10,
                                        padding: '5px 9px', whiteSpace: 'nowrap',
                                        boxShadow: '0 4px 16px rgba(0,0,0,0.60)',
                                    }}
                                >
                                    <div style={{ fontSize: 11, fontWeight: 700, color: 'white', letterSpacing: '-0.01em' }}>Leaving later</div>
                                    <div style={{ fontSize: 10, color: 'rgba(253,224,71,0.78)', marginTop: 2 }}>0.4 mi away</div>
                                </div>
                            )}

                            {/* ── Selected ping preview — appears after all pings ── */}
                            {demoPhase >= 5 && (
                                <div
                                    className={prefersReduced ? '' : 'onb2-preview-in'}
                                    style={{
                                        position: 'absolute', left: '10%', top: '35%', transform: 'translateX(-50%)', zIndex: 12,
                                        background: 'rgba(5,13,28,0.93)',
                                        backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
                                        border: '1px solid rgba(30,117,255,0.42)', borderRadius: 10,
                                        padding: '5px 9px', whiteSpace: 'nowrap',
                                        boxShadow: '0 4px 16px rgba(0,0,0,0.60)',
                                    }}
                                >
                                    <div style={{ fontSize: 11, fontWeight: 700, color: 'white', letterSpacing: '-0.01em' }}>Leaving now</div>
                                    <div style={{ fontSize: 10, color: 'rgba(147,197,253,0.78)', marginTop: 2 }}>0.2 mi away</div>
                                </div>
                            )}

                            {/* ── Pings nearby pill ── */}
                            {demoPhase >= 5 && (
                                <div
                                    className={prefersReduced ? undefined : 'onb2-pill'}
                                    style={{
                                        position: 'absolute', top: '2%', left: 10,
                                        transform: undefined,
                                        display: 'inline-flex', alignItems: 'center', gap: 6,
                                        background: 'rgba(5,13,28,0.82)',
                                        backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)',
                                        border: '1px solid rgba(52,211,153,0.24)',
                                        borderRadius: 999, padding: '5px 11px',
                                        whiteSpace: 'nowrap', zIndex: 10,
                                        boxShadow: '0 2px 12px rgba(0,0,0,0.40)',
                                    }}
                                >
                                    <div style={{ width: 6, height: 6, borderRadius: '50%', background: '#34d399', flexShrink: 0 }}/>
                                    <span style={{ fontSize: 10, fontWeight: 600, color: '#34d399', letterSpacing: '0.01em' }}>
                                        {pingCount === 1
                                            ? t('onboarding.slide2.ping_nearby_one')
                                            : t('onboarding.slide2.pings_nearby', { count: pingCount })}
                                    </span>
                                </div>
                            )}

                            {/* ── Premium bottom sheet ── */}
                            <div
                                className="absolute bottom-0 inset-x-0"
                                style={{
                                    background: 'rgba(5,13,28,0.97)',
                                    backdropFilter: 'blur(28px)', WebkitBackdropFilter: 'blur(28px)',
                                    borderTop: '1px solid rgba(255,255,255,0.08)',
                                    borderRadius: '30px 30px 0 0',
                                    boxShadow: '0 -6px 36px rgba(0,0,0,0.50)',
                                    zIndex: 20,
                                }}
                            >
                                <div className="px-6 pt-5">
                                    <span className="text-[10px] font-bold tracking-[0.22em] uppercase block mb-1.5" style={{ color: 'rgba(96,165,250,0.84)' }}>
                                        {'eyebrow' in slide ? slide.eyebrow : ''}
                                    </span>
                                    <h2 className="font-bold text-[var(--color-text)] mb-2.5"
                                        style={{ fontSize: 'clamp(21px, 2.8dvh, 25px)', lineHeight: 1.22 }}>
                                        {'headline' in slide ? slide.headline : ''}
                                    </h2>
                                    <p className="leading-[1.52] max-w-[320px]"
                                        style={{ fontSize: 'clamp(14px, 1.85dvh, 15px)', color: 'rgba(186,210,240,0.84)' }}>
                                        {'body' in slide ? slide.body : ''}
                                    </p>
                                </div>

                                {/* Responsive gap between body and pagination */}
                                <div style={{ height: 'clamp(10px, 1.8dvh, 22px)' }}/>

                                {/* Pagination dots */}
                                <div className="flex gap-2 items-center justify-center mb-3" role="tablist" aria-label="Onboarding progress">
                                    {slides.map((_, si) => (
                                        <button
                                            key={si} role="tab"
                                            aria-selected={si === current}
                                            aria-label={`Slide ${si + 1} of ${SLIDE_COUNT}`}
                                            onClick={() => goTo(si)}
                                            className="h-6 min-w-[24px] flex items-center justify-center"
                                        >
                                            {/* 24x24 hit area (WCAG 2.5.8); the dot itself is unchanged. */}
                                            <span
                                                aria-hidden="true"
                                                className={`block rounded-full transition-all duration-300${si === current ? ' h-[8px] w-8' : ' h-[6px] w-[6px]'}`}
                                                style={si === current
                                                    ? { background: '#3b82f6', boxShadow: '0 0 7px rgba(59,130,246,0.55)' }
                                                    : { background: 'rgba(255,255,255,0.28)' }}
                                            />
                                        </button>
                                    ))}
                                </div>

                                {/* CTA */}
                                <div className="px-6" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 24px)' }}>
                                    <button
                                        onClick={advance}
                                        className="w-full text-white font-bold rounded-full text-[15px] transition-all duration-[160ms] active:scale-[0.985]"
                                        style={{
                                            paddingTop: 17, paddingBottom: 17,
                                            background: 'linear-gradient(160deg, #2563eb 0%, #1d4ed8 52%, #1e40af 100%)',
                                            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.13), 0 6px 20px rgba(29,78,216,0.21), 0 2px 6px rgba(29,78,216,0.12)',
                                        }}
                                    >
                                        {t('onboarding.continue')}
                                    </button>
                                </div>
                            </div>
                        </div>
                    ) : (
                        /* ── Slide 3: MY CAR, REMEMBERED ── */
                        <div className="flex-1 relative overflow-hidden">

                            {/* ── Dark map — fills behind the sheet ── */}
                            <div
                                className={s3Phase >= 1 && !prefersReduced ? 'onb2-map-in' : ''}
                                style={{
                                    position: 'absolute', inset: 0,
                                    opacity: s3Phase >= 1 || prefersReduced ? undefined : 0,
                                }}
                            >
                                {/* Slightly varied street grid — avenues wider-spaced than blocks */}
                                <svg aria-hidden="true" className="absolute inset-0 w-full h-full" viewBox="0 0 375 812" preserveAspectRatio="xMidYMid slice">
                                    <rect width="375" height="812" fill="#181a2e"/>
                                    {/* Avenues (vertical, wider spacing) */}
                                    <rect x="62"  y="0" width="7" height="812" fill="#21243c"/>
                                    <rect x="148" y="0" width="7" height="812" fill="#232640"/>
                                    <rect x="228" y="0" width="6" height="812" fill="#21243c"/>
                                    <rect x="306" y="0" width="6" height="812" fill="#1f2238"/>
                                    {/* Cross streets (horizontal, tighter) */}
                                    <rect x="0" y="68"  width="375" height="4" fill="#1e2138"/>
                                    <rect x="0" y="116" width="375" height="4" fill="#1e2138"/>
                                    <rect x="0" y="164" width="375" height="5" fill="#202342"/>
                                    <rect x="0" y="212" width="375" height="4" fill="#1e2138"/>
                                    <rect x="0" y="260" width="375" height="4" fill="#1e2138"/>
                                    <rect x="0" y="308" width="375" height="5" fill="#202342"/>
                                    <rect x="0" y="356" width="375" height="4" fill="#1e2138"/>
                                    <rect x="0" y="404" width="375" height="4" fill="#1e2138"/>
                                    {/* Diagonal boulevard */}
                                    <line x1="0" y1="380" x2="375" y2="80" stroke="#1f2240" strokeWidth="8"/>
                                </svg>
                                {/* Soft glow at My Car position */}
                                <div className="absolute inset-0 pointer-events-none" style={{
                                    background: 'radial-gradient(ellipse 44% 28% at 56% 24%, rgba(30,117,255,0.13) 0%, transparent 70%)',
                                }}/>
                                {/* Gradient bleeding into sheet */}
                                <div className="absolute bottom-0 inset-x-0 pointer-events-none" style={{
                                    height: 'clamp(80px, 14dvh, 140px)',
                                    background: 'linear-gradient(to bottom, transparent, rgba(5,13,28,0.88))',
                                }}/>
                                {/* Edge vignette */}
                                <div className="absolute inset-0 pointer-events-none" style={{ boxShadow: 'inset 0 0 55px rgba(1,4,12,0.44)' }}/>
                            </div>

                            {/* ── Walking route — L-shaped, follows street grid — phase 3 ── */}
                            {(s3Phase >= 3 || prefersReduced) && (
                                <svg
                                    aria-hidden="true"
                                    className="absolute inset-0 w-full h-full"
                                    viewBox="0 0 100 100"
                                    preserveAspectRatio="none"
                                    style={{ zIndex: 4 }}
                                >
                                    <defs>
                                        <filter id="routeGlow3" x="-50%" y="-50%" width="200%" height="200%">
                                            <feGaussianBlur stdDeviation="0.5" result="blur"/>
                                            <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
                                        </filter>
                                    </defs>
                                    {/* Path in % coords — aligns with %-positioned user dot (27,37) and crown (56,20) */}
                                    <path
                                        className={prefersReduced ? '' : 'onb3-route-draw'}
                                        style={prefersReduced ? { opacity: 0.80 } : undefined}
                                        d="M 27 37 L 27 28 L 56 28 L 56 23"
                                        fill="none"
                                        stroke="#38bdf8"
                                        strokeWidth="2.5"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        strokeDasharray="400"
                                        vectorEffect="non-scaling-stroke"
                                        filter="url(#routeGlow3)"
                                    />
                                </svg>
                            )}

                            {/* ── User location dot — left 27%, top 37% — phase 2 ── */}
                            {(s3Phase >= 2 || prefersReduced) && (
                                <div
                                    className={prefersReduced ? undefined : 'onb2-loc-in'}
                                    style={{
                                        position: 'absolute', left: '27%', top: '37%',
                                        transform: prefersReduced ? 'translate(-50%, -50%)' : undefined,
                                        zIndex: 5,
                                    }}
                                >
                                    {!prefersReduced && <div className="onb2-loc-ring" style={{ left: '50%', top: '50%' }}/>}
                                    <div className="relative flex items-center justify-center">
                                        <div className="absolute w-4 h-4 bg-blue-500/18 rounded-full"/>
                                        <div className="w-2.5 h-2.5 bg-blue-500 rounded-full border-[1.5px] border-white shadow-md"/>
                                    </div>
                                </div>
                            )}

                            {/* ── My Car circle marker — distinct from community Ping teardrops — phase 2 ── */}
                            {(s3Phase >= 2 || prefersReduced) && (
                                <div style={{ position: 'absolute', left: '56%', top: '20%', zIndex: 8 }}>
                                    <div
                                        className={prefersReduced ? undefined : 'onb3-marker-drop'}
                                        style={prefersReduced ? { transform: 'translate(-50%, -50%)' } : undefined}
                                    >
                                        <svg
                                            viewBox="0 0 50 50"
                                            width="50" height="50"
                                            aria-hidden="true"
                                            style={{ display: 'block', filter: 'drop-shadow(0px 4px 14px rgba(59,130,246,0.50))' }}
                                        >
                                            {/* Outer glow ring */}
                                            <circle cx="25" cy="25" r="24" fill="none" stroke="rgba(59,130,246,0.16)" strokeWidth="2"/>
                                            {/* Circle body */}
                                            <circle cx="25" cy="25" r="21" fill="#0b1840" stroke="#3b82f6" strokeWidth="1.6"/>
                                            {/* Crown — centered, sole identity mark */}
                                            <g transform="translate(25,27) scale(0.90) translate(-12,-9)">
                                                <path d="m2 3 3 9h14l3-9-5 4-4-4-4 4-7-4z" fill="none" stroke="#facc15" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                                                <line x1="5" y1="12" x2="19" y2="12" stroke="#facc15" strokeWidth="2.2" strokeLinecap="round"/>
                                            </g>
                                        </svg>
                                    </div>
                                </div>
                            )}

                            {/* ── Single integrated bottom sheet ── */}
                            <div
                                className="absolute bottom-0 inset-x-0"
                                style={{
                                    background: 'rgba(5,13,28,0.98)',
                                    backdropFilter: 'blur(28px)',
                                    WebkitBackdropFilter: 'blur(28px)',
                                    borderTop: '1px solid rgba(255,255,255,0.07)',
                                    borderRadius: '30px 30px 0 0',
                                    boxShadow: '0 -4px 32px rgba(0,0,0,0.55)',
                                    zIndex: 20,
                                }}
                            >
                                {/* ── My Car product preview — always occupies space, fades in at phase 4 ── */}
                                <div
                                    style={{
                                        opacity: s3Phase >= 4 || prefersReduced ? 1 : 0,
                                        transition: prefersReduced ? undefined : 'opacity 280ms ease',
                                        paddingLeft: 24, paddingRight: 24,
                                        paddingTop: 'clamp(14px, 2dvh, 22px)',
                                        paddingBottom: 'clamp(10px, 1.6dvh, 16px)',
                                    }}
                                >
                                    {/* Header: MY CAR label + SAVED badge */}
                                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'clamp(8px,1.4dvh,14px)' }}>
                                        <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                                            {/* Small car icon — side profile matching map marker */}
                                            <svg viewBox="0 0 28 17" aria-hidden="true" style={{ width: 22, height: 13, flexShrink: 0 }}>
                                                <path d="M 1 14 C 1 12, 2 10, 4.5 9 L 7.5 5.5 C 9 4, 11.5 3, 14 3 C 16.5 3, 19 4, 20.5 6 L 24 9.5 C 25.5 11, 26 12.5, 26 14 Z" fill="#38bdf8" opacity="0.88"/>
                                                <path d="M 5 9 L 8 5.5 C 9.5 4.2, 11.5 3.5, 14 3.5 C 16.5 3.5, 18.5 4.5, 20 6.5 L 22.5 9.5 Z" fill="rgba(5,13,28,0.42)"/>
                                                <circle cx="6.5" cy="14.5" r="2.8" fill="#061030"/>
                                                <circle cx="21.5" cy="14.5" r="2.8" fill="#061030"/>
                                            </svg>
                                            <span style={{ fontSize: 11, fontWeight: 800, color: '#38bdf8', letterSpacing: '0.14em', textTransform: 'uppercase' }}>My Car</span>
                                        </div>
                                        {/* SAVED badge */}
                                        <div style={{
                                            display: 'inline-flex', alignItems: 'center', gap: 4,
                                            background: 'rgba(52,211,153,0.10)',
                                            border: '1px solid rgba(52,211,153,0.32)',
                                            borderRadius: 999, padding: '3px 8px',
                                        }}>
                                            <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#34d399', flexShrink: 0 }}/>
                                            <span style={{ fontSize: 9, fontWeight: 700, color: '#34d399', letterSpacing: '0.10em', textTransform: 'uppercase' }}>Saved</span>
                                        </div>
                                    </div>

                                    {/* Primary — universal, aspirational */}
                                    <div style={{ fontSize: 'clamp(18px,2.4dvh,21px)', fontWeight: 700, color: 'white', letterSpacing: '-0.02em', lineHeight: 1.2, marginBottom: 4 }}>
                                        Your parked car
                                    </div>

                                    {/* Walking distance */}
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 'clamp(10px,1.6dvh,16px)' }}>
                                        <svg viewBox="0 0 24 24" aria-hidden="true" style={{ width: 12, height: 12, flexShrink: 0 }}>
                                            <circle cx="12" cy="4" r="2" fill="#60a5fa"/>
                                            <path d="M 9 22 L 11 14 L 9 11 L 7 17" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                            <path d="M 11 14 L 13 11 L 16 13 L 15 17" fill="none" stroke="#60a5fa" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                        </svg>
                                        <span style={{ fontSize: 13, color: 'rgba(148,163,184,0.82)', letterSpacing: '-0.01em' }}>6 min walk away</span>
                                    </div>

                                    {/* Divider */}
                                    <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', marginBottom: 'clamp(8px,1.4dvh,14px)' }}/>

                                    {/* Safe Until — amber, visually prominent */}
                                    <div style={{ fontSize: 'clamp(15px,2dvh,17px)', fontWeight: 700, color: '#f59e0b', letterSpacing: '-0.01em', marginBottom: 4 }}>
                                        Safe until 8:30 AM
                                    </div>

                                    {/* Schedule */}
                                    <div style={{ fontSize: 'clamp(11px,1.5dvh,13px)', color: 'rgba(203,213,225,0.76)', lineHeight: 1.4, marginBottom: 2 }}>
                                        Street cleaning Tue · 8:30–10:00 AM
                                    </div>

                                    {/* Disclaimer */}
                                    <div style={{ fontSize: 'clamp(10px,1.3dvh,11px)', color: 'rgba(148,163,184,0.52)', marginBottom: 'clamp(8px,1.4dvh,14px)' }}>
                                        Check posted signs
                                    </div>

                                    {/* Reminder — green, phase 5 */}
                                    <div style={{
                                        display: 'flex', alignItems: 'center', gap: 6,
                                        opacity: s3Phase >= 5 || prefersReduced ? 1 : 0,
                                        transition: prefersReduced ? undefined : 'opacity 220ms ease',
                                    }}>
                                        <svg viewBox="0 0 24 24" aria-hidden="true" style={{ width: 13, height: 13, flexShrink: 0 }}>
                                            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" fill="none" stroke="#34d399" strokeWidth="2"/>
                                            <path d="M13.73 21a2 2 0 0 1-3.46 0" fill="none" stroke="#34d399" strokeWidth="2" strokeLinecap="round"/>
                                        </svg>
                                        <span style={{ fontSize: 'clamp(11px,1.5dvh,13px)', color: '#34d399', fontWeight: 500 }}>
                                            Reminder set for 8:15 AM
                                        </span>
                                    </div>
                                </div>

                                {/* Divider between product preview and onboarding copy */}
                                <div style={{ height: 1, background: 'rgba(255,255,255,0.07)', marginLeft: 24, marginRight: 24 }}/>

                                {/* ── Onboarding copy ── */}
                                <div className="px-6" style={{ paddingTop: 'clamp(10px,1.6dvh,18px)' }}>
                                    <span style={{
                                        fontSize: 10, fontWeight: 800, letterSpacing: '0.22em',
                                        textTransform: 'uppercase', display: 'block',
                                        marginBottom: 6, color: 'rgba(96,165,250,0.84)',
                                    }}>
                                        {'eyebrow' in slide ? slide.eyebrow : ''}
                                    </span>
                                    <h2 style={{
                                        fontWeight: 700, color: 'var(--color-text)',
                                        fontSize: 'clamp(19px,2.4dvh,23px)', lineHeight: 1.22,
                                        marginBottom: 6,
                                    }}>
                                        {'headline' in slide ? slide.headline : ''}
                                    </h2>
                                    <p style={{
                                        fontSize: 'clamp(13px,1.7dvh,14px)',
                                        color: 'rgba(186,210,240,0.84)',
                                        lineHeight: 1.5,
                                    }}>
                                        {'body' in slide ? slide.body : ''}
                                    </p>
                                </div>

                                <div style={{ height: 'clamp(8px, 1.3dvh, 16px)' }}/>

                                {/* Pagination */}
                                <div className="flex gap-2 items-center justify-center mb-3" role="tablist" aria-label="Onboarding progress">
                                    {slides.map((_, si) => (
                                        <button
                                            key={si} role="tab"
                                            aria-selected={si === current}
                                            aria-label={`Slide ${si + 1} of ${SLIDE_COUNT}`}
                                            onClick={() => goTo(si)}
                                            className="h-6 min-w-[24px] flex items-center justify-center"
                                        >
                                            {/* 24x24 hit area (WCAG 2.5.8); the dot itself is unchanged. */}
                                            <span
                                                aria-hidden="true"
                                                className={`block rounded-full transition-all duration-300${si === current ? ' h-[8px] w-8' : ' h-[6px] w-[6px]'}`}
                                                style={si === current
                                                    ? { background: '#3b82f6', boxShadow: '0 0 7px rgba(59,130,246,0.55)' }
                                                    : { background: 'rgba(255,255,255,0.28)' }}
                                            />
                                        </button>
                                    ))}
                                </div>

                                {/* CTA */}
                                <div className="px-6" style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 24px)' }}>
                                    <button
                                        onClick={advance}
                                        className="w-full text-white font-bold rounded-full text-[15px] transition-all duration-[160ms] active:scale-[0.985]"
                                        style={{
                                            paddingTop: 17, paddingBottom: 17,
                                            background: 'linear-gradient(160deg, #2563eb 0%, #1d4ed8 52%, #1e40af 100%)',
                                            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.13), 0 6px 20px rgba(29,78,216,0.21), 0 2px 6px rgba(29,78,216,0.12)',
                                        }}
                                    >
                                        {t('onboarding.continue')}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}
                </div>
            ))}

            {/* Bottom: dots + CTA — hidden on Slide 2 which has its own sheet controls */}
            <div
                className={`absolute bottom-0 inset-x-0 flex flex-col items-center px-7 gap-3${prefersReduced ? '' : ' hero-bottom-fade'}`}
                style={{
                    paddingBottom: 'calc(env(safe-area-inset-bottom) + 28px)',
                    display: current === 1 || current === 2 ? 'none' : 'flex',
                }}
            >
                <div className="flex gap-2 items-center" role="tablist" aria-label="Onboarding progress">
                    {slides.map((_, i) => (
                        <button
                            key={i}
                            role="tab"
                            aria-selected={i === current}
                            aria-label={`Slide ${i + 1} of ${SLIDE_COUNT}`}
                            onClick={() => goTo(i)}
                            className={`rounded-full transition-all duration-300${i === current ? ' h-[8px] w-8' : ' h-[6px] w-[6px]'}`}
                            style={i === current
                                ? { background: '#3b82f6', boxShadow: '0 0 7px rgba(59,130,246,0.55)' }
                                : { background: 'rgba(255,255,255,0.28)' }}
                        />
                    ))}
                </div>

                <button
                    onClick={advance}
                    className="w-full text-white font-bold py-[17px] rounded-full text-[15px] transition-all duration-[160ms] active:scale-[0.985]"
                    style={{
                        background: 'linear-gradient(160deg, #2563eb 0%, #1d4ed8 52%, #1e40af 100%)',
                        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.13), 0 6px 20px rgba(29,78,216,0.20), 0 2px 6px rgba(29,78,216,0.11)',
                    }}
                >
                    {current === 0 ? t('onboarding.get_started') : t('onboarding.continue')}
                </button>
            </div>
        </div>
    );
};
