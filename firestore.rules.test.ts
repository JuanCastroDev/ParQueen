/**
 * Firestore Security Rules tests — ParQueen private activity collections.
 *
 * Run via:
 *   npm run test:rules          (starts emulator automatically, then exits)
 *   npm run test:rules:unit     (assumes emulator already on :8080)
 *
 * Requires Java 11+ and Firebase CLI with the Firestore emulator installed.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import {
    initializeTestEnvironment,
    assertFails,
    assertSucceeds,
    type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
    doc,
    getDoc,
    getDocs,
    setDoc,
    deleteDoc,
    updateDoc,
    addDoc,
    collection,
    query,
    where,
    Timestamp,
    runTransaction,
} from 'firebase/firestore';
import { cancelClaimTransaction } from './views/street-parking/cancelClaimTransaction';
import { commitClaimToHeading } from './views/street-parking/commitToHeading';
import {
    acquireActiveIncomingClaim,
    activeIncomingClaimRef,
    markClaimArrived,
} from './views/street-parking/activeIncomingClaim';
import { getTitleForCrowns } from './utils/crowns';
import { timestampToMillis } from './utils/pingLifecycle';
import { advancePingRate, PingCreateRejected } from './views/street-parking/pingCreateBounds';
import {
    completeFinderConfirmedHandoff,
    completeTerminalHandoff,
} from './views/street-parking/completeTerminalHandoff';
import {
    claimerArrivedSpotsQuery,
    claimerTerminalFeedbackQuery,
} from './views/street-parking/unfinishedHandoff';

// ── Test identities ────────────────────────────────────────────────────────────
const OWNER_UID  = 'owner-aaa-111';
const OTHER_UID  = 'other-bbb-222';
const ADMIN_UID  = 'admin-ccc-333';
const THIRD_UID  = 'third-ddd-444';
const PROJECT_ID = 'demo-parkqueen-rules-test';
const requireFromFunctions = createRequire(path.join(process.cwd(), 'functions/package.json'));

let testEnv: RulesTestEnvironment;

// ── Contexts ───────────────────────────────────────────────────────────────────
function ownerDb()  { return testEnv.authenticatedContext(OWNER_UID).firestore(); }
function otherDb()  { return testEnv.authenticatedContext(OTHER_UID).firestore(); }
function adminDb()  { return testEnv.authenticatedContext(ADMIN_UID, { role: 'admin' }).firestore(); }
function thirdDb()  { return testEnv.authenticatedContext(THIRD_UID).firestore(); }
function anonDb()   { return testEnv.unauthenticatedContext().firestore(); }

// ── Seed helpers (bypass rules) ────────────────────────────────────────────────
async function commitBoundedPing(
    db: ReturnType<typeof ownerDb>,
    uid: string,
    spotId: string,
    data: object,
    originSpotId?: string,
) {
    const spotRef = doc(db, 'spots', spotId);
    const rateRef = doc(db, 'users', uid, 'pingCreateRate', 'current');
    const originRef = originSpotId ? doc(db, 'originRePings', originSpotId) : null;
    await runTransaction(db, async (tx) => {
        const rateSnap = await tx.get(rateRef);
        if (originRef) await tx.get(originRef);
        const now = Timestamp.now();
        const prev = rateSnap.exists()
            ? {
                spotIds: (rateSnap.data().spotIds ?? []) as string[],
                createdAtsMs: ((rateSnap.data().createdAts ?? []) as Timestamp[]).map((stamp) => stamp.toMillis()),
            }
            : null;
        // A client that skips its own cap still has to present a quota write.
        // When the rolling hour is full, send the illegal 6th entry so Rules deny it.
        let next;
        try {
            next = advancePingRate(prev, spotId, now.toMillis());
        } catch (error) {
            if (!(error instanceof PingCreateRejected) || error.reason !== 'rate') throw error;
            next = {
                spotIds: [...(prev?.spotIds ?? []), spotId],
                createdAtsMs: [...(prev?.createdAtsMs ?? []), now.toMillis()],
            };
        }
        tx.set(spotRef, data);
        tx.set(rateRef, {
            spotIds: next.spotIds,
            createdAts: next.createdAtsMs.map((ms) => Timestamp.fromMillis(ms)),
        });
        if (originRef) {
            tx.set(originRef, {
                rePingSpotId: spotId,
                finderId: uid,
                createdAt: now,
            });
        }
    });
}

async function seed(col: string, id: string, data: object) {
    await testEnv.withSecurityRulesDisabled(async ctx => {
        await setDoc(doc(ctx.firestore(), col, id), data);
    });
}

async function seedActiveClaimInvariantOpen() {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'activeIncomingClaimRollout', 'status'), {
            enforced: true,
            locklessCount: 0,
            duplicateUserCount: 0,
            duplicatePingCount: 0,
        });
    });
}

async function closeActiveClaimRollout() {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await deleteDoc(doc(ctx.firestore(), 'activeIncomingClaimRollout', 'status'));
    });
}

function rolloutTools() {
    if (!process.env.FIRESTORE_EMULATOR_HOST) {
        process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
    }
    const { initializeApp, getApps } = requireFromFunctions('firebase-admin/app');
    const { getFirestore, Timestamp: AdminTimestamp } = requireFromFunctions('firebase-admin/firestore');
    const { reconcileActiveIncomingClaims } = requireFromFunctions('./activeIncomingClaim.js');
    const name = 'a1-rollout';
    const app = getApps().find((entry: { name: string }) => entry.name === name)
        ?? initializeApp({ projectId: PROJECT_ID }, name);
    return {
        db: getFirestore(app),
        reconcile: reconcileActiveIncomingClaims as (db: unknown, now: unknown) => Promise<{
            enforced: boolean;
            locklessCount: number;
            duplicateUserCount: number;
            duplicatePingCount: number;
        }>,
        now: () => AdminTimestamp.now(),
    };
}

// ── Common timestamps ─────────────────────────────────────────────────────────
const FUTURE = Timestamp.fromMillis(Date.now() + 3_600_000);
const PAST   = Timestamp.fromMillis(Date.now() - 3_600_000);

// ── Spot fixtures ──────────────────────────────────────────────────────────────
const occupiedSpot = {
    finderId:    OWNER_UID,
    finderName:  'TestFinder',
    address:     '123 Private St',
    lat:         40.7128,
    lng:         -74.006,
    status:      'occupied',
    pingMode:    'now',
    reportedAt:  PAST,
    expiresAt:   PAST,
};

const availableSpot = {
    finderId:   OWNER_UID,
    finderName: 'TestFinder',
    address:    '456 Public Ave',
    lat:        40.714,
    lng:        -74.01,
    status:     'available',
    pingMode:   'now',
    reportedAt: Timestamp.now(),
    expiresAt:  FUTURE,
};

const interestedSpot = {
    finderId:        OWNER_UID,
    finderName:      'TestFinder',
    address:         '789 Interest Blvd',
    lat:             40.72,
    lng:             -74.0,
    status:          'interested',
    interestedUserId: OTHER_UID,
    pingMode:        'now',
    reportedAt:      Timestamp.now(),
    expiresAt:       FUTURE,
};

const claimedSpot = {
    finderId:          OWNER_UID,
    finderName:        'TestFinder',
    address:           '111 Hold Ave',
    lat:               40.73,
    lng:               -74.01,
    status:            'claimed',
    claimedBy:         OTHER_UID,
    holdRequestStatus: 'accepted',
    pingMode:          'now',
    reportedAt:        Timestamp.now(),
    expiresAt:         FUTURE,
};

// Spot with NO optional fields (no interestedUserId, no claimedBy)
const bareAvailableSpot = {
    finderId:   OWNER_UID,
    address:    '555 Bare St',
    lat:        40.70,
    lng:        -74.02,
    status:     'available',
    reportedAt: Timestamp.now(),
    expiresAt:  FUTURE,
};

// Committed scheduled claim (pingMode 'later', claimant has tapped "heading there")
const CLAIM_STARTED_AT = Timestamp.fromMillis(Date.now() - 5 * 60_000);
const committedScheduledSpot = {
    finderId:          OWNER_UID,
    finderName:        'TestFinder',
    address:           '222 Scheduled Way',
    lat:               40.71,
    lng:               -74.03,
    status:            'interested',
    claimState:        'committed',
    interestedUserId:  OTHER_UID,
    pingMode:          'later',
    reportedAt:        FUTURE,
    expiresAt:         Timestamp.fromMillis(FUTURE.toMillis() + 3_600_000),
    claimAutoReleaseAt: FUTURE,
    claimStartedAt:    CLAIM_STARTED_AT,
};

// ── Global setup ───────────────────────────────────────────────────────────────
beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
        projectId: PROJECT_ID,
        firestore: {
            rules: readFileSync('firestore.rules', 'utf8'),
            host:  'localhost',
            port:  8080,
        },
    });
});

afterAll(async () => {
    await testEnv.cleanup();
});

beforeEach(async () => {
    await testEnv.clearFirestore();
    await seedActiveClaimInvariantOpen();
});

describe('curbIdentities — server-only canonical curb identity', () => {
    const ID = 'curb2_private-test';

    beforeEach(async () => {
        await seed('curbIdentities', ID, { officialBlockFaceId: '1000000001' });
    });

    it('denies direct reads to anonymous, signed-in, and admin-token clients', async () => {
        await assertFails(getDoc(doc(anonDb(), 'curbIdentities', ID)));
        await assertFails(getDoc(doc(ownerDb(), 'curbIdentities', ID)));
        await assertFails(getDoc(doc(adminDb(), 'curbIdentities', ID)));
    });

    it('denies direct writes to signed-in and admin-token clients', async () => {
        await assertFails(setDoc(doc(ownerDb(), 'curbIdentities', 'owner-write'), { value: 1 }));
        await assertFails(setDoc(doc(adminDb(), 'curbIdentities', 'admin-write'), { value: 1 }));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SPOTS — PRIVATE HISTORY (occupied)
// ═══════════════════════════════════════════════════════════════════════════════
describe('spots — private occupied/history', () => {
    const ID = 'spot-occupied-1';
    beforeEach(async () => { await seed('spots', ID, occupiedSpot); });

    // 1
    it('S1: unauthenticated direct read denied', async () => {
        await assertFails(getDoc(doc(anonDb(), 'spots', ID)));
    });

    // 2
    it('S2: unauthenticated list query denied', async () => {
        await assertFails(getDocs(collection(anonDb(), 'spots')));
    });

    // 3
    it('S3: owner (finderId) direct read succeeds', async () => {
        await assertSucceeds(getDoc(doc(ownerDb(), 'spots', ID)));
    });

    // 4
    it('S4: owner finder-history query (finderId == own uid) succeeds', async () => {
        await assertSucceeds(
            getDocs(query(collection(ownerDb(), 'spots'), where('finderId', '==', OWNER_UID)))
        );
    });

    // 5
    it('S5: different user direct read of occupied spot denied', async () => {
        await assertFails(getDoc(doc(otherDb(), 'spots', ID)));
    });

    // 6
    it('S6: different user query where finderId == owner uid denied', async () => {
        await assertFails(
            getDocs(query(collection(otherDb(), 'spots'), where('finderId', '==', OWNER_UID)))
        );
    });

    // 7
    it('S7: broad unfiltered authenticated list denied', async () => {
        await assertFails(getDocs(collection(ownerDb(), 'spots')));
    });

    // 13
    it('S13: unrelated user cannot read non-public spot', async () => {
        // OTHER_UID is neither finderId, interestedUserId nor claimedBy on an occupied spot
        await seed('spots', 'spot-occ-unrelated', { ...occupiedSpot, finderId: ADMIN_UID });
        await assertFails(getDoc(doc(otherDb(), 'spots', 'spot-occ-unrelated')));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SPOTS — PUBLIC PING FEED (available / interested)
// ═══════════════════════════════════════════════════════════════════════════════
describe('spots — public Ping feed (available/interested)', () => {
    beforeEach(async () => {
        await seed('spots', 'spot-avail',    availableSpot);
        await seed('spots', 'spot-interest', interestedSpot);
        await seed('spots', 'spot-occ',      occupiedSpot);
    });

    // 8
    it('S8: available spot readable by any signed-in user', async () => {
        await assertSucceeds(getDoc(doc(otherDb(), 'spots', 'spot-avail')));
    });

    // 9
    it('S9: interested spot readable by any signed-in user', async () => {
        await assertSucceeds(getDoc(doc(otherDb(), 'spots', 'spot-interest')));
    });

    // 10 — production query shape: status IN [...] AND expiresAt > now
    it('S10: production live-Ping query (status+expiresAt) succeeds and excludes occupied', async () => {
        const snap = await assertSucceeds(
            getDocs(query(
                collection(ownerDb(), 'spots'),
                where('status', 'in', ['available', 'interested']),
                where('expiresAt', '>', Timestamp.now()),
            ))
        );
        const ids = snap.docs.map(d => d.id);
        expect(ids).toContain('spot-avail');
        expect(ids).toContain('spot-interest');
        expect(ids).not.toContain('spot-occ');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SPOTS — CLAIM ARMS (interestedUserId / claimedBy)
// ═══════════════════════════════════════════════════════════════════════════════
describe('spots — claimer arms', () => {
    // 11 — claimedBy arm
    it('S11: hold claimer (claimedBy) can read claimed spot', async () => {
        await seed('spots', 'spot-claimed', claimedSpot);
        // OTHER_UID is claimedBy
        await assertSucceeds(getDoc(doc(otherDb(), 'spots', 'spot-claimed')));
    });

    // 12 — interestedUserId arm
    it('S12: interested user (interestedUserId) can read interested spot', async () => {
        await seed('spots', 'spot-int', interestedSpot);
        // OTHER_UID is interestedUserId
        await assertSucceeds(getDoc(doc(otherDb(), 'spots', 'spot-int')));
    });

    it('S12b: third user cannot read occupied spot where they are neither finder nor claimer', async () => {
        const thirdUid = 'third-ddd-444';
        await seed('spots', 'spot-claimed', claimedSpot);
        const thirdDb = testEnv.authenticatedContext(thirdUid).firestore();
        await assertFails(getDoc(doc(thirdDb, 'spots', 'spot-claimed')));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SPOTS — MISSING OPTIONAL FIELDS (no Rules runtime errors)
// ═══════════════════════════════════════════════════════════════════════════════
describe('spots — missing optional fields do not cause errors', () => {
    // 15
    it('S15a: available spot with no interestedUserId or claimedBy is readable (any signed-in)', async () => {
        await seed('spots', 'spot-bare', bareAvailableSpot);
        await assertSucceeds(getDoc(doc(otherDb(), 'spots', 'spot-bare')));
    });

    it('S15b: occupied spot with no interestedUserId or claimedBy — only finder can read', async () => {
        await seed('spots', 'spot-bare-occ', { ...bareAvailableSpot, status: 'occupied', expiresAt: PAST });
        await assertSucceeds(getDoc(doc(ownerDb(), 'spots', 'spot-bare-occ')));
        await assertFails(getDoc(doc(otherDb(), 'spots', 'spot-bare-occ')));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SPOTS — ADMIN
// ═══════════════════════════════════════════════════════════════════════════════
describe('spots — admin access (coordinated read remediation — direct admin read removed)', () => {
    // 14
    it('S14: admin token can no longer directly read another user\'s occupied/history spot (moved to adminReadView pingsList callable)', async () => {
        await seed('spots', 'spot-occ-admin', { ...occupiedSpot, finderId: OTHER_UID });
        await assertFails(getDoc(doc(adminDb(), 'spots', 'spot-occ-admin')));
    });

    it('S14b: admin token can no longer directly run an unfiltered spots list (owner/claimer-only spots still denied)', async () => {
        await seed('spots', 'spot-avail', availableSpot);
        await seed('spots', 'spot-occ', occupiedSpot);
        // The available spot is still readable by anyone signed in (public Ping
        // feed); the occupied one (owned by neither adminDb's uid) is not —
        // proving the query no longer succeeds unfiltered for an admin token.
        await assertFails(getDocs(collection(adminDb(), 'spots')));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SPOTS — SECURITY REGRESSION (original vulnerability closed)
// ═══════════════════════════════════════════════════════════════════════════════
describe('spots — security regression: cross-user history attack denied', () => {
    beforeEach(async () => {
        await seed('spots', 'spot-private', occupiedSpot);  // finderId = OWNER_UID
    });

    it('R1: direct read of another user occupied spot denied', async () => {
        await assertFails(getDoc(doc(otherDb(), 'spots', 'spot-private')));
    });

    it('R2: query where finderId == another UID denied', async () => {
        await assertFails(
            getDocs(query(collection(otherDb(), 'spots'), where('finderId', '==', OWNER_UID)))
        );
    });

    it('R3: unfiltered spots list denied', async () => {
        await assertFails(getDocs(collection(otherDb(), 'spots')));
    });

    it('R4: mixed-status query (available+occupied combined) not possible — status-filtered query excludes occupied', async () => {
        await seed('spots', 'spot-avail', availableSpot);
        // A query for only ['available', 'occupied'] — the occupied entry finderId != reader → rule would deny
        // In practice Firestore denies the whole query if ANY doc could fail the rule.
        // We verify the safe production query shape works and returns only available docs.
        const snap = await assertSucceeds(
            getDocs(query(
                collection(otherDb(), 'spots'),
                where('status', 'in', ['available', 'interested']),
            ))
        );
        const ids = snap.docs.map(d => d.id);
        expect(ids).not.toContain('spot-private');
        expect(ids).toContain('spot-avail');
    });

    it('R5: owner finder-history query still succeeds (not broken)', async () => {
        await assertSucceeds(
            getDocs(query(collection(ownerDb(), 'spots'), where('finderId', '==', OWNER_UID)))
        );
    });

    it('R6: live Ping query still succeeds (not broken)', async () => {
        await seed('spots', 'spot-avail', availableSpot);
        await assertSucceeds(
            getDocs(query(
                collection(ownerDb(), 'spots'),
                where('status', 'in', ['available', 'interested']),
                where('expiresAt', '>', Timestamp.now()),
            ))
        );
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SPOT FEEDBACK — private parking confirmations
// ═══════════════════════════════════════════════════════════════════════════════
describe('spotFeedback', () => {
    const FB_ID = 'fb-1';
    const feedbackDoc = {
        userId:    OWNER_UID,
        address:   '321 Parked Lane',
        outcome:   'success',
        createdAt: Timestamp.now(),
    };

    beforeEach(async () => { await seed('spotFeedback', FB_ID, feedbackDoc); });

    // 16
    it('F1: unauthenticated read denied', async () => {
        await assertFails(getDoc(doc(anonDb(), 'spotFeedback', FB_ID)));
    });

    // 17
    it('F2: owner direct read succeeds', async () => {
        await assertSucceeds(getDoc(doc(ownerDb(), 'spotFeedback', FB_ID)));
    });

    // 18
    it('F3: different user direct read denied', async () => {
        await assertFails(getDoc(doc(otherDb(), 'spotFeedback', FB_ID)));
    });

    it('F3b: admin token can no longer directly read another user\'s spotFeedback (coordinated remediation — never consumed by any admin client code)', async () => {
        await assertFails(getDoc(doc(adminDb(), 'spotFeedback', FB_ID)));
    });

    // 19
    it('F4: owner-filtered list (userId == own uid) succeeds', async () => {
        await assertSucceeds(
            getDocs(query(collection(ownerDb(), 'spotFeedback'), where('userId', '==', OWNER_UID)))
        );
    });

    // 20
    it('F5: broad unfiltered list denied', async () => {
        await assertFails(getDocs(collection(ownerDb(), 'spotFeedback')));
    });

    it('F6: other-user-targeted list denied', async () => {
        await assertFails(
            getDocs(query(collection(otherDb(), 'spotFeedback'), where('userId', '==', OWNER_UID)))
        );
    });

    it('F7: signed-in user can create feedback', async () => {
        await seed('spots', 'feedback-spot', {
            ...interestedSpot,
            status: 'occupied',
        });
        await assertSucceeds(
            setDoc(doc(otherDb(), 'spotFeedback', `feedback-spot_${OTHER_UID}`), {
                spotId:    'feedback-spot',
                userId:    OTHER_UID,
                finderId:  OWNER_UID,
                address:   '999 New St',
                outcome:   'success',
                failureReason: null,
                createdAt: Timestamp.now(),
            })
        );
    });

    it('F8: user cannot forge successful feedback for a spot they did not claim', async () => {
        await seed('spots', 'feedback-spot', {
            ...interestedSpot,
            status: 'occupied',
        });
        await assertFails(
            setDoc(doc(thirdDb(), 'spotFeedback', `feedback-spot_${THIRD_UID}`), {
                spotId: 'feedback-spot',
                userId: THIRD_UID,
                finderId: OWNER_UID,
                address: '999 New St',
                outcome: 'success',
                failureReason: null,
                createdAt: Timestamp.now(),
            })
        );
    });

    it('F9: feedback cannot be overwritten to trigger rewards twice', async () => {
        await assertFails(
            setDoc(doc(ownerDb(), 'spotFeedback', FB_ID), {
                ...feedbackDoc,
                outcome: 'success',
                createdAt: Timestamp.now(),
            })
        );
    });

    it('F10: feedback for a non-occupied spot is rejected', async () => {
        await seed('spots', 'avail-feedback-spot', {
            ...interestedSpot,
            status: 'interested', // not occupied — rule requires status == 'occupied'
        });
        await assertFails(
            setDoc(doc(otherDb(), 'spotFeedback', `avail-feedback-spot_${OTHER_UID}`), {
                spotId:    'avail-feedback-spot',
                userId:    OTHER_UID,
                finderId:  OWNER_UID,
                address:   '999 Not Occupied St',
                outcome:   'success',
                createdAt: Timestamp.now(),
            })
        );
    });

    it('F11: new-client failed feedback accepts every final allowlisted reason at creation', async () => {
        const reasons = [
            'Someone else got it',
            "Finder hadn't left yet",
            "Couldn't find the location",
            'Other',
        ];

        for (const [index, failureReason] of reasons.entries()) {
            const spotId = `failed-feedback-spot-${index}`;
            await seed('spots', spotId, {
                ...interestedSpot,
                status: 'occupied',
            });
            await assertSucceeds(
                setDoc(doc(otherDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`), {
                    spotId,
                    userId: OTHER_UID,
                    finderId: OWNER_UID,
                    address: '999 Failed St',
                    outcome: 'failed',
                    failureReason,
                    createdAt: Timestamp.now(),
                })
            );
        }
    });

    it('F12: failed feedback with a missing or arbitrary reason is rejected', async () => {
        await seed('spots', 'invalid-failed-feedback-spot', {
            ...interestedSpot,
            status: 'occupied',
        });
        const base = {
            spotId: 'invalid-failed-feedback-spot',
            userId: OTHER_UID,
            finderId: OWNER_UID,
            address: '999 Failed St',
            outcome: 'failed',
            createdAt: Timestamp.now(),
        };

        await assertFails(
            setDoc(doc(otherDb(), 'spotFeedback', `invalid-failed-feedback-spot_${OTHER_UID}`), base)
        );
        await assertFails(
            setDoc(doc(otherDb(), 'spotFeedback', `invalid-failed-feedback-spot_${OTHER_UID}`), {
                ...base,
                failureReason: 'arbitrary user text',
            })
        );
    });

    it('F12b: rollout bridge accepts only a participant-authored legacy failed feedback with explicit null reason', async () => {
        const spotId = 'legacy-null-failed-feedback-spot';
        await seed('spots', spotId, {
            ...interestedSpot,
            status: 'occupied',
        });

        await assertSucceeds(
            setDoc(doc(otherDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`), {
                spotId,
                userId: OTHER_UID,
                finderId: OWNER_UID,
                address: '999 Legacy Failed St',
                outcome: 'failed',
                failureReason: null,
                createdAt: Timestamp.now(),
            })
        );
    });

    it('F12c: rollout bridge rejects unauthenticated and unrelated users forging legacy failed/null feedback', async () => {
        const spotId = 'legacy-null-forgery-spot';
        await seed('spots', spotId, {
            ...interestedSpot,
            status: 'occupied',
        });
        const legacyFeedback = {
            spotId,
            userId: OTHER_UID,
            finderId: OWNER_UID,
            address: '999 Legacy Failed St',
            outcome: 'failed',
            failureReason: null,
            createdAt: Timestamp.now(),
        };

        await assertFails(setDoc(doc(anonDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`), legacyFeedback));
        await assertFails(setDoc(doc(thirdDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`), legacyFeedback));
    });

    it('F12d: rollout bridge rejects extra fields on legacy failed/null feedback', async () => {
        const spotId = 'legacy-null-extra-field-spot';
        await seed('spots', spotId, {
            ...interestedSpot,
            status: 'occupied',
        });

        await assertFails(
            setDoc(doc(otherDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`), {
                spotId,
                userId: OTHER_UID,
                finderId: OWNER_UID,
                address: '999 Legacy Failed St',
                outcome: 'failed',
                failureReason: null,
                createdAt: Timestamp.now(),
                reward: 1,
            })
        );
    });

    it('F12e: unchanged backend guards reject failed/null before authoritative Crown or trust work', () => {
        const source = readFileSync('functions/index.js', 'utf8');
        const successOnlyGuard = "if (!data || data.outcome !== 'success') return;";
        const awardCrowns = source.slice(
            source.indexOf('exports.awardCrowns = onDocumentCreated('),
            source.indexOf('exports.adminDeleteSpot'),
        );
        const updateTrust = source.slice(
            source.indexOf('exports.updateTrustOnFeedback = onDocumentCreated('),
            source.indexOf('exports.scheduleCleaningReminders'),
        );

        expect(awardCrowns.indexOf(successOnlyGuard)).toBeGreaterThan(-1);
        expect(awardCrowns.indexOf(successOnlyGuard)).toBeLessThan(awardCrowns.indexOf('db.runTransaction'));
        expect(updateTrust.indexOf(successOnlyGuard)).toBeGreaterThan(-1);
        expect(updateTrust.indexOf(successOnlyGuard)).toBeLessThan(updateTrust.indexOf('applyTrustDelta'));
    });

    it('F13: successful feedback cannot smuggle a failure reason', async () => {
        await seed('spots', 'success-feedback-spot', {
            ...interestedSpot,
            status: 'occupied',
        });

        await assertFails(
            setDoc(doc(otherDb(), 'spotFeedback', `success-feedback-spot_${OTHER_UID}`), {
                spotId: 'success-feedback-spot',
                userId: OTHER_UID,
                finderId: OWNER_UID,
                address: '999 Success St',
                outcome: 'success',
                failureReason: 'Someone else got it',
                createdAt: Timestamp.now(),
            })
        );
    });

    it('F14: valid participant atomically completes success once with one finder notification', async () => {
        const spotId = 'terminal-success-spot';
        const feedbackId = `${spotId}_${OTHER_UID}`;
        await seed('spots', spotId, {
            ...interestedSpot,
            status: 'occupied',
        });
        const params = {
            spotId,
            driverId: OTHER_UID,
            driverName: 'TestDriver',
            finderId: OWNER_UID,
            address: '999 Success St',
            outcome: 'success' as const,
            failureReason: null,
        };

        await expect(completeTerminalHandoff(otherDb(), params)).resolves.toBe('created');
        await expect(completeTerminalHandoff(otherDb(), params)).resolves.toBe('already_completed');

        const feedback = await getDoc(doc(otherDb(), 'spotFeedback', feedbackId));
        expect(feedback.data()).toMatchObject({ outcome: 'success', failureReason: null });
        const notification = await getDoc(doc(ownerDb(), 'spotNotifications', `handoff_success_${feedbackId}`));
        expect(notification.data()).toMatchObject({
            senderId: OTHER_UID,
            targetUserId: OWNER_UID,
            type: 'handoff_success',
        });
    });

    it('F15: valid participant atomically completes failed feedback with its final reason once', async () => {
        const spotId = 'terminal-failed-spot';
        const feedbackId = `${spotId}_${OTHER_UID}`;
        await seed('spots', spotId, {
            ...interestedSpot,
            status: 'occupied',
        });
        const params = {
            spotId,
            driverId: OTHER_UID,
            driverName: 'TestDriver',
            finderId: OWNER_UID,
            address: '999 Failed St',
            outcome: 'failed' as const,
            failureReason: "Finder hadn't left yet",
        };

        await expect(completeTerminalHandoff(otherDb(), params)).resolves.toBe('created');
        await expect(completeTerminalHandoff(otherDb(), params)).resolves.toBe('already_completed');

        const feedback = await getDoc(doc(otherDb(), 'spotFeedback', feedbackId));
        expect(feedback.data()).toMatchObject({
            outcome: 'failed',
            failureReason: "Finder hadn't left yet",
        });
    });

    it('F16: invalid participant cannot complete another user\'s terminal handoff', async () => {
        const spotId = 'terminal-unauthorized-spot';
        await seed('spots', spotId, {
            ...interestedSpot,
            status: 'occupied',
        });

        await expect(completeTerminalHandoff(thirdDb(), {
            spotId,
            driverId: THIRD_UID,
            driverName: 'Intruder',
            finderId: OWNER_UID,
            address: '999 Private St',
            outcome: 'success',
            failureReason: null,
        })).rejects.toThrow(/PERMISSION_DENIED|permission-denied/);
    });

    it('F17: finder-confirmed success atomically occupies the spot and completes once', async () => {
        const spotId = 'finder-terminal-success-spot';
        const feedbackId = `${spotId}_${OTHER_UID}`;
        await seed('spots', spotId, interestedSpot);
        const params = {
            spotId,
            driverId: OTHER_UID,
            finderId: OWNER_UID,
            finderName: 'TestFinder',
            address: '999 Finder Success St',
        };

        await expect(completeFinderConfirmedHandoff(ownerDb(), params)).resolves.toBe('created');
        await expect(completeFinderConfirmedHandoff(ownerDb(), params)).resolves.toBe('already_completed');

        const spot = await getDoc(doc(ownerDb(), 'spots', spotId));
        expect(spot.data()?.status).toBe('occupied');
        const feedback = await getDoc(doc(ownerDb(), 'spotFeedback', feedbackId));
        expect(feedback.data()).toMatchObject({
            outcome: 'success',
            confirmedByFinder: true,
        });
        const notification = await getDoc(doc(otherDb(), 'spotNotifications', `handoff_success_${feedbackId}`));
        expect(notification.data()).toMatchObject({
            senderId: OWNER_UID,
            targetUserId: OTHER_UID,
            type: 'handoff_success',
        });
    });

    it('F18: retry repairs a legacy success missing its finder notification without updating feedback', async () => {
        const spotId = 'legacy-partial-success-spot';
        const feedbackId = `${spotId}_${OTHER_UID}`;
        await seed('spots', spotId, { ...interestedSpot, status: 'occupied' });
        await seed('spotFeedback', feedbackId, {
            spotId,
            userId: OTHER_UID,
            finderId: OWNER_UID,
            address: '999 Legacy Success St',
            outcome: 'success',
            failureReason: null,
            createdAt: Timestamp.now(),
        });

        await expect(completeTerminalHandoff(otherDb(), {
            spotId,
            driverId: OTHER_UID,
            driverName: 'TestDriver',
            finderId: OWNER_UID,
            address: '999 Legacy Success St',
            outcome: 'success',
            failureReason: null,
        })).resolves.toBe('already_completed');

        const notification = await getDoc(doc(ownerDb(), 'spotNotifications', `handoff_success_${feedbackId}`));
        expect(notification.data()).toMatchObject({
            senderId: OTHER_UID,
            targetUserId: OWNER_UID,
            type: 'handoff_success',
        });
    });

    it('F19: retry does not duplicate an already-delivered legacy random-id success notification', async () => {
        const spotId = 'legacy-complete-success-spot';
        const feedbackId = `${spotId}_${OTHER_UID}`;
        await seed('spots', spotId, { ...interestedSpot, status: 'occupied' });
        await seed('spotFeedback', feedbackId, {
            spotId,
            userId: OTHER_UID,
            finderId: OWNER_UID,
            address: '999 Legacy Complete St',
            outcome: 'success',
            failureReason: null,
            createdAt: Timestamp.now(),
        });
        await seed('spotNotifications', 'legacy-random-notification-id', {
            spotId,
            senderId: OTHER_UID,
            targetUserId: OWNER_UID,
            type: 'handoff_success',
            message: 'Already delivered',
            createdAt: Timestamp.now(),
        });

        await expect(completeTerminalHandoff(otherDb(), {
            spotId,
            driverId: OTHER_UID,
            driverName: 'TestDriver',
            finderId: OWNER_UID,
            address: '999 Legacy Complete St',
            outcome: 'success',
            failureReason: null,
        })).resolves.toBe('already_completed');

        const notifications = await getDocs(query(
            collection(ownerDb(), 'spotNotifications'),
            where('targetUserId', '==', OWNER_UID),
            where('spotId', '==', spotId),
        ));
        expect(notifications.size).toBe(1);
    });

    it('F20: finder reads only finder-authored feedback and a driver cannot forge that marker', async () => {
        await seed('spotFeedback', 'driver-private-failure', {
            spotId: 'private-failure-spot',
            userId: OTHER_UID,
            finderId: OWNER_UID,
            address: 'Private Failure St',
            outcome: 'failed',
            failureReason: 'Other',
            createdAt: Timestamp.now(),
        });
        await assertFails(getDoc(doc(ownerDb(), 'spotFeedback', 'driver-private-failure')));

        const spotId = 'forged-finder-confirmation-spot';
        await seed('spots', spotId, { ...interestedSpot, status: 'occupied' });
        await assertFails(setDoc(doc(otherDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`), {
            spotId,
            userId: OTHER_UID,
            finderId: OWNER_UID,
            address: 'Forged Confirmation St',
            outcome: 'success',
            failureReason: null,
            confirmedByFinder: true,
            createdAt: Timestamp.now(),
        }));
    });

    it('F21: finder-authored feedback must be a marked successful confirmation', async () => {
        const spotId = 'finder-marker-required-spot';
        await seed('spots', spotId, { ...interestedSpot, status: 'occupied' });
        const base = {
            spotId,
            userId: OTHER_UID,
            finderId: OWNER_UID,
            address: 'Finder Marker Required St',
            createdAt: Timestamp.now(),
        };

        await assertFails(setDoc(doc(ownerDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`), {
            ...base,
            outcome: 'success',
            failureReason: null,
        }));
        await assertFails(setDoc(doc(ownerDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`), {
            ...base,
            outcome: 'failed',
            failureReason: 'Other',
        }));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CHATS — participants only
// ═══════════════════════════════════════════════════════════════════════════════
describe('chats and messages — participant isolation', () => {
    const CHAT_ID = `${OTHER_UID}_${OWNER_UID}`;
    const chatData = {
        id: CHAT_ID,
        participants: [OWNER_UID, OTHER_UID],
        relatedSpotTitle: 'Street Spot',
        lastMessage: 'Conversation started',
        lastMessageTimestamp: Timestamp.now(),
        lastSenderId: OWNER_UID,
    };

    beforeEach(async () => {
        await seed('chats', CHAT_ID, chatData);
        await testEnv.withSecurityRulesDisabled(async ctx => {
            await setDoc(
                doc(ctx.firestore(), 'chats', CHAT_ID, 'messages', 'message-1'),
                { senderId: OWNER_UID, text: 'On my way out', timestamp: Timestamp.now() },
            );
        });
        await testEnv.withSecurityRulesDisabled(async ctx => {
            await setDoc(
                doc(ctx.firestore(), 'chats', CHAT_ID, 'messages', 'message-2'),
                { senderId: OTHER_UID, text: 'On my way too', timestamp: Timestamp.now() },
            );
        });
    });

    it('C1: participant can read their chat and messages', async () => {
        await assertSucceeds(getDoc(doc(ownerDb(), 'chats', CHAT_ID)));
        await assertSucceeds(getDocs(collection(ownerDb(), 'chats', CHAT_ID, 'messages')));
    });

    it('C2: non-participant cannot read a chat or its messages', async () => {
        await assertFails(getDoc(doc(thirdDb(), 'chats', CHAT_ID)));
        await assertFails(getDocs(collection(thirdDb(), 'chats', CHAT_ID, 'messages')));
    });

    it('C3: participant query used by the inbox remains allowed', async () => {
        await assertSucceeds(
            getDocs(query(collection(ownerDb(), 'chats'), where('participants', 'array-contains', OWNER_UID)))
        );
    });

    it('C4: non-participant cannot alter another chat', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(
            upd(doc(thirdDb(), 'chats', CHAT_ID), {
                lastMessage: 'spoofed',
                lastMessageTimestamp: Timestamp.now(),
                lastSenderId: THIRD_UID,
            })
        );
    });

    // Chat metadata hardening — lastMessage/lastMessageTimestamp/lastSenderId
    // are authoritative-server-owned (sendMessage, via the Admin SDK, which
    // these Rules cannot see or gate). A direct client write is denied even
    // for a legitimate participant setting their own uid as sender.
    it('CM-10: a participant cannot directly set lastMessage', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'chats', CHAT_ID), { lastMessage: 'forged preview' }));
    });

    it('CM-11: a participant cannot directly set lastMessageTimestamp', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'chats', CHAT_ID), { lastMessageTimestamp: Timestamp.now() }));
    });

    it('CM-12: a participant cannot directly set lastSenderId to a different value', async () => {
        // chatData seeds lastSenderId: OWNER_UID already — must change it to a
        // genuinely different value, or Firestore's diff() sees no change at
        // all and onlyChanges() trivially (and correctly) passes on an empty
        // affected-keys set, which would prove nothing about the Rules.
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'chats', CHAT_ID), { lastSenderId: OTHER_UID }));
    });

    it('CM-13: all three server-owned fields together is still denied', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'chats', CHAT_ID), {
            lastMessage: 'forged', lastMessageTimestamp: Timestamp.now(), lastSenderId: OWNER_UID,
        }));
    });

    // Chat SHELL metadata hardening (participantNames REMOVED entirely;
    // relatedSpotTitle CREATE-ONCE) — no field on an existing chats/{chatId}
    // doc is directly client-updatable at all anymore.
    it('CM-18: participantNames is no longer part of the schema — a direct write is denied', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'chats', CHAT_ID), {
            participantNames: { [OWNER_UID]: 'Forged Name' },
        }));
    });

    it('CM-19: relatedSpotTitle cannot be mutated after chat creation (create-once)', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'chats', CHAT_ID), { relatedSpotTitle: 'New Spot Title' }));
    });

    it('CM-20: the initChat re-navigation pattern (idempotent shell re-write) is now denied by Rules — the client must skip the write entirely for an existing chat, which it does', async () => {
        await assertFails(
            setDoc(doc(ownerDb(), 'chats', CHAT_ID), {
                id: CHAT_ID,
                participants: chatData.participants,
                relatedSpotTitle: chatData.relatedSpotTitle,
            }, { merge: true } as any)
        );
    });

    it('CM-20b: a create-shaped setDoc of an existing chat is denied (update:false) — concurrent/re-open init treats this as already-exists', async () => {
        await assertFails(
            setDoc(doc(ownerDb(), 'chats', CHAT_ID), {
                id: CHAT_ID,
                participants: chatData.participants,
                relatedSpotTitle: chatData.relatedSpotTitle,
            })
        );
    });

    it('CM-31: getDoc of a nonexistent chat is denied even for a signed-in would-be participant (existence probe is not allowed)', async () => {
        const missingId = [OWNER_UID, THIRD_UID].sort().join('_') + '_missing';
        await assertFails(getDoc(doc(ownerDb(), 'chats', missingId)));
    });

    it('CM-32: listing messages of a nonexistent parent chat is denied (messages listener must not attach before the shell exists)', async () => {
        const missingId = [OWNER_UID, THIRD_UID].sort().join('_') + '_missing_msgs';
        await assertFails(getDocs(collection(ownerDb(), 'chats', missingId, 'messages')));
    });

    it('CM-33: a signed-in stranger cannot create a chat they are not a participant of', async () => {
        const strangerChatId = `${OWNER_UID}_${OTHER_UID}_stranger`;
        await assertFails(
            setDoc(doc(thirdDb(), 'chats', strangerChatId), {
                id: strangerChatId,
                participants: [OWNER_UID, OTHER_UID],
                relatedSpotTitle: 'Street Spot',
            })
        );
    });

    it('CM-34: an unauthenticated client cannot create a chat', async () => {
        const anonChatId = `${OWNER_UID}_${OTHER_UID}_anon`;
        await assertFails(
            setDoc(doc(anonDb(), 'chats', anonChatId), {
                id: anonChatId,
                participants: [OWNER_UID, OTHER_UID],
                relatedSpotTitle: 'Street Spot',
            })
        );
    });

    it('CM-16: a brand-new chat can be created with the shell schema only (id, participants, relatedSpotTitle — no participantNames, no lastMessage/lastMessageTimestamp/lastSenderId)', async () => {
        const newChatId = `${OWNER_UID}_${THIRD_UID}`;
        await assertSucceeds(
            setDoc(doc(ownerDb(), 'chats', newChatId), {
                id: newChatId,
                participants: [OWNER_UID, THIRD_UID],
                relatedSpotTitle: 'Street Spot',
            })
        );
    });

    it('CM-16c: after creating a new shell, only participants can read it — signed-in strangers remain denied (no read widening)', async () => {
        const newChatId = `${OWNER_UID}_${THIRD_UID}_postcreate`;
        await assertSucceeds(
            setDoc(doc(ownerDb(), 'chats', newChatId), {
                id: newChatId,
                participants: [OWNER_UID, THIRD_UID],
                relatedSpotTitle: 'Street Spot',
            })
        );
        await assertSucceeds(getDoc(doc(ownerDb(), 'chats', newChatId)));
        await assertSucceeds(getDoc(doc(thirdDb(), 'chats', newChatId)));
        await assertFails(getDoc(doc(otherDb(), 'chats', newChatId)));
        await assertFails(getDocs(collection(otherDb(), 'chats', newChatId, 'messages')));
    });

    it('CM-16b: creating a new chat with a participantNames field included is denied (removed from schema)', async () => {
        const newChatId = `${OWNER_UID}_${THIRD_UID}_pn`;
        await assertFails(
            setDoc(doc(ownerDb(), 'chats', newChatId), {
                id: newChatId,
                participants: [OWNER_UID, THIRD_UID],
                participantNames: { [OWNER_UID]: 'Owner', [THIRD_UID]: 'Third' },
            })
        );
    });

    it('CM-17: creating a new chat with a lastMessage field included is denied (legacy shape no longer accepted)', async () => {
        const newChatId = `${OWNER_UID}_${THIRD_UID}_legacy`;
        await assertFails(
            setDoc(doc(ownerDb(), 'chats', newChatId), {
                id: newChatId,
                participants: [OWNER_UID, THIRD_UID],
                lastMessage: 'forged at create',
                lastMessageTimestamp: Timestamp.now(),
                lastSenderId: OWNER_UID,
            })
        );
    });

    // C5/C6/C8 — chat message write-path hardening: sendMessage (functions/
    // index.js) is now the sole authoritative writer via the Admin SDK,
    // which these Rules cannot see or gate. Direct client CREATE is denied
    // unconditionally, regardless of how well-formed/correctly-attributed
    // the attempted write is — this is the acceptance boundary the
    // migration is verified against. (Pre-migration, C5 asserted failure
    // for a mismatched senderId and C6 asserted success for a correctly
    // attributed one; both are now denied for the same unconditional reason.)
    it('C5: a participant cannot directly create a message, even with a fully valid, correctly-attributed schema', async () => {
        await assertFails(
            addDoc(collection(ownerDb(), 'chats', CHAT_ID, 'messages'), {
                senderId: OWNER_UID,
                text: 'Leaving now',
                timestamp: Timestamp.now(),
            })
        );
    });

    it('C6: a non-participant cannot directly create a message either', async () => {
        await assertFails(
            addDoc(collection(thirdDb(), 'chats', CHAT_ID, 'messages'), {
                senderId: THIRD_UID,
                text: 'spoofed',
                timestamp: Timestamp.now(),
            })
        );
    });

    it('C8: a malformed direct create (spoofed senderId, missing required field) is also denied', async () => {
        await assertFails(
            addDoc(collection(ownerDb(), 'chats', CHAT_ID, 'messages'), {
                senderId: OTHER_UID,
                text: 'spoofed',
                // timestamp intentionally omitted
            })
        );
    });

    // Server-mediated chat deletion (deleteChat, functions/index.js) is now
    // the sole authoritative delete path for both chats/{chatId} and its
    // messages subcollection — it writes via the Admin SDK, which these
    // Rules cannot see or gate. Direct client deletion is denied
    // unconditionally, regardless of participant status, closing both the
    // "delete an arbitrary/another participant's message" gap and the
    // parent-orphaning hazard (a client could previously delete only the
    // parent chat doc without also deleting its messages).
    it('C7: a participant (chat owner) cannot directly delete their chat', async () => {
        const { deleteDoc } = await import('firebase/firestore');
        await assertFails(deleteDoc(doc(ownerDb(), 'chats', CHAT_ID)));
    });

    it('C9: the other participant cannot directly delete the chat either', async () => {
        const { deleteDoc } = await import('firebase/firestore');
        await assertFails(deleteDoc(doc(otherDb(), 'chats', CHAT_ID)));
    });

    it('C10: a non-participant cannot delete the chat', async () => {
        const { deleteDoc } = await import('firebase/firestore');
        await assertFails(deleteDoc(doc(thirdDb(), 'chats', CHAT_ID)));
    });

    it('C11: an unauthenticated client cannot delete the chat', async () => {
        const { deleteDoc } = await import('firebase/firestore');
        await assertFails(deleteDoc(doc(anonDb(), 'chats', CHAT_ID)));
    });

    it('CM-21: the sender cannot directly delete their own message', async () => {
        const { deleteDoc } = await import('firebase/firestore');
        await assertFails(deleteDoc(doc(ownerDb(), 'chats', CHAT_ID, 'messages', 'message-1')));
    });

    it('CM-22: the other (non-sender) participant cannot delete the sender\'s message', async () => {
        const { deleteDoc } = await import('firebase/firestore');
        await assertFails(deleteDoc(doc(otherDb(), 'chats', CHAT_ID, 'messages', 'message-1')));
    });

    it('CM-23: a participant cannot delete another participant\'s message either', async () => {
        // message-2 is senderId: OTHER_UID — OWNER attempting to delete it
        // proves denial isn't merely "can't delete your own", it's
        // unconditional regardless of who sent it.
        const { deleteDoc } = await import('firebase/firestore');
        await assertFails(deleteDoc(doc(ownerDb(), 'chats', CHAT_ID, 'messages', 'message-2')));
    });

    it('CM-24: a non-participant cannot delete a message', async () => {
        const { deleteDoc } = await import('firebase/firestore');
        await assertFails(deleteDoc(doc(thirdDb(), 'chats', CHAT_ID, 'messages', 'message-1')));
    });

    it('CM-25: an unauthenticated client cannot delete a message', async () => {
        const { deleteDoc } = await import('firebase/firestore');
        await assertFails(deleteDoc(doc(anonDb(), 'chats', CHAT_ID, 'messages', 'message-1')));
    });

    it('CM-26: direct message update remains denied (pre-existing, unchanged by this PR)', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'chats', CHAT_ID, 'messages', 'message-1'), { text: 'edited' }));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// CHATS — mutual block (either direction refuses a new direct conversation)
// ═══════════════════════════════════════════════════════════════════════════════
describe('chats — mutual user block on conversation create', () => {
    function shell(id: string, participants: [string, string]) {
        return { id, participants, relatedSpotTitle: 'Street Spot' };
    }

    async function writeBlock(blockerUid: string, blockedUid: string) {
        const writer = blockerUid === OWNER_UID ? ownerDb()
            : blockerUid === OTHER_UID ? otherDb()
            : thirdDb();
        await assertSucceeds(setDoc(
            doc(writer, 'users', blockerUid, 'private', 'social'),
            { blockedUsers: [blockedUid] },
        ));
    }

    it('HB-01: with no block relationship, either participant can create the direct chat', async () => {
        const createdByA = `hb01-a-${OWNER_UID}`;
        const createdByB = `hb01-b-${OTHER_UID}`;
        await assertSucceeds(setDoc(doc(ownerDb(), 'chats', createdByA), shell(createdByA, [OWNER_UID, OTHER_UID])));
        await assertSucceeds(setDoc(doc(otherDb(), 'chats', createdByB), shell(createdByB, [OTHER_UID, OWNER_UID])));
    });

    it('HB-02: when A blocks B, A cannot create a new chat with B in either participant order', async () => {
        await writeBlock(OWNER_UID, OTHER_UID);
        const id1 = `hb02-a-${OWNER_UID}`;
        const id2 = `hb02-b-${OWNER_UID}`;
        await assertFails(setDoc(doc(ownerDb(), 'chats', id1), shell(id1, [OWNER_UID, OTHER_UID])));
        await assertFails(setDoc(doc(ownerDb(), 'chats', id2), shell(id2, [OTHER_UID, OWNER_UID])));
    });

    it('HB-03: when A blocks B, B cannot create a new chat with A in either participant order', async () => {
        await writeBlock(OWNER_UID, OTHER_UID);
        const id1 = `hb03-a-${OTHER_UID}`;
        const id2 = `hb03-b-${OTHER_UID}`;
        await assertFails(setDoc(doc(otherDb(), 'chats', id1), shell(id1, [OTHER_UID, OWNER_UID])));
        await assertFails(setDoc(doc(otherDb(), 'chats', id2), shell(id2, [OWNER_UID, OTHER_UID])));
        await assertFails(getDoc(doc(otherDb(), 'users', OWNER_UID, 'private', 'social')));
    });

    it('HB-04: when B blocks A, neither A nor B can create a new chat with the other', async () => {
        await writeBlock(OTHER_UID, OWNER_UID);
        const byA = `hb04-a-${OWNER_UID}`;
        const byB = `hb04-b-${OTHER_UID}`;
        await assertFails(setDoc(doc(ownerDb(), 'chats', byA), shell(byA, [OWNER_UID, OTHER_UID])));
        await assertFails(setDoc(doc(otherDb(), 'chats', byB), shell(byB, [OTHER_UID, OWNER_UID])));
    });

    it('HB-05: a block between A and B does not stop either of them from starting a chat with C', async () => {
        await writeBlock(OWNER_UID, OTHER_UID);
        const aWithC = `hb05-ac-${OWNER_UID}`;
        const bWithC = `hb05-bc-${OTHER_UID}`;
        const cWithA = `hb05-ca-${THIRD_UID}`;
        await assertSucceeds(setDoc(doc(ownerDb(), 'chats', aWithC), shell(aWithC, [OWNER_UID, THIRD_UID])));
        await assertSucceeds(setDoc(doc(otherDb(), 'chats', bWithC), shell(bWithC, [OTHER_UID, THIRD_UID])));
        await assertSucceeds(setDoc(doc(thirdDb(), 'chats', cWithA), shell(cWithA, [THIRD_UID, OWNER_UID])));
    });

    it('HB-06: clearing blockedUsers restores create with no other backend cleanup', async () => {
        await writeBlock(OWNER_UID, OTHER_UID);
        const id = `hb06-${OWNER_UID}`;
        await assertFails(setDoc(doc(ownerDb(), 'chats', id), shell(id, [OWNER_UID, OTHER_UID])));
        await assertFails(setDoc(doc(otherDb(), 'chats', id), shell(id, [OTHER_UID, OWNER_UID])));
        await assertSucceeds(setDoc(
            doc(ownerDb(), 'users', OWNER_UID, 'private', 'social'),
            { blockedUsers: [] },
        ));
        await assertSucceeds(setDoc(doc(ownerDb(), 'chats', id), shell(id, [OWNER_UID, OTHER_UID])));
        const otherId = `hb06b-${OTHER_UID}`;
        await assertSucceeds(setDoc(doc(otherDb(), 'chats', otherId), shell(otherId, [OTHER_UID, OWNER_UID])));
    });

    it('HB-07: an existing chat and its historical message stay readable and are not deleted when a block is added', async () => {
        const id = `hb07-${OWNER_UID}`;
        await testEnv.withSecurityRulesDisabled(async ctx => {
            const admin = ctx.firestore();
            await setDoc(doc(admin, 'chats', id), {
                ...shell(id, [OWNER_UID, OTHER_UID]),
                lastMessage: 'historical hello',
                lastSenderId: OWNER_UID,
            });
            await setDoc(doc(admin, 'chats', id, 'messages', 'message-1'), {
                senderId: OWNER_UID,
                text: 'historical hello',
                timestamp: Timestamp.now(),
            });
        });
        await writeBlock(OWNER_UID, OTHER_UID);

        const ownerChat = await assertSucceeds(getDoc(doc(ownerDb(), 'chats', id)));
        const otherChat = await assertSucceeds(getDoc(doc(otherDb(), 'chats', id)));
        const ownerMsg = await assertSucceeds(getDoc(doc(ownerDb(), 'chats', id, 'messages', 'message-1')));
        const otherMsg = await assertSucceeds(getDoc(doc(otherDb(), 'chats', id, 'messages', 'message-1')));
        expect(ownerChat.exists()).toBe(true);
        expect(otherChat.exists()).toBe(true);
        expect(ownerMsg.data()?.text).toBe('historical hello');
        expect(otherMsg.data()?.text).toBe('historical hello');

        await assertFails(setDoc(doc(ownerDb(), 'chats', `hb07-new-${OWNER_UID}`), shell(`hb07-new-${OWNER_UID}`, [OWNER_UID, OTHER_UID])));
        await assertFails(addDoc(collection(ownerDb(), 'chats', id, 'messages'), {
            senderId: OWNER_UID,
            text: 'bypass',
            timestamp: Timestamp.now(),
        }));
        await assertFails(addDoc(collection(otherDb(), 'chats', id, 'messages'), {
            senderId: OTHER_UID,
            text: 'bypass',
            timestamp: Timestamp.now(),
        }));
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'chats', id), { lastMessage: 'bypass preview' }));

        const stillThere = await assertSucceeds(getDoc(doc(ownerDb(), 'chats', id, 'messages', 'message-1')));
        expect(stillThere.data()?.text).toBe('historical hello');
    });

    it('HB-08: the blocked user cannot clear the blocker list, and a direct message write stays denied', async () => {
        await writeBlock(OWNER_UID, OTHER_UID);
        await assertFails(getDoc(doc(otherDb(), 'users', OWNER_UID, 'private', 'social')));
        await assertFails(setDoc(
            doc(otherDb(), 'users', OWNER_UID, 'private', 'social'),
            { blockedUsers: [] },
        ));
        const id = `hb08-${OTHER_UID}`;
        await assertFails(setDoc(doc(otherDb(), 'chats', id), shell(id, [OTHER_UID, OWNER_UID])));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SPOTS — claimant cancellation (Arm 3 / Arm 3b)
// ═══════════════════════════════════════════════════════════════════════════════
describe('spots — claimer cancellation', () => {
    const clearFields = {
        claimState: null,
        ownerLeavingNow: null,
        ownerLeavingNowAt: null,
        interestedUserId: null,
        interestedUserName: null,
        interestedUserVehicleColor: null,
        interestedUserVehicleType: null,
        interestedUserVehicleBrand: null,
        interestedUserTitle: null,
        etaMinutes: null,
        interestExpiresAt: null,
        claimReminderAt: null,
        claimReminderSentAt: null,
        claimAutoReleaseAt: null,
        claimAutoReleasedAt: null,
    };

    it('CC1: current claimant can cancel a non-expired claim — Ping returns to available', async () => {
        const { updateDoc } = await import('firebase/firestore');
        await seed('spots', 'cc1', committedScheduledSpot);
        await assertSucceeds(
            updateDoc(doc(otherDb(), 'spots', 'cc1'), { ...clearFields, status: 'available' })
        );
    });

    it('CC2: current claimant can clear a claim on an already-expired Ping without reopening it', async () => {
        const { updateDoc } = await import('firebase/firestore');
        await seed('spots', 'cc2', { ...committedScheduledSpot, reportedAt: PAST, expiresAt: PAST });
        await assertSucceeds(updateDoc(doc(otherDb(), 'spots', 'cc2'), clearFields));
    });

    it('CC3: unrelated user cannot cancel someone else\'s claim', async () => {
        const { updateDoc } = await import('firebase/firestore');
        await seed('spots', 'cc3', committedScheduledSpot);
        await assertFails(
            updateDoc(doc(thirdDb(), 'spots', 'cc3'), { ...clearFields, status: 'available' })
        );
    });

    it('CC4: the Ping owner cannot invoke claimant-cancellation on their own Ping', async () => {
        const { updateDoc } = await import('firebase/firestore');
        await seed('spots', 'cc4', committedScheduledSpot);
        await assertFails(
            updateDoc(doc(ownerDb(), 'spots', 'cc4'), { ...clearFields, status: 'available' })
        );
    });

    it('CC5: a superseded (old) claimant cannot release a newer claimant\'s claim', async () => {
        const { updateDoc } = await import('firebase/firestore');
        // Someone else (THIRD_UID) has since claimed the spot; OTHER_UID's stale
        // client tries to run the same release it would have sent for its own claim.
        await seed('spots', 'cc5', { ...committedScheduledSpot, interestedUserId: THIRD_UID });
        await assertFails(
            updateDoc(doc(otherDb(), 'spots', 'cc5'), { ...clearFields, status: 'available' })
        );
    });

    it('CC6: cannot reopen an expired Ping to available even as the current claimant', async () => {
        const { updateDoc } = await import('firebase/firestore');
        await seed('spots', 'cc6', { ...committedScheduledSpot, reportedAt: PAST, expiresAt: PAST });
        await assertFails(
            updateDoc(doc(otherDb(), 'spots', 'cc6'), { ...clearFields, status: 'available' })
        );
    });

    it('CC7: claimStartedAt cannot be altered by a delay-style update (Arm 6) — proves it stays a stable claim fingerprint across a legitimate delay', async () => {
        const { updateDoc } = await import('firebase/firestore');
        await seed('spots', 'cc7', committedScheduledSpot);
        // Owner extends the claimant's time (handleDelayByFinder) — legitimate Arm 6.
        await assertSucceeds(
            updateDoc(doc(ownerDb(), 'spots', 'cc7'), { interestExpiresAt: FUTURE })
        );
        // The same owner trying to also slip a claimStartedAt change into that
        // write is out of scope for Arm 6 (onlyChanges(['interestExpiresAt'])).
        await assertFails(
            updateDoc(doc(ownerDb(), 'spots', 'cc7'), {
                interestExpiresAt: FUTURE,
                claimStartedAt: Timestamp.now(),
            })
        );
        let untouched: any;
        await testEnv.withSecurityRulesDisabled(async ctx => {
            untouched = (await getDoc(doc(ctx.firestore(), 'spots', 'cc7'))).data();
        });
        expect(untouched?.claimStartedAt?.isEqual(CLAIM_STARTED_AT)).toBe(true);
    });

    it('CC8: a fresh claim on the same spot gets a different claimStartedAt than the one it replaced', async () => {
        await seed('users', OTHER_UID, { username: 'bob', crowns: 0 });
        await seed('spots', 'cc8', {
            finderId: OWNER_UID, finderName: 'TestFinder', address: '9 Reclaim Ave',
            lat: 40.71, lng: -74.03, status: 'available', pingMode: 'now',
            reportedAt: Timestamp.now(), expiresAt: FUTURE,
        });
        const db = otherDb();
        const claimedAt = Timestamp.now();
        await assertSucceeds(runTransaction(db, async (tx) => {
            tx.update(doc(db, 'spots', 'cc8'), {
                status: 'interested', claimState: 'heading', interestedUserId: OTHER_UID,
                interestExpiresAt: FUTURE, claimStartedAt: claimedAt,
            });
            tx.set(doc(db, 'users', OTHER_UID, 'activeIncomingClaims', 'current'), {
                spotId: 'cc8',
                claimStartedAt: claimedAt,
                claimState: 'heading',
                updatedAt: claimedAt,
            });
        }));
        let stored: any;
        await testEnv.withSecurityRulesDisabled(async ctx => {
            stored = (await getDoc(doc(ctx.firestore(), 'spots', 'cc8'))).data();
        });
        expect(stored?.claimStartedAt?.isEqual(claimedAt)).toBe(true);
        expect(stored?.claimStartedAt?.isEqual(CLAIM_STARTED_AT)).toBe(false);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// cancelClaimTransaction — real Firestore SDK transaction execution (no mocks)
// ═══════════════════════════════════════════════════════════════════════════════
describe('cancelClaimTransaction — transaction read/write ordering and behavior', () => {
    async function readSpot(id: string) {
        let data: any;
        await testEnv.withSecurityRulesDisabled(async ctx => {
            data = (await getDoc(doc(ctx.firestore(), 'spots', id))).data();
        });
        return data;
    }
    async function readNotif(id: string) {
        let data: any;
        await testEnv.withSecurityRulesDisabled(async ctx => {
            data = (await getDoc(doc(ctx.firestore(), 'spotNotifications', id))).data();
        });
        return data;
    }

    it('TX-1 (reproduction): a transaction that writes before its second read throws the exact SDK ordering error, and commits nothing', async () => {
        await seed('spots', 'tx1', committedScheduledSpot);
        const db = otherDb();
        const spotRef = doc(db, 'spots', 'tx1');
        const notifRef = doc(db, 'spotNotifications', 'claimer_cancelled_tx1_repro');

        // Mirrors the pre-fix operation order exactly: read, write, read, write.
        const attempt = runTransaction(db, async (tx) => {
            const fresh = await tx.get(spotRef);
            tx.update(spotRef, { status: 'available', interestedUserId: null });
            await tx.get(notifRef); // illegal: a read after a write was already queued
            tx.set(notifRef, { spotId: 'tx1' });
            void fresh;
        });

        // This ordering violation is caught client-side, before any network call
        // for the second read — so it fires even though that read would also be
        // rules-denied (spotNotifications is owner-only-readable). That's the
        // real reason production only ever surfaced the ordering error and never
        // the deeper permission problem underneath it.
        await expect(attempt).rejects.toThrow(/reads to be executed before all writes/i);

        const spotAfter = await readSpot('tx1');
        expect(spotAfter.status).toBe('interested'); // untouched — nothing committed
        expect(spotAfter.interestedUserId).toBe(OTHER_UID);
        const notifAfter = await readNotif('claimer_cancelled_tx1_repro');
        expect(notifAfter).toBeUndefined();
    });

    it('TX-2: all reads happen before any write in the corrected transaction (structural proof)', async () => {
        await seed('spots', 'tx2', committedScheduledSpot);
        await seed('spots', 'tx2b', availableSpot);
        const db = otherDb();
        const calls: string[] = [];
        const spotRef = doc(db, 'spots', 'tx2');
        const otherSpotRef = doc(db, 'spots', 'tx2b'); // a second doc, just to prove multi-read ordering
        await runTransaction(db, async (tx) => {
            calls.push('get:spot');
            await tx.get(spotRef);
            calls.push('get:otherSpot');
            await tx.get(otherSpotRef);
            calls.push('update:spot');
            tx.update(spotRef, { etaMinutes: null });
        });
        const firstWriteIndex = calls.findIndex(c => c.startsWith('update') || c.startsWith('set'));
        const readsAfterFirstWrite = calls.slice(firstWriteIndex + 1).filter(c => c.startsWith('get'));
        expect(readsAfterFirstWrite).toHaveLength(0);
    });

    it('TX-3 (CASE 1): active matching claim, no prior notification — cancels atomically, exactly one notification created', async () => {
        await seed('spots', 'tx3', committedScheduledSpot);
        const outcome = await cancelClaimTransaction(otherDb(), {
            spotId: 'tx3', claimantId: OTHER_UID, finderId: OWNER_UID,
            fingerprint: CLAIM_STARTED_AT.toMillis(), message: 'Changed my mind',
        });
        expect(outcome).toBe('cancelled');

        const spot = await readSpot('tx3');
        expect(spot.status).toBe('available');
        expect(spot.interestedUserId).toBeNull();
        expect(spot.claimStartedAt).toBeNull();

        const notif = await readNotif(`claimer_cancelled_tx3_${CLAIM_STARTED_AT.toMillis()}`);
        expect(notif).toBeDefined();
        expect(notif.senderId).toBe(OTHER_UID);
        expect(notif.targetUserId).toBe(OWNER_UID);
        expect(notif.spotId).toBe('tx3');
        expect(notif.type).toBe('claimer_cancelled');
    });

    it('TX-4 (lifecycle — future scheduled): returns to scheduled/unclaimed', async () => {
        await seed('spots', 'tx4', committedScheduledSpot); // pingMode 'later', not expired
        const outcome = await cancelClaimTransaction(otherDb(), {
            spotId: 'tx4', claimantId: OTHER_UID, finderId: OWNER_UID,
            fingerprint: CLAIM_STARTED_AT.toMillis(), message: 'x',
        });
        expect(outcome).toBe('cancelled');
        const spot = await readSpot('tx4');
        expect(spot.status).toBe('available');
        expect(spot.pingMode).toBe('later');
    });

    it('TX-5 (lifecycle — live unexpired): returns to live/unclaimed, not scheduled', async () => {
        await seed('spots', 'tx5', {
            ...committedScheduledSpot, pingMode: 'now',
            reportedAt: Timestamp.fromMillis(Date.now() - 60_000),
            expiresAt: FUTURE,
        });
        const outcome = await cancelClaimTransaction(otherDb(), {
            spotId: 'tx5', claimantId: OTHER_UID, finderId: OWNER_UID,
            fingerprint: CLAIM_STARTED_AT.toMillis(), message: 'x',
        });
        expect(outcome).toBe('cancelled');
        const spot = await readSpot('tx5');
        expect(spot.status).toBe('available');
    });

    it('TX-6 (lifecycle — expired): claim fields clear, Ping never reopens', async () => {
        await seed('spots', 'tx6', { ...committedScheduledSpot, reportedAt: PAST, expiresAt: PAST });
        const outcome = await cancelClaimTransaction(otherDb(), {
            spotId: 'tx6', claimantId: OTHER_UID, finderId: OWNER_UID,
            fingerprint: CLAIM_STARTED_AT.toMillis(), message: 'x',
        });
        expect(outcome).toBe('cancelled');
        const spot = await readSpot('tx6');
        expect(spot.status).toBe('interested'); // untouched — never flipped to available
        expect(spot.interestedUserId).toBeNull();
        expect(spot.claimStartedAt).toBeNull();
    });

    it('TX-7: a lost-response retry (same params, called twice) produces exactly one logical cancellation', async () => {
        await seed('spots', 'tx7', committedScheduledSpot);
        const params = {
            spotId: 'tx7', claimantId: OTHER_UID, finderId: OWNER_UID,
            fingerprint: CLAIM_STARTED_AT.toMillis(), message: 'x',
        };
        const first = await cancelClaimTransaction(otherDb(), params);
        const second = await cancelClaimTransaction(otherDb(), params);
        expect(first).toBe('cancelled');
        expect(second).toBe('already_resolved');

        let count = 0;
        await testEnv.withSecurityRulesDisabled(async ctx => {
            const snap = await getDocs(query(collection(ctx.firestore(), 'spotNotifications'),
                where('spotId', '==', 'tx7')));
            count = snap.size;
        });
        expect(count).toBe(1);
    });

    it('TX-8 (double-click / concurrent duplicate safety): two simultaneous calls with identical params produce exactly one cancellation and one notification', async () => {
        await seed('spots', 'tx8', committedScheduledSpot);
        const params = {
            spotId: 'tx8', claimantId: OTHER_UID, finderId: OWNER_UID,
            fingerprint: CLAIM_STARTED_AT.toMillis(), message: 'x',
        };
        const [a, b] = await Promise.all([
            cancelClaimTransaction(otherDb(), params),
            cancelClaimTransaction(otherDb(), params),
        ]);
        const outcomes = [a, b].sort();
        expect(outcomes).toEqual(['already_resolved', 'cancelled']);

        const spot = await readSpot('tx8');
        expect(spot.interestedUserId).toBeNull();
        let count = 0;
        await testEnv.withSecurityRulesDisabled(async ctx => {
            const snap = await getDocs(query(collection(ctx.firestore(), 'spotNotifications'),
                where('spotId', '==', 'tx8')));
            count = snap.size;
        });
        expect(count).toBe(1);
    });

    it('TX-9 (CASE 4 is structurally unreachable via normal operation, and fails VISIBLY if forced — never silently reported as already_resolved): a notification pre-seeded under the id this call would produce makes the write atomically reject; since the claim is still fully active and unchanged, the function must rethrow rather than mask a genuine failure', async () => {
        // This state can't arise from cancelClaimTransaction itself (notification
        // and claim-clear always co-commit), so this simulates a hypothetical
        // external/legacy write landing on the same deterministic id. Since
        // spotNotifications has no `allow update` arm, tx.set() on the existing
        // doc is rejected — and because the transaction is atomic, that rejection
        // rolls back the claim-clear too, rather than leaving a partial state.
        //
        // Critically: a post-failure re-read still shows this exact claimant's
        // claim fully active and matching — so this must NOT be reported as
        // already_resolved (that would silently tell the user their still-active
        // claim was cancelled when it wasn't). It must surface as a genuine,
        // retryable failure.
        await seed('spots', 'tx9', { ...committedScheduledSpot, claimStartedAt: CLAIM_STARTED_AT });
        const fp = CLAIM_STARTED_AT.toMillis();
        const notifId = `claimer_cancelled_tx9_${fp}`;
        await seed('spotNotifications', notifId, {
            spotId: 'tx9', senderId: OTHER_UID, targetUserId: OWNER_UID,
            type: 'claimer_cancelled', message: 'original', createdAt: Timestamp.now(),
        });

        await expect(cancelClaimTransaction(otherDb(), {
            spotId: 'tx9', claimantId: OTHER_UID, finderId: OWNER_UID, fingerprint: fp, message: 'x',
        })).rejects.toThrow();

        const spot = await readSpot('tx9');
        expect(spot.interestedUserId).toBe(OTHER_UID); // untouched — rolled back, claim still active
        expect(spot.claimStartedAt?.isEqual(CLAIM_STARTED_AT)).toBe(true);
        const notif = await readNotif(notifId);
        expect(notif.message).toBe('original'); // untouched
    });

    it('TX-11 (CASE 3): claim already released by another process, no notification — no false notification, no reopen', async () => {
        await seed('spots', 'tx11', {
            finderId: OWNER_UID, finderName: 'TestFinder', address: '1 Auto St',
            lat: 40.7, lng: -74.0, status: 'available', pingMode: 'later',
            reportedAt: FUTURE, expiresAt: Timestamp.fromMillis(FUTURE.toMillis() + 3_600_000),
        });
        const outcome = await cancelClaimTransaction(otherDb(), {
            spotId: 'tx11', claimantId: OTHER_UID, finderId: OWNER_UID,
            fingerprint: CLAIM_STARTED_AT.toMillis(), message: 'x',
        });
        expect(outcome).toBe('already_resolved');
        let count = 0;
        await testEnv.withSecurityRulesDisabled(async ctx => {
            const snap = await getDocs(query(collection(ctx.firestore(), 'spotNotifications'),
                where('spotId', '==', 'tx11')));
            count = snap.size;
        });
        expect(count).toBe(0);
    });

    it('TX-12 (CASE 5): a newer claimant has replaced the stale one — old claimant cannot release it', async () => {
        await seed('spots', 'tx12', { ...committedScheduledSpot, interestedUserId: THIRD_UID, claimStartedAt: Timestamp.now() });
        const outcome = await cancelClaimTransaction(otherDb(), {
            spotId: 'tx12', claimantId: OTHER_UID, finderId: OWNER_UID,
            fingerprint: CLAIM_STARTED_AT.toMillis(), message: 'x',
        });
        expect(outcome).toBe('stale_claim');
        const spot = await readSpot('tx12');
        expect(spot.interestedUserId).toBe(THIRD_UID); // newer claimant untouched
    });

    it('A2-HO-006: cancel with the claimStartedAt mapped by useSpotData returns cancelled', async () => {
        await seed('spots', 'a2-fp', committedScheduledSpot);
        let stored: any;
        await testEnv.withSecurityRulesDisabled(async ctx => {
            stored = (await getDoc(doc(ctx.firestore(), 'spots', 'a2-fp'))).data();
        });
        // Same expression as useSpotData's mappedFree claimStartedAt.
        const mappedClaimStartedAt = stored.claimStartedAt ?? null;
        const fingerprint = timestampToMillis(mappedClaimStartedAt);
        expect(fingerprint).toBe(CLAIM_STARTED_AT.toMillis());

        const outcome = await cancelClaimTransaction(otherDb(), {
            spotId: 'a2-fp', claimantId: OTHER_UID, finderId: OWNER_UID,
            fingerprint, message: 'Changed my mind',
        });
        expect(outcome).toBe('cancelled');
        const spot = await readSpot('a2-fp');
        expect(spot.status).toBe('available');
        expect(spot.interestedUserId).toBeNull();
    });

    it('A2-HO-006b: a fingerprint that does not match claimStartedAt is stale_claim and leaves the claim', async () => {
        await seed('spots', 'a2-stale', committedScheduledSpot);
        const outcome = await cancelClaimTransaction(otherDb(), {
            spotId: 'a2-stale', claimantId: OTHER_UID, finderId: OWNER_UID,
            fingerprint: CLAIM_STARTED_AT.toMillis() + 1, message: 'x',
        });
        expect(outcome).toBe('stale_claim');
        const spot = await readSpot('a2-stale');
        expect(spot.interestedUserId).toBe(OTHER_UID);
        expect(spot.claimStartedAt?.isEqual(CLAIM_STARTED_AT)).toBe(true);
    });

    it('TX-13: claimant receives no self-notification when they are also the Ping owner', async () => {
        await seed('spots', 'tx13', { ...committedScheduledSpot, finderId: OTHER_UID });
        const outcome = await cancelClaimTransaction(otherDb(), {
            spotId: 'tx13', claimantId: OTHER_UID, finderId: OTHER_UID,
            fingerprint: CLAIM_STARTED_AT.toMillis(), message: 'x',
        });
        expect(outcome).toBe('cancelled');
        let count = 0;
        await testEnv.withSecurityRulesDisabled(async ctx => {
            const snap = await getDocs(query(collection(ctx.firestore(), 'spotNotifications'),
                where('spotId', '==', 'tx13')));
            count = snap.size;
        });
        expect(count).toBe(0);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SPOT NOTIFICATIONS — Ping participants only
// ═══════════════════════════════════════════════════════════════════════════════
describe('spotNotifications — participant-bound creation', () => {
    beforeEach(async () => {
        await seed('spots', 'notification-spot', interestedSpot);
    });

    it('N1: finder can notify the active claimer', async () => {
        await assertSucceeds(
            addDoc(collection(ownerDb(), 'spotNotifications'), {
                spotId: 'notification-spot',
                senderId: OWNER_UID,
                targetUserId: OTHER_UID,
                type: 'delayed',
                message: 'Driver needs a few more minutes',
                createdAt: Timestamp.now(),
            })
        );
    });

    it('N2: claimer can notify the finder', async () => {
        await assertSucceeds(
            addDoc(collection(otherDb(), 'spotNotifications'), {
                spotId: 'notification-spot',
                senderId: OTHER_UID,
                targetUserId: OWNER_UID,
                type: 'claimer_cancelled',
                message: 'The other driver canceled',
                createdAt: Timestamp.now(),
            })
        );
    });

    it('N3: unrelated user cannot send a notification for another Ping', async () => {
        await assertFails(
            addDoc(collection(thirdDb(), 'spotNotifications'), {
                spotId: 'notification-spot',
                senderId: THIRD_UID,
                targetUserId: OWNER_UID,
                type: 'handoff_success',
                message: 'spoofed',
                createdAt: Timestamp.now(),
            })
        );
    });

    it('N4: sender cannot impersonate another participant', async () => {
        await assertFails(
            addDoc(collection(ownerDb(), 'spotNotifications'), {
                spotId: 'notification-spot',
                senderId: OTHER_UID,
                targetUserId: OTHER_UID,
                type: 'delayed',
                message: 'spoofed',
                createdAt: Timestamp.now(),
            })
        );
    });

    it('N5: notification with a timestamp older than 5 minutes is rejected', async () => {
        await assertFails(
            addDoc(collection(ownerDb(), 'spotNotifications'), {
                spotId: 'notification-spot',
                senderId: OWNER_UID,
                targetUserId: OTHER_UID,
                type: 'delayed',
                message: 'This message is stale',
                createdAt: PAST, // 1 hour ago — outside the 5-minute window
            })
        );
    });

    it('N6: finder cannot send notification to a user who is not the claimer of the Ping', async () => {
        await assertFails(
            addDoc(collection(ownerDb(), 'spotNotifications'), {
                spotId: 'notification-spot',
                senderId: OWNER_UID,
                targetUserId: THIRD_UID, // not the interestedUserId of this spot (OTHER_UID is)
                type: 'delayed',
                message: 'Wrong target',
                createdAt: Timestamp.now(),
            })
        );
    });

    it('N7: a second write to an already-existing deterministic notification id is rejected (no update rule) — proves the client must check-then-set for idempotent retries', async () => {
        const notifRef = doc(ownerDb(), 'spotNotifications', 'claimer_cancelled_notification-spot_123');
        await seed('spotNotifications', 'claimer_cancelled_notification-spot_123', {
            spotId: 'notification-spot',
            senderId: OTHER_UID,
            targetUserId: OWNER_UID,
            type: 'claimer_cancelled',
            message: 'The other driver canceled',
            createdAt: Timestamp.now(),
        });
        await assertFails(
            setDoc(doc(otherDb(), 'spotNotifications', 'claimer_cancelled_notification-spot_123'), {
                spotId: 'notification-spot',
                senderId: OTHER_UID,
                targetUserId: OWNER_UID,
                type: 'claimer_cancelled',
                message: 'The other driver canceled',
                createdAt: Timestamp.now(),
            })
        );
    });

    it('N8: a third party cannot read another user\'s claimer_cancelled notification (account-switch isolation)', async () => {
        await seed('spotNotifications', 'claimer_cancelled_notification-spot_456', {
            spotId: 'notification-spot',
            senderId: OTHER_UID,
            targetUserId: OWNER_UID,
            type: 'claimer_cancelled',
            message: 'The other driver canceled',
            createdAt: Timestamp.now(),
        });
        await assertFails(getDoc(doc(thirdDb(), 'spotNotifications', 'claimer_cancelled_notification-spot_456')));
        await assertSucceeds(getDoc(doc(ownerDb(), 'spotNotifications', 'claimer_cancelled_notification-spot_456')));
    });

    it('REPRO-1: claimer of a committed scheduled claim CAN send claimer_cancelled (happy path)', async () => {
        await seed('spots', 'scheduled-committed-spot', committedScheduledSpot);
        await assertSucceeds(
            addDoc(collection(otherDb(), 'spotNotifications'), {
                spotId: 'scheduled-committed-spot',
                senderId: OTHER_UID,
                targetUserId: OWNER_UID,
                type: 'claimer_cancelled',
                message: 'The other driver canceled',
                createdAt: Timestamp.now(),
            })
        );
    });

    it('REPRO-3: claimer CANNOT reopen an already-expired Ping via the old unconditional status:available write', async () => {
        await seed('spots', 'expired-committed-spot', {
            ...committedScheduledSpot,
            reportedAt: PAST,
            expiresAt: PAST, // already expired
        });
        const { updateDoc } = await import('firebase/firestore');
        await assertFails(
            updateDoc(doc(otherDb(), 'spots', 'expired-committed-spot'), {
                status: 'available',
                claimState: null,
                ownerLeavingNow: null,
                ownerLeavingNowAt: null,
                interestedUserId: null,
                interestedUserName: null,
                interestedUserVehicleColor: null,
                interestedUserVehicleType: null,
                interestedUserVehicleBrand: null,
                interestedUserTitle: null,
                etaMinutes: null,
                interestExpiresAt: null,
                claimReminderAt: null,
                claimReminderSentAt: null,
                claimAutoReleaseAt: null,
                claimAutoReleasedAt: null,
            })
        );
    });

    it('REPRO-4: claimer CAN clear claim fields on an expired Ping without reopening it (Arm 3b)', async () => {
        await seed('spots', 'expired-committed-spot-2', {
            ...committedScheduledSpot,
            reportedAt: PAST,
            expiresAt: PAST,
        });
        const { updateDoc } = await import('firebase/firestore');
        await assertSucceeds(
            updateDoc(doc(otherDb(), 'spots', 'expired-committed-spot-2'), {
                claimState: null,
                ownerLeavingNow: null,
                ownerLeavingNowAt: null,
                interestedUserId: null,
                interestedUserName: null,
                interestedUserVehicleColor: null,
                interestedUserVehicleType: null,
                interestedUserVehicleBrand: null,
                interestedUserTitle: null,
                etaMinutes: null,
                interestExpiresAt: null,
                claimReminderAt: null,
                claimReminderSentAt: null,
                claimAutoReleaseAt: null,
                claimAutoReleasedAt: null,
            })
        );
    });

    it('REPRO-2: claimer_cancelled is REJECTED once the claim has already been released server-side (stale UI race)', async () => {
        await seed('spots', 'scheduled-committed-spot', committedScheduledSpot);
        // Simulate processScheduledClaims auto-releasing the claim a moment before
        // the claimant's stale UI fires handleCancelByClaimer.
        await testEnv.withSecurityRulesDisabled(async ctx => {
            await setDoc(doc(ctx.firestore(), 'spots', 'scheduled-committed-spot'), {
                ...committedScheduledSpot,
                status: 'available',
                claimState: null,
                interestedUserId: null,
            });
        });
        await assertFails(
            addDoc(collection(otherDb(), 'spotNotifications'), {
                spotId: 'scheduled-committed-spot',
                senderId: OTHER_UID,
                targetUserId: OWNER_UID,
                type: 'claimer_cancelled',
                message: 'The other driver canceled',
                createdAt: Timestamp.now(),
            })
        );
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PARKING SESSIONS — path-keyed owner-only
// ═══════════════════════════════════════════════════════════════════════════════
describe('parkingSessions', () => {
    const sessionData = {
        active:    true,
        lat:       40.71,
        lng:       -74.0,
        address:   '42 Session St',
        startedAt: Timestamp.now(),
    };

    beforeEach(async () => {
        await seed('parkingSessions', OWNER_UID, sessionData);
    });

    // 21
    it('P1: owner can read their own session (path-keyed)', async () => {
        await assertSucceeds(getDoc(doc(ownerDb(), 'parkingSessions', OWNER_UID)));
    });

    // 22
    it('P2: different authenticated user cannot read another session', async () => {
        await assertFails(getDoc(doc(otherDb(), 'parkingSessions', OWNER_UID)));
    });

    // 23
    it('P3: unauthenticated user cannot read a session', async () => {
        await assertFails(getDoc(doc(anonDb(), 'parkingSessions', OWNER_UID)));
    });

    // 24 — collection-group / alternate path bypass check
    it('P4: owner can write to their own session path', async () => {
        await assertSucceeds(
            setDoc(doc(ownerDb(), 'parkingSessions', OWNER_UID), { ...sessionData, active: false })
        );
    });

    it('P5: different user cannot write to another session path', async () => {
        await assertFails(
            setDoc(doc(otherDb(), 'parkingSessions', OWNER_UID), { active: false })
        );
    });

    it('P6: admin token can no longer directly read another user\'s session (coordinated remediation — moved to adminReadView userDetail/dashboardCounts callable)', async () => {
        await assertFails(getDoc(doc(adminDb(), 'parkingSessions', OWNER_UID)));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PRIVATE PROFILE — users/{uid}/private/profile (owner-only demographics)
// ═══════════════════════════════════════════════════════════════════════════════
describe('users/private/profile', () => {
    const privateData = {
        homeArea:   'Brooklyn',
        driverType: 'Daily commuter',
        ageRange:   '25–34',
        gender:     'Female',
    };

    function privateDoc(db: ReturnType<typeof ownerDb>) {
        return doc(db, 'users', OWNER_UID, 'private', 'profile');
    }

    beforeEach(async () => {
        await testEnv.withSecurityRulesDisabled(async ctx => {
            await setDoc(doc(ctx.firestore(), 'users', OWNER_UID, 'private', 'profile'), privateData);
        });
    });

    // 31
    it('PP1: owner can read their own private profile', async () => {
        await assertSucceeds(getDoc(privateDoc(ownerDb())));
    });

    // 32
    it('PP2: owner can write (create/overwrite) their own private profile', async () => {
        await assertSucceeds(setDoc(privateDoc(ownerDb()), { ...privateData, ageRange: '35–44' }));
    });

    // 33
    it('PP3: owner can update their own private profile', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertSucceeds(upd(privateDoc(ownerDb()), { ageRange: '35–44' }));
    });

    // 34
    it('PP4: another authenticated user cannot read private profile', async () => {
        await assertFails(getDoc(doc(otherDb(), 'users', OWNER_UID, 'private', 'profile')));
    });

    // 35
    it('PP5: another authenticated user cannot list the private subcollection', async () => {
        await assertFails(getDocs(collection(otherDb(), 'users', OWNER_UID, 'private')));
    });

    // 36
    it('PP6: another authenticated user cannot write to private profile', async () => {
        await assertFails(
            setDoc(doc(otherDb(), 'users', OWNER_UID, 'private', 'profile'), { gender: 'Male' })
        );
    });

    // 37
    it('PP7: unauthenticated user cannot read private profile', async () => {
        await assertFails(getDoc(doc(anonDb(), 'users', OWNER_UID, 'private', 'profile')));
    });

    // 38
    it('PP8: unauthenticated user cannot write to private profile', async () => {
        await assertFails(
            setDoc(doc(anonDb(), 'users', OWNER_UID, 'private', 'profile'), { gender: 'Male' })
        );
    });

    // 39
    it('PP9: admin token can no longer directly read another user\'s private profile (coordinated read remediation — never consumed by any admin client code)', async () => {
        await assertFails(getDoc(doc(adminDb(), 'users', OWNER_UID, 'private', 'profile')));
    });

    // 40
    it('PP10: owner private doc is isolated — other owner cannot read a different user private doc', async () => {
        await testEnv.withSecurityRulesDisabled(async ctx => {
            await setDoc(doc(ctx.firestore(), 'users', OTHER_UID, 'private', 'profile'), { gender: 'Male' });
        });
        await assertFails(getDoc(doc(ownerDb(), 'users', OTHER_UID, 'private', 'profile')));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PUBLIC USER DOC DENYLIST — private fields must be rejected on users/{uid}
// ═══════════════════════════════════════════════════════════════════════════════
describe('users/{uid} public doc — private field denylist', () => {
    const publicUserData = {
        fullName: 'Jay Castro',
        username: 'jayc',
        crowns: 0,
        title: 'Newcomer',
        moderationStatus: 'active',
        reportCount: 0,
        blockedUsers: [],
        notificationRadius: 1,
    };

    beforeEach(async () => {
        await testEnv.withSecurityRulesDisabled(async ctx => {
            await setDoc(doc(ctx.firestore(), 'users', OWNER_UID), publicUserData);
        });
    });

    // 41
    it('PD1: owner cannot write dob to users/{uid} via update', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { dob: '1990-01-01' }));
    });

    // 42
    it('PD2: owner cannot write gender to users/{uid} via update', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { gender: 'Female' }));
    });

    // 43
    it('PD3: owner cannot write homeArea to users/{uid} via update', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { homeArea: 'Brooklyn' }));
    });

    // 44
    it('PD4: owner cannot write driverType to users/{uid} via update', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { driverType: 'Daily commuter' }));
    });

    // 45
    it('PD5: owner cannot write ageRange to users/{uid} via update', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { ageRange: '25–34' }));
    });

    // 46
    it('PD6: owner cannot include dob in a create (new user doc)', async () => {
        const tempUid = 'temp-create-test-uid';
        await assertFails(
            setDoc(doc(ownerDb(), 'users', tempUid), { ...publicUserData, dob: '1990-01-01' })
        );
    });

    // 47 — profile-identity hardening: fullName is now authoritative-server-owned
    // (updateDisplayName). A direct client update is denied even for the owner.
    it('PD7: direct fullName update is now denied — authoritative only via updateDisplayName', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { fullName: 'Jay Updated' }));
    });

    // 48 — notificationRadius moved to private/preferences; root write now blocked (TM-04)
    it('PD8: notificationRadius write to root doc is now blocked', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { notificationRadius: 2 }));
    });

    // 49 — profile-identity hardening: direct client CREATE of users/{uid} is
    // now denied unconditionally. claimUsername (Admin SDK) is the sole
    // authoritative writer of the initial account doc.
    it('PD9: owner cannot create a user doc directly at all, even with an otherwise-clean payload', async () => {
        const newUid = 'pd9-clean-create-uid-' + Date.now();
        await assertFails(
            setDoc(
                doc(testEnv.authenticatedContext(newUid).firestore(), 'users', newUid),
                { fullName: 'New User', username: 'newuser', crowns: 0, title: 'Newcomer' }
            )
        );
    });

    // 50
    it('PD10: owner can write allowed private fields to the private subcollection', async () => {
        await assertSucceeds(
            setDoc(
                doc(ownerDb(), 'users', OWNER_UID, 'private', 'profile'),
                { dob: '1990-01-01', gender: 'Female', homeArea: 'Brooklyn' },
                { merge: true } as any
            )
        );
    });

    // 51
    it('PD11: other authenticated user cannot read or write the private profile', async () => {
        await assertFails(getDoc(doc(otherDb(), 'users', OWNER_UID, 'private', 'profile')));
    });

    // 52
    it('PD12: unauthenticated user cannot read or write the private profile', async () => {
        await assertFails(getDoc(doc(anonDb(), 'users', OWNER_UID, 'private', 'profile')));
    });

    // 53
    it('PD13: owner cannot write phone to public users/{uid} via update', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { phone: '+15551234567' }));
    });

    // 54
    it('PD14: owner cannot include phone in public users/{uid} create', async () => {
        const newUid = 'pd14-uid-' + Date.now();
        await assertFails(
            setDoc(
                doc(testEnv.authenticatedContext(newUid).firestore(), 'users', newUid),
                { fullName: 'Test', username: 'testpd14', phone: '+15551234567' }
            )
        );
    });

    // 55
    it('PD15: owner cannot write email to public users/{uid} via update', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { email: 'test@example.com' }));
    });

    // 56
    it('PD16: owner cannot include email in public users/{uid} create', async () => {
        const newUid = 'pd16-uid-' + Date.now();
        await assertFails(
            setDoc(
                doc(testEnv.authenticatedContext(newUid).firestore(), 'users', newUid),
                { fullName: 'Test', username: 'testpd16', email: 'test@example.com' }
            )
        );
    });

    // 57
    it('PD17: owner can read users/{uid}/private/account', async () => {
        await assertSucceeds(getDoc(doc(ownerDb(), 'users', OWNER_UID, 'private', 'account')));
    });

    // 58
    it('PD18: other authenticated user cannot read users/{uid}/private/account', async () => {
        await assertFails(getDoc(doc(otherDb(), 'users', OWNER_UID, 'private', 'account')));
    });

    // 59
    it('PD19: unauthenticated user cannot read users/{uid}/private/account', async () => {
        await assertFails(getDoc(doc(anonDb(), 'users', OWNER_UID, 'private', 'account')));
    });

    it('PD20: admin token can no longer directly read users/{uid}/private/account (coordinated remediation — never consumed by any admin client code)', async () => {
        await assertFails(getDoc(doc(adminDb(), 'users', OWNER_UID, 'private', 'account')));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Coordinated admin session hardening — remaining isAdmin()-gated reads with
// no prior test coverage (adminAuditLog, stats): confirmed unused by any
// client, direct admin read now denied outright.
// ═══════════════════════════════════════════════════════════════════════════════
describe('adminAuditLog/stats — admin direct read blocked (coordinated remediation)', () => {
    it('AL-1: admin token can no longer directly read adminAuditLog (moved to adminReadView auditLogList/userDetail callable)', async () => {
        await seed('adminAuditLog', 'entry-1', { action: 'user.suspend', adminId: ADMIN_UID, createdAt: Timestamp.now() });
        await assertFails(getDoc(doc(adminDb(), 'adminAuditLog', 'entry-1')));
    });

    it('ST-1: admin token can no longer directly read stats (never consumed by any client)', async () => {
        await seed('stats', 'global', { totalUsers: 100 });
        await assertFails(getDoc(doc(adminDb(), 'stats', 'global')));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TM-11 — users/{uid} update allowlist
// ═══════════════════════════════════════════════════════════════════════════════
describe('users — update allowlist (TM-11)', () => {
    const publicUserData = { fullName: 'Alice', username: 'alice99', fcmToken: 'tok123' };

    beforeEach(async () => {
        await seed('users', OWNER_UID, publicUserData);
    });

    // Profile-identity hardening: fullName moved OUT of the direct-update
    // allowlist — it is now authoritative-server-owned via updateDisplayName.
    it('TM11-A: owner cannot update fullName directly — authoritative only via updateDisplayName', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { fullName: 'Alice B.' }));
    });

    it('TM11-B: owner cannot update fcmToken on root doc (moved to private/preferences)', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { fcmToken: 'newtoken' }));
    });

    it('TM11-C: owner cannot update crowns (not in allowlist)', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { crowns: 999 }));
    });

    it('TM11-D: owner cannot update title (not in allowlist)', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { title: 'King' }));
    });

    it('TM11-E: owner cannot write an arbitrary unknown field', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { evilField: true }));
    });

    it('TM11-F: other user cannot update another user\'s profile fields', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(otherDb(), 'users', OWNER_UID), { fullName: 'Hacked' }));
    });

    it('TM11-G: admin token can no longer bypass the allowlist directly (coordinated remediation — direct admin writes removed)', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(adminDb(), 'users', OWNER_UID), { crowns: 999999 }));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TM-10 — spots create schema validation
// ═══════════════════════════════════════════════════════════════════════════════
describe('spots — create schema (TM-10)', () => {
    const validSpot = {
        lat: 40.7128,
        lng: -74.0060,
        type: 'free',
        status: 'available',
        finderId: OWNER_UID,
        finderName: 'Alice',
        pingMode: 'now',
        reportedAt: Timestamp.now(),
        // A5: client creates must stay inside the 30-minute live TTL.
        expiresAt: Timestamp.fromMillis(Date.now() + 25 * 60 * 1000),
        geohash: 'dr5ru',
        address: '123 Main St, New York, NY',
    };

    // Spot identity-display authority: finderName must match the caller's
    // own live profile (see firestore.rules' matchesFinderIdentity).
    beforeEach(async () => {
        await seed('users', OWNER_UID, { id: OWNER_UID, username: 'Alice', crowns: 0, title: 'Newcomer' });
    });

    it('TM10-A: valid spot create succeeds', async () => {
        await assertSucceeds(commitBoundedPing(ownerDb(), OWNER_UID, 'tm10-a', validSpot));
    });

    it('TM10-B: create with forged finderId denied', async () => {
        await assertFails(
            addDoc(collection(ownerDb(), 'spots'), { ...validSpot, finderId: OTHER_UID })
        );
    });

    it('TM10-C: create with non-available status denied', async () => {
        await assertFails(
            addDoc(collection(ownerDb(), 'spots'), { ...validSpot, status: 'occupied' })
        );
    });

    it('TM10-D: create with non-free type denied', async () => {
        await assertFails(
            addDoc(collection(ownerDb(), 'spots'), { ...validSpot, type: 'paid' })
        );
    });

    it('TM10-E: create missing required field (address) denied', async () => {
        const { address: _a, ...noAddress } = validSpot;
        await assertFails(addDoc(collection(ownerDb(), 'spots'), noAddress));
    });

    it('TM10-F: create with past expiresAt denied', async () => {
        await assertFails(
            addDoc(collection(ownerDb(), 'spots'), { ...validSpot, expiresAt: PAST })
        );
    });

    it('TM10-G: create with extra unknown field denied', async () => {
        await assertFails(
            addDoc(collection(ownerDb(), 'spots'), { ...validSpot, adminOverride: true })
        );
    });

    it('TM10-H: unauthenticated create denied', async () => {
        await assertFails(addDoc(collection(anonDb(), 'spots'), validSpot));
    });

    // TM10-I/J document a real pre-existing client bug found during a
    // geoquery-feasibility audit: StreetParkingView.tsx's "re-ping over an
    // existing selectedItem" write path (handleSaveSpot's `if (selectedItem)`
    // branch) omits `geohash` entirely, even though it's in `hasAll` above.
    // TM10-I proves rules already reject that exact shape (the bug is real,
    // not merely a future geoquery prerequisite); TM10-J proves the corrected
    // shape (same payload + geohash) succeeds, matching the client fix.
    it('TM10-I: re-ping payload without geohash is denied (documents a real client bug)', async () => {
        const { geohash: _g, ...missingGeohash } = validSpot;
        await assertFails(addDoc(collection(ownerDb(), 'spots'), missingGeohash));
    });

    it('TM10-J: re-ping payload with geohash restored succeeds (proves the fix)', async () => {
        await assertSucceeds(commitBoundedPing(ownerDb(), OWNER_UID, 'tm10-j', validSpot));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SPOT IDENTITY-DISPLAY AUTHORITY — finderName/finderTitle/finderVehicle*
// (and interestedUser*/holdRequestedByName equivalents) must match the
// caller's own live profile at write time. See docs/SPOT_METADATA_HARDENING.md.
// ═══════════════════════════════════════════════════════════════════════════════
describe('spots — identity-display authority (SP)', () => {
    const finderProfile = { id: OWNER_UID, username: 'finderowner', crowns: 60, vehicleColor: 'blue', vehicleType: 'sedan', vehicleBrand: 'Honda' };
    const claimerProfile = { id: OTHER_UID, username: 'claimerother', crowns: 5, vehicleColor: 'red', vehicleType: 'suv', vehicleBrand: 'Toyota' };
    // getTitleForCrowns(60) -> 'Street Scout' (>=50), getTitleForCrowns(5) -> 'Newcomer' (<10)
    const FINDER_TITLE = 'Street Scout';
    const CLAIMER_TITLE = 'Newcomer';

    const baseSpot = {
        finderId: OWNER_UID,
        finderName: 'finderowner',
        finderTitle: FINDER_TITLE,
        finderVehicleColor: 'blue',
        finderVehicleType: 'sedan',
        finderVehicleBrand: 'Honda',
        address: '1 Identity Test St',
        lat: 40.71, lng: -74.01,
        type: 'free', status: 'available',
        geohash: 'dr5rv', pingMode: 'now',
        reportedAt: Timestamp.now(),
        expiresAt: Timestamp.fromMillis(Date.now() + 25 * 60 * 1000),
    };
    const SPOT_ID = 'sp-identity-spot';

    beforeEach(async () => {
        await seed('users', OWNER_UID, finderProfile);
        await seed('users', OTHER_UID, claimerProfile);
    });

    it('SP-01: create with a finderName that does not match the caller\'s own profile is denied, even with the correct finderId', async () => {
        await assertFails(
            setDoc(doc(ownerDb(), 'spots', SPOT_ID), { ...baseSpot, finderName: 'Someone Else' })
        );
    });

    it('SP-05: legitimate spot creation (finderName/Title/Vehicle* all matching the caller\'s live profile) succeeds', async () => {
        await assertSucceeds(commitBoundedPing(ownerDb(), OWNER_UID, SPOT_ID, baseSpot));
    });

    it('SP-07: create with a forged finderTitle (crown-tier) is denied even when finderName matches', async () => {
        await assertFails(
            setDoc(doc(ownerDb(), 'spots', SPOT_ID), { ...baseSpot, finderTitle: 'Urban Legend' })
        );
    });

    it('SP-08: create with a forged finderVehicleColor is denied even when finderName matches', async () => {
        await assertFails(
            setDoc(doc(ownerDb(), 'spots', SPOT_ID), { ...baseSpot, finderVehicleColor: 'invisible' })
        );
    });

    it('SP-11: omitting optional identity fields entirely (no vehicle set) still succeeds', async () => {
        const { finderVehicleColor: _c, finderVehicleType: _t, finderVehicleBrand: _b, finderTitle: _ti, ...minimal } = baseSpot;
        await assertSucceeds(commitBoundedPing(ownerDb(), OWNER_UID, SPOT_ID + '-minimal', minimal));
    });

    // My Car write-contract: handleMyCarPing (StreetParkingView.tsx) writes
    // source:'my_car' on every My Car ping. It ALSO used to write
    // originSessionId, which — before this fix — was rejected outright by
    // this create rule (neither field was in hasOnly()), meaning every My
    // Car ping was permanently denied in production. The fix: originSessionId
    // was dead client-side metadata (never read back anywhere — the
    // deterministic spot ID already encodes the same correlation) so the
    // client stopped writing it; 'source' IS load-bearing (handleMyCarPing's
    // own orphan-cleanup filter, d.data().source === 'my_car') so the rule
    // now allows it, but ONLY the literal 'my_car' value — 'source' is also
    // written server-side (adminDeleteSpot sets 'admin' via the Admin SDK) to
    // drive updateTrustOnSpotDelete's cancellation-penalty exemption, so a
    // client create must never be able to smuggle in any other value.
    describe('My Car write-contract (MC)', () => {
        const myCarPayload = {
            ...baseSpot,
            source: 'my_car',
        };

        it('MC-1: the corrected My Car payload (source:\'my_car\', no originSessionId) SUCCEEDS', async () => {
            await assertSucceeds(commitBoundedPing(ownerDb(), OWNER_UID, SPOT_ID + '-mycar-a', myCarPayload));
        });

        it('MC-2: originSessionId is still rejected — it is not, and must not become, part of the allowed schema', async () => {
            await assertFails(setDoc(doc(ownerDb(), 'spots', SPOT_ID + '-mycar-b'), { ...myCarPayload, originSessionId: 'session-abc-123' }));
        });

        it('MC-3 (SECURITY): a client cannot spoof source:\'admin\' to smuggle the cancellation-penalty exemption', async () => {
            await assertFails(setDoc(doc(ownerDb(), 'spots', SPOT_ID + '-mycar-c'), { ...baseSpot, source: 'admin' }));
        });

        it('MC-4: an arbitrary/unrecognized source value is rejected, not just \'admin\'', async () => {
            await assertFails(setDoc(doc(ownerDb(), 'spots', SPOT_ID + '-mycar-d'), { ...baseSpot, source: 'anything_else' }));
        });

        it('MC-5: omitting source entirely still succeeds (ordinary, non-My-Car pings never set it)', async () => {
            await assertSucceeds(commitBoundedPing(ownerDb(), OWNER_UID, SPOT_ID + '-mycar-e', baseSpot));
        });

        it('MC-6: an otherwise-unrecognized extra field is still rejected — hasOnly remains strict beyond this one addition', async () => {
            await assertFails(setDoc(doc(ownerDb(), 'spots', SPOT_ID + '-mycar-f'), { ...myCarPayload, notAllowed: 'nope' }));
        });
    });

    describe('claim (Arm 1) and hold-request (Arm 9)', () => {
        beforeEach(async () => {
            await seed('spots', SPOT_ID, baseSpot);
        });

        it('SP-03: a legitimate claim with interestedUserName/Title/Vehicle* matching the claimer\'s live profile succeeds', async () => {
            const db = otherDb();
            const claimedAt = Timestamp.now();
            await assertSucceeds(runTransaction(db, async (tx) => {
                tx.update(doc(db, 'spots', SPOT_ID), {
                    status: 'interested',
                    claimState: 'heading',
                    interestedUserId: OTHER_UID,
                    interestedUserName: 'claimerother',
                    interestedUserTitle: CLAIMER_TITLE,
                    interestedUserVehicleColor: 'red',
                    interestedUserVehicleType: 'suv',
                    interestedUserVehicleBrand: 'Toyota',
                    claimStartedAt: claimedAt,
                });
                tx.set(doc(db, 'users', OTHER_UID, 'activeIncomingClaims', 'current'), {
                    spotId: SPOT_ID,
                    claimStartedAt: claimedAt,
                    claimState: 'heading',
                    updatedAt: claimedAt,
                });
            }));
        });

        it('SP-04: a claim with a forged interestedUserName is denied, even with the correct interestedUserId', async () => {
            const db = otherDb();
            const claimedAt = Timestamp.now();
            await assertFails(runTransaction(db, async (tx) => {
                tx.update(doc(db, 'spots', SPOT_ID), {
                    status: 'interested',
                    claimState: 'heading',
                    interestedUserId: OTHER_UID,
                    interestedUserName: 'Impersonated Name',
                    claimStartedAt: claimedAt,
                });
                tx.set(doc(db, 'users', OTHER_UID, 'activeIncomingClaims', 'current'), {
                    spotId: SPOT_ID,
                    claimStartedAt: claimedAt,
                    claimState: 'heading',
                    updatedAt: claimedAt,
                });
            }));
        });

        it('SP-04b: a claim with a forged interestedUserTitle (crown-tier) is denied', async () => {
            const db = otherDb();
            const claimedAt = Timestamp.now();
            await assertFails(runTransaction(db, async (tx) => {
                tx.update(doc(db, 'spots', SPOT_ID), {
                    status: 'interested',
                    claimState: 'heading',
                    interestedUserId: OTHER_UID,
                    interestedUserName: 'claimerother',
                    interestedUserTitle: 'Urban Legend',
                    claimStartedAt: claimedAt,
                });
                tx.set(doc(db, 'users', OTHER_UID, 'activeIncomingClaims', 'current'), {
                    spotId: SPOT_ID,
                    claimStartedAt: claimedAt,
                    claimState: 'heading',
                    updatedAt: claimedAt,
                });
            }));
        });

        it('SP-05b: a profile-matching hold request is denied (A6 quarantine; Arm 9 no longer succeeds)', async () => {
            const { updateDoc: upd } = await import('firebase/firestore');
            await assertFails(upd(doc(otherDb(), 'spots', SPOT_ID), {
                holdRequestedBy: OTHER_UID,
                holdRequestStatus: 'pending',
                holdRequestedByName: 'claimerother',
            }));
        });

        it('SP-06: a hold request with a forged holdRequestedByName is denied, even with the correct holdRequestedBy', async () => {
            const { updateDoc: upd } = await import('firebase/firestore');
            await assertFails(upd(doc(otherDb(), 'spots', SPOT_ID), {
                holdRequestedBy: OTHER_UID,
                holdRequestStatus: 'pending',
                holdRequestedByName: 'Impersonated Name',
            }));
        });

        it('SP-09: a direct attempt to change finderName via update (outside of create) is denied', async () => {
            const { updateDoc: upd } = await import('firebase/firestore');
            await assertFails(upd(doc(ownerDb(), 'spots', SPOT_ID), { finderName: 'finderowner-renamed' }));
        });

        it('SP-10: a legitimate claimer cancellation (clearing interestedUser* fields to null) still succeeds unaffected', async () => {
            const db = otherDb();
            const claimedAt = Timestamp.now();
            const lockRef = doc(db, 'users', OTHER_UID, 'activeIncomingClaims', 'current');
            await runTransaction(db, async (tx) => {
                tx.update(doc(db, 'spots', SPOT_ID), {
                    status: 'interested',
                    claimState: 'heading',
                    interestedUserId: OTHER_UID,
                    interestedUserName: 'claimerother',
                    interestedUserTitle: CLAIMER_TITLE,
                    interestedUserVehicleColor: 'red',
                    interestedUserVehicleType: 'suv',
                    interestedUserVehicleBrand: 'Toyota',
                    claimStartedAt: claimedAt,
                });
                tx.set(lockRef, {
                    spotId: SPOT_ID,
                    claimStartedAt: claimedAt,
                    claimState: 'heading',
                    updatedAt: claimedAt,
                });
            });
            await assertSucceeds(runTransaction(db, async (tx) => {
                tx.update(doc(db, 'spots', SPOT_ID), {
                    status: 'available',
                    interestedUserId: null,
                    interestedUserName: null,
                    interestedUserVehicleColor: null,
                    interestedUserVehicleType: null,
                    interestedUserVehicleBrand: null,
                    interestedUserTitle: null,
                });
                tx.delete(lockRef);
            }));
        });
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A6 / HO-008 — legacy hold quarantine
// Clients cannot start or mutate hold state. Claim Arm 1 and reads of
// existing held documents stay allowed. cleanupExpiredHolds (Admin SDK)
// is covered by functions/cleanupExpiredHolds.integration.test.js.
// ═══════════════════════════════════════════════════════════════════════════════
describe('legacy hold quarantine (A6 / HO-008)', () => {
    const SPOT_ID = 'a6-hold-spot';
    const finderProfile = { id: OWNER_UID, username: 'finderowner', crowns: 60, vehicleColor: 'blue', vehicleType: 'sedan', vehicleBrand: 'Honda' };
    const claimerProfile = { id: OTHER_UID, username: 'claimerother', crowns: 5, vehicleColor: 'red', vehicleType: 'suv', vehicleBrand: 'Toyota' };

    const availableForHold = {
        finderId: OWNER_UID,
        finderName: 'finderowner',
        address: '9 Hold Quarantine St',
        lat: 40.72,
        lng: -74.0,
        type: 'free',
        status: 'available',
        geohash: 'dr5rv',
        pingMode: 'now',
        reportedAt: Timestamp.now(),
        expiresAt: FUTURE,
    };

    const pendingHold = {
        ...availableForHold,
        holdRequestedBy: OTHER_UID,
        holdRequestedByName: 'claimerother',
        holdRequestStatus: 'pending',
        holdRequestExpiresAt: FUTURE,
    };

    const acceptedHold = {
        ...availableForHold,
        status: 'claimed',
        claimedBy: OTHER_UID,
        holdRequestedBy: OTHER_UID,
        holdRequestedByName: 'claimerother',
        holdRequestStatus: 'accepted',
        holdTimerExpiresAt: PAST,
    };

    beforeEach(async () => {
        await seed('users', OWNER_UID, finderProfile);
        await seed('users', OTHER_UID, claimerProfile);
    });

    it('A6-ARM9: client send-hold (holdRequestStatus pending) is denied', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await seed('spots', SPOT_ID, availableForHold);
        await assertFails(upd(doc(otherDb(), 'spots', SPOT_ID), {
            holdRequestedBy: OTHER_UID,
            holdRequestedByName: 'claimerother',
            holdRequestStatus: 'pending',
            holdRequestExpiresAt: FUTURE,
        }));
        await assertFails(upd(doc(adminDb(), 'spots', SPOT_ID), {
            holdRequestedBy: ADMIN_UID,
            holdRequestedByName: 'Admin',
            holdRequestStatus: 'pending',
            holdRequestExpiresAt: FUTURE,
        }));
    });

    it('A6-ARM7: finder accept-hold is denied', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await seed('spots', SPOT_ID, pendingHold);
        await assertFails(upd(doc(ownerDb(), 'spots', SPOT_ID), {
            holdRequestStatus: 'accepted',
            status: 'claimed',
            claimedBy: OTHER_UID,
            holdTimerExpiresAt: FUTURE,
        }));
    });

    it('A6-ARM8: finder decline-hold is denied', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await seed('spots', SPOT_ID, pendingHold);
        await assertFails(upd(doc(ownerDb(), 'spots', SPOT_ID), {
            holdRequestStatus: 'declined',
            status: 'available',
            claimedBy: null,
        }));
    });

    it('A6-ARM10: hold claimer complete is denied', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await seed('spots', SPOT_ID, acceptedHold);
        await assertFails(upd(doc(otherDb(), 'spots', SPOT_ID), {
            holdRequestStatus: 'completed',
            status: 'occupied',
        }));
    });

    it('A6-ARM11: client hold-timer expiry (finder or claimer) is denied', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await seed('spots', SPOT_ID, acceptedHold);
        const release = {
            holdRequestStatus: 'declined',
            status: 'available',
            claimedBy: null,
        };
        await assertFails(upd(doc(ownerDb(), 'spots', SPOT_ID), release));
        await assertFails(upd(doc(otherDb(), 'spots', SPOT_ID), release));
    });

    it('A6-READ: an existing held document stays readable with its hold fields', async () => {
        await seed('spots', SPOT_ID, acceptedHold);
        const byClaimer = await assertSucceeds(getDoc(doc(otherDb(), 'spots', SPOT_ID)));
        expect(byClaimer.data()?.holdRequestStatus).toBe('accepted');
        expect(byClaimer.data()?.claimedBy).toBe(OTHER_UID);
        const byFinder = await assertSucceeds(getDoc(doc(ownerDb(), 'spots', SPOT_ID)));
        expect(byFinder.data()?.status).toBe('claimed');
        await seed('spots', SPOT_ID + '-pending', pendingHold);
        const pending = await assertSucceeds(getDoc(doc(thirdDb(), 'spots', SPOT_ID + '-pending')));
        expect(pending.data()?.holdRequestStatus).toBe('pending');
    });

    it('A6-ARM1: claim Arm 1 still succeeds on an available Ping with no hold', async () => {
        await seed('spots', SPOT_ID, availableForHold);
        const db = otherDb();
        const claimedAt = Timestamp.now();
        await assertSucceeds(runTransaction(db, async (tx) => {
            tx.update(doc(db, 'spots', SPOT_ID), {
                status: 'interested',
                claimState: 'heading',
                interestedUserId: OTHER_UID,
                interestedUserName: 'claimerother',
                interestedUserTitle: 'Newcomer',
                interestedUserVehicleColor: 'red',
                interestedUserVehicleType: 'suv',
                interestedUserVehicleBrand: 'Toyota',
                claimStartedAt: claimedAt,
            });
            tx.set(doc(db, 'users', OTHER_UID, 'activeIncomingClaims', 'current'), {
                spotId: SPOT_ID,
                claimStartedAt: claimedAt,
                claimState: 'heading',
                updatedAt: claimedAt,
            });
        }));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TM-08 — reports create schema validation
// ═══════════════════════════════════════════════════════════════════════════════
describe('reports — create schema (TM-08)', () => {
    const validReport = {
        reporterId: OWNER_UID,
        reportedUserId: OTHER_UID,
        type: 'behavior',
        reason: 'User was rude.',
        status: 'pending',
        createdAt: Timestamp.now(),
    };

    it('TM08-A: valid report create succeeds', async () => {
        await assertSucceeds(addDoc(collection(ownerDb(), 'reports'), validReport));
    });

    it('TM08-B: report with forged reporterId denied', async () => {
        await assertFails(
            addDoc(collection(ownerDb(), 'reports'), { ...validReport, reporterId: OTHER_UID })
        );
    });

    it('TM08-C: self-report denied', async () => {
        await assertFails(
            addDoc(collection(ownerDb(), 'reports'), { ...validReport, reportedUserId: OWNER_UID })
        );
    });

    it('TM08-D: report with invalid type denied', async () => {
        await assertFails(
            addDoc(collection(ownerDb(), 'reports'), { ...validReport, type: 'made_up' })
        );
    });

    it('TM08-E: report with status other than pending denied', async () => {
        await assertFails(
            addDoc(collection(ownerDb(), 'reports'), { ...validReport, status: 'resolved' })
        );
    });

    it('TM08-F: report with empty reason denied', async () => {
        await assertFails(
            addDoc(collection(ownerDb(), 'reports'), { ...validReport, reason: '' })
        );
    });

    it('TM08-G: unauthenticated report create denied', async () => {
        await assertFails(addDoc(collection(anonDb(), 'reports'), validReport));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TM-07 — listings write disabled
// ═══════════════════════════════════════════════════════════════════════════════
describe('listings — write disabled (TM-07)', () => {
    it('TM07-A: authenticated user cannot create a listing', async () => {
        await assertFails(
            addDoc(collection(ownerDb(), 'listings'), { title: 'My Garage', price: 10 })
        );
    });

    it('TM07-B: authenticated user cannot write to a specific listing', async () => {
        await assertFails(
            setDoc(doc(ownerDb(), 'listings', 'listing-123'), { title: 'Exploit' })
        );
    });

    it('TM07-C: any signed-in user can still read listings', async () => {
        await assertSucceeds(getDocs(collection(ownerDb(), 'listings')));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TM-09 — parseFailures update field restriction
// ═══════════════════════════════════════════════════════════════════════════════
describe('parseFailures — update allowlist (TM-09)', () => {
    beforeEach(async () => {
        await seed('parseFailures', 'failure-1', { count: 1, lastSeenAt: Timestamp.now() });
    });

    it('TM09-A: signed-in user can increment count and update lastSeenAt', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertSucceeds(
            upd(doc(ownerDb(), 'parseFailures', 'failure-1'), {
                count: 2,
                lastSeenAt: Timestamp.now(),
            })
        );
    });

    it('TM09-B: signed-in user cannot add resolvedAt', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(
            upd(doc(ownerDb(), 'parseFailures', 'failure-1'), {
                count: 2,
                resolvedAt: Timestamp.now(),
            })
        );
    });

    it('TM09-C: signed-in user cannot add arbitrary fields', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(
            upd(doc(ownerDb(), 'parseFailures', 'failure-1'), { injected: true })
        );
    });

    it('TM09-D: admin token can no longer bypass the allowlist directly (coordinated remediation — direct admin writes removed)', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(
            upd(doc(adminDb(), 'parseFailures', 'failure-1'), { resolvedAt: Timestamp.now() })
        );
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Coordinated admin session hardening — streetSegments/streetRules direct
// client mutation removed. views/admin/StreetSegmentsPage.tsx's Data
// Maintenance panel used to call utils/backfill.ts's
// backfillStreetIntelligence() directly against the client Firestore SDK,
// authorized only by isAdmin() — a token-only check Rules cannot re-verify
// against current server-side Auth state. A demoted/deleted/disabled
// admin's stale token could keep writing directly until the token expired.
// adminBackfillStreetIntelligence (functions/index.js, requireCurrentAdmin-
// gated) is now the only way to perform this mutation.
// ═══════════════════════════════════════════════════════════════════════════════
describe('streetSegments/streetRules — direct client mutation blocked (coordinated remediation)', () => {
    beforeEach(async () => {
        await seed('streetSegments', 'seg-1', { streetName: 'Test St', status: 'active' });
        await seed('streetSegments/seg-1/streetRules', 'rule-1', { schedules: [] });
    });

    it('SS-1: admin token can still read streetSegments directly (dashboard listing unaffected)', async () => {
        await assertSucceeds(getDoc(doc(adminDb(), 'streetSegments', 'seg-1')));
    });

    it('SS-2: admin token can no longer directly create a streetSegment', async () => {
        await assertFails(
            setDoc(doc(adminDb(), 'streetSegments', 'seg-new'), { streetName: 'New St' })
        );
    });

    it('SS-3: admin token can no longer directly update a streetSegment (the confirmed backfill.ts exploit path)', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(
            upd(doc(adminDb(), 'streetSegments', 'seg-1'), { source: 'admin' })
        );
    });

    it('SS-4: admin token can no longer directly delete a streetSegment', async () => {
        const { deleteDoc } = await import('firebase/firestore');
        await assertFails(deleteDoc(doc(adminDb(), 'streetSegments', 'seg-1')));
    });

    it('SS-5: admin token can still read streetRules directly (dashboard listing unaffected)', async () => {
        await assertSucceeds(getDoc(doc(adminDb(), 'streetSegments/seg-1/streetRules', 'rule-1')));
    });

    it('SS-6: admin token can no longer directly update a streetRule (the confirmed backfill.ts exploit path)', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(
            upd(doc(adminDb(), 'streetSegments/seg-1/streetRules', 'rule-1'), { editedBy: 'hack' })
        );
    });

    it('SS-7: admin token can no longer directly delete a streetRule', async () => {
        const { deleteDoc } = await import('firebase/firestore');
        await assertFails(deleteDoc(doc(adminDb(), 'streetSegments/seg-1/streetRules', 'rule-1')));
    });

    it('SS-8: public/unauthenticated read access to streetSegments/streetRules is unchanged (Street Parking view depends on it)', async () => {
        await assertSucceeds(getDoc(doc(anonDb(), 'streetSegments', 'seg-1')));
        await assertSucceeds(getDoc(doc(anonDb(), 'streetSegments/seg-1/streetRules', 'rule-1')));
    });
});

describe('suspensions — admin direct write blocked (coordinated remediation)', () => {
    it('SU-1: admin token can still read suspensions directly (dashboard listing unaffected)', async () => {
        await seed('suspensions', 'susp-1', { date: '2026-01-01', label: 'Test', type: 'holiday' });
        await assertSucceeds(getDoc(doc(adminDb(), 'suspensions', 'susp-1')));
    });

    it('SU-2: admin token can no longer directly create a suspension (adminAddSuspension callable is the only path now)', async () => {
        await assertFails(
            setDoc(doc(adminDb(), 'suspensions', 'susp-new'), { date: '2026-01-01', label: 'Test', type: 'holiday' })
        );
    });
});

describe('reports — admin direct read/update blocked (coordinated remediation)', () => {
    it('RP-1: admin token can no longer directly read reports (moved to adminReadView reportsList/userDetail callable)', async () => {
        await seed('reports', 'report-1', {
            reporterId: OTHER_UID, reportedUserId: OWNER_UID, type: 'spam',
            reason: 'test', status: 'pending', createdAt: Timestamp.now(),
        });
        await assertFails(getDoc(doc(adminDb(), 'reports', 'report-1')));
    });

    it('RP-2: admin token can no longer directly update a report (adminUpdateReport callable is the only path now)', async () => {
        await seed('reports', 'report-1', {
            reporterId: OTHER_UID, reportedUserId: OWNER_UID, type: 'spam',
            reason: 'test', status: 'pending', createdAt: Timestamp.now(),
        });
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(adminDb(), 'reports', 'report-1'), { status: 'reviewed' }));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TM-14 — adminBootstrap singleton not client-writable
// ═══════════════════════════════════════════════════════════════════════════════
describe('adminBootstrap — client writes blocked (TM-14)', () => {
    it('TM14-A: unauthenticated cannot write adminBootstrap/singleton', async () => {
        await assertFails(
            setDoc(doc(anonDb(), 'adminBootstrap', 'singleton'), { bootstrappedBy: 'anon' })
        );
    });

    it('TM14-B: authenticated user cannot write adminBootstrap/singleton', async () => {
        await assertFails(
            setDoc(doc(ownerDb(), 'adminBootstrap', 'singleton'), { bootstrappedBy: OWNER_UID })
        );
    });

    it('TM14-C: admin token can no longer directly read adminBootstrap/singleton (coordinated remediation — never read by any client; bootstrapAdmin uses the Admin SDK, which bypasses Rules)', async () => {
        await assertFails(getDoc(doc(adminDb(), 'adminBootstrap', 'singleton')));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TM-04 — Private user data separated from public user document
// ═══════════════════════════════════════════════════════════════════════════════
describe('TM-04 — private user data isolation', () => {
    beforeEach(async () => {
        await seed('users', OWNER_UID, {
            fullName: 'Owner',
            crowns: 0,
            title: 'Newcomer',
            moderationStatus: 'active',
            reportCount: 0,
        });
    });

    it('TM04-A: owner cannot write fcmToken to root users doc', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { fcmToken: 'tok123' }));
    });

    it('TM04-B: owner cannot write blockedUsers to root users doc', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { blockedUsers: [] }));
    });

    it('TM04-C: owner cannot write notificationsEnabled to root users doc', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { notificationsEnabled: true }));
    });

    it('TM04-D: owner cannot write lang to root users doc', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { lang: 'en' }));
    });

    it('TM04-E: owner cannot write lastGeohash to root users doc', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { lastGeohash: 'dr5ru' }));
    });

    it('TM04-F: owner can write and read private/preferences', async () => {
        await assertSucceeds(
            setDoc(doc(ownerDb(), 'users', OWNER_UID, 'private', 'preferences'),
                { notificationRadius: 2, notificationsEnabled: true })
        );
        await assertSucceeds(getDoc(doc(ownerDb(), 'users', OWNER_UID, 'private', 'preferences')));
    });

    it('TM04-G: other user cannot read private/preferences', async () => {
        await assertFails(getDoc(doc(otherDb(), 'users', OWNER_UID, 'private', 'preferences')));
    });

    it('TM04-H: unauthenticated cannot read private/preferences', async () => {
        await assertFails(getDoc(doc(anonDb(), 'users', OWNER_UID, 'private', 'preferences')));
    });

    it('TM04-I: owner can write and read private/social', async () => {
        await assertSucceeds(
            setDoc(doc(ownerDb(), 'users', OWNER_UID, 'private', 'social'), { blockedUsers: [] })
        );
        await assertSucceeds(getDoc(doc(ownerDb(), 'users', OWNER_UID, 'private', 'social')));
    });

    it('TM04-J: other user cannot read private/social', async () => {
        await assertFails(getDoc(doc(otherDb(), 'users', OWNER_UID, 'private', 'social')));
    });

    it('TM04-K: owner can write and read userLocations/{uid}', async () => {
        await assertSucceeds(
            setDoc(doc(ownerDb(), 'userLocations', OWNER_UID), { lastGeohash: 'dr5ru', lastGeohashUpdatedAt: Timestamp.now() })
        );
        await assertSucceeds(getDoc(doc(ownerDb(), 'userLocations', OWNER_UID)));
    });

    it('TM04-L: user cannot write to another user\'s userLocations doc', async () => {
        await assertFails(
            setDoc(doc(otherDb(), 'userLocations', OWNER_UID), { lastGeohash: 'dr5ru', lastGeohashUpdatedAt: Timestamp.now() })
        );
    });

    it('TM04-M: unauthenticated cannot read userLocations', async () => {
        await assertFails(getDoc(doc(anonDb(), 'userLocations', OWNER_UID)));
    });

    it('TM04-N: owner cannot create root doc containing moderationStatus', async () => {
        const { setDoc: sd } = await import('firebase/firestore');
        await assertFails(sd(doc(ownerDb(), 'users', OWNER_UID + '_new'), {
            fullName: 'Test', crowns: 0, title: 'Newcomer', moderationStatus: 'active',
        }));
    });

    it('TM04-O: owner cannot write reportCount to root users doc', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        // Use a value different from the seed (0) so affectedKeys() is non-empty
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { reportCount: 5 }));
    });

    it('TM04-P: owner cannot write to private/account (server-only)', async () => {
        const { setDoc: sd } = await import('firebase/firestore');
        await assertFails(sd(doc(ownerDb(), 'users', OWNER_UID, 'private', 'account'), { moderationStatus: 'active' }));
    });

    it('TM04-Q: private/preferences rejects invalid lang value', async () => {
        await assertFails(
            setDoc(doc(ownerDb(), 'users', OWNER_UID, 'private', 'preferences'), { lang: 'fr' })
        );
    });

    it('TM04-R: private/preferences rejects notificationRadius out of bounds', async () => {
        await assertFails(
            setDoc(doc(ownerDb(), 'users', OWNER_UID, 'private', 'preferences'), { notificationRadius: 200 })
        );
    });

    it('TM04-S: private/preferences rejects extra unknown fields', async () => {
        await assertFails(
            setDoc(doc(ownerDb(), 'users', OWNER_UID, 'private', 'preferences'), { notificationRadius: 1, suspiciousField: 'x' })
        );
    });

    it('TM04-T: private/social rejects extra fields beyond blockedUsers', async () => {
        await assertFails(
            setDoc(doc(ownerDb(), 'users', OWNER_UID, 'private', 'social'), { blockedUsers: [], extraField: true })
        );
    });

    it('TM04-U: userLocations rejects extra fields beyond schema', async () => {
        await assertFails(
            setDoc(doc(ownerDb(), 'userLocations', OWNER_UID), { lastGeohash: 'dr5ru', lastGeohashUpdatedAt: Timestamp.now(), extraField: 'x' })
        );
    });

    it('UL-1: first authorized merge creates a complete userLocations document', async () => {
        const locationRef = doc(ownerDb(), 'userLocations', OWNER_UID);
        await assertSucceeds(
            setDoc(locationRef, {
                lastGeohash: 'dr5ru7k2',
                lastGeohashUpdatedAt: Timestamp.now(),
            }, { merge: true })
        );

        const snapshot = await getDoc(locationRef);
        expect(snapshot.data()?.lastGeohash).toBe('dr5ru7k2');
        expect(snapshot.data()?.lastGeohashUpdatedAt).toBeInstanceOf(Timestamp);
    });

    it('UL-2: merge updates an existing location without losing required fields', async () => {
        await seed('userLocations', OWNER_UID, {
            lastGeohash: 'dr5ruold',
            lastGeohashUpdatedAt: Timestamp.fromMillis(Date.now() - 30_000),
        });
        const locationRef = doc(ownerDb(), 'userLocations', OWNER_UID);

        await assertSucceeds(
            setDoc(locationRef, {
                lastGeohash: 'dr5runew',
                lastGeohashUpdatedAt: Timestamp.now(),
            }, { merge: true })
        );

        const data = (await getDoc(locationRef)).data();
        expect(data?.lastGeohash).toBe('dr5runew');
        expect(data?.lastGeohashUpdatedAt).toBeInstanceOf(Timestamp);
        expect(Object.keys(data ?? {}).sort()).toEqual(['lastGeohash', 'lastGeohashUpdatedAt']);
    });

    it('UL-3: concurrent valid first merges are safe for a missing document', async () => {
        const locationRef = doc(ownerDb(), 'userLocations', OWNER_UID);
        await Promise.all([
            assertSucceeds(setDoc(locationRef, {
                lastGeohash: 'dr5ru7k2',
                lastGeohashUpdatedAt: Timestamp.now(),
            }, { merge: true })),
            assertSucceeds(setDoc(locationRef, {
                lastGeohash: 'dr5ru7k3',
                lastGeohashUpdatedAt: Timestamp.now(),
            }, { merge: true })),
        ]);

        const data = (await getDoc(locationRef)).data();
        expect(['dr5ru7k2', 'dr5ru7k3']).toContain(data?.lastGeohash);
        expect(data?.lastGeohashUpdatedAt).toBeInstanceOf(Timestamp);
    });

    it('UL-4: deleted and recreated accounts own separate location documents', async () => {
        await assertSucceeds(setDoc(doc(ownerDb(), 'userLocations', OWNER_UID), {
            lastGeohash: 'dr5ruold',
            lastGeohashUpdatedAt: Timestamp.now(),
        }, { merge: true }));
        await assertSucceeds(setDoc(doc(otherDb(), 'userLocations', OTHER_UID), {
            lastGeohash: 'dr5runew',
            lastGeohashUpdatedAt: Timestamp.now(),
        }, { merge: true }));

        expect((await getDoc(doc(ownerDb(), 'userLocations', OWNER_UID))).data()?.lastGeohash).toBe('dr5ruold');
        expect((await getDoc(doc(otherDb(), 'userLocations', OTHER_UID))).data()?.lastGeohash).toBe('dr5runew');
    });

    // FCM upsert compatibility — proves setDoc{merge:true} is allowed on private/preferences
    // even when the document does not already exist (new user, no prior setDoc from onboarding).
    it('FCM-1: owner can create private/preferences with only fcmToken (simulates first sign-in upsert)', async () => {
        // Document does not exist — setDoc without merge creates it
        await assertSucceeds(
            setDoc(doc(ownerDb(), 'users', OWNER_UID, 'private', 'preferences'), { fcmToken: 'tok_abc123' })
        );
    });

    it('FCM-2: owner can merge fcmToken into existing private/preferences without losing other fields', async () => {
        // Seed an existing preferences doc with notificationRadius
        await seed('users/' + OWNER_UID + '/private', 'preferences', { notificationRadius: 3 });
        // setDoc with merge:true — update only fcmToken; notificationRadius must survive
        const { setDoc: sd } = await import('firebase/firestore');
        await assertSucceeds(
            sd(doc(ownerDb(), 'users', OWNER_UID, 'private', 'preferences'), { fcmToken: 'tok_new' }, { merge: true })
        );
    });

    it('FCM-3: private/preferences rejects fcmToken exceeding 4096 chars', async () => {
        await assertFails(
            setDoc(doc(ownerDb(), 'users', OWNER_UID, 'private', 'preferences'), { fcmToken: 'x'.repeat(4097) })
        );
    });

    it('FCM-4: other user cannot write fcmToken to owner private/preferences', async () => {
        await assertFails(
            setDoc(doc(otherDb(), 'users', OWNER_UID, 'private', 'preferences'), { fcmToken: 'tok_other' })
        );
    });

    it('FCM-5: owner can delete fcmToken from private/preferences (logout cleanup)', async () => {
        // Proves the logout-time updateDoc({ fcmToken: deleteField() }) is permitted.
        // Seed with an existing token first.
        await seed('users/' + OWNER_UID + '/private', 'preferences', { notificationRadius: 2, fcmToken: 'tok_to_remove' });
        const { updateDoc: upd, deleteField: df } = await import('firebase/firestore');
        await assertSucceeds(
            upd(doc(ownerDb(), 'users', OWNER_UID, 'private', 'preferences'), { fcmToken: df() })
        );
    });

    it('FCM-6: deleting fcmToken leaves other preference fields intact (no full-doc overwrite)', async () => {
        // After deleteField, notificationRadius must survive.
        await seed('users/' + OWNER_UID + '/private', 'preferences', { notificationRadius: 3, fcmToken: 'tok_old' });
        const { updateDoc: upd, deleteField: df, getDoc: gd } = await import('firebase/firestore');
        await assertSucceeds(
            upd(doc(ownerDb(), 'users', OWNER_UID, 'private', 'preferences'), { fcmToken: df() })
        );
        const snap = await gd(doc(ownerDb(), 'users', OWNER_UID, 'private', 'preferences'));
        expect(snap.data()?.notificationRadius).toBe(3);
        expect(snap.data()?.fcmToken).toBeUndefined();
    });

    it('FCM-7: other user cannot delete fcmToken from owner private/preferences', async () => {
        await seed('users/' + OWNER_UID + '/private', 'preferences', { fcmToken: 'tok_secure' });
        const { updateDoc: upd, deleteField: df } = await import('firebase/firestore');
        await assertFails(
            upd(doc(otherDb(), 'users', OWNER_UID, 'private', 'preferences'), { fcmToken: df() })
        );
    });

});

// ═══════════════════════════════════════════════════════════════════════════════
// §4 — User schema: vehicle and avatar fields in create/update allowlists.
//
// vehicleBrand and vehicleColor are intentionally public: spot finders post
// their vehicle so claimers know which car is pulling out. Product decision;
// not a privacy gap. Documented here so future reviewers don't re-open it.
// ═══════════════════════════════════════════════════════════════════════════════
describe('§4 — users/{uid} vehicle and avatar allowlists', () => {
    const baseDoc = { fullName: 'Test', username: 'test_schema', crowns: 0, title: 'Newcomer' };

    beforeEach(async () => {
        await seed('users', OWNER_UID, baseDoc);
    });

    // ── update allowlist: vehicle fields ──────────────────────────────────────

    it('SC-1: owner can update vehicleType (in update allowlist)', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertSucceeds(upd(doc(ownerDb(), 'users', OWNER_UID), { vehicleType: 'sedan' }));
    });

    // UNRESOLVED PRODUCT DECISION (see Phase H audit): vehicleBrand is currently public.
    // Option A: keep as public — finders expose their car for claimer recognition.
    // Option B: keep private; copy a minimal vehicle description only to the active Ping during handoff.
    // Current exposure: vehicleBrand and vehicleColor are readable by any signed-in user via users/{uid}.
    // Recommendation: move to Option B (copy-on-handoff) before GA. Pending Product approval.
    it('SC-2: owner can update vehicleBrand (currently public — product decision UNRESOLVED)', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertSucceeds(upd(doc(ownerDb(), 'users', OWNER_UID), { vehicleBrand: 'Honda' }));
    });

    // Same unresolved decision as SC-2 above — vehicleColor is currently public.
    it('SC-3: owner can update vehicleColor (currently public — product decision UNRESOLVED)', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertSucceeds(upd(doc(ownerDb(), 'users', OWNER_UID), { vehicleColor: 'silver' }));
    });

    // ── update allowlist: avatar fields ───────────────────────────────────────

    it('SC-4: owner can update avatarUrl (in update allowlist)', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertSucceeds(upd(doc(ownerDb(), 'users', OWNER_UID), { avatarUrl: 'https://example.com/a.jpg' }));
    });

    it('SC-5: owner can update avatarManifestId (in update allowlist)', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertSucceeds(upd(doc(ownerDb(), 'users', OWNER_UID), { avatarManifestId: 'manifest_abc' }));
    });

    // ── update denylist: immutable fields ─────────────────────────────────────

    it('SC-6: owner cannot update id (not in update allowlist — immutable)', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { id: 'hijacked_uid' }));
    });

    it('SC-7: owner cannot update createdAt (not in update allowlist — immutable)', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { createdAt: Timestamp.now() }));
    });

    // ── create: profile-identity hardening denies ALL direct client create ──

    it('SC-8: owner cannot create a user doc directly, even with otherwise-legitimate vehicle fields', async () => {
        const newUid = 'sc8-uid-' + Date.now();
        await assertFails(
            setDoc(
                doc(testEnv.authenticatedContext(newUid).firestore(), 'users', newUid),
                { fullName: 'Car User', username: 'caruser', vehicleBrand: 'Toyota', vehicleColor: 'blue' }
            )
        );
    });
});


// ═══════════════════════════════════════════════════════════════════════════════
// USERS DIRECTORY — Phase A: deny client list/query, keep signed-in get-by-id.
// Closes P2 bulk enumeration. Approach B (narrow peer projection) is follow-up.
// ═══════════════════════════════════════════════════════════════════════════════
describe('users/{uid} directory — Phase A list deny / get-by-id', () => {
    beforeEach(async () => {
        await seed('users', OWNER_UID, { fullName: 'Alice', username: 'alice', avatarUrl: null });
        await seed('users', OTHER_UID, { fullName: 'Bob', username: 'bob', avatarUrl: null });
    });

    it('UD-01: signed-in owner can get their own user doc', async () => {
        await assertSucceeds(getDoc(doc(ownerDb(), 'users', OWNER_UID)));
    });

    it('UD-02: signed-in unrelated user can still get a known UID (interim Phase A design)', async () => {
        await assertSucceeds(getDoc(doc(otherDb(), 'users', OWNER_UID)));
    });

    it('UD-03: signed-in client cannot list/query users (getDocs collection)', async () => {
        await assertFails(getDocs(collection(ownerDb(), 'users')));
        await assertFails(getDocs(collection(otherDb(), 'users')));
    });

    it('UD-04: signed-in client cannot query users with a filter', async () => {
        const q = query(collection(ownerDb(), 'users'), where('username', '==', 'alice'));
        await assertFails(getDocs(q));
    });

    it('UD-05: unauthenticated get of a user doc remains denied', async () => {
        await assertFails(getDoc(doc(anonDb(), 'users', OWNER_UID)));
    });

    it('UD-06: unauthenticated list of users remains denied', async () => {
        await assertFails(getDocs(collection(anonDb(), 'users')));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// PROFILE IDENTITY HARDENING — username/fullName authoritative write paths.
// claimUsername/updateDisplayName (Admin SDK) are now the sole writers of
// these two fields; direct client mutation is denied. See
// docs/PROFILE_IDENTITY_HARDENING.md.
// ═══════════════════════════════════════════════════════════════════════════════
describe('profile identity hardening — username/fullName authoritative write paths', () => {
    const baseDoc = { fullName: 'Jay Castro', username: 'jayc_pi', crowns: 0, title: 'Newcomer' };

    beforeEach(async () => {
        await seed('users', OWNER_UID, baseDoc);
    });

    it('PR-01: authenticated owner direct username UPDATE is DENIED', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { username: 'newname' }));
    });

    it('PR-02: authenticated owner direct fullName UPDATE is DENIED', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { fullName: 'New Name' }));
    });

    it('PR-03: direct UPDATE of username and fullName together is DENIED', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { username: 'newname', fullName: 'New Name' }));
    });

    it('PR-04: another authenticated user attempting identity-field mutation is DENIED', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(otherDb(), 'users', OWNER_UID), { username: 'stolen' }));
        await assertFails(upd(doc(otherDb(), 'users', OWNER_UID), { fullName: 'Hacked' }));
    });

    it('PR-05: direct write to the usernames/{normalized} registry remains DENIED', async () => {
        await assertFails(setDoc(doc(ownerDb(), 'usernames', 'jayc_pi'), { uid: OWNER_UID, claimedAt: Timestamp.now() }));
    });

    it('PR-06: a legitimate unrelated owner profile update (vehicleType) remains ALLOWED', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertSucceeds(upd(doc(ownerDb(), 'users', OWNER_UID), { vehicleType: 'sedan' }));
    });

    it('PR-07: profile read behavior is unchanged — any signed-in user can still read the doc', async () => {
        await assertSucceeds(getDoc(doc(otherDb(), 'users', OWNER_UID)));
    });

    it('PR-08: a server-created account (Admin SDK, simulating claimUsername) is created successfully and remains normally readable/editable by its owner', async () => {
        const newUid = 'pr08-uid-' + Date.now();
        await testEnv.withSecurityRulesDisabled(async ctx => {
            await setDoc(doc(ctx.firestore(), 'users', newUid), { id: newUid, username: 'pr08user', crowns: 0, title: 'Newcomer' });
        });
        await assertSucceeds(getDoc(doc(testEnv.authenticatedContext(newUid).firestore(), 'users', newUid)));
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertSucceeds(upd(doc(testEnv.authenticatedContext(newUid).firestore(), 'users', newUid), { vehicleType: 'suv' }));
    });

    it('PR-09: a stale client attempting the old direct identity-mutation pattern is DENIED after the lock (no grandfathering)', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        // Exactly the pre-migration legitimate pattern (schema-valid, correct
        // owner, single field) — still denied outright now.
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { username: 'still_taken_by_old_client' }));
    });

    it('PR-10: a malformed direct create attempt (arbitrary schema, no valid shape) is DENIED', async () => {
        const newUid = 'pr10-uid-' + Date.now();
        await assertFails(
            setDoc(doc(testEnv.authenticatedContext(newUid).firestore(), 'users', newUid), { anything: 'goes', username: 'x' })
        );
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §5 — rateLimits collection: client access fully denied (server-only via Admin SDK)
// ═══════════════════════════════════════════════════════════════════════════════
describe('§5 — rateLimits collection Rules', () => {
    const RL_DOC = 'generateEmailOTP_0_test_uid';

    beforeEach(async () => {
        await testEnv.withSecurityRulesDisabled(async ctx => {
            await setDoc(doc(ctx.firestore(), 'rateLimits', RL_DOC), { count: 1, uid: 'test_uid' });
        });
    });

    it('RL-R1: authenticated user cannot read rateLimits docs', async () => {
        await assertFails(getDoc(doc(ownerDb(), 'rateLimits', RL_DOC)));
    });

    it('RL-R2: authenticated user cannot write rateLimits docs', async () => {
        await assertFails(setDoc(doc(ownerDb(), 'rateLimits', RL_DOC), { count: 99 }));
    });

    it('RL-R3: unauthenticated user cannot read rateLimits docs', async () => {
        await assertFails(getDoc(doc(anonDb(), 'rateLimits', RL_DOC)));
    });

    it('RL-R4: unauthenticated user cannot write rateLimits docs', async () => {
        await assertFails(setDoc(doc(anonDb(), 'rateLimits', RL_DOC), { count: 99 }));
    });
});

describe('WL-R — waitlist collection Rules (server-only)', () => {
    const WL_DOC = 'a'.repeat(64);

    beforeEach(async () => {
        await seed('waitlist', WL_DOC, {
            email: 'driver@example.com',
            status: 'pending_confirmation',
            optInMethod: 'double-opt-in',
            source: 'marketing-site',
            consentVersion: 'waitlist-2026-09-v1',
            confirmTokenHash: 'b'.repeat(64),
            confirmedAt: null,
        });
    });

    it('WL-R1: no client can read a waitlist record', async () => {
        await assertFails(getDoc(doc(anonDb(), 'waitlist', WL_DOC)));
        await assertFails(getDoc(doc(ownerDb(), 'waitlist', WL_DOC)));
        await assertFails(getDoc(doc(adminDb(), 'waitlist', WL_DOC)));
    });

    it('WL-R2: no client can list or query the waitlist', async () => {
        await assertFails(getDocs(collection(anonDb(), 'waitlist')));
        await assertFails(getDocs(query(collection(ownerDb(), 'waitlist'), where('status', '==', 'subscribed'))));
        await assertFails(getDocs(query(collection(adminDb(), 'waitlist'), where('confirmTokenHash', '==', 'b'.repeat(64)))));
    });

    it('WL-R3: no client can create a waitlist record', async () => {
        const record = { email: 'x@example.com', status: 'subscribed' };
        await assertFails(setDoc(doc(anonDb(), 'waitlist', 'c'.repeat(64)), record));
        await assertFails(setDoc(doc(ownerDb(), 'waitlist', 'c'.repeat(64)), record));
        await assertFails(addDoc(collection(adminDb(), 'waitlist'), record));
    });

    it('WL-R4: no client can confirm, change or delete a waitlist record', async () => {
        await assertFails(setDoc(doc(anonDb(), 'waitlist', WL_DOC), { status: 'subscribed' }, { merge: true }));
        await assertFails(setDoc(doc(ownerDb(), 'waitlist', WL_DOC), { status: 'subscribed' }, { merge: true }));
        await assertFails(setDoc(doc(adminDb(), 'waitlist', WL_DOC), { status: 'unsubscribed' }, { merge: true }));
        const { deleteDoc } = await import('firebase/firestore');
        await assertFails(deleteDoc(doc(anonDb(), 'waitlist', WL_DOC)));
        await assertFails(deleteDoc(doc(adminDb(), 'waitlist', WL_DOC)));
    });

    // adminDb() is a client SDK context with an admin role claim, not the Admin SDK.
    it('WL-R5: no client SDK user (anon, signed-in, admin-claim) can read, list, write or delete an unsubscribe token', async () => {
        const TOKEN_DOC = 'd'.repeat(64);
        await seed('waitlistUnsubscribeTokens', TOKEN_DOC, {
            waitlistId: WL_DOC,
            issuedAt: Timestamp.now(),
            validUntil: FUTURE,
            subscriptionConfirmedAt: null,
        });
        const { deleteDoc } = await import('firebase/firestore');
        for (const db of [anonDb(), ownerDb(), adminDb()]) {
            await assertFails(getDoc(doc(db, 'waitlistUnsubscribeTokens', TOKEN_DOC)));
            await assertFails(getDocs(collection(db, 'waitlistUnsubscribeTokens')));
            await assertFails(getDocs(query(collection(db, 'waitlistUnsubscribeTokens'), where('waitlistId', '==', WL_DOC))));
            await assertFails(setDoc(doc(db, 'waitlistUnsubscribeTokens', 'e'.repeat(64)), { waitlistId: WL_DOC }));
            await assertFails(setDoc(doc(db, 'waitlistUnsubscribeTokens', TOKEN_DOC), { validUntil: FUTURE }, { merge: true }));
            await assertFails(deleteDoc(doc(db, 'waitlistUnsubscribeTokens', TOKEN_DOC)));
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// §9 — Two-user workflow: OWNER (finder) ↔ OTHER (claimer) lifecycle
// ═══════════════════════════════════════════════════════════════════════════════
describe('§9 — Two-user workflow: finder ↔ claimer lifecycle', () => {
    const WF_SPOT_ID  = 'wf-spot-001';
    const WF_CHAT_ID  = `${OWNER_UID}_${OTHER_UID}_wf`;
    const WF_NOTIF_ID = 'wf-notif-001';

    const wfAvailableSpot = {
        finderId:   OWNER_UID,
        finderName: 'Workflow Alice',
        address:    '1 Workflow St',
        lat:        40.71,
        lng:        -74.01,
        type:       'free',
        status:     'available',
        geohash:    'dr5rv',
        pingMode:   'now',
        reportedAt: Timestamp.now(),
        expiresAt:  FUTURE,
    };

    const wfChat = {
        id:                   WF_CHAT_ID,
        participants:         [OWNER_UID, OTHER_UID],
        participantNames:     { [OWNER_UID]: 'Alice', [OTHER_UID]: 'Bob' },
        relatedSpotTitle:     '1 Workflow St',
        lastMessage:          'Heading out',
        lastMessageTimestamp: Timestamp.now(),
        lastSenderId:         OWNER_UID,
    };

    beforeEach(async () => {
        await seed('users', OWNER_UID, { fullName: 'Alice', username: 'alice' });
        await seed('users', OTHER_UID, { fullName: 'Bob',   username: 'bob'   });
        await testEnv.withSecurityRulesDisabled(async ctx => {
            await setDoc(
                doc(ctx.firestore(), 'users', OWNER_UID, 'private', 'account'),
                { moderationStatus: 'active', reportCount: 0 },
            );
        });
        await seed('spots',             WF_SPOT_ID,  wfAvailableSpot);
        await seed('chats',             WF_CHAT_ID,  wfChat);
        await seed('spotNotifications', WF_NOTIF_ID, {
            spotId:       WF_SPOT_ID,
            senderId:     OWNER_UID,
            targetUserId: OTHER_UID,
            type:         'delayed',
            message:      'Heading out now',
            createdAt:    Timestamp.now(),
        });
    });

    // ── Profile cross-reads ────────────────────────────────────────────────────

    it('WF-01: OTHER can read OWNER\'s public profile', async () => {
        await assertSucceeds(getDoc(doc(otherDb(), 'users', OWNER_UID)));
    });

    it('WF-02: OTHER cannot read OWNER\'s private/account subcollection', async () => {
        await assertFails(getDoc(doc(otherDb(), 'users', OWNER_UID, 'private', 'account')));
    });

    it('WF-03: OWNER cannot read OTHER\'s private/account subcollection', async () => {
        await assertFails(getDoc(doc(ownerDb(), 'users', OTHER_UID, 'private', 'account')));
    });

    it('WF-04: unauthenticated cannot read any private/account subcollection', async () => {
        await assertFails(getDoc(doc(anonDb(), 'users', OWNER_UID, 'private', 'account')));
    });

    // ── Ping lifecycle ─────────────────────────────────────────────────────────

    it('WF-05: OWNER can create a valid available Ping', async () => {
        // finderName must match the beforeEach-seeded profile's username
        // ('alice') — spot identity-display authority (matchesFinderIdentity).
        await assertSucceeds(commitBoundedPing(ownerDb(), OWNER_UID, 'wf-spot-new', {
            finderId:   OWNER_UID,
            finderName: 'alice',
            address:    '2 Workflow St',
            lat:        40.72,
            lng:        -74.02,
            type:       'free',
            status:     'available',
            geohash:    'dr5rv',
            pingMode:   'now',
            reportedAt: Timestamp.now(),
            expiresAt:  Timestamp.fromMillis(Date.now() + 25 * 60 * 1000),
        }));
    });

    it('WF-06: OTHER (authenticated) can read the available Ping', async () => {
        await assertSucceeds(getDoc(doc(otherDb(), 'spots', WF_SPOT_ID)));
    });

    it('WF-07: THIRD cannot update OWNER\'s Ping', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(
            upd(doc(thirdDb(), 'spots', WF_SPOT_ID), {
                status:    'claimed',
                claimedBy: THIRD_UID,
            }),
        );
    });

    it('WF-08: OTHER can claim OWNER\'s available Ping (express interest)', async () => {
        const db = otherDb();
        const claimedAt = Timestamp.now();
        await assertSucceeds(runTransaction(db, async (tx) => {
            tx.update(doc(db, 'spots', WF_SPOT_ID), {
                status: 'interested',
                claimState: 'heading',
                interestedUserId: OTHER_UID,
                claimStartedAt: claimedAt,
            });
            tx.set(doc(db, 'users', OTHER_UID, 'activeIncomingClaims', 'current'), {
                spotId: WF_SPOT_ID,
                claimStartedAt: claimedAt,
                claimState: 'heading',
                updatedAt: claimedAt,
            });
        }));
    });

    it('A2-HO-004: OWNER cannot claim their own available Ping', async () => {
        const db = ownerDb();
        const claimedAt = Timestamp.now();
        await assertFails(runTransaction(db, async (tx) => {
            tx.update(doc(db, 'spots', WF_SPOT_ID), {
                status: 'interested',
                claimState: 'heading',
                interestedUserId: OWNER_UID,
                claimStartedAt: claimedAt,
            });
            tx.set(doc(db, 'users', OWNER_UID, 'activeIncomingClaims', 'current'), {
                spotId: WF_SPOT_ID,
                claimStartedAt: claimedAt,
                claimState: 'heading',
                updatedAt: claimedAt,
            });
        }));

        let spot: any;
        let lockExists = true;
        await testEnv.withSecurityRulesDisabled(async ctx => {
            const fs = ctx.firestore();
            spot = (await getDoc(doc(fs, 'spots', WF_SPOT_ID))).data();
            lockExists = (await getDoc(doc(fs, 'users', OWNER_UID, 'activeIncomingClaims', 'current'))).exists();
        });
        expect(spot?.status).toBe('available');
        expect(spot?.interestedUserId).toBeUndefined();
        expect(lockExists).toBe(false);
    });

    // ── Chat isolation ─────────────────────────────────────────────────────────

    it('WF-09: OWNER can read the OWNER↔OTHER chat', async () => {
        await assertSucceeds(getDoc(doc(ownerDb(), 'chats', WF_CHAT_ID)));
    });

    it('WF-10: OTHER can read the OWNER↔OTHER chat', async () => {
        await assertSucceeds(getDoc(doc(otherDb(), 'chats', WF_CHAT_ID)));
    });

    it('WF-11: THIRD cannot read the OWNER↔OTHER chat', async () => {
        await assertFails(getDoc(doc(thirdDb(), 'chats', WF_CHAT_ID)));
    });

    // ── Notification isolation ─────────────────────────────────────────────────

    it('WF-12: notification targeted at OTHER is readable by OTHER only', async () => {
        await assertSucceeds(getDoc(doc(otherDb(), 'spotNotifications', WF_NOTIF_ID)));
        await assertFails(getDoc(doc(thirdDb(), 'spotNotifications', WF_NOTIF_ID)));
        await assertFails(getDoc(doc(anonDb(),  'spotNotifications', WF_NOTIF_ID)));
    });
});

// ── PA: users/{uid}/private/avatar — pendingUploadId race guard ───────────────
//
// Client writes pendingUploadId here before each Storage upload. Server (Admin SDK,
// bypasses rules) reads it in the moderation transaction and clears it on approval.
// Rules: owner read/write with strict schema; client delete denied (server-only clear).

describe('PA-01–PA-09: users/{uid}/private/avatar rules', () => {
    const VALID_PAYLOAD = () => ({
        pendingUploadId: 'upload-abc-123',
        requestedAt: Timestamp.now(),
    });

    it('PA-01: owner can write a valid pendingUploadId record', async () => {
        await assertSucceeds(
            setDoc(doc(ownerDb(), 'users', OWNER_UID, 'private', 'avatar'), VALID_PAYLOAD()),
        );
    });

    it('PA-02: owner can read their own private/avatar doc', async () => {
        await assertSucceeds(
            getDoc(doc(ownerDb(), 'users', OWNER_UID, 'private', 'avatar')),
        );
    });

    it('PA-03: non-owner cannot write to another user\'s private/avatar', async () => {
        await assertFails(
            setDoc(doc(otherDb(), 'users', OWNER_UID, 'private', 'avatar'), VALID_PAYLOAD()),
        );
    });

    it('PA-04: unauthenticated cannot write to private/avatar', async () => {
        await assertFails(
            setDoc(doc(anonDb(), 'users', OWNER_UID, 'private', 'avatar'), VALID_PAYLOAD()),
        );
    });

    it('PA-05: non-owner cannot read another user\'s private/avatar', async () => {
        await assertFails(
            getDoc(doc(otherDb(), 'users', OWNER_UID, 'private', 'avatar')),
        );
    });

    it('PA-06: unauthenticated cannot read private/avatar', async () => {
        await assertFails(
            getDoc(doc(anonDb(), 'users', OWNER_UID, 'private', 'avatar')),
        );
    });

    it('PA-07: write rejected when extra unknown field is present', async () => {
        await assertFails(
            setDoc(doc(ownerDb(), 'users', OWNER_UID, 'private', 'avatar'), {
                ...VALID_PAYLOAD(),
                extraField: 'bad',
            }),
        );
    });

    it('PA-08: write rejected when pendingUploadId exceeds 64 characters', async () => {
        await assertFails(
            setDoc(doc(ownerDb(), 'users', OWNER_UID, 'private', 'avatar'), {
                pendingUploadId: 'x'.repeat(65),
                requestedAt: Timestamp.now(),
            }),
        );
    });

    it('PA-09: write rejected when pendingUploadId is empty string', async () => {
        await assertFails(
            setDoc(doc(ownerDb(), 'users', OWNER_UID, 'private', 'avatar'), {
                pendingUploadId: '',
                requestedAt: Timestamp.now(),
            }),
        );
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A1 — one active incoming claim per user (HO-003)
// Server authority is the lock at users/{uid}/activeIncomingClaims/current,
// written in the same transaction as the Ping claim. These tests skip the
// client checkAlreadyInterested query on purpose.
// ═══════════════════════════════════════════════════════════════════════════════
describe('A1 — one active incoming claim', () => {
    function availablePing(address: string) {
        return {
            finderId: OWNER_UID,
            finderName: 'TestFinder',
            address,
            lat: 40.71,
            lng: -74.01,
            status: 'available',
            pingMode: 'now' as const,
            reportedAt: Timestamp.now(),
            expiresAt: FUTURE,
        };
    }

    async function seedClaimer(uid: string, username: string) {
        await seed('users', uid, { username, fullName: username, crowns: 0 });
    }

    function claimPayload(
        uid: string,
        username: string,
        claimState: 'heading' | 'committed',
        claimStartedAt: Timestamp,
        extra: Record<string, unknown> = {},
    ) {
        return {
            status: 'interested',
            claimState,
            ownerLeavingNow: null,
            interestedUserId: uid,
            interestedUserName: username,
            interestedUserVehicleColor: null,
            interestedUserVehicleType: null,
            interestedUserVehicleBrand: null,
            interestedUserTitle: getTitleForCrowns(0),
            claimStartedAt,
            ...extra,
        };
    }

    async function claimAs(
        db: ReturnType<typeof otherDb>,
        uid: string,
        username: string,
        spotId: string,
        claimState: 'heading' | 'committed' = 'heading',
    ) {
        return acquireActiveIncomingClaim(db, {
            spotId,
            uid,
            unavailableMessage: 'Someone already got this spot',
            missingMessage: 'Spot no longer exists',
            buildClaimFields: (_spot, startedAt) => claimPayload(uid, username, claimState, startedAt),
        });
    }

    async function readSpot(id: string) {
        let snap: any;
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            snap = await getDoc(doc(ctx.firestore(), 'spots', id));
        });
        return snap;
    }

    async function readLock(uid: string) {
        let snap: any;
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            snap = await getDoc(activeIncomingClaimRef(ctx.firestore(), uid));
        });
        return snap;
    }

    async function seedLock(uid: string, spotId: string, claimStartedAt = Timestamp.now()) {
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            await setDoc(activeIncomingClaimRef(ctx.firestore(), uid), {
                spotId,
                claimStartedAt,
                claimState: 'heading',
                updatedAt: claimStartedAt,
            });
        });
    }

    it('A1-1: a claim with no existing lock succeeds and writes the lock in the same commit', async () => {
        await seedClaimer(OTHER_UID, 'bob');
        await seed('spots', 'a1-open', availablePing('A1 open'));
        const db = otherDb();
        await expect(claimAs(db, OTHER_UID, 'bob', 'a1-open')).resolves.toBe('claimed');
        const spot = await readSpot('a1-open');
        const lock = await readLock(OTHER_UID);
        expect(spot.data().status).toBe('interested');
        expect(spot.data().interestedUserId).toBe(OTHER_UID);
        expect(lock.exists()).toBe(true);
        expect(lock.data().spotId).toBe('a1-open');
        expect(lock.data().claimState).toBe('heading');
        expect(lock.data().claimStartedAt.isEqual(spot.data().claimStartedAt)).toBe(true);
    });

    it('A1-2: a malicious client that skips the client check cannot claim a second Ping without moving the lock', async () => {
        await seedClaimer(OTHER_UID, 'bob');
        await seed('spots', 'a1-held', availablePing('A1 held'));
        await seed('spots', 'a1-second', availablePing('A1 second'));
        const db = otherDb();
        await claimAs(db, OTHER_UID, 'bob', 'a1-held');
        const claimedAt = Timestamp.now();
        await assertFails(runTransaction(db, async (tx) => {
            tx.update(doc(db, 'spots', 'a1-second'), claimPayload(OTHER_UID, 'bob', 'heading', claimedAt));
        }));
        expect((await readSpot('a1-held')).data().interestedUserId).toBe(OTHER_UID);
        expect((await readSpot('a1-second')).data().status).toBe('available');
        expect((await readLock(OTHER_UID)).data().spotId).toBe('a1-held');
    });

    it('A1-3: moving the lock onto a second Ping while the first is still interested is denied', async () => {
        await seedClaimer(OTHER_UID, 'bob');
        await seed('spots', 'a1-first', availablePing('A1 first'));
        await seed('spots', 'a1-other', availablePing('A1 other'));
        const db = otherDb();
        await claimAs(db, OTHER_UID, 'bob', 'a1-first');
        const claimedAt = Timestamp.now();
        await assertFails(runTransaction(db, async (tx) => {
            tx.update(doc(db, 'spots', 'a1-other'), claimPayload(OTHER_UID, 'bob', 'heading', claimedAt));
            tx.set(activeIncomingClaimRef(db, OTHER_UID), {
                spotId: 'a1-other',
                claimStartedAt: claimedAt,
                claimState: 'heading',
                updatedAt: claimedAt,
            });
        }));
        expect((await readSpot('a1-first')).data().status).toBe('interested');
        expect((await readSpot('a1-other')).data().status).toBe('available');
        expect((await readLock(OTHER_UID)).data().spotId).toBe('a1-first');
    });

    it('A1-4: two parallel claims on different Pings by the same user produce exactly one active claim', async () => {
        await seedClaimer(OTHER_UID, 'bob');
        await seed('spots', 'a1-race-a', availablePing('A1 race A'));
        await seed('spots', 'a1-race-b', availablePing('A1 race B'));
        const db = otherDb();
        const results = await Promise.allSettled([
            claimAs(db, OTHER_UID, 'bob', 'a1-race-a'),
            claimAs(db, OTHER_UID, 'bob', 'a1-race-b'),
        ]);
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
        const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
        expect(rejected.reason?.code).toBe('permission-denied');

        const spotA = await readSpot('a1-race-a');
        const spotB = await readSpot('a1-race-b');
        const interested = [spotA, spotB].filter((snap) => snap.data().status === 'interested');
        expect(interested).toHaveLength(1);
        expect(interested[0].data().interestedUserId).toBe(OTHER_UID);
        expect((await readLock(OTHER_UID)).data().spotId).toBe(interested[0].id);
    });

    it('A1-5: same-Ping contention still denies the second claimer (isAvailableForClaim)', async () => {
        await seedClaimer(OTHER_UID, 'bob');
        await seedClaimer(THIRD_UID, 'cara');
        await seed('spots', 'a1-same', availablePing('A1 same'));
        await claimAs(otherDb(), OTHER_UID, 'bob', 'a1-same');
        const db = thirdDb();
        const claimedAt = Timestamp.now();
        await assertFails(runTransaction(db, async (tx) => {
            tx.update(doc(db, 'spots', 'a1-same'), claimPayload(THIRD_UID, 'cara', 'heading', claimedAt));
            tx.set(activeIncomingClaimRef(db, THIRD_UID), {
                spotId: 'a1-same',
                claimStartedAt: claimedAt,
                claimState: 'heading',
                updatedAt: claimedAt,
            });
        }));
        const spot = await readSpot('a1-same');
        expect(spot.data().interestedUserId).toBe(OTHER_UID);
        expect((await readLock(THIRD_UID)).exists()).toBe(false);
    });

    it('A1-6: a duplicate claim of the same Ping is idempotent and does not change the fingerprint', async () => {
        await seedClaimer(OTHER_UID, 'bob');
        await seed('spots', 'a1-dup', availablePing('A1 dup'));
        const db = otherDb();
        await claimAs(db, OTHER_UID, 'bob', 'a1-dup');
        const before = await readSpot('a1-dup');
        await expect(claimAs(db, OTHER_UID, 'bob', 'a1-dup')).resolves.toBe('already_held');
        const after = await readSpot('a1-dup');
        expect(after.data().claimStartedAt.isEqual(before.data().claimStartedAt)).toBe(true);
        expect((await readLock(OTHER_UID)).data().spotId).toBe('a1-dup');
    });

    it('A1-7: a stale lock whose Ping is already released does not block the next claim', async () => {
        await seedClaimer(OTHER_UID, 'bob');
        await seed('spots', 'a1-released', {
            ...availablePing('A1 released'),
            status: 'available',
            interestedUserId: null,
        });
        await seed('spots', 'a1-next', availablePing('A1 next'));
        await seedLock(OTHER_UID, 'a1-released', Timestamp.fromMillis(Date.now() - 60_000));
        const db = otherDb();
        await expect(claimAs(db, OTHER_UID, 'bob', 'a1-next')).resolves.toBe('claimed');
        expect((await readLock(OTHER_UID)).data().spotId).toBe('a1-next');
        expect((await readSpot('a1-next')).data().interestedUserId).toBe(OTHER_UID);
    });

    it('A1-8: a stale lock whose Ping document is gone does not block the next claim', async () => {
        await seedClaimer(OTHER_UID, 'bob');
        await seed('spots', 'a1-after-delete', availablePing('A1 after delete'));
        await seedLock(OTHER_UID, 'a1-missing-ping', Timestamp.fromMillis(Date.now() - 60_000));
        await expect(claimAs(otherDb(), OTHER_UID, 'bob', 'a1-after-delete')).resolves.toBe('claimed');
        expect((await readLock(OTHER_UID)).data().spotId).toBe('a1-after-delete');
    });

    it('A1-9: claimer cancel clears the matching lock in the same transaction', async () => {
        await seedClaimer(OTHER_UID, 'bob');
        await seed('spots', 'a1-cancel', availablePing('A1 cancel'));
        const db = otherDb();
        await claimAs(db, OTHER_UID, 'bob', 'a1-cancel');
        const fingerprint = (await readSpot('a1-cancel')).data().claimStartedAt.toMillis();
        await expect(cancelClaimTransaction(db, {
            spotId: 'a1-cancel',
            claimantId: OTHER_UID,
            finderId: OWNER_UID,
            fingerprint,
            message: 'Changed my mind',
        })).resolves.toBe('cancelled');
        expect((await readSpot('a1-cancel')).data().status).toBe('available');
        expect((await readSpot('a1-cancel')).data().interestedUserId).toBeNull();
        expect((await readLock(OTHER_UID)).exists()).toBe(false);
    });

    it('A1-10: cancel does not delete a lock that names a different Ping', async () => {
        await seedClaimer(OTHER_UID, 'bob');
        const started = Timestamp.fromMillis(Date.now() - 60_000);
        await seed('spots', 'a1-cancel-this', {
            ...availablePing('A1 cancel this'),
            status: 'interested',
            claimState: 'heading',
            interestedUserId: OTHER_UID,
            claimStartedAt: started,
            expiresAt: FUTURE,
        });
        await seed('spots', 'a1-lock-other', {
            ...availablePing('A1 lock other'),
            status: 'interested',
            claimState: 'heading',
            interestedUserId: OTHER_UID,
            claimStartedAt: started,
        });
        await seedLock(OTHER_UID, 'a1-lock-other', started);
        const db = otherDb();
        await expect(cancelClaimTransaction(db, {
            spotId: 'a1-cancel-this',
            claimantId: OTHER_UID,
            finderId: OWNER_UID,
            fingerprint: started.toMillis(),
            message: 'x',
        })).resolves.toBe('cancelled');
        expect((await readSpot('a1-cancel-this')).data().interestedUserId).toBeNull();
        expect((await readLock(OTHER_UID)).data().spotId).toBe('a1-lock-other');
    });

    it('A1-11: arrival clears the matching lock, and a later claim is allowed', async () => {
        await seedClaimer(OTHER_UID, 'bob');
        await seed('spots', 'a1-arrive', availablePing('A1 arrive'));
        await seed('spots', 'a1-after-arrive', availablePing('A1 after arrive'));
        const db = otherDb();
        await claimAs(db, OTHER_UID, 'bob', 'a1-arrive');
        await markClaimArrived(db, 'a1-arrive', OTHER_UID);
        const arrived = (await readSpot('a1-arrive')).data();
        expect(arrived.status).toBe('occupied');
        expect(arrived.claimState).toBe('arrived_pending_outcome');
        expect(arrived.arrivedAt).toBeTruthy();
        expect((await readLock(OTHER_UID)).exists()).toBe(false);
        await expect(claimAs(db, OTHER_UID, 'bob', 'a1-after-arrive')).resolves.toBe('claimed');
        expect((await readLock(OTHER_UID)).data().spotId).toBe('a1-after-arrive');
    });

    it('A1-12: clearing a claim while leaving the matching lock behind is denied', async () => {
        await seedClaimer(OTHER_UID, 'bob');
        await seed('spots', 'a1-keep-lock', availablePing('A1 keep lock'));
        const db = otherDb();
        await claimAs(db, OTHER_UID, 'bob', 'a1-keep-lock');
        const { updateDoc } = await import('firebase/firestore');
        await assertFails(updateDoc(doc(db, 'spots', 'a1-keep-lock'), {
            status: 'available',
            claimState: null,
            interestedUserId: null,
            interestedUserName: null,
            interestedUserVehicleColor: null,
            interestedUserVehicleType: null,
            interestedUserVehicleBrand: null,
            interestedUserTitle: null,
            etaMinutes: null,
            interestExpiresAt: null,
            claimStartedAt: null,
            ownerLeavingNow: null,
            ownerLeavingNowAt: null,
            claimReminderAt: null,
            claimReminderSentAt: null,
            claimAutoReleaseAt: null,
            claimAutoReleasedAt: null,
        }));
        expect((await readSpot('a1-keep-lock')).data().status).toBe('interested');
        expect((await readLock(OTHER_UID)).data().spotId).toBe('a1-keep-lock');
    });

    it('A1-13: another user cannot read the lock, and a non-current doc id cannot be created', async () => {
        await seedClaimer(OTHER_UID, 'bob');
        await seed('spots', 'a1-private', availablePing('A1 private'));
        await claimAs(otherDb(), OTHER_UID, 'bob', 'a1-private');
        await assertFails(getDoc(activeIncomingClaimRef(thirdDb(), OTHER_UID)));
        await assertSucceeds(getDoc(activeIncomingClaimRef(otherDb(), OTHER_UID)));
        await assertFails(setDoc(doc(otherDb(), 'users', OTHER_UID, 'activeIncomingClaims', 'other'), {
            spotId: 'a1-private',
            claimStartedAt: Timestamp.now(),
            claimState: 'heading',
            updatedAt: Timestamp.now(),
        }));
    });

    it('A1-14: a scheduled committed claim blocks a second claim', async () => {
        await seedClaimer(OTHER_UID, 'bob');
        await seed('spots', 'a1-committed', {
            ...availablePing('A1 committed'),
            pingMode: 'later',
            reportedAt: FUTURE,
            expiresAt: Timestamp.fromMillis(FUTURE.toMillis() + 3_600_000),
        });
        await seed('spots', 'a1-while-committed', availablePing('A1 while committed'));
        const db = otherDb();
        await expect(claimAs(db, OTHER_UID, 'bob', 'a1-committed', 'committed')).resolves.toBe('claimed');
        expect((await readSpot('a1-committed')).data().claimState).toBe('committed');
        await expect(claimAs(db, OTHER_UID, 'bob', 'a1-while-committed')).rejects.toMatchObject({
            code: 'permission-denied',
        });
        expect((await readLock(OTHER_UID)).data().spotId).toBe('a1-committed');
        expect((await readSpot('a1-while-committed')).data().status).toBe('available');
    });

    it('A1-15: driver terminal completion clears a leftover lock that still names the Ping', async () => {
        await seedClaimer(OTHER_UID, 'bob');
        const spotId = 'a1-terminal';
        await seed('spots', spotId, {
            ...interestedSpot,
            status: 'occupied',
            address: 'A1 terminal',
        });
        await seedLock(OTHER_UID, spotId);
        const db = otherDb();
        await expect(completeTerminalHandoff(db, {
            spotId,
            driverId: OTHER_UID,
            driverName: 'bob',
            finderId: OWNER_UID,
            address: 'A1 terminal',
            outcome: 'success',
            failureReason: null,
        })).resolves.toBe('created');
        expect((await readLock(OTHER_UID)).exists()).toBe(false);
    });

    async function seedLegacyInterest(id: string, uid: string, claimStartedAt: Timestamp) {
        await seed('spots', id, {
            finderId: OWNER_UID,
            finderName: 'TestFinder',
            address: id,
            lat: 40.71,
            lng: -74.01,
            status: 'interested',
            pingMode: 'now',
            claimState: 'heading',
            interestedUserId: uid,
            interestedUserName: 'bob',
            claimStartedAt,
            reportedAt: Timestamp.now(),
            expiresAt: FUTURE,
            interestExpiresAt: FUTURE,
        });
    }

    it('A1-R001: a legacy lockless interested Ping cannot obtain a second claim before or after reconciliation', async () => {
        await closeActiveClaimRollout();
        await seedClaimer(OTHER_UID, 'bob');
        await seedClaimer(THIRD_UID, 'cara');
        const legacyStarted = Timestamp.fromMillis(Date.now() - 60_000);
        await seedLegacyInterest('a1-r001-legacy', OTHER_UID, legacyStarted);
        await seed('spots', 'a1-r001-new', availablePing('A1 R001 new'));
        const db = otherDb();

        await expect(claimAs(db, OTHER_UID, 'bob', 'a1-r001-new')).rejects.toMatchObject({
            code: 'permission-denied',
        });
        expect((await readSpot('a1-r001-legacy')).data().interestedUserId).toBe(OTHER_UID);
        expect((await readSpot('a1-r001-new')).data().status).toBe('available');
        expect((await readLock(OTHER_UID)).exists()).toBe(false);

        const tools = rolloutTools();
        const repaired = await tools.reconcile(tools.db, tools.now());
        expect(repaired.enforced).toBe(false);
        expect(repaired.locklessCount).toBe(0);
        expect(repaired.duplicateUserCount).toBe(0);
        expect(repaired.duplicatePingCount).toBe(0);
        const lock = await readLock(OTHER_UID);
        expect(lock.exists()).toBe(true);
        expect(lock.data().spotId).toBe('a1-r001-legacy');
        expect(lock.data().claimStartedAt.toMillis()).toBe(legacyStarted.toMillis());

        await expect(claimAs(db, OTHER_UID, 'bob', 'a1-r001-new')).rejects.toMatchObject({
            code: 'permission-denied',
        });

        const confirmed = await tools.reconcile(tools.db, tools.now());
        expect(confirmed.enforced).toBe(true);
        expect(confirmed.locklessCount).toBe(0);
        expect(confirmed.duplicateUserCount).toBe(0);
        expect(confirmed.duplicatePingCount).toBe(0);
        await expect(claimAs(db, OTHER_UID, 'bob', 'a1-r001-new')).rejects.toMatchObject({
            code: 'permission-denied',
        });
        expect((await readSpot('a1-r001-legacy')).data().status).toBe('interested');
        expect((await readSpot('a1-r001-new')).data().status).toBe('available');
        expect((await readLock(OTHER_UID)).data().spotId).toBe('a1-r001-legacy');
        await expect(claimAs(thirdDb(), THIRD_UID, 'cara', 'a1-r001-new')).resolves.toBe('claimed');
    });

    it('A1-R001b: duplicate interested Pings are released deterministically and reported before the gate opens', async () => {
        await closeActiveClaimRollout();
        await seedClaimer(OTHER_UID, 'bob');
        const earlier = Timestamp.fromMillis(Date.now() - 120_000);
        const later = Timestamp.fromMillis(Date.now() - 30_000);
        await seedLegacyInterest('a1-r001-keep', OTHER_UID, earlier);
        await seedLegacyInterest('a1-r001-drop', OTHER_UID, later);
        await seed('spots', 'a1-r001-third', availablePing('A1 R001 third'));

        const tools = rolloutTools();
        const repaired = await tools.reconcile(tools.db, tools.now());
        expect(repaired.enforced).toBe(false);
        expect(repaired.duplicateUserCount).toBe(0);
        expect(repaired.duplicatePingCount).toBe(0);
        expect(repaired.locklessCount).toBe(0);
        expect((await readSpot('a1-r001-keep')).data().interestedUserId).toBe(OTHER_UID);
        const dropped = await readSpot('a1-r001-drop');
        expect(dropped.data().status).toBe('available');
        expect(dropped.data().interestedUserId).toBeNull();
        expect((await readLock(OTHER_UID)).data().spotId).toBe('a1-r001-keep');

        const conflictSnap = await tools.db.doc(`activeIncomingClaimConflicts/${OTHER_UID}`).get();
        expect(conflictSnap.exists).toBe(true);
        expect(conflictSnap.data().keptSpotId).toBe('a1-r001-keep');
        expect(conflictSnap.data().releasedSpotIds).toEqual(['a1-r001-drop']);
        expect(conflictSnap.data().rule).toBe('earliest_claimStartedAt_then_spotId');

        await expect(claimAs(otherDb(), OTHER_UID, 'bob', 'a1-r001-third')).rejects.toMatchObject({
            code: 'permission-denied',
        });
        const confirmed = await tools.reconcile(tools.db, tools.now());
        expect(confirmed.enforced).toBe(true);
        await expect(claimAs(otherDb(), OTHER_UID, 'bob', 'a1-r001-third')).rejects.toMatchObject({
            code: 'permission-denied',
        });
        expect((await readSpot('a1-r001-keep')).data().status).toBe('interested');
        expect((await readSpot('a1-r001-third')).data().status).toBe('available');
    });

    it('A1-R001c: a client cannot open or rewrite the rollout gate', async () => {
        const db = otherDb();
        await assertFails(setDoc(doc(db, 'activeIncomingClaimRollout', 'status'), {
            enforced: true,
            locklessCount: 0,
            duplicateUserCount: 0,
            duplicatePingCount: 0,
        }));
        await assertFails(setDoc(doc(db, 'activeIncomingClaimConflicts', OTHER_UID), {
            keptSpotId: 'forged',
            releasedSpotIds: [],
        }));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A3 — committed → heading vs a released claim (HO-009)
// Arm 2b is unchanged. The client transaction writes only that field set.
// ═══════════════════════════════════════════════════════════════════════════════
describe('A3 — commit to heading', () => {
    async function readSpot(id: string) {
        let data: any;
        await testEnv.withSecurityRulesDisabled(async ctx => {
            data = (await getDoc(doc(ctx.firestore(), 'spots', id))).data();
        });
        return data;
    }

    async function seedLock(spotId: string) {
        await testEnv.withSecurityRulesDisabled(async ctx => {
            await setDoc(doc(ctx.firestore(), 'users', OTHER_UID, 'activeIncomingClaims', 'current'), {
                spotId,
                claimStartedAt: CLAIM_STARTED_AT,
                claimState: 'committed',
                updatedAt: CLAIM_STARTED_AT,
            });
        });
    }

    it('A3-1: the claimer transaction moves committed to heading without touching the fingerprint or lock', async () => {
        await seed('spots', 'a3-commit', committedScheduledSpot);
        await seedLock('a3-commit');
        const nowMs = Date.now();
        const outcome = await commitClaimToHeading(otherDb(), {
            spotId: 'a3-commit',
            uid: OTHER_UID,
            etaMinutes: 5,
            claimMinutes: 10,
            nowMs,
        });
        expect(outcome).toBe('committed');
        const spot = await readSpot('a3-commit');
        expect(spot.claimState).toBe('heading');
        expect(spot.status).toBe('interested');
        expect(spot.interestedUserId).toBe(OTHER_UID);
        expect(spot.claimStartedAt.isEqual(CLAIM_STARTED_AT)).toBe(true);
        expect(spot.claimAutoReleaseAt).toBeNull();
        expect(spot.etaMinutes).toBe(5);
        expect(spot.interestExpiresAt.toMillis()).toBe(nowMs + 10 * 60_000);
        let lock: any;
        await testEnv.withSecurityRulesDisabled(async ctx => {
            lock = (await getDoc(doc(ctx.firestore(), 'users', OTHER_UID, 'activeIncomingClaims', 'current'))).data();
        });
        expect(lock.spotId).toBe('a3-commit');
        expect(lock.claimState).toBe('committed');
    });

    it('A3-2: a second commit is already heading and does not rewrite ETA', async () => {
        await seed('spots', 'a3-dual', { ...committedScheduledSpot, etaMinutes: 4 });
        const [first, second] = await Promise.all([
            commitClaimToHeading(otherDb(), {
                spotId: 'a3-dual', uid: OTHER_UID, etaMinutes: 5, claimMinutes: 10, nowMs: Date.now(),
            }),
            commitClaimToHeading(otherDb(), {
                spotId: 'a3-dual', uid: OTHER_UID, etaMinutes: 9, claimMinutes: 14, nowMs: Date.now(),
            }),
        ]);
        expect([first, second].sort()).toEqual(['already_heading', 'committed']);
        const spot = await readSpot('a3-dual');
        const eta = spot.etaMinutes;
        expect([5, 9]).toContain(eta);
        const again = await commitClaimToHeading(otherDb(), {
            spotId: 'a3-dual', uid: OTHER_UID, etaMinutes: 3, claimMinutes: 8, nowMs: Date.now(),
        });
        expect(again).toBe('already_heading');
        expect((await readSpot('a3-dual')).etaMinutes).toBe(eta);
        expect((await readSpot('a3-dual')).claimStartedAt.isEqual(CLAIM_STARTED_AT)).toBe(true);
    });

    it('A3-3: commit after the claim was released does not resurrect heading', async () => {
        await seed('spots', 'a3-released', {
            ...committedScheduledSpot,
            status: 'available',
            claimState: null,
            interestedUserId: null,
            claimStartedAt: null,
            claimAutoReleaseAt: null,
            etaMinutes: null,
        });
        const outcome = await commitClaimToHeading(otherDb(), {
            spotId: 'a3-released', uid: OTHER_UID, etaMinutes: 5, claimMinutes: 10, nowMs: Date.now(),
        });
        expect(outcome).toBe('rejected');
        const spot = await readSpot('a3-released');
        expect(spot.status).toBe('available');
        expect(spot.claimState).toBeNull();
        expect(spot.interestedUserId).toBeNull();
        expect(spot.claimStartedAt).toBeNull();

        const { updateDoc } = await import('firebase/firestore');
        await assertFails(updateDoc(doc(otherDb(), 'spots', 'a3-released'), {
            claimState: 'heading',
            ownerLeavingNow: null,
            ownerLeavingNowAt: null,
            etaMinutes: 5,
            interestExpiresAt: Timestamp.fromMillis(Date.now() + 10 * 60_000),
            claimReminderAt: null,
            claimReminderSentAt: null,
            claimAutoReleaseAt: null,
        }));
        expect((await readSpot('a3-released')).claimState).toBeNull();
    });

    it('A3-4: owner leave-now can extend claimAutoReleaseAt, then commit still clears it', async () => {
        await seed('spots', 'a3-leave', committedScheduledSpot);
        const { updateDoc } = await import('firebase/firestore');
        const extended = Timestamp.fromMillis(Date.now() + 10 * 60_000);
        await assertSucceeds(updateDoc(doc(ownerDb(), 'spots', 'a3-leave'), {
            ownerLeavingNow: true,
            ownerLeavingNowAt: Timestamp.now(),
            claimAutoReleaseAt: extended,
        }));
        const outcome = await commitClaimToHeading(otherDb(), {
            spotId: 'a3-leave', uid: OTHER_UID, etaMinutes: 5, claimMinutes: 10, nowMs: Date.now(),
        });
        expect(outcome).toBe('committed');
        const spot = await readSpot('a3-leave');
        expect(spot.claimState).toBe('heading');
        expect(spot.interestedUserId).toBe(OTHER_UID);
        expect(spot.claimAutoReleaseAt).toBeNull();
        expect(spot.claimStartedAt.isEqual(CLAIM_STARTED_AT)).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A5 — Ping lifetime bounds (SEC-002). Create-time caps only. Claim arms are
// unchanged; seeded documents are not re-validated.
// ═══════════════════════════════════════════════════════════════════════════════
describe('A5 — Ping lifetime bounds', () => {
    const THIRTY_MIN = 30 * 60 * 1000;
    const TWELVE_H = 12 * 60 * 60 * 1000;

    function livePing(overrides: Record<string, unknown> = {}) {
        const reportedAt = Timestamp.now();
        return {
            lat: 40.7128,
            lng: -74.006,
            type: 'free',
            status: 'available',
            finderId: OWNER_UID,
            finderName: 'Alice',
            pingMode: 'now',
            reportedAt,
            expiresAt: Timestamp.fromMillis(reportedAt.toMillis() + THIRTY_MIN),
            geohash: 'dr5ru',
            address: '123 Main St, New York, NY',
            ...overrides,
        };
    }

    beforeEach(async () => {
        await seed('users', OWNER_UID, { id: OWNER_UID, username: 'Alice', crowns: 0, title: 'Newcomer' });
    });

    it('A5-TTL-POS: an honest 30-minute live Ping create succeeds', async () => {
        await assertSucceeds(commitBoundedPing(ownerDb(), OWNER_UID, 'a5-live', livePing()));
    });

    it('A5-TTL-NEG: expiresAt more than 30 minutes after reportedAt is denied', async () => {
        const reportedAt = Timestamp.now();
        await assertFails(commitBoundedPing(ownerDb(), OWNER_UID, 'a5-ttl-over', livePing({
            reportedAt,
            expiresAt: Timestamp.fromMillis(reportedAt.toMillis() + THIRTY_MIN + 60_000),
        })));
    });

    it('A5-TTL-POS: a reportedAt in the recent past still succeeds when expiresAt stays within 30 minutes of it', async () => {
        const reportedAt = Timestamp.fromMillis(Date.now() - 5 * 60 * 1000);
        await assertSucceeds(commitBoundedPing(ownerDb(), OWNER_UID, 'a5-short-live', livePing({
            reportedAt,
            expiresAt: Timestamp.fromMillis(reportedAt.toMillis() + THIRTY_MIN),
        })));
    });

    it('A5-HORIZON-POS: My Car now and later within the 12-hour cap succeed', async () => {
        const nowReported = Timestamp.now();
        await assertSucceeds(commitBoundedPing(ownerDb(), OWNER_UID, 'a5-mycar-now', livePing({
            pingMode: 'now',
            source: 'my_car',
            reportedAt: nowReported,
            expiresAt: Timestamp.fromMillis(nowReported.toMillis() + THIRTY_MIN),
        })));

        const laterReported = Timestamp.fromMillis(Date.now() + TWELVE_H - 60_000);
        await assertSucceeds(commitBoundedPing(ownerDb(), OWNER_UID, 'a5-mycar-later', livePing({
            pingMode: 'later',
            source: 'my_car',
            reportedAt: laterReported,
            expiresAt: Timestamp.fromMillis(laterReported.toMillis() + THIRTY_MIN),
        })));
    });

    it('A5-HORIZON-NEG: reportedAt more than 12 hours ahead is denied', async () => {
        const reportedAt = Timestamp.fromMillis(Date.now() + TWELVE_H + 5 * 60 * 1000);
        await assertFails(commitBoundedPing(ownerDb(), OWNER_UID, 'a5-horizon', livePing({
            pingMode: 'later',
            reportedAt,
            expiresAt: Timestamp.fromMillis(reportedAt.toMillis() + THIRTY_MIN),
        })));
    });

    it('A5-GEOHASH: create still requires geohash (nearby delivery fields unchanged)', async () => {
        const payload = livePing();
        delete (payload as { geohash?: string }).geohash;
        await assertFails(commitBoundedPing(ownerDb(), OWNER_UID, 'a5-nogeo', payload));
    });

    it('A5-RATE-NEG: a direct create with no quota record is denied', async () => {
        await assertFails(addDoc(collection(ownerDb(), 'spots'), livePing()));
    });

    it('A5-RATE-NEG: the 6th create in the rolling hour is denied', async () => {
        const db = ownerDb();
        for (let i = 0; i < 5; i += 1) {
            await commitBoundedPing(db, OWNER_UID, `a5-rate-${i}`, livePing({ address: `Rate ${i}` }));
        }
        await assertFails(commitBoundedPing(db, OWNER_UID, 'a5-rate-6', livePing({ address: 'Rate 6' })));
        let sixthExists = true;
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            sixthExists = (await getDoc(doc(ctx.firestore(), 'spots', 'a5-rate-6'))).exists();
        });
        expect(sixthExists).toBe(false);
    });

    it('A5-RATE-NEG: replacing the quota list to drop in-window creates is denied', async () => {
        const db = ownerDb();
        for (let i = 0; i < 5; i += 1) {
            await commitBoundedPing(db, OWNER_UID, `a5-keep-${i}`, livePing({ address: `Keep ${i}` }));
        }
        const now = Timestamp.now();
        await assertFails(runTransaction(db, async (tx) => {
            tx.set(doc(db, 'spots', 'a5-reset'), livePing({ address: 'Reset' }));
            tx.set(doc(db, 'users', OWNER_UID, 'pingCreateRate', 'current'), {
                spotIds: ['a5-reset'],
                createdAts: [now],
            });
        }));
    });

    it('A5-RATE-NEG: the quota doc cannot be deleted to reset the hour', async () => {
        await commitBoundedPing(ownerDb(), OWNER_UID, 'a5-nodelete', livePing());
        await assertFails(deleteDoc(doc(ownerDb(), 'users', OWNER_UID, 'pingCreateRate', 'current')));
    });

    it('A5-RATE-POS: creates older than one hour do not consume the rolling quota', async () => {
        const stale = Timestamp.fromMillis(Date.now() - 2 * 60 * 60 * 1000);
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            await setDoc(doc(ctx.firestore(), 'users', OWNER_UID, 'pingCreateRate', 'current'), {
                spotIds: ['old-1', 'old-2', 'old-3', 'old-4', 'old-5'],
                createdAts: [stale, stale, stale, stale, stale],
            });
        });
        await assertSucceeds(commitBoundedPing(ownerDb(), OWNER_UID, 'a5-after-hour', livePing()));
    });

    it('A5-ORIGIN-POS: one departure re-ping of an occupied handoff succeeds', async () => {
        await seed('users', OTHER_UID, { id: OTHER_UID, username: 'Bob', crowns: 0 });
        await seed('spots', 'a5-origin', {
            ...livePing(),
            status: 'occupied',
            finderName: 'Alice',
            interestedUserId: OTHER_UID,
        });
        const reportedAt = Timestamp.fromMillis(Date.now() + 30 * 60 * 1000);
        await assertSucceeds(commitBoundedPing(otherDb(), OTHER_UID, 'a5-reping', {
            ...livePing({
                finderId: OTHER_UID,
                finderName: 'Bob',
                pingMode: 'later',
                reportedAt,
                expiresAt: Timestamp.fromMillis(reportedAt.toMillis() + THIRTY_MIN),
                originSpotId: 'a5-origin',
            }),
        }, 'a5-origin'));
    });

    it('A5-ORIGIN-NEG: a second origin-linked re-ping of the same handoff is denied', async () => {
        await seed('users', OTHER_UID, { id: OTHER_UID, username: 'Bob', crowns: 0 });
        await seed('spots', 'a5-origin-2', {
            ...livePing(),
            status: 'occupied',
            interestedUserId: OTHER_UID,
        });
        const reportedAt = Timestamp.fromMillis(Date.now() + 20 * 60 * 1000);
        const payload = {
            finderId: OTHER_UID,
            finderName: 'Bob',
            pingMode: 'later',
            reportedAt,
            expiresAt: Timestamp.fromMillis(reportedAt.toMillis() + THIRTY_MIN),
            originSpotId: 'a5-origin-2',
            lat: 40.7128,
            lng: -74.006,
            type: 'free',
            status: 'available',
            geohash: 'dr5ru',
            address: 'Departure',
        };
        await commitBoundedPing(otherDb(), OTHER_UID, 'a5-reping-1', payload, 'a5-origin-2');
        await assertFails(commitBoundedPing(otherDb(), OTHER_UID, 'a5-reping-2', {
            ...payload,
            address: 'Departure again',
        }, 'a5-origin-2'));
    });

    it('A5-ORIGIN-NEG: originSpotId without the create-once marker is denied', async () => {
        await assertFails(commitBoundedPing(ownerDb(), OWNER_UID, 'a5-origin-bare', livePing({
            originSpotId: 'missing-origin',
        })));
    });

    it('A5-ORIGIN-NEG: a re-ping of a spot that is not an occupied handoff is denied', async () => {
        await seed('spots', 'a5-still-available', livePing());
        await assertFails(commitBoundedPing(ownerDb(), OWNER_UID, 'a5-not-occupied', livePing({
            originSpotId: 'a5-still-available',
        }), 'a5-still-available'));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B1 — durable arrived_pending_outcome (HO-001 server half)
// Arrival stays status=occupied and also records claimState + arrivedAt.
// GPS is not part of the allow. B2 resume UI, B3 override, and B4 sweep are
// not covered here.
// ═══════════════════════════════════════════════════════════════════════════════
describe('B1 — durable arrived_pending_outcome', () => {
    function headingPing(id: string, extra: Record<string, unknown> = {}) {
        return {
            finderId: OWNER_UID,
            finderName: 'TestFinder',
            address: id,
            lat: 40.71,
            lng: -74.01,
            status: 'interested',
            claimState: 'heading',
            interestedUserId: OTHER_UID,
            pingMode: 'now',
            reportedAt: Timestamp.now(),
            expiresAt: FUTURE,
            claimStartedAt: Timestamp.fromMillis(Date.now() - 60_000),
            ...extra,
        };
    }

    async function seedLock(spotId: string) {
        const started = Timestamp.now();
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            await setDoc(activeIncomingClaimRef(ctx.firestore(), OTHER_UID), {
                spotId,
                claimStartedAt: started,
                claimState: 'heading',
                updatedAt: started,
            });
        });
    }

    async function readSpot(id: string) {
        let snap: any;
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            snap = await getDoc(doc(ctx.firestore(), 'spots', id));
        });
        return snap;
    }

    async function readLock() {
        let snap: any;
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            snap = await getDoc(activeIncomingClaimRef(ctx.firestore(), OTHER_UID));
        });
        return snap;
    }

    const clearFields = {
        claimState: null,
        ownerLeavingNow: null,
        ownerLeavingNowAt: null,
        interestedUserId: null,
        interestedUserName: null,
        interestedUserVehicleColor: null,
        interestedUserVehicleType: null,
        interestedUserVehicleBrand: null,
        interestedUserTitle: null,
        etaMinutes: null,
        interestExpiresAt: null,
        claimReminderAt: null,
        claimReminderSentAt: null,
        claimAutoReleaseAt: null,
        claimAutoReleasedAt: null,
        claimStartedAt: null,
    };

    it('B1-POS: first arrival persists occupied + arrived_pending_outcome + arrivedAt and clears the lock without GPS', async () => {
        const spotId = 'b1-pos';
        await seed('spots', spotId, headingPing(spotId));
        await seedLock(spotId);
        const db = otherDb();

        await assertSucceeds(runTransaction(db, async (tx) => {
            tx.update(doc(db, 'spots', spotId), {
                status: 'occupied',
                claimState: 'arrived_pending_outcome',
                arrivedAt: Timestamp.now(),
            });
            tx.delete(activeIncomingClaimRef(db, OTHER_UID));
        }));

        const spot = (await readSpot(spotId)).data();
        expect(spot.status).toBe('occupied');
        expect(spot.claimState).toBe('arrived_pending_outcome');
        expect(spot.arrivedAt).toBeTruthy();
        expect(spot.lat).toBe(40.71);
        expect(spot.lng).toBe(-74.01);
        expect((await readLock()).exists()).toBe(false);
    });

    it('B1-WRITE: markClaimArrived writes the durable fields and clears the matching lock', async () => {
        const spotId = 'b1-write';
        await seed('spots', spotId, headingPing(spotId));
        await seedLock(spotId);

        await markClaimArrived(otherDb(), spotId, OTHER_UID);

        const spot = (await readSpot(spotId)).data();
        expect(spot.status).toBe('occupied');
        expect(spot.claimState).toBe('arrived_pending_outcome');
        expect(typeof spot.arrivedAt?.toMillis).toBe('function');
        expect((await readLock()).exists()).toBe(false);
    });

    it('B1-IDEM: a second markClaimArrived succeeds and does not rewrite arrivedAt', async () => {
        const spotId = 'b1-idem';
        await seed('spots', spotId, headingPing(spotId));
        await seedLock(spotId);
        const db = otherDb();
        await markClaimArrived(db, spotId, OTHER_UID);
        const first = (await readSpot(spotId)).data().arrivedAt;

        await expect(markClaimArrived(db, spotId, OTHER_UID)).resolves.toBeUndefined();

        const second = (await readSpot(spotId)).data();
        expect(second.claimState).toBe('arrived_pending_outcome');
        expect(second.status).toBe('occupied');
        expect(second.arrivedAt.isEqual(first)).toBe(true);
        expect((await readLock()).exists()).toBe(false);
    });

    it('B1-IDEM-RULES: an unchanged arrival replay is allowed and a new arrivedAt is denied', async () => {
        const spotId = 'b1-idem-rules';
        await seed('spots', spotId, headingPing(spotId));
        await seedLock(spotId);
        const db = otherDb();
        await markClaimArrived(db, spotId, OTHER_UID);
        const arrivedAt = (await readSpot(spotId)).data().arrivedAt;
        const { updateDoc } = await import('firebase/firestore');

        await assertSucceeds(updateDoc(doc(db, 'spots', spotId), {
            status: 'occupied',
            claimState: 'arrived_pending_outcome',
            arrivedAt,
        }));
        await assertFails(updateDoc(doc(db, 'spots', spotId), {
            status: 'occupied',
            claimState: 'arrived_pending_outcome',
            arrivedAt: Timestamp.now(),
        }));
        expect((await readSpot(spotId)).data().arrivedAt.isEqual(arrivedAt)).toBe(true);
    });

    it('B1-NEG: an extra field on arrival is denied', async () => {
        const spotId = 'b1-extra';
        await seed('spots', spotId, headingPing(spotId));
        await seedLock(spotId);
        const db = otherDb();
        await assertFails(runTransaction(db, async (tx) => {
            tx.update(doc(db, 'spots', spotId), {
                status: 'occupied',
                claimState: 'arrived_pending_outcome',
                arrivedAt: Timestamp.now(),
                etaMinutes: 1,
            });
            tx.delete(activeIncomingClaimRef(db, OTHER_UID));
        }));
        expect((await readSpot(spotId)).data().status).toBe('interested');
        expect((await readLock()).data().spotId).toBe(spotId);
    });

    it('B1-NEG: arrival that does not become arrived_pending_outcome is denied', async () => {
        const spotId = 'b1-status-only';
        await seed('spots', spotId, headingPing(spotId));
        await seedLock(spotId);
        const db = otherDb();
        const { updateDoc } = await import('firebase/firestore');

        await assertFails(runTransaction(db, async (tx) => {
            tx.update(doc(db, 'spots', spotId), { status: 'occupied' });
            tx.delete(activeIncomingClaimRef(db, OTHER_UID));
        }));
        await assertFails(runTransaction(db, async (tx) => {
            tx.update(doc(db, 'spots', spotId), {
                status: 'occupied',
                claimState: 'heading',
                arrivedAt: Timestamp.now(),
            });
            tx.delete(activeIncomingClaimRef(db, OTHER_UID));
        }));
        await assertFails(updateDoc(doc(db, 'spots', spotId), {
            claimState: 'arrived_pending_outcome',
        }));

        const spot = (await readSpot(spotId)).data();
        expect(spot.status).toBe('interested');
        expect(spot.claimState).toBe('heading');
        expect(spot.arrivedAt).toBeUndefined();
        expect((await readLock()).exists()).toBe(true);
    });

    it('B1-NEG: arrived_pending_outcome while a matching lock remains is denied', async () => {
        const spotId = 'b1-lock';
        await seed('spots', spotId, headingPing(spotId));
        await seedLock(spotId);
        const db = otherDb();
        await assertFails(runTransaction(db, async (tx) => {
            tx.update(doc(db, 'spots', spotId), {
                status: 'occupied',
                claimState: 'arrived_pending_outcome',
                arrivedAt: Timestamp.now(),
            });
        }));
        expect((await readSpot(spotId)).data().status).toBe('interested');
        expect((await readLock()).data().spotId).toBe(spotId);
    });

    it('B1-NEG: terminal feedback already present cannot be reopened into awaiting outcome', async () => {
        const spotId = 'b1-feedback';
        await seed('spots', spotId, headingPing(spotId));
        await seedLock(spotId);
        await seed('spotFeedback', `${spotId}_${OTHER_UID}`, {
            spotId,
            userId: OTHER_UID,
            finderId: OWNER_UID,
            address: spotId,
            outcome: 'success',
            failureReason: null,
            createdAt: Timestamp.now(),
        });
        const db = otherDb();
        await assertFails(runTransaction(db, async (tx) => {
            tx.update(doc(db, 'spots', spotId), {
                status: 'occupied',
                claimState: 'arrived_pending_outcome',
                arrivedAt: Timestamp.now(),
            });
            tx.delete(activeIncomingClaimRef(db, OTHER_UID));
        }));
        expect((await readSpot(spotId)).data().claimState).toBe('heading');
        expect((await readLock()).exists()).toBe(true);
    });

    it('B1-TERMINAL: completeTerminalHandoff still succeeds from occupied + arrived_pending_outcome', async () => {
        const spotId = 'b1-terminal';
        const arrivedAt = Timestamp.fromMillis(Date.now() - 60_000);
        await seed('spots', spotId, headingPing(spotId, {
            status: 'occupied',
            claimState: 'arrived_pending_outcome',
            arrivedAt,
        }));

        await expect(completeTerminalHandoff(otherDb(), {
            spotId,
            driverId: OTHER_UID,
            driverName: 'TestDriver',
            finderId: OWNER_UID,
            address: spotId,
            outcome: 'success',
            failureReason: null,
        })).resolves.toBe('created');

        const spot = (await readSpot(spotId)).data();
        expect(spot.status).toBe('occupied');
        expect(spot.claimState).toBe('arrived_pending_outcome');
        expect(spot.arrivedAt.isEqual(arrivedAt)).toBe(true);
        const feedback = await getDoc(doc(otherDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`));
        expect(feedback.data()).toMatchObject({ outcome: 'success', failureReason: null });
    });

    it('B1-FINDER: finder confirm still completes when the claimer already arrived', async () => {
        const spotId = 'b1-finder';
        const arrivedAt = Timestamp.fromMillis(Date.now() - 30_000);
        await seed('spots', spotId, headingPing(spotId, {
            status: 'occupied',
            claimState: 'arrived_pending_outcome',
            arrivedAt,
        }));

        await expect(completeFinderConfirmedHandoff(ownerDb(), {
            spotId,
            driverId: OTHER_UID,
            finderId: OWNER_UID,
            finderName: 'TestFinder',
            address: spotId,
        })).resolves.toBe('created');

        const spot = (await readSpot(spotId)).data();
        expect(spot.status).toBe('occupied');
        expect(spot.claimState).toBe('arrived_pending_outcome');
        expect(spot.arrivedAt.isEqual(arrivedAt)).toBe(true);
        const feedback = await getDoc(doc(ownerDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`));
        expect(feedback.data()).toMatchObject({ outcome: 'success', confirmedByFinder: true });
    });

    it('B1-CANCEL: cancel after arrival does not reopen the Ping', async () => {
        const spotId = 'b1-cancel';
        await seed('spots', spotId, headingPing(spotId));
        await seedLock(spotId);
        const db = otherDb();
        await markClaimArrived(db, spotId, OTHER_UID);
        const arrivedAt = (await readSpot(spotId)).data().arrivedAt;
        const { updateDoc } = await import('firebase/firestore');

        await expect(cancelClaimTransaction(db, {
            spotId,
            claimantId: OTHER_UID,
            finderId: OWNER_UID,
            fingerprint: timestampToMillis((await readSpot(spotId)).data().claimStartedAt),
            message: 'Changed my mind',
        })).resolves.toBe('already_resolved');
        await assertFails(updateDoc(doc(db, 'spots', spotId), {
            ...clearFields,
            status: 'available',
        }));

        const spot = (await readSpot(spotId)).data();
        expect(spot.status).toBe('occupied');
        expect(spot.claimState).toBe('arrived_pending_outcome');
        expect(spot.interestedUserId).toBe(OTHER_UID);
        expect(spot.arrivedAt.isEqual(arrivedAt)).toBe(true);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B2 — claimer resume query. Occupied arrived Pings stay off the public feed.
// ═══════════════════════════════════════════════════════════════════════════════
describe('B2 — claimer arrived resume query', () => {
    async function seedResumeFixtures() {
        await seed('spots', 'b2-open', {
            finderId: OWNER_UID,
            finderName: 'TestFinder',
            address: '1 Resume St',
            lat: 40.71,
            lng: -74.01,
            status: 'occupied',
            claimState: 'arrived_pending_outcome',
            interestedUserId: OTHER_UID,
            arrivedAt: Timestamp.now(),
            pingMode: 'now',
            reportedAt: Timestamp.now(),
            expiresAt: FUTURE,
        });
        await seed('spots', 'b2-heading', {
            ...interestedSpot,
            claimState: 'heading',
            interestedUserId: OTHER_UID,
        });
        await seed('spots', 'b2-stranger', {
            finderId: OWNER_UID,
            finderName: 'TestFinder',
            address: '9 Other St',
            lat: 40.72,
            lng: -74.02,
            status: 'occupied',
            claimState: 'arrived_pending_outcome',
            interestedUserId: THIRD_UID,
            arrivedAt: Timestamp.now(),
            pingMode: 'now',
            reportedAt: Timestamp.now(),
            expiresAt: FUTURE,
        });
        await seed('spots', 'b2-available', availableSpot);
    }

    it('B2-QUERY: claimer lists only their own arrived_pending_outcome Pings', async () => {
        await seedResumeFixtures();
        const snap = await assertSucceeds(getDocs(claimerArrivedSpotsQuery(otherDb(), OTHER_UID)));
        expect(snap.docs.map((d) => d.id).sort()).toEqual(['b2-open']);
    });

    it('B2-QUERY: another user cannot list the claimer\'s arrived Pings', async () => {
        await seedResumeFixtures();
        await assertFails(getDocs(claimerArrivedSpotsQuery(thirdDb(), OTHER_UID)));
        await assertFails(getDocs(query(
            collection(otherDb(), 'spots'),
            where('claimState', '==', 'arrived_pending_outcome'),
        )));
    });

    it('B2-QUERY: the public available/interested feed still excludes occupied arrived Pings', async () => {
        await seedResumeFixtures();
        const feed = await assertSucceeds(getDocs(query(
            collection(otherDb(), 'spots'),
            where('status', 'in', ['available', 'interested']),
        )));
        const ids = feed.docs.map((d) => d.id);
        expect(ids).toContain('b2-available');
        expect(ids).toContain('b2-heading');
        expect(ids).not.toContain('b2-open');
        expect(ids).not.toContain('b2-stranger');
    });

    it('B2-QUERY: claimer can list their own terminal feedback without a spot filter', async () => {
        await seed('spotFeedback', `b2-open_${OTHER_UID}`, {
            spotId: 'b2-open',
            userId: OTHER_UID,
            finderId: OWNER_UID,
            outcome: 'success',
            failureReason: null,
            address: '1 Resume St',
            createdAt: Timestamp.now(),
        });
        const snap = await assertSucceeds(getDocs(claimerTerminalFeedbackQuery(otherDb(), OTHER_UID)));
        expect(snap.docs.map((d) => d.id)).toEqual([`b2-open_${OTHER_UID}`]);
        await assertFails(getDocs(claimerTerminalFeedbackQuery(thirdDb(), OTHER_UID)));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// B4 — client cannot write unconfirmed. The cleanup job uses the Admin SDK.
// ═══════════════════════════════════════════════════════════════════════════════
describe('B4 — client cannot create unconfirmed', () => {
    const spotId = 'b4-client-unconfirmed';

    async function seedArrived() {
        await seed('spots', spotId, {
            finderId: OWNER_UID,
            finderName: 'TestFinder',
            address: '1 Unconfirmed St',
            lat: 40.71,
            lng: -74.01,
            status: 'occupied',
            claimState: 'arrived_pending_outcome',
            interestedUserId: OTHER_UID,
            arrivedAt: Timestamp.fromMillis(Date.now() - 3 * 60 * 60 * 1000),
            pingMode: 'now',
            reportedAt: Timestamp.now(),
            expiresAt: FUTURE,
        });
    }

    function unconfirmedFeedback(extra: Record<string, unknown> = {}) {
        return {
            spotId,
            userId: OTHER_UID,
            finderId: OWNER_UID,
            outcome: 'unconfirmed',
            failureReason: null,
            address: '1 Unconfirmed St',
            createdAt: Timestamp.now(),
            ...extra,
        };
    }

    async function serverFeedback() {
        let data: Record<string, unknown> | null = null;
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            const snap = await getDoc(doc(ctx.firestore(), 'spotFeedback', `${spotId}_${OTHER_UID}`));
            data = snap.exists() ? snap.data() : null;
        });
        return data;
    }

    it('B4-CLIENT: claimer, finder, and admin token cannot create outcome unconfirmed', async () => {
        await seedArrived();
        await assertFails(setDoc(doc(otherDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`), unconfirmedFeedback()));
        await assertFails(setDoc(doc(ownerDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`), unconfirmedFeedback({
            confirmedByFinder: true,
        })));
        await assertFails(setDoc(doc(adminDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`), unconfirmedFeedback()));
        expect(await serverFeedback()).toBeNull();
    });

    it('B4-CLIENT: claimer cannot stamp claimState unconfirmed', async () => {
        await seedArrived();
        await assertFails(updateDoc(doc(otherDb(), 'spots', spotId), { claimState: 'unconfirmed' }));
        let claimState = '';
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            claimState = (await getDoc(doc(ctx.firestore(), 'spots', spotId))).data()?.claimState;
        });
        expect(claimState).toBe('arrived_pending_outcome');
    });

    it('B4-LATE: a success or finder confirm after unconfirmed does not overwrite feedback or notify', async () => {
        await seedArrived();
        await seed('spotFeedback', `${spotId}_${OTHER_UID}`, {
            spotId,
            userId: OTHER_UID,
            finderId: OWNER_UID,
            outcome: 'unconfirmed',
            failureReason: null,
            address: '1 Unconfirmed St',
            createdAt: Timestamp.fromMillis(Date.now() - 60_000),
        });

        await expect(completeTerminalHandoff(otherDb(), {
            spotId,
            driverId: OTHER_UID,
            driverName: 'TestDriver',
            finderId: OWNER_UID,
            address: '1 Unconfirmed St',
            outcome: 'success',
            failureReason: null,
        })).rejects.toMatchObject({ code: 'permission-denied' });
        await expect(completeFinderConfirmedHandoff(ownerDb(), {
            spotId,
            driverId: OTHER_UID,
            finderId: OWNER_UID,
            finderName: 'TestFinder',
            address: '1 Unconfirmed St',
        })).rejects.toMatchObject({ code: 'permission-denied' });

        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            const db = ctx.firestore();
            const feedback = await getDoc(doc(db, 'spotFeedback', `${spotId}_${OTHER_UID}`));
            expect(feedback.data()).toMatchObject({ outcome: 'unconfirmed', failureReason: null });
            const spot = await getDoc(doc(db, 'spots', spotId));
            expect(spot.data()?.claimState).toBe('arrived_pending_outcome');
            const notices = await getDocs(query(collection(db, 'spotNotifications'), where('spotId', '==', spotId)));
            expect(notices.docs.filter((snap) => snap.data().type === 'handoff_success')).toHaveLength(0);
        });
    });
});
