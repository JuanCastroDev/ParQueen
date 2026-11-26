import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  Bell, Camera, Check, CheckCircle2, ChevronLeft, Clock, CloudOff, Info, Lock, Map as MapIcon,
  RefreshCw, RotateCcw, ScanLine, X, XOctagon,
} from 'lucide-react';
import { analyzeParkingSign, SIGN_ANALYSIS_UNAVAILABLE_EXPLANATION, type SignAnalysisResult } from '../../services/geminiService';
import { resolveSignScannerAndroidBack } from '../../utils/androidBackNavigation';
import { useParkingTimer } from '../street-parking/useParkingTimer';
import { t, useLang } from '../../i18n';
import { clearRecentScans, loadRecentScans, recordScan, restoreRecentScans, type RecentScan } from '../../utils/recentScans';
import { fileToSignImage, type SignImage } from '../../utils/signScanner';
import { SignScannerArt, StackedSignsGlyph, UnreadableGlyph } from './SignScannerArt';
import {
  capitalize, dayWord, errorKindFor, formatClock, formatScanTime, relativeIn, reminderMinutesFor,
  reminderOffered, REMINDER_TIMER_LABEL, splitExplanation, timingEventFor, verdictFor,
  type ResultStatus, type VerdictTone,
} from './signScannerPresentation';
import './signScanner.css';

type Phase = 'home' | 'preview' | 'reading' | 'result' | 'error';

export type SignScannerAndroidBackHandle = {
  handleAndroidBack: () => 'handled' | 'leave';
};

interface SignScannerViewProps {
  /** Leaves the scanner for the map. The home screen's back control calls this. */
  onBack?: () => void;
  /** Lets App mirror the visible Back for Android system Back. */
  androidBackRef?: React.MutableRefObject<SignScannerAndroidBackHandle | null>;
}

/**
 * When focus returns from the system camera without a photo, wait this long for a late
 * `change` event before deciding nothing came back.
 */
const CAMERA_RETURN_GRACE_MS = 1200;
const READING_STEP_MS = 1600;
const UNDO_MS = 5000;

type IconProps = { size: number; strokeWidth: number; 'aria-hidden': true };
const ICON: IconProps = { size: 20, strokeWidth: 2, 'aria-hidden': true };
const SMALL: IconProps = { size: 16, strokeWidth: 2, 'aria-hidden': true };

const toneIcon = (tone: VerdictTone, props = SMALL) =>
  tone === 'ok' ? <CheckCircle2 {...props} /> : tone === 'bad' ? <XOctagon {...props} /> : <Clock {...props} />;

export const SignScannerView = ({ onBack, androidBackRef }: SignScannerViewProps = {}) => {
  const lang = useLang();
  const [phase, setPhase] = useState<Phase>('home');
  const [photo, setPhoto] = useState<SignImage | null>(null);
  const [analysis, setAnalysis] = useState<SignAnalysisResult | null>(null);
  const [analyzedAt, setAnalyzedAt] = useState(0);
  const [recent, setRecent] = useState<RecentScan[]>(() => loadRecentScans());
  const [newScanId, setNewScanId] = useState<string | null>(null);
  const [cameraMissed, setCameraMissed] = useState(false);
  const [readingStep, setReadingStep] = useState(0);
  const [reminderStarted, setReminderStarted] = useState(false);
  const [undoScans, setUndoScans] = useState<RecentScan[] | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const ctaRef = useRef<HTMLButtonElement>(null);
  const clearRef = useRef<HTMLButtonElement>(null);
  const undoRef = useRef<HTMLButtonElement>(null);
  /** Where focus goes after the undo toast closes: back to Clear (undone) or to the CTA (expired). */
  const focusAfterToastRef = useRef<'clear' | 'cta' | null>(null);
  const focusRef = useRef<HTMLHeadingElement>(null);
  const bodyRef = useRef<HTMLElement>(null);
  /** Blocks a second camera launch while the first is still open. */
  const captureInFlightRef = useRef(false);
  const fileArrivedRef = useRef(false);
  const missTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Blocks a second analyze while one is in flight (fast double tap). */
  const inFlightRef = useRef(false);
  /** Bumped on cancel / leave so a late response is dropped instead of replacing the screen. */
  const requestIdRef = useRef(0);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const { startTimer, timer } = useParkingTimer();
  const reminderSet = reminderStarted && !!timer;

  /* Focus the new screen's heading on every phase change (and on mount), and start at the top. */
  useEffect(() => {
    focusRef.current?.focus?.({ preventScroll: true });
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, [phase]);

  /* Rotate the reading sub-line while waiting. */
  useEffect(() => {
    if (phase !== 'reading') return;
    setReadingStep(0);
    const id = setInterval(() => setReadingStep(s => s + 1), READING_STEP_MS);
    return () => clearInterval(id);
  }, [phase]);

  /* Undo window for "Clear recent scans". The button that had focus is gone, so focus moves to
     Undo while the toast is up, then somewhere sensible when it closes. */
  useEffect(() => {
    if (!undoScans) {
      const target = focusAfterToastRef.current === 'clear' ? clearRef.current : focusAfterToastRef.current === 'cta' ? ctaRef.current : null;
      focusAfterToastRef.current = null;
      target?.focus?.();
      return;
    }
    undoRef.current?.focus?.();
    const id = setTimeout(() => {
      if (typeof document !== 'undefined' && document.activeElement === undoRef.current) focusAfterToastRef.current = 'cta';
      setUndoScans(null);
    }, UNDO_MS);
    return () => clearTimeout(id);
  }, [undoScans]);

  /* Camera return: the WebView regains focus when the system camera closes. If no file follows,
     the user cancelled (or the camera could not open), so say so calmly on the home screen. */
  const noteCameraReturnedEmpty = useCallback(() => {
    if (!fileArrivedRef.current && phaseRef.current === 'home') setCameraMissed(true);
  }, []);

  useEffect(() => {
    const onFocus = () => {
      if (!captureInFlightRef.current) return;
      captureInFlightRef.current = false;
      if (missTimerRef.current) clearTimeout(missTimerRef.current);
      missTimerRef.current = setTimeout(noteCameraReturnedEmpty, CAMERA_RETURN_GRACE_MS);
    };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      if (missTimerRef.current) clearTimeout(missTimerRef.current);
    };
  }, [noteCameraReturnedEmpty]);

  /* Chromium (Android WebView 113+) also fires `cancel` on the input when the picker is dismissed. */
  useEffect(() => {
    const node = fileInputRef.current;
    if (!node || typeof node.addEventListener !== 'function') return;
    const onCancel = () => {
      captureInFlightRef.current = false;
      noteCameraReturnedEmpty();
    };
    node.addEventListener('cancel', onCancel);
    return () => node.removeEventListener('cancel', onCancel);
  }, [noteCameraReturnedEmpty]);

  const openCamera = () => {
    if (captureInFlightRef.current) return;
    const node = fileInputRef.current;
    if (!node || typeof node.click !== 'function') return;
    captureInFlightRef.current = true;
    fileArrivedRef.current = false;
    setCameraMissed(false);
    node.click();
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    captureInFlightRef.current = false;
    // Allow re-picking the same file twice in a row.
    event.target.value = '';
    if (!file) {
      noteCameraReturnedEmpty();
      return;
    }
    fileArrivedRef.current = true;
    setCameraMissed(false);
    void fileToSignImage(file).then((captured) => {
      if (!captured) return;
      requestIdRef.current += 1;
      inFlightRef.current = false;
      setPhoto(captured);
      setAnalysis(null);
      setReminderStarted(false);
      setPhase('preview');
    });
  };

  const analyze = useCallback(async () => {
    if (!photo || inFlightRef.current) return;
    inFlightRef.current = true;
    const requestId = ++requestIdRef.current;
    setReminderStarted(false);
    setPhase('reading');
    let result: SignAnalysisResult;
    try {
      result = await analyzeParkingSign(photo.imageData);
    } catch {
      result = { status: 'ERROR', explanation: SIGN_ANALYSIS_UNAVAILABLE_EXPLANATION };
    }
    if (requestId !== requestIdRef.current) return; // cancelled, or a newer photo replaced this one
    inFlightRef.current = false;
    setAnalysis(result);
    setAnalyzedAt(Date.now());
    if (result.status === 'ERROR') {
      // A failed read is not a scan the user made; it is never recorded.
      setPhase('error');
      return;
    }
    const before = new Set(recent.map(s => s.id));
    const next = recordScan(result);
    setRecent(next);
    setNewScanId(next[0] && !before.has(next[0].id) ? next[0].id : null);
    setPhase('result');
  }, [photo, recent]);

  const goHome = useCallback(() => {
    requestIdRef.current += 1;
    inFlightRef.current = false;
    setPhoto(null);
    setAnalysis(null);
    setReminderStarted(false);
    setRecent(loadRecentScans());
    setPhase('home');
  }, []);

  const leave = () => onBack?.();

  /* Android system Back mirrors the visible back control. */
  const goHomeRef = useRef(goHome);
  goHomeRef.current = goHome;
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack;
  useEffect(() => {
    if (!androidBackRef) return;
    androidBackRef.current = {
      handleAndroidBack: () => {
        if (resolveSignScannerAndroidBack(phaseRef.current === 'home') === 'backToScannerHome') {
          goHomeRef.current();
          return 'handled';
        }
        onBackRef.current?.();
        return 'leave';
      },
    };
    return () => { androidBackRef.current = null; };
  }, [androidBackRef]);

  const setReminder = () => {
    if (!analysis || !reminderOffered(analysis) || reminderSet) return;
    startTimer(reminderMinutesFor(analysis, Date.now()), REMINDER_TIMER_LABEL);
    setReminderStarted(true);
  };

  const clearRecent = () => {
    setUndoScans(recent);
    clearRecentScans();
    setRecent([]);
    setNewScanId(null);
  };
  const undoClear = () => {
    if (!undoScans) return;
    setRecent(restoreRecentScans(undoScans));
    focusAfterToastRef.current = 'clear';
    setUndoScans(null);
  };

  /* ── header ─────────────────────────────────────────────────────────────── */
  const backLabel = phase === 'home' ? t('scanner.back_map_aria')
    : phase === 'preview' ? t('scanner.discard_aria')
    : phase === 'reading' ? t('scanner.stop_aria')
    : t('scanner.back_home_aria');

  const header = (
    <header className="pq-scan-head">
      <button
        type="button"
        className="pq-scan-back"
        onClick={phase === 'home' ? leave : goHome}
        aria-label={backLabel}
      >
        <ChevronLeft {...ICON} />
      </button>
      <h1
        ref={phase === 'home' ? focusRef : undefined}
        tabIndex={-1}
        className="pq-scan-title"
      >
        {t('scanner.title')}
      </h1>
    </header>
  );

  const photoFrame = (reading: boolean) => photo && (
    <div className={`pq-scan-photo${reading ? ' pq-scan-photo--reading' : ''}`}>
      <img src={photo.previewUrl} alt={t('scanner.photo_alt')} />
      <span className="pq-scan-corner pq-scan-corner--tl" aria-hidden="true" />
      <span className="pq-scan-corner pq-scan-corner--tr" aria-hidden="true" />
      <span className="pq-scan-corner pq-scan-corner--bl" aria-hidden="true" />
      <span className="pq-scan-corner pq-scan-corner--br" aria-hidden="true" />
      {reading && <span className="pq-scan-photo-sweep" aria-hidden="true" />}
    </div>
  );

  /* ── screens ────────────────────────────────────────────────────────────── */
  let body: React.ReactNode;
  let foot: React.ReactNode = null;
  let footClass = 'pq-scan-foot--stack';

  if (phase === 'home') {
    const hasHistory = recent.length > 0;
    const now = new Date();
    body = (
      <>
        <SignScannerArt compact={hasHistory} />
        <section className="pq-scan-intro">
          <h2 className="pq-scan-headline">{t('scanner.headline')}</h2>
          <p className="pq-scan-lede">{t('scanner.lede')}</p>
        </section>
        <div className="pq-scan-cta-block">
          <button ref={ctaRef} type="button" className="pq-scan-cta" onClick={openCamera}>
            <Camera {...ICON} />
            {t('scanner.cta')}
          </button>
          <p className="pq-scan-micro">
            <Lock size={14} strokeWidth={2} aria-hidden />
            {t('scanner.camera_note')}
          </p>
          {cameraMissed && (
            <div className="pq-scan-hint" role="status">
              <Info {...SMALL} />
              <span><strong>{t('scanner.miss_title')}</strong> {t('scanner.miss_body')}</span>
              <button
                type="button"
                className="pq-scan-hint-x"
                onClick={() => setCameraMissed(false)}
                aria-label={t('scanner.dismiss')}
              >
                <X {...SMALL} />
              </button>
            </div>
          )}
        </div>
        {!hasHistory && (
          <aside className="pq-scan-tip">
            <StackedSignsGlyph />
            <p><strong>{t('scanner.tip_title')}</strong> {t('scanner.tip_body')}</p>
          </aside>
        )}
        {hasHistory && (
          <section className="pq-scan-recent" aria-labelledby="pq-scan-recent-h">
            <div className="pq-scan-recent-head">
              <h2 id="pq-scan-recent-h">{t('scanner.recent_title')}</h2>
              <span className="pq-scan-recent-note">{t('scanner.recent_note')}</span>
              <button
                ref={clearRef}
                type="button"
                className="pq-scan-recent-clear"
                onClick={clearRecent}
                aria-label={t('scanner.recent_clear_aria')}
              >
                {t('scanner.recent_clear')}
              </button>
            </div>
            <ul className="pq-scan-recent-list">
              {recent.map(scan => {
                const v = verdictFor((scan.status === 'ERROR' ? 'CONDITIONAL' : scan.status) as ResultStatus);
                return (
                  <li key={scan.id} className={`pq-scan-row${scan.id === newScanId ? ' pq-scan-row--new' : ''}`}>
                    <span className={`pq-scan-glyph pq-scan-tone-${v.tone}`}>{toneIcon(v.tone)}</span>
                    <span>
                      <span className="pq-scan-row-title">{scan.title}</span>
                      <span className="pq-scan-row-meta">
                        {t(v.shortKey)} · {formatScanTime(scan.ts, now, lang)}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </>
    );
  } else if (phase === 'preview') {
    body = (
      <>
        <p className="pq-scan-eyebrow">{t('scanner.preview_eyebrow')}</p>
        <h2 ref={focusRef} tabIndex={-1} className="pq-scan-h2">{t('scanner.preview_title')}</h2>
        {photoFrame(false)}
        <ul className="pq-scan-checks">
          <li>{t('scanner.preview_check_text')}</li>
          <li>{t('scanner.preview_check_stack')}</li>
        </ul>
      </>
    );
    footClass = 'pq-scan-foot--row';
    foot = (
      <>
        <button type="button" className="pq-scan-btn2" onClick={openCamera}>
          <RotateCcw {...SMALL} />{t('scanner.retake')}
        </button>
        <button type="button" className="pq-scan-cta" onClick={() => { void analyze(); }}>
          <ScanLine {...ICON} />{t('scanner.read_cta')}
        </button>
      </>
    );
  } else if (phase === 'reading') {
    const steps = [t('scanner.reading_step_1'), t('scanner.reading_step_2')];
    body = (
      <>
        <p className="pq-scan-eyebrow">{t('scanner.reading_eyebrow')}</p>
        <div role="status" aria-live="polite">
          <h2 ref={focusRef} tabIndex={-1} className="pq-scan-h2">{t('scanner.reading_title')}</h2>
        </div>
        {photoFrame(true)}
        <div className="pq-scan-progress">
          <div className="pq-scan-bar" aria-hidden="true" />
          <p className="pq-scan-sub" aria-hidden="true">{steps[readingStep % steps.length]}</p>
        </div>
      </>
    );
    foot = (
      <button type="button" className="pq-scan-btn3" onClick={goHome}>{t('scanner.cancel')}</button>
    );
  } else if (phase === 'result' && analysis && analysis.status !== 'ERROR') {
    const status = analysis.status as ResultStatus;
    const v = verdictFor(status);
    const now = new Date(analyzedAt || Date.now());
    const { headline, body: detail } = splitExplanation(analysis.explanation);
    const event = timingEventFor(analysis, now.getTime());
    const offerReminder = reminderOffered(analysis);
    let reminderLabel = '';
    if (offerReminder) {
      const minutes = reminderMinutesFor(analysis, now.getTime());
      const startsAt = analysis.restrictionStartsAt ? new Date(analysis.restrictionStartsAt) : null;
      const usesStart = !!startsAt && Math.ceil((startsAt.getTime() - now.getTime()) / 60_000) === minutes;
      if (!usesStart) {
        reminderLabel = t('scanner.remind_in_hour');
      } else {
        const at = new Date(now.getTime() + minutes * 60_000);
        const day = dayWord(at, now, lang);
        reminderLabel = day
          ? t('scanner.remind_on', { day, time: formatClock(at, lang) })
          : t('scanner.remind_at', { time: formatClock(at, lang) });
      }
    }
    const eventDay = event ? dayWord(event.at, now, lang) : null;
    const eventSub = event ? [eventDay && capitalize(eventDay), relativeIn(event.at, now, lang)].filter(Boolean).join(' · ') : '';

    body = (
      <>
        <div role="status" aria-live="polite">
          <div className="pq-scan-res-top">
            <div>
              <p className="pq-scan-eyebrow">{t('scanner.result_eyebrow')}</p>
              <span className={`pq-scan-pill pq-scan-tone-${v.tone}`}>{toneIcon(v.tone, { ...SMALL, size: 18 })}{t(v.labelKey)}</span>
            </div>
            {photo && <img className="pq-scan-thumb" src={photo.previewUrl} alt={t('scanner.thumb_alt')} />}
          </div>
          <h2 ref={focusRef} tabIndex={-1} className="pq-scan-res-h">{headline}</h2>
          {detail && <p className="pq-scan-res-body">{detail}</p>}
        </div>

        {status === 'CONDITIONAL' && (
          <>
            <p className="pq-scan-cond">{t('scanner.conditional_note')}</p>
            <button type="button" className="pq-scan-link" onClick={openCamera}>
              <RotateCcw {...SMALL} />{t('scanner.retake_clearer')}
            </button>
          </>
        )}

        {event && (
          <div className="pq-scan-time" role="group" aria-label={t('scanner.timing_aria')}>
            <span>
              <span className="pq-scan-time-k">{t('scanner.now')}</span>
              <span className="pq-scan-time-v">{formatClock(now, lang)}<small>{t('scanner.today')}</small></span>
            </span>
            <span
              className="pq-scan-track"
              aria-hidden="true"
              style={{ ['--pq-scan-event' as string]: event.kind === 'starts' ? 'var(--color-warning)' : 'var(--color-success)' }}
            />
            <span className="pq-scan-time-end">
              <span className="pq-scan-time-k">{t(event.kind === 'starts' ? 'scanner.restriction_starts' : 'scanner.restriction_ends')}</span>
              <span className="pq-scan-time-v">{formatClock(event.at, lang)}<small>{eventSub || ' '}</small></span>
            </span>
          </div>
        )}

        {analysis.actionableAdvice && (
          <div className="pq-scan-advice">
            <p><Clock {...SMALL} size={18} /><span>{analysis.actionableAdvice}</span></p>
            {offerReminder && (
              <button type="button" className="pq-scan-remind" onClick={setReminder} aria-pressed={reminderSet}>
                {reminderSet ? <Check {...SMALL} /> : <Bell {...SMALL} />}
                {reminderSet ? t('scanner.reminder_set') : reminderLabel}
              </button>
            )}
          </div>
        )}

        <p className="pq-scan-boundary">
          <Info {...SMALL} />
          <span><strong>{t('scanner.boundary_strong')}</strong> {t('scanner.boundary_body')}</span>
        </p>
      </>
    );
    foot = (
      <>
        <button type="button" className="pq-scan-cta" onClick={leave}>
          <MapIcon {...ICON} />{t('scanner.back_to_map')}
        </button>
        <button type="button" className="pq-scan-btn2" onClick={openCamera}>
          <Camera {...SMALL} />{t('scanner.scan_another')}
        </button>
      </>
    );
  } else if (phase === 'error' && analysis) {
    const kind = errorKindFor(analysis);
    body = (
      <>
        {kind === 'unreadable'
          ? <UnreadableGlyph />
          : <span className="pq-scan-err-icon" aria-hidden="true"><CloudOff size={34} strokeWidth={1.6} /></span>}
        <div role="alert">
          <h2 ref={focusRef} tabIndex={-1} className="pq-scan-h2">
            {t(kind === 'unreadable' ? 'scanner.error_unreadable_title' : 'scanner.error_unavailable_title')}
          </h2>
        </div>
        <p className="pq-scan-err-body">
          {t(kind === 'unreadable' ? 'scanner.error_unreadable_body' : 'scanner.error_unavailable_body')}
        </p>
        {photo && (
          <p className="pq-scan-err-photo">
            <img className="pq-scan-thumb" src={photo.previewUrl} alt={t('scanner.thumb_alt')} />
            {t('scanner.error_not_saved')}
          </p>
        )}
      </>
    );
    const retake = (primary: boolean) => (
      <button key="retake" type="button" className={primary ? 'pq-scan-cta' : 'pq-scan-btn2'} onClick={openCamera}>
        {primary ? <Camera {...ICON} /> : <RotateCcw {...SMALL} />}{t('scanner.retake_photo')}
      </button>
    );
    const retry = (primary: boolean) => (
      <button key="retry" type="button" className={primary ? 'pq-scan-cta' : 'pq-scan-btn2'} onClick={() => { void analyze(); }}>
        <RefreshCw {...(primary ? ICON : SMALL)} />{t(primary ? 'scanner.try_again' : 'scanner.try_photo_again')}
      </button>
    );
    foot = kind === 'unreadable' ? <>{retake(true)}{retry(false)}</> : <>{retry(true)}{retake(false)}</>;
  }

  return (
    <div className="pq-scan">
      {/* Camera-only capture: the phone's own camera via a file input. No gallery, no plugin. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        tabIndex={-1}
        aria-hidden="true"
        onChange={handleFileChange}
      />
      {header}
      <main
        ref={bodyRef}
        key={phase}
        className={`pq-scan-body pq-scan-screen${foot ? ' pq-scan-body--footed' : ''}`}
      >
        {body}
      </main>
      {foot && <footer className={`pq-scan-foot ${footClass}`}>{foot}</footer>}
      {undoScans && (
        <div className="pq-scan-toast" role="status">
          <span>{t('scanner.recent_cleared')}</span>
          <button ref={undoRef} type="button" onClick={undoClear}>{t('scanner.undo')}</button>
        </div>
      )}
    </div>
  );
};
