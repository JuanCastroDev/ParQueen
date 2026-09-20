import React, { useState, useEffect } from 'react';
import { db } from '../../firebase';
import { collection, getDocs, getDoc, doc, query, where, orderBy } from 'firebase/firestore';
import { Leaf, AlertTriangle, CheckCircle } from 'lucide-react';
import {
  computeSafeUntil, toNYCDateKey, addNYCDateKeyDays, MAX_FORWARD_SEARCH_DAYS_AHEAD,
  StreetRuleDoc, SuspensionDoc, SafeUntilResult, CleaningSchedule,
} from '../../utils/streetIntelligence';
import {
  classifyStreetIntelligence,
  StreetIntelligenceCautionReason,
  StreetIntelligencePresentation,
  StreetIntelligenceSource,
} from '../../utils/streetIntelligencePresentation';
import { t, useLang } from '../../i18n';

interface Props {
  segmentId: string;
  parkingSide: string | null;
  streetName: string;
  sideConfidence: 'high' | 'low' | 'unknown';
  confirmedParkingSide: string | null;
  onConfirmSide: (side: string) => void;
  onResult?: (result: SafeUntilResult | null) => void;
}

const fmtSafeUntil = (d: Date) => {
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day} at ${time}`;
};

const fmtSourceDate = (value: string, locale: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
};

const sourceLabel = (source: StreetIntelligenceSource) => {
  if (source === 'admin') return t('street_intel.source_admin');
  if (source === 'sweepnyc') return t('street_intel.source_sweepnyc');
  return t('street_intel.source_nyc_open_data');
};

export const StreetIntelligenceUnavailableCard = () => (
  <div className="pq-mycar-intel-unavailable">
    <div className="pq-mycar-intel-street">
      <AlertTriangle size={14} className="text-[var(--color-text-secondary)] shrink-0" />
      <p className="text-sm font-semibold text-[var(--color-text)]" style={{ textTransform: 'none', letterSpacing: '-0.01em', fontSize: 14 }}>
        {t('street_intel.data_unavailable')}
      </p>
    </div>
    <p className="pq-mycar-intel-reason" style={{ marginBottom: 0 }}>
      {t('street_intel.decision_caution')}
    </p>
  </div>
);

/**
 * Every caution state names the doubt, so the UI never has to fall back on a
 * generic "review recommended" over a result the data actually supports.
 */
const CAUTION_REASON_KEY: Record<StreetIntelligenceCautionReason, string> = {
  side_unresolved: 'street_intel.caution_side_unresolved',
  block_not_decisive: 'street_intel.caution_block_not_decisive',
  conflicting_schedules: 'street_intel.caution_conflicting_schedules',
  incomplete_parse: 'street_intel.caution_incomplete_parse',
  flagged_for_review: 'street_intel.caution_flagged_for_review',
  low_confidence: 'street_intel.caution_low_confidence',
};

const cautionCopy = (reasons: StreetIntelligenceCautionReason[]): string | null =>
  reasons.length > 0 ? t(CAUTION_REASON_KEY[reasons[0]]) : null;

const SIDE_KEY_MAP: Record<string, string> = {
  North: 'street_intel.side_north',
  South: 'street_intel.side_south',
  East: 'street_intel.side_east',
  West: 'street_intel.side_west',
  even: 'street_intel.side_even',
  odd: 'street_intel.side_odd',
};

export const StreetIntelligenceCard = ({
  segmentId, parkingSide, streetName,
  sideConfidence, confirmedParkingSide, onConfirmSide,
  onResult,
}: Props) => {
  const lang = useLang();
  const locale = lang === 'es' ? 'es-US' : 'en-US';
  const sideLabel = (side: string) => SIDE_KEY_MAP[side] ? t(SIDE_KEY_MAP[side]) : side;

  // Effective side: user-confirmed takes priority, then GPS only if confidence is high
  const effectiveSide = confirmedParkingSide || (sideConfidence === 'high' ? parkingSide : null);

  const [result, setResult] = useState<SafeUntilResult | null>(null);
  const [scheduleCount, setScheduleCount] = useState(0);
  const [availableSides, setAvailableSides] = useState<string[]>([]);
  const [presentation, setPresentation] = useState<StreetIntelligencePresentation>({
    state: 'unknown', source: null, lastSourceSync: null, reasons: [],
  });
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [debugLines, setDebugLines] = useState<string[]>([]);

  const isDebugMode = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('debugStreet');
  const cdbg = (msg: string) => {
    if (!isDebugMode) return;
    console.log('[StreetIntelCardDebug]', msg);
    setDebugLines(prev => [...prev, `${new Date().toLocaleTimeString()} ${msg}`]);
  };

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(false);
    setResult(null);
    setAvailableSides([]);
    setPresentation({ state: 'unknown', source: null, lastSourceSync: null, reasons: [] });

    const load = async () => {
      cdbg(`load — sideConfidence:${sideConfidence} hasEffectiveSide:${Boolean(effectiveSide)}`);
      try {
        // Suspension matching (computeSafeUntil) only ever inspects today
        // through today + MAX_FORWARD_SEARCH_DAYS_AHEAD (NYC civil dates) —
        // bounding the fetch to that exact horizon avoids reading the
        // suspensions collection's entire history on every card load.
        const todayKey = toNYCDateKey(new Date());
        const horizonKey = addNYCDateKeyDays(todayKey, MAX_FORWARD_SEARCH_DAYS_AHEAD);

        const [segSnap, rulesSnap, suspSnap] = await Promise.all([
          getDoc(doc(db, 'streetSegments', segmentId)),
          getDocs(query(
            collection(db, 'streetSegments', segmentId, 'streetRules'),
            where('supersededAt', '==', null),
          )),
          getDocs(query(
            collection(db, 'suspensions'),
            where('date', '>=', todayKey),
            where('date', '<=', horizonKey),
            orderBy('date', 'desc'),
          )),
        ]);
        if (cancelled) return;

        const rules = rulesSnap.docs.map(d => ({ id: d.id, ...d.data() } as StreetRuleDoc));
        cdbg(`streetRules count: ${rules.length}`);
        const segment = segSnap.exists() ? segSnap.data() : null;
        const nextPresentation = classifyStreetIntelligence(segment, rules);
        cdbg(`presentation state: ${nextPresentation.state} | source: ${nextPresentation.source ?? 'none'}`);
        setPresentation(nextPresentation);

        const suspensions = suspSnap.docs
          .map(d => ({ id: d.id, ...d.data() } as SuspensionDoc))
          .filter(s => s.status !== 'archived');
        const allSchedules: CleaningSchedule[] = rules.flatMap(r => r.schedules || []);

        cdbg(`total schedules: ${allSchedules.length}`);
        setScheduleCount(allSchedules.length);

        if (nextPresentation.state === 'unknown') {
          cdbg('UI branch: unknown/unavailable');
          onResult?.(null);
          return;
        }

        if (!effectiveSide) {
          const sides = [...new Set(allSchedules.map(s => s.side))].filter(Boolean);
          cdbg(`UI branch: side-picker schedules=${allSchedules.length}`);
          setAvailableSides(sides);
          onResult?.(null);
          return;
        }

        cdbg(`computeSafeUntil input: scheduleCount=${allSchedules.length} suspensionCount=${suspensions.length}`);
        const r = computeSafeUntil(allSchedules, effectiveSide, suspensions);
        cdbg(`computeSafeUntil result: activeNow=${r.activeNow} hasUpcoming=${Boolean(r.nextDay)} hasDescription=${Boolean(r.scheduleDescription)}`);

        const branch = r.scheduleDescription === null
          ? (allSchedules.length > 0 ? 'side-mismatch' : 'no-schedule')
          : r.activeNow ? 'active-now'
          : r.nextDay ? 'safe-until'
          : 'no-upcoming';
        cdbg(`UI branch: ${branch}`);

        setResult(r);
        onResult?.(r);
      } catch {
        cdbg('load failed');
        console.warn('StreetIntelligenceCard load failed');
        setLoadError(true);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    load();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [segmentId, effectiveSide]);

  const debugBlock = isDebugMode && debugLines.length > 0 ? (
    <div style={{ marginTop: 8, padding: '6px 8px', background: 'rgba(0,0,0,0.85)', borderRadius: 8, border: '1px solid #1e75ff55' }}>
      <p style={{ color: 'var(--color-brand)', fontWeight: 700, fontSize: 10, margin: '0 0 4px', fontFamily: 'monospace' }}>StreetIntelCardDebug</p>
      {debugLines.map((l, i) => {
        const isWarn = l.includes('null') || l.includes('no-schedule') || l.includes('side-mismatch') || l.includes('error');
        return <p key={i} style={{ margin: '1px 0', fontSize: 10, color: isWarn ? '#f87171' : '#a3e635', fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{l}</p>;
      })}
    </div>
  ) : null;

  const freshnessDate = presentation.lastSourceSync
    ? fmtSourceDate(presentation.lastSourceSync, locale)
    : null;
  const metadataBlock = presentation.source ? (
    <div className="pq-mycar-intel-meta">
      <p>{t('street_intel.source_label', { source: sourceLabel(presentation.source) })}</p>
      {freshnessDate && <p>{t('street_intel.data_updated', { date: freshnessDate })}</p>}
    </div>
  ) : null;

  if (loading) {
    return (
      <div className="pq-mycar-intel animate-pulse">
        <div className="h-3 w-24 bg-white/10 rounded mb-3" />
        <div className="h-7 w-48 bg-white/10 rounded mb-2" />
        <div className="h-3 w-36 bg-white/10 rounded" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="pq-mycar-intel-unavailable">
        <p className="text-sm text-[var(--color-text-secondary)] mb-2">{t('street_intel.load_error')}</p>
        <p className="pq-mycar-intel-reason" style={{ marginBottom: 0 }}>{t('street_intel.decision_caution')}</p>
      </div>
    );
  }

  if (presentation.state === 'unknown') return <StreetIntelligenceUnavailableCard />;

  if (!effectiveSide) {
    if (availableSides.length === 0) return null;
    return (
      <div className="pq-mycar-intel pq-mycar-intel--caution">
        <div className="pq-mycar-intel-street">
          <AlertTriangle size={14} className="text-[var(--color-warning)] shrink-0" />
          <p style={{ color: 'var(--color-warning)' }}>
            {presentation.state === 'caution'
              ? t('street_intel.needs_review')
              : t('street_intel.info_available')}
          </p>
        </div>
        <p className="text-sm text-white font-semibold mb-1">
          {t('street_intel.which_side')}
        </p>
        <p className="pq-mycar-intel-reason">
          {presentation.state === 'caution'
            ? t('street_intel.schedules_found_estimate', { street: streetName })
            : t('street_intel.schedules_found_street', { street: streetName })}
        </p>
        <div className="pq-mycar-intel-side-btns">
          {availableSides.map(side => (
            <button
              key={side}
              onClick={() => onConfirmSide(side)}
              className="pq-mycar-intel-side-btn"
            >
              {sideLabel(side)}
            </button>
          ))}
        </div>
        {metadataBlock}
        {debugBlock}
      </div>
    );
  }

  if (!result) return null;

  const effectiveSideLabel = sideLabel(effectiveSide);
  const sideHeader = `${streetName} · ${effectiveSideLabel}${confirmedParkingSide ? ' ✓' : ''}`;

  if (!result.scheduleDescription) {
    return (
      <div className="pq-mycar-intel">
        <div className="pq-mycar-intel-street">
          <Leaf size={14} className="text-[var(--color-text-secondary)]" />
          <p>{sideHeader}</p>
        </div>
        <p className="pq-mycar-intel-reason" style={{ marginBottom: presentation.state === 'caution' ? 12 : 0 }}>
          {confirmedParkingSide
            ? t('street_intel.no_schedule_for_side', { side: effectiveSideLabel.toLowerCase() })
            : t('street_intel.no_schedule_unknown')}
        </p>
        {metadataBlock}
        {presentation.state === 'caution' && (
          <p className="pq-mycar-intel-reason" style={{ marginBottom: 0, marginTop: 8 }}>
            {cautionCopy(presentation.reasons) ?? t('street_intel.decision_caution')}
          </p>
        )}
        {debugBlock}
      </div>
    );
  }

  const toneClass = result.activeNow
    ? 'pq-mycar-intel--danger'
    : presentation.state === 'caution'
    ? 'pq-mycar-intel--caution'
    : 'pq-mycar-intel--safe';
  const iconTone = result.activeNow
    ? 'is-danger'
    : presentation.state === 'caution'
    ? 'is-caution'
    : 'is-safe';
  const datetimeTone = result.activeNow
    ? 'is-danger'
    : presentation.state === 'caution'
    ? 'is-caution'
    : '';

  return (
    <div className={`pq-mycar-intel ${toneClass}`}>
      <div className="pq-mycar-intel-street">
        <Leaf size={14} className="text-[var(--color-text-secondary)]" />
        <p>{sideHeader}</p>
      </div>

      {presentation.state === 'caution' && (
        <div className="pq-mycar-intel-caution-banner">
          <div className="flex items-center gap-2 mb-1">
            <AlertTriangle size={16} className="text-[var(--color-warning)] shrink-0" />
            <p className="text-sm font-bold text-[var(--color-warning)]">{t('street_intel.needs_review')}</p>
          </div>
          <p className="text-xs text-[var(--color-text-secondary)]">
            {cautionCopy(presentation.reasons) ?? t('street_intel.needs_review_body')}
          </p>
        </div>
      )}

      {result.activeNow ? (
        <div className="pq-mycar-intel-hero">
          <div className={`pq-mycar-intel-hero-icon ${iconTone}`}>
            <AlertTriangle size={18} />
          </div>
          <div>
            <p className={`pq-mycar-intel-datetime ${datetimeTone}`}>
              {presentation.state === 'caution'
                ? t('street_intel.may_be_active_now')
                : t('street_intel.active_now')}
            </p>
            <p className="pq-mycar-intel-reason" style={{ marginTop: 4, marginBottom: 0 }}>
              {presentation.state === 'caution'
                ? t('street_intel.may_be_active_now_body')
                : t('street_intel.active_now_body')}
            </p>
          </div>
        </div>
      ) : result.nextDay ? (
        <div className="pq-mycar-intel-hero">
          <div className={`pq-mycar-intel-hero-icon ${iconTone}`}>
            {presentation.state === 'caution'
              ? <AlertTriangle size={18} />
              : <CheckCircle size={18} />}
          </div>
          <div>
            <p className="pq-mycar-intel-label">
              {presentation.state === 'caution'
                ? t('street_intel.estimated_window')
                : t('street_intel.safe_until_label')}
            </p>
            <p className={`pq-mycar-intel-datetime ${datetimeTone}`}>
              {result.safeUntil ? fmtSafeUntil(result.safeUntil) : `${result.nextDay} ${result.nextTime}`}
            </p>
          </div>
        </div>
      ) : (
        <div className="pq-mycar-intel-hero">
          <div className={`pq-mycar-intel-hero-icon ${iconTone}`}>
            {presentation.state === 'caution'
              ? <AlertTriangle size={18} />
              : <CheckCircle size={18} />}
          </div>
          <p className="text-sm text-[var(--color-text-secondary)]">{t('street_intel.no_upcoming')}</p>
        </div>
      )}

      <p className="pq-mycar-intel-reason">
        {t('street_intel.because', { schedule: result.scheduleDescription })}
      </p>

      <div className="pq-mycar-intel-chips">
        <span className="pq-mycar-intel-chip">
          {scheduleCount === 1
            ? t('street_intel.schedules_count_one')
            : t('street_intel.schedules_count', { count: String(scheduleCount) })}
        </span>
        {presentation.state === 'caution' ? (
          <span className="pq-mycar-intel-chip is-warning">
            {t('street_intel.needs_review')}
          </span>
        ) : (
          <span className="pq-mycar-intel-chip is-accent">
            {t('street_intel.info_available')}
          </span>
        )}
        {confirmedParkingSide && (
          <span className="pq-mycar-intel-chip is-warning">
            {t('street_intel.you_confirmed')}
          </span>
        )}
      </div>
      {metadataBlock}
      {presentation.state === 'caution' && (
        <p className="pq-mycar-intel-reason" style={{ marginTop: 10, marginBottom: 0 }}>
          {cautionCopy(presentation.reasons) ?? t('street_intel.decision_caution')}
        </p>
      )}
      {debugBlock}
    </div>
  );
};
