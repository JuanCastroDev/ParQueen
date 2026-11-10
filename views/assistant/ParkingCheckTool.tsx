import React, { useCallback, useEffect, useRef, useState } from 'react';
import { db } from '../../firebase';
import { collection, doc, getDoc, getDocs, orderBy, query, where } from 'firebase/firestore';
import { AlertTriangle, Car, CheckCircle2, HelpCircle, MapPin, RefreshCw, ScanLine } from 'lucide-react';
import { t } from '../../i18n';
import { readSavedSpot, effectiveParkingSide, type SavedSpot } from '../../utils/savedSpot';
import {
  computeSafeUntil, toNYCDateKey, addNYCDateKeyDays, MAX_FORWARD_SEARCH_DAYS_AHEAD,
  type CleaningSchedule, type StreetRuleDoc, type SuspensionDoc, type SafeUntilResult,
} from '../../utils/streetIntelligence';
import {
  classifyStreetIntelligence, type StreetIntelligencePresentationState,
} from '../../utils/streetIntelligencePresentation';
import { evaluateParkingCheck, type ParkingCheckResult } from '../../utils/parkingCheck';
import { filterAuthoritativeRules } from '../../utils/canonicalCurbWriteAuthority';
import { assessHydrantDistance, type HydrantAssessment } from '../../utils/hydrantDistance';
import { lookupNearestHydrant } from './HydrantDistanceTool';
import { HydrantIcon } from './HydrantIcon';

interface StreetOutcome {
  presentation: StreetIntelligencePresentationState;
  safeUntil: SafeUntilResult | null;
  effectiveSide: string | null;
  failed: boolean;
}

/**
 * Loads and evaluates the saved block face.
 *
 * This is the same retrieval and the same computeSafeUntil / classify pipeline
 * StreetIntelligenceCard uses — the horizon-bounded suspensions query included.
 * No second parser and no second interpretation of the rules.
 */
async function loadStreetOutcome(spot: SavedSpot): Promise<StreetOutcome> {
  const effectiveSide = effectiveParkingSide(spot);
  if (!spot.segmentId) {
    return { presentation: 'unknown', safeUntil: null, effectiveSide, failed: false };
  }
  try {
    const todayKey = toNYCDateKey(new Date());
    const horizonKey = addNYCDateKeyDays(todayKey, MAX_FORWARD_SEARCH_DAYS_AHEAD);
    const [v2Snap, legacySnap, v2RulesSnap, legacyRulesSnap, suspSnap] = await Promise.all([
      getDoc(doc(db, 'streetSegmentsV2', spot.segmentId)),
      getDoc(doc(db, 'streetSegments', spot.segmentId)),
      getDocs(query(
        collection(db, 'streetSegmentsV2', spot.segmentId, 'streetRulesV2'),
        where('supersededAt', '==', null),
      )),
      getDocs(query(
        collection(db, 'streetSegments', spot.segmentId, 'streetRules'),
        where('supersededAt', '==', null),
      )),
      getDocs(query(
        collection(db, 'suspensions'),
        where('date', '>=', todayKey),
        where('date', '<=', horizonKey),
        orderBy('date', 'desc'),
      )),
    ]);
    const useVersioned = typeof v2Snap.exists === 'function' ? v2Snap.exists() : Boolean(v2Snap.exists);
    const segSnap = useVersioned ? v2Snap : legacySnap;
    const rulesSnap = useVersioned ? v2RulesSnap : legacyRulesSnap;

    const loadedRules = rulesSnap.docs.map(d => ({ id: d.id, ...d.data() } as StreetRuleDoc));
    const segment = segSnap.exists() ? segSnap.data() : null;
    const selected = filterAuthoritativeRules(segment, loadedRules);
    const rules = selected.ok ? selected.rules : [];
    const presentation = classifyStreetIntelligence(selected.ok ? segment : null, rules).state;
    if (presentation === 'unknown' || !effectiveSide) {
      return { presentation, safeUntil: null, effectiveSide, failed: false };
    }
    const suspensions = suspSnap.docs
      .map(d => ({ id: d.id, ...d.data() } as SuspensionDoc))
      .filter(s => s.status !== 'archived');
    const schedules: CleaningSchedule[] = rules.flatMap(r => r.schedules || []);
    return { presentation, safeUntil: computeSafeUntil(schedules, effectiveSide, suspensions), effectiveSide, failed: false };
  } catch {
    // Never surface a raw Firestore error; an unreadable check is uncertainty.
    return { presentation: 'unknown', safeUntil: null, effectiveSide, failed: true };
  }
}

export const ParkingCheckTool = ({
  onOpenMyCar, onScanSign, onViewOnMap,
}: {
  onOpenMyCar?: () => void;
  onScanSign?: () => void;
  onViewOnMap?: () => void;
}) => {
  const [spot, setSpot] = useState<SavedSpot | null | undefined>(undefined);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<ParkingCheckResult | null>(null);
  const [street, setStreet] = useState<StreetOutcome | null>(null);
  const inFlight = useRef(false);

  const run = useCallback(async (s: SavedSpot) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRunning(true);
    setResult(null);
    try {
      // The two checks are independent, so one failing must not cancel the other.
      const [streetOutcome, hydrantLookup] = await Promise.all([
        loadStreetOutcome(s),
        lookupNearestHydrant(s.lat, s.lng),
      ]);
      const hydrant: HydrantAssessment = assessHydrantDistance({
        distanceMeters: hydrantLookup.status === 'found' ? hydrantLookup.meters : null,
        accuracyMeters: s.gpsAccuracyMeters,
        failed: hydrantLookup.status === 'unavailable' || hydrantLookup.status === 'out_of_area',
      });
      setStreet(streetOutcome);
      setResult(evaluateParkingCheck({ street: streetOutcome, hydrant }));
    } finally {
      inFlight.current = false;
      setRunning(false);
    }
  }, []);

  useEffect(() => {
    const s = readSavedSpot();
    setSpot(s);
    if (s) run(s);
  }, [run]);

  if (spot === undefined) return null;

  // ── No saved spot ─────────────────────────────────────────────────────────
  if (spot === null) {
    return (
      <div className="rounded-[22px] p-6 bg-[var(--color-card)] border border-[var(--color-border)] text-center">
        <span className="pq-tool-icon mx-auto mb-4" aria-hidden="true"><Car size={22} /></span>
        <h2 className="font-extrabold text-lg text-[var(--color-text)]">{t('check.empty_title')}</h2>
        <p className="text-sm text-[var(--color-text-secondary)] mt-2 leading-relaxed">{t('check.empty_body')}</p>
        {onOpenMyCar && (
          <button
            type="button"
            onClick={onOpenMyCar}
            className="pq-cta w-full mt-5 py-3 rounded-2xl font-bold text-white text-sm focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none"
          >
            {t('check.empty_cta')}
          </button>
        )}
      </div>
    );
  }

  if (running || !result) {
    return (
      <div className="rounded-[22px] p-8 bg-[var(--color-card)] border border-[var(--color-border)] flex flex-col items-center"
           role="status" aria-live="polite">
        <span className="pq-pulse-ring mb-4" aria-hidden="true"><ScanLine size={22} /></span>
        <p className="font-bold text-[var(--color-text)]">{t('check.running')}</p>
        <p className="text-xs text-[var(--color-text-secondary)] mt-1">{t('check.running_note')}</p>
      </div>
    );
  }

  const tone = result.overall === 'move' ? 'danger' : result.overall === 'check' ? 'warn' : 'ok';
  const OverallIcon = result.overall === 'move' ? AlertTriangle
    : result.overall === 'check' ? HelpCircle : CheckCircle2;
  const overallTitle = {
    move: t('check.overall_move'),
    check: t('check.overall_check'),
    no_known_issue: t('check.overall_clear'),
  }[result.overall];
  const overallBody = {
    move: t('check.overall_move_b'),
    check: t('check.overall_check_b'),
    no_known_issue: t('check.overall_clear_b'),
  }[result.overall];

  return (
    <div className="space-y-3">
      {/* Overall assessment */}
      <div className={`pq-result pq-result--${tone} rounded-[22px] p-5`} role="status" aria-live="polite">
        <div className="flex items-start gap-3">
          <OverallIcon size={22} className="shrink-0 mt-0.5 pq-result-icon" aria-hidden="true" />
          <div className="min-w-0">
            <h2 className="font-extrabold text-lg pq-result-title leading-tight">{overallTitle}</h2>
            <p className="text-sm text-[var(--color-text-secondary)] mt-1.5 leading-relaxed">{overallBody}</p>
          </div>
        </div>
        {spot.address && (
          <p className="flex items-center gap-1.5 text-xs text-[var(--color-text-secondary)] mt-4 pt-3 border-t border-[var(--color-border)]">
            <MapPin size={13} aria-hidden="true" className="shrink-0" />
            <span className="truncate">{spot.address}</span>
          </p>
        )}
      </div>

      {/* Individual checks */}
      <CheckRow
        label={t('check.row_street')}
        icon={<ScanLine size={16} aria-hidden="true" />}
        status={result.street === 'active_restriction' ? 'bad' : result.street === 'clear' ? 'good' : 'unknown'}
        headline={{
          active_restriction: t('check.street_active'),
          clear: t('check.street_clear'),
          side_unknown: t('check.street_side_unknown'),
          unavailable: t('check.street_unavailable'),
        }[result.street]}
        detail={
          result.street === 'clear' && street?.safeUntil?.nextDay
            ? t('check.street_next')
                .replace('{day}', street.safeUntil.nextDay)
                .replace('{time}', street.safeUntil.nextTime ?? '')
            : result.street === 'active_restriction' && street?.safeUntil?.scheduleDescription
              ? street.safeUntil.scheduleDescription
              : null
        }
      />

      <CheckRow
        label={t('check.row_hydrant')}
        icon={<HydrantIcon size={16} />}
        status={
          result.hydrant?.status === 'within' ? 'bad'
          : result.hydrant?.status === 'beyond' || result.hydrant?.status === 'none_nearby' ? 'good'
          : 'unknown'
        }
        headline={
          result.hydrant === null ? t('check.hydrant_unavailable')
          : {
              within: t('check.hydrant_within'),
              too_close_to_call: t('check.hydrant_close'),
              beyond: t('check.hydrant_beyond').replace('{ft}', String(result.hydrant.distanceFt ?? '')),
              none_nearby: t('check.hydrant_none'),
              unavailable: t('check.hydrant_unavailable'),
            }[result.hydrant.status]
        }
        detail={result.hydrant && result.hydrant.distanceFt !== null
          ? `${t('hydrant.nyc_minimum')}: ${result.hydrant.thresholdFt} ${t('hydrant.ft')} · ± ${result.hydrant.accuracyFt} ${t('hydrant.ft')}`
          : null}
      />

      <CheckRow
        label={t('check.row_confidence')}
        icon={<HelpCircle size={16} aria-hidden="true" />}
        status={result.confidence === 'high' ? 'good' : 'unknown'}
        headline={result.confidence === 'high' ? t('check.conf_high') : t('check.conf_review')}
        detail={confidenceReason(result)}
      />

      {/* Actions that all lead somewhere real */}
      <div className="space-y-2 pt-1">
        <button
          type="button"
          onClick={() => run(spot)}
          className="pq-cta w-full py-3 rounded-2xl font-bold text-white text-sm inline-flex items-center justify-center gap-2 focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none"
        >
          <RefreshCw size={16} aria-hidden="true" /> {t('check.recheck')}
        </button>
        {onScanSign && (
          <button
            type="button"
            onClick={onScanSign}
            className="w-full min-h-[44px] rounded-2xl border border-[var(--color-border)] text-sm font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none transition-colors"
          >
            {t('check.scan_nearby')}
          </button>
        )}
        {onViewOnMap && (
          <button
            type="button"
            onClick={onViewOnMap}
            className="w-full min-h-[44px] rounded-2xl border border-[var(--color-border)] text-sm font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text)] focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none transition-colors"
          >
            {t('check.view_on_map')}
          </button>
        )}
      </div>

      <p className="text-[11px] text-[var(--color-text-secondary)] leading-relaxed text-center px-2 pt-1">
        {t('check.disclaimer')}
      </p>
    </div>
  );
};

function confidenceReason(r: ParkingCheckResult): string | null {
  if (r.reasons.includes('street_unavailable')) return t('check.conf_reason_street');
  if (r.reasons.includes('side_unknown')) return t('check.conf_reason_side');
  if (r.reasons.includes('street_needs_review')) return t('check.conf_reason_review');
  if (r.reasons.includes('hydrant_too_close_to_call')) return t('check.conf_reason_hydrant_close');
  if (r.reasons.includes('hydrant_unavailable') || r.reasons.includes('hydrant_not_checked')) return t('check.conf_reason_hydrant');
  return r.confidence === 'high' ? t('check.conf_reason_high') : null;
}

const CheckRow = ({
  label, icon, status, headline, detail,
}: {
  label: string;
  icon: React.ReactNode;
  status: 'good' | 'bad' | 'unknown';
  headline: string;
  detail: string | null;
}) => {
  // Shape and words carry the meaning; colour only reinforces it.
  const Mark = status === 'good' ? CheckCircle2 : status === 'bad' ? AlertTriangle : HelpCircle;
  const markClass = status === 'good' ? 'text-[var(--color-success)]'
    : status === 'bad' ? 'text-[var(--color-danger)]' : 'text-[var(--color-warning)]';
  return (
    <section className="rounded-[22px] p-4 bg-[var(--color-card)] border border-[var(--color-border)]">
      <h3 className="flex items-center gap-2 text-[10px] font-bold tracking-[0.16em] text-[var(--color-text-secondary)] mb-2">
        <span className="text-[var(--color-info)]" aria-hidden="true">{icon}</span>{label}
      </h3>
      <p className="flex items-start gap-2">
        <Mark size={16} className={`${markClass} shrink-0 mt-0.5`} aria-hidden="true" />
        <span className="font-semibold text-sm text-[var(--color-text)] leading-snug">{headline}</span>
      </p>
      {detail && <p className="text-xs text-[var(--color-text-secondary)] mt-1.5 ml-6 leading-relaxed">{detail}</p>}
    </section>
  );
};
