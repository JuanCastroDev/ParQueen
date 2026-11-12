/**
 * S7 mixed-version compatibility — T1 LEGACY DIRECT WRITES (t674u).
 *
 * Replays the Oct 16 production client's direct Firestore claim and
 * cancellation writes against:
 *   1. the verified DEPLOYED production ruleset snapshot
 *      (test-fixtures/production-baseline/deployed-firestore-134a97cf.rules,
 *      sha256 134a97cf8e25f2f8848ff4d2c0ff65ff5dd83434f1690901b4ba7dffe403810b,
 *      fetched read-only in t660u; it matches no git commit), and
 *   2. the repository candidate firestore.rules (head; not published).
 *
 * Old-client write shapes are copied from the live-bundle source commit
 * 1ffeba94a09d01247c5d960aa3c4ff0672a8432e:
 *   views/street-parking/activeIncomingClaim.ts    blob f55c7a0edf9cba65df10e4433b819bf408475ddc
 *   views/street-parking/cancelClaimTransaction.ts blob 5b700d7e0a4b25d3481c81850968c223ed00366b
 *   views/street-parking/useInterestFlow.ts        blob a1631b190e967fefd48c2247f09f849817b65909
 *
 * Test classes:
 *   CHARACTERIZATION  documents what production does today. Not a contract.
 *   SECURITY          the behavior that must hold before an S7 release.
 *                     A reproduced bypass is an `it.fails` tagged
 *                     `BLOCKER[...]`: the assertion is unchanged and the test
 *                     stays visible. When the bypass is fixed the it.fails
 *                     turns red and must be flipped to `it`.
 *
 * The rollout gate document activeIncomingClaimRollout/status is SEEDED here.
 * Its production value was not read (not authorized). Arm 1 results are
 * therefore conditional on that gate being open in production.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
    setDoc,
    deleteDoc,
    addDoc,
    collection,
    Timestamp,
    runTransaction,
} from 'firebase/firestore';
import { assertRulesProject, readRulesEmulatorEndpoint } from './firestoreRulesEmulator';

const PROJECT_ID = 'demo-parkqueen-rules-test';
const rulesEmulator = readRulesEmulatorEndpoint();
assertRulesProject(PROJECT_ID);

const DEPLOYED_RULES_PATH = 'test-fixtures/production-baseline/deployed-firestore-134a97cf.rules';
const DEPLOYED_RULES_SHA256 = '134a97cf8e25f2f8848ff4d2c0ff65ff5dd83434f1690901b4ba7dffe403810b';

function readDeployedRules(): string {
    const bytes = readFileSync(DEPLOYED_RULES_PATH);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== DEPLOYED_RULES_SHA256) {
        throw new Error(`Deployed rules snapshot digest mismatch: ${digest}`);
    }
    return bytes.toString('utf8');
}

const FINDER = 'mv-finder-0001';
const CLAIMER = 'mv-claimer-0002';
const GEN_A = 'ab'.repeat(32);

type Profile = Record<string, unknown> | null;
type Variant = { key: string; label: string; profile: Profile; fenced: boolean };

const ACTIVE: Profile = { username: 'ada', fullName: 'Ada', crowns: 0, status: 'Active', productAccessBlocked: false };
const VARIANTS: Variant[] = [
    { key: 'suspended', label: 'Suspended profile', profile: { ...ACTIVE, status: 'Suspended' }, fenced: false },
    { key: 'blocked', label: 'productAccessBlocked profile', profile: { ...ACTIVE, productAccessBlocked: true }, fenced: false },
    { key: 'fenced', label: 'lifecycle-fenced account (accountLifecycle present, profile still present)', profile: ACTIVE, fenced: true },
    { key: 'deleted', label: 'deleted profile + lifecycle fence (mid-deletion, token still valid)', profile: null, fenced: true },
];

let testEnv: RulesTestEnvironment;

function future(ms: number) { return Timestamp.fromMillis(Date.now() + ms); }

// The Oct 16 client stamps notices with the device clock (Timestamp.now()).
// Both rulesets require createdAt <= request.time, so a device clock even a few
// ms ahead of the emulator's clock is denied for a reason unrelated to the case
// under test (observed in t674u: the same Active cancel flipped between runs).
// The replicas stamp a device clock 1 s behind the server, inside the deployed
// 5-minute window, so each outcome depends only on the identity checks.
function deviceNow() { return Timestamp.fromMillis(Date.now() - 1_000); }

function availableSpot(extra: Record<string, unknown> = {}) {
    return {
        finderId: FINDER,
        finderName: 'Bea',
        address: '1 Mixed Version Way',
        lat: 40.7,
        lng: -74.0,
        type: 'free',
        status: 'available',
        pingMode: 'now',
        reportedAt: future(60_000),
        expiresAt: future(20 * 60_000),
        ...extra,
    };
}

async function seedWorld(spotId: string, claimerProfile: Profile, fenced: boolean, spot: Record<string, unknown>) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        await setDoc(doc(db, 'activeIncomingClaimRollout', 'status'), {
            enforced: true, locklessCount: 0, duplicateUserCount: 0, duplicatePingCount: 0,
        });
        await setDoc(doc(db, 'users', FINDER), { ...ACTIVE, username: 'bea', fullName: 'Bea' });
        if (claimerProfile) await setDoc(doc(db, 'users', CLAIMER), claimerProfile);
        if (fenced) {
            await setDoc(doc(db, 'accountLifecycle', CLAIMER), { decision: 'delete', fenceGeneration: 1, source: 'deleteAccount' });
            await setDoc(doc(db, 'accountLifecycle', FINDER), { decision: 'delete', fenceGeneration: 1, source: 'deleteAccount' });
        }
        await setDoc(doc(db, 'spots', spotId), spot);
    });
}

function claimantProfileFor(v: Variant): Record<string, unknown> {
    return (v.profile ?? ACTIVE) as Record<string, unknown>;
}

// 1ffeba94 acquireActiveIncomingClaim + useInterestFlow.claimerFields (immediate).
async function legacyClaim(uid: string, spotId: string, cached: Record<string, unknown>) {
    const db = testEnv.authenticatedContext(uid).firestore();
    const spotRef = doc(db, 'spots', spotId);
    const lockRef = doc(db, 'users', uid, 'activeIncomingClaims', 'current');
    return runTransaction(db, async (tx) => {
        const spotSnap = await tx.get(spotRef);
        await tx.get(lockRef);
        if (!spotSnap.exists()) throw new Error('missing');
        const spot = spotSnap.data() as Record<string, any>;
        if (spot.status === 'interested' && spot.interestedUserId === uid) return 'already_held';
        if (spot.status !== 'available') throw new Error('unavailable');
        const claimStartedAt = Timestamp.now();
        const fields = {
            status: 'interested',
            claimState: 'heading',
            ownerLeavingNow: null,
            interestedUserId: uid,
            interestedUserName: (cached.username as string) || (cached.fullName as string) || 'Someone',
            interestedUserVehicleColor: (cached.vehicleColor as string) || null,
            interestedUserVehicleType: (cached.vehicleType as string) || null,
            interestedUserVehicleBrand: (cached.vehicleBrand as string) || null,
            interestedUserTitle: 'Newcomer',
            claimStartedAt,
            etaMinutes: 4,
            interestExpiresAt: Timestamp.fromMillis(Date.now() + 9 * 60000),
        };
        tx.update(spotRef, fields);
        tx.set(lockRef, { spotId, claimStartedAt, claimState: 'heading', updatedAt: claimStartedAt });
        return 'claimed';
    });
}

// 1ffeba94 cancelClaimTransaction (claimer cancel, Arm 3, with the
// claimer_cancelled notice keyed by the claimStartedAt fingerprint).
async function legacyClaimerCancel(uid: string, spotId: string) {
    const db = testEnv.authenticatedContext(uid).firestore();
    const spotRef = doc(db, 'spots', spotId);
    return runTransaction(db, async (tx) => {
        const fresh = await tx.get(spotRef);
        if (!fresh.exists()) return 'already_resolved';
        const spot = fresh.data() as Record<string, any>;
        if (spot.interestedUserId !== uid) return 'stale_claim';
        const lockRef = doc(db, 'users', uid, 'activeIncomingClaims', 'current');
        const lockSnap = await tx.get(lockRef);
        const clearFields = {
            claimState: null, ownerLeavingNow: null, ownerLeavingNowAt: null,
            interestedUserId: null, interestedUserName: null, interestedUserVehicleColor: null,
            interestedUserVehicleType: null, interestedUserVehicleBrand: null, interestedUserTitle: null,
            etaMinutes: null, interestExpiresAt: null, claimReminderAt: null, claimReminderSentAt: null,
            claimAutoReleaseAt: null, claimAutoReleasedAt: null, claimStartedAt: null,
        };
        tx.update(spotRef, { ...clearFields, status: 'available' });
        if (lockSnap.exists() && lockSnap.data()?.spotId === spotId) tx.delete(lockRef);
        const fingerprint = spot.claimStartedAt?.toMillis?.() ?? 'x';
        tx.set(doc(db, 'spotNotifications', `claimer_cancelled_${spotId}_${fingerprint}`), {
            spotId, senderId: uid, targetUserId: spot.finderId, type: 'claimer_cancelled',
            message: 'The other driver canceled — your spot is available again.', createdAt: deviceNow(),
        });
        return 'cancelled';
    });
}

// 1ffeba94 useInterestFlow.handleCancelByFinder: 'cancelled' notice, then deleteDoc.
async function legacyFinderCancel(uid: string, spotId: string, claimant: string | null) {
    const db = testEnv.authenticatedContext(uid).firestore();
    if (claimant) {
        await addDoc(collection(db, 'spotNotifications'), {
            spotId, senderId: uid, targetUserId: claimant, type: 'cancelled',
            message: 'The driver had to cancel.', createdAt: deviceNow(),
        });
    }
    await deleteDoc(doc(db, 'spots', spotId));
}

function claimedSpot(extra: Record<string, unknown> = {}) {
    const started = Timestamp.fromMillis(Date.now() - 60_000);
    return availableSpot({
        status: 'interested',
        claimState: 'heading',
        interestedUserId: CLAIMER,
        interestedUserName: 'ada',
        interestedUserTitle: 'Newcomer',
        claimStartedAt: started,
        etaMinutes: 4,
        interestExpiresAt: future(9 * 60_000),
        ...extra,
    });
}

async function seedLock(uid: string, spotId: string, started: Timestamp) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'users', uid, 'activeIncomingClaims', 'current'), {
            spotId, claimStartedAt: started, claimState: 'heading', updatedAt: Timestamp.now(),
        });
    });
}

async function readSpot(spotId: string) {
    let data: Record<string, any> | null = null;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const snap = await getDoc(doc(ctx.firestore(), 'spots', spotId));
        data = snap.exists() ? (snap.data() as Record<string, any>) : null;
    });
    return data as Record<string, any> | null;
}

function suite(name: string, rulesText: () => string, isDeployed: boolean) {
    describe(name, () => {
        beforeAll(async () => {
            testEnv = await initializeTestEnvironment({
                projectId: PROJECT_ID,
                firestore: { rules: rulesText(), host: rulesEmulator.host, port: rulesEmulator.port },
            });
        });
        afterAll(async () => { await testEnv.cleanup(); });
        beforeEach(async () => { await testEnv.clearFirestore(); });

        if (isDeployed) {
            it('CHARACTERIZATION T1-C1: an Active old client claims and cancels directly (Arm 1 / Arm 3) under the deployed rules', async () => {
                await seedWorld('c1', ACTIVE, false, availableSpot());
                await expect(legacyClaim(CLAIMER, 'c1', ACTIVE as Record<string, unknown>)).resolves.toBe('claimed');
                await expect(legacyClaimerCancel(CLAIMER, 'c1')).resolves.toBe('cancelled');
                const spot = await readSpot('c1');
                expect(spot?.status).toBe('available');
                expect(spot?.interestedUserId).toBeNull();
            });

            it('CHARACTERIZATION T1-C2: an Active old finder deletes a claimed Ping directly and sends its own cancelled notice', async () => {
                await seedWorld('c2', ACTIVE, false, claimedSpot());
                await assertSucceeds(legacyFinderCancel(FINDER, 'c2', CLAIMER));
                expect(await readSpot('c2')).toBeNull();
            });

            it('CHARACTERIZATION T1-C3: the old claim write is denied when the rollout gate document is absent (functional, not security)', async () => {
                await seedWorld('c3', ACTIVE, false, availableSpot());
                await testEnv.withSecurityRulesDisabled(async (ctx) => {
                    await deleteDoc(doc(ctx.firestore(), 'activeIncomingClaimRollout', 'status'));
                });
                await assertFails(legacyClaim(CLAIMER, 'c3', ACTIVE as Record<string, unknown>));
            });

            it('CHARACTERIZATION T1-C4: an old-client claimer cancel of a callable-minted claim leaves claimGenerationId behind', async () => {
                await seedWorld('c4', ACTIVE, false, claimedSpot({ claimGenerationId: GEN_A }));
                await expect(legacyClaimerCancel(CLAIMER, 'c4')).resolves.toBe('cancelled');
                const spot = await readSpot('c4');
                expect(spot?.status).toBe('available');
                expect(spot?.interestedUserId).toBeNull();
                expect(spot?.claimGenerationId).toBe(GEN_A);
            });

            it('CHARACTERIZATION T1-C5: an old-client direct claim on a Ping with a leftover generation inherits that generation', async () => {
                await seedWorld('c5', ACTIVE, false, availableSpot({ claimGenerationId: GEN_A }));
                await expect(legacyClaim(CLAIMER, 'c5', ACTIVE as Record<string, unknown>)).resolves.toBe('claimed');
                const spot = await readSpot('c5');
                expect(spot?.interestedUserId).toBe(CLAIMER);
                expect(spot?.claimGenerationId).toBe(GEN_A);
            });
        } else {
            it('CHARACTERIZATION T1-H0: head rules deny the Oct 16 direct claim for an Active user (legacy client cutoff, A5)', async () => {
                await seedWorld('h0', ACTIVE, false, availableSpot());
                await assertFails(legacyClaim(CLAIMER, 'h0', ACTIVE as Record<string, unknown>));
            });
        }

        // SECURITY: old direct-write paths must not bypass suspension or the
        // server-side lifecycle fence. Each case is registered once per
        // variant; the deployed-ruleset outcomes that reproduce a bypass are
        // listed in BYPASS_EXPECTED below (filled from the executed run, not
        // assumed).
        for (const v of VARIANTS) {
            const caseIds = {
                claim: `T1-${isDeployed ? 'D' : 'H'}-CLAIM-${v.key}`,
                cancel: `T1-${isDeployed ? 'D' : 'H'}-CANCEL-${v.key}`,
                finder: `T1-${isDeployed ? 'D' : 'H'}-FINDER-${v.key}`,
            };
            const claimTitle = `SECURITY ${caseIds.claim}: old-client direct claim is denied for a ${v.label}`;
            const cancelTitle = `SECURITY ${caseIds.cancel}: old-client direct claimer cancel + notice is denied for a ${v.label}`;
            const finderTitle = `SECURITY ${caseIds.finder}: old-client finder delete of a claimed Ping + notice is denied for a ${v.label} finder`;

            register(caseIds.claim, claimTitle, async () => {
                await seedWorld(`cl-${v.key}`, v.profile, v.fenced, availableSpot());
                await assertFails(legacyClaim(CLAIMER, `cl-${v.key}`, claimantProfileFor(v)));
                expect((await readSpot(`cl-${v.key}`))?.interestedUserId ?? null).toBeNull();
            });

            register(caseIds.cancel, cancelTitle, async () => {
                const started = Timestamp.fromMillis(Date.now() - 60_000);
                await seedWorld(`cc-${v.key}`, v.profile, v.fenced, claimedSpot({ claimStartedAt: started }));
                await seedLock(CLAIMER, `cc-${v.key}`, started);
                await assertFails(legacyClaimerCancel(CLAIMER, `cc-${v.key}`));
            });

            register(caseIds.finder, finderTitle, async () => {
                await testEnv.withSecurityRulesDisabled(async (ctx) => {
                    await setDoc(doc(ctx.firestore(), 'users', CLAIMER), ACTIVE);
                });
                await seedWorld(`fd-${v.key}`, ACTIVE, false, claimedSpot());
                // The finder is the restricted actor in this case.
                await testEnv.withSecurityRulesDisabled(async (ctx) => {
                    const db = ctx.firestore();
                    await deleteDoc(doc(db, 'accountLifecycle', CLAIMER));
                    if (v.profile) await setDoc(doc(db, 'users', FINDER), { ...v.profile, username: 'bea', fullName: 'Bea' });
                    else await deleteDoc(doc(db, 'users', FINDER));
                    if (v.fenced) await setDoc(doc(db, 'accountLifecycle', FINDER), { decision: 'delete', fenceGeneration: 1 });
                    else await deleteDoc(doc(db, 'accountLifecycle', FINDER));
                });
                await assertFails(legacyFinderCancel(FINDER, `fd-${v.key}`, CLAIMER));
                expect(await readSpot(`fd-${v.key}`)).not.toBeNull();
            });
        }
    });
}

// Bypasses reproduced by the executed t674u run against the deployed ruleset.
// Each id here is a RELEASE BLOCKER. Do not remove an id to make the suite
// green; remove it only when the underlying rules path is fixed.
// Reproduced in the t674u runs (2026-11-11): each of
// these write batches SUCCEEDED under the deployed 134a97cf ruleset. T1-D-CLAIM-deleted
// is not listed: the deployed identity get() on the deleted profile denies it.
const BYPASS_EXPECTED = new Set<string>([
    'T1-D-CLAIM-suspended',
    'T1-D-CLAIM-blocked',
    'T1-D-CLAIM-fenced',
    'T1-D-CANCEL-suspended',
    'T1-D-CANCEL-blocked',
    'T1-D-CANCEL-fenced',
    'T1-D-CANCEL-deleted',
    'T1-D-FINDER-suspended',
    'T1-D-FINDER-blocked',
    'T1-D-FINDER-fenced',
    'T1-D-FINDER-deleted',
]);

// A BLOCKER case must fail for the reproduced reason only (the denied write
// succeeded). Any other error (setup, seeding, emulator) is logged and swallowed,
// so the inner fn returns and it.fails reports the case as broken instead of
// counting it as the reproduced blocker.
const BYPASS_SIGNATURE = /Expected request to fail, but it succeeded/;
function asBlocker(fn: () => Promise<void>) {
    return async () => {
        try {
            await fn();
        } catch (error) {
            if (BYPASS_SIGNATURE.test(String((error as Error)?.message ?? error))) throw error;
            console.error('BLOCKER case failed for an unexpected reason:', error);
            return;
        }
    };
}

function register(id: string, title: string, fn: () => Promise<void>) {
    if (BYPASS_EXPECTED.has(id)) it.fails(`BLOCKER[${id}] ${title}`, asBlocker(fn));
    else it(title, fn);
}

suite('T1 legacy direct writes vs DEPLOYED production rules (134a97cf)', readDeployedRules, true);
suite('T1 legacy direct writes vs HEAD candidate firestore.rules (unpublished)', () => readFileSync('firestore.rules', 'utf8'), false);
