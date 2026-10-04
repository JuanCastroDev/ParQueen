import { useState, useEffect, useRef, useCallback } from 'react';
import { db } from '../../firebase';
import { doc, updateDoc, deleteDoc, Timestamp, collection, query, where, getDocs, addDoc, setDoc, onSnapshot, orderBy, limit } from 'firebase/firestore';
import { MapItem } from './types';
import { getDistance, drawRoute, clearRoute, NYC_CENTER } from './utils';
import { getTitleForCrowns } from '../../utils/crowns';
import { getPingExpiresAtMs, timestampToMillis } from '../../utils/pingLifecycle';
import { commitPingCreate, PING_SCHEDULE_HORIZON_MS, PingCreateRejected } from './pingCreateBounds';
import { cancelClaimTransaction } from './cancelClaimTransaction';
import { acquireActiveIncomingClaim, ALREADY_CLAIMED_MESSAGE, markClaimArrived } from './activeIncomingClaim';
import { commitClaimToHeading } from './commitToHeading';
import { reportClaimFailure, reportClaimCancelFailure } from './claimFailureReporting';
import { reportCriticalActionFailure } from '../../utils/errorReporting';
import { t } from '../../i18n';
import { completeFinderConfirmedHandoff, completeTerminalHandoff } from './completeTerminalHandoff';
import { isHandoffFailureReason } from '../../utils/spotFeedback';
import {
    claimerArrivedSpotsQuery,
    claimerTerminalFeedbackQuery,
    selectUnfinishedHandoff,
    terminalSpotIdsFromFeedback,
    type ClaimerSpotRecord,
    type UnfinishedHandoff,
} from './unfinishedHandoff';
import { ARRIVAL_DISTANCE_KM } from './arrivalLocation';

interface UseInterestFlowOptions {
    selectedItem: any;
    setSelectedItem: React.Dispatch<React.SetStateAction<any>>;
    user: any;
    freeSpots: MapItem[];
    userLocation: [number, number] | null;
    mapRef: React.RefObject<mapboxgl.Map | null>;
    activeRouteDestinationRef: React.MutableRefObject<[number, number] | null>;
}

/** Maps a departure re-ping denial to copy. Does not decide whether the write is allowed. */
export function departurePingDenialCopy(error: unknown): { title: string; message: string } {
    const title = t('ping_errors.denied_title');
    if (error instanceof PingCreateRejected && error.reason === 'rate') {
        return { title, message: t('ping_errors.rate_limit', { min: error.minutesLeft ?? 1 }) };
    }
    if (error instanceof PingCreateRejected && error.reason === 'origin') {
        return { title, message: t('ping_errors.origin') };
    }
    if (error instanceof PingCreateRejected && error.reason === 'horizon') {
        return { title, message: t('ping_errors.horizon') };
    }
    return { title, message: t('ping_errors.save_failed') };
}

const MAX_ETA_MINUTES = 7;
const MAX_CLAIM_MINUTES = 15;
const ETA_OPTIONS = [2, 5, 8, 10];
const kmToEstMinutes = (km: number) => Math.ceil((km / 25) * 60);

export function useInterestFlow({
    selectedItem, setSelectedItem, user, freeSpots, userLocation, mapRef, activeRouteDestinationRef
}: UseInterestFlowOptions) {
    const [trackedItemId, setTrackedItemId] = useState<string | null>(null);
    const [interestError, setInterestError] = useState<string | null>(null);
    const [cancelingClaim, setCancelingClaim] = useState(false);
    const cancelingClaimRef = useRef(false);
    // Session UX guards only. A1 still decides whether a claim or arrival write commits.
    const [claiming, setClaiming] = useState(false);
    const claimingRef = useRef(false);
    const [arriving, setArriving] = useState(false);
    const arrivingRef = useRef(false);
    const lastWrittenEtaRef = useRef<number | null>(null);
    const etaWriteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const expiryWarnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const [handoffStep, setHandoffStep] = useState<'outcome' | 'celebration' | 'failure_reason' | null>(null);
    const [handoffSubmitError, setHandoffSubmitError] = useState<string | null>(null);
    const [handoffSubmitting, setHandoffSubmitting] = useState(false);
    const handoffSubmitLock = useRef(false);
    const lastTerminalAttempt = useRef<
        | { outcome: 'success' }
        | { outcome: 'failed'; reason: string }
        | null
    >(null);
    const [handoffFinderName, setHandoffFinderName] = useState<string | null>(null);
    const [handoffAddress, setHandoffAddress] = useState<string>('');
    const handoffSpotRef = useRef<{
        id: string; lat: number; lng: number; address?: string;
        finderId: string; finderName: string; geohash?: string;
    } | null>(null);
    const [handoffSpotCoords, setHandoffSpotCoords] = useState<{ lat: number; lng: number; address: string } | null>(null);
    const [unfinishedHandoff, setUnfinishedHandoff] = useState<UnfinishedHandoff | null>(null);
    const arrivedSpotsRef = useRef<ClaimerSpotRecord[]>([]);
    const terminalSpotIdsRef = useRef<Set<string>>(new Set());
    const optimisticTerminalRef = useRef<Set<string>>(new Set());
    const resumeReadyRef = useRef({ spots: false, feedback: false });
    const resumeUserIdRef = useRef<string | undefined>(user?.id);
    resumeUserIdRef.current = user?.id;
    const [finderToast, setFinderToast] = useState<string | null>(null);
    const [finderToastTitle, setFinderToastTitle] = useState<string | null>(null);
    const [finderToastVariant, setFinderToastVariant] = useState<'success' | 'info'>('success');
    const [driverNotification, setDriverNotification] = useState<string | null>(null);
    const [driverNotifTitle, setDriverNotifTitle] = useState<string | null>(null);
    const [driverNotifVariant, setDriverNotifVariant] = useState<'success' | 'warning' | 'info'>('info');

    // Listen for notifications targeted at this user (as the interested driver)
    useEffect(() => {
        if (!user?.id) return;
        const q = query(
            collection(db, 'spotNotifications'),
            where('targetUserId', '==', user.id),
            orderBy('createdAt', 'desc'),
            limit(1)
        );
        const unsub = onSnapshot(q, (snap) => {
            snap.docChanges().forEach(change => {
                if (change.type === 'added') {
                    const data = change.doc.data();
                    const notifMeta: Record<string, { title: string; variant: 'success' | 'warning' | 'info' }> = {
                        cancelled: { title: 'Spot cancelled', variant: 'warning' },
                        claimer_cancelled: { title: 'Spot available again', variant: 'success' },
                        owner_leaving_now: { title: 'Owner leaving now', variant: 'info' },
                        scheduled_claim_auto_released: { title: 'Claim released', variant: 'warning' },
                        handoff_success: { title: "You're parked!", variant: 'success' },
                        delayed: { title: 'Small delay', variant: 'info' },
                    };
                    const meta = notifMeta[data.type] ?? { title: 'Update', variant: 'info' as const };
                    setDriverNotification(data.message);
                    setDriverNotifTitle(meta.title);
                    setDriverNotifVariant(meta.variant);
                    setTimeout(() => { setDriverNotification(null); setDriverNotifTitle(null); }, 5000);
                    if (data.type === 'cancelled') {
                        setTrackedItemId(null);
                        activeRouteDestinationRef.current = null;
                        if (mapRef.current) clearRoute(mapRef.current);
                        setSelectedItem(null);
                    }
                    if (data.type === 'owner_leaving_now') {
                        // UI updates via live snapshot; toast is the only action here
                    }
                    if (data.type === 'scheduled_claim_auto_released') {
                        setTrackedItemId(null);
                        setSelectedItem(null);
                    }
                    if (data.type === 'handoff_success') {
                        setFinderToast(data.message);
                        setFinderToastTitle('Confirmed!');
                        setFinderToastVariant('success');
                        setTimeout(() => setFinderToast(null), 6000);
                    }
                    deleteDoc(change.doc.ref).catch(() => {});
                }
            });
        });
        return () => unsub();
    }, [user?.id]);

    // Claimer-scoped resume. Occupied arrived Pings are not on the public map
    // feed. Dismissing the sheet does not write; only terminal feedback clears this.
    useEffect(() => {
        if (!user?.id || !db) {
            arrivedSpotsRef.current = [];
            terminalSpotIdsRef.current = new Set();
            optimisticTerminalRef.current = new Set();
            resumeReadyRef.current = { spots: false, feedback: false };
            setUnfinishedHandoff(null);
            return;
        }
        const uid = user.id;
        let cancelled = false;
        arrivedSpotsRef.current = [];
        terminalSpotIdsRef.current = new Set();
        optimisticTerminalRef.current = new Set();
        resumeReadyRef.current = { spots: false, feedback: false };

        const publish = () => {
            if (cancelled || !resumeReadyRef.current.spots || !resumeReadyRef.current.feedback) return;
            setUnfinishedHandoff(selectUnfinishedHandoff(
                arrivedSpotsRef.current,
                terminalSpotIdsRef.current,
                uid,
            ));
        };

        const unsubSpots = onSnapshot(
            claimerArrivedSpotsQuery(db, uid),
            (snap) => {
                arrivedSpotsRef.current = snap.docs.map((spotDoc) => ({ id: spotDoc.id, data: spotDoc.data() }));
                resumeReadyRef.current.spots = true;
                publish();
            },
            () => {
                arrivedSpotsRef.current = [];
                resumeReadyRef.current.spots = true;
                publish();
            },
        );
        const unsubFeedback = onSnapshot(
            claimerTerminalFeedbackQuery(db, uid),
            (snap) => {
                const ids = terminalSpotIdsFromFeedback(snap.docs);
                for (const id of optimisticTerminalRef.current) ids.add(id);
                terminalSpotIdsRef.current = ids;
                resumeReadyRef.current.feedback = true;
                publish();
            },
            () => {
                resumeReadyRef.current.feedback = false;
                if (!cancelled) setUnfinishedHandoff(null);
            },
        );
        return () => {
            cancelled = true;
            unsubSpots();
            unsubFeedback();
        };
    }, [user?.id]);

    const noteTerminalHandoff = useCallback((spotId: string) => {
        optimisticTerminalRef.current.add(spotId);
        terminalSpotIdsRef.current.add(spotId);
        const uid = resumeUserIdRef.current;
        if (!uid || !resumeReadyRef.current.spots || !resumeReadyRef.current.feedback) {
            setUnfinishedHandoff((current) => (current?.id === spotId ? null : current));
            return;
        }
        setUnfinishedHandoff(selectUnfinishedHandoff(
            arrivedSpotsRef.current,
            terminalSpotIdsRef.current,
            uid,
        ));
    }, []);

    const resumeUnfinishedHandoff = useCallback(() => {
        if (!unfinishedHandoff) return;
        handoffSpotRef.current = {
            id: unfinishedHandoff.id,
            lat: unfinishedHandoff.lat,
            lng: unfinishedHandoff.lng,
            address: unfinishedHandoff.address,
            finderId: unfinishedHandoff.finderId,
            finderName: unfinishedHandoff.finderName,
            geohash: unfinishedHandoff.geohash,
        };
        setHandoffFinderName(unfinishedHandoff.finderName || null);
        setHandoffAddress(unfinishedHandoff.address || '');
        // Kill, refresh, and sheet dismiss all reopen at the outcome step.
        setHandoffStep('outcome');
    }, [unfinishedHandoff]);

    // Dynamic ETA: debounce-write claimer's estimated drive time back to Firestore
    useEffect(() => {
        if (!trackedItemId || !userLocation || !db) return;
        const spot = freeSpots.find(s => s.id === trackedItemId);
        if (!spot) return;
        // Don't write ETA for committed claims — claimer isn't heading there yet
        if (spot.claimState === 'committed') return;

        const km = getDistance(userLocation[1], userLocation[0], spot.lat, spot.lng);
        const estMinutes = Math.max(1, Math.ceil((km / 25) * 60));

        if (lastWrittenEtaRef.current !== null && Math.abs(estMinutes - lastWrittenEtaRef.current) < 1) return;

        if (etaWriteTimerRef.current) clearTimeout(etaWriteTimerRef.current);
        etaWriteTimerRef.current = setTimeout(async () => {
            try {
                await updateDoc(doc(db, 'spots', trackedItemId), { etaMinutes: estMinutes });
                lastWrittenEtaRef.current = estMinutes;
            } catch {}
        }, 30_000);

        return () => { if (etaWriteTimerRef.current) clearTimeout(etaWriteTimerRef.current); };
    }, [trackedItemId, userLocation, freeSpots]);

    // Pre-expiry warning: notify claimer 2 minutes before claim expires
    useEffect(() => {
        if (expiryWarnTimerRef.current) clearTimeout(expiryWarnTimerRef.current);
        if (!trackedItemId) return;
        const spot = freeSpots.find(s => s.id === trackedItemId);
        if (!spot?.interestExpiresAt) return;

        const expiresMs = typeof spot.interestExpiresAt.toMillis === 'function'
            ? spot.interestExpiresAt.toMillis()
            : new Date(spot.interestExpiresAt).getTime();

        const delay = expiresMs - 2 * 60 * 1000 - Date.now();
        if (delay <= 0) return;

        expiryWarnTimerRef.current = setTimeout(() => {
            setDriverNotification("Your claim expires in 2 minutes — still heading there?");
            setDriverNotifTitle('Heads up');
            setDriverNotifVariant('warning');
            setTimeout(() => { setDriverNotification(null); setDriverNotifTitle(null); }, 8000);
        }, delay);

        return () => { if (expiryWarnTimerRef.current) clearTimeout(expiryWarnTimerRef.current); };
    }, [trackedItemId, freeSpots]);

    const getEstDriveMinutes = (spot: MapItem): number | null => {
        if (!userLocation) return null;
        const km = getDistance(userLocation[1], userLocation[0], spot.lat, spot.lng);
        return kmToEstMinutes(km);
    };

    const isWithinArrivalRange = (spot: MapItem): boolean => {
        if (!userLocation) return false;
        return getDistance(userLocation[1], userLocation[0], spot.lat, spot.lng) <= ARRIVAL_DISTANCE_KM;
    };

    const checkAlreadyInterested = async (): Promise<boolean> => {
        if (!user?.id) return false;
        const q = query(collection(db, 'spots'), where('interestedUserId', '==', user.id), where('status', '==', 'interested'));
        const snap = await getDocs(q);
        return !snap.empty;
    };

    // checkAlreadyInterested is a UX hint only. The transaction + Rules are
    // the authority. A rules denial while another interested Ping exists is
    // the multi-claim rejection; other denials keep the generic fallback.
    const claimErrorMessage = async (error: any, fallback: string): Promise<string> => {
        if (error?.message === ALREADY_CLAIMED_MESSAGE) return ALREADY_CLAIMED_MESSAGE;
        if (error?.code === 'permission-denied') {
            try {
                if (await checkAlreadyInterested()) return ALREADY_CLAIMED_MESSAGE;
            } catch {
                // Fall through to the generic message.
            }
        }
        return error?.message || fallback;
    };

    const claimerFields = (claimStartedAt: Timestamp, claimState: 'heading' | 'committed') => ({
        status: 'interested' as const,
        claimState,
        ownerLeavingNow: null,
        interestedUserId: user.id,
        interestedUserName: user.username || user.fullName || 'Someone',
        interestedUserVehicleColor: user.vehicleColor || null,
        interestedUserVehicleType: user.vehicleType || null,
        interestedUserVehicleBrand: user.vehicleBrand || null,
        interestedUserTitle: getTitleForCrowns(user.crowns || 0),
        claimStartedAt,
    });

    const claimOrArriveInFlight = () =>
        claimingRef.current || arrivingRef.current || cancelingClaimRef.current;

    const handleExpressInterest = async (etaMinutes: number) => {
        const spot = selectedItem;
        if (!spot || !user || !db || claimOrArriveInFlight()) return;
        setInterestError(null);

        const estMinutes = getEstDriveMinutes(spot);
        if (estMinutes !== null && estMinutes > MAX_ETA_MINUTES) {
            setInterestError("Too far to reserve this spot right now");
            return;
        }

        claimingRef.current = true;
        setClaiming(true);
        try {
            const alreadyActive = await checkAlreadyInterested();
            if (alreadyActive) {
                setInterestError(ALREADY_CLAIMED_MESSAGE);
                return;
            }

            try {
                const claimMinutes = Math.min(etaMinutes + 5, MAX_CLAIM_MINUTES);
                await acquireActiveIncomingClaim(db, {
                    spotId: spot.id,
                    uid: user.id,
                    unavailableMessage: 'Someone already got this spot',
                    missingMessage: 'Spot no longer exists',
                    buildClaimFields: (_spot, claimStartedAt) => ({
                        ...claimerFields(claimStartedAt, 'heading'),
                        etaMinutes,
                        interestExpiresAt: Timestamp.fromMillis(Date.now() + claimMinutes * 60000),
                    }),
                });

                const dest: [number, number] = [spot.lng, spot.lat];
                activeRouteDestinationRef.current = dest;
                setTrackedItemId(spot.id);
                if (mapRef.current) drawRoute(mapRef.current, userLocation || NYC_CENTER, dest);
            } catch (e: any) {
                reportClaimFailure(e, 'immediate');
                setInterestError(await claimErrorMessage(e, 'Failed to reserve spot'));
            }
        } finally {
            claimingRef.current = false;
            setClaiming(false);
        }
    };

    const handleCancelByFinder = async (reason: string) => {
        if (!selectedItem || !user || !db) return;
        const interestedId = selectedItem.interestedUserId;
        if (interestedId) {
            const messages: Record<string, string> = {
                "Can't wait anymore": "The driver couldn't wait any longer — your claim has been released.",
                "Spot no longer available": "The spot is no longer available.",
            };
            await addDoc(collection(db, 'spotNotifications'), {
                spotId: selectedItem.id,
                senderId: user.id,
                targetUserId: interestedId,
                type: 'cancelled',
                message: messages[reason] ?? "The driver had to cancel.",
                createdAt: Timestamp.now(),
            });
        }
        await deleteDoc(doc(db, 'spots', selectedItem.id));
        setSelectedItem(null);
    };

    // Finder confirms the claimer arrived — triggers success flow without requiring claimer's tap
    const handleFinderConfirmsArrival = async () => {
        if (!selectedItem || !user || !db) return;
        const claimerId = selectedItem.interestedUserId;
        const claimerName = selectedItem.interestedUserName || 'the driver';

        if (!claimerId) throw new Error('Missing claimer for completed handoff');
        await completeFinderConfirmedHandoff(db, {
            spotId: selectedItem.id,
            driverId: claimerId,
            finderId: user.id,
            finderName: user.username || 'The driver',
            address: selectedItem.title || selectedItem.address || '',
        });

        setFinderToast(`Nice one! ${claimerName} is parked. +2 Crowns earned.`);
        setFinderToastTitle('Crown earned!');
        setFinderToastVariant('success');
        setTimeout(() => setFinderToast(null), 6000);
        setSelectedItem(null);
    };

    // Claim identity used to detect a stale/superseded claim. claimStartedAt is
    // set once when a claim is created (handleExpressInterest / handleScheduledClaim)
    // and is never touched by any other handler — unlike interestExpiresAt, which
    // legitimately shifts under the *same* claim via handleDelayByFinder, so it
    // can't be used to distinguish "stale" from "just extended".
    const claimFingerprint = (spot: { claimStartedAt?: unknown }): number | null => {
        const ms = timestampToMillis(spot.claimStartedAt);
        return ms > 0 ? ms : null;
    };

    const handleCancelByClaimer = async (reason: string) => {
        if (!selectedItem || !user || !db || cancelingClaimRef.current || claimingRef.current || arrivingRef.current) return;
        const messages: Record<string, string> = {
            "Found parking elsewhere": "The driver found parking elsewhere — your spot is available again.",
            "Traffic is too heavy": "The driver got stuck in traffic — your spot is available again.",
            "Changed my mind": "The driver changed their mind — your spot is available again.",
        };

        cancelingClaimRef.current = true;
        setCancelingClaim(true);
        setInterestError(null);

        try {
            await cancelClaimTransaction(db, {
                spotId: selectedItem.id,
                claimantId: user.id,
                finderId: selectedItem.finderId ?? null,
                fingerprint: claimFingerprint(selectedItem),
                message: messages[reason] ?? "The other driver canceled — your spot is available again.",
            });

            // 'cancelled' | 'already_resolved' | 'stale_claim' all mean the claim is
            // no longer active from this UI's perspective — reconcile and close.
            setTrackedItemId(null);
            activeRouteDestinationRef.current = null;
            if (mapRef.current) clearRoute(mapRef.current);
            setSelectedItem(null);
        } catch (e) {
            reportClaimCancelFailure(e);
            // Never leak raw SDK error text (e.g. transaction-ordering errors) to the UI.
            setInterestError(t('claim_flow.cancel_error'));
        } finally {
            cancelingClaimRef.current = false;
            setCancelingClaim(false);
        }
    };

    const handleDelayByFinder = async (extraMinutes = 3) => {
        if (!selectedItem || !user || !db) return;
        const newExpiry = Timestamp.fromMillis(Date.now() + extraMinutes * 60000);
        await updateDoc(doc(db, 'spots', selectedItem.id), {
            interestExpiresAt: newExpiry,
        });
        const interestedId = selectedItem.interestedUserId;
        if (interestedId) {
            await addDoc(collection(db, 'spotNotifications'), {
                spotId: selectedItem.id,
                senderId: user.id,
                targetUserId: interestedId,
                type: 'delayed',
                message: 'Driver needs a few more minutes',
                createdAt: Timestamp.now(),
            });
        }
        setFinderToast('The other driver has been notified');
        setFinderToastTitle('All set');
        setFinderToastVariant('info');
        setTimeout(() => setFinderToast(null), 3000);
    };

    const handleArrival = async () => {
        if (!selectedItem || !user || !db || claimOrArriveInFlight()) return;
        arrivingRef.current = true;
        setArriving(true);
        try {
            handoffSpotRef.current = {
                id: selectedItem.id,
                lat: selectedItem.lat,
                lng: selectedItem.lng,
                address: selectedItem.title || selectedItem.address,
                finderId: selectedItem.finderId,
                finderName: selectedItem.finderName,
                geohash: selectedItem.geohash,
            };
            setHandoffFinderName(selectedItem.finderName || null);
            setHandoffAddress(selectedItem.title || selectedItem.address || '');
            await markClaimArrived(db, selectedItem.id, user.id);
            setTrackedItemId(null);
            activeRouteDestinationRef.current = null;
            if (mapRef.current) clearRoute(mapRef.current);
            setHandoffStep('outcome');
        } finally {
            arrivingRef.current = false;
            setArriving(false);
        }
    };

    const showTerminalSubmitFailure = (error: unknown) => {
        // A rejected terminal write used to be an uncaught promise, so the
        // reason row looked like it had never received the click.
        reportCriticalActionFailure('terminal_handoff', error);
        setHandoffSubmitError(t('handoff.submit_failed'));
    };

    const handleHandoffOutcome = async (outcome: 'success' | 'failed') => {
        // The lock covers every terminal choice, including the local step
        // change for "No luck". An in-flight success retry must not walk
        // the outcome screen onto the failure-reason path.
        if (handoffSubmitLock.current) return;

        const spotSnap = handoffSpotRef.current;
        if (!spotSnap || !user) {
            if (outcome === 'success') showTerminalSubmitFailure(new Error('Handoff participants changed'));
            return;
        }

        if (outcome === 'failed') {
            setHandoffSubmitError(null);
            setHandoffStep('failure_reason');
            return;
        }

        handoffSubmitLock.current = true;
        lastTerminalAttempt.current = { outcome: 'success' };
        setHandoffSubmitting(true);
        setHandoffSubmitError(null);
        try {
            await completeTerminalHandoff(db, {
                spotId: spotSnap.id,
                driverId: user.id,
                driverName: user.username || 'Someone',
                finderId: spotSnap.finderId,
                address: spotSnap.address || '',
                outcome: 'success',
                failureReason: null,
            });

            noteTerminalHandoff(spotSnap.id);
            setHandoffSpotCoords({ lat: spotSnap.lat, lng: spotSnap.lng, address: spotSnap.address || '' });
            setHandoffStep('celebration');
        } catch (error) {
            showTerminalSubmitFailure(error);
        } finally {
            handoffSubmitLock.current = false;
            setHandoffSubmitting(false);
        }
    };

    const handleFailureReason = async (reason: string) => {
        const spotSnap = handoffSpotRef.current;
        if (!spotSnap || !user) {
            showTerminalSubmitFailure(new Error('Handoff participants changed'));
            return;
        }
        if (!isHandoffFailureReason(reason)) {
            throw new Error('Invalid handoff failure reason');
        }
        if (handoffSubmitLock.current) return;
        handoffSubmitLock.current = true;
        lastTerminalAttempt.current = { outcome: 'failed', reason };
        setHandoffSubmitting(true);
        setHandoffSubmitError(null);
        try {
            await completeTerminalHandoff(db, {
                spotId: spotSnap.id,
                driverId: user.id,
                driverName: user.username || 'Someone',
                finderId: spotSnap.finderId,
                address: spotSnap.address || '',
                outcome: 'failed',
                failureReason: reason,
            });

            noteTerminalHandoff(spotSnap.id);
            setHandoffStep(null);
            setHandoffFinderName(null);
            setHandoffAddress('');
            handoffSpotRef.current = null;
            setSelectedItem(null);
            lastTerminalAttempt.current = null;
        } catch (error) {
            showTerminalSubmitFailure(error);
        } finally {
            handoffSubmitLock.current = false;
            setHandoffSubmitting(false);
        }
    };

    const retryTerminalHandoff = () => {
        const attempt = lastTerminalAttempt.current;
        if (!attempt || handoffSubmitLock.current) return;
        if (attempt.outcome === 'success') return handleHandoffOutcome('success');
        return handleFailureReason(attempt.reason);
    };

    const showDeparturePingDenial = (copy: { title: string; message: string }) => {
        setDriverNotification(copy.message);
        setDriverNotifTitle(copy.title);
        setDriverNotifVariant('warning');
        setTimeout(() => { setDriverNotification(null); setDriverNotifTitle(null); }, 6000);
    };

    const handleDeparturePing = async (durationMinutes: number) => {
        const spotSnap = handoffSpotRef.current;
        if (!spotSnap || !user) return;
        // Deny rather than clamp. Preset departure reminders are 30–120 minutes.
        if (durationMinutes * 60_000 > PING_SCHEDULE_HORIZON_MS) return;

        const now = Date.now();
        const reportedAt = Timestamp.fromMillis(now + durationMinutes * 60000);
        const expiresAt = Timestamp.fromMillis(getPingExpiresAtMs(reportedAt));

        try {
            await commitPingCreate(db, {
                uid: user.id,
                spotRef: doc(collection(db, 'spots')),
                originSpotId: spotSnap.id,
                data: {
                    lat: spotSnap.lat,
                    lng: spotSnap.lng,
                    type: 'free',
                    status: 'available',
                    finderId: user.id,
                    finderName: user.username || user.fullName || 'Anonymous',
                    pingMode: 'later',
                    reportedAt,
                    expiresAt,
                    geohash: spotSnap.geohash || '',
                    address: spotSnap.address || '',
                    originSpotId: spotSnap.id,
                },
            });
        } catch (error) {
            // Rules stay the authority. Preflight already labels rate vs origin;
            // a generic permission-denied still has to be visible.
            showDeparturePingDenial(departurePingDenialCopy(error));
            return;
        }

        setHandoffStep(null);
        setHandoffFinderName(null);
        setHandoffAddress('');
        handoffSpotRef.current = null;
        setSelectedItem(null);
    };

    const handleScheduledClaim = async () => {
        const spot = selectedItem;
        if (!spot || !user || !db || claimOrArriveInFlight()) return;
        setInterestError(null);

        claimingRef.current = true;
        setClaiming(true);
        try {
            const alreadyActive = await checkAlreadyInterested();
            if (alreadyActive) {
                setInterestError(ALREADY_CLAIMED_MESSAGE);
                return;
            }

            try {
                await acquireActiveIncomingClaim(db, {
                    spotId: spot.id,
                    uid: user.id,
                    unavailableMessage: 'Someone already claimed this spot',
                    missingMessage: 'Spot no longer exists',
                    buildClaimFields: (data, claimStartedAt) => {
                        // Remind 20 min before departure; skip if already past
                        const departureMs = data.reportedAt?.toMillis?.() ?? 0;
                        const reminderMs = departureMs - 20 * 60 * 1000;
                        const claimReminderAt = reminderMs > Date.now()
                            ? Timestamp.fromMillis(reminderMs)
                            : null;
                        return {
                            ...claimerFields(claimStartedAt, 'committed'),
                            ownerLeavingNowAt: null,
                            etaMinutes: null,
                            // Claim lives as long as the spot itself — inherit spot's own expiry
                            interestExpiresAt: data.expiresAt,
                            claimReminderAt,
                            claimReminderSentAt: null,
                            claimAutoReleaseAt: departureMs
                                ? Timestamp.fromMillis(departureMs + 10 * 60 * 1000)
                                : null,
                            claimAutoReleasedAt: null,
                        };
                    },
                });

                // Track for snapshot disappearance detection — no route drawn yet
                setTrackedItemId(spot.id);
            } catch (e: any) {
                reportClaimFailure(e, 'scheduled');
                setInterestError(await claimErrorMessage(e, 'Failed to claim spot'));
            }
        } finally {
            claimingRef.current = false;
            setClaiming(false);
        }
    };

    const handleCommitToHeading = async () => {
        const spot = selectedItem;
        if (!spot || !user || !db || claimOrArriveInFlight()) return;

        const etaMinutes = getEstDriveMinutes(spot) ?? 5;
        const claimMinutes = Math.min(etaMinutes + 5, MAX_CLAIM_MINUTES);

        claimingRef.current = true;
        setClaiming(true);
        try {
            let outcome: 'committed' | 'already_heading' | 'rejected';
            try {
                outcome = await commitClaimToHeading(db, {
                    spotId: spot.id,
                    uid: user.id,
                    etaMinutes,
                    claimMinutes,
                });
            } catch {
                // Permission denial or contention after auto-release: do not start
                // navigation against a Ping this commit did not win.
                return;
            }
            if (outcome === 'rejected') return;

            const dest: [number, number] = [spot.lng, spot.lat];
            activeRouteDestinationRef.current = dest;
            if (mapRef.current) drawRoute(mapRef.current, userLocation || NYC_CENTER, dest);
        } finally {
            claimingRef.current = false;
            setClaiming(false);
        }
    };

    const handleOwnerLeaveNow = async () => {
        const spot = selectedItem;
        if (!spot || !user || !db) return;

        await updateDoc(doc(db, 'spots', spot.id), {
            ownerLeavingNow: true,
            ownerLeavingNowAt: Timestamp.now(),
            claimAutoReleaseAt: Timestamp.fromMillis(Date.now() + 10 * 60 * 1000),
        });

        if (spot.interestedUserId) {
            await addDoc(collection(db, 'spotNotifications'), {
                spotId: spot.id,
                senderId: user.id,
                targetUserId: spot.interestedUserId,
                type: 'owner_leaving_now',
                message: `${user.username || user.fullName || 'The driver'} is leaving now — time to head over`,
                createdAt: Timestamp.now(),
            });
        }
    };

    const handleSkipDeparture = () => {
        setHandoffStep(null);
        setHandoffSubmitError(null);
        setHandoffSubmitting(false);
        handoffSubmitLock.current = false;
        lastTerminalAttempt.current = null;
        setHandoffFinderName(null);
        setHandoffAddress('');
        setHandoffSpotCoords(null);
        handoffSpotRef.current = null;
        setSelectedItem(null);
    };

    const clearDriverNotification = useCallback(() => {
        setDriverNotification(null);
        setDriverNotifTitle(null);
    }, []);
    const clearFinderToast = useCallback(() => setFinderToast(null), []);

    return {
        trackedItemId,
        interestError,
        setInterestError,
        handoffStep,
        handoffSubmitError,
        handoffSubmitting,
        retryTerminalHandoff,
        handoffFinderName,
        handoffAddress,
        handoffSpotCoords,
        unfinishedHandoff,
        resumeUnfinishedHandoff,
        finderToast,
        finderToastTitle,
        finderToastVariant,
        clearFinderToast,
        driverNotification,
        driverNotifTitle,
        driverNotifVariant,
        clearDriverNotification,
        handleExpressInterest,
        handleScheduledClaim,
        handleCommitToHeading,
        handleOwnerLeaveNow,
        handleCancelByFinder,
        handleCancelByClaimer,
        cancelingClaim,
        claiming,
        arriving,
        handleFinderConfirmsArrival,
        handleDelayByFinder,
        handleArrival,
        handleHandoffOutcome,
        handleFailureReason,
        handleDeparturePing,
        handleSkipDeparture,
        getEstDriveMinutes,
        isWithinArrivalRange,
        ETA_OPTIONS,
        MAX_ETA_MINUTES,
    };
}
