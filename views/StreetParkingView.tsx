import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { AppView } from '../types';
import { MapPin, Check, Locate, X, Bell, Clock, ChevronRight, ChevronLeft, Users, Car, Navigation, CheckCircle2 } from 'lucide-react';
import { db } from '../firebase';
import { collection, addDoc, Timestamp, doc, deleteDoc, writeBatch, updateDoc, getDocs, getDoc, setDoc, where, query, orderBy, startAt, endAt, serverTimestamp, limit } from 'firebase/firestore';
import { auth } from '../firebaseConfig';
import { detectParkingSide } from '../utils/streetIntelligence';
import { detectCardinalSide } from '../utils/sweepnyc';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { getApp } from 'firebase/app';
import mapboxgl from 'mapbox-gl';
import 'mapbox-gl/dist/mapbox-gl.css';
import * as geofire from 'geofire-common';

import { NYC_CENTER, createMarkerElement, createStackMarkerElement, clearRoute, drawRoute, getDistance } from './street-parking/utils';
import { getMapboxToken } from '../utils/browserCredentials';
import { t, useLang } from '../i18n';
import { VehicleIcon } from '../utils/vehicleIcon';
import { getTitleForCrowns } from '../utils/crowns';
import { createUserLocationGeohashPersister } from '../utils/userLocationGeohash';
import { getCurrentPosition, isGeolocationAvailable, watchPosition, type LocationWatchHandle } from '../utils/geolocation';
import { derivePingLifecycle, getPingExpiresAtMs, getPingPhase, timestampToMillis } from '../utils/pingLifecycle';
import { countUsableStreetIntelligence, shouldCallEmptyCacheRefresh, shouldCallRestrictionMigrationRefresh, hasRestrictionEvaluation, logStreetIntelEvent } from '../utils/streetIntelRefresh';


const reverseGeocode = async (lng: number, lat: number): Promise<string> => {
    try {
        const res = await fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${lng},${lat}.json?types=address&limit=1&access_token=${getMapboxToken()}`);
        const json = await res.json();
        return json.features?.[0]?.place_name?.split(',')[0] || '';
    } catch { return ''; }
};
import { MapItem, MapViewProps } from './street-parking/types';
import { SpotModal } from './street-parking/SpotModal';
import { TimePicker } from './street-parking/TimePicker';
import { GlassDatePicker } from './street-parking/GlassDatePicker';
import { localDateStr, combineDateAndTime } from './street-parking/dateUtils';
import { useSearch } from './street-parking/useSearch';
import { useSpotData } from './street-parking/useSpotData';
import { useInterestFlow } from './street-parking/useInterestFlow';
import { checkPingRateLimit } from './street-parking/pingRateLimit';
import { reportPingCreationFailure } from './street-parking/pingFailureReporting';
import { SpotDetailsCard } from './street-parking/SpotDetailsCard';
import { BottomSheet } from './street-parking/BottomSheet';
import { HandoffFlow } from './street-parking/HandoffFlow';
import { ParkingActivitySheet } from './street-parking/ParkingActivitySheet';
import { HeaderBar } from './street-parking/HeaderBar';
import { NavigationBar } from './street-parking/NavigationBar';
import { StreetIntelligenceCard, StreetIntelligenceUnavailableCard } from './street-parking/StreetIntelligenceCard';
import { useParkingTimer } from './street-parking/useParkingTimer';
import { SAVED_SPOT_KEY, readSavedSpot, type SavedSpot } from '../utils/savedSpot';
import { usePingPhaseClock } from './street-parking/usePingPhaseClock';
import { AppTour, TOUR_KEY } from './street-parking/AppTour';
import { resolveNotificationPing } from '../utils/notificationPing';
import { AccessibleModal } from '../components/AccessibleModal';
import { shouldShowMapPrimaryNavigation } from './street-parking/mobileNavigationVisibility';
import { isLegacyNYCOpenDataSegment } from '../utils/streetIntelligenceLegacy';


export const MapView: React.FC<MapViewProps> = ({
    user,
    setView,
    onMessageUser,
    pendingSpotId,
    onPendingSpotConsumed,
    onPendingSpotUnavailable,
    pendingMyCarOpen = false,
    onPendingMyCarConsumed,
    allowLocationTracking,
    showPrimaryNavigation = true,
    unreadMessagesCount = 0,
    onPendingUpdatesCountChange,
}) => {
    useLang(); // re-render on language change
    const mapContainerRef = useRef<HTMLDivElement>(null);
    const mapRef = useRef<mapboxgl.Map | null>(null);
    const allMarkersRef = useRef<Record<string, mapboxgl.Marker>>({});
    const userMarkerRef = useRef<mapboxgl.Marker | null>(null);
    const lastParkedMarkerRef = useRef<mapboxgl.Marker | null>(null);
    const activeRouteDestinationRef = useRef<[number, number] | null>(null);

    // Capture the initial tracking permission so the map-init effect doesn't need it as a dep
    const allowLocationTrackingRef = useRef(allowLocationTracking);

    const [selectedItem, setSelectedItem] = useState<any | null>(null);
    const [selectedItemManageMode, setSelectedItemManageMode] = useState(false);
    const [userLocation, setUserLocation] = useState<[number, number] | null>(null);
    const [searchCenter, setSearchCenter] = useState<[number, number] | null>(null);
    const [mapReady, setMapReady] = useState(false);
    const [stackGroup, setStackGroup] = useState<MapItem[] | null>(null);
    const [spotDetailsBackStack, setSpotDetailsBackStack] = useState<MapItem[] | null>(null);
    const [mapFilterRadiusMiles, setMapFilterRadiusMiles] = useState(2.0);
    const [showTour, setShowTour] = useState(false);

    const [showFree, setShowFree] = useState(true);
    const [showPaid, setShowPaid] = useState(false);


    const [isPinging, setIsPinging] = useState(false);
    const [showPingConfirmation, setShowPingConfirmation] = useState(false);
    const [pingError, setPingError] = useState<string | null>(null);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const deletePingCancelRef = useRef<HTMLButtonElement>(null);
    const [isSpotModalOpen, setSpotModalOpen] = useState(false);
    const [spotAddress, setSpotAddress] = useState<string>(() => t('my_car.resolving_address'));


    const userRef = useRef(user);
    useEffect(() => { userRef.current = user; }, [user]);
    const userLocationGeohashPersisterRef = useRef(createUserLocationGeohashPersister(
        async (uid, geohash) => {
            await setDoc(doc(db, 'userLocations', uid), {
                lastGeohash: geohash,
                lastGeohashUpdatedAt: serverTimestamp(),
            }, { merge: true });
        },
    ));
    // Tracks last GPS accuracy reading from watchPosition — used at saveMySpot time
    const lastGpsAccuracyRef = useRef<number | null>(null);
    const emptyRulesRefreshAttemptedRef = useRef<Set<string>>(new Set());
    const restrictionRefreshAttemptedRef = useRef<Set<string>>(new Set());

    // Show first-run tutorial once map is ready and user is authenticated
    useEffect(() => {
        if (!mapReady || !user?.id) return;
        if (localStorage.getItem(TOUR_KEY)) return;
        if (selectedItem || stackGroup) return;
        const t = setTimeout(() => setShowTour(true), 400);
        return () => clearTimeout(t);
    }, [mapReady, user?.id, selectedItem, stackGroup]);

    // --- Custom hooks ---

    const search = useSearch();
    const spotData = useSpotData({
        userId: user?.id,
        blockedUsers: user?.blockedUsers,
        searchCenter: searchCenter || NYC_CENTER,
        showFree,
        showPaid,
        filterRadiusMiles: mapFilterRadiusMiles,
    });
    useEffect(() => {
        onPendingUpdatesCountChange?.(spotData.pendingUpdatesCount);
    }, [onPendingUpdatesCountChange, spotData.pendingUpdatesCount]);
    const nowMs = usePingPhaseClock(spotData.radiusFilteredItems);
    const currentItems = useMemo(
        () => spotData.radiusFilteredItems.filter(item => !derivePingLifecycle(item, nowMs, user?.id).expired),
        [spotData.radiusFilteredItems, nowMs, user?.id],
    );

    const itemsRef = useRef<MapItem[]>([]);
    itemsRef.current = currentItems;

    useEffect(() => {
        if (selectedItem && derivePingLifecycle(selectedItem, nowMs, user?.id).expired) {
            setSelectedItem(null);
            setSelectedItemManageMode(false);
            setSpotDetailsBackStack(null);
        }
        setStackGroup(current => {
            if (!current) return current;
            const live = current.filter(item => !derivePingLifecycle(item, nowMs, user?.id).expired);
            return live.length === current.length ? current : (live.length ? live : null);
        });
    }, [nowMs, selectedItem, user?.id]);

    // Resolve a notification Ping against current map state, then one direct
    // document read if the radius-bounded arrays do not contain it. Every
    // outcome consumes the pending ID so stale alerts cannot remain stuck.
    useEffect(() => {
        if (!pendingSpotId || !mapReady) return;
        let cancelled = false;
        const currentItems = [...spotData.freeSpots, ...spotData.activeSpots];
        void resolveNotificationPing(
            pendingSpotId,
            currentItems,
            Date.now(),
            async spotId => {
                const snap = await getDoc(doc(db, 'spots', spotId));
                return snap.exists() ? ({ id: snap.id, ...snap.data() } as any) : null;
            },
        ).then(result => {
            if (cancelled) return;
            onPendingSpotConsumed?.();
            if (result.kind === 'unavailable') {
                onPendingSpotUnavailable?.();
                return;
            }
            const item = result.item;
            mapRef.current?.flyTo({ center: [item.lng as number, item.lat as number], zoom: 17, duration: 800 });
            setSelectedItem(item);
        }).catch(() => {
            if (cancelled) return;
            onPendingSpotConsumed?.();
            onPendingSpotUnavailable?.();
        });
        return () => { cancelled = true; };
    }, [pendingSpotId, mapReady, spotData.freeSpots, spotData.activeSpots]);

    const interestFlow = useInterestFlow({
        selectedItem,
        setSelectedItem,
        user,
        freeSpots: spotData.freeSpots,
        userLocation,
        mapRef,
        activeRouteDestinationRef,
    });

    const parkingTimer = useParkingTimer();

    type SegmentMatch = {
        segmentId: string | null;
        parkingSide: string | null;
        sideConfidence?: SavedSpot['sideConfidence'];
        restrictionVersionId: string | null;
        segmentStreetName: string | null;
        streetIntelStatus: 'found' | 'unavailable' | 'failed';
        streetIntelReason: string | null;
    };

    const cfReasonToIntelStatus = (reason: string | undefined): 'unavailable' | 'failed' => {
        const unavailableReasons = ['no_sweepnyc_notes', 'no_signs', 'no_sweepnyc_data', 'archived_segment'];
        return reason && unavailableReasons.includes(reason) ? 'unavailable' : 'failed';
    };

    // Read/expiry/back-fill now live in utils/savedSpot so the assistant reads
    // the same record through the same parser. Key and shape are unchanged.
    const [savedSpot, setSavedSpot] = useState<SavedSpot | null>(() => readSavedSpot());
    // Always-current mirror of savedSpot.linkedPingId — set synchronously before any
    // Firestore write so the marker filter is correct even before React re-renders.
    const linkedPingIdRef = useRef<string | null>(savedSpot?.linkedPingId ?? null);
    const [reminderEnabled, setReminderEnabled] = useState<boolean>(
        () => localStorage.getItem('streetCleaningReminder') !== 'false'
    );
    const [showSessionSheet, setShowSessionSheet] = useState(false);
    const [showDepartureSheet, setShowDepartureSheet] = useState(false);

    useEffect(() => {
        if (!pendingMyCarOpen) return;
        onPendingMyCarConsumed?.();
        if (savedSpot) setShowSessionSheet(true);
    }, [pendingMyCarOpen, savedSpot, onPendingMyCarConsumed]);
    const [parkedDuration, setParkedDuration] = useState('');
    const [showCustomReminder, setShowCustomReminder] = useState(false);
    const [showRemindPanel, setShowRemindPanel] = useState(false);
    const [reminderAmPm, setReminderAmPm] = useState<'AM' | 'PM'>(new Date().getHours() < 12 ? 'AM' : 'PM');
    const [reminderHour, setReminderHour] = useState('');
    const [reminderMinute, setReminderMinute] = useState('');
    const [reminderDate, setReminderDate] = useState(() => localDateStr());
    const reminderMinuteRef = useRef<HTMLInputElement>(null);
    const reminderSlots = useMemo(() => {
        const now = new Date();
        const start = new Date(now);
        const rem = start.getMinutes() % 30;
        start.setMinutes(start.getMinutes() + (rem === 0 ? 30 : 30 - rem), 0, 0);
        return Array.from({ length: 10 }, (_, i) => new Date(start.getTime() + i * 30 * 60000));
    }, [showCustomReminder]); // recalculate each time picker opens
    const parkedSheetSetterRef = useRef<(() => void) | null>(null);
    parkedSheetSetterRef.current = () => setShowSessionSheet(true);
    // Tracks whether SpotModal was opened from the departure flow —
    // session only ends on successful ping, not on dismiss.
    const isDepartureFlowRef = useRef(false);

    // My Car inline departure flow (bypasses SpotModal entirely)
    const [myCarDepartureView, setMyCarDepartureView] = useState<'prompt' | 'timePicker'>('prompt');
    const [myCarDepartureTime, setMyCarDepartureTime] = useState(() => new Date(Date.now() + 2 * 60_000));
    const [myCarDepartureLoading, setMyCarDepartureLoading] = useState(false);
    const [myCarDepartureError, setMyCarDepartureError] = useState<string | null>(null);
    const [myCarDepartureDate, setMyCarDepartureDate] = useState(() => localDateStr());
    const [linkedPingError, setLinkedPingError] = useState<string | null>(null);
    const [showRemoveCarConfirm, setShowRemoveCarConfirm] = useState(false);
    const [removeCarLoading, setRemoveCarLoading] = useState(false);
    const [myCarPingSuccess, setMyCarPingSuccess] = useState<'leaving_now' | 'leaving_later' | 'already_shared' | null>(null);
    // Post-save offer: shown after saveMySpot() succeeds
    const [showPostSaveOffer, setShowPostSaveOffer] = useState(false);
    // Allows "Share when I leave" to open departure sheet directly at timePicker
    const departureSheetInitialViewRef = useRef<'prompt' | 'timePicker'>('prompt');
    // Tracks where the departure sheet was opened from, so back arrow knows where to return.
    const departureSheetOriginRef = useRef<'session' | 'post_save' | 'change_time' | 'prompt'>('prompt');

    // ?debugStreet=1 — in-app street intelligence debug panel (no-op for normal users)
    const isDebugMode = useMemo(() => new URLSearchParams(window.location.search).has('debugStreet'), []);
    const [isDebugAdmin, setIsDebugAdmin] = useState(false);
    useEffect(() => {
        if (!isDebugMode) return;
        auth.currentUser?.getIdTokenResult().then(token => {
            if (token.claims.role === 'admin') setIsDebugAdmin(true);
        }).catch(() => {});
    }, [isDebugMode]);
    const debugLinesRef = useRef<string[]>([]);
    const [debugLines, setDebugLines] = useState<string[]>([]);
    const [debugPanelOpen, setDebugPanelOpen] = useState(true);
    const dbg = useCallback((msg: string) => {
        if (!isDebugMode) return;
        const line = `${new Date().toLocaleTimeString()} ${msg}`;
        console.log('[StreetIntelDebug]', msg);
        debugLinesRef.current = [...debugLinesRef.current, line];
        setDebugLines([...debugLinesRef.current]);
    }, [isDebugMode]);

    const [manualLat, setManualLat] = useState('');
    const [manualLng, setManualLng] = useState('');
    const [cfManualLoading, setCfManualLoading] = useState(false);
    const testCFManual = useCallback(async () => {
        if (!isDebugMode) return;
        const lat = parseFloat(manualLat);
        const lng = parseFloat(manualLng);
        if (isNaN(lat) || isNaN(lng)) { dbg('Manual CF: invalid lat/lng'); return; }
        setCfManualLoading(true);
        dbg('--- DIRECT MANUAL CF TEST ---');
        try {
            const fn = httpsCallable(getFunctions(getApp(), 'us-central1'), 'createSegmentFromSweepNYC');
            const result = await fn({ lat, lng });
            const data = result.data as any;
            const hasDiag = data._diag != null;
            const d = data._diag ?? {};
            const dv = (v: any) => hasDiag ? (v == null ? 'null' : String(v)) : '?';
            dbg(`Manual CF result: success=${data.success} reason=${data.reason ?? 'none'}`);
            dbg(`  _diag: stage=${dv(d.stage)} geo=${dv(d.geometrySource)} segStatus=${dv(d.segmentStatus)} signs=${dv(d.signsCount)} parsed=${dv(d.parsedCount)} failures=${dv(d.parseFailureCount)}`);
        } catch (e: any) {
            dbg(`Manual CF failed: code=${e?.code ?? 'unknown'}`);
            console.warn('[StreetIntelDebug] Manual CF failed');
        } finally {
            setCfManualLoading(false);
            dbg('--- MANUAL CF TEST DONE ---');
        }
    }, [isDebugMode, manualLat, manualLng, dbg]);

    const [cfTestLoading, setCfTestLoading] = useState(false);
    const testCFDirect = useCallback(() => {
        if (!isDebugMode) return;
        setCfTestLoading(true);
        dbg('--- DIRECT CF TEST ---');
        void getCurrentPosition().then(async pos => {
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;
            dbg('CF test: received a position (coordinates omitted)');
            try {
                const fn = httpsCallable(getFunctions(getApp(), 'us-central1'), 'createSegmentFromSweepNYC');
                const result = await fn({ lat, lng });
                const data = result.data as any;
                dbg(`CF test result: success=${data?.success === true} reason=${data?.reason ?? 'none'}`);
            } catch (e: any) {
                dbg(`CF test failed: code=${e?.code ?? 'unknown'}`);
                console.warn('[StreetIntelDebug] CF test failed');
            } finally {
                setCfTestLoading(false);
                dbg('--- CF TEST DONE ---');
            }
        }).catch(err => {
            dbg(`CF test geolocation failed: ${err?.kind ?? 'failed'}`);
            setCfTestLoading(false);
        });
    }, [isDebugMode, dbg]);

    // Retry segmentId lookup once per session for legacy saved spots that have no streetIntelStatus.
    // Skip if a fresh lookup already ran (streetIntelStatus is set) — the UI should show that result.
    const segmentRetrySessionRef = useRef<string | null>(null);
    useEffect(() => {
        if (!showSessionSheet || !savedSpot) return;
        if (savedSpot.segmentId !== null) return;                // already have segment
        if (segmentRetrySessionRef.current === savedSpot.sessionId) return; // already retried this session
        // Skip for unavailable (SweepNYC returned real no-data) — retrying won't help.
        // Allow retry for failed (technical error) — one automatic retry per session.
        if (savedSpot.streetIntelStatus === 'unavailable') {
            console.log('[segmentRetry] skipped — streetIntelStatus=unavailable reason=' + (savedSpot.streetIntelReason ?? 'none'));
            return;
        }
        segmentRetrySessionRef.current = savedSpot.sessionId;
        // Use the saved spot's own coordinates — not current GPS — so retry targets the parked location
        const { lat, lng } = savedSpot;
        console.log('[segmentRetry] retrying saved location');
        (async () => {
            const match = await matchNearestSegment(lat, lng);
            if (!match.segmentId) { console.warn('[segmentRetry] retry also returned null, status:', match.streetIntelStatus); return; }
            console.log('[segmentRetry] retry succeeded');
            const updated = { ...savedSpot, ...match, streetIntelCheckedAt: new Date().toISOString() };
            setSavedSpot(updated);
            localStorage.setItem(SAVED_SPOT_KEY, JSON.stringify(updated));
        })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showSessionSheet, savedSpot?.sessionId]);

    // Live duration counter for active session
    useEffect(() => {
        if (!savedSpot) { setParkedDuration(''); return; }
        const update = () => {
            const mins = Math.floor((Date.now() - savedSpot.savedAt) / 60000);
            if (mins < 1) setParkedDuration(t('my_car.just_parked'));
            else if (mins < 60) setParkedDuration(mins === 1 ? t('my_car.duration_minute', { min: mins }) : t('my_car.duration_minutes', { min: mins }));
            else {
                const h = Math.floor(mins / 60);
                const m = mins % 60;
                setParkedDuration(m === 0 ? `${h}h` : `${h}h ${m}m`);
            }
        };
        update();
        const id = setInterval(update, 60000);
        return () => clearInterval(id);
    }, [savedSpot?.savedAt]);

    const matchNearestSegment = async (userLat: number, userLng: number) => {
        try {
            dbg('matchNearestSegment started');
            const radiusM = 80;
            const center: [number, number] = [userLat, userLng];
            const bounds = geofire.geohashQueryBounds(center, radiusM);
            dbg(`geohash bounds queried: ${bounds.length} ranges`);

            const snaps = await Promise.all(
                bounds.map(([start, end]) =>
                    getDocs(
                        query(
                            collection(db, 'streetSegments'),
                            orderBy('geohash'),
                            startAt(start),
                            endAt(end),
                        ),
                    ),
                ),
            );

            const allCandidates = snaps.flatMap(s =>
                s.docs.map(d => ({ id: d.id, ...(d.data() as any) }))
            );
            // Exclude archived segments so stale data doesn't block a fresh SweepNYC lookup
            const candidates = allCandidates.filter(
                (c: any) => !c.status || c.status === 'active' || c.status === 'needs_review'
            );
            console.log('[matchNearestSegment] candidate counts:', {
                total: allCandidates.length, active: candidates.length,
            });
            dbg(`raw candidates: ${allCandidates.length} | active: ${candidates.length}`);

            if (!candidates.length) {
                // No active Firestore segment — lazy-populate via CF (server-controlled write)
                console.log('[matchNearestSegment] no active segments — calling createSegmentFromSweepNYC');
                dbg('no active segments — calling createSegmentFromSweepNYC');
                try {
                    const fn = httpsCallable(getFunctions(getApp(), 'us-central1'), 'createSegmentFromSweepNYC');
                    const accuracyMeters = lastGpsAccuracyRef.current;
                    const result = await fn({
                        lat: userLat,
                        lng: userLng,
                        ...(typeof accuracyMeters === 'number' && Number.isFinite(accuracyMeters)
                            ? { accuracyMeters } : {}),
                    });
                    const data = result.data as { success: boolean; segmentId?: string; parkingSide?: string; streetName?: string; reason?: string; sideConfidence?: string };
                    console.log('[matchNearestSegment] CF result:', { success: data.success, reason: data.reason ?? 'none' });
                    dbg(`CF result: success=${data.success} reason=${data.reason ?? 'none'}`);
                    if (!data.success || !data.segmentId) {
                        const status = cfReasonToIntelStatus(data.reason);
                        console.warn('[SweepNYC] lookup failed:', data.reason ?? 'unknown');
                        return { segmentId: null, parkingSide: null, restrictionVersionId: null, segmentStreetName: null, streetIntelStatus: status, streetIntelReason: data.reason ?? null };
                    }
                    return {
                        segmentId: data.segmentId,
                        parkingSide: data.parkingSide ?? null,
                        sideConfidence: data.sideConfidence === 'high' ? 'high' as const : undefined,
                        restrictionVersionId: null,
                        segmentStreetName: data.streetName ?? null,
                        streetIntelStatus: 'found' as const,
                        streetIntelReason: null,
                    };
                } catch (e: any) {
                    console.warn('[SweepNYC] cloud function failed:', e?.code ?? 'unknown');
                    dbg(`CF failed: code=${e?.code ?? 'unknown'}`);
                    return { segmentId: null, parkingSide: null, restrictionVersionId: null, segmentStreetName: null, streetIntelStatus: 'failed' as const, streetIntelReason: e?.code ?? 'cf_error' };
                }
            }

            const withDist = candidates.map((seg: any) => ({
                ...seg,
                dist: geofire.distanceBetween([userLat, userLng], [seg.centerLat, seg.centerLng]),
            }));
            withDist.sort((a: any, b: any) => a.dist - b.dist);
            const nearest = withDist[0];
            dbg(`selected nearest candidate: status=${nearest.status ?? 'none'}`);

            if (isLegacyNYCOpenDataSegment(nearest)) {
                // Rows written before block-face evidence existed must not be
                // promoted from their old conservative stamp. Ask the server to
                // re-run the authoritative selector/parser for this exact row.
                // Any failure falls through to the existing caution data below.
                try {
                    const fn = httpsCallable(getFunctions(getApp(), 'us-central1'), 'createSegmentFromSweepNYC');
                    const accuracyMeters = lastGpsAccuracyRef.current;
                    const result = await fn({
                        lat: userLat,
                        lng: userLng,
                        revalidateSegmentId: nearest.id,
                        ...(typeof accuracyMeters === 'number' && Number.isFinite(accuracyMeters)
                            ? { accuracyMeters } : {}),
                    });
                    const data = result.data as { success: boolean; segmentId?: string; parkingSide?: string; streetName?: string; reason?: string; sideConfidence?: string };
                    if (data.success && data.segmentId) {
                        return {
                            segmentId: data.segmentId,
                            parkingSide: data.parkingSide ?? null,
                            sideConfidence: data.sideConfidence === 'high' ? 'high' as const : undefined,
                            restrictionVersionId: null,
                            segmentStreetName: data.streetName ?? nearest.streetName ?? null,
                            streetIntelStatus: 'found' as const,
                            streetIntelReason: null,
                        };
                    }
                    console.warn('[Street Intelligence] legacy revalidation retained the existing caution row:', data.reason ?? 'unknown');
                } catch (e: any) {
                    console.warn('[Street Intelligence] legacy revalidation unavailable; retaining existing caution row:', e?.code ?? 'unknown');
                }
            }

            const rulesSnap = await getDocs(
                query(
                    collection(db, 'streetSegments', nearest.id, 'streetRules'),
                    where('supersededAt', '==', null),
                ),
            );
            const restrictionVersionId = rulesSnap.docs[0]?.id || null;
            dbg(`streetRules count: ${rulesSnap.docs.length}`);
            const nearbyRules = rulesSnap.docs.map(d => d.data());
            const usableCount = countUsableStreetIntelligence(nearbyRules);
            const alreadyAttemptedEmptyRefresh = emptyRulesRefreshAttemptedRef.current.has(nearest.id);
            if (shouldCallEmptyCacheRefresh(usableCount, alreadyAttemptedEmptyRefresh)) {
                emptyRulesRefreshAttemptedRef.current.add(nearest.id);
                logStreetIntelEvent('cache_hit_empty_refresh', { via: 'nearby_80m', usableCount });
                try {
                    const fn = httpsCallable(getFunctions(getApp(), 'us-central1'), 'createSegmentFromSweepNYC');
                    const accuracyMeters = lastGpsAccuracyRef.current;
                    const result = await fn({
                        lat: userLat,
                        lng: userLng,
                        ...(typeof accuracyMeters === 'number' && Number.isFinite(accuracyMeters)
                            ? { accuracyMeters } : {}),
                    });
                    const data = result.data as { success: boolean; segmentId?: string; parkingSide?: string; streetName?: string; reason?: string; sideConfidence?: string };
                    if (data.success && data.segmentId) {
                        return {
                            segmentId: data.segmentId,
                            parkingSide: data.parkingSide ?? null,
                            sideConfidence: data.sideConfidence === 'high' ? 'high' as const : undefined,
                            restrictionVersionId: null,
                            segmentStreetName: data.streetName ?? nearest.streetName ?? null,
                            streetIntelStatus: 'found' as const,
                            streetIntelReason: null,
                        };
                    }
                    console.warn('[Street Intelligence] empty-rules refresh retained the nearby row:', data.reason ?? 'unknown');
                } catch (e: any) {
                    console.warn('[Street Intelligence] empty-rules refresh unavailable; retaining nearby row:', e?.code ?? 'unknown');
                }
            } else if (shouldCallRestrictionMigrationRefresh(
                usableCount,
                hasRestrictionEvaluation(nearbyRules),
                restrictionRefreshAttemptedRef.current.has(nearest.id),
            )) {
                restrictionRefreshAttemptedRef.current.add(nearest.id);
                logStreetIntelEvent('cache_hit_restriction_refresh', { via: 'nearby_80m', usableCount });
                try {
                    const fn = httpsCallable(getFunctions(getApp(), 'us-central1'), 'createSegmentFromSweepNYC');
                    const accuracyMeters = lastGpsAccuracyRef.current;
                    const result = await fn({
                        lat: userLat,
                        lng: userLng,
                        ...(typeof accuracyMeters === 'number' && Number.isFinite(accuracyMeters)
                            ? { accuracyMeters } : {}),
                    });
                    const data = result.data as { success: boolean; segmentId?: string; parkingSide?: string; streetName?: string; reason?: string; sideConfidence?: string };
                    if (data.success && data.segmentId) {
                        return {
                            segmentId: data.segmentId,
                            parkingSide: data.parkingSide ?? null,
                            sideConfidence: data.sideConfidence === 'high' ? 'high' as const : undefined,
                            restrictionVersionId: null,
                            segmentStreetName: data.streetName ?? nearest.streetName ?? null,
                            streetIntelStatus: 'found' as const,
                            streetIntelReason: null,
                        };
                    }
                    console.warn('[Street Intelligence] restriction migration retained the nearby row:', data.reason ?? 'unknown');
                } catch (e: any) {
                    console.warn('[Street Intelligence] restriction migration unavailable; retaining nearby row:', e?.code ?? 'unknown');
                }
            } else if (usableCount > 0) {
                logStreetIntelEvent('cache_hit_usable', { via: 'nearby_80m', usableCount });
            } else {
                logStreetIntelEvent('cache_hit_empty_no_retry', { via: 'nearby_80m', usableCount });
            }
            if (rulesSnap.docs.length === 0) {
                dbg('⚠️ Existing segment found but no streetRules detected.');
                console.warn('[StreetIntelDebug] Existing segment found but no streetRules detected');
            }

            let parkingSide = nearest.source === 'sweepnyc'
                ? detectCardinalSide(userLat, userLng, nearest.fromLat, nearest.fromLng, nearest.toLat, nearest.toLng, nearest.bearing ?? 90)
                : detectParkingSide(userLat, userLng, nearest.fromLat, nearest.fromLng, nearest.toLat, nearest.toLng, nearest.evenSideIsPositiveCross ?? true);
            let sideConfidence: SavedSpot['sideConfidence'] | undefined;
            const scheduleSides = [...new Set(
                rulesSnap.docs.flatMap(d => ((d.data() as any).schedules || []))
                    .map((s: any) => s?.side)
                    .filter(Boolean),
            )];
            if (nearest.source === 'sweepnyc' && scheduleSides.length > 1) {
                try {
                    const fn = httpsCallable(getFunctions(getApp(), 'us-central1'), 'createSegmentFromSweepNYC');
                    const accuracyMeters = lastGpsAccuracyRef.current;
                    const result = await fn({
                        lat: userLat,
                        lng: userLng,
                        ...(typeof accuracyMeters === 'number' && Number.isFinite(accuracyMeters)
                            ? { accuracyMeters } : {}),
                    });
                    const data = result.data as { success?: boolean; parkingSide?: string; sideConfidence?: string };
                    if (data.success && data.sideConfidence === 'high' && data.parkingSide) {
                        parkingSide = data.parkingSide;
                        sideConfidence = 'high';
                    }
                } catch (e: any) {
                    console.warn('[Street Intelligence] curb side resolution unavailable; keeping manual side confirmation:', e?.code ?? 'unknown');
                }
            }

            return {
                segmentId: nearest.id as string,
                parkingSide,
                sideConfidence,
                restrictionVersionId,
                segmentStreetName: nearest.streetName as string,
                streetIntelStatus: 'found' as const,
                streetIntelReason: null,
            };
        } catch (e) {
            dbg('matchNearestSegment failed');
            console.warn('Segment match failed');
            return { segmentId: null, parkingSide: null, restrictionVersionId: null, segmentStreetName: null, streetIntelStatus: 'failed' as const, streetIntelReason: 'match_error' };
        }
    };

    const [simSaveLoading, setSimSaveLoading] = useState(false);
    const simulateMyCarSave = async () => {
        if (!isDebugMode) return;
        const lat = parseFloat(manualLat);
        const lng = parseFloat(manualLng);
        if (isNaN(lat) || isNaN(lng)) { dbg('Simulate save: invalid lat/lng'); return; }
        setSimSaveLoading(true);
        dbg('--- SIMULATED MY CAR SAVE ---');
        try {
            const match = await matchNearestSegment(lat, lng);
            dbg(`match: status=${match.streetIntelStatus} reason=${match.streetIntelReason ?? 'none'}`);
            const spot: SavedSpot = {
                lat, lng,
                address: `${lat.toFixed(5)}, ${lng.toFixed(5)} (simulated)`,
                savedAt: Date.now(),
                sessionId: crypto.randomUUID(),
                linkedPingId: null,
                segmentId: match.segmentId,
                parkingSide: match.parkingSide,
                restrictionVersionId: match.restrictionVersionId,
                segmentStreetName: match.segmentStreetName,
                streetIntelStatus: match.streetIntelStatus,
                streetIntelReason: match.streetIntelReason,
                streetIntelCheckedAt: new Date().toISOString(),
                gpsAccuracyMeters: null,
                sideConfidence: 'unknown',
                confirmedParkingSide: null,
            };
            localStorage.setItem(SAVED_SPOT_KEY, JSON.stringify(spot));
            setSavedSpot(spot);
            setShowSessionSheet(true);
            const willRenderCard = !!(spot.segmentId && spot.segmentStreetName);
            const willRenderUnavailable = !willRenderCard && (spot.streetIntelStatus === 'unavailable' || spot.streetIntelStatus === 'failed');
            dbg('savedSpot set');
            dbg(`  streetIntelStatus=${spot.streetIntelStatus} streetIntelReason=${spot.streetIntelReason ?? 'null'}`);
            dbg(`  StreetIntelligenceCard renders: ${willRenderCard} | unavailable card renders: ${willRenderUnavailable}`);
        } catch (e: any) {
            dbg('Simulate save failed');
        } finally {
            setSimSaveLoading(false);
            dbg('--- SIMULATED MY CAR SAVE DONE ---');
        }
    };

    const saveMySpot = async () => {
        if (!userLocation) return;
        const [lng, lat] = userLocation;
        dbg('saveMySpot started');
        const [address, segmentMatch] = await Promise.all([
            reverseGeocode(lng, lat),
            matchNearestSegment(lat, lng),
        ]);
        const gpsAccuracyMeters = lastGpsAccuracyRef.current ?? null;
        const sideConfidence: SavedSpot['sideConfidence'] = segmentMatch.sideConfidence === 'high' && segmentMatch.parkingSide
            ? 'high'
            : !segmentMatch.parkingSide ? 'unknown'
            : (gpsAccuracyMeters === null || gpsAccuracyMeters > 30) ? 'low'
            : 'high';
        dbg(`segmentMatch: status=${segmentMatch.streetIntelStatus} sideConfidence=${sideConfidence}`);
        const spot: SavedSpot = {
            lat,
            lng,
            address,
            savedAt: Date.now(),
            sessionId: crypto.randomUUID(),
            linkedPingId: null,
            segmentId: segmentMatch.segmentId,
            parkingSide: segmentMatch.parkingSide,
            restrictionVersionId: segmentMatch.restrictionVersionId,
            segmentStreetName: segmentMatch.segmentStreetName,
            streetIntelStatus: segmentMatch.streetIntelStatus,
            streetIntelReason: segmentMatch.streetIntelReason,
            streetIntelCheckedAt: new Date().toISOString(),
            gpsAccuracyMeters,
            sideConfidence,
            confirmedParkingSide: null,
        };
        const cardCondition = !!(spot.segmentId && spot.segmentStreetName);
        dbg(`StreetIntelligenceCard will render: ${cardCondition} status=${spot.streetIntelStatus}`);
        localStorage.setItem(SAVED_SPOT_KEY, JSON.stringify(spot));
        setSavedSpot(spot);
        setShowPostSaveOffer(true);
    };

    // Used after handoff — skips GPS, uses the already-known claimed Ping coordinates
    const saveMySpotFromCoords = async (lat: number, lng: number, address: string) => {
        const segmentMatch = await matchNearestSegment(lat, lng);
        const sideConfidence: SavedSpot['sideConfidence'] = segmentMatch.sideConfidence === 'high' && segmentMatch.parkingSide
            ? 'high'
            : 'low';
        const spot: SavedSpot = {
            lat, lng, address,
            savedAt: Date.now(),
            sessionId: crypto.randomUUID(),
            linkedPingId: null,
            segmentId: segmentMatch.segmentId,
            parkingSide: segmentMatch.parkingSide,
            restrictionVersionId: segmentMatch.restrictionVersionId,
            segmentStreetName: segmentMatch.segmentStreetName,
            streetIntelStatus: segmentMatch.streetIntelStatus,
            streetIntelReason: segmentMatch.streetIntelReason,
            streetIntelCheckedAt: new Date().toISOString(),
            gpsAccuracyMeters: null,
            sideConfidence,
            confirmedParkingSide: null,
        };
        localStorage.setItem(SAVED_SPOT_KEY, JSON.stringify(spot));
        setSavedSpot(spot);
        setShowSessionSheet(true);
    };

    const handleConfirmSide = useCallback((side: string) => {
        if (!savedSpot) return;
        const updated = { ...savedSpot, confirmedParkingSide: side };
        setSavedSpot(updated);
        localStorage.setItem(SAVED_SPOT_KEY, JSON.stringify(updated));
    }, [savedSpot]);

    const [retryingStreetIntel, setRetryingStreetIntel] = useState(false);
    const handleRetryStreetIntel = useCallback(async () => {
        if (!savedSpot || retryingStreetIntel) return;
        setRetryingStreetIntel(true);
        try {
            const match = await matchNearestSegment(savedSpot.lat, savedSpot.lng);
            const gpsAccuracyMeters = lastGpsAccuracyRef.current ?? null;
            const sideConfidence: SavedSpot['sideConfidence'] = match.sideConfidence === 'high' && match.parkingSide
                ? 'high'
                : !match.parkingSide ? 'unknown'
                : (gpsAccuracyMeters === null || gpsAccuracyMeters > 30) ? 'low'
                : 'high';
            const updated: SavedSpot = {
                ...savedSpot, ...match,
                streetIntelCheckedAt: new Date().toISOString(),
                gpsAccuracyMeters,
                sideConfidence,
                confirmedParkingSide: null,
            };
            setSavedSpot(updated);
            localStorage.setItem(SAVED_SPOT_KEY, JSON.stringify(updated));
        } finally {
            setRetryingStreetIntel(false);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [savedSpot, retryingStreetIntel]);

    const writeCleaningReminder = async (safeUntil: Date | null, enabled: boolean, streetName: string | null) => {
        if (!safeUntil || !enabled || !auth.currentUser || !streetName) return;
        const uid = auth.currentUser.uid;
        try {
            const userSnap = await getDoc(doc(db, 'users', uid, 'private', 'preferences'));
            const fcmToken = userSnap.data()?.fcmToken;
            if (!fcmToken) return;
            const reminderMinutesBefore = 60;
            const reminderAt = new Date(safeUntil.getTime() - reminderMinutesBefore * 60 * 1000);
            await setDoc(doc(db, 'parkingSessions', uid), {
                userId: uid,
                fcmToken,
                streetName,
                nextCleaningAt: Timestamp.fromDate(safeUntil),
                reminderAt: Timestamp.fromDate(reminderAt),
                reminderMinutesBefore,
                reminderEnabled: true,
                reminderSent: false,
                active: true,
                savedAt: Timestamp.now(),
            });
        } catch (e) {
            console.warn('Could not write cleaning reminder:', (e as any)?.code ?? 'unknown');
        }
    };

    const endSession = () => {
        localStorage.removeItem(SAVED_SPOT_KEY);
        if (auth.currentUser) {
            setDoc(doc(db, 'parkingSessions', auth.currentUser.uid), { active: false }, { merge: true }).catch(() => {});
        }
        setSavedSpot(null);
        parkingTimer.clearTimer();
        setShowSessionSheet(false);
        setShowDepartureSheet(false);
        setShowCustomReminder(false);
        setReminderHour('');
        setReminderMinute('');
        setReminderAmPm(new Date().getHours() < 12 ? 'AM' : 'PM');
        if (lastParkedMarkerRef.current) {
            lastParkedMarkerRef.current.remove();
            lastParkedMarkerRef.current = null;
        }
        activeRouteDestinationRef.current = null;
        if (mapRef.current) clearRoute(mapRef.current);
    };

    // Proximity check — are we back at the car?
    const isNearSavedSpot = savedSpot && userLocation
        ? getDistance(userLocation[1], userLocation[0], savedSpot.lat, savedSpot.lng) < 0.05
        : false;

    const myCarDistanceLabel = useMemo(() => {
        if (!savedSpot || !userLocation) return null;
        const km = getDistance(userLocation[1], userLocation[0], savedSpot.lat, savedSpot.lng);
        if (km < 0.02) return "You're here";
        if (km < 0.5) return `${Math.round(km * 3280.84)} ft away`;
        return `${(km * 0.621371).toFixed(1)} mi away`;
    }, [userLocation, savedSpot]);

    const otherSpots = currentItems.filter(s => s.finderId !== user?.id);
    const spotCount = otherSpots.length;

    const [pillToast, setPillToast] = useState<string | null>(null);
    useEffect(() => {
        if (!pillToast) return;
        const id = setTimeout(() => setPillToast(null), 3000);
        return () => clearTimeout(id);
    }, [pillToast]);

    const [nearbyPillSheet, setNearbyPillSheet] = useState(false);

    const handleNearbyPillClick = useCallback(() => {
        const spots = currentItems.filter(s => s.finderId !== user?.id);
        if (spots.length === 0) {
            setPillToast(t('map.no_spots_available_now'));
            return;
        }
        const origin: [number, number] = userLocation ?? (() => {
            const c = mapRef.current?.getCenter();
            return c ? [c.lng, c.lat] : null;
        })() ?? [spots[0].lng, spots[0].lat];
        const dist = (s: typeof spots[0]) => getDistance(origin[1], origin[0], s.lat, s.lng);
        const isScheduled = (s: typeof spots[0]) => getPingPhase(s, nowMs) === 'scheduled';
        const sorted = [...spots].sort((a, b) => {
            const sa = isScheduled(a) ? 1 : 0;
            const sb = isScheduled(b) ? 1 : 0;
            if (sa !== sb) return sa - sb;
            return dist(a) - dist(b);
        });
        if (sorted.length === 1) {
            mapRef.current?.flyTo({ center: [sorted[0].lng, sorted[0].lat], zoom: 17, duration: 800 });
            setSelectedItem(sorted[0]);
        } else {
            setSelectedItem(null);
            setNearbyPillSheet(true);
            setStackGroup(sorted);
        }
    }, [currentItems, user?.id, userLocation, nowMs]);



    // Reset remove-car confirmation state whenever the session sheet closes
    useEffect(() => {
        if (!showSessionSheet) { setShowRemoveCarConfirm(false); setRemoveCarLoading(false); }
    }, [showSessionSheet]);

    // --- Remaining effects ---

    // Clear route when deselecting
    useEffect(() => {
        if (!selectedItem) {
            activeRouteDestinationRef.current = null;
            if (mapRef.current) clearRoute(mapRef.current);
        }
    }, [selectedItem]);

    // Defensive: clear My Car route if saved spot is removed by any path
    useEffect(() => {
        if (!savedSpot) {
            activeRouteDestinationRef.current = null;
            if (mapRef.current) clearRoute(mapRef.current);
        }
    }, [savedSpot]);

    // Sync selectedItem from live Firestore updates
    useEffect(() => {
        if (!selectedItem) return;
        const updatedFree = spotData.freeSpots.find(s => s.id === selectedItem.id);
        if (updatedFree) {
            if (updatedFree !== selectedItem) {
                setSelectedItem(updatedFree);
            }
            return;
        }
        const updatedPaid = spotData.paidListings.find(s => s.id === selectedItem.id);
        if (updatedPaid) {
            if (updatedPaid !== selectedItem) {
                setSelectedItem(updatedPaid);
            }
            return;
        }
        // Spot no longer in any data source (occupied/expired/deleted) — clear selection
        if (!interestFlow.handoffStep) {
            setSelectedItem(null);
        }
    }, [spotData.freeSpots, spotData.paidListings, selectedItem?.id]);

    // Get initial GPS fix, then create map centered on real location
    useEffect(() => {
        if (!mapContainerRef.current) return;
        const mapboxToken = getMapboxToken();
        mapboxgl.accessToken = mapboxToken;

        let cancelled = false;
        let watchHandle: LocationWatchHandle | undefined;
        let ro: ResizeObserver | undefined;

        const initMap = (center: [number, number]) => {
            if (cancelled || mapRef.current) return;
            const isDark = document.documentElement.classList.contains('dark');
            const map = new mapboxgl.Map({ container: mapContainerRef.current!, style: `mapbox://styles/mapbox/${isDark ? 'dark' : 'light'}-v11`, center, zoom: 16, attributionControl: false, interactive: true });
            mapRef.current = map;
            setSearchCenter(center);
            setMapReady(true);

            map.on('load', () => { map.resize(); });

            // The light basemap ships very pale label text (hsl(220,1%,49%)) that
            // reads as washed out over the map. Darken it in light mode only; dark
            // mode keeps the style's own colors. Applied on 'styledata' rather than
            // 'load' because the style's layers are not queryable yet at 'load' —
            // setPaintProperty there silently no-ops. Idempotent, and guarded on
            // getLayer so a hosted-style change just leaves the default labels.
            if (!isDark) {
                const applyLightLabelContrast = () => {
                    if (!map.getLayer('road-label-simple')) return;
                    map.setPaintProperty('road-label-simple', 'text-color', '#42505f');
                    map.setPaintProperty('road-label-simple', 'text-halo-color', '#ffffff');
                    map.setPaintProperty('road-label-simple', 'text-halo-width', 1.2);
                    ['settlement-subdivision-label', 'settlement-minor-label', 'poi-label']
                        .forEach(id => { if (map.getLayer(id)) map.setPaintProperty(id, 'text-color', '#55606e'); });
                    map.off('styledata', applyLightLabelContrast);
                };
                map.on('styledata', applyLightLabelContrast);
            }

            // ResizeObserver keeps the Mapbox canvas in sync with the wrapper whenever
            // the viewport changes (mobile chrome show/hide, orientation change, etc.).
            ro = new ResizeObserver(() => { map.resize(); });
            ro.observe(mapContainerRef.current!);

            const updateViewportRadius = () => {
                const b = map.getBounds();
                const ne = b.getNorthEast();
                const sw = b.getSouthWest();
                const halfDiagMiles = getDistance(ne.lat, ne.lng, sw.lat, sw.lng) * 0.621371 / 2;
                setMapFilterRadiusMiles(Math.min(10, Math.max(2, Math.round(halfDiagMiles * 10) / 10)));
            };

            updateViewportRadius();

            let moveEndTimeout: ReturnType<typeof setTimeout> | undefined;
            map.on('moveend', () => {
                if (moveEndTimeout) clearTimeout(moveEndTimeout);
                moveEndTimeout = setTimeout(() => {
                    const c = map.getCenter();
                    setSearchCenter([c.lng, c.lat]);
                    updateViewportRadius();
                }, 400);
            });
        };

        // Try to get location first, fall back to NYC after 5s
        const fallbackTimer = setTimeout(() => {
            if (!mapRef.current) initMap(NYC_CENTER);
        }, 5000);

        if (allowLocationTrackingRef.current && isGeolocationAvailable()) {
            watchHandle = watchPosition(
                (position) => {
                    const { longitude, latitude, accuracy } = position.coords;
                    lastGpsAccuracyRef.current = accuracy ?? null;
                    const newLocation: [number, number] = [longitude, latitude];
                    setUserLocation(newLocation);

                    if (!mapRef.current) {
                        clearTimeout(fallbackTimer);
                        initMap(newLocation);
                    } else {
                        if (activeRouteDestinationRef.current) {
                            drawRoute(mapRef.current, newLocation, activeRouteDestinationRef.current);
                        }
                    }

                    try {
                        const newGeohash = geofire.geohashForLocation([latitude, longitude]);
                        void userLocationGeohashPersisterRef.current.persist({
                            trackingAllowed: allowLocationTrackingRef.current,
                            authUid: auth.currentUser?.uid ?? null,
                            ownerUid: userRef.current?.id ?? null,
                            geohash: newGeohash,
                        }).catch(e => console.warn('Failed to persist lastGeohash:', (e as any)?.code ?? 'unknown'));
                    } catch (err) {
                        console.error("Geohash generation failed:", (err as any)?.name ?? 'unknown');
                    }
                },
                () => {
                    clearTimeout(fallbackTimer);
                    if (!mapRef.current) initMap(NYC_CENTER);
                },
                { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
            );
        } else {
            clearTimeout(fallbackTimer);
            initMap(NYC_CENTER);
        }

        return () => {
            cancelled = true;
            clearTimeout(fallbackTimer);
            watchHandle?.clear();
            ro?.disconnect();
            if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
        };
    }, []);

    // Marker rendering — community spots get premium stack grouping; paid/public render individually
    // Keep the ref in sync for all cases OTHER than handleMyCarPing (which sets it
    // synchronously). Runs before the marker effect because it appears first in source order.
    useEffect(() => {
        linkedPingIdRef.current = savedSpot?.linkedPingId ?? null;
    }, [savedSpot?.linkedPingId]);

    useEffect(() => {
        if (!mapRef.current) return;
        const map = mapRef.current;

        Object.values(allMarkersRef.current).forEach(m => m.remove());
        allMarkersRef.current = {};

        // Exclude only the My Car session's linked ping (shown separately in the session sheet).
        // Own manual pings remain visible so the creator sees their own marker on the map.
        const allItems = currentItems.filter(
            item => item.id !== (linkedPingIdRef.current ?? '')
        );

        // Split: community shared spots vs. paid/public (rendered individually, no stacking)
        const communityItems = allItems.filter(item => item.type === 'free');
        const otherItems = allItems.filter(item => item.type !== 'free');

        // --- Community spots: group within 30m, stack marker for groups > 1 ---
        const assigned = new Set<string>();
        for (const item of communityItems) {
            if (assigned.has(item.id)) continue;

            const group: MapItem[] = [item];
            assigned.add(item.id);
            for (const other of communityItems) {
                if (assigned.has(other.id)) continue;
                if (getDistance(item.lat, item.lng, other.lat, other.lng) < 0.03) {
                    group.push(other);
                    assigned.add(other.id);
                }
            }

            if (group.length === 1) {
                const reportedMs = timestampToMillis(item.reportedAt);
                const isScheduled = getPingPhase(item, nowMs) === 'scheduled';
                const el = createMarkerElement(isScheduled, reportedMs);
                const lngLat: [number, number] = [item.lng, item.lat];
                const marker = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
                    .setLngLat(lngLat).addTo(map);
                marker.getElement().addEventListener('click', (e) => {
                    e.stopPropagation();
                    const fresh = itemsRef.current.find(i => i.id === item.id) || item;
                    setSpotDetailsBackStack(null);
                    setSelectedItem(fresh);
                    map.flyTo({ center: lngLat, zoom: 16 });
                });
                allMarkersRef.current[item.id] = marker;
            } else {
                // Centroid placement — average lat/lng of the group (explicit Number() guards against string coercion)
                const centroidLat = group.reduce((s, i) => s + Number(i.lat), 0) / group.length;
                const centroidLng = group.reduce((s, i) => s + Number(i.lng), 0) / group.length;
                const centroid: [number, number] = [centroidLng, centroidLat];

                const hasAvailableNow = group.some(i => {
                    return getPingPhase(i, nowMs) === 'live';
                });

                const el = createStackMarkerElement(group.length, hasAvailableNow);
                const marker = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
                    .setLngLat(centroid).addTo(map);
                marker.getElement().addEventListener('click', (e) => {
                    e.stopPropagation();
                    setStackGroup(group);
                });
                allMarkersRef.current[item.id] = marker;
            }
        }

        // --- Paid/public items: individual markers, no stacking ---
        for (const item of otherItems) {
            const reportedMs = timestampToMillis(item.reportedAt);
            const isScheduled = getPingPhase(item, nowMs) === 'scheduled';
            const el = createMarkerElement(isScheduled, reportedMs);
            const lngLat: [number, number] = [item.lng, item.lat];
            const marker = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
                .setLngLat(lngLat).addTo(map);
            marker.getElement().addEventListener('click', (e) => {
                e.stopPropagation();
                const fresh = itemsRef.current.find(i => i.id === item.id) || item;
                setSpotDetailsBackStack(null);
                setSelectedItem(fresh);
                map.flyTo({ center: lngLat, zoom: 16 });
            });
            allMarkersRef.current[item.id] = marker;
        }
    }, [currentItems, savedSpot?.linkedPingId, nowMs]);

    // Last parked location marker
    useEffect(() => {
        if (!mapRef.current || !mapReady) return;
        if (lastParkedMarkerRef.current) {
            lastParkedMarkerRef.current.remove();
            lastParkedMarkerRef.current = null;
        }
        const loc = savedSpot;
        if (!loc?.lat || !loc?.lng) return;

        const el = document.createElement('div');
        el.className = 'pq-mycar-map-marker';
        el.setAttribute('role', 'img');
        el.setAttribute('aria-label', loc.address || t('my_car.last_parked_here'));
        el.innerHTML = `
            <span class="pq-mycar-map-marker-halo" aria-hidden="true"></span>
            <svg class="pq-mycar-map-marker-svg" viewBox="0 0 48 62" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
              <defs>
                <linearGradient id="pqMycarPinBody" x1="24" y1="4" x2="24" y2="48" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stop-color="#5aa8ff"/>
                  <stop offset="48%" stop-color="#2f7fff"/>
                  <stop offset="100%" stop-color="#1659d8"/>
                </linearGradient>
                <linearGradient id="pqMycarPinSheen" x1="14" y1="6" x2="34" y2="34" gradientUnits="userSpaceOnUse">
                  <stop offset="0%" stop-color="#ffffff" stop-opacity="0.38"/>
                  <stop offset="55%" stop-color="#ffffff" stop-opacity="0.06"/>
                  <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
                </linearGradient>
                <filter id="pqMycarPinSoft" x="-40%" y="-40%" width="180%" height="180%">
                  <feDropShadow dx="0" dy="4" stdDeviation="3.5" flood-color="#1e75ff" flood-opacity="0.45"/>
                </filter>
              </defs>
              <!-- unified pin + tip -->
              <path filter="url(#pqMycarPinSoft)" fill="url(#pqMycarPinBody)" d="M24 3.5c-9.2 0-16.6 7.4-16.6 16.5 0 11.8 14.2 28.2 15.8 30 0.4 0.45 1.2 0.45 1.6 0 1.6-1.8 15.8-18.2 15.8-30C40.6 10.9 33.2 3.5 24 3.5z"/>
              <path fill="url(#pqMycarPinSheen)" d="M24 3.5c-9.2 0-16.6 7.4-16.6 16.5 0 11.8 14.2 28.2 15.8 30 0.4 0.45 1.2 0.45 1.6 0 1.6-1.8 15.8-18.2 15.8-30C40.6 10.9 33.2 3.5 24 3.5z" opacity="0.9"/>
              <circle cx="24" cy="20" r="10.2" fill="rgba(6,18,40,0.28)" stroke="rgba(210,235,255,0.28)" stroke-width="1"/>
              <!-- car glyph -->
              <g fill="none" stroke="#eaf6ff" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
                <path d="M15.6 22.2h16.8l-1.4-4.1c-0.3-0.9-1.1-1.5-2.1-1.5H19.1c-0.9 0-1.8 0.6-2.1 1.5l-1.4 4.1z"/>
                <path d="M14.4 22.2h19.2v3.4c0 0.7-0.6 1.3-1.3 1.3h-1.1c-0.5 0-0.9-0.3-1.1-0.7l-0.2-0.5H18.1l-0.2 0.5c-0.2 0.4-0.6 0.7-1.1 0.7h-1.1c-0.7 0-1.3-0.6-1.3-1.3v-3.4z" fill="rgba(234,246,255,0.12)"/>
                <circle cx="18.2" cy="26.8" r="1.15" fill="#eaf6ff" stroke="none"/>
                <circle cx="29.8" cy="26.8" r="1.15" fill="#eaf6ff" stroke="none"/>
              </g>
              <!-- ground anchor -->
              <ellipse cx="24" cy="57.2" rx="5.2" ry="2.1" fill="rgba(30,117,255,0.35)"/>
              <ellipse cx="24" cy="57.2" rx="2.4" ry="1.05" fill="rgba(210,235,255,0.85)"/>
            </svg>
        `;
        el.title = loc.address || t('my_car.last_parked_here');

        const marker = new mapboxgl.Marker({ element: el, anchor: 'bottom' })
            .setLngLat([loc.lng, loc.lat])
            .addTo(mapRef.current);

        // Ensure wrapper sits above user location dot (z-index 5) — defer so DOM is ready
        setTimeout(() => {
            const wrapper = marker.getElement().parentElement;
            if (wrapper) wrapper.style.zIndex = '10';
        }, 0);

        el.addEventListener('click', (e) => {
            e.stopPropagation();
            mapRef.current?.flyTo({ center: [loc.lng, loc.lat], zoom: 16 });
            parkedSheetSetterRef.current?.();
        });

        lastParkedMarkerRef.current = marker;
    }, [savedSpot?.savedAt, mapReady]);

    // Spot address resolution
    useEffect(() => {
        const spot = selectedItem || (spotData.freeSpots.length > 0 ? spotData.freeSpots[0] : null);
        const coords = spot
            ? { lng: spot.lng, lat: spot.lat, title: spot.title, address: spot.address }
            : userLocation ? { lng: userLocation[0], lat: userLocation[1], title: null, address: null } : null;
        if (!coords) { setSpotAddress(""); return; }
        if (coords.title) { setSpotAddress(coords.title); return; }
        if (coords.address) { setSpotAddress(coords.address); return; }
        const mapboxToken = getMapboxToken();

        setSpotAddress(t('my_car.resolving_address'));
        fetch(`https://api.mapbox.com/geocoding/v5/mapbox.places/${coords.lng},${coords.lat}.json?types=address&access_token=${mapboxToken}&limit=1`)
            .then(res => res.json())
            .then(data => {
                if (data.features && data.features.length > 0) {
                    setSpotAddress(data.features[0].place_name.split(',')[0]);
                } else {
                    setSpotAddress(`Coordinates: ${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)}`);
                }
            })
            .catch(() => { setSpotAddress(t('my_car.street_spot')); });
    }, [selectedItem, spotData.freeSpots, userLocation]);

    // User location marker
    useEffect(() => {
        if (userMarkerRef.current) userMarkerRef.current.remove();
        if (mapRef.current && userLocation) {
            const el = document.createElement('div');
            el.style.zIndex = '5';
            el.innerHTML = `<div class="relative flex items-center justify-center"><div class="absolute w-6 h-6 bg-blue-500/20 rounded-full"></div><div class="w-3.5 h-3.5 bg-blue-500 rounded-full border-2 border-white shadow-md"></div></div>`;
            userMarkerRef.current = new mapboxgl.Marker(el).setLngLat(userLocation).addTo(mapRef.current);
        }
    }, [userLocation]);

    useEffect(() => {
        if (!pingError) return;
        const t = setTimeout(() => setPingError(null), 4000);
        return () => clearTimeout(t);
    }, [pingError]);

    // Reset My Car departure sub-state each time the sheet opens.
    // If the session already has a linked ping, show "already shared" immediately.
    // departureSheetInitialViewRef lets callers (e.g. post-save offer) open directly to timePicker.
    useEffect(() => {
        if (showDepartureSheet) {
            setMyCarDepartureView(departureSheetInitialViewRef.current);
            departureSheetInitialViewRef.current = 'prompt'; // consume and reset
            setMyCarDepartureTime(new Date(Date.now() + 2 * 60_000));
            setMyCarDepartureDate(localDateStr());
            setMyCarDepartureError(null);
            setMyCarPingSuccess(savedSpot?.linkedPingId ? 'already_shared' : null);
        } else {
            departureSheetOriginRef.current = 'prompt'; // reset on close
        }
    }, [showDepartureSheet]);

    // Validate stale linkedPingId when the departure sheet opens.
    // If the linked ping no longer exists, has expired, or was successfully
    // handed off (occupied), clear the link so the user can share again.
    useEffect(() => {
        if (!showDepartureSheet || !savedSpot?.linkedPingId) return;
        getDoc(doc(db, 'spots', savedSpot.linkedPingId)).then(snap => {
            const data = snap.data();
            const isActive = snap.exists()
                && (data?.expiresAt?.toMillis?.() ?? 0) > Date.now()
                && data?.status !== 'occupied';
            if (!isActive) {
                const updated = { ...savedSpot, linkedPingId: null };
                localStorage.setItem(SAVED_SPOT_KEY, JSON.stringify(updated));
                setSavedSpot(updated);
                setMyCarPingSuccess(null);
            }
        }).catch(() => { /* non-fatal: keep showing "already shared" if check fails */ });
    }, [showDepartureSheet, savedSpot?.linkedPingId]);

    // --- Handlers ---

    const handleLocateMe = () => {
        if (userLocation && mapRef.current) {
            mapRef.current.flyTo({ center: userLocation, zoom: 16 });
        }
    };

    // Directly creates a ping from the saved My Car location — no SpotModal.
    // Uses a deterministic spot ID (mycar_uid_sessionId) so retries are idempotent.
    const handleMyCarPing = async (departureTime: Date | null) => {
        if (!savedSpot || !user) return;

        // Gate 1: session already has a confirmed linked ping
        if (savedSpot.linkedPingId) {
            setMyCarPingSuccess('already_shared');
            return;
        }

        setMyCarDepartureLoading(true);
        setMyCarDepartureError(null);

        const now = Date.now();
        const reportedAt = departureTime ? Timestamp.fromDate(departureTime) : Timestamp.fromMillis(now);
        const expiresAt = Timestamp.fromMillis(getPingExpiresAtMs(reportedAt));
        const spotId = `mycar_${user.id}_${savedSpot.sessionId}`;
        const spotRef = doc(db, 'spots', spotId);

        // Rate-limit check + orphan cleanup in one query — bounded to the same
        // finderId+reportedAt composite index and limit(10) already used by
        // the general ping rate-limit query below (no new index required),
        // instead of reading this finder's entire spot history. A 'my_car'
        // orphan older than the 10 most-recent spots for this finder is no
        // longer proactively deleted here, but every spot has expiresAt set
        // at creation and cleanupExpiredSpotsHourly sweeps the whole
        // collection every hour regardless of source/status, so it's still
        // deleted within about 90 minutes rather than left permanently.
        try {
            const snap = await getDocs(query(
                collection(db, 'spots'),
                where('finderId', '==', user.id),
                orderBy('reportedAt', 'desc'),
                limit(10)
            ));
            const candidates = snap.docs.filter(d => d.id !== spotId);
            const rateLimit = checkPingRateLimit(candidates, now);
            if (rateLimit.limited) {
                setMyCarDepartureError(t('my_car.ping_limit_reached', { minutes: rateLimit.minutesLeft }));
                setMyCarDepartureLoading(false);
                return;
            }
            // Orphan cleanup: previous My Car pings orphaned when a new session overwrites
            // savedSpot without deleting the old linked ping (e.g. handoff auto-save)
            const orphans = candidates.filter(d => d.data().source === 'my_car');
            if (orphans.length > 0) {
                await Promise.all(orphans.map(d => deleteDoc(doc(db, 'spots', d.id))));
            }
        } catch { /* non-fatal */ }

        // Gate 2: pre-flight check — spot may already exist if a previous attempt
        // succeeded but the session update (linkedPingId) failed
        try {
            const existing = await getDoc(spotRef);
            if (existing.exists()) {
                linkedPingIdRef.current = spotId;
                const updated = { ...savedSpot, linkedPingId: spotId };
                localStorage.setItem(SAVED_SPOT_KEY, JSON.stringify(updated));
                setSavedSpot(updated);
                setMyCarPingSuccess('already_shared');
                setMyCarDepartureLoading(false);
                return;
            }
        } catch { /* non-fatal, proceed to create */ }

        // Set the ref SYNCHRONOUSLY before setDoc — the Firestore onSnapshot listener
        // fires during setDoc (before the Promise resolves), so the ref must be set
        // before that moment. setSavedSpot is async (enqueues a render); the ref is not.
        linkedPingIdRef.current = spotId;
        const withLinkedId = { ...savedSpot, linkedPingId: spotId };
        localStorage.setItem(SAVED_SPOT_KEY, JSON.stringify(withLinkedId));
        setSavedSpot(withLinkedId);

        // Create the ping with the deterministic ID
        try {
            await setDoc(spotRef, {
                lat: savedSpot.lat,
                lng: savedSpot.lng,
                type: 'free',
                status: 'available',
                finderId: user.id,
                finderName: user.username || user.fullName || 'Anonymous',
                finderTitle: getTitleForCrowns(user.crowns || 0),
                finderVehicleColor: user.vehicleColor || null,
                finderVehicleType: user.vehicleType || null,
                finderVehicleBrand: user.vehicleBrand || null,
                pingMode: departureTime ? 'later' : 'now',
                source: 'my_car',
                reportedAt,
                expiresAt,
                geohash: geofire.geohashForLocation([savedSpot.lat, savedSpot.lng]),
                address: savedSpot.address,
            });

            const mode = departureTime ? 'leaving_later' : 'leaving_now';
            setMyCarPingSuccess(mode);
            setMyCarDepartureLoading(false);

            setTimeout(() => {
                setShowDepartureSheet(false);
                if (mode === 'leaving_now') endSession();
            }, 1500);
        } catch (e) {
            // Revert optimistic update — the ping doc was never created
            localStorage.setItem(SAVED_SPOT_KEY, JSON.stringify(savedSpot));
            setSavedSpot(savedSpot);
            console.error('My Car ping failed:', (e as any)?.code ?? 'unknown');
            setMyCarDepartureError(t('my_car.share_error'));
            setMyCarDepartureLoading(false);
        }
    };

    const handleSaveSpot = async (departureTime: Date | null) => {
        if (isPinging || !user) return;

        if (!selectedItem) {
            const activeQ = query(collection(db, 'spots'), where('finderId', '==', user.id), where('status', 'in', ['available', 'interested']));
            const activeSnap = await getDocs(activeQ);
            const nowMs = Date.now();
            const hasActive = activeSnap.docs.some(d => (d.data().expiresAt?.toMillis?.() ?? 0) > nowMs);
            if (hasActive) {
                setPingError(t('ping_errors.duplicate'));
                return;
            }
        }

        setIsPinging(true);
        setSpotModalOpen(false);

        const now = Date.now();
        const reportedAt = departureTime ? Timestamp.fromDate(departureTime) : Timestamp.fromMillis(now);
        const expiresAt = Timestamp.fromMillis(getPingExpiresAtMs(reportedAt));

        const onSaveSuccess = () => {
            setIsPinging(false);
            setSelectedItem(null);
            if (isDepartureFlowRef.current) {
                isDepartureFlowRef.current = false;
                endSession();
            }
        };

        const onSaveError = (error: any) => {
            console.error("Error saving spot:", (error as any)?.code ?? 'unknown');
            reportPingCreationFailure(error, departureTime);
            setPingError(t('ping_errors.save_failed'));
            setIsPinging(false);
        };

        if (selectedItem) {
            try {
                const batch = writeBatch(db);
                const oldSpotRef = doc(db, "spots", selectedItem.id);
                batch.delete(oldSpotRef);
                const newSpotRef = doc(collection(db, "spots"));
                const newSpotData = {
                    lat: selectedItem.lat,
                    lng: selectedItem.lng,
                    type: 'free',
                    status: 'available',
                    finderId: user.id,
                    finderName: user.username || user.fullName || 'Anonymous',
                    finderTitle: getTitleForCrowns(user.crowns || 0),
                    finderVehicleColor: user.vehicleColor || null,
                    finderVehicleType: user.vehicleType || null,
                    finderVehicleBrand: user.vehicleBrand || null,
                    pingMode: departureTime ? 'later' : 'now',
                    reportedAt,
                    expiresAt,
                    geohash: geofire.geohashForLocation([selectedItem.lat, selectedItem.lng]),
                    address: await reverseGeocode(selectedItem.lng, selectedItem.lat),
                };
                batch.set(newSpotRef, newSpotData);
                await batch.commit();
                onSaveSuccess();
            } catch (error) {
                onSaveError(error);
            }
        } else {
            try {
                // Bounded to the newest 10 via the existing finderId+reportedAt
                // index — reads no longer grow with a user's lifetime spot history.
                const q = query(
                    collection(db, "spots"),
                    where("finderId", "==", user.id),
                    orderBy("reportedAt", "desc"),
                    limit(10)
                );
                const snap = await getDocs(q);
                const rateLimit = checkPingRateLimit(snap.docs, now);

                if (rateLimit.limited) {
                    setPingError(t('ping_errors.rate_limit', { min: rateLimit.minutesLeft }));
                    setIsPinging(false);
                    return;
                }
            } catch (error) {
                console.error("Error checking rate limit:", (error as any)?.code ?? 'unknown');
            }

            if (userLocation) {
                const newSpotData = {
                    lat: userLocation[1],
                    lng: userLocation[0],
                    type: 'free',
                    status: 'available',
                    finderId: user.id,
                    finderName: user.username || user.fullName || 'Anonymous',
                    finderTitle: getTitleForCrowns(user.crowns || 0),
                    finderVehicleColor: user.vehicleColor || null,
                    finderVehicleType: user.vehicleType || null,
                    finderVehicleBrand: user.vehicleBrand || null,
                    pingMode: departureTime ? 'later' : 'now',
                    reportedAt,
                    expiresAt,
                    geohash: geofire.geohashForLocation([userLocation[1], userLocation[0]]),
                    address: await reverseGeocode(userLocation[0], userLocation[1]),
                };
                try {
                    await addDoc(collection(db, "spots"), newSpotData);
                    setShowPingConfirmation(true);
                    setTimeout(() => setShowPingConfirmation(false), 4000);
                    onSaveSuccess();
                } catch (error) {
                    onSaveError(error);
                }
            } else {
                void getCurrentPosition({ enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 })
                    .then(async (position) => {
                        const location: [number, number] = [position.coords.longitude, position.coords.latitude];
                        const geohash = geofire.geohashForLocation([location[1], location[0]]);

                        const newSpotData = {
                            lat: location[1],
                            lng: location[0],
                            type: 'free',
                            status: 'available',
                            finderId: user.id,
                            finderName: user.username || user.fullName || 'Anonymous',
                            finderVehicleColor: user.vehicleColor || null,
                            finderVehicleType: user.vehicleType || null,
                            finderVehicleBrand: user.vehicleBrand || null,
                            pingMode: departureTime ? 'later' : 'now',
                            reportedAt,
                            expiresAt,
                            geohash,
                            address: await reverseGeocode(location[0], location[1]),
                        };
                        try {
                            await addDoc(collection(db, "spots"), newSpotData);
                            setShowPingConfirmation(true);
                            setTimeout(() => setShowPingConfirmation(false), 4000);
                            onSaveSuccess();
                        } catch (error) {
                            onSaveError(error);
                        }
                    })
                    .catch((error) => {
                        console.error("Error getting position for ping:", error?.kind ?? error?.code ?? 'position_error');
                        setPingError(t('ping_errors.location'));
                        setIsPinging(false);
                    });
            }
        }
    };

    const handleDeletePing = () => {
        const spotToDelete = selectedItem || (spotData.activeSpots.length > 0 ? spotData.activeSpots[0] : null);
        if (!user || !spotToDelete) return;
        if (user.id !== spotToDelete.finderId) return;
        setShowDeleteConfirm(true);
    };

    const cancelLinkedPing = async () => {
        if (!savedSpot?.linkedPingId) return;
        setLinkedPingError(null);
        try {
            await deleteDoc(doc(db, 'spots', savedSpot.linkedPingId));
        } catch (e) {
            console.error('Error canceling linked ping:', (e as any)?.code ?? 'unknown');
            setLinkedPingError(t('my_car.cancel_shared_error'));
            return;
        }
        const updated = { ...savedSpot, linkedPingId: null };
        localStorage.setItem(SAVED_SPOT_KEY, JSON.stringify(updated));
        setSavedSpot(updated);
    };

    const handleRemoveCar = async () => {
        if (!savedSpot?.linkedPingId) { endSession(); return; }
        setRemoveCarLoading(true);
        setLinkedPingError(null);
        // Validate before touching Firestore — same stale criteria as the departure sheet validator
        let snap: Awaited<ReturnType<typeof getDoc>>;
        try {
            snap = await getDoc(doc(db, 'spots', savedSpot.linkedPingId));
        } catch (e) {
            console.error('Error checking linked ping before remove:', (e as any)?.code ?? 'unknown');
            setLinkedPingError(t('my_car.remove_error'));
            setRemoveCarLoading(false);
            return;
        }
        const snapData = snap.data() as any;
        const isActive = snap.exists()
            && (snapData?.expiresAt?.toMillis?.() ?? 0) > Date.now()
            && snapData?.status !== 'occupied';
        if (!isActive) {
            // Stale ping — already gone, expired, or handed off; safe to remove without deleteDoc
            endSession();
            return;
        }
        // Active ping — must delete from Firestore before removing My Car
        try {
            await deleteDoc(doc(db, 'spots', savedSpot.linkedPingId));
        } catch (e) {
            console.error('Error canceling linked ping before remove:', (e as any)?.code ?? 'unknown');
            setLinkedPingError(t('my_car.remove_error'));
            setRemoveCarLoading(false);
            return;
        }
        endSession();
    };

    const changeLinkedPingTime = async () => {
        if (!savedSpot?.linkedPingId) return;
        setLinkedPingError(null);
        try {
            await deleteDoc(doc(db, 'spots', savedSpot.linkedPingId));
        } catch (e) {
            console.error('Error updating linked ping:', (e as any)?.code ?? 'unknown');
            setLinkedPingError(t('my_car.update_error'));
            return;
        }
        const updated = { ...savedSpot, linkedPingId: null };
        localStorage.setItem(SAVED_SPOT_KEY, JSON.stringify(updated));
        setSavedSpot(updated);
        departureSheetOriginRef.current = 'change_time';
        departureSheetInitialViewRef.current = 'timePicker';
        setShowSessionSheet(false);
        setShowDepartureSheet(true);
    };

    const doDeletePing = async () => {
        const spotToDelete = selectedItem || (spotData.activeSpots.length > 0 ? spotData.activeSpots[0] : null);
        if (!spotToDelete) return;
        setShowDeleteConfirm(false);
        try {
            await deleteDoc(doc(db, "spots", spotToDelete.id));
            setSelectedItem(null);
        } catch (e) {
            console.error("Error deleting ping:", (e as any)?.code ?? 'unknown');
        }
    };

    const handlePrimaryMapAction = () => {
        const myPing = spotData.activeSpots.find(s => s.finderId === user?.id && s.id !== savedSpot?.linkedPingId);
        if (savedSpot) {
            if (mapRef.current) {
                mapRef.current.flyTo({ center: [savedSpot.lng, savedSpot.lat], zoom: 17, duration: 800 });
            }
            setTimeout(() => setShowSessionSheet(true), 600);
        } else if (myPing) {
            setSelectedItem(myPing);
            setSelectedItemManageMode(myPing.status !== 'interested');
        } else {
            setSelectedItem(null);
            setSpotModalOpen(true);
        }
    };

    const mapPrimaryNavigationVisible = shouldShowMapPrimaryNavigation({
        enabled: showPrimaryNavigation,
        spotModalOpen: isSpotModalOpen,
        spotDetailsOpen: !!selectedItem,
        sessionSheetOpen: showSessionSheet,
        postSaveOfferOpen: showPostSaveOffer,
        departureSheetOpen: showDepartureSheet,
        handoffSheetOpen: interestFlow.handoffStep !== null,
        stackSheetOpen: !!stackGroup,
        deleteDialogOpen: showDeleteConfirm,
        destinationActivitySheetOpen: !!search.selectedDestination,
    });

    return (
        <div className="sp-page">
            <SpotModal
                isOpen={isSpotModalOpen}
                onClose={() => {
                    setSpotModalOpen(false);
                    setSelectedItem(null);
                    isDepartureFlowRef.current = false; // session stays alive if they back out
                }}
                onSave={handleSaveSpot}
                spot={selectedItem}
                spotAddress={spotAddress}
                user={user}
            />

            {/* Spot details bottom sheet */}
            <BottomSheet isOpen={!!selectedItem && !isSpotModalOpen} ariaLabel="Spot details" onClose={() => { setSelectedItem(null); setSelectedItemManageMode(false); setSpotDetailsBackStack(null); }} onNestedBack={() => {
                if (!spotDetailsBackStack) return false;
                setSelectedItem(null);
                setStackGroup(spotDetailsBackStack);
                setSpotDetailsBackStack(null);
                return true;
            }}>
                <SpotDetailsCard
                    selectedItem={selectedItem}
                    backLabel={spotDetailsBackStack ? `Back to ${spotDetailsBackStack.length} spots` : undefined}
                    onBack={spotDetailsBackStack ? () => { setSelectedItem(null); setStackGroup(spotDetailsBackStack); setSpotDetailsBackStack(null); } : undefined}
                    freeSpots={spotData.freeSpots}
                    user={user}
                    userLocation={userLocation}
                    spotAddress={spotAddress}
                    onHeadingThere={() => {
                        const eta = selectedItem ? interestFlow.getEstDriveMinutes(selectedItem) : null;
                        interestFlow.handleExpressInterest(eta ?? 5);
                    }}
                    onScheduledClaim={() => interestFlow.handleScheduledClaim()}
                    onCommitToHeading={() => interestFlow.handleCommitToHeading()}
                    onOwnerLeaveNow={() => interestFlow.handleOwnerLeaveNow()}
                    onEditSpot={(spot) => { setSelectedItem(spot); setSpotModalOpen(true); }}
                    onDeletePing={handleDeletePing}
                    onArrival={interestFlow.handleArrival}
                    onCancelByFinder={interestFlow.handleCancelByFinder}
                    onCancelByClaimer={interestFlow.handleCancelByClaimer}
                    cancelingClaim={interestFlow.cancelingClaim}
                    onDriverArrived={interestFlow.handleFinderConfirmsArrival}
                    onMessageUser={onMessageUser}
                    interestError={interestFlow.interestError}
                    estDriveMinutes={selectedItem ? interestFlow.getEstDriveMinutes(selectedItem) : null}
                    isWithinArrivalRange={selectedItem ? interestFlow.isWithinArrivalRange(selectedItem) : false}
                    maxEtaMinutes={interestFlow.MAX_ETA_MINUTES}
                    manageMode={selectedItemManageMode}
                    nowMs={nowMs}
                />
            </BottomSheet>


            {/* My Car — Parking Session sheet (personal only) */}
            <BottomSheet isOpen={showSessionSheet} ariaLabel="My Car session" onClose={() => { setShowSessionSheet(false); setShowCustomReminder(false); setShowRemindPanel(false); }}>
                {savedSpot && (
                    <div className="pq-mycar">
                        {/* 1 — Car summary hero */}
                        <section className="pq-mycar-hero" aria-label={t('common.my_car')}>
                            <div className="pq-mycar-hero-icon">
                                <VehicleIcon type={user?.vehicleType} color={user?.vehicleColor} size={22} />
                            </div>
                            <div className="pq-mycar-hero-body">
                                <p className="pq-mycar-hero-kicker">{t('common.my_car')}</p>
                                {savedSpot.address && (
                                    <p className="pq-mycar-hero-address">{savedSpot.address}</p>
                                )}
                                <p className="pq-mycar-hero-status">{parkedDuration || t('my_car.just_parked')}</p>
                            </div>
                            <button
                                onClick={() => {
                                    if (!mapRef.current || !userLocation) return;
                                    const dest: [number, number] = [savedSpot.lng, savedSpot.lat];
                                    activeRouteDestinationRef.current = dest;
                                    drawRoute(mapRef.current, userLocation, dest);
                                    mapRef.current.flyTo({ center: dest, zoom: 16 });
                                    setShowSessionSheet(false);
                                }}
                                aria-label="Navigate to my car"
                                className="pq-mycar-nav"
                            >
                                <Navigation size={14} />
                                <span>Navigate</span>
                            </button>
                        </section>

                        {/* 2 — Safety / status hero */}
                        <section className="pq-mycar-safety" aria-label="Street intelligence">
                        {savedSpot.segmentId && savedSpot.segmentStreetName ? (
                            <StreetIntelligenceCard
                                segmentId={savedSpot.segmentId}
                                parkingSide={savedSpot.parkingSide}
                                streetName={savedSpot.segmentStreetName}
                                sideConfidence={savedSpot.sideConfidence ?? 'unknown'}
                                confirmedParkingSide={savedSpot.confirmedParkingSide ?? null}
                                onConfirmSide={handleConfirmSide}
                                onResult={r => {
                                    if (r?.safeUntil) {
                                        writeCleaningReminder(r.safeUntil, reminderEnabled, savedSpot.segmentStreetName);
                                    }
                                }}
                            />
                        ) : savedSpot.streetIntelStatus === 'unavailable' || savedSpot.streetIntelStatus === 'failed' ? (
                            <div className="pq-mycar-intel-unavailable">
                                <div className="pq-mycar-intel-street">
                                    <MapPin size={14} className="text-[var(--color-text-secondary)]" />
                                    <p>
                                        {savedSpot.streetIntelStatus === 'failed' ? t('street_intel.failed_title') :
                                         savedSpot.streetIntelReason === 'no_sweepnyc_notes' || savedSpot.streetIntelReason === 'no_signs' ? t('street_intel.unavailable_title_no_data') :
                                         t('street_intel.unavailable_title_general')}
                                    </p>
                                </div>
                                <p className="pq-mycar-intel-reason">
                                    {savedSpot.streetIntelStatus === 'failed'
                                        ? t('street_intel.failed_body')
                                        : savedSpot.streetIntelReason === 'no_sweepnyc_notes' || savedSpot.streetIntelReason === 'no_signs'
                                        ? t('street_intel.unavailable_body_no_data')
                                        : t('street_intel.unavailable_body_general')}
                                </p>
                                <p className="pq-mycar-intel-reason" style={{ marginBottom: 0 }}>
                                    {t('street_intel.check_signs')}
                                </p>
                                <button
                                    onClick={handleRetryStreetIntel}
                                    disabled={retryingStreetIntel}
                                    className="pq-mycar-intel-retry"
                                >
                                    {retryingStreetIntel
                                        ? t('street_intel.trying')
                                        : savedSpot.streetIntelStatus === 'failed'
                                        ? t('street_intel.try_again')
                                        : t('street_intel.check_again')}
                                </button>
                            </div>
                        ) : (
                            <StreetIntelligenceUnavailableCard />
                        )}
                        </section>

                        {/* 3 — Reminders */}
                        <section className="pq-mycar-reminders" aria-label={t('my_car.section_reminders')}>
                        <div className="pq-mycar-section-label">
                            <span>{t('my_car.section_reminders')}</span>
                        </div>
                        <div className="pq-mycar-remind-grid">
                            <button
                                onClick={() => {
                                    const next = !reminderEnabled;
                                    setReminderEnabled(next);
                                    localStorage.setItem('streetCleaningReminder', String(next));
                                    if (auth.currentUser) {
                                        setDoc(doc(db, 'parkingSessions', auth.currentUser.uid), { reminderEnabled: next }, { merge: true }).catch(() => {});
                                    }
                                }}
                                disabled={!savedSpot.segmentId}
                                aria-pressed={reminderEnabled}
                                className={`pq-mycar-remind-tile${reminderEnabled ? ' is-on' : ''}`}
                            >
                                <span className="pq-mycar-remind-on" aria-hidden="true">On</span>
                                <div className="pq-mycar-remind-tile-icon">
                                    <Bell size={16} />
                                </div>
                                <span className="pq-mycar-remind-tile-label">Cleaning alert</span>
                            </button>
                            <button
                                onClick={() => setShowRemindPanel(v => !v)}
                                aria-expanded={showRemindPanel || !!parkingTimer.timer}
                                className={`pq-mycar-remind-tile${parkingTimer.timer || showRemindPanel ? ' is-on' : ''}`}
                            >
                                <span className="pq-mycar-remind-on" aria-hidden="true">On</span>
                                <div className="pq-mycar-remind-tile-icon">
                                    <Clock size={16} />
                                </div>
                                <span className="pq-mycar-remind-tile-label">
                                    {parkingTimer.timer ? <>{parkingTimer.minutesRemaining}m left</> : <>Move reminder</>}
                                </span>
                            </button>
                        </div>

                        {reminderEnabled && (
                            <p className="pq-mycar-remind-note">
                                We'll remind you <strong>1 hour before</strong> cleaning, and again at <strong>30 minutes before</strong> street cleaning starts
                            </p>
                        )}

                        {(showRemindPanel || !!parkingTimer.timer) && (
                            <div className="pq-mycar-remind-panel">
                                {parkingTimer.timer ? (
                                    <div className="flex items-center gap-2.5 px-4 py-3">
                                        <Clock size={14} className="text-[var(--color-info)] shrink-0" />
                                        <p className="text-xs font-semibold text-[var(--color-info)] flex-1">{t('my_car.min_remaining', { min: parkingTimer.minutesRemaining })}</p>
                                        <button onClick={parkingTimer.clearTimer} className="text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors">
                                            <X size={13} />
                                        </button>
                                    </div>
                                ) : showCustomReminder ? (
                                    <div>
                                        <div className="px-4 pt-3 pb-2">
                                            <p className="text-[10px] font-bold text-[var(--color-text-secondary)] uppercase tracking-widest mb-1.5">{t('ping_modal.date')}</p>
                                            <GlassDatePicker
                                                id="pq-reminder-date"
                                                value={reminderDate}
                                                min={localDateStr()}
                                                onChange={setReminderDate}
                                            />
                                        </div>
                                        <div className="px-4 pb-3">
                                            <p className="text-[10px] font-bold text-[var(--color-text-secondary)] uppercase tracking-widest mb-1.5">{t('ping_modal.time')}</p>
                                            <div className="flex items-center gap-2">
                                                <div className="flex items-center gap-0.5 flex-1 min-w-0">
                                                    <input
                                                        type="text"
                                                        inputMode="numeric"
                                                        placeholder="12"
                                                        value={reminderHour}
                                                        maxLength={2}
                                                        autoFocus
                                                        className="w-7 bg-transparent text-sm font-semibold text-white text-center focus:outline-none"
                                                        onFocus={(e) => e.target.select()}
                                                        onChange={(e) => {
                                                            const raw = e.target.value.replace(/\D/g, '');
                                                            if (!raw) { setReminderHour(''); return; }
                                                            const n = parseInt(raw);
                                                            if (n > 12) { setReminderHour('12'); reminderMinuteRef.current?.focus(); return; }
                                                            if (n === 0) { setReminderHour('1'); return; }
                                                            setReminderHour(raw);
                                                            if (raw.length === 2 || (raw.length === 1 && n >= 2)) {
                                                                reminderMinuteRef.current?.focus();
                                                            }
                                                        }}
                                                    />
                                                    <span className="text-sm font-bold text-[var(--color-text-secondary)] select-none">:</span>
                                                    <input
                                                        ref={reminderMinuteRef}
                                                        type="text"
                                                        inputMode="numeric"
                                                        placeholder="00"
                                                        value={reminderMinute}
                                                        maxLength={2}
                                                        className="w-7 bg-transparent text-sm font-semibold text-white text-center focus:outline-none"
                                                        onFocus={(e) => e.target.select()}
                                                        onChange={(e) => {
                                                            const raw = e.target.value.replace(/\D/g, '');
                                                            if (!raw) { setReminderMinute(''); return; }
                                                            const n = parseInt(raw);
                                                            if (n > 59) { setReminderMinute('59'); return; }
                                                            setReminderMinute(raw);
                                                        }}
                                                    />
                                                </div>
                                                <div className="flex rounded-lg overflow-hidden border border-[var(--color-border)] shrink-0">
                                                    {(['AM', 'PM'] as const).map(period => (
                                                        <button key={period} type="button"
                                                            onClick={() => setReminderAmPm(period)}
                                                            className={`px-2.5 py-1 text-xs font-bold transition-colors ${
                                                                reminderAmPm === period
                                                                    ? 'bg-[var(--color-brand)] text-white'
                                                                    : 'bg-transparent text-[var(--color-text-secondary)] hover:text-[var(--color-text)]'
                                                            }`}>
                                                            {period}
                                                        </button>
                                                    ))}
                                                </div>
                                            </div>
                                        </div>
                                        <div className="h-px bg-[var(--color-border)]" />
                                        <div className="flex divide-x divide-[var(--color-border)]">
                                            <button onClick={() => setShowCustomReminder(false)}
                                                className="flex-1 py-3 text-xs font-bold text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors">
                                                {t('my_car.cancel')}
                                            </button>
                                            <button
                                                onClick={() => {
                                                    const hRaw = parseInt(reminderHour) || 12;
                                                    const m = parseInt(reminderMinute) || 0;
                                                    let h = hRaw % 12;
                                                    if (reminderAmPm === 'PM') h += 12;
                                                    const dateStr = reminderDate || localDateStr();
                                                    const target = new Date(`${dateStr}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}`);
                                                    const minutes = Math.round((target.getTime() - Date.now()) / 60000);
                                                    if (minutes > 0) {
                                                        parkingTimer.startTimer(minutes, savedSpot!.address || '', () => setShowSessionSheet(true));
                                                        setShowCustomReminder(false);
                                                        setShowRemindPanel(false);
                                                    }
                                                }}
                                                className="flex-1 py-3 text-xs font-bold text-[var(--color-info)] hover:text-[var(--color-accent)] transition-colors">
                                                {t('my_car.set_reminder')}
                                            </button>
                                        </div>
                                    </div>
                                ) : (
                                    <div className="grid grid-cols-4 divide-x divide-[var(--color-border)]">
                                        {[{ label: '15m', minutes: 15 }, { label: '30m', minutes: 30 }, { label: '1 hr', minutes: 60 }, { label: 'Custom', minutes: -1 }].map(opt => (
                                            <button key={opt.minutes}
                                                onClick={() => {
                                                    if (opt.minutes === -1) { setReminderHour(''); setReminderMinute(''); setReminderDate(localDateStr()); setShowCustomReminder(true); return; }
                                                    parkingTimer.startTimer(opt.minutes, savedSpot.address || '', () => setShowSessionSheet(true));
                                                    setShowRemindPanel(false);
                                                }}
                                                className="py-3 text-xs font-bold text-[var(--color-text)] hover:bg-white/5 transition-colors text-center">
                                                {opt.label}
                                            </button>
                                        ))}
                                    </div>
                                )}
                            </div>
                        )}
                        </section>

                        {/* 4 — Community + danger zone */}
                        <section className="pq-mycar-community" aria-label={t('my_car.section_community')}>
                        <div className="pq-mycar-section-label">
                            <span>{t('my_car.section_community')}</span>
                        </div>
                        {savedSpot.linkedPingId ? (() => {
                            const linkedSpot = spotData.activeSpots.find(s => s.id === savedSpot.linkedPingId);
                            const depTime = linkedSpot?.reportedAt
                                ? (typeof linkedSpot.reportedAt.toDate === 'function'
                                    ? linkedSpot.reportedAt.toDate()
                                    : new Date(linkedSpot.reportedAt.seconds * 1000))
                                : null;
                            const depText = (() => {
                                if (!depTime || depTime.getTime() <= Date.now() + 60_000)
                                    return t('my_car.drivers_see_now');
                                const now = new Date();
                                const time = depTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                                if (depTime.toDateString() === now.toDateString())
                                    return t('my_car.drivers_see_at', { time });
                                const tom = new Date(now); tom.setDate(now.getDate() + 1);
                                if (depTime.toDateString() === tom.toDateString())
                                    return t('my_car.drivers_see_tomorrow', { time });
                                return t('my_car.drivers_see_date', { date: depTime.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }), time });
                            })();
                            return (
                                <div className="pq-mycar-ping-active">
                                    <div className="flex items-center gap-2 mb-1">
                                        <div className="w-2 h-2 rounded-full bg-[#38bdf8] shrink-0" />
                                        <p className="text-sm font-bold text-[var(--color-text)]">
                                            {depTime && depTime.getTime() > Date.now() + 60_000
                                                ? t('my_car.sharing_at', { time: depTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) })
                                                : t('my_car.spot_shared')}
                                        </p>
                                    </div>
                                    <p className="text-xs text-[var(--color-text-secondary)]">{depText}</p>
                                    <div className="pq-mycar-ping-actions">
                                        <button
                                            onClick={changeLinkedPingTime}
                                            className="pq-mycar-btn-ghost">
                                            {t('my_car.change_time')}
                                        </button>
                                        <button
                                            onClick={cancelLinkedPing}
                                            className="pq-mycar-btn-danger">
                                            {t('my_car.stop_sharing')}
                                        </button>
                                    </div>
                                    {linkedPingError && (
                                        <p className="mt-2 text-xs text-[var(--color-danger)] font-semibold text-center">{linkedPingError}</p>
                                    )}
                                </div>
                            );
                        })() : (
                            <>
                                <button
                                    onClick={() => {
                                        departureSheetOriginRef.current = 'session';
                                        departureSheetInitialViewRef.current = 'timePicker';
                                        setShowSessionSheet(false);
                                        setShowDepartureSheet(true);
                                    }}
                                    className="pq-mycar-ping-cta">
                                    <Clock size={14} />
                                    <span className="pq-mycar-ping-cta-label">{t('my_car.ping_when_leaving')}</span>
                                    <ChevronRight size={14} className="pq-mycar-ping-cta-chevron" aria-hidden="true" />
                                </button>
                                <p className="pq-mycar-ping-hint">{t('my_car.community_hint')}</p>
                            </>
                        )}
                        </section>

                        <section className="pq-mycar-danger" aria-label={t('my_car.remove_saved_car')}>
                            {!showRemoveCarConfirm ? (
                                <button
                                    onClick={() => setShowRemoveCarConfirm(true)}
                                    className="pq-mycar-danger-trigger">
                                    {t('my_car.remove_saved_car')}
                                </button>
                            ) : savedSpot?.linkedPingId ? (
                                <div className="pq-mycar-danger-confirm">
                                    <p>{t('my_car.remove_with_ping')}</p>
                                    {linkedPingError && <p className="text-xs text-[var(--color-danger)] text-center font-semibold">{linkedPingError}</p>}
                                    <div className="pq-mycar-ping-actions">
                                        <button
                                            onClick={() => { setShowRemoveCarConfirm(false); setLinkedPingError(null); }}
                                            className="pq-mycar-btn-ghost">
                                            {t('my_car.keep_it')}
                                        </button>
                                        <button
                                            onClick={handleRemoveCar}
                                            disabled={removeCarLoading}
                                            className="pq-mycar-btn-danger">
                                            {removeCarLoading ? t('my_car.removing') : t('my_car.cancel_and_remove')}
                                        </button>
                                    </div>
                                </div>
                            ) : (
                                <div className="pq-mycar-danger-confirm">
                                    <p>{t('my_car.remove_confirm')}</p>
                                    <div className="pq-mycar-ping-actions">
                                        <button
                                            onClick={() => setShowRemoveCarConfirm(false)}
                                            className="pq-mycar-btn-ghost">
                                            {t('my_car.keep_it')}
                                        </button>
                                        <button
                                            onClick={endSession}
                                            className="pq-mycar-btn-danger">
                                            {t('my_car.remove')}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </section>
                    </div>
                )}
            </BottomSheet>

            {/* Post-save offer — shown once after saveMySpot() succeeds */}
            <BottomSheet isOpen={showPostSaveOffer} ariaLabel="Ping your spot" onClose={() => { setShowPostSaveOffer(false); setShowSessionSheet(true); }}>
                {savedSpot && (
                    <div className="pq-postsave">
                        <div className="pq-postsave-hero" aria-hidden="true">
                            <span className="pq-postsave-hero-glow" />
                            <div className="pq-postsave-hero-ring">
                                <div className="pq-postsave-hero-icon">
                                    <Car size={26} strokeWidth={1.85} />
                                </div>
                            </div>
                        </div>
                        <h2 className="pq-postsave-title">{t('my_car.car_saved')}</h2>
                        <p className="pq-postsave-sub">{t('my_car.help_another_driver')}</p>
                        <button
                            type="button"
                            onClick={() => {
                                departureSheetOriginRef.current = 'post_save';
                                departureSheetInitialViewRef.current = 'timePicker';
                                setShowPostSaveOffer(false);
                                setShowDepartureSheet(true);
                            }}
                            className="pq-postsave-cta"
                        >
                            <Clock size={16} strokeWidth={2.2} />
                            <span>{t('my_car.share_when_leaving')}</span>
                        </button>
                        <button
                            type="button"
                            onClick={() => { setShowPostSaveOffer(false); setShowSessionSheet(true); }}
                            className="pq-postsave-dismiss"
                        >
                            {t('my_car.not_now')}
                        </button>
                    </div>
                )}
            </BottomSheet>

            {/* Departure prompt — inline, no SpotModal required */}
            <BottomSheet isOpen={showDepartureSheet} ariaLabel="Set departure time" onClose={() => setShowDepartureSheet(false)} onNestedBack={() => {
                if (myCarPingSuccess || myCarDepartureView !== 'timePicker') return false;
                setMyCarDepartureError(null);
                if (departureSheetOriginRef.current === 'prompt') {
                    setMyCarDepartureView('prompt');
                } else {
                    setShowDepartureSheet(false);
                    setShowSessionSheet(true);
                }
                return true;
            }}>
                {savedSpot && (
                    <div>
                        {/* Success / already-shared state */}
                        {myCarPingSuccess && (
                            <div className="flex flex-col items-center py-6">
                                <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4"
                                    style={{ background: 'linear-gradient(90deg, var(--color-brand), var(--color-brand-2))' }}>
                                    <CheckCircle2 size={30} className="text-white" />
                                </div>
                                <p className="text-xl font-extrabold text-[var(--color-text)] mb-1">
                                    {myCarPingSuccess === 'leaving_now' ? t('my_car.spot_shared_now')
                                     : myCarPingSuccess === 'leaving_later' ? t('my_car.spot_shared_later')
                                     : t('my_car.spot_already_shared')}
                                </p>
                                <p className="text-sm text-[var(--color-text-secondary)] text-center">
                                    {myCarPingSuccess === 'leaving_now'
                                        ? t('my_car.nearby_can_see')
                                        : myCarPingSuccess === 'leaving_later'
                                        ? t('my_car.will_notify')
                                        : t('my_car.can_already_see')}
                                </p>
                                {myCarPingSuccess === 'already_shared' && (
                                    <button
                                        onClick={() => setShowDepartureSheet(false)}
                                        className="mt-4 text-sm font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors">
                                        {t('my_car.got_it')}
                                    </button>
                                )}
                            </div>
                        )}

                        {/* Prompt view */}
                        {!myCarPingSuccess && myCarDepartureView === 'prompt' && (
                            <div className="pq-leave">
                                <div className="pq-leave-hero" aria-hidden="true">
                                    <span className="pq-leave-hero-glow" />
                                    <div className="pq-leave-hero-ring">
                                        <div className="pq-leave-hero-icon">
                                            <Car size={20} strokeWidth={1.85} />
                                        </div>
                                    </div>
                                </div>
                                <h2 className="pq-leave-title">{t('my_car.leaving_this_spot')}</h2>
                                <p className="pq-leave-sub">{t('my_car.share_with_drivers')}</p>

                                {myCarDepartureError && (
                                    <p className="pq-leave-error">{myCarDepartureError}</p>
                                )}

                                <button
                                    type="button"
                                    onClick={() => handleMyCarPing(null)}
                                    disabled={myCarDepartureLoading}
                                    className="pq-leave-primary"
                                >
                                    <MapPin size={16} strokeWidth={2.2} />
                                    <span>{myCarDepartureLoading ? t('my_car.sharing') : t('ping_modal.leaving_now')}</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => {
                                        setMyCarDepartureTime(new Date(Date.now() + 2 * 60_000));
                                        setMyCarDepartureError(null);
                                        setMyCarDepartureView('timePicker');
                                    }}
                                    disabled={myCarDepartureLoading}
                                    className="pq-leave-secondary"
                                >
                                    <Clock size={15} strokeWidth={2.1} />
                                    <span>{t('ping_modal.leaving_later')}</span>
                                </button>
                                <button
                                    type="button"
                                    onClick={() => setShowDepartureSheet(false)}
                                    className="pq-leave-tertiary"
                                >
                                    {t('my_car.keep_saved')}
                                </button>
                            </div>
                        )}

                        {/* Time picker view */}
                        {!myCarPingSuccess && myCarDepartureView === 'timePicker' && (
                            <div className="pq-depart">
                                <div className="pq-depart-header">
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setMyCarDepartureError(null);
                                            if (departureSheetOriginRef.current === 'prompt') {
                                                setMyCarDepartureView('prompt');
                                            } else {
                                                setShowDepartureSheet(false);
                                                setShowSessionSheet(true);
                                            }
                                        }}
                                        className="pq-depart-back"
                                        aria-label={t('ping_modal.back')}
                                    >
                                        <ChevronLeft size={18} strokeWidth={2.2} />
                                    </button>
                                    <div className="pq-depart-heading">
                                        <h2 className="pq-depart-title">{t('ping_modal.set_departure')}</h2>
                                        <p className="pq-depart-sub">{t('my_car.planning_to_leave')}</p>
                                    </div>
                                </div>

                                <div className="pq-depart-section">
                                    <p className="pq-depart-label">{t('ping_modal.date')}</p>
                                    <GlassDatePicker
                                            id="pq-depart-date"
                                            value={myCarDepartureDate}
                                            min={localDateStr()}
                                            onChange={setMyCarDepartureDate}
                                        />
                                </div>

                                <div className="pq-depart-section">
                                    <p className="pq-depart-label">{t('ping_modal.time')}</p>
                                    <div className="pq-depart-time-card">
                                        <TimePicker
                                            initialTime={myCarDepartureTime}
                                            onTimeChange={setMyCarDepartureTime}
                                            variant="glass"
                                        />
                                    </div>
                                </div>

                                {myCarDepartureError && (
                                    <p className="pq-depart-error">{myCarDepartureError}</p>
                                )}

                                <button
                                    type="button"
                                    onClick={() => {
                                        const combined = combineDateAndTime(myCarDepartureDate, myCarDepartureTime);
                                        if (combined.getTime() <= Date.now()) {
                                            setMyCarDepartureError(t('ping_modal.future_time_error'));
                                            return;
                                        }
                                        handleMyCarPing(combined);
                                    }}
                                    disabled={myCarDepartureLoading}
                                    className="pq-depart-cta"
                                >
                                    <MapPin size={16} strokeWidth={2.2} />
                                    <span>{myCarDepartureLoading ? t('my_car.scheduling') : t('my_car.schedule_spot')}</span>
                                </button>
                            </div>
                        )}
                    </div>
                )}
            </BottomSheet>

            {/* Post-arrival handoff flow */}
            <BottomSheet isOpen={interestFlow.handoffStep !== null} ariaLabel="Handoff" onClose={() => {
                const wasCelebration = interestFlow.handoffStep === 'celebration';
                const coords = interestFlow.handoffSpotCoords;
                interestFlow.handleSkipDeparture();
                if (wasCelebration) {
                    if (!savedSpot && coords) saveMySpotFromCoords(coords.lat, coords.lng, coords.address);
                    else setShowSessionSheet(true);
                }
            }}>
                {interestFlow.handoffStep && (
                    <HandoffFlow
                        step={interestFlow.handoffStep}
                        finderName={interestFlow.handoffFinderName}
                        onOutcome={interestFlow.handleHandoffOutcome}
                        onFailureReason={interestFlow.handleFailureReason}
                        onSetTimer={(minutes) => parkingTimer.startTimer(minutes, interestFlow.handoffAddress)}
                        onSkip={() => {
                            const wasCelebration = interestFlow.handoffStep === 'celebration';
                            const coords = interestFlow.handoffSpotCoords;
                            interestFlow.handleSkipDeparture();
                            if (wasCelebration) {
                                if (!savedSpot && coords) saveMySpotFromCoords(coords.lat, coords.lng, coords.address);
                                else setShowSessionSheet(true);
                            }
                        }}
                    />
                )}
            </BottomSheet>

            {/* Spot stack sheet — multiple community shared spots nearby */}
            <BottomSheet isOpen={!!stackGroup} ariaLabel="Nearby pings" onClose={() => { setStackGroup(null); setNearbyPillSheet(false); }}>
                {stackGroup && (() => {
                    const nowMs2 = nowMs;
                    const origin2: [number, number] = userLocation ?? (() => {
                        const c = mapRef.current?.getCenter();
                        return c ? [c.lng, c.lat] : null;
                    })() ?? [stackGroup[0].lng, stackGroup[0].lat];
                    const distLabel = (item: MapItem) => {
                        const km = getDistance(origin2[1], origin2[0], item.lat, item.lng);
                        if (km < 0.5) return `${Math.round(km * 3280.84)} ft away`;
                        return `${(km * 0.621371).toFixed(1)} mi away`;
                    };
                    const getSpotMeta = (item: MapItem) => {
                        const ms = timestampToMillis(item.reportedAt);
                        const isScheduled = getPingPhase(item, nowMs2) === 'scheduled';
                        let statusLabel: string;
                        if (isScheduled) {
                            const d = new Date(ms);
                            const h = d.getHours() % 12 || 12;
                            const m = String(d.getMinutes()).padStart(2, '0');
                            const ampm = d.getHours() >= 12 ? 'PM' : 'AM';
                            statusLabel = t('map.leaving_at_time', { time: `${h}:${m} ${ampm}` });
                        } else {
                            statusLabel = t('spot_details.leaving_now');
                        }
                        const expiresMs = timestampToMillis(item.expiresAt);
                        const expiryMin = !isScheduled && expiresMs > nowMs2 ? Math.round((expiresMs - nowMs2) / 60000) : 0;
                        const address = item.address || item.title || t('map.nearby_shared_spot');
                        return { statusLabel, isScheduled, address, expiryMin };
                    };
                    const title = nearbyPillSheet ? t('map.nearby_spots_title') : t('map.pings_nearby', { count: stackGroup.length });
                    const subtitle = nearbyPillSheet ? t('map.nearby_spots_subtitle') : t('map.choose_spot');
                    return (
                        <div>
                            <p className="text-base font-bold text-[var(--color-text)] mb-0.5">{title}</p>
                            <p className="text-xs text-[var(--color-text-secondary)] mb-4">{subtitle}</p>
                            <div className="flex flex-col gap-2">
                                {stackGroup.map(item => {
                                    const { statusLabel, isScheduled, address, expiryMin } = getSpotMeta(item);
                                    const isOwnSpot = item.finderId === user?.id;
                                    if (isOwnSpot) {
                                        return (
                                            <div
                                                key={item.id}
                                                aria-disabled="true"
                                                className="flex items-start gap-3 w-full px-4 py-3.5 rounded-2xl bg-[var(--color-card)] border border-[var(--color-border)] opacity-50 cursor-default"
                                            >
                                                <div className="w-2 h-2 rounded-full shrink-0 mt-1 bg-[var(--color-text-secondary)]" />
                                                <div className="flex-1 min-w-0">
                                                    <p className="text-sm font-semibold text-[var(--color-text)]">{t('map.your_spot')}</p>
                                                    <p className="text-xs text-[var(--color-text-secondary)] truncate">{t('map.your_ping_label')}</p>
                                                </div>
                                            </div>
                                        );
                                    }
                                    return (
                                        <button
                                            key={item.id}
                                            onClick={() => {
                                                const fresh = itemsRef.current.find(i => i.id === item.id);
                                                if (!fresh) {
                                                    setPillToast(t('map.spot_no_longer_available'));
                                                    setStackGroup(null);
                                                    setNearbyPillSheet(false);
                                                    return;
                                                }
                                                setStackGroup(null);
                                                setNearbyPillSheet(false);
                                                mapRef.current?.flyTo({ center: [fresh.lng, fresh.lat], zoom: 17, duration: 800 });
                                                setSpotDetailsBackStack(stackGroup);
                                                setSelectedItem(fresh);
                                            }}
                                            className="flex items-start gap-3 w-full px-4 py-3.5 rounded-2xl bg-[var(--color-card)] border border-[var(--color-border)] text-left hover:border-[#1e75ff]/40 transition-all active:scale-[0.98]"
                                        >
                                            <div className={`w-2 h-2 rounded-full shrink-0 mt-1 ${isScheduled ? 'bg-yellow-400' : 'bg-emerald-400'}`} />
                                            <div className="flex-1 min-w-0">
                                                <p className="text-sm font-semibold text-[var(--color-text)]">{statusLabel}</p>
                                                <p className="text-xs text-[var(--color-text-secondary)] truncate">{address}</p>
                                                <p className="text-xs text-[var(--color-text-secondary)]">{distLabel(item)}{expiryMin > 0 ? ` · ${t('map.expires_in_min', { min: expiryMin })}` : ''}</p>
                                            </div>
                                            <span className="text-[var(--color-text-secondary)] text-xs mt-0.5">›</span>
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })()}
            </BottomSheet>

            {/* Parking Activity Explorer */}
            {search.selectedDestination && (
                <ParkingActivitySheet
                    destination={search.selectedDestination}
                    nowMs={nowMs}
                    onExplore={() => {
                        const dest = search.selectedDestination!;
                        mapRef.current?.easeTo({
                            center: dest.center,
                            zoom: 14,
                            duration: 800,
                        });
                        search.clearDestination();
                    }}
                    onDismiss={search.clearDestination}
                />
            )}

            {/* Finder notification: someone is heading to their spot */}
            {(() => {
                const interestedSpot = spotData.freeSpots.find(s => s.finderId === user?.id && s.status === 'interested');
                if (!interestedSpot || selectedItem?.id === interestedSpot.id) return null;
                const name = interestedSpot.interestedUserName || 'Someone';
                const initial = name.charAt(0).toUpperCase();
                return (
                    <button
                        onClick={() => { setSelectedItem(interestedSpot); setSelectedItemManageMode(false); }}
                        className="absolute top-24 left-1/2 -translate-x-1/2 w-[90%] max-w-[360px] z-50 backdrop-blur-xl rounded-2xl shadow-2xl pointer-events-auto overflow-hidden active:scale-[0.98] transition-transform text-left"
                        style={{ background: 'rgba(5,13,28,0.82)', border: '1px solid rgba(30,117,255,0.3)' }}
                    >
                        <div className="px-4 py-3.5 flex items-center gap-3">
                            <div className="w-10 h-10 rounded-full flex items-center justify-center shrink-0 text-white font-bold text-sm"
                                style={{ background: 'linear-gradient(135deg, var(--color-brand), var(--color-brand-2))' }}>
                                {initial}
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-[11px] font-semibold text-[var(--color-info)] uppercase tracking-wider mb-0.5">
                                    {interestedSpot.claimState === 'committed' ? t('scheduled_claim.owner_eyebrow') : t('en_route.heading')}
                                </p>
                                <p className="text-sm font-bold text-white truncate">{name}</p>
                                {interestedSpot.claimState === 'committed'
                                    ? <p className="text-[11px] text-white/55 mt-0.5">{t('en_route.tap_details')}</p>
                                    : interestedSpot.etaMinutes != null
                                        ? <p className="text-[11px] text-white/55 mt-0.5">{interestedSpot.etaMinutes < 1 ? t('en_route.eta_under_1') : t('en_route.eta', { eta: interestedSpot.etaMinutes })} · {t('en_route.tap_details')}</p>
                                        : <p className="text-[11px] text-white/55 mt-0.5">{t('en_route.calculating')}</p>
                                }
                            </div>
                            <ChevronRight size={16} className="text-white/30 shrink-0" />
                        </div>
                    </button>
                );
            })()}

            <div className="sp-map">
                <div ref={mapContainerRef} style={{ width: '100%', height: '100%' }} onClick={() => setSelectedItem(null)} />
            </div>

            {!mapReady && (
                <div className="absolute inset-0 z-20 bg-[var(--color-bg)] flex items-center justify-center">
                    <div className="animate-spin w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full" />
                </div>
            )}

            <div className="map-blue-tint-color" />
            <div className="map-blue-tint-overlay" />
            <div className="map-blue-tint-soft" />

            {pingError && (
                <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 bg-red-500/90 text-white text-sm font-medium rounded-2xl shadow-lg backdrop-blur-sm max-w-[85vw] text-center pointer-events-none">
                    {pingError}
                </div>
            )}

            {showDeleteConfirm && (
                <AccessibleModal
                    ariaLabel={t('map.delete_confirm_title')}
                    initialFocusRef={deletePingCancelRef}
                    onDismiss={() => setShowDeleteConfirm(false)}
                    overlayClassName="absolute inset-0 z-[200] flex items-end justify-center pb-10 bg-black/50 backdrop-blur-sm"
                    panelClassName="bg-[var(--color-card)] border border-[var(--color-border)] rounded-3xl p-6 mx-4 w-full max-w-sm shadow-2xl"
                >
                        <p className="text-base font-bold text-[var(--color-text)] text-center mb-1">{t('map.delete_confirm_title')}</p>
                        <p className="text-sm text-[var(--color-text-secondary)] text-center mb-6">{t('map.delete_confirm_body')}</p>
                        <div className="flex gap-3">
                            <button ref={deletePingCancelRef} onClick={() => setShowDeleteConfirm(false)} className="flex-1 py-3 rounded-2xl border border-[var(--color-border)] text-[var(--color-text)] font-semibold text-sm">
                                {t('map.delete_cancel')}
                            </button>
                            <button onClick={doDeletePing} className="flex-1 py-3 rounded-2xl bg-red-500/20 border border-red-500/40 text-[var(--color-danger)] font-bold text-sm">
                                {t('map.delete_confirm_btn')}
                            </button>
                        </div>
                </AccessibleModal>
            )}

            {showPingConfirmation && (
                <div className="absolute inset-0 z-50 flex items-start justify-center pt-28 pointer-events-none">
                    <div className="ping-celebration flex flex-col items-center gap-5">
                        <div className="relative flex items-center justify-center">
                            <div className="ping-ring" />
                            <div className="ping-ring ping-ring-2" />
                            <div className="ping-ring ping-ring-3" />
                            <img
                                src="/Parqueen_Logo.png"
                                alt="ParkQueen"
                                className="ping-logo-drop relative z-10 w-20 h-20 object-contain drop-shadow-2xl"
                            />
                        </div>
                        <div className="ping-text-fade text-center">
                            <p className="text-2xl font-extrabold text-white tracking-tight drop-shadow-lg">{t('my_car.spot_pinged')}</p>
                            <p className="text-sm text-white/70 mt-1 font-medium">{t('my_car.nearby_notified')}</p>
                        </div>
                    </div>
                </div>
            )}

            {interestFlow.finderToast && (
                <div className="absolute top-20 left-0 right-0 flex justify-center z-20 px-4 pointer-events-none">
                    <button
                        onClick={interestFlow.clearFinderToast}
                        className={`notif-slide-down pointer-events-auto flex items-start gap-3 px-4 py-3.5 rounded-2xl backdrop-blur-xl shadow-2xl border max-w-sm w-full text-left active:scale-[0.98] transition-transform ${
                            interestFlow.finderToastVariant === 'success'
                                ? 'bg-emerald-950/85 border-emerald-500/25'
                                : 'bg-slate-900/90 border-blue-500/20'
                        }`}
                    >
                        <div className={`mt-0.5 shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${interestFlow.finderToastVariant === 'success' ? 'bg-emerald-500/20' : 'bg-blue-500/20'}`}>
                            {interestFlow.finderToastVariant === 'success'
                                ? <CheckCircle2 size={16} className="text-[var(--color-success)]" />
                                : <Bell size={16} className="text-[var(--color-accent)]" />}
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className={`text-sm font-semibold leading-snug ${interestFlow.finderToastVariant === 'success' ? 'text-[var(--color-success)]' : 'text-[var(--color-accent)]'}`}>
                                {interestFlow.finderToastTitle}
                            </p>
                            <p className="text-xs text-white/55 mt-0.5 leading-snug">{interestFlow.finderToast}</p>
                        </div>
                        <X size={13} className="text-white/25 shrink-0 mt-1" />
                    </button>
                </div>
            )}

            {interestFlow.driverNotification && (
                <div className="absolute top-20 left-0 right-0 flex justify-center z-20 px-4 pointer-events-none">
                    <button
                        onClick={interestFlow.clearDriverNotification}
                        className={`notif-slide-down pointer-events-auto flex items-start gap-3 px-4 py-3.5 rounded-2xl backdrop-blur-xl shadow-2xl border max-w-sm w-full text-left active:scale-[0.98] transition-transform ${
                            interestFlow.driverNotifVariant === 'success'
                                ? 'bg-emerald-950/85 border-emerald-500/25'
                                : interestFlow.driverNotifVariant === 'warning'
                                ? 'bg-amber-950/85 border-amber-500/25'
                                : 'bg-slate-900/90 border-blue-500/20'
                        }`}
                    >
                        <div className={`mt-0.5 shrink-0 w-8 h-8 rounded-full flex items-center justify-center ${
                            interestFlow.driverNotifVariant === 'success' ? 'bg-emerald-500/20'
                            : interestFlow.driverNotifVariant === 'warning' ? 'bg-amber-500/20'
                            : 'bg-blue-500/20'
                        }`}>
                            {interestFlow.driverNotifVariant === 'success'
                                ? <CheckCircle2 size={16} className="text-[var(--color-success)]" />
                                : interestFlow.driverNotifVariant === 'warning'
                                ? <Clock size={16} className="text-[var(--color-warning)]" />
                                : <Bell size={16} className="text-[var(--color-accent)]" />}
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className={`text-sm font-semibold leading-snug ${
                                interestFlow.driverNotifVariant === 'success' ? 'text-[var(--color-success)]'
                                : interestFlow.driverNotifVariant === 'warning' ? 'text-[var(--color-warning)]'
                                : 'text-[var(--color-accent)]'
                            }`}>{interestFlow.driverNotifTitle}</p>
                            <p className="text-xs text-white/55 mt-0.5 leading-snug">{interestFlow.driverNotification}</p>
                        </div>
                        <X size={13} className="text-white/25 shrink-0 mt-1" />
                    </button>
                </div>
            )}

            <div className="sp-overlay flex flex-col justify-between p-0 md:p-3 pointer-events-none">
                <HeaderBar
                    user={user}
                    setView={setView}
                    inputRef={search.inputRef}
                    searchQuery={search.searchQuery}
                    setSearchQuery={search.setSearchQuery}
                    searchOpen={search.searchOpen}
                    setSearchOpen={search.setSearchOpen}
                    results={search.results}
                    setResults={search.setResults}
                    loading={search.loading}
                    handleCancelSearch={search.handleCancelSearch}
                    unreadMessagesCount={unreadMessagesCount}
                    pendingUpdatesCount={spotData.pendingUpdatesCount}
                    setPendingUpdatesCount={spotData.setPendingUpdatesCount}
                    onSelectResult={search.handleSelectResult}
                />

                {!search.searchOpen && (
                    <div className="map-status-row md:w-full max-w-none md:max-w-[380px] mx-auto pointer-events-auto">
                        {spotCount > 0 ? (
                            <div className="flex items-center gap-1.5 flex-wrap">
                                <button
                                    onClick={handleNearbyPillClick}
                                    aria-label={spotCount === 1 ? t('map.view_nearby_spot') : t('map.view_nearby_spots')}
                                    className="map-status-chip is-available inline-flex items-center gap-2.5 text-[12px] font-medium cursor-pointer active:scale-95 active:opacity-80 transition-transform"
                                >
                                    <div className="map-status-dot bg-emerald-400 animate-pulse motion-reduce:animate-none shrink-0" />
                                    {spotCount === 1 ? t('map.free_spot_singular') : t('map.free_spots_plural', { count: spotCount })}
                                    <ChevronRight size={10} className="opacity-60 shrink-0" />
                                </button>
                            </div>
                        ) : mapReady && !spotData.activeSpots.find(s => s.finderId === user?.id) && (
                            <div className="map-status-chip is-empty inline-flex items-center gap-2.5 text-[12px] font-medium">
                                <div className="map-status-dot bg-[#9bb0c7]/80 shrink-0" />
                                {t('map.no_spots_nearby')}
                            </div>
                        )}
                        {pillToast && (
                            <div className="mt-1.5 inline-flex items-center gap-1.5 bg-[var(--color-card)] backdrop-blur-xl border border-white/10 rounded-full px-2.5 py-1 text-[10px] font-semibold text-[var(--color-text-secondary)] shadow-md">
                                {pillToast}
                            </div>
                        )}
                    </div>
                )}


                <div className="mobile-map-controls w-full flex flex-col gap-3 pointer-events-auto mt-auto pb-0 px-0 md:pb-16 md:px-4">

                    {/* Car (toggle) + Locate stacked vertically on the right */}
                    <div className="map-secondary-controls flex flex-col items-end gap-3 max-w-none md:max-w-[380px] mx-auto w-full mb-3">
                        {userLocation && (
                            <button
                                data-tour="my-car"
                                onClick={() => {
                                    if (!savedSpot) saveMySpot();
                                    else if (isNearSavedSpot) setShowDepartureSheet(true);
                                    else setShowSessionSheet(true);
                                }}
                                title={t('common.my_car')}
                                className={`map-control-button flex items-center justify-center transition-all active:scale-90 ${
                                    savedSpot
                                        ? 'is-active'
                                        : ''
                                }`}
                            >
                                <Car size={21} className={savedSpot ? 'text-white' : 'text-[var(--color-accent)]'} />
                            </button>
                        )}
                        <button
                            onClick={handleLocateMe}
                            className="map-control-button flex items-center justify-center transition-all active:scale-90"
                            title="Locate Me"
                        >
                            <Locate size={22} className="text-[var(--color-accent)]" />
                        </button>
                    </div>

                    {/* Timer chip — subtle indicator that a reminder is active */}
                    {parkingTimer.timer && savedSpot && (
                        <div className="map-timer-chip max-w-[380px] mx-auto w-full pointer-events-auto">
                            <button
                                onClick={() => setShowSessionSheet(true)}
                                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-full bg-[var(--color-card)] backdrop-blur-xl border border-[#1e75ff]/20 shadow-md">
                                <Clock size={11} className="text-[var(--color-info)]" />
                                <p className="text-[11px] font-semibold text-[var(--color-info)]">{t('my_car.timer_chip', { min: parkingTimer.minutesRemaining })}</p>
                            </button>
                        </div>
                    )}


                    {(() => {
                        // My Car-linked pings must not override the "My Parked Car" label.
                        // isMyCarMode wins whenever savedSpot exists, even if the session has a linked ping.
                        const myPing = spotData.activeSpots.find(s => s.finderId === user?.id && s.id !== savedSpot?.linkedPingId);
                        const hasActivePing = !!myPing;
                        const isMyCarMode = !!savedSpot;
                        return (
                            <button
                                data-tour="share-spot"
                                onClick={handlePrimaryMapAction}
                                disabled={!user}
                                className={`map-primary-cta${isMyCarMode ? ' is-car-mode' : ''} hidden md:inline-flex relative mx-auto active:scale-[0.98] text-white disabled:opacity-50 transition-transform duration-200`}
                            >
                                {isMyCarMode ? (
                                    <div className="flex items-center justify-center gap-2.5 w-full px-8">
                                        <VehicleIcon type={user?.vehicleType} color="White" size={22} />
                                        <div className="text-center">
                                            <p className="text-[17px] font-bold leading-tight whitespace-nowrap">{t('my_car.parked_car_label')}</p>
                                            {myCarDistanceLabel && myCarDistanceLabel !== "You're here" && (
                                                <p className="text-[10px] font-semibold text-white/70 whitespace-nowrap leading-tight">
                                                    {myCarDistanceLabel}
                                                </p>
                                            )}
                                            {myCarDistanceLabel === "You're here" && (
                                                <p className="text-[10px] font-semibold text-[var(--color-success)] whitespace-nowrap leading-tight">
                                                    {t('my_car.youve_arrived')}
                                                </p>
                                            )}
                                        </div>
                                    </div>
                                ) : (
                                    <>
                                        <span className="map-primary-cta-icon" aria-hidden="true">
                                            <MapPin size={26} strokeWidth={2.15} />
                                        </span>
                                        <span className="map-primary-cta-label whitespace-nowrap">
                                            {hasActivePing ? t('common.my_ping') : t('common.ping_your_spot')}
                                        </span>
                                    </>
                                )}
                            </button>
                        );
                    })()}

                </div>
            </div>

            {showTour && <AppTour onDone={() => setShowTour(false)} />}

            {/* ?debugStreet=1 — Street Intelligence debug panel. Never shown to normal users. */}
            {isDebugMode && (
                <div style={{ position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 9999, maxHeight: '45vh', display: 'flex', flexDirection: 'column', background: 'rgba(0,0,0,0.92)', borderTop: '1.5px solid #1e75ff', fontFamily: 'monospace', fontSize: 11 }}>
                    <div style={{ display: 'flex', alignItems: 'center', borderBottom: '1px solid #1e75ff33' }}>
                        <div
                            onClick={() => setDebugPanelOpen(o => !o)}
                            style={{ flex: 1, padding: '4px 10px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', userSelect: 'none' }}
                        >
                            <span style={{ color: 'var(--color-brand)', fontWeight: 700 }}>🛠 StreetIntelDebug {debugLines.length ? `(${debugLines.length})` : ''}</span>
                            <span style={{ color: '#888' }}>{debugPanelOpen ? '▼' : '▲'}</span>
                        </div>
                        {isDebugAdmin && (
                            <button
                                onClick={testCFDirect}
                                disabled={cfTestLoading}
                                style={{ margin: '2px 6px', padding: '2px 8px', fontSize: 10, fontFamily: 'monospace', background: cfTestLoading ? '#333' : '#1e3a5f', color: '#38bdf8', border: '1px solid #1e75ff', borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap' }}
                            >
                                {cfTestLoading ? 'testing…' : 'Test CF ⚡'}
                            </button>
                        )}
                    </div>
                    {debugPanelOpen && (
                        <div style={{ overflowY: 'auto', flex: 1, padding: '6px 10px 10px' }}>
                            {isDebugAdmin && (
                            <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginBottom: 6, flexWrap: 'wrap' }}>
                                <input
                                    value={manualLat}
                                    onChange={e => setManualLat(e.target.value)}
                                    placeholder="lat e.g. 40.8419"
                                    style={{ flex: 1, minWidth: 110, padding: '2px 6px', fontSize: 10, fontFamily: 'monospace', background: '#111', color: '#e2e8f0', border: '1px solid #334', borderRadius: 4 }}
                                />
                                <input
                                    value={manualLng}
                                    onChange={e => setManualLng(e.target.value)}
                                    placeholder="lng e.g. -73.8696"
                                    style={{ flex: 1, minWidth: 110, padding: '2px 6px', fontSize: 10, fontFamily: 'monospace', background: '#111', color: '#e2e8f0', border: '1px solid #334', borderRadius: 4 }}
                                />
                                <button
                                    onClick={testCFManual}
                                    disabled={cfManualLoading}
                                    style={{ padding: '2px 8px', fontSize: 10, fontFamily: 'monospace', background: cfManualLoading ? '#333' : '#1a3a1a', color: '#4ade80', border: '1px solid #166534', borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap' }}
                                >
                                    {cfManualLoading ? 'testing…' : 'Test Manual CF 🗺'}
                                </button>
                                <button
                                    onClick={simulateMyCarSave}
                                    disabled={simSaveLoading}
                                    style={{ padding: '2px 8px', fontSize: 10, fontFamily: 'monospace', background: simSaveLoading ? '#333' : '#1a1a3a', color: '#a78bfa', border: '1px solid #4c1d95', borderRadius: 4, cursor: 'pointer', whiteSpace: 'nowrap' }}
                                >
                                    {simSaveLoading ? 'simulating…' : 'Simulate My Car Save 🧪'}
                                </button>
                            </div>
                            )}
                            {savedSpot && (
                                <p style={{ margin: '2px 0 4px', fontSize: 10, color: '#94a3b8', fontFamily: 'monospace' }}>
                                    savedSpot: status={savedSpot.streetIntelStatus ?? 'null'} reason={savedSpot.streetIntelReason ?? 'null'} segmentId={savedSpot.segmentId ?? 'null'} checkedAt={savedSpot.streetIntelCheckedAt ?? 'null'}
                                </p>
                            )}
                            {debugLines.length === 0
                                ? <p style={{ color: '#666', margin: 0 }}>No events yet — save a My Car spot to begin.</p>
                                : debugLines.map((line, i) => {
                                    const isWarn = line.includes('⚠️') || line.includes('threw') || line.includes('null');
                                    return (
                                        <p key={i} style={{ margin: '1px 0', color: isWarn ? '#f87171' : '#a3e635', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                                            {line}
                                        </p>
                                    );
                                })
                            }
                        </div>
                    )}
                </div>
            )}

            {mapPrimaryNavigationVisible && (
                <NavigationBar
                    currentView={AppView.MAP}
                    setView={setView}
                    unreadMessagesCount={unreadMessagesCount}
                    pendingUpdatesCount={spotData.pendingUpdatesCount}
                    onPing={handlePrimaryMapAction}
                    pingDisabled={!user}
                />
            )}
        </div>
    );
};
