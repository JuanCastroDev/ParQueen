import { collection, query, where } from 'firebase/firestore';

type Firestore = any;

/**
 * Claimer-scoped resume lookup. Two equality filters, so this query needs the
 * spots composite index on interestedUserId + claimState. It does not read the
 * public map feed. Terminal feedback is a separate userId-scoped read; any
 * success or failed spotFeedback removes that Ping from the resume set.
 */
export function claimerArrivedSpotsQuery(db: Firestore, uid: string) {
    return query(
        collection(db, 'spots'),
        where('interestedUserId', '==', uid),
        where('claimState', '==', 'arrived_pending_outcome'),
    );
}

export function claimerTerminalFeedbackQuery(db: Firestore, uid: string) {
    return query(
        collection(db, 'spotFeedback'),
        where('userId', '==', uid),
    );
}

/**
 * Finder-side recovery deliberately queries only by finderId. The security
 * rules allow a finder to read their own occupied/history Pings, and filtering
 * claimState client-side avoids introducing a new production composite index
 * just to make the mutual-confirmation action reachable.
 */
export function finderArrivedSpotsQuery(db: Firestore, uid: string) {
    return query(
        collection(db, 'spots'),
        where('finderId', '==', uid),
    );
}

export interface ClaimerSpotRecord {
    id: string;
    data: Record<string, any>;
}

export interface UnfinishedHandoff {
    id: string;
    lat: number;
    lng: number;
    address: string;
    finderId: string;
    finderName: string;
    geohash: string;
    arrivedAtMs: number;
}

export interface FinderPendingHandoff {
    id: string;
    address: string;
    claimerId: string;
    claimerName: string;
    arrivedAtMs: number;
}

// success and failed end the handoff. participant_success is one side's
// attestation and is not terminal: Finish-your-handoff stays up until the
// claimer doc is failed, or claimState leaves arrived_pending_outcome
// (completed_success or unconfirmed).
const TERMINAL_OUTCOMES = new Set(['success', 'failed']);

export function terminalSpotIdsFromFeedback(
    docs: Array<{ data: () => Record<string, any> | undefined }>,
): Set<string> {
    const ids = new Set<string>();
    for (const docSnap of docs) {
        const data = docSnap.data() ?? {};
        if (!TERMINAL_OUTCOMES.has(data.outcome)) continue;
        if (typeof data.spotId === 'string' && data.spotId.length > 0) ids.add(data.spotId);
    }
    return ids;
}

function toUnfinished(spot: ClaimerSpotRecord): UnfinishedHandoff {
    const data = spot.data;
    const arrivedAtMs = typeof data.arrivedAt?.toMillis === 'function' ? data.arrivedAt.toMillis() : 0;
    return {
        id: spot.id,
        lat: typeof data.lat === 'number' ? data.lat : 0,
        lng: typeof data.lng === 'number' ? data.lng : 0,
        address: typeof data.address === 'string' ? data.address : '',
        finderId: typeof data.finderId === 'string' ? data.finderId : '',
        finderName: typeof data.finderName === 'string' ? data.finderName : '',
        geohash: typeof data.geohash === 'string' ? data.geohash : '',
        arrivedAtMs,
    };
}

/** Latest open arrival for this claimer. Heading claims and terminal feedback are excluded. */
export function selectUnfinishedHandoff(
    spots: ClaimerSpotRecord[],
    terminalSpotIds: ReadonlySet<string>,
    uid: string,
): UnfinishedHandoff | null {
    const open = spots
        .filter((spot) => {
            const data = spot.data;
            return data.interestedUserId === uid
                && data.claimState === 'arrived_pending_outcome'
                && !terminalSpotIds.has(spot.id);
        })
        .map(toUnfinished)
        .sort((a, b) => b.arrivedAtMs - a.arrivedAtMs || a.id.localeCompare(b.id));
    return open[0] ?? null;
}


/** Latest arrived Ping owned by this finder and still waiting for mutual outcome. */
export function selectFinderPendingHandoff(
    spots: ClaimerSpotRecord[],
    uid: string,
): FinderPendingHandoff | null {
    const pending = spots
        .filter((spot) => {
            const data = spot.data;
            return data.finderId === uid
                && data.status === 'occupied'
                && data.claimState === 'arrived_pending_outcome'
                && typeof data.interestedUserId === 'string'
                && data.interestedUserId.length > 0
                && data.interestedUserId !== uid;
        })
        .map((spot) => {
            const data = spot.data;
            return {
                id: spot.id,
                address: typeof data.address === 'string' ? data.address : '',
                claimerId: data.interestedUserId as string,
                claimerName: typeof data.interestedUserName === 'string' && data.interestedUserName.trim()
                    ? data.interestedUserName
                    : '',
                arrivedAtMs: typeof data.arrivedAt?.toMillis === 'function' ? data.arrivedAt.toMillis() : 0,
            };
        })
        .sort((a, b) => b.arrivedAtMs - a.arrivedAtMs || a.id.localeCompare(b.id));

    return pending[0] ?? null;
}
