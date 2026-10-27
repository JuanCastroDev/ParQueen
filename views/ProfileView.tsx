import React, { useState, useEffect, useRef } from 'react';
import { useFocusOnMount } from '../hooks/useFocusOnMount';
import { useModalAccessibility } from '../hooks/useModalAccessibility';
import { getStorage, ref, uploadBytes } from 'firebase/storage';
import { doc, setDoc, serverTimestamp, onSnapshot, collection, query, where, orderBy, limit, getDocs, getCountFromServer } from 'firebase/firestore';
import { db } from '../firebase';
import { ChevronLeft, ChevronRight, Camera, Clock, Info, Settings, Crown, MapPin, Handshake, ParkingSquare, Plus, AlertTriangle, History } from 'lucide-react';
import { VehicleIcon } from '../utils/vehicleIcon';
import { AppView } from '../types';
import { getNextTitle, getTierForCrowns, getProgressPct, TITLE_THRESHOLDS } from '../utils/crowns';
import { CrownBadge } from '../utils/CrownBadge';
import { getInitials } from '../utils/profileAvatar';
import { validateAvatarUpload } from '../utils/avatarUploadValidation';
import { deriveImpactCounts } from '../utils/profileImpact';
import { t, useLang, getLang } from '../i18n';
import { NavigationBar } from './street-parking/NavigationBar';

// The durable per-user pingsShared counter (users/{uid}.impactStats.pingsShared)
// only started accumulating with this feature's rollout — historical ping
// activity before it was intentionally not backfilled (see the Pings Shared
// backfill-feasibility investigation). This constant is that fixed rollout
// boundary, not the incrementTotalSpotsPinged marker's own 2026-08-04 start
// date, which predates and is unrelated to this per-user counter.
const PINGS_SHARED_TRACKING_SINCE = new Date(2026, 7, 1);

// The current rank band, straight from the existing threshold helpers: the
// bar, the "X / Y" readout and "N to go" all read these same numbers.
export function describeJourney(crowns: number) {
  const tier = getTierForCrowns(crowns);
  const next = getNextTitle(crowns);
  const from = TITLE_THRESHOLDS[tier].crowns;
  return next
    ? { tier, next, from, to: crowns + next.crownsNeeded, pct: getProgressPct(crowns) }
    : { tier, next: null, from, to: from, pct: 100 };
}

export const ProfileView = ({ user, onBack, setView, unreadMessagesCount = 0, pendingUpdatesCount = 0 }) => {
  useLang();
  const locale = getLang() === 'es' ? 'es' : 'en-US';
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string>('');
  const [uploadError, setUploadError] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [recentActivity, setRecentActivity] = useState<{ id: string; icon: string; actionKey: string; address: string; ts: number; reward: string | null }[]>([]);
  const [impactState, setImpactState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [impactCounts, setImpactCounts] = useState({ pingsShared: 0, successfulHandoffs: 0, spotsFound: 0 });
  const [showCrownsInfo, setShowCrownsInfo] = useState(false);
  const crownsDialogRef = useRef<HTMLDivElement>(null);
  useModalAccessibility({ isOpen: showCrownsInfo, dialogRef: crownsDialogRef, onEscape: () => setShowCrownsInfo(false) });
  useFocusOnMount(headingRef);

  const fmt = (ms: number) => {
    const min = Math.round((Date.now() - ms) / 60000);
    if (min < 1) return t('profile.time_just_now');
    if (min < 60) return t('profile.time_min_ago', { min });
    const hr = Math.round(min / 60);
    if (hr < 24) return t('profile.time_hr_ago', { hr });
    return t('profile.time_days_ago', { d: Math.round(hr / 24) });
  };

  const colorLabels: Record<string, string> = {
    'Black': t('vehicle.color_black'), 'White': t('vehicle.color_white'),
    'Silver': t('vehicle.color_silver'), 'Gray': t('vehicle.color_gray'),
    'Blue': t('vehicle.color_blue'), 'Red': t('vehicle.color_red'),
    'Green': t('vehicle.color_green'), 'Brown': t('vehicle.color_brown'),
    'Beige': t('vehicle.color_beige'), 'Gold': t('vehicle.color_gold'),
    'Yellow': t('vehicle.color_yellow'), 'Orange': t('vehicle.color_orange'),
    'Purple': t('vehicle.color_purple'),
  };
  const typeLabels: Record<string, string> = {
    'Sedan': t('vehicle.type_sedan'), 'Compact': t('vehicle.type_compact'),
    'SUV': t('vehicle.type_suv'), 'Hatchback': t('vehicle.type_hatchback'),
    'Coupe': t('vehicle.type_coupe'), 'Pickup Truck': t('vehicle.type_pickup_truck'),
    'Van': t('vehicle.type_van'), 'Minivan': t('vehicle.type_minivan'),
    'Wagon': t('vehicle.type_wagon'), 'Convertible': t('vehicle.type_convertible'),
  };

  useEffect(() => {
    if (!user?.id) return;
    const fetchActivity = async () => {
      try {
        const items: { id: string; icon: string; actionKey: string; address: string; reward: string | null; ts: number }[] = [];

        // Three independent, purpose-specific reads, fetched concurrently.
        // RecentActivity (spots + feedback) only ever needs the newest 3
        // combined items — safe by the top-K-of-union argument (see the
        // RecentActivity bounded-query investigation). Spots found needs an
        // exact full-history count, which a server aggregation provides
        // without ever materializing the historical feedback documents
        // client-side (see the Spots Found decoupling investigation).
        const [spotsSnap, feedbackSnap, spotsFoundAgg] = await Promise.all([
          getDocs(query(
            collection(db, 'spots'),
            where('finderId', '==', user.id),
            orderBy('reportedAt', 'desc'),
            limit(3),
          )),
          getDocs(query(
            collection(db, 'spotFeedback'),
            where('userId', '==', user.id),
            orderBy('createdAt', 'desc'),
            limit(3),
          )),
          getCountFromServer(query(
            collection(db, 'spotFeedback'),
            where('userId', '==', user.id),
            where('outcome', '==', 'success'),
          )),
        ]);

        const recentSpots = spotsSnap.docs.map(d => ({ id: d.id, ...d.data() } as any));
        recentSpots.forEach(s => {
          const ts = s.reportedAt?.toMillis?.() || 0;
          const addr = s.address || '';
          if (s.status === 'occupied') {
            items.push({ id: `f-${s.id}`, icon: 'handshake', actionKey: 'profile.activity_helped_driver', address: addr, reward: '+2', ts });
          } else if (s.pingMode === 'later') {
            items.push({ id: `f-${s.id}`, icon: 'clock', actionKey: 'profile.activity_scheduled', address: addr, reward: null, ts });
          } else {
            items.push({ id: `f-${s.id}`, icon: 'pin', actionKey: 'profile.activity_pinged', address: addr, reward: null, ts });
          }
        });

        // Keep all feedback outcomes visible in RecentActivity, but only a
        // successful parking outcome represents the driver's earned Crown.
        const recentFeedback = feedbackSnap.docs.map(d => ({ id: d.id, ...d.data() } as any));
        recentFeedback.forEach(f => {
          const ts = f.createdAt?.toMillis?.() || 0;
          const successful = f.outcome === 'success';
          const actionKey = successful
            ? 'profile.activity_parked'
            : f.outcome === 'failed'
              ? 'profile.activity_parking_unsuccessful'
              : 'profile.activity_parking_completed';
          items.push({ id: `d-${f.id}`, icon: 'parking', actionKey, address: f.address || '', reward: successful ? '+1' : null, ts });
        });

        // successfulHandoffs and pingsShared come from durable users/{uid}
        // counters (already present in memory — App.tsx spreads the whole
        // users/{uid} doc into `user` — no extra Firestore read needed).
        // spotsFound comes from the aggregation above — an exact full-history
        // count, independent of whatever RecentActivity happens to fetch.
        const counts = deriveImpactCounts({
          pingsShared: user.impactStats?.pingsShared,
          successfulHandoffs: user.trustStats?.handoffsCompleted,
          spotsFound: spotsFoundAgg.data().count,
        });
        setImpactCounts(counts);
        setImpactState('loaded');

        items.sort((a, b) => b.ts - a.ts);
        setRecentActivity(items.slice(0, 3));
      } catch {
        setImpactState('error');
      }
    };
    fetchActivity();
  }, [user?.id]);

  const activityIcons: Record<string, React.ReactNode> = {
    handshake: <Handshake size={16} />,
    parking: <ParkingSquare size={16} />,
    pin: <MapPin size={16} />,
    clock: <Clock size={16} />,
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file && user) {
      // Reject too-large/unsupported files before any Firebase request — the
      // rule enforces the same limits server-side, but failing fast here
      // avoids a generic Storage 403 and gives the user an actionable reason.
      const validation = await validateAvatarUpload(file);
      if ('reason' in validation) {
        setUploadError(true);
        setUploadStatus(validation.reason === 'too_large'
          ? t('profile.avatar_too_large')
          : t('profile.avatar_unsupported_format'));
        setTimeout(() => setUploadStatus(''), 4000);
        return;
      }

      setIsUploading(true);
      setUploadError(false);
      setUploadStatus(t('profile.uploading'));
      const storage = getStorage();
      // Each upload gets a unique ID so the client can detect its own moderation result.
      // The server writes avatarUrl to users/{uid} after approval — no client updateDoc needed.
      const uploadId = crypto.randomUUID
        ? crypto.randomUUID()
        : Date.now().toString(36) + Math.random().toString(36).slice(2);
      const storageRef = ref(storage, `avatarUploads/${user.id}/${uploadId}/original`);
      try {
        // Register pendingUploadId before uploading so the server can detect
        // a pre-event newer-upload race even before this event arrives.
        await setDoc(doc(db, 'users', user.id, 'private', 'avatar'), {
          pendingUploadId: uploadId,
          requestedAt: serverTimestamp(),
        });
        // Explicit contentType — File.type is not trusted; validateAvatarUpload
        // already verified it (or the magic-byte fallback) against the same
        // allowlist storage.rules enforces server-side.
        await uploadBytes(storageRef, file, { contentType: validation.contentType });
        setUploadStatus(t('profile.reviewing_photo'));

        const moderationRef = doc(db, 'avatarModeration', user.id);
        // The backend allows 120 seconds per processing attempt. Leave another
        // 60 seconds for Eventarc delivery and Firestore listener propagation.
        const clientModerationTimeoutMs = 180_000;
        const timeout = setTimeout(() => {
          unsub();
          setUploadError(true);
          setUploadStatus(t('profile.photo_timed_out'));
          setIsUploading(false);
        }, clientModerationTimeoutMs);

        const unsub = onSnapshot(moderationRef, (snap) => {
          const data = snap.data();
          // Ignore stale docs from a previous upload or pre-terminal statuses.
          if (!data || data.uploadId !== uploadId) return;
          if (data.status === 'processing' || data.status === 'retry_pending') return;

          clearTimeout(timeout);
          unsub();

          if (data.status === 'approved') {
            // avatarUrl is set on users/{uid} by the server — picked up by the
            // existing user-doc listener in App.tsx without a client updateDoc call.
            setUploadError(false);
            setUploadStatus('');
          } else {
            setUploadError(true);
            setUploadStatus(t('profile.photo_rejected'));
            setTimeout(() => setUploadStatus(''), 4000);
          }
          setIsUploading(false);
        });
      } catch (_err) {
        setUploadError(true);
        setUploadStatus(t('profile.upload_failed'));
        setIsUploading(false);
      }
    }
  };

  const triggerUpload = () => fileInputRef.current?.click();

  const crowns = user?.crowns || 0;
  const journey = describeJourney(crowns);
  const initials = getInitials(user?.username, user?.fullName);
  const currentTitle = user?.title || t('profile.newcomer');
  const num = (n: number) => n.toLocaleString(locale);
  const crownLabel = crowns === 1 ? t('profile.crowns_singular', { count: crowns }) : t('profile.crowns_plural', { count: num(crowns) });
  const displayName = user?.username?.startsWith('user_')
    ? (user.fullName || t('profile.username_fallback'))
    : (user?.username || user?.fullName || t('profile.username_fallback'));
  const joined = (() => {
    const ts = user?.createdAt;
    if (!ts) return null;
    const d = typeof ts.toDate === 'function' ? ts.toDate() : new Date(ts);
    return t('profile.joined', { date: d.toLocaleDateString(locale, { month: 'long', year: 'numeric' }) });
  })();

  const vehicleColor = user?.vehicleColor ? (colorLabels[user.vehicleColor] ?? user.vehicleColor) : '';
  const vehicleType = user?.vehicleType ? (typeLabels[user.vehicleType] ?? user.vehicleType) : '';
  const vehicleName = [vehicleColor, user?.vehicleBrand].filter(Boolean).join(' ');
  const hasVehicle = !!(user?.vehicleBrand || user?.vehicleColor || user?.vehicleType);
  // Only the parts that exist: "Yellow Alfa Romeo" over "Compact", or just the type.
  const vehiclePrimary = vehicleName || vehicleType;
  const vehicleSecondary = vehicleName ? vehicleType : '';

  const stats = [
    { key: 'pings', value: impactCounts.pingsShared, icon: <MapPin size={15} />, one: 'profile.pings_shared_one', many: 'profile.pings_shared', since: true },
    { key: 'handoffs', value: impactCounts.successfulHandoffs, icon: <Handshake size={15} />, one: 'profile.successful_handoffs_one', many: 'profile.successful_handoffs', since: false },
    { key: 'spots', value: impactCounts.spotsFound, icon: <ParkingSquare size={15} />, one: 'profile.spots_found_one', many: 'profile.spots_found', since: false },
  ];
  const focusRing = 'focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none';

  return (
    <div className="mobile-primary-screen mobile-safe-top md:pt-4 md:pb-20 min-h-full bg-[var(--color-bg)] text-[var(--color-text)] px-4">
      {user ? (
        <div className="max-w-md mx-auto flex flex-col">

          {/* ── Header — no Back on phones: Profile is a bottom-nav tab. The
              nav is md:hidden, so wider screens keep Back as their way out. */}
          <header className="relative flex items-center justify-center h-11">
            <button
              onClick={onBack}
              aria-label={t('profile.back_aria')}
              className={`pq-icon-btn hidden md:flex absolute left-0 top-0 bg-[var(--color-overlay)] border border-[var(--color-border)] ${focusRing}`}
            >
              <ChevronLeft size={20} aria-hidden="true" />
            </button>
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="text-[17px] font-extrabold tracking-tight focus:outline-none"
            >
              {t('profile.title')}
            </h1>
            <button
              onClick={() => setView(AppView.SETTINGS)}
              aria-label={t('profile.settings_aria')}
              className={`pq-icon-btn absolute right-0 top-0 bg-[var(--color-overlay)] border border-[var(--color-border)] ${focusRing}`}
            >
              <Settings size={20} aria-hidden="true" />
            </button>
          </header>

          {/* ── Identity hero — open, no card ─────────────────────────────── */}
          <div className="relative flex flex-col items-center text-center pt-4 pb-7">
            <div className="pq-hero-glow" aria-hidden="true" />
            <div className="relative">
              <div className="pq-avatar-ring">
                <div
                  className="relative w-[96px] h-[96px] rounded-full overflow-hidden flex items-center justify-center"
                  style={{ background: 'linear-gradient(135deg, #0d1a2e 0%, #1e3a5f 100%)' }}
                  aria-hidden="true"
                >
                  {user.avatarUrl ? (
                    <img src={user.avatarUrl} alt="" className="w-full h-full object-cover" />
                  ) : initials ? (
                    <span className="text-[32px] font-extrabold text-white select-none leading-none">{initials}</span>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="none" className="w-11 h-11 text-[#38bdf8]/60" stroke="currentColor" strokeWidth={1.5}>
                      <circle cx="12" cy="8" r="4" />
                      <path d="M4 20c0-4 3.58-7 8-7s8 3 8 7" strokeLinecap="round" />
                    </svg>
                  )}
                  {isUploading && (
                    <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                      <div className="animate-spin motion-reduce:animate-none rounded-full h-7 w-7 border-b-2 border-white" />
                    </div>
                  )}
                </div>
              </div>
              {/* 44px target around a 30px badge */}
              <button
                onClick={triggerUpload}
                disabled={isUploading}
                aria-label={t('profile.upload_photo_aria')}
                className={`absolute -bottom-2 -right-2 w-11 h-11 rounded-full flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed ${focusRing}`}
              >
                <span className="pq-avatar-edit pointer-events-none"><Camera size={14} aria-hidden="true" /></span>
              </button>
              <input type="file" ref={fileInputRef} onChange={handleFileChange} accept="image/jpeg,image/png,image/webp" className="hidden" />
            </div>

            <h2 className="pq-profile-name mt-4 max-w-full truncate text-[24px] font-extrabold tracking-tight leading-tight" title={displayName}>
              {displayName}
            </h2>

            <p className="mt-2 flex items-center justify-center gap-1.5 text-[14px] font-semibold">
              <CrownBadge tier={journey.tier} size={17} />
              <span>{currentTitle}</span>
              <span aria-hidden="true" className="text-[var(--color-text-secondary)]">·</span>
              <span className="text-[var(--color-text-secondary)]">{crownLabel}</span>
            </p>
            {joined && <p className="text-[12.5px] text-[var(--color-text-secondary)] mt-1">{joined}</p>}

            {user.username?.startsWith('user_') && (
              <button
                onClick={() => setView(AppView.EDIT_PROFILE)}
                className={`mt-3 min-h-[44px] px-4 rounded-full bg-[#1e75ff]/12 border border-[#1e75ff]/30 pq-accent-text text-[13px] font-semibold active:scale-95 transition-transform ${focusRing}`}
              >
                {t('profile.complete_profile')}
              </button>
            )}

            {uploadStatus && (
              <p aria-live="polite" className={`text-[12.5px] mt-2 font-semibold ${uploadError ? 'pq-inline-note--error' : 'pq-accent-text'}`}>
                {uploadStatus}
              </p>
            )}
          </div>

          {/* ── Your Journey — the one strong card ────────────────────────── */}
          <section aria-labelledby="pq-journey-heading" className="pq-journey px-5 pt-4 pb-5">
            <div className="flex items-center justify-between">
              <h2 id="pq-journey-heading" className="pq-section-label">{t('profile.section_journey')}</h2>
              <button
                onClick={() => setShowCrownsInfo(true)}
                aria-label={t('profile.crowns_what_are')}
                className={`pq-icon-btn -mr-3 text-[var(--color-text-secondary)] ${focusRing}`}
              >
                <Info size={17} aria-hidden="true" />
              </button>
            </div>

            {journey.next ? (
              <>
                <div className="flex items-end justify-between gap-3 mt-1">
                  <p className="flex items-center gap-1.5 min-w-0 text-[17px] font-extrabold leading-tight">
                    <CrownBadge tier={journey.tier} size={17} />
                    <span className="truncate">{currentTitle}</span>
                  </p>
                  <div className="min-w-0 text-right">
                    <p className="text-[10.5px] font-bold uppercase tracking-[0.12em] text-[var(--color-text-secondary)]">{t('profile.next_label')}</p>
                    <p className="flex items-center justify-end gap-1.5 mt-0.5 text-[13.5px] font-semibold text-[var(--color-text-secondary)]">
                      <CrownBadge tier={journey.next.tier} size={13} />
                      <span className="truncate">{journey.next.title}</span>
                    </p>
                  </div>
                </div>
                <div
                  role="progressbar"
                  aria-label={t('profile.section_journey')}
                  aria-valuemin={journey.from}
                  aria-valuemax={journey.to}
                  aria-valuenow={crowns}
                  aria-valuetext={t('profile.progress_valuetext', { count: crowns, total: journey.to, title: journey.next.title })}
                  className="pq-progress-track mt-3.5"
                >
                  <div className="pq-progress-fill" style={{ width: `${journey.pct}%` }} />
                </div>
                <div className="flex items-center justify-between mt-2 text-[12.5px]">
                  <span className="font-semibold">
                    {journey.next.crownsNeeded === 1
                      ? t('profile.crowns_to_go_one')
                      : t('profile.crowns_to_go', { count: num(journey.next.crownsNeeded) })}
                  </span>
                  <span className="tabular-nums text-[var(--color-text-secondary)]" aria-hidden="true">{num(crowns)} / {num(journey.to)}</span>
                </div>
              </>
            ) : (
              <>
                <p className="flex items-center gap-1.5 mt-1 text-[17px] font-extrabold leading-tight">
                  <CrownBadge tier={journey.tier} size={17} />
                  <span className="truncate">{currentTitle}</span>
                </p>
                <div
                  role="progressbar"
                  aria-label={t('profile.section_journey')}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={100}
                  aria-valuetext={t('profile.max_rank')}
                  className="pq-progress-track mt-3.5"
                >
                  <div className="pq-progress-fill pq-progress-fill--max" style={{ width: '100%' }} />
                </div>
                <p className="mt-2 text-[12.5px] font-semibold">{t('profile.max_rank')}</p>
              </>
            )}

            <div className="pq-journey-divider my-4" />

            {/* Impact. A failed count shows the existing error line, never a fake 0. */}
            {impactState === 'error' ? (
              <p className="text-[12.5px] text-[var(--color-text-secondary)] text-center py-1">{t('profile.impact_loading_error')}</p>
            ) : (
              <dl className="grid grid-cols-3 gap-2" aria-busy={impactState === 'loading'}>
                {stats.map(s => (
                  <div key={s.key} className="flex flex-col items-center text-center min-w-0">
                    <span className="pq-stat-icon mb-2" aria-hidden="true">{s.icon}</span>
                    <dt className="order-2 mt-1.5 text-[11.5px] leading-snug text-[var(--color-text-secondary)]">
                      {t(s.value === 1 ? s.one : s.many)}
                      {s.since && (
                        <span className="pq-stat-since block text-[10px]">
                          {t('profile.pings_shared_since', { date: PINGS_SHARED_TRACKING_SINCE.toLocaleDateString(locale, { month: 'short', year: 'numeric' }) })}
                        </span>
                      )}
                    </dt>
                    <dd className="order-1">
                      {impactState === 'loaded'
                        ? <span className="pq-stat-value">{num(s.value)}</span>
                        : <span className="pq-skeleton block w-8 h-[26px]" />}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </section>

          {/* ── Your Vehicle — compact utility row ────────────────────────── */}
          <section aria-labelledby="pq-vehicle-heading" className="mt-7">
            <h2 id="pq-vehicle-heading" className="pq-section-label px-1 mb-2.5">{t('profile.section_vehicle')}</h2>
            <button
              onClick={() => setView(AppView.EDIT_VEHICLE)}
              className={`pq-util-card w-full min-h-[72px] px-3.5 py-3 flex items-center gap-3.5 text-left ${focusRing}`}
            >
              <span className="pq-vehicle-tile" aria-hidden="true">
                {hasVehicle
                  ? <VehicleIcon type={user.vehicleType} color={user.vehicleColor} size={22} />
                  : <Plus size={20} className="pq-stat-icon" />}
              </span>
              <span className="flex-1 min-w-0">
                <span className="block truncate text-[15px] font-bold">{hasVehicle ? vehiclePrimary : t('profile.no_vehicle')}</span>
                {(hasVehicle ? vehicleSecondary : true) && (
                  <span
                    className="block mt-0.5 text-[12.5px] leading-snug text-[var(--color-text-secondary)]"
                    style={{ textWrap: 'pretty' } as React.CSSProperties}
                  >
                    {hasVehicle ? vehicleSecondary : t('profile.no_vehicle_hint')}
                  </span>
                )}
              </span>
              <ChevronRight size={18} className="text-[var(--color-text-secondary)] shrink-0" aria-hidden="true" />
            </button>

            {(user.vehicleType || user.vehicleBrand) && !user.vehicleColor && (
              <button
                onClick={() => setView(AppView.EDIT_VEHICLE)}
                className={`pq-warn-banner mt-2.5 w-full min-h-[44px] px-4 rounded-2xl flex items-center gap-2.5 text-left active:scale-[0.99] transition-transform ${focusRing}`}
              >
                <AlertTriangle size={15} className="shrink-0" aria-hidden="true" />
                <span className="flex-1 text-[12.5px] font-semibold">{t('vehicle.incomplete_banner')}</span>
              </button>
            )}
          </section>

          {/* ── Recent Activity — a plain list, not another card ──────────── */}
          <section aria-labelledby="pq-activity-heading" className="mt-7">
            <h2 id="pq-activity-heading" className="pq-section-label px-1 mb-1">{t('profile.section_activity')}</h2>

            {impactState === 'loading' ? (
              <div aria-hidden="true">
                {[0, 1].map(i => (
                  <div key={i} className="pq-activity-row flex items-center gap-3 py-3 px-1">
                    <span className="pq-skeleton w-[38px] h-[38px] rounded-xl" />
                    <span className="flex-1 space-y-1.5"><span className="pq-skeleton block h-3.5 w-2/5" /><span className="pq-skeleton block h-3 w-3/5" /></span>
                  </div>
                ))}
              </div>
            ) : impactState === 'error' ? (
              <p className="py-4 px-1 text-[12.5px] text-[var(--color-text-secondary)]">{t('profile.activity_load_error')}</p>
            ) : recentActivity.length === 0 ? (
              <div className="flex items-center gap-3 py-3 px-1">
                <span className="pq-activity-icon pq-activity-icon--pin" aria-hidden="true"><History size={16} /></span>
                <span className="min-w-0">
                  <span className="block text-[14px] font-semibold">{t('profile.no_activity')}</span>
                  <span className="block text-[12.5px] text-[var(--color-text-secondary)] mt-0.5">{t('profile.no_activity_hint')}</span>
                </span>
              </div>
            ) : (
              <ul>
                {recentActivity.map(item => (
                  <li key={item.id} className="pq-activity-row flex items-center gap-3 py-3 px-1">
                    <span className={`pq-activity-icon pq-activity-icon--${item.icon}`} aria-hidden="true">
                      {activityIcons[item.icon] ?? activityIcons.pin}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block truncate text-[14px] font-semibold">{t(item.actionKey)}</span>
                      {item.address && (
                        <span className="pq-activity-address block truncate mt-0.5 text-[12.5px] text-[var(--color-text-secondary)]">{item.address}</span>
                      )}
                    </span>
                    <span className="shrink-0 flex flex-col items-end gap-1">
                      <span className="text-[11.5px] tabular-nums text-[var(--color-text-secondary)]">{fmt(item.ts)}</span>
                      {item.reward && (
                        <span
                          className="pq-reward inline-flex items-center gap-0.5 text-[12px] font-bold"
                          aria-label={item.reward === '+1' ? t('profile.crowns_singular', { count: item.reward }) : t('profile.crowns_plural', { count: item.reward })}
                        >
                          {item.reward}<Crown size={11} aria-hidden="true" />
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            <button
              onClick={() => setView(AppView.PARKING_SPACE)}
              className={`pq-accent-text w-full min-h-[44px] mt-1 px-1 flex items-center justify-between text-[13.5px] font-semibold rounded-xl ${focusRing}`}
            >
              {t('profile.view_all_activity')}
              <ChevronRight size={17} aria-hidden="true" />
            </button>
          </section>

        </div>
      ) : (
        <div className="text-center py-10">{t('profile.not_logged_in')}</div>
      )}

      {/* Crowns info modal */}
      {showCrownsInfo && (
        <div
          data-modal-root=""
          className="fixed inset-0 z-50 flex items-end justify-center p-4 bg-black/60 backdrop-blur-sm"
          onClick={() => setShowCrownsInfo(false)}
        >
          <div
            ref={crownsDialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="crowns-modal-title"
            className="w-full max-w-md bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl p-5 space-y-3"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <Crown size={18} className="text-[var(--color-warning)] shrink-0" aria-hidden="true" />
              <h3 id="crowns-modal-title" className="text-base font-extrabold text-[var(--color-text)]">
                {t('profile.crowns_modal_title')}
              </h3>
            </div>
            <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">{t('profile.crowns_modal_body1')}</p>
            <p className="text-sm text-[var(--color-text-secondary)] leading-relaxed">{t('profile.crowns_modal_body2')}</p>
            <button
              onClick={() => setShowCrownsInfo(false)}
              className="w-full py-3 rounded-xl bg-white/8 border border-[var(--color-border)] text-sm font-bold text-[var(--color-text)] hover:bg-white/12 active:scale-[0.98] transition-all"
            >
              {t('profile.crowns_modal_dismiss')}
            </button>
          </div>
        </div>
      )}
      {!showCrownsInfo && (
        <NavigationBar
          currentView={AppView.PROFILE}
          setView={setView}
          unreadMessagesCount={unreadMessagesCount}
          pendingUpdatesCount={pendingUpdatesCount}
        />
      )}
    </div>
  );
};
