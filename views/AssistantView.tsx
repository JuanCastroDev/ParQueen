import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useFocusOnMount } from '../hooks/useFocusOnMount';
import {
  Camera, AlertCircle, CheckCircle2, Clock, Bell, ChevronLeft, ChevronRight,
  ShieldCheck, ImageIcon, X, ScanLine,
} from 'lucide-react';
import { HydrantDistanceTool } from './assistant/HydrantDistanceTool';
import { ParkingCheckTool } from './assistant/ParkingCheckTool';
import { HydrantIcon } from './assistant/HydrantIcon';
import { analyzeParkingSign, SignAnalysisResult } from '../services/geminiService';
import { useParkingTimer } from './street-parking/useParkingTimer';
import { t, useLang } from '../i18n';
import { loadRecentScans, recordScan, RecentScan } from '../utils/recentScans';
import {
  captureFromCamera,
  pickFromGallery,
  subscribeRestoredSignCapture,
  usesNativeSignCapture,
  type SignCaptureOutcome,
} from '../utils/signScanner';

type ScanState = 'idle' | 'preview' | 'analyzing' | 'done';

/** Most scans are looked back at the same day, when a bare date says nothing. */
function formatScanTime(ts: number): string {
  const d = new Date(ts);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString();
}


/**
 * The result payload sometimes packs a headline and a body into `explanation`
 * separated by a newline (see geminiService error branches). Split it so the
 * card can lead with the headline instead of rendering one dense paragraph.
 */
function splitExplanation(text: string): { headline: string | null; body: string } {
  const idx = (text || '').indexOf('\n');
  if (idx === -1) return { headline: null, body: text || '' };
  return { headline: text.slice(0, idx).trim(), body: text.slice(idx + 1).trim() };
}

type ToolMode = 'hub' | 'scan' | 'hydrant' | 'check';

interface AssistantViewProps {
  /** Leaves the assistant entirely. The hub's back control calls this. */
  onBack?: () => void;
  /** Opens the map's My Car flow, for the empty states that need a saved spot. */
  onOpenMyCar?: () => void;
}

export const AssistantView = ({ onBack, onOpenMyCar }: AssistantViewProps = {}) => {
  useLang();
  const [mode, setMode] = useState<ToolMode>('hub');
  const [scanState, setScanState] = useState<ScanState>('idle');
  const [image, setImage] = useState<string | null>(null);
  const [imageData, setImageData] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<SignAnalysisResult | null>(null);
  const [recent, setRecent] = useState<RecentScan[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const galleryInputRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Guards against a second submit while a request is already in flight, which
  // a fast double-tap on the CTA would otherwise produce.
  const inFlightRef = useRef(false);
  const captureInFlightRef = useRef(false);
  const { startTimer, timer } = useParkingTimer();
  useFocusOnMount(headingRef);

  useEffect(() => { setRecent(loadRecentScans()); }, []);

  const applyCapture = useCallback((outcome: SignCaptureOutcome) => {
    if (outcome.status !== 'captured') return;
    setImage(outcome.image.previewUrl);
    setImageData(outcome.image.imageData);
    setAnalysis(null);
    setScanState('preview');
    setMode('scan');
  }, []);

  useEffect(() => subscribeRestoredSignCapture(applyCapture), [applyCapture]);

  const openNativeOrInput = async (
    nativeCapture: () => Promise<SignCaptureOutcome>,
    input: React.RefObject<HTMLInputElement>,
  ) => {
    if (!usesNativeSignCapture()) {
      input.current?.click();
      return;
    }
    if (captureInFlightRef.current) return;
    captureInFlightRef.current = true;
    try {
      applyCapture(await nativeCapture());
    } finally {
      captureInFlightRef.current = false;
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = reader.result as string;
      setImage(base64String);
      setImageData(base64String.split(',')[1]);
      setAnalysis(null);
      setScanState('preview');
    };
    reader.readAsDataURL(file);
    // Allow re-picking the same file twice in a row.
    event.target.value = '';
  };

  const analyze = useCallback(async (base64Data: string) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setScanState('analyzing');
    try {
      const result = await analyzeParkingSign(base64Data);
      setAnalysis(result);
      if (result.status !== 'ERROR') setRecent(recordScan(result));
    } catch {
      setAnalysis({ status: 'ERROR', explanation: t('assistant.error_generic') });
    } finally {
      inFlightRef.current = false;
      setScanState('done');
    }
  }, []);

  const openScanner = () => {
    setMode('scan');
    setScanState('idle');
    setImage(null);
    setImageData(null);
    setAnalysis(null);
  };

  const resetToIdle = () => {
    setImage(null);
    setImageData(null);
    setAnalysis(null);
    setScanState('idle');
  };

  const backToHub = () => {
    resetToIdle();
    setMode('hub');
    setRecent(loadRecentScans());
  };

  const reminderSet = !!timer;

  const setReminder = () => {
    if (!analysis) return;
    let minutes = 60;
    if (analysis.restrictionStartsAt) {
      const parsed = new Date(analysis.restrictionStartsAt);
      const diff = Math.ceil((parsed.getTime() - Date.now()) / 60_000);
      if (diff > 0) minutes = diff;
    }
    startTimer(minutes, 'parking sign');
  };

  const isError = analysis?.status === 'ERROR';

  return (
    <div className="pq-assist pb-24 px-4 h-full bg-[var(--color-bg)] overflow-y-auto no-scrollbar">
      {/* ── One header, whichever tool is open ──────────────────────────────
           The app-level bar used to render its own title and back button on top
           of this view's hero, so the screen opened with two headers, two
           subtitles and two back affordances stacked. AssistantView now owns the
           header outright and App.tsx renders none. */}
      <header
        className="flex items-center gap-3 mb-5 -mx-1"
        style={{ paddingTop: 'max(0.75rem, env(safe-area-inset-top, 0px))' }}
      >
        <button
          type="button"
          onClick={mode === 'hub' ? (onBack ?? (() => {})) : backToHub}
          aria-label={mode === 'hub' ? t('assistant.back_map_aria') : t('assistant.back_hub_aria')}
          className="w-11 h-11 rounded-full flex items-center justify-center bg-[var(--color-overlay)] border border-[var(--color-border)] text-[var(--color-text)] hover:bg-white/10 active:scale-95 focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none transition-all shrink-0"
        >
          <ChevronLeft size={20} />
        </button>
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="text-xl font-extrabold text-[var(--color-text)] tracking-tight truncate focus:outline-none"
        >
          {mode === 'hub' ? t('assistant.hub_title')
            : mode === 'scan' ? t('assistant.scan_title')
            : mode === 'hydrant' ? t('assistant.hydrant_title')
            : t('assistant.check_title')}
        </h1>
      </header>

      {/* ── Hub ────────────────────────────────────────────────────────────── */}
      {mode === 'hub' && (
        <div className="space-y-3.5">
          {/* Three tools, one visual family. Each is a real destination — there
              are no disabled cards and no "Soon" badges on this screen. */}
          {([
            {
              key: 'scan',
              title: t('assistant.scan_title'),
              desc: t('assistant.scan_desc_long'),
              tag: t('assistant.tag_ai_vision'),
              icon: <ScanLine size={22} aria-hidden="true" />,
              tone: 'pq-tool--scan',
              go: openScanner,
            },
            {
              key: 'hydrant',
              title: t('assistant.hydrant_title'),
              desc: t('assistant.hydrant_desc'),
              tag: t('assistant.tag_15ft'),
              icon: <HydrantIcon />,
              tone: 'pq-tool--hydrant',
              go: () => setMode('hydrant'),
            },
            {
              key: 'check',
              title: t('assistant.check_title'),
              desc: t('assistant.check_desc'),
              tag: t('assistant.tag_parking_check'),
              icon: <ShieldCheck size={22} aria-hidden="true" />,
              tone: 'pq-tool--check',
              go: () => setMode('check'),
            },
          ] as const).map(tool => (
            <button
              key={tool.key}
              type="button"
              onClick={tool.go}
              aria-label={tool.title}
              className={`pq-tool-card ${tool.tone} w-full text-left rounded-[22px] p-4 flex items-center gap-4 focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none`}
            >
              <span className="pq-tool-icon shrink-0" aria-hidden="true">{tool.icon}</span>
              <span className="block flex-1 min-w-0">
                <span className="block text-[9.5px] font-bold tracking-[0.16em] text-[var(--color-info)] mb-1">
                  {tool.tag}
                </span>
                <span className="block font-extrabold text-[15px] text-[var(--color-text)] leading-tight">
                  {tool.title}
                </span>
                <span className="block text-xs text-[var(--color-text-secondary)] mt-1 leading-snug">
                  {tool.desc}
                </span>
              </span>
              <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-[var(--color-text-secondary)]" />
            </button>
          ))}

          {/* Recent scans — real local history only */}
          <section className="rounded-3xl p-5 bg-[var(--color-card)] border border-[var(--color-border)]">
            <h2 className="text-[10px] font-bold tracking-[0.18em] text-[var(--color-text-secondary)] mb-3">
              {t('assistant.recent_title')}
            </h2>
            {recent.length === 0 ? (
              <p className="text-sm text-[var(--color-text-secondary)] py-2">{t('assistant.recent_empty')}</p>
            ) : (
              <ul className="space-y-2.5">
                {recent.map(scan => (
                  <li key={scan.id} className="flex items-start gap-3">
                    <span className="pq-recent-dot shrink-0" aria-hidden="true">
                      {scan.status === 'NO'
                        ? <AlertCircle size={15} className="text-[var(--color-danger)]" />
                        : scan.status === 'YES'
                          ? <CheckCircle2 size={15} className="text-[var(--color-success)]" />
                          : <Clock size={15} className="text-[var(--color-warning)]" />}
                    </span>
                    <span className="block min-w-0 flex-1">
                      <span className="block text-sm font-semibold text-[var(--color-text)] leading-snug">{scan.title}</span>
                      <span className="block text-xs text-[var(--color-text-secondary)] mt-0.5">
                        {formatScanTime(scan.ts)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      )}

      {mode === 'hydrant' && <HydrantDistanceTool onOpenMyCar={onOpenMyCar} />}

      {mode === 'check' && (
        <ParkingCheckTool
          onOpenMyCar={onOpenMyCar}
          onScanSign={openScanner}
          onViewOnMap={onBack}
        />
      )}

      {/* ── Scan flow ──────────────────────────────────────────────────────── */}
      {mode === 'scan' && (
        <div className="flex flex-col items-center">
          <input
            type="file" ref={fileInputRef} onChange={handleFileChange}
            accept="image/*" capture="environment" className="hidden"
          />
          <input
            type="file" ref={galleryInputRef} onChange={handleFileChange}
            accept="image/*" className="hidden"
          />

          {/* A. idle */}
          {scanState === 'idle' && (
            <div className="w-full max-w-sm flex flex-col items-center pt-2">
              <span className="pq-scan-orb pq-scan-orb-lg mb-5" aria-hidden="true">
                <Camera size={40} className="text-white" />
              </span>
              <p className="text-sm text-[var(--color-text-secondary)] text-center mb-6 leading-relaxed">
                {t('assistant.photo_hint')}
              </p>
              <button
                type="button"
                onClick={() => { void openNativeOrInput(captureFromCamera, fileInputRef); }}
                className="pq-cta w-full py-3.5 rounded-2xl font-bold text-white text-sm mb-3 focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none"
              >
                {t('assistant.open_camera')}
              </button>
              <button
                type="button"
                onClick={() => { void openNativeOrInput(pickFromGallery, galleryInputRef); }}
                className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 text-sm font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text)] rounded-2xl border border-[var(--color-border)] focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none transition-colors"
              >
                <ImageIcon size={16} aria-hidden="true" /> {t('assistant.choose_photos')}
              </button>
              <p className="text-[11px] text-[var(--color-text-secondary)] text-center mt-6 leading-relaxed px-4">
                {t('assistant.privacy_note')}
              </p>

              {/* Scanner tips live here, where they are about to be used, rather
                  than on the hub where they only lengthened a multi-tool screen. */}
              <ul className="mt-6 space-y-1.5 text-[11px] text-[var(--color-text-secondary)]">
                {[t('assistant.how_1_d'), t('assistant.how_2_d'), t('assistant.how_3_d')].map(tip => (
                  <li key={tip} className="flex items-start gap-2">
                    <span className="pq-tip-dot shrink-0" aria-hidden="true" />
                    <span className="leading-snug">{tip}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* B/C/D/E — image chosen */}
          {scanState !== 'idle' && image && (
            <div className="w-full max-w-sm">
              <div className="relative rounded-3xl overflow-hidden border border-[var(--color-border)] shadow-2xl mb-4">
                {/* Once the verdict exists it is the point of the screen, so the
                    photo drops to a thumbnail — at 390x844 a full-height image
                    pushed the answer entirely below the fold. */}
                <img
                  src={image}
                  alt={t('assistant.preview_alt')}
                  className={`w-full h-auto object-cover ${scanState === 'done' ? 'max-h-[120px]' : 'max-h-[340px]'}`}
                />
                {scanState === 'analyzing' && <span className="pq-scanline" aria-hidden="true" />}
              </div>

              {/* B. preview — explicit confirm before spending a call */}
              {scanState === 'preview' && (
                <div className="space-y-2.5">
                  <button
                    type="button"
                    onClick={() => imageData && analyze(imageData)}
                    className="pq-cta w-full py-3.5 rounded-2xl font-bold text-white text-sm inline-flex items-center justify-center gap-2 focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none"
                  >
                    <ScanLine size={17} aria-hidden="true" /> {t('assistant.analyze_cta')}
                  </button>
                  <button
                    type="button"
                    onClick={resetToIdle}
                    className="w-full min-h-[44px] rounded-2xl border border-[var(--color-border)] text-sm font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none transition-colors"
                  >
                    {t('assistant.retake')}
                  </button>
                  <button
                    type="button"
                    onClick={backToHub}
                    className="w-full min-h-[44px] inline-flex items-center justify-center gap-1.5 text-sm font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none rounded-2xl transition-colors"
                  >
                    <X size={15} aria-hidden="true" /> {t('assistant.cancel')}
                  </button>
                </div>
              )}

              {/* C/D/E — announced to screen readers */}
              <div aria-live="polite" role="status">
                {scanState === 'analyzing' && (
                  <div className="rounded-3xl p-6 bg-[var(--color-surface)] border border-[var(--color-border)] flex flex-col items-center">
                    <span className="pq-pulse-ring mb-4" aria-hidden="true">
                      <ScanLine size={22} className="text-[var(--color-info)]" />
                    </span>
                    <p className="text-sm font-semibold text-[var(--color-text)]">{t('assistant.reading_sign')}</p>
                    <p className="text-xs text-[var(--color-text-secondary)] mt-1">{t('assistant.checking_rules')}</p>
                  </div>
                )}

                {scanState === 'done' && analysis && (
                  <div className="rounded-3xl p-5 bg-[var(--color-surface)] border border-[var(--color-border)]">
                    {(() => {
                      const { headline, body } = splitExplanation(analysis.explanation);
                      const meta = isError
                        ? { icon: <AlertCircle className="text-yellow-500" size={22} />, label: t('assistant.error_title'), tone: 'text-[var(--color-warning)]' }
                        : analysis.status === 'YES'
                          ? { icon: <CheckCircle2 className="text-green-500" size={22} />, label: t('assistant.result_yes'), tone: 'text-[var(--color-success)]' }
                          : analysis.status === 'NO'
                            ? { icon: <AlertCircle className="text-red-500" size={22} />, label: t('assistant.result_no'), tone: 'text-[var(--color-danger)]' }
                            : { icon: <AlertCircle className="text-yellow-500" size={22} />, label: t('assistant.result_maybe'), tone: 'text-[var(--color-warning)]' };
                      return (
                        <>
                          <div className="flex items-start gap-3 mb-3">
                            <span className="shrink-0 mt-0.5">{meta.icon}</span>
                            <span className={`font-extrabold text-lg leading-snug ${meta.tone}`}>{meta.label}</span>
                          </div>
                          {/* The service's error headline is often the same
                              sentence as the card label; printing both reads as
                              a stutter. */}
                          {headline && headline !== meta.label && (
                            <p className="text-sm font-semibold text-[var(--color-text)] mb-1.5">{headline}</p>
                          )}
                          <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">{body}</p>
                        </>
                      );
                    })()}

                    {analysis.actionableAdvice && (
                      <div className="mt-4 rounded-2xl p-3.5 bg-[#1e75ff]/10 border border-[#1e75ff]/30">
                        <p className="flex items-center gap-2 text-[var(--color-info)] font-bold text-sm mb-1">
                          <Clock size={15} aria-hidden="true" /> {t('assistant.advice_label')}
                        </p>
                        <p className="text-sm text-[var(--color-text-secondary)]">{analysis.actionableAdvice}</p>
                        <button
                          type="button"
                          onClick={setReminder}
                          className="mt-3 w-full min-h-[44px] bg-[#1e75ff]/20 hover:bg-[#1e75ff]/35 text-[var(--color-info)] rounded-xl inline-flex items-center justify-center gap-2 text-sm font-semibold focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none transition-colors"
                        >
                          <Bell size={15} aria-hidden="true" /> {reminderSet ? t('assistant.reminder_set') : t('assistant.set_reminder')}
                        </button>
                      </div>
                    )}

                    {!isError && (
                      <p className="mt-4 text-[11px] text-[var(--color-text-secondary)] text-center leading-relaxed">
                        {t('assistant.disclaimer')}
                      </p>
                    )}

                    <div className="mt-4 space-y-2.5">
                      {isError ? (
                        <>
                          <button
                            type="button"
                            onClick={() => imageData && analyze(imageData)}
                            className="pq-cta w-full py-3 rounded-2xl font-bold text-white text-sm focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none"
                          >
                            {t('assistant.try_again')}
                          </button>
                          <button
                            type="button"
                            onClick={resetToIdle}
                            className="w-full min-h-[44px] rounded-2xl border border-[var(--color-border)] text-sm font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none transition-colors"
                          >
                            {t('assistant.choose_another')}
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={resetToIdle}
                          className="w-full min-h-[44px] rounded-2xl border border-[var(--color-border)] text-sm font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none transition-colors"
                        >
                          {t('assistant.scan_another')}
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
