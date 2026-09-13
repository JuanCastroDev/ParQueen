import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useFocusOnMount } from '../hooks/useFocusOnMount';
import { t, useLang } from '../i18n';
import { useModalAccessibility } from '../hooks/useModalAccessibility';
import { MapPin, Bell, BellOff, LocateFixed, WifiOff, ChevronRight, Check, Clock, Zap } from 'lucide-react';
import { db } from '../firebase';
import { collection, query, where, onSnapshot, orderBy, Timestamp } from 'firebase/firestore';
import { deriveNearbyState, resolveBlockedCTA, type LocationPermissionState, type LocationCallbacks } from '../utils/nearbyActivity';
import { usePingPhaseClock } from './street-parking/usePingPhaseClock';
import { derivePingLifecycle } from '../utils/pingLifecycle';
import { buildGeoQueryRanges } from './street-parking/geoQuery';
import { GeoRegionSubscription } from './street-parking/geoRegionSubscription';
import { NotificationEnableCard } from '../components/NotificationEnableCard';
import type { NotificationRuntimeState } from '../utils/notificationRegistration';
import { AppView } from '../types';
import { NavigationBar } from './street-parking/NavigationBar';
import { doc, updateDoc } from 'firebase/firestore';
import { RADIUS_OPTIONS, normalizeRadius, formatRadius } from '../utils/notificationRadius';
import {
    derivePingCard, distanceKm, kmToMiles, formatDistance, formatAvailableAt,
    summarizeFeed, MAX_VISIBLE_PINGS,
} from '../utils/nearbyFeed';
import { deriveNotificationPresentation } from '../utils/notificationPresentation';
import { getCurrentPosition, isGeolocationAvailable } from '../utils/geolocation';

interface NotificationsViewProps {
    user: any;
    onBack: () => void;
    onSelectSpot?: (spotId: string) => void;
    permissionState: LocationPermissionState;
    callbacks: LocationCallbacks;
    notificationRuntime?: NotificationRuntimeState | null;
    notificationBusy?: boolean;
    onEnableNotifications?: () => void;
    onRecheckNotifications?: () => void;
    setView?: (view: AppView) => void;
    unreadMessagesCount?: number;
    pendingUpdatesCount?: number;
}


const relativeTime = (ts: any): string => {
    if (!ts) return '';
    const ms = typeof ts.toMillis === 'function' ? ts.toMillis() : (ts.seconds ?? 0) * 1000;
    const diff = Math.floor((Date.now() - ms) / 1000);
    if (diff < 60) return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
};

const avatarGradients = [
    'linear-gradient(135deg,#1e3a5f,#1e40af)',
    'linear-gradient(135deg,#1a2e1a,#14532d)',
    'linear-gradient(135deg,#2e1a2e,#581c87)',
    'linear-gradient(135deg,#3b2a1a,#92400e)',
];

const LOCATION_NEEDED: LocationPermissionState[] = [
    'not_determined', 'denied_requestable', 'permanently_blocked', 'services_disabled',
];

export const NotificationsView: React.FC<NotificationsViewProps> = ({
    user, onBack, onSelectSpot, permissionState, callbacks,
    notificationRuntime, notificationBusy = false,
    onEnableNotifications, onRecheckNotifications, setView,
    unreadMessagesCount = 0, pendingUpdatesCount = 0,
}) => {
    const [spots, setSpots] = useState<any[]>([]);
    const [spotsLoading, setSpotsLoading] = useState(true);
    const [spotsError, setSpotsError] = useState(false);
    const [userLocation, setUserLocation] = useState<[number, number] | null>(null);
    const [locating, setLocating] = useState(false);
    const [locationError, setLocationError] = useState(false);
    const [requesting, setRequesting] = useState(false);
    const headingRef = useRef<HTMLHeadingElement>(null);
    useFocusOnMount(headingRef);
    const lang = useLang();

    const lastViewed = parseInt(localStorage.getItem('lastViewedNotifications') || '0', 10);

    // Fetch coordinates only when granted
    const fetchLocation = useCallback(() => {
        if (!isGeolocationAvailable()) { setLocationError(true); return; }
        setLocating(true);
        setLocationError(false);
        const timer = setTimeout(() => { setLocating(false); setLocationError(true); }, 10000);
        void getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 })
            .then(pos => {
                clearTimeout(timer);
                setUserLocation([pos.coords.latitude, pos.coords.longitude]);
                setLocating(false);
            })
            .catch(() => { clearTimeout(timer); setLocating(false); setLocationError(true); });
    }, []);

    useEffect(() => {
        if (permissionState === 'granted' && !userLocation) fetchLocation();
        setRequesting(false);
    }, [permissionState]); // eslint-disable-line react-hooks/exhaustive-deps

    // One source of truth: the same notificationRadius preference that controls
    // push alerts also bounds this feed. It streams in live from the private
    // preferences snapshot in App.tsx, so changing it anywhere re-runs the
    // subscription effect below and the feed follows immediately.
    const locale = lang === 'es' ? 'es-US' : 'en-US';
    const radiusMiles = normalizeRadius(user?.notificationRadius);
    const [radiusSheetOpen, setRadiusSheetOpen] = useState(false);
    const radiusDialogRef = useRef<HTMLDivElement>(null);
    useModalAccessibility({ isOpen: radiusSheetOpen, dialogRef: radiusDialogRef, onEscape: () => setRadiusSheetOpen(false) });
    const [radiusSaving, setRadiusSaving] = useState(false);

    const setRadius = useCallback(async (miles: number) => {
        setRadiusSheetOpen(false);
        if (!user?.id || miles === radiusMiles) return;
        setRadiusSaving(true);
        try {
            // The existing preference write path — the same document
            // NotificationsSettingsView writes, so alerts and feed cannot drift.
            await updateDoc(doc(db, 'users', user.id, 'private', 'preferences'), {
                notificationRadius: miles,
            });
        } catch {
            // The live snapshot is authoritative; a failed write simply leaves
            // the previous radius in place rather than desyncing the UI.
        } finally {
            setRadiusSaving(false);
        }
    }, [user?.id, radiusMiles]);

    // One navigation per tap. A fast double-tap on a card would otherwise fire
    // onSelectSpot/onBack twice and push two view transitions.
    const navigatingRef = useRef(false);
    const selectSpot = useCallback((spotId: string) => {
        if (navigatingRef.current) return;
        navigatingRef.current = true;
        onSelectSpot?.(spotId);
        onBack();
    }, [onSelectSpot, onBack]);

    const subscriptionRef = useRef<GeoRegionSubscription<any, undefined> | null>(null);
    const hasUsableLocation = permissionState === 'granted' && !!userLocation && !locationError;

    // Geo-bound spots listener: one Firestore range subscription per geohash
    // range covering the user's chosen alert radius around the resolved location,
    // reusing the same GeoRegionSubscription/buildGeoQueryRanges
    // infrastructure the map already relies on (see street-parking/useSpotData.ts).
    // Without a usable location there is no bare/citywide fallback — the
    // subscription is disposed (zero listeners, zero reads) instead.
    useEffect(() => {
        if (!db) return;

        if (!hasUsableLocation) {
            if (subscriptionRef.current) {
                subscriptionRef.current.dispose();
                subscriptionRef.current = null;
            }
            setSpots([]);
            return;
        }

        const [lat, lng] = userLocation!;
        // Fixed once per subscription generation — every range in this
        // generation shares this exact Timestamp rather than each computing
        // its own `Timestamp.now()`, matching the PR #75 expiration contract.
        const subscriptionTimestamp = Timestamp.now();
        const ranges = buildGeoQueryRanges(lat, lng, radiusMiles);

        const subscription = new GeoRegionSubscription<any, undefined>({
            subscribeRange: (range, onSnapshotCb, onErrorCb) => {
                const q = query(
                    collection(db, 'spots'),
                    where('status', 'in', ['available', 'interested']),
                    where('expiresAt', '>', subscriptionTimestamp),
                    where('geohash', '>=', range.start),
                    where('geohash', '<=', range.end),
                    orderBy('geohash'),
                );
                return onSnapshot(
                    q,
                    snap => onSnapshotCb(snap.docs.map(d => ({ id: d.id, data: { id: d.id, ...d.data() } as any }))),
                    err => onErrorCb(err),
                );
            },
            onData: merged => {
                const all = Array.from(merged.values())
                    .filter((s: any) => s.finderId !== user?.id && s.status !== 'interested');
                all.sort((a: any, b: any) => (b.reportedAt?.toMillis() || 0) - (a.reportedAt?.toMillis() || 0));
                setSpots(all);
                setSpotsLoading(false);
            },
            onActiveListenerError: () => { setSpotsLoading(false); setSpotsError(true); },
            onPendingListenerError: () => { setSpotsLoading(false); setSpotsError(true); },
        });

        subscriptionRef.current = subscription;
        subscription.setRegion(ranges);

        return () => {
            subscription.dispose();
            if (subscriptionRef.current === subscription) subscriptionRef.current = null;
        };
    }, [user?.id, hasUsableLocation, userLocation, radiusMiles]);

    // Reuses the same self-rescheduling clock the map already uses
    // (usePingPhaseClock/derivePingLifecycle) so a spot disappears at its
    // real expiresAt boundary even with zero further Firestore activity —
    // the query's `expiresAt > Timestamp.now()` bound is only evaluated once,
    // at subscription-creation time, and Firestore listeners don't re-fire
    // on wall-clock advancement alone.
    const nowMs = usePingPhaseClock(spots);
    const unexpiredSpots = spots.filter(s => !derivePingLifecycle(s, nowMs).expired);

    const filteredSpots = userLocation
        ? unexpiredSpots.filter(s =>
            kmToMiles(distanceKm(userLocation[0], userLocation[1], s.lat, s.lng)) <= radiusMiles)
        : unexpiredSpots;
    // The displayed count and the queried radius come from the same numbers,
    // so the summary line can never claim a different radius than it filtered on.
    const feedCounts = summarizeFeed(filteredSpots.length);
    const nearbySpots = filteredSpots.slice(0, MAX_VISIBLE_PINGS);
    const hasMore = feedCounts.hiddenByCap > 0;
    const showNoLocationBanner = !userLocation && spots.length > 0 && permissionState === 'granted';

    const renderState = deriveNearbyState({
        permissionState,
        locating,
        locationError,
        userLocation,
        spotsLoading,
        spotsError,
        nearbyCount: nearbySpots.length,
    });

    const isLocationNeeded = (LOCATION_NEEDED as string[]).includes(renderState);

    // Runtime capability stays authoritative — a compact "Alerts on" chip is
    // only shown for a genuinely registered runtime, never for the product
    // preference alone. Anything needing action keeps the full card.
    const notifPresentation = deriveNotificationPresentation(
        user?.notificationsEnabled !== false,
        notificationRuntime ?? null,
    );
    const notifNeedsAction = notifPresentation.action !== 'none'
        || notifPresentation.kind === 'ios_install_required'
        || notifPresentation.kind === 'unsupported';
    const notifCompact = !notifNeedsAction && notifPresentation.kind !== 'checking';
    // "LIVE" means a bounded subscription is actually attached and reporting.
    const isFeedLive = hasUsableLocation && !spotsError && !spotsLoading;

    // CTA for each location-needed sub-state — label and action are capability-derived
    // so a web button never says "Open Settings" when it can't open settings.
    const blockedAction = resolveBlockedCTA(renderState, callbacks);
    const locationCTA = blockedAction === 'openSettings'
        ? { label: t('nearby_activity.open_settings'), action: callbacks.openAppSettings }
        : blockedAction === 'openLocationServices'
        ? { label: t('nearby_activity.turn_on_services'), action: callbacks.openLocationServicesSettings }
        : blockedAction === 'recheck'
        ? { label: t('nearby_activity.check_again'), action: callbacks.recheckPermission }
        : {
            label: requesting ? t('nearby_activity.enable_requesting') : t('nearby_activity.enable_cta'),
            action: () => { setRequesting(true); callbacks.requestLocationPermission(); },
        };

    return (
        <div className="mobile-primary-screen h-full bg-[var(--color-bg)] flex flex-col">
            {/* Header — no Back control. This is a primary bottom-nav
                destination (Map | Nearby | Ping | Messages | Profile), and a
                back arrow made it read as a pushed secondary screen. `onBack`
                is still used to return to the map when a Ping is selected. */}
            <div
                className="px-5 pb-2 shrink-0 text-center"
                style={{ paddingTop: 'calc(env(safe-area-inset-top) + 18px)' }}
            >
                <h1
                    ref={headingRef}
                    tabIndex={-1}
                    className="text-[22px] font-extrabold text-[var(--color-text)] focus:outline-none leading-tight tracking-tight"
                >
                    {t('common.nearby_activity')}
                </h1>
                <p className="text-[13px] text-[var(--color-text-secondary)] mt-1">
                    {t('nearby_activity.subtitle')}
                </p>

                {/* Compact status strip. Replaces the full-width "alerts are
                    enabled" card whenever notifications are healthy — that card
                    only earns prime space when it needs an action. */}
                <div className="flex items-center justify-center gap-2 mt-3.5 flex-wrap">
                    {isFeedLive && (
                        <span className="pq-live-chip" aria-label={t('nearby_activity.live_aria')}>
                            <span className="pq-live-dot" aria-hidden="true" />
                            {t('nearby_activity.live')}
                        </span>
                    )}
                    {notifCompact && (
                        <span className={`pq-status-chip ${notifPresentation.kind === 'enabled' ? 'pq-status-chip--ok' : ''}`}>
                            {notifPresentation.kind === 'enabled'
                                ? <Check size={12} aria-hidden="true" />
                                : <BellOff size={12} aria-hidden="true" />}
                            {notifPresentation.kind === 'enabled'
                                ? t('nearby_activity.alerts_on')
                                : t('nearby_activity.alerts_off')}
                        </span>
                    )}
                    <button
                        type="button"
                        onClick={() => setRadiusSheetOpen(true)}
                        disabled={radiusSaving || !user?.id}
                        aria-haspopup="dialog"
                        aria-expanded={radiusSheetOpen}
                        aria-label={t('nearby_activity.radius_aria', { radius: formatRadius(radiusMiles) })}
                        className="pq-radius-pill"
                    >
                        {formatRadius(radiusMiles)}
                        <ChevronRight size={12} aria-hidden="true" className="rotate-90" />
                    </button>
                </div>
            </div>

            {/* Body */}
            {/* Column flex so the empty state can take the leftover height and
                sit centred between the header and the nav. */}
            <div className="flex-1 overflow-y-auto no-scrollbar flex flex-col">
                {onEnableNotifications && onRecheckNotifications && notifNeedsAction && (
                    <div className="px-4 pt-4 w-full max-w-md mx-auto">
                        <NotificationEnableCard
                            runtime={notificationRuntime ?? null}
                            productPreferenceEnabled={user?.notificationsEnabled !== false}
                            busy={notificationBusy}
                            onEnable={onEnableNotifications}
                            onRecheck={onRecheckNotifications}
                        />
                    </div>
                )}

                {/* ── Unified location-needed state ───────────────────────── */}
                {isLocationNeeded && (
                    <div className="flex-1 flex flex-col items-center justify-center px-6 pt-4 pb-14 text-center gap-4">
                        {/* Illustration */}
                        <div className="relative mb-2">
                            <div className="w-24 h-24 rounded-full bg-[#1e75ff]/10 border border-[#1e75ff]/20 flex items-center justify-center">
                                <div className="w-16 h-16 rounded-full bg-[#1e75ff]/15 border border-[#1e75ff]/30 flex items-center justify-center">
                                    <MapPin size={28} className="text-[var(--color-info)]" />
                                </div>
                            </div>
                            <div
                                className="absolute inset-0 rounded-full border border-[#1e75ff]/20 animate-ping"
                                style={{ animationDuration: '2s' }}
                            />
                        </div>

                        <p
                            className="text-[20px] font-bold text-[var(--color-text)] leading-tight"
                            style={{ textWrap: 'balance' } as React.CSSProperties}
                        >
                            {t('nearby_activity.enable_headline')}
                        </p>
                        <p className="text-[14px] text-[var(--color-text-secondary)] leading-relaxed max-w-[260px]">
                            {t('nearby_activity.enable_body')}
                        </p>

                        <button
                            type="button"
                            onClick={locationCTA.action}
                            disabled={requesting && renderState !== 'permanently_blocked' && renderState !== 'services_disabled'}
                            className="w-full max-w-[280px] h-[54px] rounded-full font-semibold text-[16px] text-white active:scale-[0.985] transition-transform disabled:opacity-70 mt-2"
                            style={{ background: 'linear-gradient(90deg, var(--color-brand), var(--color-brand-2))' }}
                        >
                            {locationCTA.label}
                        </button>

                        <p className="pq-helper-text text-[12px] leading-snug max-w-[240px]">
                            {t('nearby_activity.enable_reassurance')}
                        </p>

                        {/* Concise browser guidance for permanently_blocked on web */}
                        {blockedAction === 'recheck' && renderState === 'permanently_blocked' && (
                            <p className="pq-helper-text text-[11px] leading-snug max-w-[240px] text-center">
                                {t('nearby_activity.blocked_web_hint')}
                            </p>
                        )}
                    </div>
                )}

                {/* ── locating ────────────────────────────────────────────── */}
                {renderState === 'locating' && (
                    <div aria-live="polite" role="status" className="flex flex-col items-center justify-center gap-4 h-48">
                        <div className="w-7 h-7 rounded-full border-2 border-[#1e75ff] border-t-transparent animate-spin" />
                        <p className="text-[14px] font-semibold text-[var(--color-text)]">
                            {t('nearby_activity.locating_headline')}
                        </p>
                        <p className="text-[13px] text-[var(--color-text-secondary)]">
                            {t('nearby_activity.locating_body')}
                        </p>
                    </div>
                )}

                {/* ── location_error ──────────────────────────────────────── */}
                {renderState === 'location_error' && (
                    <div className="flex flex-col items-center justify-center px-6 py-12 text-center gap-4">
                        <div className="w-16 h-16 rounded-full bg-amber-500/10 border border-amber-500/20 flex items-center justify-center mb-1">
                            <LocateFixed size={24} className="text-[var(--color-warning)]" />
                        </div>
                        <p className="text-[17px] font-bold text-[var(--color-text)]">
                            {t('nearby_activity.error_headline')}
                        </p>
                        <p className="text-[13px] text-[var(--color-text-secondary)] leading-relaxed max-w-[240px]">
                            {t('nearby_activity.error_body')}
                        </p>
                        <button
                            type="button"
                            onClick={fetchLocation}
                            className="mt-2 px-8 h-[44px] rounded-full font-semibold text-[14px] text-white border border-[#1e75ff]/40 active:scale-[0.985] transition-transform"
                            style={{ background: '#0d1a2e' }}
                        >
                            {t('nearby_activity.error_retry')}
                        </button>
                    </div>
                )}

                {/* ── pings_loading ───────────────────────────────────────── */}
                {renderState === 'pings_loading' && (
                    <div aria-live="polite" role="status" className="flex flex-col items-center justify-center gap-4 h-48">
                        <div className="w-7 h-7 rounded-full border-2 border-[#1e75ff] border-t-transparent animate-spin" />
                        <p className="text-[14px] font-semibold text-[var(--color-text)]">
                            {t('nearby_activity.loading_headline')}
                        </p>
                    </div>
                )}

                {/* ── empty ───────────────────────────────────────────────── */}
                {renderState === 'empty' && (
                    // No create CTA here: the nav's central Ping is the one
                    // share action, and this tab is for watching, not creating.
                    <div className="flex-1 flex flex-col items-center justify-center px-8 pt-2 pb-14 text-center">
                        {/* Radar — concentric rings sweeping outward, the same
                            idea as the feed watching a radius around you. */}
                        <div className="pq-radar" aria-hidden="true">
                            <span className="pq-radar-ring" />
                            <span className="pq-radar-ring pq-radar-ring--2" />
                            <span className="pq-radar-ring pq-radar-ring--3" />
                            <span className="pq-radar-core">
                                <MapPin size={20} />
                            </span>
                        </div>

                        <h2 className="text-[20px] font-extrabold text-[var(--color-text)] tracking-tight mt-7">
                            {t('nearby_activity.empty_title')}
                        </h2>
                        <p
                            className="text-[14px] text-[var(--color-text-secondary)] mt-2 max-w-[31ch] leading-relaxed"
                            style={{ textWrap: 'pretty' } as React.CSSProperties}
                        >
                            {t('nearby_activity.empty_watching', { radius: formatRadius(radiusMiles) })}{' '}
                            {t('nearby_activity.empty_body')}
                        </p>

                        {notifCompact && notifPresentation.kind === 'enabled' && (
                            <p className="pq-empty-alert mt-5">
                                <Check size={13} aria-hidden="true" />
                                {t('nearby_activity.empty_will_alert')}
                            </p>
                        )}
                    </div>
                )}

                {/* Distinct from a location failure: the subscription itself
                    errored. Kept as its own state with its own retry rather
                    than folded into a generic error. */}
                {renderState === 'query_error' && (
                    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
                        <div className="w-16 h-16 rounded-full bg-rose-500/10 border border-rose-500/25 flex items-center justify-center">
                            <WifiOff size={24} className="text-[var(--color-danger)]" aria-hidden="true" />
                        </div>
                        <h2 className="text-[18px] font-extrabold text-[var(--color-text)] mt-5">
                            {t('nearby_activity.query_error_headline')}
                        </h2>
                        <p className="text-[13px] text-[var(--color-text-secondary)] leading-relaxed max-w-[260px] mt-1.5">
                            {t('nearby_activity.query_error_body')}
                        </p>
                        <button
                            type="button"
                            onClick={() => { setSpotsError(false); setSpotsLoading(true); }}
                            className="pq-cta mt-6 px-8 h-[44px] rounded-2xl font-bold text-[14px] text-white focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none"
                        >
                            {t('nearby_activity.query_error_retry')}
                        </button>
                    </div>
                )}

                {renderState === 'results' && (
                    <div className="px-4 pt-3 flex flex-col gap-2.5 pb-10">
                        {showNoLocationBanner && (
                            <div className="flex items-start gap-3 px-4 py-3 rounded-2xl bg-amber-500/10 border border-amber-500/25 mb-1">
                                <MapPin size={16} className="text-[var(--color-warning)] shrink-0 mt-0.5" />
                                <div>
                                    <p className="text-[13px] font-bold text-[var(--color-warning)]">{t('common.location_off')}</p>
                                    <p className="text-[12px] text-[var(--color-text-secondary)] leading-snug mt-0.5">
                                        {t('common.location_off_body')}
                                    </p>
                                </div>
                            </div>
                        )}

                        {/* Activity summary — the count and the radius are the
                            same values the filter used, so it cannot overstate. */}
                        <div className="px-1 pb-0.5" aria-live="polite" aria-atomic="true">
                            <p className="text-[10px] font-bold text-[var(--color-info)] tracking-[0.16em] uppercase">
                                {t('nearby_activity.live_nearby')}
                            </p>
                            <p className="text-[15px] font-extrabold text-[var(--color-text)] mt-0.5">
                                {userLocation
                                    ? t(feedCounts.total === 1 ? 'nearby_activity.count_one' : 'nearby_activity.count_many',
                                        { count: String(feedCounts.total), radius: formatRadius(radiusMiles) })
                                    : t(feedCounts.total === 1 ? 'nearby_activity.count_one_nolocation' : 'nearby_activity.count_many_nolocation',
                                        { count: String(feedCounts.total) })}
                            </p>
                        </div>

                        {nearbySpots.map(spot => {
                            const km = userLocation
                                ? distanceKm(userLocation[0], userLocation[1], spot.lat, spot.lng)
                                : null;
                            const distStr = km !== null ? formatDistance(km) : null;
                            const time = relativeTime(spot.reportedAt);
                            const card = derivePingCard(spot, nowMs, lastViewed);
                            const address = spot.address || t('nearby_activity.shared_spot');
                            const finderName = spot.finderName || spot.username || t('nearby_activity.someone_nearby');
                            const initial = finderName.charAt(0).toUpperCase();
                            const avatarBg = avatarGradients[initial.charCodeAt(0) % avatarGradients.length];

                            const statusLabel = card.kind === 'leaving_later'
                                ? t('nearby_activity.leaving_later')
                                : t('nearby_activity.available_now');
                            // Status, address and distance in the accessible name:
                            // the driver's actual decision, not "X pinged a spot".
                            const ariaLabel = [statusLabel, address, distStr
                                ? t('nearby_activity.distance_away', { dist: distStr }) : null]
                                .filter(Boolean).join(', ');

                            return (
                                <button
                                    key={spot.id}
                                    onClick={() => selectSpot(spot.id)}
                                    aria-label={ariaLabel}
                                    className={`pq-ping-card pq-ping-card--${card.kind}${card.expiringSoon ? ' pq-ping-card--urgent' : ''} w-full text-left rounded-[22px] p-4 flex items-center gap-3.5 focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none`}
                                >
                                    <span className="relative shrink-0" aria-hidden="true">
                                        <span
                                            className="w-11 h-11 rounded-[14px] flex items-center justify-center text-[16px] font-extrabold text-white"
                                            style={{ background: avatarBg }}
                                        >
                                            {initial}
                                        </span>
                                        {card.isNew && <span className="pq-new-dot" />}
                                    </span>

                                    <span className="block flex-1 min-w-0">
                                        {/* 1. the opportunity */}
                                        <span className="flex items-center gap-1.5 flex-wrap">
                                            <span className={`pq-ping-status pq-ping-status--${card.kind}`}>
                                                {card.kind === 'leaving_later'
                                                    ? <Clock size={11} aria-hidden="true" />
                                                    : <Zap size={11} aria-hidden="true" />}
                                                {statusLabel}
                                            </span>
                                            {card.expiringSoon && (
                                                <span className="pq-ping-status pq-ping-status--urgent">
                                                    {card.minutesLeft !== null
                                                        ? t('nearby_activity.expiring_in', { mins: String(card.minutesLeft) })
                                                        : t('nearby_activity.expiring_soon')}
                                                </span>
                                            )}
                                            {card.isNew && (
                                                <span className="pq-ping-status pq-ping-status--new">{t('nearby_activity.new')}</span>
                                            )}
                                        </span>

                                        {/* 2. the address */}
                                        <span className="block text-[15px] font-bold text-[var(--color-text)] leading-snug truncate mt-1.5">
                                            {address}
                                        </span>

                                        {/* 3/4. distance and freshness */}
                                        <span className="flex items-center gap-2 mt-1 text-[12px] text-[var(--color-text-secondary)]">
                                            {distStr && <span className="font-semibold text-[var(--color-text)]">{t('nearby_activity.distance_away', { dist: distStr })}</span>}
                                            {distStr && time && <span aria-hidden="true">·</span>}
                                            {card.kind === 'leaving_later' && card.availableAtMs
                                                ? <span>{t('nearby_activity.free_at', { time: formatAvailableAt(card.availableAtMs, locale) })}</span>
                                                : time && <span>{time}</span>}
                                        </span>

                                        {/* 5. contributor, last */}
                                        <span className="block text-[11px] text-[var(--color-text-secondary)] mt-1.5 truncate">
                                            {t('nearby_activity.shared_by', { name: finderName })}
                                        </span>
                                    </span>

                                    <ChevronRight size={18} aria-hidden="true" className="shrink-0 text-[var(--color-text-secondary)]" />
                                </button>
                            );
                        })}

                        {hasMore && (
                            <p className="text-center text-[11px] text-[var(--color-text-secondary)] pt-1 pb-2">
                                {userLocation
                                    ? t('nearby_activity.showing_closest', { more: String(feedCounts.hiddenByCap) })
                                    : t('nearby_activity.showing_recent', { more: String(feedCounts.hiddenByCap) })}
                            </p>
                        )}
                    </div>
                )}
            </div>
            {radiusSheetOpen && (
                <div
                    data-modal-root=""
                    className="pq-sheet-overlay fixed inset-0 flex items-end justify-center"
                >
                    <button
                        type="button"
                        aria-label={t('common.close')}
                        onClick={() => setRadiusSheetOpen(false)}
                        className="absolute inset-0 bg-black/60"
                    />
                    <div
                        ref={radiusDialogRef}
                        className="pq-sheet relative w-full max-w-md rounded-t-[26px] p-5"
                        role="dialog"
                        aria-modal="true"
                        aria-label={t('nearby_activity.radius_sheet_title')}
                        // Clears the fixed bottom nav; inline so it beats
                        // the Tailwind padding utility emitted after our CSS.
                        style={{ paddingBottom: 'calc(var(--mobile-primary-nav-space, 104px) + 8px)' }}
                    >
                        <h2 className="text-[17px] font-extrabold text-[var(--color-text)]">
                            {t('nearby_activity.radius_sheet_title')}
                        </h2>
                        <p className="text-[12px] text-[var(--color-text-secondary)] mt-1 leading-relaxed">
                            {t('nearby_activity.radius_sheet_body')}
                        </p>
                        <div className="grid grid-cols-4 gap-2 mt-4">
                            {RADIUS_OPTIONS.map(r => (
                                <button
                                    key={r}
                                    type="button"
                                    onClick={() => setRadius(r)}
                                    aria-pressed={r === radiusMiles}
                                    className={r === radiusMiles ? 'pq-radius-opt pq-radius-opt--on' : 'pq-radius-opt'}
                                >
                                    {r} mi
                                </button>
                            ))}
                        </div>
                    </div>
                </div>
            )}

            {setView && (
                <NavigationBar
                    currentView={AppView.NOTIFICATIONS}
                    setView={setView}
                    unreadMessagesCount={unreadMessagesCount}
                    pendingUpdatesCount={pendingUpdatesCount}
                />
            )}
        </div>
    );
};
