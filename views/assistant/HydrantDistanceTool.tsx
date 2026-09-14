import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { getApp } from 'firebase/app';
import { AlertTriangle, Car, CheckCircle2, HelpCircle, LocateFixed, RefreshCw } from 'lucide-react';
import { t } from '../../i18n';
import { readSavedSpot, type SavedSpot } from '../../utils/savedSpot';
import {
  assessHydrantDistance, type HydrantAssessment, HYDRANT_THRESHOLD_FT,
} from '../../utils/hydrantDistance';
import { HydrantIcon } from './HydrantIcon';
import { getCurrentPosition } from '../../utils/geolocation';

type Phase = 'choose' | 'locating' | 'checking' | 'result' | 'error';
type Source = 'car' | 'current';
type ErrorKind = 'permission' | 'unavailable' | 'network' | 'out_of_area';

export interface HydrantLookup {
  status: 'found' | 'none_nearby' | 'unavailable' | 'out_of_area';
  meters: number | null;
}

/**
 * Calls the server, which owns the NYC DEP query and the Socrata token.
 * Exported so the parking check can reuse the exact same lookup — there is only
 * one hydrant implementation in the app.
 */
export async function lookupNearestHydrant(lat: number, lng: number): Promise<HydrantLookup> {
  try {
    const fn = httpsCallable<{ lat: number; lng: number }, HydrantLookup>(
      getFunctions(getApp(), 'us-central1'), 'checkHydrantDistance',
    );
    const res = await fn({ lat, lng });
    const data = res.data;
    if (!data || typeof data.status !== 'string') return { status: 'unavailable', meters: null };
    return data;
  } catch {
    // Never surface a raw Firebase error code to the user.
    return { status: 'unavailable', meters: null };
  }
}

/** Resolves the current position, or a reason it could not. */
function getPosition() {
  return getCurrentPosition({ enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
}

const STATUS_META = {
  within:            { tone: 'danger',  icon: AlertTriangle },
  too_close_to_call: { tone: 'warn',    icon: HelpCircle },
  beyond:            { tone: 'ok',      icon: CheckCircle2 },
  none_nearby:       { tone: 'neutral', icon: HydrantIcon },
  unavailable:       { tone: 'neutral', icon: AlertTriangle },
} as const;

export const HydrantDistanceTool = ({ onOpenMyCar }: { onOpenMyCar?: () => void }) => {
  const [spot, setSpot] = useState<SavedSpot | null>(null);
  const [phase, setPhase] = useState<Phase>('choose');
  const [source, setSource] = useState<Source>('car');
  const [assessment, setAssessment] = useState<HydrantAssessment | null>(null);
  const [errorKind, setErrorKind] = useState<ErrorKind>('unavailable');
  const inFlight = useRef(false);

  useEffect(() => { setSpot(readSavedSpot()); }, []);

  const run = useCallback(async (which: Source) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSource(which);
    setAssessment(null);

    let lat: number, lng: number, accuracyMeters: number | null;
    try {
      if (which === 'car') {
        const s = readSavedSpot();
        if (!s) { setErrorKind('unavailable'); setPhase('error'); return; }
        lat = s.lat; lng = s.lng; accuracyMeters = s.gpsAccuracyMeters;
      } else {
        // Permission is only requested here, after an explicit choice.
        setPhase('locating');
        const pos = await getPosition();
        lat = pos.coords.latitude;
        lng = pos.coords.longitude;
        accuracyMeters = Number.isFinite(pos.coords.accuracy) ? pos.coords.accuracy : null;
      }
    } catch (err: any) {
      setErrorKind(err?.code === 1 ? 'permission' : 'unavailable');
      setPhase('error');
      return;
    } finally {
      if (which === 'car') { /* no async gap to clean up */ }
    }

    setPhase('checking');
    const lookup = await lookupNearestHydrant(lat, lng);
    inFlight.current = false;

    if (lookup.status === 'out_of_area') { setErrorKind('out_of_area'); setPhase('error'); return; }
    setAssessment(assessHydrantDistance({
      distanceMeters: lookup.status === 'found' ? lookup.meters : null,
      accuracyMeters,
      failed: lookup.status === 'unavailable',
    }));
    setPhase('result');
  }, []);

  useEffect(() => { if (!inFlight.current && phase !== 'checking' && phase !== 'locating') inFlight.current = false; }, [phase]);

  // ── Choose a location ─────────────────────────────────────────────────────
  if (phase === 'choose') {
    return (
      <div className="space-y-3">
        <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">
          {t('hydrant.intro')}
        </p>
        {spot && (
          <button
            type="button"
            onClick={() => run('car')}
            className="pq-tool-card pq-tool--check w-full text-left rounded-[22px] p-4 flex items-center gap-4 focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none"
          >
            <span className="pq-tool-icon shrink-0" aria-hidden="true"><Car size={22} /></span>
            <span className="block flex-1 min-w-0">
              <span className="block font-extrabold text-[15px] text-[var(--color-text)]">{t('hydrant.check_my_car')}</span>
              {spot.address && (
                <span className="block text-xs text-[var(--color-text-secondary)] mt-0.5 truncate">{spot.address}</span>
              )}
            </span>
          </button>
        )}
        <button
          type="button"
          onClick={() => run('current')}
          className="pq-tool-card pq-tool--hydrant w-full text-left rounded-[22px] p-4 flex items-center gap-4 focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none"
        >
          <span className="pq-tool-icon shrink-0" aria-hidden="true"><LocateFixed size={22} /></span>
          <span className="block flex-1 min-w-0">
            <span className="block font-extrabold text-[15px] text-[var(--color-text)]">{t('hydrant.use_current')}</span>
            <span className="block text-xs text-[var(--color-text-secondary)] mt-0.5">{t('hydrant.use_current_note')}</span>
          </span>
        </button>
        {!spot && onOpenMyCar && (
          <button
            type="button"
            onClick={onOpenMyCar}
            className="w-full min-h-[44px] rounded-2xl border border-[var(--color-border)] text-sm font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none transition-colors"
          >
            {t('hydrant.save_my_car')}
          </button>
        )}
        <p className="text-[11px] text-[var(--color-text-secondary)] leading-relaxed pt-1">
          {t('hydrant.disclaimer')}
        </p>
      </div>
    );
  }

  // ── Working ───────────────────────────────────────────────────────────────
  if (phase === 'locating' || phase === 'checking') {
    return (
      <div className="rounded-[22px] p-8 bg-[var(--color-card)] border border-[var(--color-border)] flex flex-col items-center"
           role="status" aria-live="polite">
        <span className="pq-pulse-ring mb-4" aria-hidden="true">
          <HydrantIcon size={22} />
        </span>
        <p className="font-bold text-[var(--color-text)]">
          {phase === 'locating' ? t('hydrant.locating') : t('hydrant.checking')}
        </p>
        <p className="text-xs text-[var(--color-text-secondary)] mt-1">{t('hydrant.checking_note')}</p>
      </div>
    );
  }

  // ── Error / permission states ─────────────────────────────────────────────
  if (phase === 'error') {
    const copy = {
      permission:   { title: t('hydrant.err_permission_t'), body: t('hydrant.err_permission_b') },
      out_of_area:  { title: t('hydrant.err_area_t'),       body: t('hydrant.err_area_b') },
      network:      { title: t('hydrant.err_network_t'),    body: t('hydrant.err_network_b') },
      unavailable:  { title: t('hydrant.err_generic_t'),    body: t('hydrant.err_generic_b') },
    }[errorKind];
    return (
      <div className="rounded-[22px] p-5 bg-[var(--color-card)] border border-[var(--color-border)]" role="status" aria-live="polite">
        <div className="flex items-start gap-3 mb-2">
          <AlertTriangle size={20} className="text-yellow-500 shrink-0 mt-0.5" aria-hidden="true" />
          <p className="font-extrabold text-[var(--color-warning)]">{copy.title}</p>
        </div>
        <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed mb-4">{copy.body}</p>
        <button
          type="button"
          onClick={() => { setPhase('choose'); inFlight.current = false; }}
          className="w-full min-h-[44px] rounded-2xl border border-[var(--color-border)] text-sm font-semibold text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none"
        >
          {t('hydrant.back_to_options')}
        </button>
      </div>
    );
  }

  // ── Result ────────────────────────────────────────────────────────────────
  const a = assessment!;
  return (
    <div className="space-y-3">
      <HydrantResultCard assessment={a} />
      <div className="space-y-2">
        <button
          type="button"
          onClick={() => run(source)}
          className="pq-cta w-full py-3 rounded-2xl font-bold text-white text-sm inline-flex items-center justify-center gap-2 focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none"
        >
          <RefreshCw size={16} aria-hidden="true" /> {t('hydrant.check_again')}
        </button>
        <button
          type="button"
          onClick={() => run(source === 'car' ? 'current' : 'car')}
          disabled={source === 'current' && !spot}
          className="w-full min-h-[44px] rounded-2xl border border-[var(--color-border)] text-sm font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text)] disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none transition-colors"
        >
          {source === 'car' ? t('hydrant.use_current') : t('hydrant.check_my_car')}
        </button>
      </div>
      <p className="text-[11px] text-[var(--color-text-secondary)] leading-relaxed text-center px-2">
        {t('hydrant.disclaimer')}
      </p>
    </div>
  );
};

/** The result card, split out so the parking check can render the same visual. */
export const HydrantResultCard = ({ assessment: a }: { assessment: HydrantAssessment }) => {
  const meta = STATUS_META[a.status];
  const Icon = meta.icon as any;
  const headline = {
    within: t('hydrant.res_within'),
    too_close_to_call: t('hydrant.res_close'),
    beyond: t('hydrant.res_beyond'),
    none_nearby: t('hydrant.res_none'),
    unavailable: t('hydrant.res_unavailable'),
  }[a.status];
  const body = {
    within: t('hydrant.res_within_b'),
    too_close_to_call: t('hydrant.res_close_b'),
    beyond: t('hydrant.res_beyond_b'),
    none_nearby: t('hydrant.res_none_b'),
    unavailable: t('hydrant.res_unavailable_b'),
  }[a.status];

  return (
    <div className={`pq-result pq-result--${meta.tone} rounded-[22px] p-5`} role="status" aria-live="polite">
      {a.distanceFt !== null && (
        <>
          <p className="text-[10px] font-bold tracking-[0.16em] text-[var(--color-text-secondary)]">
            {t('hydrant.nearest')}
          </p>
          <p className="mt-1 flex items-baseline gap-2">
            <span className="text-4xl font-extrabold text-[var(--color-text)] tabular-nums">{a.distanceFt}</span>
            <span className="text-lg font-bold text-[var(--color-text-secondary)]">{t('hydrant.ft')}</span>
          </p>
          <p className="text-xs text-[var(--color-text-secondary)] mt-0.5">{t('hydrant.estimated_distance')}</p>
          <DistanceBar assessment={a} />
        </>
      )}

      {/* Icon + words, never colour alone. */}
      <div className="flex items-start gap-2.5 mt-4">
        <Icon size={18} className="shrink-0 mt-0.5 pq-result-icon" aria-hidden="true" />
        <div className="min-w-0">
          <p className="font-extrabold text-[15px] pq-result-title leading-snug">{headline}</p>
          <p className="text-sm text-[var(--color-text-secondary)] mt-1 leading-relaxed">{body}</p>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-3 mt-4 pt-4 border-t border-[var(--color-border)]">
        <div>
          <dt className="text-[10px] font-bold tracking-[0.14em] text-[var(--color-text-secondary)]">{t('hydrant.nyc_minimum')}</dt>
          <dd className="text-sm font-bold text-[var(--color-text)] mt-0.5">{HYDRANT_THRESHOLD_FT} {t('hydrant.ft')}</dd>
        </div>
        <div>
          <dt className="text-[10px] font-bold tracking-[0.14em] text-[var(--color-text-secondary)]">{t('hydrant.location_accuracy')}</dt>
          <dd className="text-sm font-bold text-[var(--color-text)] mt-0.5">
            ± {a.accuracyFt} {t('hydrant.ft')}
            {a.accuracyAssumed && <span className="font-normal text-[var(--color-text-secondary)]"> {t('hydrant.assumed')}</span>}
          </dd>
        </div>
      </dl>
    </div>
  );
};

/**
 * Car → threshold → hydrant, drawn to scale but capped.
 *
 * The uncertainty band is drawn as a real span rather than a point, so the
 * picture cannot imply a precision the reading does not have.
 */
const DistanceBar = ({ assessment: a }: { assessment: HydrantAssessment }) => {
  if (a.distanceFt === null) return null;
  const span = Math.max(a.distanceFt + a.accuracyFt, HYDRANT_THRESHOLD_FT * 2);
  const pct = (ft: number) => Math.max(0, Math.min(100, (ft / span) * 100));
  const lo = pct(Math.max(0, a.distanceFt - a.accuracyFt));
  const hi = pct(a.distanceFt + a.accuracyFt);

  return (
    <div className="mt-4" aria-hidden="true">
      <div className="pq-distance-track">
        <span className="pq-distance-threshold" style={{ left: `${pct(HYDRANT_THRESHOLD_FT)}%` }} />
        <span className="pq-distance-band" style={{ left: `${lo}%`, width: `${Math.max(2, hi - lo)}%` }} />
        <span className="pq-distance-hydrant" style={{ left: `${pct(a.distanceFt)}%` }} />
      </div>
      <div className="flex justify-between mt-1.5 text-[10px] font-semibold text-[var(--color-text-secondary)]">
        <span>{t('hydrant.your_car')}</span>
        <span>{HYDRANT_THRESHOLD_FT} {t('hydrant.ft')}</span>
        <span>{t('hydrant.hydrant')}</span>
      </div>
    </div>
  );
};
