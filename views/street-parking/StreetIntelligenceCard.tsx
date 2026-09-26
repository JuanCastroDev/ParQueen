import React, { useState, useEffect } from 'react';
import { db } from '../../firebase';
import { collection, getDocs, getDoc, doc, query, where, orderBy } from 'firebase/firestore';
import { Leaf, AlertTriangle, CheckCircle } from 'lucide-react';
import {
  computeSafeUntil, toNYCDateKey, addNYCDateKeyDays, MAX_FORWARD_SEARCH_DAYS_AHEAD,
  StreetRuleDoc, SuspensionDoc, SafeUntilResult, CleaningSchedule,
} from '../../utils/streetIntelligence';
import {
  formatMeterWindowLabel, formatMeterStatus, formatMaxStay, MeterWindow,
} from '../../utils/streetIntelMeter';
import {
  classifyStreetIntelligence,
  StreetIntelligencePresentation,
} from '../../utils/streetIntelligencePresentation';
import { t, useLang } from '../../i18n';

interface Props {
  segmentId: string;
  parkingSide: string | null;
  streetName: string;
  sideConfidence: 'high' | 'low' | 'unknown';
  confirmedParkingSide: string | null;
  onConfirmSide: (side: string) => void;
  onResult?: (result: StreetIntelligenceCardResult) => void;
}

export interface StreetIntelligenceCardResult {
  movementResult: SafeUntilResult | null;
  cleaningAvailable: boolean;
  nextCleaningAt: Date | null;
}

const fmtSafeUntil = (d: Date) => {
  const day = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${day} at ${time}`;
};

export const StreetIntelligenceUnavailableCard = () => (
  <div className="pq-mycar-intel-unavailable">
    <div className="pq-mycar-intel-street">
      <AlertTriangle size={14} className="text-[var(--color-text-secondary)] shrink-0" />
      <p className="text-sm font-semibold text-[var(--color-text)]" style={{ textTransform: 'none', letterSpacing: '-0.01em', fontSize: 14 }}>
        {t('street_intel.could_not_verify')}
      </p>
    </div>
  </div>
);

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
  useLang();
  const sideLabel = (side: string) => SIDE_KEY_MAP[side] ? t(SIDE_KEY_MAP[side]) : side;

  // Effective side: user-confirmed takes priority, then GPS only if confidence is high
  const effectiveSide = confirmedParkingSide || (sideConfidence === 'high' ? parkingSide : null);

  const [result, setResult] = useState<SafeUntilResult | null>(null);
  const [meterWindows, setMeterWindows] = useState<MeterWindow[]>([]);
  const [meterTerms, setMeterTerms] = useState<{ maxStayMinutes?: number; rateDisplay?: string } | null>(null);
  const [restrictionWindows, setRestrictionWindows] = useState<CleaningSchedule[]>([]);
  const [timeLimitedWindows, setTimeLimitedWindows] = useState<CleaningSchedule[]>([]);
  const [cleaningWindows, setCleaningWindows] = useState<CleaningSchedule[]>([]);
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
    setMeterWindows([]);
    setMeterTerms(null);
    setRestrictionWindows([]);
    setTimeLimitedWindows([]);
    setCleaningWindows([]);
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

        const [segSnap, suspSnap] = await Promise.all([
          getDoc(doc(db, 'streetSegments', segmentId)),
          getDocs(query(
            collection(db, 'suspensions'),
            where('date', '>=', todayKey),
            where('date', '<=', horizonKey),
            orderBy('date', 'desc'),
          )),
        ]);
        if (cancelled) return;

        const segment = segSnap.exists() ? segSnap.data() : null;
        const activeRuleSetVersion = segment?.protocolVersion === 2
          ? segment.activeRuleSetVersion : null;
        const rulesSnap = await getDocs(activeRuleSetVersion
          ? query(
            collection(db, 'streetSegments', segmentId, 'streetRules'),
            where('ruleSetVersion', '==', activeRuleSetVersion),
          )
          : query(
            collection(db, 'streetSegments', segmentId, 'streetRules'),
            where('supersededAt', '==', null),
          ));
        if (cancelled) return;
        const rules = rulesSnap.docs
          .map(d => ({ id: d.id, ...d.data() } as StreetRuleDoc & { ruleSetVersion?: string }))
          .filter(rule => !activeRuleSetVersion || rule.ruleSetVersion === activeRuleSetVersion);
        cdbg(`streetRules count: ${rules.length}`);
        const nextPresentation = classifyStreetIntelligence(segment, rules);
        cdbg(`presentation state: ${nextPresentation.state} | source: ${nextPresentation.source ?? 'none'}`);
        setPresentation(nextPresentation);

        const suspensions = suspSnap.docs
          .map(d => ({ id: d.id, ...d.data() } as SuspensionDoc))
          .filter(s => s.status !== 'archived');
        const cleaningRules = rules.filter(r => r.type === 'streetCleaning' || !r.type);
        const meterRules = rules.filter(r => r.type === 'meter');
        const restrictionSet = rules.filter(r => r.type === 'curbRestrictionSet' || r.type === 'noParking' || r.type === 'noStanding' || r.type === 'noStopping' || r.type === 'timeLimited');
        const allSchedules: CleaningSchedule[] = cleaningRules.flatMap(r => ((r.schedules || []) as CleaningSchedule[]).map(s => ({ ...s, type: 'streetCleaning' as const })));
        const restrictionSchedules: CleaningSchedule[] = restrictionSet.flatMap(r => ((r.schedules || []) as CleaningSchedule[]).map(s => ({
          ...s,
          type: (s.type || r.type) as CleaningSchedule['type'],
        })));
        const movement = [
          ...allSchedules,
          ...restrictionSchedules.filter(s => s.type === 'noParking' || s.type === 'noStanding' || s.type === 'noStopping'),
        ];
        const timeLimited = restrictionSchedules.filter(s => s.type === 'timeLimited');
        const meters: MeterWindow[] = meterRules.flatMap(r => (r.schedules || []) as MeterWindow[]);
        const terms = meterRules.find(r => r.meterTerms)?.meterTerms || null;

        cdbg(`total schedules: ${allSchedules.length}`);
        setMeterWindows(meters);
        setMeterTerms(terms);
        setRestrictionWindows(restrictionSchedules.filter(s => s.type === 'noParking' || s.type === 'noStanding' || s.type === 'noStopping'));
        setTimeLimitedWindows(timeLimited);
        setCleaningWindows(allSchedules);

        if (nextPresentation.state === 'unknown') {
          cdbg('UI branch: unknown/unavailable');
          onResult?.({ movementResult: null, cleaningAvailable: false, nextCleaningAt: null });
          return;
        }

        if (!effectiveSide) {
          const sides = [...new Set([
            ...allSchedules.map(s => s.side),
            ...restrictionSchedules.map(s => s.side),
            ...meters.map(s => s.side),
          ])].filter(Boolean);
          cdbg(`UI branch: side-picker schedules=${allSchedules.length}`);
          setAvailableSides(sides);
          onResult?.({ movementResult: null, cleaningAvailable: false, nextCleaningAt: null });
          return;
        }

        cdbg(`computeSafeUntil input: scheduleCount=${allSchedules.length} suspensionCount=${suspensions.length}`);
        const r = computeSafeUntil(movement, effectiveSide, suspensions);
        cdbg(`computeSafeUntil result: activeNow=${r.activeNow} hasUpcoming=${Boolean(r.nextDay)} hasDescription=${Boolean(r.scheduleDescription)}`);

        const branch = r.scheduleDescription === null
          ? (allSchedules.length > 0 ? 'side-mismatch' : 'no-schedule')
          : r.activeNow ? 'active-now'
          : r.nextDay ? 'safe-until'
          : 'no-upcoming';
        cdbg(`UI branch: ${branch}`);

        setResult(r);
        const cleaningResult = computeSafeUntil(allSchedules, effectiveSide, suspensions);
        const nextCleaningAt = cleaningResult.scheduleDescription
          && cleaningResult.activeNow !== true
          && cleaningResult.safeUntil
          && cleaningResult.safeUntil.getTime() > Date.now()
          ? cleaningResult.safeUntil : null;
        onResult?.({
          movementResult: r,
          cleaningAvailable: Boolean(nextCleaningAt),
          nextCleaningAt,
        });
      } catch {
        cdbg('load failed');
        console.warn('StreetIntelligenceCard load failed');
        setLoadError(true);
        onResult?.({ movementResult: null, cleaningAvailable: false, nextCleaningAt: null });
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
    return <StreetIntelligenceUnavailableCard />;
  }

  if (presentation.state === 'unknown' || presentation.state === 'caution') {
    return <StreetIntelligenceUnavailableCard />;
  }

  if (!effectiveSide) {
    if (availableSides.length === 0) return null;
    return (
      <div className="pq-mycar-intel pq-mycar-intel--caution">
        <div className="pq-mycar-intel-street">
          <AlertTriangle size={14} className="text-[var(--color-warning)] shrink-0" />
          <p>{t('street_intel.info_available')}</p>
        </div>
        <p className="text-sm text-white font-semibold mb-1">
          {t('street_intel.which_side')}
        </p>
        <p className="pq-mycar-intel-reason">
          {t('street_intel.schedules_found_street', { street: streetName })}
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
        {debugBlock}
      </div>
    );
  }

  if (!result) return null;

  const effectiveSideLabel = sideLabel(effectiveSide);
  const sideHeader = `${streetName} · ${effectiveSideLabel}${confirmedParkingSide ? ' ✓' : ''}`;
  const sideMeters = meterWindows.filter(window => !window.side || window.side === effectiveSide);
  const sideRestrictions = restrictionWindows.filter(window => !window.side || window.side === effectiveSide);
  const sideTimeLimits = timeLimitedWindows.filter(window => !window.side || window.side === effectiveSide);
  const kindTitle = (kind?: string | null) => {
    if (kind === 'noStanding') return t('street_intel.no_standing');
    if (kind === 'noStopping') return t('street_intel.no_stopping');
    if (kind === 'noParking') return t('street_intel.no_parking');
    return t('street_intel.street_cleaning');
  };
  const restrictionDetails = sideRestrictions.length ? (
    <div className="pq-mycar-intel-reason" style={{ marginTop: 10, marginBottom: 0 }}>
      {sideRestrictions.map((window, index) => (
        <div key={`${window.type}-${index}`} className={index ? 'mt-2' : undefined}>
          <span className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-secondary)] mb-1">
            {kindTitle(window.type)}
          </span>
          <span className="block">{window.anytime ? t('street_intel.anytime') : formatMeterWindowLabel({
            side: window.side,
            days: window.days,
            startTime: window.startTime || '00:00',
            endTime: window.endTime || '00:00',
          })}</span>
        </div>
      ))}
    </div>
  ) : null;
  const sideCleaning = cleaningWindows.filter(window => !window.side || window.side === effectiveSide);
  const meterDetails = sideMeters.length ? (
    <div className="pq-mycar-intel-reason" style={{ marginTop: 10, marginBottom: 0 }}>
      <span className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-secondary)] mb-1">
        {t('street_intel.metered_parking')}
      </span>
      <span className="block">{formatMeterWindowLabel(sideMeters[0])}</span>
      <span className="block text-[var(--color-text-secondary)]">{formatMeterStatus(sideMeters)}</span>
      {(meterTerms?.rateDisplay || formatMaxStay(meterTerms?.maxStayMinutes)) && (
        <span className="block text-[var(--color-text-secondary)]">
          {[meterTerms?.rateDisplay, formatMaxStay(meterTerms?.maxStayMinutes)].filter(Boolean).join(' · ')}
        </span>
      )}
    </div>
  ) : null;
  const cleaningDetails = sideCleaning.length ? (
    <div className="pq-mycar-intel-reason" style={{ marginTop: 10, marginBottom: 0 }}>
      <span className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-secondary)] mb-1">
        {t('street_intel.street_cleaning')}
      </span>
      <span className="block">{formatMeterWindowLabel({
        side: sideCleaning[0].side,
        days: sideCleaning[0].days,
        startTime: sideCleaning[0].startTime || '00:00',
        endTime: sideCleaning[0].endTime || '00:00',
      })}</span>
    </div>
  ) : (sideMeters.length || sideRestrictions.length) ? (
    <p className="pq-mycar-intel-reason" style={{ marginTop: 10, marginBottom: 0 }}>
      {t('street_intel.no_cleaning_schedule_found')}
    </p>
  ) : null;
  const timeLimitDetails = sideTimeLimits.length ? (
    <div className="pq-mycar-intel-reason" style={{ marginTop: 10, marginBottom: 0 }}>
      <span className="block text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-text-secondary)] mb-1">
        {t('street_intel.time_limited')}
      </span>
      <span className="block">{formatMaxStay((sideTimeLimits[0] as any).hourLimit ? Number((sideTimeLimits[0] as any).hourLimit) * 60 : undefined) || formatMeterWindowLabel({
        side: sideTimeLimits[0].side,
        days: sideTimeLimits[0].days,
        startTime: sideTimeLimits[0].startTime || '00:00',
        endTime: sideTimeLimits[0].endTime || '00:00',
      })}</span>
    </div>
  ) : null;

  if (!result.scheduleDescription && !sideMeters.length && !sideRestrictions.length) {
    return (
      <div className="pq-mycar-intel">
        <div className="pq-mycar-intel-street">
          <Leaf size={14} className="text-[var(--color-text-secondary)]" />
          <p>{sideHeader}</p>
        </div>
        <p className="pq-mycar-intel-reason" style={{ marginBottom: 0 }}>
          {confirmedParkingSide
            ? t('street_intel.no_schedule_for_side', { side: effectiveSideLabel.toLowerCase() })
            : t('street_intel.no_schedule_unknown')}
        </p>
        {debugBlock}
      </div>
    );
  }

  const toneClass = result.activeNow
    ? 'pq-mycar-intel--danger'
    : 'pq-mycar-intel--safe';
  const iconTone = result.activeNow
    ? 'is-danger'
    : 'is-safe';
  const datetimeTone = result.activeNow
    ? 'is-danger'
    : '';

  return (
    <div className={`pq-mycar-intel ${toneClass}`}>
      <div className="pq-mycar-intel-street">
        <Leaf size={14} className="text-[var(--color-text-secondary)]" />
        <p>{sideHeader}</p>
      </div>

      {result.scheduleDescription ? (
        <>
          {result.activeNow ? (
        <div className="pq-mycar-intel-hero">
          <div className={`pq-mycar-intel-hero-icon ${iconTone}`}>
            <AlertTriangle size={18} />
          </div>
          <div>
            <p className={`pq-mycar-intel-datetime ${datetimeTone}`}>
              {result.anytime
                  ? t('street_intel.restricted')
                  : result.restrictionKind && result.restrictionKind !== 'streetCleaning'
                    ? t('street_intel.restricted_now')
                    : t('street_intel.active_now')}
            </p>
            <p className="pq-mycar-intel-reason" style={{ marginTop: 4, marginBottom: 0 }}>
              {result.restrictionKind && result.restrictionKind !== 'streetCleaning'
                  ? (result.anytime
                    ? `${kindTitle(result.restrictionKind)} · ${t('street_intel.anytime')}`
                    : t('street_intel.until', { time: result.safeUntil ? result.safeUntil.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) : '' }))
                  : t('street_intel.active_now_body')}
            </p>
          </div>
        </div>
      ) : result.nextDay ? (
        <div className="pq-mycar-intel-hero">
          <div className={`pq-mycar-intel-hero-icon ${iconTone}`}>
            <CheckCircle size={18} />
          </div>
          <div>
            <p className="pq-mycar-intel-label">
              {t('street_intel.safe_until_label')}
            </p>
            <p className={`pq-mycar-intel-datetime ${datetimeTone}`}>
              {result.safeUntil ? fmtSafeUntil(result.safeUntil) : `${result.nextDay} ${result.nextTime}`}
            </p>
          </div>
        </div>
      ) : (
        <div className="pq-mycar-intel-hero">
          <div className={`pq-mycar-intel-hero-icon ${iconTone}`}>
            <CheckCircle size={18} />
          </div>
          <p className="text-sm text-[var(--color-text-secondary)]">{t('street_intel.no_upcoming')}</p>
        </div>
      )}
        </>
      ) : null}

      {restrictionDetails}
      {cleaningDetails}
      {timeLimitDetails}
      {meterDetails}

      {debugBlock}
    </div>
  );
};
