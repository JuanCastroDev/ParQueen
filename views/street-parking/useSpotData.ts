import { useState, useEffect, useMemo, useRef } from 'react';
import { db } from '../../firebase';
import { collection, onSnapshot, query, where, orderBy, Timestamp } from 'firebase/firestore';
import { MapItem } from './types';
import { getDistance, NYC_CENTER } from './utils';
import { buildGeoQueryRanges } from './geoQuery';
import { GeoRegionSubscription } from './geoRegionSubscription';
import { filterVisibleSpots } from './filterVisibleSpots';
import { parsePersistedCount } from '../../utils/persistedCount';

interface UseSpotDataOptions {
    userId: string | undefined;
    blockedUsers?: string[];
    searchCenter: [number, number];
    showFree: boolean;
    showPaid: boolean;
    filterRadiusMiles?: number;
}

interface RegionMetadata {
    center: [number, number];
    filterRadiusMiles: number;
}

export function useSpotData({ userId, blockedUsers, searchCenter, showFree, showPaid, filterRadiusMiles }: UseSpotDataOptions) {
    const [freeSpots, setFreeSpots] = useState<MapItem[]>([]);
    const [paidListings, setPaidListings] = useState<MapItem[]>([]);
    const [activeSpots, setActiveSpots] = useState<any[]>([]);
    const [pendingUpdatesCount, setPendingUpdatesCount] = useState(() => {
        return parsePersistedCount(localStorage.getItem('pendingUpdatesCount'));
    });
    // The center/radius that freeSpots was actually filtered against — only
    // ever updated atomically with the dataset it describes (see
    // geoRegionSubscription.ts's metadata contract), so radiusFilteredItems
    // never filters a stale (still-active) dataset against a not-yet-active
    // desired region during a pending transition.
    const [activeRegion, setActiveRegion] = useState<RegionMetadata>({
        center: searchCenter,
        filterRadiusMiles: filterRadiusMiles ?? 2.0,
    });

    const subscriptionRef = useRef<GeoRegionSubscription<any, RegionMetadata> | null>(null);
    const nowTimestampRef = useRef<Timestamp>(Timestamp.now());
    // Mirrors the latest userId/blockedUsers so the onData callback (bound
    // once per subscription, not recreated per render) always filters
    // against current values.
    const userIdRef = useRef(userId);
    const blockedUsersRef = useRef(blockedUsers);
    userIdRef.current = userId;
    blockedUsersRef.current = blockedUsers;

    // Firestore free spots listener — bounded to geohash ranges around
    // searchCenter/filterRadiusMiles (see geoRegionSubscription.ts for the
    // active/pending transition contract) instead of a single citywide
    // subscription.
    useEffect(() => {
        if (!db || !userId) return;

        const subscription = new GeoRegionSubscription<any, RegionMetadata>({
            subscribeRange: (range, onSnapshotCb, onErrorCb) => {
                const q = query(
                    collection(db, "spots"),
                    where("status", "in", ["available", "interested"]),
                    where("expiresAt", ">", nowTimestampRef.current),
                    where("geohash", ">=", range.start),
                    where("geohash", "<=", range.end),
                    orderBy("geohash"),
                );
                return onSnapshot(
                    q,
                    (snapshot) => onSnapshotCb(snapshot.docs.map(d => ({ id: d.id, data: { id: d.id, ...d.data() } as any }))),
                    (err) => onErrorCb(err),
                );
            },
            onData: (merged, metadata) => {
                setActiveRegion(metadata);
                const now = Date.now();
                const rawSpots = Array.from(merged.values());
                const spots = filterVisibleSpots(rawSpots, userIdRef.current, blockedUsersRef.current, now);
                setActiveSpots(spots);

                const mappedFree: MapItem[] = spots.map(s => ({
                    id: s.id,
                    lat: s.lat,
                    lng: s.lng,
                    type: 'free' as const,
                    status: s.status || 'available',
                    title: s.address || '',
                    reportedAt: s.reportedAt,
                    expiresAt: s.expiresAt,
                    finderId: s.finderId,
                    finderName: s.finderName,
                    finderVehicleColor: s.finderVehicleColor || null,
                    finderVehicleType: s.finderVehicleType || null,
                    finderVehicleBrand: s.finderVehicleBrand || null,
                    interestedUserId: s.interestedUserId,
                    interestedUserName: s.interestedUserName,
                    interestedUserVehicleColor: s.interestedUserVehicleColor || null,
                    interestedUserVehicleType: s.interestedUserVehicleType || null,
                    interestedUserVehicleBrand: s.interestedUserVehicleBrand || null,
                    interestedUserTitle: s.interestedUserTitle || null,
                    etaMinutes: s.etaMinutes,
                    interestExpiresAt: s.interestExpiresAt,
                    address: s.address || '',
                    geohash: s.geohash || '',
                    originSpotId: s.originSpotId || null,
                    pingMode: s.pingMode || null,
                    claimState: s.claimState || null,
                    claimStartedAt: s.claimStartedAt ?? null,
                    ownerLeavingNow: s.ownerLeavingNow || null,
                    ownerLeavingNowAt: s.ownerLeavingNowAt || null,
                    claimReminderAt: s.claimReminderAt || null,
                    claimReminderSentAt: s.claimReminderSentAt || null,
                    claimAutoReleaseAt: s.claimAutoReleaseAt || null,
                    claimAutoReleasedAt: s.claimAutoReleasedAt || null,
                    rawSpot: s
                }));
                setFreeSpots(mappedFree);

                const lastViewedStr = localStorage.getItem('lastViewedNotifications');
                const lastViewedTime = lastViewedStr ? parseInt(lastViewedStr, 10) : 0;

                let newSpotsCount = 0;
                spots.forEach(s => {
                    const reportedTime = s.reportedAt?.toMillis() || 0;
                    if (reportedTime > lastViewedTime && s.finderId !== userIdRef.current) {
                        newSpotsCount++;
                    }
                });

                if (newSpotsCount > 0) {
                    setPendingUpdatesCount(newSpotsCount);
                    localStorage.setItem('pendingUpdatesCount', newSpotsCount.toString());
                } else {
                    const saved = localStorage.getItem('pendingUpdatesCount');
                    if (saved !== null) {
                        setPendingUpdatesCount(parsePersistedCount(saved));
                    }
                }
            },
            onActiveListenerError: (err) => console.warn("Spots snapshot listener error:", err),
            onPendingListenerError: (err) => console.warn("Spots snapshot listener error:", err),
        });
        subscriptionRef.current = subscription;

        return () => {
            subscription.dispose();
            subscriptionRef.current = null;
        };
    }, [userId]);

    // Recomputes the bounded region whenever the already-debounced
    // searchCenter/filterRadiusMiles change (StreetParkingView debounces
    // map moveend by 400ms before updating either — no per-frame querying
    // here). setRegion() itself is a no-op when the resulting geohash range
    // set is identical to what's already active, so panning within the same
    // cells never tears down and rebuilds listeners.
    useEffect(() => {
        if (!subscriptionRef.current) return;
        nowTimestampRef.current = Timestamp.now();
        const ranges = buildGeoQueryRanges(searchCenter[1], searchCenter[0], filterRadiusMiles ?? 2.0);
        subscriptionRef.current.setRegion(ranges, { center: searchCenter, filterRadiusMiles: filterRadiusMiles ?? 2.0 });
    }, [userId, searchCenter, filterRadiusMiles]);

    // Firestore paid listings listener
    useEffect(() => {
        if (!showPaid) return;
        if (!db || !userId) return;
        const q = query(collection(db, "listings"));
        const unsubscribe = onSnapshot(q, (snapshot) => {
            let list = snapshot.docs.map(d => {
                const data = d.data();
                return {
                    id: d.id,
                    lat: data.lat || NYC_CENTER[1],
                    lng: data.lng || NYC_CENTER[0],
                    type: 'paid' as const,
                    status: 'available' as const,
                    title: data.title || 'Private Spot',
                    pricePerHour: data.pricePerHour || 1.50,
                    description: data.description || 'Secure parking space',
                    rawSpot: { id: d.id, ...data }
                };
            });
            setPaidListings(list);
        }, (err) => {
            console.warn("Listings snapshot listener error:", err);
        });
        return () => unsubscribe();
    }, [db, userId, showPaid]);

    const radiusFilteredItems = useMemo(() => {
        const withinRadius = (items: MapItem[], centerLat: number, centerLng: number, radiusMiles: number) =>
            items.filter(item => {
                const distanceVal = getDistance(centerLat, centerLng, item.lat, item.lng);
                const distanceInMiles = distanceVal * 0.621371;
                return distanceInMiles <= radiusMiles;
            });

        const visibleItems: MapItem[] = [];
        // freeSpots is bounded by the geohash-range listener migration — it
        // must be filtered against activeRegion (the center/radius the data
        // was actually queried for), not the raw, possibly-ahead-of-the-data
        // searchCenter/filterRadiusMiles props, or a pending region change
        // would filter the still-active OLD dataset against the NEW desired
        // center and briefly empty the map (see geoRegionSubscription.ts).
        if (showFree) {
            visibleItems.push(...withinRadius(freeSpots, activeRegion.center[1], activeRegion.center[0], activeRegion.filterRadiusMiles));
        }
        // paidListings has no such transition — it's a single unbounded
        // listener that's always current, so it filters against the live
        // (debounced) props directly.
        if (showPaid) {
            visibleItems.push(...withinRadius(paidListings, searchCenter[1], searchCenter[0], filterRadiusMiles ?? 2.0));
        }

        return visibleItems;
    }, [showFree, showPaid, freeSpots, paidListings, activeRegion, searchCenter, filterRadiusMiles]);

    return {
        freeSpots,
        paidListings,
        activeSpots,
        radiusFilteredItems,
        pendingUpdatesCount,
        setPendingUpdatesCount,
    };
}
