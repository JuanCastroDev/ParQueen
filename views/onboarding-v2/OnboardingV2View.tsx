// Onboarding 2.0: arrival -> one-tap example (~8.3 s) -> three intentions.
// Faithful React port of the approved prototype gateb-freeze-v1.1. The prototype's simulated phone screen is
// replaced by the real sign-up: choosing an intention or "Already have an account?" hands off to the app.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import './onboardingV2.css';
import Logo from '../../assets/Parqueen_Logo.png';
import { setLang, translateIn, useLang, type Lang } from '../../i18n';
import type { OnboardingIntent } from '../../utils/onboardingIntent';
import { NeighborhoodScene, LeaveIntentIcon } from './NeighborhoodScene';
import { baseLayout, computeLayout, placeOverlays, type OnboardingLayout } from './onboardingV2Layout';
import { STORY_STEPS, STORY_TIMELINE, type StoryCaption } from './onboardingV2Timeline';

export type StoryState = 'arrive' | 'demo' | 'choose';

export type OnboardingV2AndroidBackHandle = { handleAndroidBack: () => 'handled' | 'minimize' };

type Props = {
  onChooseIntent: (intent: OnboardingIntent) => void;
  onAccount: () => void;
  androidBackRef?: React.MutableRefObject<OnboardingV2AndroidBackHandle | null>;
  /** Where to start; 'choose' when returning from the phone screen. */
  initialState?: 'arrive' | 'choose';
};

type Tr = (key: string) => string;

const CAPTION_KEY: Record<StoryCaption, string> = {
  cap1: 'onboarding_v2.caption_1', cap2: 'onboarding_v2.caption_2', cap3: 'onboarding_v2.caption_3',
};
const ALT_KEY: Record<StoryState, string> = {
  arrive: 'onboarding_v2.alt_arrive', demo: 'onboarding_v2.alt_demo', choose: 'onboarding_v2.alt_choose',
};

export function prefersReducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

const InfoIcon = () => (
  <svg width={15} height={15} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="#38bdf8" strokeWidth={2.2} strokeLinecap="round">
    <circle cx="12" cy="12" r="9" /><path d="M12 11v5" /><path d="M12 7.5v.5" />
  </svg>
);
const Chevron = () => (
  <svg width={18} height={18} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="rgba(255,255,255,0.6)" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
    <polyline points="9 6 15 12 9 18" />
  </svg>
);

const inertProps = (inactive: boolean) => (inactive ? ({ inert: '', 'aria-hidden': true, 'data-inactive': '' } as Record<string, unknown>) : {});

// ---------------------------------------------------------------- panels (shared by the live UI and the hidden measuring copies)
type ArriveProps = { measuring?: boolean; tr: Tr; onPlay?: () => void; onSkip?: () => void; onAccount?: () => void; className?: string; panelRef?: React.Ref<HTMLElement>; onScroll?: React.UIEventHandler; extra?: Record<string, unknown> };
const ArrivePanel = ({ measuring, tr, onPlay, onSkip, onAccount, className = '', panelRef, onScroll, extra }: ArriveProps) => (
  <section className={`panel p-arrive ${className}`} aria-labelledby={measuring ? undefined : 'obv2-h-arrive'} ref={panelRef as React.Ref<HTMLElement>} onScroll={onScroll} {...extra}>
    <span className="sr-only">ParQueen</span>
    <h1 id={measuring ? undefined : 'obv2-h-arrive'} tabIndex={-1}>{tr('onboarding_v2.headline_1')}<br />{tr('onboarding_v2.headline_2')}</h1>
    <p className="sub">{tr('onboarding_v2.supporting')}</p>
    <button type="button" className="btn btn-primary" style={{ marginTop: 22 }} onClick={onPlay}>{tr('onboarding_v2.primary')}</button>
    <div className="row2">
      <button type="button" className="text-btn" onClick={onSkip}>{tr('onboarding_v2.skip')}</button>
      <button type="button" className="link-btn" onClick={onAccount}>{tr('onboarding_v2.account')}</button>
    </div>
  </section>
);

type DemoProps = { measuring?: boolean; tr: Tr; caption: React.ReactNode; onSkip?: () => void; className?: string; panelRef?: React.Ref<HTMLElement>; onScroll?: React.UIEventHandler; extra?: Record<string, unknown>; captionRef?: React.Ref<HTMLHeadingElement> };
const DemoPanel = ({ measuring, tr, caption, onSkip, className = '', panelRef, onScroll, extra, captionRef }: DemoProps) => (
  <section className={`panel p-demo ${className}`} aria-labelledby={measuring ? undefined : 'obv2-cap'} ref={panelRef as React.Ref<HTMLElement>} onScroll={onScroll} {...extra}>
    <h1 className="caption" id={measuring ? undefined : 'obv2-cap'} tabIndex={-1} ref={captionRef}>{caption}</h1>
    <p className="trust"><InfoIcon /><span>{tr('onboarding_v2.disclosure')}</span></p>
    <button type="button" className="text-btn skip-demo" onClick={onSkip}>{tr('onboarding_v2.skip_to_choices')}</button>
  </section>
);

type ChooseProps = { measuring?: boolean; tr: Tr; picked?: OnboardingIntent | null; onIntent?: (i: OnboardingIntent) => void; onAccount?: () => void; className?: string; panelRef?: React.Ref<HTMLElement>; onScroll?: React.UIEventHandler; extra?: Record<string, unknown> };
const INTENTS: { id: OnboardingIntent; key: string; icon: React.ReactNode }[] = [
  { id: 'find', key: 'onboarding_v2.intent_find', icon: (
    <svg width={17} height={17} viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>) },
  { id: 'leave', key: 'onboarding_v2.intent_leave', icon: <LeaveIntentIcon /> },
  { id: 'explore', key: 'onboarding_v2.intent_explore', icon: (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" /><polygon points="15.5 8.5 13.5 13.5 8.5 15.5 10.5 10.5" fill="#60a5fa" /></svg>) },
];
const ChoosePanel = ({ measuring, tr, picked, onIntent, onAccount, className = '', panelRef, onScroll, extra }: ChooseProps) => (
  <section className={`panel p-choose ${className}`} aria-labelledby={measuring ? undefined : 'obv2-h-choose'} ref={panelRef as React.Ref<HTMLElement>} onScroll={onScroll} {...extra}>
    <p className="kicker">{tr('onboarding_v2.kicker')}</p>
    <h1 id={measuring ? undefined : 'obv2-h-choose'} tabIndex={-1}>{tr('onboarding_v2.choose_heading')}</h1>
    <div className="opts" role="group" aria-label={tr('onboarding_v2.intent_group')}>
      {INTENTS.map((it, i) => (
        <button
          key={it.id}
          type="button"
          className={`opt${picked === it.id ? ' picked' : ''}`}
          style={{ '--i': i } as React.CSSProperties}
          data-intent={it.id}
          onClick={() => onIntent?.(it.id)}
        >
          <span className="ic" aria-hidden="true">{it.icon}</span>
          <span className="lbl">{tr(it.key)}</span>
          <Chevron />
        </button>
      ))}
    </div>
    <p className="trust-line"><InfoIcon /><span>{tr('onboarding_v2.disclosure')}</span></p>
    <div className="row1"><button type="button" className="link-btn" onClick={onAccount}>{tr('onboarding_v2.account')}</button></div>
  </section>
);

const BrandMini = ({ measureRef }: { measureRef?: React.Ref<HTMLDivElement> }) => (
  <div className="brand-mini" aria-hidden="true" ref={measureRef}>
    <img src={Logo} alt="" draggable={false} /><span className="wm">ParQueen</span>
  </div>
);
const BrandHero = ({ measureRef }: { measureRef?: React.Ref<HTMLDivElement> }) => (
  <div className="brand-hero" aria-hidden="true" ref={measureRef}>
    <img src={Logo} alt="" draggable={false} /><span className="wm">ParQueen</span>
  </div>
);

// ---------------------------------------------------------------- view
export const OnboardingV2View = ({ onChooseIntent, onAccount, androidBackRef, initialState = 'arrive' }: Props) => {
  const lang = useLang();
  const tr: Tr = useCallback(key => translateIn(lang, key), [lang]);
  const reduce = prefersReducedMotion();

  const [state, setStateRaw] = useState<StoryState>(initialState);
  const [playing, setPlaying] = useState(false);
  const [replaying, setReplaying] = useState(false);
  const [intro, setIntro] = useState(() => initialState === 'arrive' && !prefersReducedMotion());
  const [caption, setCaption] = useState<{ key: StoryCaption; animate: boolean } | null>(null);
  const [picked, setPicked] = useState<OnboardingIntent | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [atEnd, setAtEnd] = useState<Record<StoryState, boolean>>({ arrive: true, demo: true, choose: true });
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 360, h: 712 });
  const [layout, setLayout] = useState<OnboardingLayout | null>(null);
  const [overlays, setOverlays] = useState<{ scrimTop: number; replayTop: number }>({ scrimTop: 0, replayTop: 0 });
  const [fontsReady, setFontsReady] = useState(0);

  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const stageRef = useRef<HTMLDivElement>(null);
  const hdrRef = useRef<HTMLDivElement>(null);
  const langRef = useRef<HTMLDivElement>(null);
  const panelRefs = { arrive: useRef<HTMLElement>(null), demo: useRef<HTMLElement>(null), choose: useRef<HTMLElement>(null) };
  const replayRef = useRef<HTMLButtonElement>(null);
  const measure = {
    story: useRef<Array<HTMLElement | null>>([]),
    arrive: useRef<HTMLElement>(null),
    arriveTight: useRef<HTMLElement>(null),
    hero: useRef<HTMLDivElement>(null),
    mini: useRef<HTMLDivElement>(null),
  };
  const pendingFocus = useRef<StoryState | null>(null);
  const replayAfterReset = useRef(false);

  const clearTimers = () => { timers.current.forEach(clearTimeout); timers.current = []; };
  const later = (ms: number, fn: () => void) => { timers.current.push(setTimeout(fn, ms)); };

  const setStoryState = (next: StoryState, focus = true) => {
    setStateRaw(next);
    pendingFocus.current = focus ? next : null;
  };

  // ---- size tracking
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const read = () => setSize(prev => (prev.w === el.clientWidth && prev.h === el.clientHeight) ? prev : { w: el.clientWidth, h: el.clientHeight });
    read();
    const RO = (window as unknown as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
    const ro = RO ? new RO(read) : null;
    ro?.observe(el);
    window.addEventListener('resize', read);
    return () => { ro?.disconnect(); window.removeEventListener('resize', read); };
  }, []);
  useEffect(() => {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    fonts?.ready?.then(() => setFontsReady(n => n + 1)).catch(() => {});
  }, []);

  const base = baseLayout(size.w, size.h);

  // ---- camera + panel layout (one camera per size, shared by every state and both languages)
  useLayoutEffect(() => {
    const stage = stageRef.current, hdr = hdrRef.current, langEl = langRef.current;
    if (!stage || !hdr || !langEl) return;
    const storyHeights = measure.story.current.filter(Boolean).map(el => (el as HTMLElement).offsetHeight);
    const hero = measure.hero.current;
    const next = computeLayout(base, {
      insetTop: hdr.offsetTop,
      storyPanelHeight: storyHeights.length ? Math.max(...storyHeights) : 0,
      arrivalHeight: measure.arrive.current?.offsetHeight ?? 0,
      arrivalTightHeight: measure.arriveTight.current?.offsetHeight ?? 0,
      heroBottom: hero ? hero.offsetTop + hero.offsetHeight : 0,
      heroHeight: hero?.offsetHeight ?? 0,
      headerSpace: langEl.getBoundingClientRect().left - hdr.getBoundingClientRect().left,
      brandMiniWidth: measure.mini.current?.offsetWidth ?? 0,
    });
    setLayout(prev => (prev && JSON.stringify(prev) === JSON.stringify(next)) ? prev : next);
  }, [size.w, size.h, lang, fontsReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- scrim and Replay placement follow the live panel heights
  useLayoutEffect(() => {
    if (!layout || layout.land) return;
    const active = panelRefs[state].current, choose = panelRefs.choose.current;
    const next = placeOverlays(layout, state, active?.offsetHeight ?? 0, choose?.offsetHeight ?? 0, replayRef.current?.offsetHeight ?? 40);
    setOverlays(prev => (prev.scrimTop === next.scrimTop && prev.replayTop === next.replayTop) ? prev : next);
    const p = panelRefs[state].current;
    if (p) {
      p.scrollTop = 0;
      const end = p.scrollHeight <= p.clientHeight + 4;
      setAtEnd(prev => (prev[state] === end ? prev : { ...prev, [state]: end }));
    }
  }, [layout, state, lang]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- focus the new heading after a state change
  useEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const id = { arrive: 'obv2-h-arrive', demo: 'obv2-cap', choose: 'obv2-h-choose' }[target];
    const t = setTimeout(() => document.getElementById(id)?.focus({ preventScroll: true }), STORY_TIMELINE.focusDelay);
    return () => clearTimeout(t);
  }, [state]);

  // ---- opening: logo first, then the street
  useEffect(() => {
    if (!intro) return;
    const t = setTimeout(() => setIntro(false), STORY_TIMELINE.introDuration);
    return () => clearTimeout(t);
  }, [intro]);

  useEffect(() => () => clearTimers(), []);

  // ---- story
  const toChoose = useCallback(() => {
    clearTimers();
    setStoryState('choose');
    setAnnouncement('');
    later(STORY_TIMELINE.announceDelay, () => setAnnouncement(translateIn(lang, 'onboarding_v2.done')));
  }, [lang]); // eslint-disable-line react-hooks/exhaustive-deps

  const startPlay = useCallback(() => {
    clearTimers();
    setIntro(false);
    if (prefersReducedMotion()) { setPlaying(false); toChoose(); return; }
    setCaption({ key: 'cap1', animate: true });
    setStoryState('demo');
    setPlaying(true);
    for (const step of STORY_STEPS) {
      later(step.at, () => {
        if (step.action === 'caption') setCaption({ key: step.caption, animate: true });
        else toChoose();
      });
    }
  }, [toChoose]); // eslint-disable-line react-hooks/exhaustive-deps

  const play = () => {
    if (playing || state === 'demo') return;
    startPlay();
  };

  // Replay: drop back to the arrival pose without transitions, then run the story again.
  const replay = () => {
    clearTimers();
    setPlaying(false);
    setReplaying(true);
    setStateRaw('arrive');
    replayAfterReset.current = true;
  };
  useLayoutEffect(() => {
    if (!replaying || !replayAfterReset.current) return;
    replayAfterReset.current = false;
    void stageRef.current?.offsetWidth;   // commit the reset pose before the animations restart
    setReplaying(false);
    startPlay();
  }, [replaying, startPlay]);

  const skip = () => { setPlaying(false); toChoose(); };
  const toArrive = () => { clearTimers(); setPlaying(false); setCaption(null); setStoryState('arrive'); };

  const chooseIntent = (intent: OnboardingIntent) => {
    if (picked) return;
    if (prefersReducedMotion()) { onChooseIntent(intent); return; }
    setPicked(intent);
    later(STORY_TIMELINE.pickDelay, () => { setPicked(null); onChooseIntent(intent); });
  };

  const switchLang = (next: Lang) => { if (next !== lang) setLang(next); };

  // Android system Back: the story steps back to arrival; on arrival the app minimizes.
  useEffect(() => {
    if (!androidBackRef) return;
    androidBackRef.current = {
      handleAndroidBack: () => {
        if (state === 'arrive') return 'minimize';
        toArrive();
        return 'handled';
      },
    };
    return () => { if (androidBackRef.current) androidBackRef.current = null; };
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const onPanelScroll = (name: StoryState) => (e: React.UIEvent<HTMLElement>) => {
    const p = e.currentTarget;
    const end = p.scrollTop + p.clientHeight >= p.scrollHeight - 4;
    setAtEnd(prev => (prev[name] === end ? prev : { ...prev, [name]: end }));
  };

  const L = layout;
  const classes = [
    'pq-obv2', `s-${state}`,
    playing && 'play', intro && 'intro', replaying && 'replaying', picked && 'leaving',
    base.land && 'land', base.short && 'short', base.tiny && 'tiny',
    L?.scrollPanel && 'scroll-panel', L?.arriveUnder && 'arrive-under', L?.arriveTight && 'arrive-tight',
    L?.arriveCompact && 'arrive-compact', L?.arriveScroll && 'arrive-scroll', L?.logoOnly && 'logo-only',
    !L && 'obv2-measuring',
  ].filter(Boolean).join(' ');
  const stageStyle = {
    ...(L?.panelMax != null ? { '--pmax': `${L.panelMax}px` } : {}),
    ...(L?.arriveMax != null ? { '--amax': `${L.arriveMax}px` } : {}),
    ...(L?.arriveTop != null ? { '--arrive-top': `${L.arriveTop}px` } : {}),
  } as React.CSSProperties;
  const transform = L ? `translate(${L.tx}px, ${L.ty}px) scale(${L.k})` : `scale(${size.w / 390})`;
  const captionNode = caption
    ? <span className={caption.animate && !reduce ? 'cap-new' : ''} key={`${caption.key}-${lang}`}>{tr(CAPTION_KEY[caption.key])}</span>
    : null;

  return (
    <div className="pq-obv2-host">
      <div className={classes} ref={stageRef} lang={lang} style={stageStyle} data-testid="obv2-stage" data-state={state}>
        <NeighborhoodScene
          altText={tr(ALT_KEY[state])}
          carLabel={tr('onboarding_v2.car_label')}
          carTappable={state === 'arrive'}
          onCarTap={play}
          transform={transform}
        />
        <div className="scrim-top" aria-hidden="true" />
        <div className="scrim-bottom" aria-hidden="true" style={{ transform: `translateY(${overlays.scrimTop}px)` }} />
        <button
          type="button"
          className="replay-pill"
          ref={replayRef}
          hidden={state !== 'choose'}
          onClick={replay}
          style={L && !L.land ? { top: overlays.replayTop } : undefined}
        >
          <svg width={15} height={15} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><path d="M3 12a9 9 0 1 0 3-6.7" /><polyline points="3 3 3 9 9 9" /></svg>
          <span>{tr('onboarding_v2.replay')}</span>
        </button>

        <BrandHero />
        <div className="hdr" ref={hdrRef}>
          <div className="hdr-left">
            <button type="button" className="icon-btn" aria-label={tr('onboarding_v2.back')} hidden={state === 'arrive'} onClick={toArrive}>
              <svg width={22} height={22} viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round"><polyline points="15 6 9 12 15 18" /></svg>
            </button>
            <BrandMini />
          </div>
          <div className="lang" role="group" aria-label={tr('onboarding_v2.lang_label')} ref={langRef}>
            <button type="button" aria-pressed={lang === 'en'} lang="en" aria-label="English" onClick={() => switchLang('en')}>EN</button>
            <button type="button" aria-pressed={lang === 'es'} lang="es" aria-label="Español" onClick={() => switchLang('es')}>ES</button>
          </div>
        </div>

        <ArrivePanel
          tr={tr}
          onPlay={play}
          onSkip={skip}
          onAccount={onAccount}
          className={atEnd.arrive ? 'at-end' : ''}
          panelRef={panelRefs.arrive}
          onScroll={onPanelScroll('arrive')}
          extra={state === 'arrive' ? undefined : inertProps(true)}
        />
        <DemoPanel
          tr={tr}
          caption={captionNode}
          onSkip={skip}
          className={atEnd.demo ? 'at-end' : ''}
          panelRef={panelRefs.demo}
          onScroll={onPanelScroll('demo')}
          extra={state === 'demo' ? undefined : inertProps(true)}
        />
        <ChoosePanel
          tr={tr}
          picked={picked}
          onIntent={chooseIntent}
          onAccount={onAccount}
          className={atEnd.choose ? 'at-end' : ''}
          panelRef={panelRefs.choose}
          onScroll={onPanelScroll('choose')}
          extra={state === 'choose' ? undefined : inertProps(true)}
        />

        {/* Hidden copies used only to measure: both languages, so the camera never moves when the language changes. */}
        <div className="obv2-measure" aria-hidden="true" {...({ inert: '' } as Record<string, string>)}>
          {(['en', 'es'] as const).flatMap((l, li) => [
            <DemoPanel measuring key={`d-${l}`} tr={k => translateIn(l, k)} caption={<span>{[translateIn(l, CAPTION_KEY.cap1), translateIn(l, CAPTION_KEY.cap2), translateIn(l, CAPTION_KEY.cap3)].sort((a, b) => b.length - a.length)[0]}</span>} panelRef={el => { measure.story.current[li * 2] = el; }} />,
            <ChoosePanel measuring key={`c-${l}`} tr={k => translateIn(l, k)} panelRef={el => { measure.story.current[li * 2 + 1] = el; }} />,
          ])}
          <ArrivePanel measuring tr={tr} panelRef={measure.arrive} />
          <ArrivePanel measuring tr={tr} className="measure-tight" panelRef={measure.arriveTight} />
          <BrandHero measureRef={measure.hero} />
          <BrandMini measureRef={measure.mini} />
        </div>

        <div className="sr-only" aria-live="polite" data-testid="obv2-live">{announcement}</div>
      </div>
    </div>
  );
};
