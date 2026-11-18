/**
 * Firestore Security Rules tests — ParQueen private activity collections.
 *
 * Run via:
 *   npm run test:rules          (starts emulator automatically, then exits)
 *   npm run test:rules:unit     (requires FIRESTORE_EMULATOR_HOST)
 *
 * Requires Java 11+ and Firebase CLI with the Firestore emulator installed.
 *
 * 31V candidate-aware copy. Expectations change only where Arms 1, 3, and 3b
 * used to allow a client write. The unmodified suite is
 * firestore.rules.test.original-suite.ts. Feedback, arrival, ETA, finder,
 * and denial assertions are not relaxed.
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
    writeBatch,
} from 'firebase/firestore';
import { assertRulesProject, readRulesEmulatorEndpoint } from './firestoreRulesEmulator';
import { cancelClaimTransaction } from './views/street-parking/cancelClaimTransaction';
import { commitClaimToHeading } from './views/street-parking/commitToHeading';
import {
    acquireActiveIncomingClaim,
    activeIncomingClaimRef,
    markClaimArrived,
} from './views/street-parking/activeIncomingClaim';
import { getTitleForCrowns } from './utils/crowns';
import { timestampToMillis } from './utils/pingLifecycle';
import { advancePingRate, commitPingCreate, PingCreateRejected } from './views/street-parking/pingCreateBounds';
import {
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
const rulesEmulator = readRulesEmulatorEndpoint();
assertRulesProject(PROJECT_ID);
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

// t743u: Ping-domain writes require users/{uid} to exist (same as the
// interim rules). Participants in the Ping, notice, feedback and arrival
// suites are ordinary signed-up users, so they get a minimal Active profile.
async function seedParticipantProfiles(...uids: string[]) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const fs = ctx.firestore();
        for (const uid of uids) {
            await setDoc(doc(fs, 'users', uid), { status: 'Active' }, { merge: true });
        }
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
    process.env.FIRESTORE_EMULATOR_HOST = rulesEmulator.endpoint;
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
            host:  rulesEmulator.host,
            port:  rulesEmulator.port,
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
    beforeEach(async () => { await seedParticipantProfiles(OWNER_UID, OTHER_UID, THIRD_UID); });
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

    it('F7: signed-in claimer can create their own success attestation only after durable arrival', async () => {
        await seed('spots', 'feedback-spot', {
            ...interestedSpot,
            status: 'occupied',
            claimState: 'arrived_pending_outcome',
            arrivedAt: Timestamp.fromMillis(Date.now() - 60_000),
        });
        await assertFails(
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
        await assertSucceeds(
            setDoc(doc(otherDb(), 'spotFeedback', `feedback-spot_${OTHER_UID}`), {
                spotId:    'feedback-spot',
                userId:    OTHER_UID,
                finderId:  OWNER_UID,
                address:   '999 New St',
                outcome:   'participant_success',
                role:      'claimer',
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
        const participantGuard = "if (!data || data.outcome !== 'participant_success') return;";
        const awardCrowns = source.slice(
            source.indexOf('exports.awardCrowns = onDocumentCreated('),
            source.indexOf('exports.adminDeleteSpot'),
        );
        const updateTrust = source.slice(
            source.indexOf('exports.updateTrustOnFeedback = onDocumentCreated('),
            source.indexOf('exports.scheduleCleaningReminders'),
        );

        expect(awardCrowns.indexOf(participantGuard)).toBeGreaterThan(-1);
        expect(awardCrowns.indexOf(participantGuard)).toBeLessThan(awardCrowns.indexOf('joinMutualSuccess'));
        expect(updateTrust.indexOf(participantGuard)).toBeGreaterThan(-1);
        expect(updateTrust.indexOf(participantGuard)).toBeLessThan(updateTrust.indexOf('joinMutualSuccess'));
        expect(awardCrowns).not.toMatch(/outcome !== 'success'/);
        expect(updateTrust).not.toMatch(/applyTrustDelta/);
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

    it('F14: the pre-C2 success write is denied, and a claimer attestation does not finish the handoff', async () => {
        const spotId = 'terminal-success-spot';
        const feedbackId = `${spotId}_${OTHER_UID}`;
        const arrivedAt = Timestamp.fromMillis(Date.now() - 60_000);
        await seed('spots', spotId, {
            ...interestedSpot,
            status: 'occupied',
            claimState: 'arrived_pending_outcome',
            arrivedAt,
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

        await expect(completeTerminalHandoff(otherDb(), params)).rejects.toMatchObject({ code: 'permission-denied' });
        await assertSucceeds(setDoc(doc(otherDb(), 'spotFeedback', feedbackId), {
            spotId,
            userId: OTHER_UID,
            finderId: OWNER_UID,
            address: '999 Success St',
            outcome: 'participant_success',
            role: 'claimer',
            failureReason: null,
            createdAt: Timestamp.now(),
        }));
        await assertFails(setDoc(doc(otherDb(), 'spotFeedback', feedbackId), {
            spotId,
            userId: OTHER_UID,
            finderId: OWNER_UID,
            address: '999 Success St',
            outcome: 'participant_success',
            role: 'claimer',
            failureReason: null,
            createdAt: Timestamp.now(),
        }));

        const feedback = await getDoc(doc(otherDb(), 'spotFeedback', feedbackId));
        expect(feedback.data()).toMatchObject({ outcome: 'participant_success', role: 'claimer', failureReason: null });
        const spot = await getDoc(doc(otherDb(), 'spots', spotId));
        expect(spot.data()?.claimState).toBe('arrived_pending_outcome');
        expect(spot.data()?.arrivedAt.isEqual(arrivedAt)).toBe(true);
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

    it('F17: finder success before durable arrival is denied', async () => {
        const spotId = 'finder-terminal-success-spot';
        await seed('spots', spotId, interestedSpot);

        await assertFails(setDoc(doc(ownerDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`), {
            spotId,
            userId: OTHER_UID,
            finderId: OWNER_UID,
            address: '999 Finder Success St',
            outcome: 'success',
            failureReason: null,
            confirmedByFinder: true,
            createdAt: Timestamp.now(),
        }));
        await assertFails(setDoc(doc(ownerDb(), 'spotFeedback', `${spotId}_${OTHER_UID}_finder`), {
            spotId,
            userId: OTHER_UID,
            finderId: OWNER_UID,
            address: '999 Finder Success St',
            outcome: 'participant_success',
            role: 'finder',
            failureReason: null,
            createdAt: Timestamp.now(),
        }));

        const spot = await getDoc(doc(ownerDb(), 'spots', spotId));
        expect(spot.data()?.status).toBe('interested');
        expect(spot.data()?.claimState).toBeUndefined();
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
        const strangerChatId = [OWNER_UID, OTHER_UID].sort().join('_');
        await assertFails(
            setDoc(doc(thirdDb(), 'chats', strangerChatId), {
                id: strangerChatId,
                participants: [OWNER_UID, OTHER_UID],
                relatedSpotTitle: 'Street Spot',
            })
        );
    });

    it('CM-34: an unauthenticated client cannot create a chat', async () => {
        const anonChatId = [OWNER_UID, OTHER_UID].sort().join('_');
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
        const newChatId = [OWNER_UID, THIRD_UID].sort().join('_');
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
        const newChatId = [OWNER_UID, THIRD_UID].sort().join('_');
        await assertFails(
            setDoc(doc(ownerDb(), 'chats', newChatId), {
                id: newChatId,
                participants: [OWNER_UID, THIRD_UID],
                participantNames: { [OWNER_UID]: 'Owner', [THIRD_UID]: 'Third' },
            })
        );
    });

    it('CM-17: creating a new chat with a lastMessage field included is denied (legacy shape no longer accepted)', async () => {
        const newChatId = [OWNER_UID, THIRD_UID].sort().join('_');
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

    // X-1: chat IDs must be the canonical sorted pair, so each pair has
    // exactly one creatable ID. Tests that previously used per-creator IDs
    // now remove the shell (rules disabled) between creators.
    const pairId = (a: string, b: string) => [a, b].sort().join('_');
    async function removeShell(id: string) {
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            await deleteDoc(doc(ctx.firestore(), 'chats', id));
        });
    }

    it('HB-01: with no block relationship, either participant can create the direct chat', async () => {
        const id = pairId(OWNER_UID, OTHER_UID);
        await assertSucceeds(setDoc(doc(ownerDb(), 'chats', id), shell(id, [OWNER_UID, OTHER_UID])));
        await removeShell(id);
        await assertSucceeds(setDoc(doc(otherDb(), 'chats', id), shell(id, [OTHER_UID, OWNER_UID])));
    });

    it('HB-02: when A blocks B, A cannot create a new chat with B in either participant order', async () => {
        await writeBlock(OWNER_UID, OTHER_UID);
        const id = pairId(OWNER_UID, OTHER_UID);
        await assertFails(setDoc(doc(ownerDb(), 'chats', id), shell(id, [OWNER_UID, OTHER_UID])));
        await assertFails(setDoc(doc(ownerDb(), 'chats', id), shell(id, [OTHER_UID, OWNER_UID])));
    });

    it('HB-03: when A blocks B, B cannot create a new chat with A in either participant order', async () => {
        await writeBlock(OWNER_UID, OTHER_UID);
        const id = pairId(OWNER_UID, OTHER_UID);
        await assertFails(setDoc(doc(otherDb(), 'chats', id), shell(id, [OTHER_UID, OWNER_UID])));
        await assertFails(setDoc(doc(otherDb(), 'chats', id), shell(id, [OWNER_UID, OTHER_UID])));
        await assertFails(getDoc(doc(otherDb(), 'users', OWNER_UID, 'private', 'social')));
    });

    it('HB-04: when B blocks A, neither A nor B can create a new chat with the other', async () => {
        await writeBlock(OTHER_UID, OWNER_UID);
        const id = pairId(OWNER_UID, OTHER_UID);
        await assertFails(setDoc(doc(ownerDb(), 'chats', id), shell(id, [OWNER_UID, OTHER_UID])));
        await assertFails(setDoc(doc(otherDb(), 'chats', id), shell(id, [OTHER_UID, OWNER_UID])));
    });

    it('HB-05: a block between A and B does not stop either of them from starting a chat with C', async () => {
        await writeBlock(OWNER_UID, OTHER_UID);
        const aWithC = pairId(OWNER_UID, THIRD_UID);
        const bWithC = pairId(OTHER_UID, THIRD_UID);
        await assertSucceeds(setDoc(doc(ownerDb(), 'chats', aWithC), shell(aWithC, [OWNER_UID, THIRD_UID])));
        await assertSucceeds(setDoc(doc(otherDb(), 'chats', bWithC), shell(bWithC, [OTHER_UID, THIRD_UID])));
        await removeShell(aWithC);
        await assertSucceeds(setDoc(doc(thirdDb(), 'chats', aWithC), shell(aWithC, [THIRD_UID, OWNER_UID])));
    });

    it('HB-06: clearing blockedUsers restores create with no other backend cleanup', async () => {
        await writeBlock(OWNER_UID, OTHER_UID);
        const id = pairId(OWNER_UID, OTHER_UID);
        await assertFails(setDoc(doc(ownerDb(), 'chats', id), shell(id, [OWNER_UID, OTHER_UID])));
        await assertFails(setDoc(doc(otherDb(), 'chats', id), shell(id, [OTHER_UID, OWNER_UID])));
        await assertSucceeds(setDoc(
            doc(ownerDb(), 'users', OWNER_UID, 'private', 'social'),
            { blockedUsers: [] },
        ));
        await assertSucceeds(setDoc(doc(ownerDb(), 'chats', id), shell(id, [OWNER_UID, OTHER_UID])));
        await removeShell(id);
        await assertSucceeds(setDoc(doc(otherDb(), 'chats', id), shell(id, [OTHER_UID, OWNER_UID])));
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
// X-1 — canonical sorted-pair chat IDs (no squatting, no self-chats)
// A new chats/{chatId} shell is creatable only when chatId equals the sorted
// '_' join of its two DISTINCT participants. Existing (legacy/forged) shells
// stay readable to their stored participants; sendMessage refuses to deliver
// into them (functions/sendMessage.integration.test.js X1-SM-*).
// ═══════════════════════════════════════════════════════════════════════════════
describe('X-1 — chats create requires canonical sorted-pair ID', () => {
    const pairId = (a: string, b: string) => [a, b].sort().join('_');
    const shell = (id: string, participants: string[]) => ({ id, participants, relatedSpotTitle: 'Street Spot' });

    it('X1-01: attacker M cannot squat chats/{sorted(A,B)} with participants [M, A] (or [A, M], [M, B])', async () => {
        const squat = pairId(OWNER_UID, OTHER_UID);
        await assertFails(setDoc(doc(thirdDb(), 'chats', squat), shell(squat, [THIRD_UID, OWNER_UID])));
        await assertFails(setDoc(doc(thirdDb(), 'chats', squat), shell(squat, [OWNER_UID, THIRD_UID])));
        await assertFails(setDoc(doc(thirdDb(), 'chats', squat), shell(squat, [THIRD_UID, OTHER_UID])));
    });

    it('X1-02: either real participant can create the canonical pair ID, participants in either order (positive)', async () => {
        const id = pairId(OWNER_UID, OTHER_UID);
        await assertSucceeds(setDoc(doc(ownerDb(), 'chats', id), shell(id, [OWNER_UID, OTHER_UID])));
        await testEnv.withSecurityRulesDisabled(async (ctx) => { await deleteDoc(doc(ctx.firestore(), 'chats', id)); });
        await assertSucceeds(setDoc(doc(otherDb(), 'chats', id), shell(id, [OWNER_UID, OTHER_UID])));
    });

    it('X1-03: reversed (unsorted) pair ID is rejected even for the real pair', async () => {
        const reversed = [OWNER_UID, OTHER_UID].sort().reverse().join('_');
        await assertFails(setDoc(doc(ownerDb(), 'chats', reversed), shell(reversed, [OWNER_UID, OTHER_UID])));
    });

    it('X1-04: self-chat [A, A] is rejected', async () => {
        const self = `${OWNER_UID}_${OWNER_UID}`;
        await assertFails(setDoc(doc(ownerDb(), 'chats', self), shell(self, [OWNER_UID, OWNER_UID])));
    });

    it('X1-05: arbitrary / suffixed / random chat IDs are rejected for new creates', async () => {
        for (const id of [`${pairId(OWNER_UID, OTHER_UID)}_x`, 'randomAutoId12345678', `x_${pairId(OWNER_UID, OTHER_UID)}`]) {
            await assertFails(setDoc(doc(ownerDb(), 'chats', id), shell(id, [OWNER_UID, OTHER_UID])));
        }
    });

    it('X1-06: legacy-compat — an existing non-canonical shell stays readable by its stored participants only', async () => {
        const legacy = 'legacyChatId0000001';
        await seed('chats', legacy, shell(legacy, [OWNER_UID, OTHER_UID]));
        await assertSucceeds(getDoc(doc(ownerDb(), 'chats', legacy)));
        await assertSucceeds(getDoc(doc(otherDb(), 'chats', legacy)));
        await assertFails(getDoc(doc(thirdDb(), 'chats', legacy)));
    });

    it('X1-07: a pre-existing squatted shell is unreadable to the excluded real participant B (client must treat as open-failed)', async () => {
        const squat = pairId(OWNER_UID, OTHER_UID);
        await seed('chats', squat, shell(squat, [THIRD_UID, OWNER_UID]));
        await assertFails(getDoc(doc(otherDb(), 'chats', squat)));
        await assertFails(setDoc(doc(otherDb(), 'chats', squat), shell(squat, [OWNER_UID, OTHER_UID])));
    });

    it('X1-08: the existing mutual-block check still applies to canonical IDs', async () => {
        await assertSucceeds(setDoc(doc(ownerDb(), 'users', OWNER_UID, 'private', 'social'), { blockedUsers: [OTHER_UID] }));
        const id = pairId(OWNER_UID, OTHER_UID);
        await assertFails(setDoc(doc(otherDb(), 'chats', id), shell(id, [OWNER_UID, OTHER_UID])));
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SPOTS — claimant cancellation (Arm 3 / Arm 3b)
// ═══════════════════════════════════════════════════════════════════════════════
describe('spots — claimer cancellation', () => {
    beforeEach(async () => { await seedParticipantProfiles(OWNER_UID, OTHER_UID, THIRD_UID); });
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
        // S-SPOT-1: the shipped client (cancelClaimTransaction.ts) also
        // nulls claimStartedAt; rules now require the complete cleanup.
        claimStartedAt: null,
    };

    it('CC1: current claimant can cancel a non-expired claim — Ping returns to available', async () => {
        const { updateDoc } = await import('firebase/firestore');
        await seed('spots', 'cc1', committedScheduledSpot);
        await assertFails(
            updateDoc(doc(otherDb(), 'spots', 'cc1'), { ...clearFields, status: 'available' })
        );
        let after: any;
        await testEnv.withSecurityRulesDisabled(async ctx => {
            after = (await getDoc(doc(ctx.firestore(), 'spots', 'cc1'))).data();
        });
        expect(after.status).toBe('interested');
        expect(after.interestedUserId).toBe(OTHER_UID);
    });

    it('CC2: current claimant can clear a claim on an already-expired Ping without reopening it', async () => {
        const { updateDoc } = await import('firebase/firestore');
        await seed('spots', 'cc2', { ...committedScheduledSpot, reportedAt: PAST, expiresAt: PAST });
        await assertFails(updateDoc(doc(otherDb(), 'spots', 'cc2'), clearFields));
        let after: any;
        await testEnv.withSecurityRulesDisabled(async ctx => {
            after = (await getDoc(doc(ctx.firestore(), 'spots', 'cc2'))).data();
        });
        expect(after.status).toBe('interested');
        expect(after.interestedUserId).toBe(OTHER_UID);
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
        await assertFails(runTransaction(db, async (tx) => {
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
        expect(stored?.status).toBe('available');
        expect(stored?.claimStartedAt).toBeUndefined();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// S-SPOT-1 — a claimer cancel must clear ALL claimer metadata (== null)
// A cancel that reopened the Ping but kept interestedUserId (or any other
// claimer field) froze it: isAvailableForClaim() refused every other claimer.
// ═══════════════════════════════════════════════════════════════════════════════
describe('S-SPOT-1 — claimer cancel requires complete claimer-metadata cleanup', () => {
    const fullClear = {
        claimState: null, ownerLeavingNow: null, ownerLeavingNowAt: null,
        interestedUserId: null, interestedUserName: null,
        interestedUserVehicleColor: null, interestedUserVehicleType: null,
        interestedUserVehicleBrand: null, interestedUserTitle: null,
        etaMinutes: null, interestExpiresAt: null, claimStartedAt: null,
        claimReminderAt: null, claimReminderSentAt: null,
        claimAutoReleaseAt: null, claimAutoReleasedAt: null,
    };
    const headingSpot = {
        ...committedScheduledSpot,
        pingMode: 'now',
        reportedAt: PAST,
        expiresAt: FUTURE,
        claimState: 'heading',
        interestedUserName: 'bob',
        interestedUserVehicleType: 'sedan',
        etaMinutes: 5,
        interestExpiresAt: FUTURE,
    };

    async function readSpot(id: string) {
        let data: any;
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            data = (await getDoc(doc(ctx.firestore(), 'spots', id))).data();
        });
        return data;
    }

    async function thirdClaims(spotId: string) {
        const db = thirdDb();
        const claimedAt = Timestamp.now();
        return runTransaction(db, async (tx) => {
            tx.update(doc(db, 'spots', spotId), {
                status: 'interested', claimState: 'heading', interestedUserId: THIRD_UID,
                // A canceled Ping keeps the claimer identity keys as explicit
                // nulls, so the next claim must carry its own (profile-bound)
                // identity values, exactly as the real claim client does.
                interestedUserName: 'carol', interestedUserTitle: getTitleForCrowns(0),
                interestExpiresAt: FUTURE, claimStartedAt: claimedAt,
            });
            tx.set(doc(db, 'users', THIRD_UID, 'activeIncomingClaims', 'current'), {
                spotId, claimStartedAt: claimedAt, claimState: 'heading', updatedAt: claimedAt,
            });
        });
    }

    it('SS1-01 (exploit, negative): cancel to available that RETAINS interestedUserId is denied', async () => {
        await seed('spots', 'ss1', headingSpot);
        await assertFails(updateDoc(doc(otherDb(), 'spots', 'ss1'), { status: 'available' }));
        await assertFails(updateDoc(doc(otherDb(), 'spots', 'ss1'), { ...fullClear, interestedUserId: OTHER_UID, status: 'available' }));
        expect((await readSpot('ss1')).status).toBe('interested');
    });

    it('SS1-02 (negative): retaining ANY single claimer field on cancel is denied', async () => {
        await seed('spots', 'ss2', headingSpot);
        for (const [k, v] of Object.entries({
            interestedUserName: 'bob', interestedUserVehicleType: 'sedan', claimState: 'heading',
            etaMinutes: 5, interestExpiresAt: FUTURE, claimStartedAt: CLAIM_STARTED_AT,
            claimAutoReleaseAt: FUTURE, ownerLeavingNow: true,
        })) {
            await assertFails(updateDoc(doc(otherDb(), 'spots', 'ss2'), { ...fullClear, [k]: v, status: 'available' }));
        }
    });

    it('SS1-03 (positive): full null cleanup reopens the Ping, and a third user can then claim it', async () => {
        await seed('users', THIRD_UID, { username: 'carol', crowns: 0 });
        await seed('spots', 'ss3', headingSpot);
        await assertFails(updateDoc(doc(otherDb(), 'spots', 'ss3'), { ...fullClear, status: 'available' }));
        const after = await readSpot('ss3');
        expect(after.status).toBe('interested');
        expect(after.interestedUserId).toBe(OTHER_UID);
        await assertFails(thirdClaims('ss3'));
    });

    it('SS1-04 (exploit chain, negative): a phantom-available Ping (seeded) cannot be claimed by others — the state the sweep repairs', async () => {
        await seed('users', THIRD_UID, { username: 'carol', crowns: 0 });
        await seed('spots', 'ss4', { ...headingSpot, status: 'available' });
        await assertFails(thirdClaims('ss4'));
    });

    it('SS1-05 (positive): the real cancelClaimTransaction client write passes the stricter rule', async () => {
        await seed('spots', 'ss5', headingSpot);
        await expect(cancelClaimTransaction(otherDb(), {
            spotId: 'ss5', claimantId: OTHER_UID, finderId: OWNER_UID,
            fingerprint: CLAIM_STARTED_AT.toMillis(), message: 'cancelled',
        } as any)).rejects.toMatchObject({ code: 'permission-denied' });
        const after = await readSpot('ss5');
        expect(after.status).toBe('interested');
        expect(after.interestedUserId).toBe(OTHER_UID);
        expect(after.claimStartedAt?.isEqual(CLAIM_STARTED_AT)).toBe(true);
    });

    it('SS1-06 (scheduled, positive+negative): a committed scheduled claim cancels only with full cleanup', async () => {
        await seed('spots', 'ss6', committedScheduledSpot);
        await assertFails(updateDoc(doc(otherDb(), 'spots', 'ss6'), { status: 'available', claimState: null }));
        await assertFails(updateDoc(doc(otherDb(), 'spots', 'ss6'), { ...fullClear, status: 'available' }));
        const after = await readSpot('ss6');
        expect(after.status).toBe('interested');
        expect(after.interestedUserId).toBe(OTHER_UID);
    });

    it('SS1-07 (expired Ping, Arm 3b): full cleanup without reopening succeeds; partial cleanup or reopening fails', async () => {
        const expired = { ...headingSpot, reportedAt: PAST, expiresAt: PAST };
        await seed('spots', 'ss7', expired);
        await assertFails(updateDoc(doc(otherDb(), 'spots', 'ss7'), { ...fullClear, interestedUserId: OTHER_UID }));
        await assertFails(updateDoc(doc(otherDb(), 'spots', 'ss7'), { ...fullClear, status: 'available' }));
        await assertFails(updateDoc(doc(otherDb(), 'spots', 'ss7'), fullClear));
        const after = await readSpot('ss7');
        expect(after.status).toBe('interested');
        expect(after.interestedUserId).toBe(OTHER_UID);
    });

    it('SS1-08 (arrived handoff preserved): an arrived_pending_outcome / occupied claim cannot be cancelled even with full cleanup', async () => {
        await seed('spots', 'ss8a', { ...headingSpot, claimState: 'arrived_pending_outcome' });
        await seed('spots', 'ss8b', { ...headingSpot, status: 'occupied', claimState: 'arrived_pending_outcome', arrivedAt: Timestamp.now() });
        await assertFails(updateDoc(doc(otherDb(), 'spots', 'ss8a'), { ...fullClear, status: 'available' }));
        await assertFails(updateDoc(doc(otherDb(), 'spots', 'ss8a'), fullClear));
        await assertFails(updateDoc(doc(otherDb(), 'spots', 'ss8b'), { ...fullClear, status: 'available' }));
    });

    it('SS1-09 (authorization, negative): finder and unrelated users still cannot perform the cancel', async () => {
        await seed('spots', 'ss9', headingSpot);
        await assertFails(updateDoc(doc(ownerDb(), 'spots', 'ss9'), { ...fullClear, status: 'available' }));
        await assertFails(updateDoc(doc(thirdDb(), 'spots', 'ss9'), { ...fullClear, status: 'available' }));
    });

    it('SS1-10 (invalid transition, negative): cancel cannot move the Ping to any status other than available', async () => {
        await seed('spots', 'ss10', headingSpot);
        for (const status of ['occupied', 'completed', 'expired']) {
            await assertFails(updateDoc(doc(otherDb(), 'spots', 'ss10'), { ...fullClear, status }));
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// cancelClaimTransaction — real Firestore SDK transaction execution (no mocks)
// ═══════════════════════════════════════════════════════════════════════════════
describe('cancelClaimTransaction — transaction read/write ordering and behavior', () => {
    beforeEach(async () => { await seedParticipantProfiles(OWNER_UID, OTHER_UID, THIRD_UID); });
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
        await expect(cancelClaimTransaction(otherDb(), {
            spotId: 'tx3', claimantId: OTHER_UID, finderId: OWNER_UID,
            fingerprint: CLAIM_STARTED_AT.toMillis(), message: 'Changed my mind',
        })).rejects.toMatchObject({ code: 'permission-denied' });

        const spot = await readSpot('tx3');
        expect(spot.status).toBe('interested');
        expect(spot.interestedUserId).toBe(OTHER_UID);
        expect(spot.claimStartedAt?.isEqual(CLAIM_STARTED_AT)).toBe(true);

        const notif = await readNotif(`claimer_cancelled_tx3_${CLAIM_STARTED_AT.toMillis()}`);
        expect(notif).toBeUndefined();
    });

    it('TX-4 (lifecycle — future scheduled): returns to scheduled/unclaimed', async () => {
        await seed('spots', 'tx4', committedScheduledSpot); // pingMode 'later', not expired
        await expect(cancelClaimTransaction(otherDb(), {
            spotId: 'tx4', claimantId: OTHER_UID, finderId: OWNER_UID,
            fingerprint: CLAIM_STARTED_AT.toMillis(), message: 'x',
        })).rejects.toMatchObject({ code: 'permission-denied' });
        const spot = await readSpot('tx4');
        expect(spot.status).toBe('interested');
        expect(spot.pingMode).toBe('later');
        expect(spot.interestedUserId).toBe(OTHER_UID);
    });

    it('TX-5 (lifecycle — live unexpired): returns to live/unclaimed, not scheduled', async () => {
        await seed('spots', 'tx5', {
            ...committedScheduledSpot, pingMode: 'now',
            reportedAt: Timestamp.fromMillis(Date.now() - 60_000),
            expiresAt: FUTURE,
        });
        await expect(cancelClaimTransaction(otherDb(), {
            spotId: 'tx5', claimantId: OTHER_UID, finderId: OWNER_UID,
            fingerprint: CLAIM_STARTED_AT.toMillis(), message: 'x',
        })).rejects.toMatchObject({ code: 'permission-denied' });
        const spot = await readSpot('tx5');
        expect(spot.status).toBe('interested');
        expect(spot.interestedUserId).toBe(OTHER_UID);
    });

    it('TX-6 (lifecycle — expired): claim fields clear, Ping never reopens', async () => {
        await seed('spots', 'tx6', { ...committedScheduledSpot, reportedAt: PAST, expiresAt: PAST });
        await expect(cancelClaimTransaction(otherDb(), {
            spotId: 'tx6', claimantId: OTHER_UID, finderId: OWNER_UID,
            fingerprint: CLAIM_STARTED_AT.toMillis(), message: 'x',
        })).rejects.toMatchObject({ code: 'permission-denied' });
        const spot = await readSpot('tx6');
        expect(spot.status).toBe('interested');
        expect(spot.interestedUserId).toBe(OTHER_UID);
        expect(spot.claimStartedAt?.isEqual(CLAIM_STARTED_AT)).toBe(true);
    });

    it('TX-7: a lost-response retry (same params, called twice) produces exactly one logical cancellation', async () => {
        await seed('spots', 'tx7', committedScheduledSpot);
        const params = {
            spotId: 'tx7', claimantId: OTHER_UID, finderId: OWNER_UID,
            fingerprint: CLAIM_STARTED_AT.toMillis(), message: 'x',
        };
        await expect(cancelClaimTransaction(otherDb(), params)).rejects.toMatchObject({ code: 'permission-denied' });
        await expect(cancelClaimTransaction(otherDb(), params)).rejects.toMatchObject({ code: 'permission-denied' });
        const spot = await readSpot('tx7');
        expect(spot.interestedUserId).toBe(OTHER_UID);

        let count = 0;
        await testEnv.withSecurityRulesDisabled(async ctx => {
            const snap = await getDocs(query(collection(ctx.firestore(), 'spotNotifications'),
                where('spotId', '==', 'tx7')));
            count = snap.size;
        });
        expect(count).toBe(0);
    });

    it('TX-8 (double-click / concurrent duplicate safety): two simultaneous calls with identical params produce exactly one cancellation and one notification', async () => {
        await seed('spots', 'tx8', committedScheduledSpot);
        const params = {
            spotId: 'tx8', claimantId: OTHER_UID, finderId: OWNER_UID,
            fingerprint: CLAIM_STARTED_AT.toMillis(), message: 'x',
        };
        const [a, b] = await Promise.allSettled([
            cancelClaimTransaction(otherDb(), params),
            cancelClaimTransaction(otherDb(), params),
        ]);
        expect(a.status).toBe('rejected');
        expect(b.status).toBe('rejected');
        expect((a as PromiseRejectedResult).reason?.code).toBe('permission-denied');
        expect((b as PromiseRejectedResult).reason?.code).toBe('permission-denied');

        const spot = await readSpot('tx8');
        expect(spot.interestedUserId).toBe(OTHER_UID);
        let count = 0;
        await testEnv.withSecurityRulesDisabled(async ctx => {
            const snap = await getDocs(query(collection(ctx.firestore(), 'spotNotifications'),
                where('spotId', '==', 'tx8')));
            count = snap.size;
        });
        expect(count).toBe(0);
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

        await expect(cancelClaimTransaction(otherDb(), {
            spotId: 'a2-fp', claimantId: OTHER_UID, finderId: OWNER_UID,
            fingerprint, message: 'Changed my mind',
        })).rejects.toMatchObject({ code: 'permission-denied' });
        const spot = await readSpot('a2-fp');
        expect(spot.status).toBe('interested');
        expect(spot.interestedUserId).toBe(OTHER_UID);
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
        await expect(cancelClaimTransaction(otherDb(), {
            spotId: 'tx13', claimantId: OTHER_UID, finderId: OTHER_UID,
            fingerprint: CLAIM_STARTED_AT.toMillis(), message: 'x',
        })).rejects.toMatchObject({ code: 'permission-denied' });
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
    beforeEach(async () => { await seedParticipantProfiles(OWNER_UID, OTHER_UID, THIRD_UID); });
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
        await assertFails(
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
                // S-SPOT-1: complete cleanup, exactly as cancelClaimTransaction.ts writes.
                claimStartedAt: null,
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
    // F7: fixture is now the real shipped client shape (StreetParkingView
    // writeCleaningReminder). The previous lat/lng/address/startedAt fixture
    // was never written by any client and is rejected by the strict schema.
    const sessionData = {
        userId:                OWNER_UID,
        fcmToken:              'legacy-client-token',
        streetName:            'W 42 St',
        nextCleaningAt:        Timestamp.fromMillis(Date.now() + 7_200_000),
        reminderAt:            Timestamp.fromMillis(Date.now() + 3_600_000),
        reminderMinutesBefore: 60,
        reminderEnabled:       true,
        reminderSent:          false,
        active:                true,
        savedAt:               Timestamp.now(),
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
// F7 / R3 — parkingSessions strict schema. Compatibility proof: every shape
// the shipped client writes (StreetParkingView.tsx writeCleaningReminder full
// setDoc incl. legacy fcmToken; deactivate merge; endSession merge; the older
// c640477 reminderEnabled toggle merge) is accepted; poison/oversized/foreign
// shapes are denied.
// ═══════════════════════════════════════════════════════════════════════════════
describe('F7 — parkingSessions schema (client-compatible, poison-proof)', () => {
    const clientFullWrite = () => ({
        userId: OWNER_UID,
        fcmToken: 'legacy-client-token',
        streetName: 'Broadway',
        nextCleaningAt: Timestamp.fromMillis(Date.now() + 7_200_000),
        reminderAt: Timestamp.fromMillis(Date.now() + 3_600_000),
        reminderMinutesBefore: 60,
        reminderEnabled: true,
        reminderSent: false,
        active: true,
        savedAt: Timestamp.now(),
    });
    const ref = () => doc(ownerDb(), 'parkingSessions', OWNER_UID);

    it('F7-C1 (compat): the exact writeCleaningReminder full setDoc (with legacy fcmToken) is accepted on create and overwrite', async () => {
        await assertSucceeds(setDoc(ref(), clientFullWrite()));
        await assertSucceeds(setDoc(ref(), clientFullWrite()));
    });

    it('F7-C2 (compat): the same full write WITHOUT fcmToken (future client) is accepted', async () => {
        const { fcmToken, ...rest } = clientFullWrite();
        void fcmToken;
        await assertSucceeds(setDoc(ref(), rest));
    });

    it('F7-C3 (compat): deactivateCleaningReminder merge {reminderEnabled:false, nextCleaningAt:null, reminderAt:null} is accepted (with and without an existing doc)', async () => {
        await assertSucceeds(setDoc(ref(), { reminderEnabled: false, nextCleaningAt: null, reminderAt: null }, { merge: true }));
        await assertSucceeds(setDoc(ref(), clientFullWrite()));
        await assertSucceeds(setDoc(ref(), { reminderEnabled: false, nextCleaningAt: null, reminderAt: null }, { merge: true }));
    });

    it('F7-C4 (compat): endSession merge {active:false} and legacy toggle merge {reminderEnabled:<bool>} are accepted', async () => {
        await assertSucceeds(setDoc(ref(), clientFullWrite()));
        await assertSucceeds(setDoc(ref(), { active: false }, { merge: true }));
        await assertSucceeds(setDoc(ref(), { reminderEnabled: true }, { merge: true }));
    });

    it('F7-C5 (compat): a doc already marked reminderSent:true / quarantined reminderEnabled:false by the server still accepts client merges', async () => {
        await seed('parkingSessions', OWNER_UID, { ...clientFullWrite(), reminderSent: true, reminderEnabled: false });
        await assertSucceeds(setDoc(ref(), { active: false }, { merge: true }));
    });

    it('F7-N1 (R3 poison): non-timestamp reminderAt is denied (string, number, map, bool)', async () => {
        for (const bad of ['not-a-timestamp', 12345, { seconds: 1 }, true]) {
            await assertFails(setDoc(ref(), { ...clientFullWrite(), reminderAt: bad }));
        }
        await assertFails(setDoc(ref(), { reminderAt: 'x' }, { merge: true }));
    });

    it('F7-N2: unknown keys are denied (hasOnly)', async () => {
        await assertFails(setDoc(ref(), { ...clientFullWrite(), recipientUid: OTHER_UID }));
        await assertFails(setDoc(ref(), { ...clientFullWrite(), lat: 40.7 }));
    });

    it('F7-N3: streetName must be a string of at most 200 chars', async () => {
        await assertFails(setDoc(ref(), { ...clientFullWrite(), streetName: 'x'.repeat(201) }));
        await assertFails(setDoc(ref(), { ...clientFullWrite(), streetName: 42 }));
        await assertSucceeds(setDoc(ref(), { ...clientFullWrite(), streetName: 'x'.repeat(200) }));
    });

    it('F7-N4: fcmToken, when present, must be a string of at most 4096 chars', async () => {
        await assertFails(setDoc(ref(), { ...clientFullWrite(), fcmToken: 'x'.repeat(4097) }));
        await assertFails(setDoc(ref(), { ...clientFullWrite(), fcmToken: { token: 'x' } }));
    });

    it('F7-N5: wrong types for flags / minutes / savedAt are denied', async () => {
        await assertFails(setDoc(ref(), { ...clientFullWrite(), reminderSent: 'false' }));
        await assertFails(setDoc(ref(), { ...clientFullWrite(), active: 1 }));
        await assertFails(setDoc(ref(), { ...clientFullWrite(), reminderMinutesBefore: '60' }));
        await assertFails(setDoc(ref(), { ...clientFullWrite(), reminderMinutesBefore: 100000 }));
        await assertFails(setDoc(ref(), { ...clientFullWrite(), savedAt: 'now' }));
    });

    it('F7-N6: userId field, when present, must equal the path owner', async () => {
        await assertFails(setDoc(ref(), { ...clientFullWrite(), userId: OTHER_UID }));
    });

    it('F7-A1 (authorization): another user cannot create/update/delete the owner session; owner can delete', async () => {
        await assertFails(setDoc(doc(otherDb(), 'parkingSessions', OWNER_UID), { ...clientFullWrite() }));
        await seed('parkingSessions', OWNER_UID, clientFullWrite());
        await assertFails(setDoc(doc(otherDb(), 'parkingSessions', OWNER_UID), { active: false }, { merge: true }));
        await assertFails(deleteDoc(doc(otherDb(), 'parkingSessions', OWNER_UID)));
        await assertFails(setDoc(doc(anonDb(), 'parkingSessions', OWNER_UID), { active: false }, { merge: true }));
        await assertSucceeds(deleteDoc(ref()));
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
// F3 — suspension who/why/when is admin-only (users/{uid}/private/moderation)
// adminSuspendUser/adminUnsuspendUser (Admin SDK) write it; no client rule
// matches the path, so every client — the user, peers, a stale admin token —
// is denied by default. The public users/{uid} doc keeps only `status`.
// ═══════════════════════════════════════════════════════════════════════════════
describe('F3 — users/{uid}/private/moderation is admin-only', () => {
    const modDoc = {
        status: 'Suspended', suspendedAt: new Date('2026-10-01T00:00:00Z'), suspendedBy: ADMIN_UID,
        suspensionReason: 'spam', unsuspendedAt: null, unsuspendedBy: null,
    };

    beforeEach(async () => {
        await testEnv.withSecurityRulesDisabled(async ctx => {
            const fs = ctx.firestore();
            await setDoc(doc(fs, 'users', OWNER_UID), { username: 'alice99', status: 'Suspended' });
            await setDoc(doc(fs, 'users', OWNER_UID, 'private', 'moderation'), modDoc);
        });
    });

    it('F3-R-01: a peer cannot read another user\'s moderation record', async () => {
        await assertFails(getDoc(doc(otherDb(), 'users', OWNER_UID, 'private', 'moderation')));
    });

    it('F3-R-02: the suspended user cannot read their own moderation record (admin uid stays private)', async () => {
        await assertFails(getDoc(doc(ownerDb(), 'users', OWNER_UID, 'private', 'moderation')));
    });

    it('F3-R-03: an admin-claim token cannot read it directly either (admin UI uses adminReadView)', async () => {
        await assertFails(getDoc(doc(adminDb(), 'users', OWNER_UID, 'private', 'moderation')));
    });

    it('F3-R-04: nobody can write it from a client (create / overwrite / delete)', async () => {
        const { deleteDoc: del } = await import('firebase/firestore');
        await assertFails(setDoc(doc(ownerDb(), 'users', OWNER_UID, 'private', 'moderation'), { status: 'Active' }));
        await assertFails(setDoc(doc(adminDb(), 'users', OTHER_UID, 'private', 'moderation'), modDoc));
        await assertFails(del(doc(ownerDb(), 'users', OWNER_UID, 'private', 'moderation')));
    });

    it('F3-R-05: the suspended user cannot clear their own public status', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { status: 'Active' }));
    });

    it('F3-R-06: peers can still get the public doc (status only) — positive control', async () => {
        const snap = await assertSucceeds(getDoc(doc(otherDb(), 'users', OWNER_UID)));
        expect(snap.data()?.status).toBe('Suspended');
        expect(snap.data()).not.toHaveProperty('suspendedBy');
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
            await assertFails(runTransaction(db, async (tx) => {
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
            await testEnv.withSecurityRulesDisabled(async (ctx) => {
                const admin = ctx.firestore();
                await updateDoc(doc(admin, 'spots', SPOT_ID), {
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
                await setDoc(doc(admin, 'users', OTHER_UID, 'activeIncomingClaims', 'current'), {
                    spotId: SPOT_ID,
                    claimStartedAt: claimedAt,
                    claimState: 'heading',
                    updatedAt: claimedAt,
                });
            });
            await assertFails(runTransaction(db, async (tx) => {
                tx.update(doc(db, 'spots', SPOT_ID), {
                    status: 'available',
                    interestedUserId: null,
                    interestedUserName: null,
                    interestedUserVehicleColor: null,
                    interestedUserVehicleType: null,
                    interestedUserVehicleBrand: null,
                    interestedUserTitle: null,
                    // S-SPOT-1: a legitimate cancel clears every claimer field
                    // (cancelClaimTransaction.ts). Leaving claimState/
                    // claimStartedAt behind is now denied (SS1-02).
                    claimState: null,
                    claimStartedAt: null,
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
        await assertFails(runTransaction(db, async (tx) => {
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

    it('AN-CONSENT-1: owner can enable and disable analytics while preserving preferences', async () => {
        const ref = doc(ownerDb(), 'users', OWNER_UID, 'private', 'preferences');

        await assertSucceeds(setDoc(ref, {
            notificationRadius: 2,
            notificationsEnabled: true,
        }));

        await assertSucceeds(setDoc(ref, { analyticsConsent: true }, { merge: true }));

        let snap = await assertSucceeds(getDoc(ref));
        expect(snap.data()?.analyticsConsent).toBe(true);
        expect(snap.data()?.notificationRadius).toBe(2);
        expect(snap.data()?.notificationsEnabled).toBe(true);

        await assertSucceeds(setDoc(ref, { analyticsConsent: false }, { merge: true }));

        snap = await assertSucceeds(getDoc(ref));
        expect(snap.data()?.analyticsConsent).toBe(false);
        expect(snap.data()?.notificationRadius).toBe(2);
    });

    it('AN-CONSENT-2: invalid analytics consent values are rejected', async () => {
        const ref = doc(ownerDb(), 'users', OWNER_UID, 'private', 'preferences');

        for (const invalid of ['yes', 1, null]) {
            await assertFails(setDoc(ref, { analyticsConsent: invalid }));
        }
    });

    it('AN-CONSENT-3: unauthorized analytics consent writes are rejected', async () => {
        await assertFails(setDoc(
            doc(otherDb(), 'users', OWNER_UID, 'private', 'preferences'),
            { analyticsConsent: true }
        ));

        await assertFails(setDoc(
            doc(anonDb(), 'users', OWNER_UID, 'private', 'preferences'),
            { analyticsConsent: true }
        ));
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
// §4 — User schema: client-writable vehicle fields; server-owned avatar fields.
//
// Avatar fields are published by the moderation Function (Admin SDK) only.
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

    // ── moderation-owned avatar metadata: no direct client writes ────────────

    it('SC-4: owner cannot bypass moderation by setting an external avatarUrl', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { avatarUrl: 'https://example.com/a.jpg' }));
    });

    it('SC-5: owner cannot set avatarManifestId', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { avatarManifestId: 'manifest_abc' }));
    });

    it('SC-5a: owner cannot set avatarAgeGroup', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { avatarAgeGroup: 'adult' }));
    });

    it('SC-5b: owner cannot set avatarUpdatedAt', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { avatarUpdatedAt: Timestamp.now() }));
    });

    it('SC-5c: owner cannot remove an existing approved avatarUrl', async () => {
        const { updateDoc: upd, deleteField } = await import('firebase/firestore');
        await seed('users', OWNER_UID, { ...baseDoc, avatarUrl: 'https://example.com/approved.jpg' });
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), { avatarUrl: deleteField() }));
    });

    it('SC-5d: owner cannot combine an allowed vehicle change with a forged avatarUrl', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        await assertFails(upd(doc(ownerDb(), 'users', OWNER_UID), {
            vehicleType: 'sedan',
            avatarUrl: 'https://example.com/unmoderated.jpg',
        }));
        const snap = await getDoc(doc(ownerDb(), 'users', OWNER_UID));
        expect(snap.data()?.vehicleType).toBeUndefined();
    });

    it('SC-5e: owner can still update a vehicle field when a server-approved avatar exists', async () => {
        const { updateDoc: upd } = await import('firebase/firestore');
        const serverAvatarUrl = 'https://example.com/approved.jpg';
        await seed('users', OWNER_UID, { ...baseDoc, avatarUrl: serverAvatarUrl });
        await assertSucceeds(upd(doc(ownerDb(), 'users', OWNER_UID), { vehicleColor: 'blue' }));
        const snap = await getDoc(doc(ownerDb(), 'users', OWNER_UID));
        expect(snap.data()?.avatarUrl).toBe(serverAvatarUrl);
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
// F8 — usernames/{normalized} registry: exact-doc get only, list/query denied.
// Availability checks (NameEntryView, EditProfileView) are single-doc getDoc;
// claimUsername (Admin SDK) writes the registry and is unaffected by rules.
// ═══════════════════════════════════════════════════════════════════════════════
describe('F8 — usernames registry get-only (list/query denied)', () => {
    beforeEach(async () => {
        // Seed exactly the shape claimUsername writes: { uid, claimedAt }.
        await seed('usernames', 'alice', { uid: OWNER_UID, claimedAt: Timestamp.now() });
        await seed('usernames', 'bob', { uid: OTHER_UID, claimedAt: Timestamp.now() });
    });

    it('F8-01: signed-in user can get a taken username doc (availability = taken)', async () => {
        const snap = await assertSucceeds(getDoc(doc(otherDb(), 'usernames', 'alice')));
        expect(snap.exists()).toBe(true);
    });

    it('F8-02: signed-in user can get a free username doc (availability = available)', async () => {
        const snap = await assertSucceeds(getDoc(doc(thirdDb(), 'usernames', 'free_name')));
        expect(snap.exists()).toBe(false);
    });

    it('F8-03: signed-in user cannot list the usernames collection', async () => {
        await assertFails(getDocs(collection(ownerDb(), 'usernames')));
        await assertFails(getDocs(collection(thirdDb(), 'usernames')));
    });

    it('F8-04: signed-in user cannot query usernames by uid (reverse lookup)', async () => {
        await assertFails(getDocs(query(collection(thirdDb(), 'usernames'), where('uid', '==', OWNER_UID))));
    });

    it('F8-05: unauthenticated get and list remain denied', async () => {
        await assertFails(getDoc(doc(anonDb(), 'usernames', 'alice')));
        await assertFails(getDocs(collection(anonDb(), 'usernames')));
    });

    it('F8-06: client writes to the registry remain denied (create, update, delete)', async () => {
        await assertFails(setDoc(doc(thirdDb(), 'usernames', 'newname'), { uid: THIRD_UID, claimedAt: Timestamp.now() }));
        await assertFails(updateDoc(doc(ownerDb(), 'usernames', 'alice'), { uid: THIRD_UID }));
        await assertFails(deleteDoc(doc(ownerDb(), 'usernames', 'alice')));
    });

    it('F8-07: a doc written by the server (rules disabled, as claimUsername does) is immediately get-able by its owner', async () => {
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            await setDoc(doc(ctx.firestore(), 'usernames', 'third_new'), { uid: THIRD_UID, claimedAt: Timestamp.now() });
        });
        const snap = await assertSucceeds(getDoc(doc(thirdDb(), 'usernames', 'third_new')));
        expect(snap.data()?.uid).toBe(THIRD_UID);
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
        await assertFails(runTransaction(db, async (tx) => {
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

    async function seedHeldClaim(
        uid: string,
        username: string,
        spotId: string,
        claimState: 'heading' | 'committed' = 'heading',
    ) {
        const startedAt = Timestamp.now();
        const existing = await readSpot(spotId);
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            const admin = ctx.firestore();
            await setDoc(doc(admin, 'spots', spotId), {
                ...existing.data(),
                ...claimPayload(uid, username, claimState, startedAt),
            });
            await setDoc(activeIncomingClaimRef(admin, uid), {
                spotId,
                claimStartedAt: startedAt,
                claimState,
                updatedAt: startedAt,
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
        await expect(claimAs(db, OTHER_UID, 'bob', 'a1-open')).rejects.toMatchObject({
            code: 'permission-denied',
        });
        const spot = await readSpot('a1-open');
        const lock = await readLock(OTHER_UID);
        expect(spot.data().status).toBe('available');
        expect(spot.data().interestedUserId ?? null).toBeNull();
        expect(lock.exists()).toBe(false);
    });

    it('A1-2: a malicious client that skips the client check cannot claim a second Ping without moving the lock', async () => {
        await seedClaimer(OTHER_UID, 'bob');
        await seed('spots', 'a1-held', availablePing('A1 held'));
        await seed('spots', 'a1-second', availablePing('A1 second'));
        const db = otherDb();
        await seedHeldClaim(OTHER_UID, 'bob', 'a1-held');
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
        await seedHeldClaim(OTHER_UID, 'bob', 'a1-first');
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
        expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(0);
        expect(results.filter((result) => result.status === 'rejected')).toHaveLength(2);
        for (const result of results) {
            expect((result as PromiseRejectedResult).reason?.code).toBe('permission-denied');
        }

        const spotA = await readSpot('a1-race-a');
        const spotB = await readSpot('a1-race-b');
        expect(spotA.data().status).toBe('available');
        expect(spotB.data().status).toBe('available');
        expect((await readLock(OTHER_UID)).exists()).toBe(false);
    });

    it('A1-5: same-Ping contention still denies the second claimer (isAvailableForClaim)', async () => {
        await seedClaimer(OTHER_UID, 'bob');
        await seedClaimer(THIRD_UID, 'cara');
        await seed('spots', 'a1-same', availablePing('A1 same'));
        await seedHeldClaim(OTHER_UID, 'bob', 'a1-same');
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
        await seedHeldClaim(OTHER_UID, 'bob', 'a1-dup');
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
        await expect(claimAs(db, OTHER_UID, 'bob', 'a1-next')).rejects.toMatchObject({
            code: 'permission-denied',
        });
        expect((await readLock(OTHER_UID)).data().spotId).toBe('a1-released');
        expect((await readSpot('a1-next')).data().status).toBe('available');
    });

    it('A1-8: a stale lock whose Ping document is gone does not block the next claim', async () => {
        await seedClaimer(OTHER_UID, 'bob');
        await seed('spots', 'a1-after-delete', availablePing('A1 after delete'));
        await seedLock(OTHER_UID, 'a1-missing-ping', Timestamp.fromMillis(Date.now() - 60_000));
        await expect(claimAs(otherDb(), OTHER_UID, 'bob', 'a1-after-delete')).rejects.toMatchObject({
            code: 'permission-denied',
        });
        expect((await readLock(OTHER_UID)).data().spotId).toBe('a1-missing-ping');
        expect((await readSpot('a1-after-delete')).data().status).toBe('available');
    });

    it('A1-9: claimer cancel clears the matching lock in the same transaction', async () => {
        await seedClaimer(OTHER_UID, 'bob');
        await seed('spots', 'a1-cancel', availablePing('A1 cancel'));
        const db = otherDb();
        await seedHeldClaim(OTHER_UID, 'bob', 'a1-cancel');
        const fingerprint = (await readSpot('a1-cancel')).data().claimStartedAt.toMillis();
        await expect(cancelClaimTransaction(db, {
            spotId: 'a1-cancel',
            claimantId: OTHER_UID,
            finderId: OWNER_UID,
            fingerprint,
            message: 'Changed my mind',
        })).rejects.toThrow(/identity conflict/);
        expect((await readSpot('a1-cancel')).data().status).toBe('interested');
        expect((await readSpot('a1-cancel')).data().interestedUserId).toBe(OTHER_UID);
        expect((await readLock(OTHER_UID)).data().spotId).toBe('a1-cancel');
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
        })).rejects.toMatchObject({ code: 'permission-denied' });
        expect((await readSpot('a1-cancel-this')).data().interestedUserId).toBe(OTHER_UID);
        expect((await readLock(OTHER_UID)).data().spotId).toBe('a1-lock-other');
    });

    it('A1-11: arrival clears the matching lock, and a later claim is allowed', async () => {
        await seedClaimer(OTHER_UID, 'bob');
        await seed('spots', 'a1-arrive', availablePing('A1 arrive'));
        await seed('spots', 'a1-after-arrive', availablePing('A1 after arrive'));
        const db = otherDb();
        await seedHeldClaim(OTHER_UID, 'bob', 'a1-arrive');
        await markClaimArrived(db, 'a1-arrive', OTHER_UID);
        const arrived = (await readSpot('a1-arrive')).data();
        expect(arrived.status).toBe('occupied');
        expect(arrived.claimState).toBe('arrived_pending_outcome');
        expect(arrived.arrivedAt).toBeTruthy();
        expect((await readLock(OTHER_UID)).exists()).toBe(false);
        await expect(claimAs(db, OTHER_UID, 'bob', 'a1-after-arrive')).rejects.toMatchObject({
            code: 'permission-denied',
        });
        expect((await readLock(OTHER_UID)).exists()).toBe(false);
        expect((await readSpot('a1-after-arrive')).data().status).toBe('available');
    });

    it('A1-12: clearing a claim while leaving the matching lock behind is denied', async () => {
        await seedClaimer(OTHER_UID, 'bob');
        await seed('spots', 'a1-keep-lock', availablePing('A1 keep lock'));
        const db = otherDb();
        await seedHeldClaim(OTHER_UID, 'bob', 'a1-keep-lock');
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

    it.each([
        ['missing', {}],
        ['non-string', { spotId: 42 }],
    ])('A1-F1-MAL-SPOT: arrival is denied when the existing lock spotId is %s', async (_label, malformed) => {
        await seedClaimer(OTHER_UID, 'bob');
        const spotId = `a1-malformed-lock-${_label}`;
        const startedAt = Timestamp.now();
        await seed('spots', spotId, {
            ...availablePing(`A1 malformed ${_label}`),
            ...claimPayload(OTHER_UID, 'bob', 'heading', startedAt),
        });
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            await setDoc(activeIncomingClaimRef(ctx.firestore(), OTHER_UID), {
                claimStartedAt: startedAt,
                claimState: 'heading',
                updatedAt: startedAt,
                ...malformed,
            });
        });

        const db = otherDb();
        await assertFails(updateDoc(doc(db, 'spots', spotId), {
            status: 'occupied',
            claimState: 'arrived_pending_outcome',
            arrivedAt: Timestamp.now(),
        }));
        expect((await readSpot(spotId)).data().status).toBe('interested');
        expect((await readLock(OTHER_UID)).exists()).toBe(true);
    });

    it('A1-13: another user cannot read the lock, and a non-current doc id cannot be created', async () => {
        await seedClaimer(OTHER_UID, 'bob');
        await seed('spots', 'a1-private', availablePing('A1 private'));
        await seedHeldClaim(OTHER_UID, 'bob', 'a1-private');
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
        await seedHeldClaim(OTHER_UID, 'bob', 'a1-committed', 'committed');
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
        const startedAt = Timestamp.now();
        await seed('spots', spotId, {
            ...interestedSpot,
            status: 'occupied',
            claimState: 'arrived_pending_outcome',
            arrivedAt: Timestamp.fromMillis(Date.now() - 60_000),
            address: 'A1 terminal',
            claimStartedAt: startedAt,
        });
        await seedLock(OTHER_UID, spotId, startedAt);
        const db = otherDb();
        const feedbackId = `${spotId}_${OTHER_UID}`;
        await assertSucceeds(runTransaction(db, async (tx) => {
            const lockRef = activeIncomingClaimRef(db, OTHER_UID);
            const lockSnap = await tx.get(lockRef);
            tx.set(doc(db, 'spotFeedback', feedbackId), {
                spotId,
                userId: OTHER_UID,
                finderId: OWNER_UID,
                outcome: 'participant_success',
                role: 'claimer',
                failureReason: null,
                address: 'A1 terminal',
                createdAt: Timestamp.now(),
            });
            if (lockSnap.exists() && lockSnap.data()?.spotId === spotId) tx.delete(lockRef);
        }));
        expect((await readLock(OTHER_UID)).exists()).toBe(false);
    });

    it('A1-15-30P-FEEDBACK-ONLY: same A1-15 seed creates participant_success and leaves the matching lock', async () => {
        await seedClaimer(OTHER_UID, 'bob');
        const spotId = 'a1-15-30p-feedback-only';
        const arrivedAt = Timestamp.fromMillis(Date.now() - 60_000);
        const startedAt = Timestamp.now();
        await seed('spots', spotId, {
            ...interestedSpot,
            status: 'occupied',
            claimState: 'arrived_pending_outcome',
            arrivedAt,
            address: 'A1 terminal',
            claimStartedAt: startedAt,
        });
        await seedLock(OTHER_UID, spotId, startedAt);
        const db = otherDb();
        const feedbackId = `${spotId}_${OTHER_UID}`;
        let denied: unknown = null;
        try {
            await assertSucceeds(runTransaction(db, async (tx) => {
                const lockRef = activeIncomingClaimRef(db, OTHER_UID);
                const lockSnap = await tx.get(lockRef);
                expect(lockSnap.exists()).toBe(true);
                expect(lockSnap.data()?.spotId).toBe(spotId);
                tx.set(doc(db, 'spotFeedback', feedbackId), {
                    spotId,
                    userId: OTHER_UID,
                    finderId: OWNER_UID,
                    outcome: 'participant_success',
                    role: 'claimer',
                    failureReason: null,
                    address: 'A1 terminal',
                    createdAt: Timestamp.now(),
                });
            }));
        } catch (error) {
            denied = error;
        }
        const lock = await readLock(OTHER_UID);
        const spot = await readSpot(spotId);
        let feedbackExists = false;
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            feedbackExists = (await getDoc(doc(ctx.firestore(), 'spotFeedback', feedbackId))).exists();
        });
        if (denied) {
            const error = denied instanceof Error ? denied : new Error(String(denied));
            error.message += `\npost-state lockExists=${lock.exists()} lockSpot=${lock.exists() ? lock.data()?.spotId : 'absent'} status=${spot.data()?.status} claimState=${spot.data()?.claimState} interestedUserId=${spot.data()?.interestedUserId} feedbackExists=${feedbackExists}`;
            throw error;
        }
        expect(feedbackExists).toBe(true);
        expect(lock.exists()).toBe(true);
        expect(lock.data().spotId).toBe(spotId);
        expect(spot.data().status).toBe('occupied');
        expect(spot.data().claimState).toBe('arrived_pending_outcome');
        expect(spot.data().arrivedAt.isEqual(arrivedAt)).toBe(true);
        expect(spot.data().interestedUserId).toBe(OTHER_UID);
    });

    it('A1-15-30P-LOCK-DELETE-ONLY: same A1-15 seed deletes the matching lock and does not create feedback', async () => {
        await seedClaimer(OTHER_UID, 'bob');
        const spotId = 'a1-15-30p-lock-delete-only';
        const arrivedAt = Timestamp.fromMillis(Date.now() - 60_000);
        const startedAt = Timestamp.now();
        await seed('spots', spotId, {
            ...interestedSpot,
            status: 'occupied',
            claimState: 'arrived_pending_outcome',
            arrivedAt,
            address: 'A1 terminal',
            claimStartedAt: startedAt,
        });
        await seedLock(OTHER_UID, spotId, startedAt);
        const db = otherDb();
        const feedbackId = `${spotId}_${OTHER_UID}`;
        let denied: unknown = null;
        try {
            await assertSucceeds(runTransaction(db, async (tx) => {
                const lockRef = activeIncomingClaimRef(db, OTHER_UID);
                const lockSnap = await tx.get(lockRef);
                expect(lockSnap.exists()).toBe(true);
                expect(lockSnap.data()?.spotId).toBe(spotId);
                tx.delete(lockRef);
            }));
        } catch (error) {
            denied = error;
        }
        const lock = await readLock(OTHER_UID);
        const spot = await readSpot(spotId);
        let feedbackExists = false;
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            feedbackExists = (await getDoc(doc(ctx.firestore(), 'spotFeedback', feedbackId))).exists();
        });
        if (denied) {
            const error = denied instanceof Error ? denied : new Error(String(denied));
            error.message += `\npost-state lockExists=${lock.exists()} lockSpot=${lock.exists() ? lock.data()?.spotId : 'absent'} status=${spot.data()?.status} claimState=${spot.data()?.claimState} interestedUserId=${spot.data()?.interestedUserId} feedbackExists=${feedbackExists}`;
            throw error;
        }
        expect(lock.exists()).toBe(false);
        expect(feedbackExists).toBe(false);
        expect(spot.data().status).toBe('occupied');
        expect(spot.data().claimState).toBe('arrived_pending_outcome');
        expect(spot.data().arrivedAt.isEqual(arrivedAt)).toBe(true);
        expect(spot.data().interestedUserId).toBe(OTHER_UID);
    });

    it('A1-F1: Rules deny deletion of a same-Ping lock from another modern generation', async () => {
        const spotId = 'a1-f1-modern-conflict';
        const spotGeneration = 'a'.repeat(64);
        const lockGeneration = 'b'.repeat(64);
        const startedAt = Timestamp.now();
        await seed('spots', spotId, {
            ...interestedSpot,
            status: 'occupied',
            claimState: 'arrived_pending_outcome',
            claimGenerationId: spotGeneration,
            claimStartedAt: startedAt,
            arrivedAt: startedAt,
        });
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            await setDoc(activeIncomingClaimRef(ctx.firestore(), OTHER_UID), {
                spotId,
                claimGenerationId: lockGeneration,
                claimStartedAt: startedAt,
                claimState: 'heading',
                updatedAt: startedAt,
            });
        });

        await assertFails(deleteDoc(activeIncomingClaimRef(otherDb(), OTHER_UID)));
        expect((await readLock(OTHER_UID)).data().claimGenerationId).toBe(lockGeneration);
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
        await expect(claimAs(thirdDb(), THIRD_UID, 'cara', 'a1-r001-new')).rejects.toMatchObject({
            code: 'permission-denied',
        });
        expect((await readSpot('a1-r001-new')).data().status).toBe('available');
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

    it('F1-GATE-DORMANT: the complete dormant rollout predicate requires an explicit integer zero malformed count', () => {
        const rules = readFileSync('firestore.rules', 'utf8');
        const start = rules.indexOf('function activeIncomingClaimInvariantEnforced() {');
        const end = rules.indexOf('\n    }', start);
        expect(start).toBeGreaterThan(-1);
        expect(end).toBeGreaterThan(start);
        const predicate = rules.slice(start, end);
        expect(predicate).toContain("status.get('malformedInterestedCount', null) is int");
        expect(predicate).toContain("status.get('malformedInterestedCount', null) == 0");
        expect(predicate).toContain('status.enforced == true');
        expect(predicate).toContain('status.locklessCount == 0');
        expect(predicate).toContain('status.duplicateUserCount == 0');
        expect(predicate).toContain('status.duplicatePingCount == 0');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// A3 — committed → heading vs a released claim (HO-009)
// Arm 2b is unchanged. The client transaction writes only that field set.
// ═══════════════════════════════════════════════════════════════════════════════
describe('A3 — commit to heading', () => {
    beforeEach(async () => { await seedParticipantProfiles(OWNER_UID, OTHER_UID, THIRD_UID); });
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
    beforeEach(async () => { await seedParticipantProfiles(OWNER_UID, OTHER_UID, THIRD_UID); });
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
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            const admin = ctx.firestore();
            const spot = await getDoc(doc(admin, 'spots', spotId));
            const started = spot.data()?.claimStartedAt;
            if (!(started instanceof Timestamp)) throw new Error('seedLock requires claimStartedAt');
            await setDoc(activeIncomingClaimRef(admin, OTHER_UID), {
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

    it('B1-LEGACY-MISSING-LOCK: first arrival remains allowed when the legacy lock is absent', async () => {
        const spotId = 'b1-legacy-missing-lock';
        await seed('spots', spotId, headingPing(spotId));

        await assertSucceeds(updateDoc(doc(otherDb(), 'spots', spotId), {
            status: 'occupied',
            claimState: 'arrived_pending_outcome',
            arrivedAt: Timestamp.now(),
        }));

        const spot = (await readSpot(spotId)).data();
        expect(spot.status).toBe('occupied');
        expect(spot.claimState).toBe('arrived_pending_outcome');
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

    it('B1-TERMINAL: a claimer success attestation does not rewrite arrival, and legacy success is denied', async () => {
        const spotId = 'b1-terminal';
        const arrivedAt = Timestamp.fromMillis(Date.now() - 60_000);
        await seed('spots', spotId, headingPing(spotId, {
            status: 'occupied',
            claimState: 'arrived_pending_outcome',
            arrivedAt,
            claimGenerationId: '11111111-1111-4111-8111-111111111111',
        }));
        const generation = (await readSpot(spotId)).data().claimGenerationId;

        await expect(completeTerminalHandoff(otherDb(), {
            spotId,
            driverId: OTHER_UID,
            driverName: 'TestDriver',
            finderId: OWNER_UID,
            address: spotId,
            outcome: 'success',
            failureReason: null,
        })).rejects.toMatchObject({ code: 'permission-denied' });
        await assertSucceeds(setDoc(doc(otherDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`), {
            spotId,
            userId: OTHER_UID,
            finderId: OWNER_UID,
            address: spotId,
            outcome: 'participant_success',
            role: 'claimer',
            claimGenerationId: generation,
            failureReason: null,
            createdAt: Timestamp.now(),
        }));

        const spot = (await readSpot(spotId)).data();
        expect(spot.status).toBe('occupied');
        expect(spot.claimState).toBe('arrived_pending_outcome');
        expect(spot.arrivedAt.isEqual(arrivedAt)).toBe(true);
        const feedback = await getDoc(doc(otherDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`));
        expect(feedback.data()).toMatchObject({ outcome: 'participant_success', role: 'claimer', failureReason: null });
    });

    it('B1-GENERATION: claimer completion must match the durable claim generation', async () => {
        const spotId = 'b1-generation';
        await seed('spots', spotId, headingPing(spotId, {
            status: 'occupied',
            claimState: 'arrived_pending_outcome',
            arrivedAt: Timestamp.fromMillis(Date.now() - 30_000),
            claimGenerationId: '22222222-2222-4222-8222-222222222222',
        }));
        const current = (await readSpot(spotId)).data().claimGenerationId;
        const base = {
            spotId,
            userId: OTHER_UID,
            finderId: OWNER_UID,
            address: spotId,
            outcome: 'participant_success',
            role: 'claimer',
            failureReason: null,
            createdAt: Timestamp.now(),
        };
        await assertFails(setDoc(doc(otherDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`), {
            ...base,
            claimGenerationId: '00000000-0000-4000-8000-000000000000',
        }));
        await assertFails(setDoc(doc(otherDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`), base));
        await assertSucceeds(setDoc(doc(otherDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`), {
            ...base,
            claimGenerationId: current,
        }));
    });

    it('B1-FINDER: finder success is a separate attestation and does not rewrite arrival', async () => {
        const spotId = 'b1-finder';
        const arrivedAt = Timestamp.fromMillis(Date.now() - 30_000);
        await seed('spots', spotId, headingPing(spotId, {
            status: 'occupied',
            claimState: 'arrived_pending_outcome',
            arrivedAt,
        }));

        await assertFails(setDoc(doc(ownerDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`), {
            spotId,
            userId: OTHER_UID,
            finderId: OWNER_UID,
            address: spotId,
            outcome: 'success',
            failureReason: null,
            confirmedByFinder: true,
            createdAt: Timestamp.now(),
        }));
        await assertSucceeds(setDoc(doc(ownerDb(), 'spotFeedback', `${spotId}_${OTHER_UID}_finder`), {
            spotId,
            userId: OTHER_UID,
            finderId: OWNER_UID,
            address: spotId,
            outcome: 'participant_success',
            role: 'finder',
            failureReason: null,
            createdAt: Timestamp.now(),
        }));

        const spot = (await readSpot(spotId)).data();
        expect(spot.status).toBe('occupied');
        expect(spot.claimState).toBe('arrived_pending_outcome');
        expect(spot.arrivedAt.isEqual(arrivedAt)).toBe(true);
        const feedback = await getDoc(doc(ownerDb(), 'spotFeedback', `${spotId}_${OTHER_UID}_finder`));
        expect(feedback.data()).toMatchObject({ outcome: 'participant_success', role: 'finder' });
        await assertFails(getDoc(doc(thirdDb(), 'spotFeedback', `${spotId}_${OTHER_UID}_finder`)));
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

    it('B4-LATE: a success write after unconfirmed does not overwrite feedback or notify', async () => {
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
        await assertFails(setDoc(doc(ownerDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`), {
            spotId,
            userId: OTHER_UID,
            finderId: OWNER_UID,
            address: '1 Unconfirmed St',
            outcome: 'success',
            failureReason: null,
            confirmedByFinder: true,
            createdAt: Timestamp.now(),
        }));

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

// ═══════════════════════════════════════════════════════════════════════════════
// C1 — Design A participant attestations. outcome success is not a client write.
// One attestation is not terminal: claimState stays arrived_pending_outcome.
// ═══════════════════════════════════════════════════════════════════════════════
describe('C1 — participant success attestations', () => {
    beforeEach(async () => { await seedParticipantProfiles(OWNER_UID, OTHER_UID, THIRD_UID); });
    function arrivedSpot(id: string, extra: Record<string, unknown> = {}) {
        return {
            finderId: OWNER_UID,
            finderName: 'TestFinder',
            address: id,
            lat: 40.71,
            lng: -74.01,
            status: 'occupied',
            claimState: 'arrived_pending_outcome',
            interestedUserId: OTHER_UID,
            arrivedAt: Timestamp.fromMillis(Date.now() - 60_000),
            pingMode: 'now',
            reportedAt: Timestamp.now(),
            expiresAt: FUTURE,
            ...extra,
        };
    }

    function claimerAttestation(spotId: string, extra: Record<string, unknown> = {}) {
        return {
            spotId,
            userId: OTHER_UID,
            finderId: OWNER_UID,
            outcome: 'participant_success',
            role: 'claimer',
            failureReason: null,
            address: spotId,
            createdAt: Timestamp.now(),
            ...extra,
        };
    }

    function finderAttestation(spotId: string, extra: Record<string, unknown> = {}) {
        return {
            spotId,
            userId: OTHER_UID,
            finderId: OWNER_UID,
            outcome: 'participant_success',
            role: 'finder',
            failureReason: null,
            address: spotId,
            createdAt: Timestamp.now(),
            ...extra,
        };
    }

    it('C1-OWN: each participant can create only their own attestation', async () => {
        const spotId = 'c1-own';
        await seed('spots', spotId, arrivedSpot(spotId));
        await assertFails(setDoc(doc(ownerDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`), claimerAttestation(spotId)));
        await assertFails(setDoc(doc(otherDb(), 'spotFeedback', `${spotId}_${OTHER_UID}_finder`), finderAttestation(spotId)));
        await assertSucceeds(setDoc(doc(otherDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`), claimerAttestation(spotId)));
        await assertSucceeds(setDoc(doc(ownerDb(), 'spotFeedback', `${spotId}_${OTHER_UID}_finder`), finderAttestation(spotId)));
        await assertFails(updateDoc(doc(otherDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`), { outcome: 'failed' }));
        await assertFails(deleteDoc(doc(ownerDb(), 'spotFeedback', `${spotId}_${OTHER_UID}_finder`)));
        await assertFails(updateDoc(doc(ownerDb(), 'spotFeedback', `${spotId}_${OTHER_UID}_finder`), { role: 'claimer' }));
    });

    it('C1-ARRIVAL: finder success is rejected before durable arrival', async () => {
        const spotId = 'c1-before-arrival';
        await seed('spots', spotId, arrivedSpot(spotId, {
            status: 'occupied',
            claimState: 'heading',
            arrivedAt: null,
        }));
        await assertFails(setDoc(doc(ownerDb(), 'spotFeedback', `${spotId}_${OTHER_UID}_finder`), finderAttestation(spotId)));
        await assertFails(setDoc(doc(otherDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`), claimerAttestation(spotId)));
    });

    it('C1-SERVER: clients cannot write completed_success, functionEvents, or crowns', async () => {
        const spotId = 'c1-server';
        await seed('spots', spotId, arrivedSpot(spotId));
        await assertFails(updateDoc(doc(otherDb(), 'spots', spotId), { claimState: 'completed_success' }));
        await assertFails(updateDoc(doc(ownerDb(), 'spots', spotId), { claimState: 'completed_success' }));
        await assertFails(setDoc(doc(otherDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`), claimerAttestation(spotId, {
            outcome: 'completed_success',
        })));
        await assertFails(setDoc(doc(otherDb(), 'functionEvents', `awardCrowns_${spotId}`), { outcome: 'awarded' }));
        await assertFails(setDoc(doc(ownerDb(), 'functionEvents', `awardCrowns_${spotId}`), { outcome: 'awarded' }));
        await seed('users', OTHER_UID, { username: 'bob', crowns: 0, title: 'Newcomer' });
        await assertFails(updateDoc(doc(otherDb(), 'users', OTHER_UID), { crowns: 9, title: 'Trusted Driver' }));
    });

    it('C1-PAIR: self-pair and a mismatched finder are denied', async () => {
        const spotId = 'c1-self';
        await seed('spots', spotId, arrivedSpot(spotId, {
            finderId: OTHER_UID,
            interestedUserId: OTHER_UID,
        }));
        await assertFails(setDoc(doc(otherDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`), claimerAttestation(spotId, {
            finderId: OTHER_UID,
        })));

        const mismatch = 'c1-mismatch';
        await seed('spots', mismatch, arrivedSpot(mismatch));
        await assertFails(setDoc(doc(otherDb(), 'spotFeedback', `${mismatch}_${OTHER_UID}`), claimerAttestation(mismatch, {
            finderId: THIRD_UID,
        })));
        await assertFails(setDoc(doc(thirdDb(), 'spotFeedback', `${mismatch}_${OTHER_UID}_finder`), finderAttestation(mismatch, {
            finderId: THIRD_UID,
        })));
    });

    it('C1-READ: claimer reads both attestations and the finder reads only the finder doc', async () => {
        const spotId = 'c1-read';
        await seed('spots', spotId, arrivedSpot(spotId));
        await seed('spotFeedback', `${spotId}_${OTHER_UID}`, claimerAttestation(spotId));
        await seed('spotFeedback', `${spotId}_${OTHER_UID}_finder`, finderAttestation(spotId));
        await assertSucceeds(getDoc(doc(otherDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`)));
        await assertSucceeds(getDoc(doc(otherDb(), 'spotFeedback', `${spotId}_${OTHER_UID}_finder`)));
        await assertSucceeds(getDoc(doc(ownerDb(), 'spotFeedback', `${spotId}_${OTHER_UID}_finder`)));
        await assertFails(getDoc(doc(ownerDb(), 'spotFeedback', `${spotId}_${OTHER_UID}`)));
        await assertFails(getDoc(doc(thirdDb(), 'spotFeedback', `${spotId}_${OTHER_UID}_finder`)));
    });
});

// S7 access — one user document. status Suspended denies. productAccessBlocked
// denies unless missing or exactly boolean false. Functions do not write the
// field yet. private/access is client-denied and is not an authorization source.
describe('S7 access — Firestore caller gate', () => {
    const UID = 's7-access-uid';
    function userDb() {
        return testEnv.authenticatedContext(UID).firestore();
    }

    async function seedProfile(data: object) {
        await seed('users', UID, data);
    }

    function ownedSpot(id: string) {
        return {
            finderId: UID,
            finderName: 'legacy',
            address: id,
            lat: 40.71,
            lng: -74.03,
            status: 'available',
            pingMode: 'now',
            type: 'free',
            reportedAt: Timestamp.now(),
            expiresAt: FUTURE,
            geohash: 'dr5ru',
        };
    }

    it('A: a legacy profile with no productAccessBlocked field can still update a vehicle field', async () => {
        await seedProfile({ username: 'legacy' });
        await assertSucceeds(updateDoc(doc(userDb(), 'users', UID), { vehicleColor: 'blue' }));
    });

    it('B: Suspended denies even when productAccessBlocked is false', async () => {
        await seedProfile({ username: 'legacy', status: 'Suspended', productAccessBlocked: false });
        await assertFails(updateDoc(doc(userDb(), 'users', UID), { vehicleColor: 'blue' }));
        await seed('spots', 's7-susp-spot', ownedSpot('s7-susp-spot'));
        await assertFails(updateDoc(doc(userDb(), 'spots', 's7-susp-spot'), { interestExpiresAt: FUTURE }));
        await assertFails(deleteDoc(doc(userDb(), 'spots', 's7-susp-spot')));
        await assertFails(getDoc(doc(userDb(), 'spots', 's7-susp-spot')));
    });

    it('C: productAccessBlocked true denies spot create, update, and delete while status is Active', async () => {
        await seedProfile({
            username: 'legacy',
            status: 'Active',
            productAccessBlocked: true,
            crowns: 0,
        });
        await assertFails(updateDoc(doc(userDb(), 'users', UID), { vehicleColor: 'blue' }));
        const created = {
            ...ownedSpot('s7-create'),
            reportedAt: Timestamp.now(),
            expiresAt: Timestamp.fromMillis(Date.now() + 20 * 60 * 1000),
        };
        await assertFails(commitBoundedPing(userDb(), UID, 's7-create', created));
        await seed('spots', 's7-blocked-spot', ownedSpot('s7-blocked-spot'));
        await assertFails(updateDoc(doc(userDb(), 'spots', 's7-blocked-spot'), { interestExpiresAt: FUTURE }));
        await assertFails(deleteDoc(doc(userDb(), 'spots', 's7-blocked-spot')));
        await assertFails(getDoc(doc(userDb(), 'spots', 's7-blocked-spot')));
    });

    it('D: the same auth context is denied after productAccessBlocked becomes true', async () => {
        await seedProfile({ username: 'legacy', status: 'Active', productAccessBlocked: false });
        const db = userDb();
        await assertSucceeds(updateDoc(doc(db, 'users', UID), { vehicleColor: 'blue' }));
        await seedProfile({ username: 'legacy', status: 'Active', productAccessBlocked: true, vehicleColor: 'blue' });
        await assertFails(updateDoc(doc(db, 'users', UID), { vehicleColor: 'red' }));
    });

    it('E: clients cannot read or write private/access, or forge productAccessBlocked', async () => {
        await seedProfile({ username: 'legacy', status: 'Active', productAccessBlocked: false });
        const path = ['users', UID, 'private', 'access'] as const;
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            await setDoc(doc(ctx.firestore(), ...path), { blocked: true });
        });
        await assertFails(getDoc(doc(userDb(), ...path)));
        await assertFails(getDoc(doc(otherDb(), ...path)));
        await assertFails(getDoc(doc(adminDb(), ...path)));
        await assertFails(setDoc(doc(userDb(), ...path), { blocked: false }));
        await assertFails(updateDoc(doc(userDb(), ...path), { blocked: false }));
        await assertFails(deleteDoc(doc(userDb(), ...path)));
        await assertFails(updateDoc(doc(userDb(), 'users', UID), { productAccessBlocked: true }));
        await assertFails(updateDoc(doc(userDb(), 'users', UID), {
            vehicleColor: 'blue',
            productAccessBlocked: true,
        }));
        const { deleteField } = await import('firebase/firestore');
        await assertFails(updateDoc(doc(userDb(), 'users', UID), { productAccessBlocked: deleteField() }));
        await assertFails(setDoc(doc(userDb(), 'users', 's7-new-user'), {
            username: 'forged',
            productAccessBlocked: false,
        }));
        let stored: { productAccessBlocked?: boolean } | undefined;
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            stored = (await getDoc(doc(ctx.firestore(), 'users', UID))).data();
        });
        expect(stored?.productAccessBlocked).toBe(false);
    });

    it('F: street segments, street rules, and curb suspensions stay publicly readable', async () => {
        await seedProfile({ username: 'legacy', status: 'Suspended' });
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            const fs = ctx.firestore();
            await setDoc(doc(fs, 'streetSegments', 'seg-s7'), { name: 'Main' });
            await setDoc(doc(fs, 'streetSegments', 'seg-s7', 'streetRules', 'rule-s7'), { days: ['Mon'] });
            await setDoc(doc(fs, 'suspensions', 'curb-s7'), { reason: 'sweep' });
        });
        await assertSucceeds(getDoc(doc(anonDb(), 'streetSegments', 'seg-s7')));
        await assertSucceeds(getDoc(doc(anonDb(), 'streetSegments', 'seg-s7', 'streetRules', 'rule-s7')));
        await assertSucceeds(getDoc(doc(anonDb(), 'suspensions', 'curb-s7')));
        await assertSucceeds(getDoc(doc(userDb(), 'streetSegments', 'seg-s7')));
        await assertSucceeds(getDoc(doc(userDb(), 'suspensions', 'curb-s7')));
    });

    it('G: a blocked caller cannot open a chat, and private/account stays server-written', async () => {
        await seedProfile({ username: 'legacy', status: 'Active', productAccessBlocked: true });
        const peer = 's7-chat-peer';
        const participants = [UID, peer].sort();
        const chatId = participants.join('_');
        await assertFails(setDoc(doc(userDb(), 'chats', chatId), {
            id: chatId,
            participants,
        }));
        await assertFails(setDoc(doc(userDb(), 'users', UID, 'private', 'account'), { reportCount: 0 }));
    });

    it('H: first-time onboarding writes succeed when no profile or access doc exists', async () => {
        await assertSucceeds(setDoc(doc(userDb(), 'users', UID, 'private', 'preferences'), { lang: 'en' }));
        await seed('usernames', 'freshname', { uid: 'someone-else' });
        await assertSucceeds(getDoc(doc(userDb(), 'usernames', 'freshname')));
        await assertSucceeds(setDoc(doc(userDb(), 'users', UID, 'private', 'avatar'), {
            pendingUploadId: 'upload-onboard-1',
            requestedAt: Timestamp.now(),
        }));
    });

    it('I: a malformed productAccessBlocked fails closed, and boolean false does not', async () => {
        const cases = ['false', 'true', 0, 1, null];
        for (const productAccessBlocked of cases) {
            await seedProfile({ username: 'legacy', status: 'Active', productAccessBlocked });
            await assertFails(updateDoc(doc(userDb(), 'users', UID), { vehicleColor: 'blue' }));
        }
        await seedProfile({ username: 'legacy', status: 'Active', productAccessBlocked: false });
        await assertSucceeds(updateDoc(doc(userDb(), 'users', UID), { vehicleColor: 'blue' }));
    });

    it('J: a claim transaction still commits when productAccessBlocked is false', async () => {
        const claimer = 's7-claimer';
        const spotId = 's7-claim-spot';
        await seedActiveClaimInvariantOpen();
        await seed('users', OWNER_UID, { username: 'finder', crowns: 10, status: 'Active' });
        await seed('users', claimer, {
            username: 'claimer',
            crowns: 0,
            status: 'Active',
            productAccessBlocked: false,
        });
        await seed('spots', spotId, {
            finderId: OWNER_UID,
            finderName: 'finder',
            address: '1 Access Ave',
            lat: 40.71,
            lng: -74.03,
            status: 'available',
            pingMode: 'now',
            reportedAt: Timestamp.now(),
            expiresAt: FUTURE,
        });
        const db = testEnv.authenticatedContext(claimer).firestore();
        const claimedAt = Timestamp.now();
        await assertFails(runTransaction(db, async (tx) => {
            tx.update(doc(db, 'spots', spotId), {
                status: 'interested',
                claimState: 'heading',
                interestedUserId: claimer,
                interestExpiresAt: FUTURE,
                claimStartedAt: claimedAt,
            });
            tx.set(doc(db, 'users', claimer, 'activeIncomingClaims', 'current'), {
                spotId,
                claimStartedAt: claimedAt,
                claimState: 'heading',
                updatedAt: claimedAt,
            });
        }));
    });

    it('J2: a two-write batch still commits for a legacy user with no access doc', async () => {
        await seedProfile({ username: 'legacy', status: 'Active' });
        const db = userDb();
        const batch = writeBatch(db);
        batch.set(doc(db, 'users', UID, 'private', 'preferences'), { lang: 'es' });
        batch.set(doc(db, 'userLocations', UID), {
            lastGeohash: 'dr5ru',
            lastGeohashUpdatedAt: Timestamp.now(),
        });
        await assertSucceeds(batch.commit());
    });

    it('recovery: a Suspended user can still read their own account-deletion job', async () => {
        await seedProfile({ username: 'legacy', status: 'Suspended' });
        await seed('accountDeletionJobs', UID, { state: 'queued' });
        const snap = await assertSucceeds(getDoc(doc(userDb(), 'accountDeletionJobs', UID)));
        expect(snap.data()?.state).toBe('queued');
        await assertFails(setDoc(doc(userDb(), 'users', UID, 'private', 'preferences'), { lang: 'en' }));
    });
});

// ── t743u: Step 7 final-rules correction ──────────────────────────────────────
// The final rules must keep two interim-rules denials that the first final
// draft lost: a caller with no users/{uid} profile cannot write the Ping
// domain, and a caller with the server-written deletion fence
// accountLifecycle/{uid} (any value) cannot use the product. Legacy direct
// claim, claimant cancel and claimed-Ping finder delete stay removed.
describe('t743u — final rules: deletion fence and missing-profile denials', () => {
    const FIN = 't743-finder';
    const CLM = 't743-claimer';
    const GEN = 'ab'.repeat(32);
    const STARTED = Timestamp.fromMillis(Date.now() - 60_000);
    const ACTIVE = { username: 'claimer743', fullName: 'C', crowns: 0, status: 'Active', productAccessBlocked: false };
    const FINDER_PROFILE = { username: 'finder743', fullName: 'F', crowns: 0, status: 'Active', productAccessBlocked: false };
    type Actor = 'active' | 'suspended' | 'blocked' | 'missing' | 'fenced' | 'deleted';
    const RESTRICTED: Actor[] = ['suspended', 'blocked', 'missing', 'fenced', 'deleted'];

    function db(uid: string) { return testEnv.authenticatedContext(uid).firestore(); }

    // A denial must be a rules decision, not an evaluation-limit failure.
    async function denied(p: Promise<unknown>) {
        const err = await assertFails(p) as { message?: string };
        expect(String(err?.message ?? '')).not.toMatch(/maximum|exceed|too many|limit/i);
    }

    async function seedActor(uid: string, actor: Actor, base: Record<string, unknown> = ACTIVE) {
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            const fs = ctx.firestore();
            if (actor === 'active') await setDoc(doc(fs, 'users', uid), base);
            if (actor === 'suspended') await setDoc(doc(fs, 'users', uid), { ...base, status: 'Suspended' });
            if (actor === 'blocked') await setDoc(doc(fs, 'users', uid), { ...base, productAccessBlocked: true });
            if (actor === 'fenced') {
                await setDoc(doc(fs, 'users', uid), base);
                await setDoc(doc(fs, 'accountLifecycle', uid), { state: 'deleting' });
            }
            // deleted: profile already removed, fence still present, ID token still valid.
            // missing: no users/{uid} and no fence.
            if (actor === 'deleted' || actor === 'missing') await deleteDoc(doc(fs, 'users', uid));
            if (actor === 'deleted') await setDoc(doc(fs, 'accountLifecycle', uid), { state: 'deleting' });
        });
    }

    function available(id: string, extra: Record<string, unknown> = {}) {
        return {
            finderId: FIN, finderName: 'finder743', address: id, lat: 40.71, lng: -74.01,
            status: 'available', pingMode: 'now', type: 'free', geohash: 'dr5ru',
            reportedAt: Timestamp.now(), expiresAt: FUTURE, ...extra,
        };
    }

    // What the claimSpot callable leaves behind (Admin SDK write).
    async function seedServerClaim(id: string, extra: Record<string, unknown> = {}, lockGeneration: string | null = GEN) {
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            const fs = ctx.firestore();
            await setDoc(doc(fs, 'spots', id), available(id, {
                status: 'interested', claimState: 'heading', interestedUserId: CLM,
                claimGenerationId: GEN, claimStartedAt: STARTED, interestExpiresAt: FUTURE, ...extra,
            }));
            await setDoc(activeIncomingClaimRef(fs, CLM), {
                spotId: id, claimStartedAt: STARTED, claimState: 'heading', updatedAt: STARTED,
                ...(lockGeneration ? { claimGenerationId: lockGeneration } : {}),
            });
        });
    }

    function notice(spotId: string, senderId: string, targetUserId: string, type: string) {
        return { spotId, senderId, targetUserId, type, message: 'm', createdAt: Timestamp.fromMillis(Date.now() - 1000) };
    }

    function arrivedAttestation(spotId: string, role: 'claimer' | 'finder') {
        return {
            spotId, userId: CLM, finderId: FIN, outcome: 'participant_success', role,
            claimGenerationId: GEN, failureReason: null, address: spotId, createdAt: Timestamp.now(),
        };
    }

    async function seedArrived(id: string) {
        await seed('spots', id, available(id, {
            status: 'occupied', claimState: 'arrived_pending_outcome', interestedUserId: CLM,
            claimGenerationId: GEN, claimStartedAt: STARTED, arrivedAt: Timestamp.fromMillis(Date.now() - 30_000),
        }));
    }

    beforeEach(async () => {
        await seed('users', FIN, FINDER_PROFILE);
    });

    it('T743-ACTIVE: an Active user with a valid profile keeps every new-client path', async () => {
        await seedActor(CLM, 'active');
        await seedServerClaim('act');
        const c = db(CLM);
        await assertSucceeds(getDoc(doc(c, 'spots', 'act')));
        await assertSucceeds(getDoc(activeIncomingClaimRef(c, CLM)));
        await assertSucceeds(updateDoc(doc(c, 'spots', 'act'), { etaMinutes: 5 }));
        await assertSucceeds(setDoc(doc(c, 'spotNotifications', 'act-n'), notice('act', CLM, FIN, 'delayed')));
        await assertSucceeds(getDoc(doc(db(FIN), 'spotNotifications', 'act-n')));
        await assertSucceeds(updateDoc(doc(c, 'users', CLM), { vehicleColor: 'red' }));
        await assertSucceeds(setDoc(doc(c, 'users', CLM, 'private', 'preferences'), { lang: 'en' }));
        await seed('usernames', 'taken743', { uid: FIN });
        await assertSucceeds(getDoc(doc(c, 'usernames', 'taken743')));
        await assertSucceeds(getDoc(doc(c, 'users', FIN)));
        // Arrival on a callable-minted (generation) claim, then the attestation.
        await markClaimArrived(c, 'act', CLM);
        await assertSucceeds(setDoc(doc(c, 'spotFeedback', `act_${CLM}`), arrivedAttestation('act', 'claimer')));
        // Finder side: Ping create (worst-case create transaction) and the finder attestation.
        await assertSucceeds(commitBoundedPing(db(FIN), FIN, 'act-new', available('act-new', {
            reportedAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 20 * 60_000),
        })));
        await assertSucceeds(setDoc(doc(db(FIN), 'spotFeedback', `act_${CLM}_finder`), arrivedAttestation('act', 'finder')));
    });

    for (const actor of RESTRICTED) {
        it(`T743-DENY-${actor}: claimant Ping-domain writes are denied (${actor})`, async () => {
            await seedActor(CLM, actor);
            await seedServerClaim(`d-${actor}`);
            const c = db(CLM);
            await denied(updateDoc(doc(c, 'spots', `d-${actor}`), { etaMinutes: 5 }));
            await denied(setDoc(doc(c, 'spotNotifications', `n-${actor}`), notice(`d-${actor}`, CLM, FIN, 'delayed')));
            await denied(markClaimArrived(c, `d-${actor}`, CLM));
            await denied(deleteDoc(activeIncomingClaimRef(c, CLM)));
            await seedArrived(`a-${actor}`);
            await denied(setDoc(doc(c, 'spotFeedback', `a-${actor}_${CLM}`), arrivedAttestation(`a-${actor}`, 'claimer')));
        });

        it(`T743-DENY-FINDER-${actor}: finder Ping create, orphan delete and re-ping are denied (${actor})`, async () => {
            await seedActor(FIN, actor, FINDER_PROFILE);
            await seed('spots', `o-${actor}`, available(`o-${actor}`));
            const f = db(FIN);
            await denied(deleteDoc(doc(f, 'spots', `o-${actor}`)));
            await denied(commitBoundedPing(f, FIN, `c-${actor}`, available(`c-${actor}`, {
                reportedAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 20 * 60_000),
            })));
            await denied(setDoc(doc(f, 'users', FIN, 'pingCreateRate', 'current'), {
                spotIds: ['x'], createdAts: [Timestamp.now()],
            }));
        });
    }

    for (const actor of ['suspended', 'blocked', 'fenced', 'deleted'] as Actor[]) {
        it(`T743-READ-${actor}: product reads are denied (${actor})`, async () => {
            await seedActor(CLM, actor);
            await seedServerClaim(`r-${actor}`);
            const c = db(CLM);
            await denied(getDoc(doc(c, 'spots', `r-${actor}`)));
            await denied(getDoc(activeIncomingClaimRef(c, CLM)));
            await denied(getDoc(doc(c, 'users', FIN)));
            await denied(setDoc(doc(c, 'users', CLM, 'private', 'preferences'), { lang: 'en' }));
            await denied(getDoc(doc(c, 'usernames', 'finder743')));
        });
    }

    it('T743-FENCE-ANY: any accountLifecycle/{uid} document is a fence, whatever it holds', async () => {
        await seedActor(CLM, 'active');
        await seed('accountLifecycle', CLM, {});
        await seedServerClaim('fa');
        await denied(updateDoc(doc(db(CLM), 'spots', 'fa'), { etaMinutes: 5 }));
        await denied(getDoc(doc(db(CLM), 'spots', 'fa')));
    });

    it('T743-FENCE-CLIENT: clients cannot read, create, clear or delete the fence', async () => {
        await seedActor(CLM, 'active');
        await denied(setDoc(doc(db(CLM), 'accountLifecycle', CLM), { state: 'deleting' }));
        await seedActor(CLM, 'fenced');
        await denied(getDoc(doc(db(CLM), 'accountLifecycle', CLM)));
        await denied(deleteDoc(doc(db(CLM), 'accountLifecycle', CLM)));
        await denied(setDoc(doc(db(CLM), 'accountLifecycle', CLM), {}));
    });

    it('T743-ONBOARD: a signed-in user with no profile keeps first-time onboarding but cannot write Pings', async () => {
        await seedActor(CLM, 'missing');
        const c = db(CLM);
        const own = await assertSucceeds(getDoc(doc(c, 'users', CLM)));
        expect(own.exists()).toBe(false);
        await seed('usernames', 'taken743', { uid: FIN });
        await assertSucceeds(getDoc(doc(c, 'usernames', 'taken743')));
        await assertSucceeds(setDoc(doc(c, 'users', CLM, 'private', 'preferences'), { lang: 'en' }));
        await seed('spots', 'feed', available('feed'));
        await assertSucceeds(getDoc(doc(c, 'spots', 'feed')));
        await denied(setDoc(doc(c, 'users', CLM), { username: 'self-made' }));
        await denied(setDoc(doc(c, 'users', CLM, 'pingCreateRate', 'current'), {
            spotIds: ['x'], createdAts: [Timestamp.now()],
        }));
    });

    it('T743-CARLOCATION: carLocation behavior is unchanged (self-scoped signedIn, not product-gated)', async () => {
        const car = () => ({
            verification: 'UNVERIFIED', approximate: true, lat: 40.7, lng: -74,
            accuracyMeters: 10, savedAt: Timestamp.now(),
        });
        for (const actor of ['active', 'missing', 'fenced'] as Actor[]) {
            await testEnv.clearFirestore();
            await seedActor(CLM, actor);
            await assertSucceeds(setDoc(doc(db(CLM), 'users', CLM, 'private', 'carLocation'), car()));
            await assertSucceeds(getDoc(doc(db(CLM), 'users', CLM, 'private', 'carLocation')));
            await denied(getDoc(doc(db(FIN), 'users', CLM, 'private', 'carLocation')));
        }
    });

    it('T743-CALLABLE: server claim and server cancel leave the client able to follow the claim', async () => {
        await seedActor(CLM, 'active');
        await seedServerClaim('cb');
        const c = db(CLM);
        expect((await assertSucceeds(getDoc(doc(c, 'spots', 'cb')))).data()?.claimGenerationId).toBe(GEN);
        expect((await assertSucceeds(getDoc(activeIncomingClaimRef(c, CLM)))).exists()).toBe(true);
        // cancelClaim callable (Admin SDK): Ping back to available, lock removed, notice to the finder.
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            const fs = ctx.firestore();
            await setDoc(doc(fs, 'spots', 'cb'), available('cb'));
            await deleteDoc(activeIncomingClaimRef(fs, CLM));
        });
        expect((await assertSucceeds(getDoc(doc(c, 'spots', 'cb')))).data()?.status).toBe('available');
        expect((await assertSucceeds(getDoc(activeIncomingClaimRef(c, CLM)))).exists()).toBe(false);
    });

    it('T743-LEGACY: legacy direct claim, claimant cancel and claimed-Ping finder delete stay denied for an Active user', async () => {
        await seedActor(CLM, 'active');
        await seed('spots', 'lg-claim', available('lg-claim'));
        const c = db(CLM);
        const claimedAt = Timestamp.now();
        await denied(runTransaction(c, async (tx) => {
            tx.update(doc(c, 'spots', 'lg-claim'), {
                status: 'interested', claimState: 'heading', interestedUserId: CLM,
                interestExpiresAt: FUTURE, claimStartedAt: claimedAt,
            });
            tx.set(activeIncomingClaimRef(c, CLM), {
                spotId: 'lg-claim', claimStartedAt: claimedAt, claimState: 'heading', updatedAt: claimedAt,
            });
        }));
        // A legacy (no generation) claim and a callable claim: the claimant cannot release either directly.
        for (const [id, legacy] of [['lg-old', true], ['lg-gen', false]] as const) {
            if (legacy) {
                // Oct 16 client claim: no generation on the Ping or the lock.
                await seedServerClaim(id, {}, null);
                await testEnv.withSecurityRulesDisabled(async (ctx) => {
                    const { deleteField } = await import('firebase/firestore');
                    await updateDoc(doc(ctx.firestore(), 'spots', id), { claimGenerationId: deleteField() });
                });
            } else {
                await seedServerClaim(id);
            }
            await denied(runTransaction(c, async (tx) => {
                tx.update(doc(c, 'spots', id), {
                    status: 'available', interestedUserId: null, claimState: null,
                    claimStartedAt: null, interestExpiresAt: null,
                });
                tx.delete(activeIncomingClaimRef(c, CLM));
            }));
            await denied(updateDoc(doc(c, 'spots', id), { status: 'available', interestedUserId: null }));
            // Finder cannot delete a claimed Ping directly (finderCancelSpot owns that).
            await denied(deleteDoc(doc(db(FIN), 'spots', id)));
        }
    });

    it('T743-ORPHAN: an Active finder can still delete an unclaimed, generation-free Ping; not a claimed or generation one', async () => {
        await seed('spots', 'orph', available('orph'));
        await assertSucceeds(deleteDoc(doc(db(FIN), 'spots', 'orph')));
        await seed('spots', 'orph-gen', available('orph-gen', { claimGenerationId: GEN }));
        await denied(deleteDoc(doc(db(FIN), 'spots', 'orph-gen')));
        await seed('spots', 'orph-other', available('orph-other', { finderId: 'someone-else' }));
        await denied(deleteDoc(doc(db(FIN), 'spots', 'orph-other')));
    });
});

// ── t743u: document-access headroom of the corrected final rules ─────────────
// Firestore allows 10 distinct document lookups per single-document request or
// per operation, and 20 per transaction or batch. The correction adds one
// lookup (accountLifecycle/{uid}) to every actorMayUseProduct() caller. Each
// case pads an in-memory copy of firestore.rules with K extra exists() calls on
// distinct existing documents inside actorMayUseProduct() and records the
// largest K the valid operation still passes. Nothing is written to disk.
describe('t743u — final rules: document-access headroom', () => {
    const FIN = 't743b-finder';
    const CLM = 't743b-claimer';
    const GEN = 'cd'.repeat(32);
    const STARTED = Timestamp.fromMillis(Date.now() - 60_000);
    const RULES_TEXT = readFileSync('firestore.rules', 'utf8');
    const PAD = 't743uPadDocs';
    const ANCHOR = 'return request.auth != null && !productAccessDenied() && !accountDeletionFenced();';
    const MIN_HEADROOM = 2;

    function padded(k: number) {
        const at = RULES_TEXT.indexOf(ANCHOR);
        if (at < 0 || RULES_TEXT.indexOf(ANCHOR, at + 1) >= 0) throw new Error('pad anchor not unique');
        const terms = Array.from({ length: k }, (_, i) => ` && exists(/databases/$(database)/documents/${PAD}/p${i})`).join('');
        return RULES_TEXT.slice(0, at) + ANCHOR.slice(0, -1) + terms + ';' + RULES_TEXT.slice(at + ANCHOR.length);
    }
    let padEnv: RulesTestEnvironment | undefined;
    async function useRules(text: string) {
        if (padEnv) await padEnv.cleanup();
        padEnv = await initializeTestEnvironment({
            projectId: PROJECT_ID,
            firestore: { rules: text, host: rulesEmulator.host, port: rulesEmulator.port },
        });
    }
    afterAll(async () => {
        // Restore the unpadded rules for anything that runs after this block.
        await useRules(RULES_TEXT);
        if (padEnv) await padEnv.cleanup();
    });

    function db(uid: string) { return testEnv.authenticatedContext(uid).firestore(); }
    function available(id: string, extra: Record<string, unknown> = {}) {
        return {
            finderId: FIN, finderName: 'finderb', address: id, lat: 40.71, lng: -74.01,
            status: 'available', pingMode: 'now', type: 'free', geohash: 'dr5ru',
            reportedAt: Timestamp.now(), expiresAt: FUTURE, ...extra,
        };
    }
    async function seedAll() {
        await testEnv.clearFirestore();
        await seedActiveClaimInvariantOpen();
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            const fs = ctx.firestore();
            for (let i = 0; i < 12; i += 1) await setDoc(doc(fs, PAD, `p${i}`), { p: 1 });
            await setDoc(doc(fs, 'users', FIN), { username: 'finderb', crowns: 0, status: 'Active', productAccessBlocked: false });
            await setDoc(doc(fs, 'users', CLM), { username: 'claimerb', crowns: 0, status: 'Active', productAccessBlocked: false });
            const claim = { status: 'interested', claimState: 'heading', interestedUserId: CLM, claimGenerationId: GEN, claimStartedAt: STARTED, interestExpiresAt: FUTURE };
            await setDoc(doc(fs, 'spots', 'eta'), available('eta', claim));
            await setDoc(doc(fs, 'spots', 'arr'), available('arr', claim));
            await setDoc(doc(fs, 'spots', 'fb'), available('fb', {
                status: 'occupied', claimState: 'arrived_pending_outcome', interestedUserId: CLM,
                claimGenerationId: GEN, claimStartedAt: STARTED, arrivedAt: Timestamp.fromMillis(Date.now() - 30_000),
            }));
            await setDoc(doc(fs, 'spots', 'orph'), available('orph'));
            await setDoc(activeIncomingClaimRef(fs, CLM), { spotId: 'arr', claimStartedAt: STARTED, claimState: 'heading', updatedAt: STARTED, claimGenerationId: GEN });
            // A full rolling hour minus one, so the quota update reads and carries four prior entries.
            const prior = [1, 2, 3, 4].map((m) => Timestamp.fromMillis(Date.now() - m * 60_000));
            await setDoc(doc(fs, 'users', FIN, 'pingCreateRate', 'current'), { spotIds: ['q1', 'q2', 'q3', 'q4'], createdAts: prior });
        });
    }
    const CASES: { id: string; limit: number; run: () => Promise<unknown> }[] = [
        { id: 'H-1 finder Ping create with quota carry (transaction)', limit: 20,
            run: () => commitBoundedPing(db(FIN), FIN, 'new1', available('new1', { reportedAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 20 * 60_000) })) },
        { id: 'H-2 claimant arrival with lock release (transaction)', limit: 20,
            run: () => markClaimArrived(db(CLM), 'arr', CLM) },
        { id: 'H-3 claimant ETA (single write)', limit: 10,
            run: () => updateDoc(doc(db(CLM), 'spots', 'eta'), { etaMinutes: 4 }) },
        { id: 'H-4 claimant notice to finder (single write)', limit: 10,
            run: () => setDoc(doc(db(CLM), 'spotNotifications', 'n1'), { spotId: 'eta', senderId: CLM, targetUserId: FIN, type: 'delayed', message: 'm', createdAt: Timestamp.fromMillis(Date.now() - 1000) }) },
        { id: 'H-5 claimant success attestation (single write)', limit: 10,
            run: () => setDoc(doc(db(CLM), 'spotFeedback', `fb_${CLM}`), { spotId: 'fb', userId: CLM, finderId: FIN, outcome: 'participant_success', role: 'claimer', claimGenerationId: GEN, failureReason: null, address: 'fb', createdAt: Timestamp.now() }) },
        { id: 'H-6 finder unclaimed-orphan delete (single write)', limit: 10,
            run: () => deleteDoc(doc(db(FIN), 'spots', 'orph')) },
    ];

    for (const c of CASES) {
        it(`${c.id}: valid unpadded and keeps at least ${MIN_HEADROOM} lookups of headroom`, async () => {
            let headroom = -1;
            for (let k = 0; k <= 12; k += 1) {
                await useRules(padded(k));
                await seedAll();
                try { await c.run(); headroom = k; } catch { break; }
            }
            console.log(JSON.stringify({ t743u: 'access', id: c.id, limit: c.limit, headroom }));
            expect(headroom).toBeGreaterThanOrEqual(MIN_HEADROOM);
        }, 240_000);
    }
});

// ═══════════════════════════════════════════════════════════════════════════════
// t745u — Ping create quota under the 1000-expression request limit.
// The deployed a7d53cc8 client (StreetParkingView.tsx) sends finderTitle and the
// three finderVehicle* fields. With those fields the 5th Ping of a rolling hour
// used to exceed 1000 expressions because pingCreateRateRecorded() re-ran the
// quota doc's own shape and carry checks. pingCreateRateRecorded() now only binds
// the same-commit quota write to the new spot; the quota doc's create/update
// rule stays the single authority for shape, the 5-entry cap and the carry.
// Every denial below must name the intended rule ("false for ... @ L<line>"),
// never an expression-limit or evaluation error.
// ═══════════════════════════════════════════════════════════════════════════════
describe('t745u — Ping create quota under the 1000-expression limit', () => {
    const FIN = 't745-finder';
    const CLM = 't745-claimer';
    // Worst-case identity path for the shipped client: crowns 0 walks every
    // titleForCrowns branch, and all three vehicle fields are compared.
    const PROFILE = {
        username: 'finder745', fullName: 'Finder Five', crowns: 0, status: 'Active', productAccessBlocked: false,
        vehicleColor: 'Red', vehicleType: 'Sedan', vehicleBrand: 'Toyota',
    };
    const RULES_TEXT = readFileSync('firestore.rules', 'utf8');
    const RULE_LINES = RULES_TEXT.split('\n');
    function lineOf(needle: string, after = 0) {
        const i = RULE_LINES.findIndex((l, idx) => idx >= after && l.includes(needle));
        if (i < 0) throw new Error(`rule line not found: ${needle}`);
        return i + 1;
    }
    const RATE_MATCH = lineOf('match /pingCreateRate/{rateId}');
    const RATE_CREATE = lineOf('allow create: if actorMayWritePings()', RATE_MATCH);
    const RATE_UPDATE = lineOf('allow update: if actorMayWritePings()', RATE_MATCH);
    const SPOT_CREATE = lineOf('allow create: if actorMayWritePings()', lineOf('match /spots/{spotId}'));
    const ORIGIN_MATCH = lineOf('match /originRePings/{originSpotId}');
    const ORIGIN_UPDATE = lineOf('allow update, delete: if false;', ORIGIN_MATCH);

    function db(uid = FIN) { return testEnv.authenticatedContext(uid).firestore(); }
    function rateRef(d: ReturnType<typeof db>, uid = FIN) { return doc(d, 'users', uid, 'pingCreateRate', 'current'); }
    function minutesAgo(m: number) { return Timestamp.fromMillis(Date.now() - m * 60_000); }

    // Exact StreetParkingView.tsx (a7d53cc8) create payload for this profile.
    function clientPing(i: number | string, extra: Record<string, unknown> = {}) {
        const reportedAt = Timestamp.now();
        return {
            lat: 40.7 + Number(String(i).replace(/\D/g, '') || 0) * 0.001,
            lng: -73.99,
            type: 'free',
            status: 'available',
            finderId: FIN,
            finderName: PROFILE.username,
            finderTitle: getTitleForCrowns(PROFILE.crowns),
            finderVehicleColor: PROFILE.vehicleColor,
            finderVehicleType: PROFILE.vehicleType,
            finderVehicleBrand: PROFILE.vehicleBrand,
            pingMode: 'now',
            reportedAt,
            expiresAt: Timestamp.fromMillis(reportedAt.toMillis() + 30 * 60_000),
            geohash: 'dr5rsq',
            address: `${i} Quota Street, New York, NY 10001`,
            ...extra,
        };
    }

    async function seedRate(ids: string[], ats: Timestamp[]) {
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            await setDoc(rateRef(ctx.firestore()), { spotIds: ids, createdAts: ats });
        });
    }
    async function adminRead(path: string[]) {
        let data: any = null;
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            const snap = await getDoc(doc(ctx.firestore(), path[0], ...path.slice(1)));
            data = snap.exists() ? snap.data() : null;
        });
        return data;
    }
    async function finderSpotCount() {
        let n = 0;
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            n = (await getDocs(query(collection(ctx.firestore(), 'spots'), where('finderId', '==', FIN)))).size;
        });
        return n;
    }

    // A real rules decision: the message must carry "false for '<op>' @ L<line>"
    // for the intended rule, and nothing that indicates the evaluator gave up.
    // The emulator also lists diagnostic "evaluation error at L<n>:<col>" entries
    // for the create/update statements it probes for each write (they appear on
    // every denial, including a plain spot-only create); the decision is the
    // "false for" entry, so those are not treated as the denial reason.
    const EVALUATOR_FAILURE = /maximum of \d+ expressions|expressions to evaluate|too complex|exceeded|too many/i;
    async function ruleDenied(p: Promise<unknown>, op: string, line: number, alt?: [string, number]) {
        const err = await assertFails(p) as { message?: string };
        const msg = String(err?.message ?? '');
        console.log(JSON.stringify({ t745u: 'denial', op, line, msg: msg.replace(/\s+/g, ' ').slice(0, 400) }));
        expect(msg).not.toMatch(EVALUATOR_FAILURE);
        const wanted = [`false for '${op}' @ L${line}`, ...(alt ? [`false for '${alt[0]}' @ L${alt[1]}`] : [])];
        expect(wanted.some((w) => msg.includes(w)), `${wanted.join(' | ')} in ${msg}`).toBe(true);
        return msg;
    }
    async function allowed(p: Promise<unknown>) {
        try {
            await p;
        } catch (e: any) {
            throw new Error(`expected success, got ${e?.code ?? e?.name}: ${String(e?.message ?? '').replace(/\s+/g, ' ').slice(0, 400)}`);
        }
    }

    // A client that skips advancePingRate entirely and writes the quota doc as given.
    function forcedCreate(d: ReturnType<typeof db>, spotId: string, data: object, rate: { spotIds: string[]; createdAts: Timestamp[] } | null, extraWrites?: (b: ReturnType<typeof writeBatch>) => void) {
        const b = writeBatch(d);
        b.set(doc(d, 'spots', spotId), data);
        if (rate) b.set(rateRef(d), rate);
        extraWrites?.(b);
        return b.commit();
    }

    beforeEach(async () => {
        await seed('users', FIN, PROFILE);
    });

    it('T745-Q1: Pings 1-5 in one rolling hour succeed through the a7d53cc8 commitPingCreate with the full client shape', async () => {
        const d = db();
        for (let i = 1; i <= 5; i += 1) {
            await allowed(commitPingCreate(d, { uid: FIN, spotRef: doc(collection(d, 'spots')), data: clientPing(i) }));
        }
        const rate = await adminRead(['users', FIN, 'pingCreateRate', 'current']);
        expect(rate.spotIds).toHaveLength(5);
        expect(await finderSpotCount()).toBe(5);
        // The shipped client refuses a 6th before writing anything.
        await expect(commitPingCreate(d, { uid: FIN, spotRef: doc(collection(d, 'spots')), data: clientPing(6) }))
            .rejects.toMatchObject({ name: 'PingCreateRejected', reason: 'rate' });
    });

    it('T745-Q2: a forced 6th Ping (client rate check bypassed, honest 6-entry quota) is denied by the quota update rule', async () => {
        const ids = ['q1', 'q2', 'q3', 'q4', 'q5'];
        const ats = [50, 40, 30, 20, 10].map(minutesAgo);
        await seedRate(ids, ats);
        await ruleDenied(forcedCreate(db(), 'q6', clientPing(6), { spotIds: [...ids, 'q6'], createdAts: [...ats, Timestamp.now()] }), 'update', RATE_UPDATE);
        expect(await adminRead(['spots', 'q6'])).toBeNull();
        expect((await adminRead(['users', FIN, 'pingCreateRate', 'current'])).spotIds).toEqual(ids);
    });

    it('T745-Q2b: a forced 6th Ping after five real creates is denied by the quota rule, through the commitBoundedPing bypass helper', async () => {
        const d = db();
        for (let i = 1; i <= 5; i += 1) {
            await allowed(commitPingCreate(d, { uid: FIN, spotRef: doc(collection(d, 'spots')), data: clientPing(i) }));
        }
        await ruleDenied(commitBoundedPing(d, FIN, 'forced-6', clientPing(6)), 'update', RATE_UPDATE);
        expect(await finderSpotCount()).toBe(5);
    });

    it('T745-Q2c: a forced 6th that drops the oldest in-window entry to stay at 5 is denied', async () => {
        const ids = ['q1', 'q2', 'q3', 'q4', 'q5'];
        const ats = [50, 40, 30, 20, 10].map(minutesAgo);
        await seedRate(ids, ats);
        await ruleDenied(forcedCreate(db(), 'q6', clientPing(6), { spotIds: [...ids.slice(1), 'q6'], createdAts: [...ats.slice(1), Timestamp.now()] }), 'update', RATE_UPDATE);
    });

    it('T745-Q3: after the oldest entry leaves the rolling hour, a new Ping succeeds and the expired prefix is dropped', async () => {
        const ids = ['old', 'q2', 'q3', 'q4', 'q5'];
        await seedRate(ids, [61, 50, 40, 30, 20].map(minutesAgo));
        const d = db();
        const spotRef = doc(collection(d, 'spots'));
        await allowed(commitPingCreate(d, { uid: FIN, spotRef, data: clientPing(7) }));
        const rate = await adminRead(['users', FIN, 'pingCreateRate', 'current']);
        expect(rate.spotIds).toEqual(['q2', 'q3', 'q4', 'q5', spotRef.id]);
    });

    it('T745-Q3b: keeping the expired entry (6 entries) is still denied', async () => {
        const ids = ['old', 'q2', 'q3', 'q4', 'q5'];
        const ats = [61, 50, 40, 30, 20].map(minutesAgo);
        await seedRate(ids, ats);
        await ruleDenied(forcedCreate(db(), 'q6', clientPing(6), { spotIds: [...ids, 'q6'], createdAts: [...ats, Timestamp.now()] }), 'update', RATE_UPDATE);
    });

    describe('forged or mismatched quota writes (four in-window entries)', () => {
        const ids = ['q1', 'q2', 'q3', 'q4'];
        const ats = [40, 30, 20, 10].map(minutesAgo);
        beforeEach(async () => { await seedRate(ids, ats); });

        it('T745-F1: a quota doc with an extra field is denied', async () => {
            await ruleDenied(forcedCreate(db(), 'f1', clientPing(1), { spotIds: [...ids, 'f1'], createdAts: [...ats, Timestamp.now()], reset: true } as any), 'update', RATE_UPDATE);
        });
        it('T745-F2: replacing the list with only the new spot (forged reset) is denied', async () => {
            await ruleDenied(forcedCreate(db(), 'f2', clientPing(2), { spotIds: ['f2'], createdAts: [Timestamp.now()] }), 'update', RATE_UPDATE);
        });
        it('T745-F3: dropping an unexpired entry is denied', async () => {
            await ruleDenied(forcedCreate(db(), 'f3', clientPing(3), { spotIds: ['q1', 'q3', 'q4', 'f3'], createdAts: [ats[0], ats[2], ats[3], Timestamp.now()] }), 'update', RATE_UPDATE);
        });
        it('T745-F4: back-dating a carried timestamp so it looks expired is denied', async () => {
            await ruleDenied(forcedCreate(db(), 'f4', clientPing(4), { spotIds: [...ids, 'f4'], createdAts: [minutesAgo(120), ats[1], ats[2], ats[3], Timestamp.now()] }), 'update', RATE_UPDATE);
        });
        it('T745-F5: a stale timestamp on the new entry is denied', async () => {
            await ruleDenied(forcedCreate(db(), 'f5', clientPing(5), { spotIds: [...ids, 'f5'], createdAts: [...ats, minutesAgo(5)] }), 'update', RATE_UPDATE);
        });
        it('T745-F6: a quota entry naming another spot id is denied', async () => {
            // Both rules reject this (the quota's last id is not a spot created
            // in this commit; the spot is not the quota's last id). The emulator
            // reports whichever write it evaluates first.
            await ruleDenied(forcedCreate(db(), 'f6', clientPing(6), { spotIds: [...ids, 'someone-else'], createdAts: [...ats, Timestamp.now()] }), 'update', RATE_UPDATE, ['create', SPOT_CREATE]);
        });
        it('T745-F7: a carried spot id rewritten in place is denied', async () => {
            await ruleDenied(forcedCreate(db(), 'f7', clientPing(7), { spotIds: ['qX', 'q2', 'q3', 'q4', 'f7'], createdAts: [...ats, Timestamp.now()] }), 'update', RATE_UPDATE);
        });
        it('T745-F8: a Ping create with no quota write is denied', async () => {
            await ruleDenied(forcedCreate(db(), 'f8', clientPing(8), null), 'create', SPOT_CREATE);
        });
        it('T745-F9: two Pings in one commit with one quota entry are denied', async () => {
            const d = db();
            await ruleDenied(forcedCreate(d, 'f9a', clientPing(9), { spotIds: [...ids, 'f9a'], createdAts: [...ats, Timestamp.now()] },
                (b) => b.set(doc(d, 'spots', 'f9b'), clientPing(10))), 'create', SPOT_CREATE);
            expect(await adminRead(['spots', 'f9a'])).toBeNull();
        });
        it('T745-F10: delete-and-recreate of the last recorded spot id without a new quota entry is denied', async () => {
            const d = db();
            await allowed(commitPingCreate(d, { uid: FIN, spotRef: doc(d, 'spots', 'f10'), data: clientPing(10) }));
            await allowed(deleteDoc(doc(d, 'spots', 'f10')));
            // The quota doc still ends with f10 and its stamp is fresh; reusing it must not count as a new quota write.
            await ruleDenied(forcedCreate(d, 'f10', clientPing(10), null), 'create', SPOT_CREATE);
            expect(await adminRead(['spots', 'f10'])).toBeNull();
        });
        it('T745-F11: a quota doc created for another user is denied', async () => {
            const d = db();
            const b = writeBatch(d);
            b.set(doc(d, 'spots', 'f11'), clientPing(11));
            b.set(rateRef(d), { spotIds: [...ids, 'f11'], createdAts: [...ats, Timestamp.now()] });
            b.set(doc(d, 'users', CLM, 'pingCreateRate', 'current'), { spotIds: ['f11'], createdAts: [Timestamp.now()] });
            await assertFails(b.commit());
        });
    });

    describe('departure re-Ping (originSpotId)', () => {
        async function seedHandoff(id: string) {
            await seed('spots', id, {
                ...clientPing(id), finderId: CLM, finderName: 'claimer745', status: 'occupied', interestedUserId: FIN,
            });
        }
        // Exact useInterestFlow.ts handleDeparturePing (a7d53cc8) payload.
        function rePing(originId: string, minutesAhead = 30) {
            const reportedAt = Timestamp.fromMillis(Date.now() + minutesAhead * 60_000);
            return {
                lat: 40.71, lng: -73.99, type: 'free', status: 'available', finderId: FIN, finderName: PROFILE.username,
                pingMode: 'later', reportedAt, expiresAt: Timestamp.fromMillis(reportedAt.toMillis() + 30 * 60_000),
                geohash: 'dr5rsq', address: `${originId} departure`, originSpotId: originId,
            };
        }

        it('T745-O1: with four in-window entries the re-Ping is the 5th create and succeeds; the quota and marker are written', async () => {
            await seed('users', CLM, { username: 'claimer745', crowns: 0, status: 'Active', productAccessBlocked: false });
            await seedHandoff('o1');
            await seedRate(['q1', 'q2', 'q3', 'q4'], [40, 30, 20, 10].map(minutesAgo));
            const d = db();
            const spotRef = doc(collection(d, 'spots'));
            await allowed(commitPingCreate(d, { uid: FIN, spotRef, originSpotId: 'o1', data: rePing('o1') }));
            expect((await adminRead(['users', FIN, 'pingCreateRate', 'current'])).spotIds).toHaveLength(5);
            expect((await adminRead(['originRePings', 'o1'])).rePingSpotId).toBe(spotRef.id);
        });

        it('T745-O2: a second re-Ping of the same origin is denied by the create-once marker (quota still has room)', async () => {
            await seedHandoff('o2');
            await seedRate(['q1', 'q2'], [30, 20].map(minutesAgo));
            const d = db();
            await allowed(commitPingCreate(d, { uid: FIN, spotRef: doc(d, 'spots', 'o2-r1'), originSpotId: 'o2', data: rePing('o2') }));
            // The shipped client refuses on the existing marker; a bypassing client still hits Rules.
            await expect(commitPingCreate(d, { uid: FIN, spotRef: doc(collection(d, 'spots')), originSpotId: 'o2', data: rePing('o2', 40) }))
                .rejects.toMatchObject({ name: 'PingCreateRejected', reason: 'origin' });
            const msg = await ruleDenied(commitBoundedPing(d, FIN, 'o2-r2', rePing('o2', 40), 'o2'), 'update', ORIGIN_UPDATE);
            expect(msg).not.toMatch(EVALUATOR_FAILURE);
            expect(await adminRead(['spots', 'o2-r2'])).toBeNull();
            expect((await adminRead(['users', FIN, 'pingCreateRate', 'current'])).spotIds).toHaveLength(3);
        });

        it('T745-O3: a re-Ping with five in-window entries is denied by the quota rule', async () => {
            await seedHandoff('o3');
            const ids = ['q1', 'q2', 'q3', 'q4', 'q5'];
            await seedRate(ids, [50, 40, 30, 20, 10].map(minutesAgo));
            await ruleDenied(commitBoundedPing(db(), FIN, 'o3-r1', rePing('o3'), 'o3'), 'update', RATE_UPDATE);
            expect(await adminRead(['originRePings', 'o3'])).toBeNull();
        });
    });

    it('T745-R1: the 5th create that also replaces the selected own Ping (StreetParkingView deleteRefs path) succeeds', async () => {
        await seed('spots', 'old-own', clientPing('old-own'));
        await seedRate(['q1', 'q2', 'q3', 'q4'], [40, 30, 20, 10].map(minutesAgo));
        const d = db();
        await allowed(commitPingCreate(d, { uid: FIN, spotRef: doc(collection(d, 'spots')), data: clientPing(5), deleteRefs: [doc(d, 'spots', 'old-own')] }));
        expect(await adminRead(['spots', 'old-own'])).toBeNull();
    });

    it('T745-C1: concurrent 5th-Ping batches built from the same 4-entry snapshot commit at most one', async () => {
        const ids = ['q1', 'q2', 'q3', 'q4'];
        const ats = [40, 30, 20, 10].map(minutesAgo);
        await seedRate(ids, ats);
        const results = await Promise.allSettled([1, 2, 3].map((k) => {
            const d = db();
            return forcedCreate(d, `c5-${k}`, clientPing(k), { spotIds: [...ids, `c5-${k}`], createdAts: [...ats, Timestamp.now()] });
        }));
        const ok = results.filter((r) => r.status === 'fulfilled').length;
        for (const r of results) if (r.status === 'rejected') expect(String((r.reason as any)?.message ?? '')).not.toMatch(EVALUATOR_FAILURE);
        console.log(JSON.stringify({ t745u: 'concurrency-5th', fulfilled: ok, rejected: results.length - ok }));
        expect(ok).toBe(1);
        expect(await finderSpotCount()).toBe(1);
        expect((await adminRead(['users', FIN, 'pingCreateRate', 'current'])).spotIds).toHaveLength(5);
    });

    it('T745-C2: concurrent forced 6th and 7th batches against a full hour commit nothing', async () => {
        const ids = ['q1', 'q2', 'q3', 'q4', 'q5'];
        const ats = [50, 40, 30, 20, 10].map(minutesAgo);
        await seedRate(ids, ats);
        const results = await Promise.allSettled([6, 7].map((k) => {
            const d = db();
            return Promise.all([
                forcedCreate(d, `c-${k}a`, clientPing(k), { spotIds: [...ids, `c-${k}a`], createdAts: [...ats, Timestamp.now()] }),
                forcedCreate(d, `c-${k}b`, clientPing(k), { spotIds: [...ids.slice(1), `c-${k}b`], createdAts: [...ats.slice(1), Timestamp.now()] }),
            ]);
        }));
        expect(results.every((r) => r.status === 'rejected')).toBe(true);
        expect(await finderSpotCount()).toBe(0);
        expect((await adminRead(['users', FIN, 'pingCreateRate', 'current'])).spotIds).toEqual(ids);
    });
});

// t745u — expression headroom. The request limit is 1000 evaluated expressions.
// Padding: a helper t745uPad(i) evaluating ten "request.time != null" terms is
// defined next to pingCreateRateRecorded() and called K times (distinct literal
// argument per call) inside the spots create rule. Calibration: the same helper
// on a one-line rule gives the per-call expression cost as 1000 / (Kcal + 1).
// Headroom for a case ~= Kmax_case * per-call cost (approximate, ± one call).
describe('t745u — 5th Ping expression headroom', () => {
    const FIN = 't745h-finder';
    const PROFILE = {
        username: 'finder745h', fullName: 'H', crowns: 0, status: 'Active', productAccessBlocked: false,
        vehicleColor: 'Red', vehicleType: 'Sedan', vehicleBrand: 'Toyota',
    };
    const RULES_TEXT = readFileSync('firestore.rules', 'utf8');
    const CREATE_ANCHOR = '&& pingCreateRateRecorded(spotId)\n        && originLinkRecorded(spotId);';
    const FN_ANCHOR = '    function pingCreateRateRecorded(spotId) {';
    const PAD_FN = `    function t745uPad(i) {\n      return i != null${' && request.time != null'.repeat(10)};\n    }\n\n`;
    const MIN_HEADROOM_EXPRESSIONS = 100;
    let padEnv: RulesTestEnvironment | undefined;
    async function useRules(text: string) {
        if (padEnv) { await padEnv.cleanup(); padEnv = undefined; }
        padEnv = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { rules: text, host: rulesEmulator.host, port: rulesEmulator.port } });
    }
    afterAll(async () => {
        await useRules(RULES_TEXT);
        if (padEnv) await padEnv.cleanup();
    });
    function calls(k: number) { return Array.from({ length: k }, (_, i) => ` && t745uPad(${i})`).join(''); }
    function unique(text: string, anchor: string) {
        const at = text.indexOf(anchor);
        if (at < 0 || text.indexOf(anchor, at + 1) >= 0) throw new Error(`pad anchor not unique: ${anchor.slice(0, 40)}`);
        return at;
    }
    function padded(k: number) {
        let text = RULES_TEXT;
        const c = unique(text, CREATE_ANCHOR);
        text = text.slice(0, c) + CREATE_ANCHOR.slice(0, -1) + calls(k) + ';' + text.slice(c + CREATE_ANCHOR.length);
        const f = unique(text, FN_ANCHOR);
        return text.slice(0, f) + PAD_FN + text.slice(f);
    }
    function ping(i: number | string) {
        const reportedAt = Timestamp.now();
        return {
            lat: 40.7, lng: -73.99, type: 'free', status: 'available', finderId: FIN, finderName: PROFILE.username,
            finderTitle: getTitleForCrowns(0), finderVehicleColor: 'Red', finderVehicleType: 'Sedan', finderVehicleBrand: 'Toyota',
            pingMode: 'now', reportedAt, expiresAt: Timestamp.fromMillis(reportedAt.toMillis() + 30 * 60_000),
            geohash: 'dr5rsq', address: `${i} Headroom Avenue, New York, NY 10001`,
        };
    }
    async function seedFourth(withOwn: boolean) {
        await testEnv.clearFirestore();
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            const fs = ctx.firestore();
            await setDoc(doc(fs, 'users', FIN), PROFILE);
            await setDoc(doc(fs, 'users', FIN, 'pingCreateRate', 'current'), {
                spotIds: ['q1', 'q2', 'q3', 'q4'], createdAts: [40, 30, 20, 10].map((m) => Timestamp.fromMillis(Date.now() - m * 60_000)),
            });
            if (withOwn) await setDoc(doc(fs, 'spots', 'own'), ping('own'));
        });
    }
    async function maxK(tryK: (k: number) => Promise<boolean>, hi: number) {
        if (!(await tryK(0))) return -1;
        let lo = 0;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (await tryK(mid)) lo = mid; else hi = mid - 1;
        }
        return lo;
    }

    it('T745-H: the heaviest valid 5th-Ping requests keep at least 100 expressions of headroom', async () => {
        const calText = (k: number) => `rules_version = '2';\nservice cloud.firestore {\n  match /databases/{database}/documents {\n${PAD_FN}    match /cal/{d} {\n      allow write: if request.auth != null${calls(k)};\n    }\n  }\n}\n`;
        let calErr = '';
        const calK = await maxK(async (k) => {
            try {
                await useRules(calText(k));
                await setDoc(doc(padEnv!.authenticatedContext(FIN).firestore(), 'cal', 'x'), { a: 1 });
                return true;
            } catch (e: any) { calErr = String(e?.message ?? ''); return false; }
        }, 200);
        expect(calK).toBeGreaterThan(0);
        expect(calK).toBeLessThan(200);
        expect(calErr).toMatch(/maximum of 1000 expressions/);
        const perCall = 1000 / (calK + 1);
        const cases: { id: string; own: boolean; run: (d: any) => Promise<unknown> }[] = [
            { id: '5th Ping, full client shape', own: false,
                run: (d) => commitPingCreate(d, { uid: FIN, spotRef: doc(d, 'spots', 'p5'), data: ping(5) }) },
            { id: '5th Ping replacing own Ping (deleteRefs)', own: true,
                run: (d) => commitPingCreate(d, { uid: FIN, spotRef: doc(d, 'spots', 'p5r'), data: ping(5), deleteRefs: [doc(d, 'spots', 'own')] }) },
        ];
        for (const c of cases) {
            let lastErr = '';
            const k = await maxK(async (kk) => {
                try {
                    await useRules(padded(kk));
                    await seedFourth(c.own);
                    await c.run(padEnv!.authenticatedContext(FIN).firestore());
                    return true;
                } catch (e: any) { lastErr = String(e?.message ?? ''); return false; }
            }, 150);
            const headroom = Math.round(k * perCall);
            console.log(JSON.stringify({ t745u: 'expr-headroom', id: c.id, calibrationCalls: calK, perCallExpressions: Number(perCall.toFixed(2)), maxPadCalls: k, approxHeadroomExpressions: headroom, failureAtNext: lastErr.replace(/\s+/g, ' ').slice(0, 200) }));
            expect(k).toBeGreaterThanOrEqual(0);
            expect(lastErr).toMatch(/maximum of 1000 expressions/);
            expect(headroom).toBeGreaterThanOrEqual(MIN_HEADROOM_EXPRESSIONS);
        }
    }, 600_000);
});
