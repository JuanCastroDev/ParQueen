/**
 * S7 INTERIM LEGACY-HARDENED RULES PROOF (t680u). LOCAL EMULATOR ONLY.
 *
 * Exercises the NONDEPLOYABLE candidate
 *   test-fixtures/interim-candidate/firestore.interim-legacy-hardened.rules
 * which starts from the verified deployed snapshot
 *   test-fixtures/production-baseline/deployed-firestore-134a97cf.rules
 * and adds fail-closed account-state checks to the legacy Ping write paths.
 * It is not main's firestore.rules and no deploy path references it.
 *
 * Old-client write shapes replicate the live-bundle source commit
 * 1ffeba94a09d01247c5d960aa3c4ff0672a8432e:
 *   views/street-parking/activeIncomingClaim.ts    (claim, arrival)
 *   views/street-parking/cancelClaimTransaction.ts (claimer cancel + notice)
 *   views/street-parking/useInterestFlow.ts        (finder cancel, delayed/owner_leaving_now notices)
 *   views/street-parking/pingCreateBounds.ts       (Ping + quota + origin marker)
 *   utils/spotFeedback.ts                          (failure / participant_success docs)
 * The claim/cancel/finder replicas are byte-for-byte the logic of the t674u
 * T1 harness (firestore.rules.test.mixed-version-deployed.ts), which stays
 * unchanged with its 11 historical expected failures.
 *
 * The rollout gate activeIncomingClaimRollout/status is SEEDED. Its
 * production value was not read (not authorized).
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
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
    updateDoc,
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
const CANDIDATE_RULES_PATH = 'test-fixtures/interim-candidate/firestore.interim-legacy-hardened.rules';

function readDeployedRules(): string {
    const bytes = readFileSync(DEPLOYED_RULES_PATH);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== DEPLOYED_RULES_SHA256) throw new Error(`Deployed rules snapshot digest mismatch: ${digest}`);
    return bytes.toString('utf8');
}

function readCandidateRules(): string {
    const text = readFileSync(CANDIDATE_RULES_PATH, 'utf8');
    if (!text.startsWith('// ====') || !text.includes('NONDEPLOYABLE')) {
        throw new Error('Candidate rules lost the NONDEPLOYABLE header');
    }
    console.log(`[t680u] candidate sha256 ${createHash('sha256').update(text).digest('hex')}`);
    return text;
}

const FINDER = 'mv-finder-0001';
const CLAIMER = 'mv-claimer-0002';
const OTHER = 'mv-other-0003';
const GEN_A = 'ab'.repeat(32);

type Profile = Record<string, unknown> | null;
type Variant = { key: string; label: string; profile: Profile; fenced: boolean };

const ACTIVE: Record<string, unknown> = { username: 'ada', fullName: 'Ada', crowns: 0, status: 'Active', productAccessBlocked: false };
const FINDER_ACTIVE: Record<string, unknown> = { ...ACTIVE, username: 'bea', fullName: 'Bea' };
const VARIANTS: Variant[] = [
    { key: 'suspended', label: 'Suspended profile', profile: { ...ACTIVE, status: 'Suspended' }, fenced: false },
    { key: 'blocked', label: 'productAccessBlocked profile', profile: { ...ACTIVE, productAccessBlocked: true }, fenced: false },
    { key: 'fenced', label: 'lifecycle-fenced account (profile still present)', profile: ACTIVE, fenced: true },
    { key: 'deleted', label: 'deleted profile + lifecycle fence (token still valid)', profile: null, fenced: true },
];
const EXTRA_VARIANTS: Variant[] = [
    { key: 'blocked-malformed', label: 'productAccessBlocked malformed ("yes")', profile: { ...ACTIVE, productAccessBlocked: 'yes' }, fenced: false },
    { key: 'deleted-unfenced', label: 'deleted profile, no fence (token still valid)', profile: null, fenced: false },
];

let testEnv: RulesTestEnvironment;

function future(ms: number) { return Timestamp.fromMillis(Date.now() + ms); }
function past(ms: number) { return Timestamp.fromMillis(Date.now() - ms); }
// Device clock 1 s behind the emulator (see the t674u T1 harness note).
function deviceNow() { return Timestamp.fromMillis(Date.now() - 1_000); }

function availableSpot(extra: Record<string, unknown> = {}) {
    return {
        finderId: FINDER, finderName: 'bea', address: '1 Mixed Version Way',
        lat: 40.7, lng: -74.0, type: 'free', status: 'available', pingMode: 'now',
        reportedAt: future(60_000), expiresAt: future(20 * 60_000), ...extra,
    };
}

function claimedSpot(extra: Record<string, unknown> = {}) {
    return availableSpot({
        status: 'interested', claimState: 'heading', interestedUserId: CLAIMER,
        interestedUserName: 'ada', interestedUserTitle: 'Newcomer',
        claimStartedAt: past(60_000), etaMinutes: 4, interestExpiresAt: future(9 * 60_000), ...extra,
    });
}

function arrivedSpot(extra: Record<string, unknown> = {}) {
    return claimedSpot({ status: 'occupied', claimState: 'arrived_pending_outcome', arrivedAt: past(30_000), ...extra });
}

async function seedBase(spots: Record<string, Record<string, unknown>>, gate = true) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        if (gate) {
            await setDoc(doc(db, 'activeIncomingClaimRollout', 'status'), {
                enforced: true, locklessCount: 0, duplicateUserCount: 0, duplicatePingCount: 0,
            });
        }
        await setDoc(doc(db, 'users', FINDER), FINDER_ACTIVE);
        await setDoc(doc(db, 'users', CLAIMER), ACTIVE);
        for (const [id, data] of Object.entries(spots)) await setDoc(doc(db, 'spots', id), data);
    });
}

// Puts one actor into the restricted state. Everyone else stays Active.
async function applyActor(uid: string, v: Variant) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        const base = uid === FINDER ? { username: 'bea', fullName: 'Bea' } : {};
        if (v.profile) await setDoc(doc(db, 'users', uid), { ...v.profile, ...base });
        else await deleteDoc(doc(db, 'users', uid));
        if (v.fenced) await setDoc(doc(db, 'accountLifecycle', uid), { decision: 'delete', fenceGeneration: 1, source: 'deleteAccount' });
    });
}

async function seedLock(uid: string, spotId: string, started: Timestamp) {
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
        await setDoc(doc(ctx.firestore(), 'users', uid, 'activeIncomingClaims', 'current'), {
            spotId, claimStartedAt: started, claimState: 'heading', updatedAt: Timestamp.now(),
        });
    });
}

async function readDoc(path: string[]) {
    let data: Record<string, any> | null = null;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const snap = await getDoc(doc(ctx.firestore(), path[0], ...path.slice(1)));
        data = snap.exists() ? (snap.data() as Record<string, any>) : null;
    });
    return data as Record<string, any> | null;
}
const readSpot = (id: string) => readDoc(['spots', id]);

// ── 1ffeba94 replicas ───────────────────────────────────────────────────────

// activeIncomingClaim.acquireActiveIncomingClaim + useInterestFlow.claimerFields.
async function legacyClaim(uid: string, spotId: string, cached: Record<string, unknown>, claimState: 'heading' | 'committed' = 'heading') {
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
            claimState,
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
        tx.set(lockRef, { spotId, claimStartedAt, claimState, updatedAt: claimStartedAt });
        return 'claimed';
    });
}

// cancelClaimTransaction (Arm 3 / 3b + claimer_cancelled notice).
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
        const expired = spot.expiresAt?.toMillis?.() != null && spot.expiresAt.toMillis() <= Date.now();
        tx.update(spotRef, expired ? clearFields : { ...clearFields, status: 'available' });
        if (lockSnap.exists() && lockSnap.data()?.spotId === spotId) tx.delete(lockRef);
        const fingerprint = spot.claimStartedAt?.toMillis?.() ?? 'x';
        tx.set(doc(db, 'spotNotifications', `claimer_cancelled_${spotId}_${fingerprint}`), {
            spotId, senderId: uid, targetUserId: spot.finderId, type: 'claimer_cancelled',
            message: 'The other driver canceled — your spot is available again.', createdAt: deviceNow(),
        });
        return 'cancelled';
    });
}

// useInterestFlow.handleCancelByFinder: 'cancelled' notice, then deleteDoc.
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

// activeIncomingClaim.markClaimerArrived (Arm 4 + lock delete).
async function legacyArrival(uid: string, spotId: string) {
    const db = testEnv.authenticatedContext(uid).firestore();
    const spotRef = doc(db, 'spots', spotId);
    const lockRef = doc(db, 'users', uid, 'activeIncomingClaims', 'current');
    return runTransaction(db, async (tx) => {
        const spotSnap = await tx.get(spotRef);
        const lockSnap = await tx.get(lockRef);
        if (!spotSnap.exists()) throw new Error('missing');
        tx.update(spotRef, { status: 'occupied', claimState: 'arrived_pending_outcome', arrivedAt: Timestamp.now() });
        if (lockSnap.exists() && lockSnap.data()?.spotId === spotId) tx.delete(lockRef);
        return 'arrived';
    });
}

// pingCreateBounds.commitPingCreate (Ping + quota + optional origin marker).
async function legacyPingCreate(uid: string, spotId: string, finderName: string, originSpotId: string | null = null) {
    const db = testEnv.authenticatedContext(uid).firestore();
    const spotRef = doc(db, 'spots', spotId);
    const rateRef = doc(db, 'users', uid, 'pingCreateRate', 'current');
    const originRef = originSpotId ? doc(db, 'originRePings', originSpotId) : null;
    const data: Record<string, unknown> = {
        lat: 40.71, lng: -74.01, type: 'free', status: 'available', finderId: uid, finderName,
        pingMode: 'now', reportedAt: deviceNow(), expiresAt: future(20 * 60_000),
        geohash: 'dr5regw', address: '2 Legacy Lane',
    };
    if (originSpotId) data.originSpotId = originSpotId;
    await runTransaction(db, async (tx) => {
        const rateSnap = await tx.get(rateRef);
        const originSnap = originRef ? await tx.get(originRef) : null;
        if (originSnap?.exists()) throw new Error('origin');
        const now = Timestamp.now();
        const prevIds = rateSnap.exists() ? (rateSnap.data().spotIds as string[]) : [];
        const prevAts = rateSnap.exists() ? (rateSnap.data().createdAts as Timestamp[]) : [];
        tx.set(spotRef, data);
        tx.set(rateRef, { spotIds: [...prevIds, spotId], createdAts: [...prevAts, now] });
        if (originRef) tx.set(originRef, { rePingSpotId: spotId, finderId: uid, createdAt: now });
    });
}

// HandoffFlow claimer failure doc ({spotId}_{claimerId}).
async function legacyClaimerFailure(uid: string, spotId: string) {
    const db = testEnv.authenticatedContext(uid).firestore();
    await setDoc(doc(db, 'spotFeedback', `${spotId}_${uid}`), {
        spotId, userId: uid, finderId: FINDER, outcome: 'failed', failureReason: 'Other',
        address: '1 Mixed Version Way', createdAt: deviceNow(),
    });
}

// attestParticipantSuccess via buildParticipantSuccessAttestation.
async function legacyAttestation(uid: string, spotId: string, role: 'claimer' | 'finder') {
    const db = testEnv.authenticatedContext(uid).firestore();
    const id = role === 'finder' ? `${spotId}_${CLAIMER}_finder` : `${spotId}_${CLAIMER}`;
    await setDoc(doc(db, 'spotFeedback', id), {
        spotId, userId: CLAIMER, finderId: FINDER, outcome: 'participant_success', role,
        failureReason: null, address: '1 Mixed Version Way', createdAt: deviceNow(),
    });
}

async function legacyNotice(uid: string, spotId: string, target: string, type: string) {
    const db = testEnv.authenticatedContext(uid).firestore();
    await addDoc(collection(db, 'spotNotifications'), {
        spotId, senderId: uid, targetUserId: target, type, message: `legacy ${type}`, createdAt: deviceNow(),
    });
}

function spotUpdate(uid: string, spotId: string, fields: Record<string, unknown>) {
    return updateDoc(doc(testEnv.authenticatedContext(uid).firestore(), 'spots', spotId), fields);
}

function carLocation(uid: string, owner = uid) {
    return doc(testEnv.authenticatedContext(uid).firestore(), 'users', owner, 'private', 'carLocation');
}
const CAR = () => ({ verification: 'UNVERIFIED', approximate: true, lat: 40.7, lng: -74, accuracyMeters: 25, savedAt: Timestamp.now() });

// A single named direct-write path. seed() runs with every user Active;
// the acting user is restricted (or not) before write().
type PathCase = {
    id: string;
    actor: 'claimer' | 'finder';
    seed: () => Promise<void>;
    write: () => Promise<unknown>;
    deployedDeletedDenied?: boolean;
};
const NEW_PATHS: PathCase[] = [
    {
        id: 'PING-CREATE', actor: 'finder', deployedDeletedDenied: true,
        seed: () => seedBase({}),
        write: () => legacyPingCreate(FINDER, 'np-create', 'bea'),
    },
    {
        id: 'REPING', actor: 'claimer', deployedDeletedDenied: true,
        seed: () => seedBase({ 'np-origin': arrivedSpot() }),
        write: () => legacyPingCreate(CLAIMER, 'np-reping', 'ada', 'np-origin'),
    },
    {
        id: 'ETA', actor: 'claimer',
        seed: () => seedBase({ 'np-eta': claimedSpot() }),
        write: () => spotUpdate(CLAIMER, 'np-eta', { etaMinutes: 7 }),
    },
    {
        id: 'HEADING', actor: 'claimer',
        seed: () => seedBase({ 'np-head': claimedSpot({ claimState: 'committed' }) }),
        write: () => spotUpdate(CLAIMER, 'np-head', { claimState: 'heading', etaMinutes: 5 }),
    },
    {
        id: 'ARRIVAL', actor: 'claimer',
        seed: async () => {
            const started = past(60_000);
            await seedBase({ 'np-arr': claimedSpot({ claimStartedAt: started }) });
            await seedLock(CLAIMER, 'np-arr', started);
        },
        write: () => legacyArrival(CLAIMER, 'np-arr'),
    },
    {
        id: 'FEEDBACK-FAILED', actor: 'claimer',
        seed: () => seedBase({ 'np-fail': claimedSpot({ status: 'occupied' }) }),
        write: () => legacyClaimerFailure(CLAIMER, 'np-fail'),
    },
    {
        id: 'ATTEST-CLAIMER', actor: 'claimer',
        seed: () => seedBase({ 'np-att': arrivedSpot() }),
        write: () => legacyAttestation(CLAIMER, 'np-att', 'claimer'),
    },
    {
        id: 'ATTEST-FINDER', actor: 'finder',
        seed: () => seedBase({ 'np-attf': arrivedSpot() }),
        write: () => legacyAttestation(FINDER, 'np-attf', 'finder'),
    },
    {
        id: 'FINDER-CONFIRM', actor: 'finder',
        seed: () => seedBase({ 'np-conf': claimedSpot() }),
        write: () => spotUpdate(FINDER, 'np-conf', { status: 'occupied' }),
    },
    {
        id: 'FINDER-EXTEND', actor: 'finder',
        seed: () => seedBase({ 'np-ext': claimedSpot() }),
        write: () => spotUpdate(FINDER, 'np-ext', { interestExpiresAt: future(15 * 60_000) }),
    },
    {
        id: 'FINDER-LEAVING', actor: 'finder',
        seed: () => seedBase({ 'np-leave': claimedSpot() }),
        write: () => spotUpdate(FINDER, 'np-leave', { ownerLeavingNow: true, ownerLeavingNowAt: Timestamp.now(), claimAutoReleaseAt: future(10 * 60_000) }),
    },
    {
        id: 'NOTICE-LEAVING', actor: 'finder',
        seed: () => seedBase({ 'np-leaven': claimedSpot() }),
        write: () => legacyNotice(FINDER, 'np-leaven', CLAIMER, 'owner_leaving_now'),
    },
    {
        id: 'NOTICE-DELAYED', actor: 'claimer',
        seed: () => seedBase({ 'np-delay': claimedSpot() }),
        write: () => legacyNotice(CLAIMER, 'np-delay', FINDER, 'delayed'),
    },
    {
        id: 'FINDER-DELETE-UNCLAIMED', actor: 'finder',
        seed: () => seedBase({ 'np-del': availableSpot() }),
        write: () => deleteDoc(doc(testEnv.authenticatedContext(FINDER).firestore(), 'spots', 'np-del')),
    },
    {
        id: 'LOCK-DELETE', actor: 'claimer',
        seed: async () => {
            await seedBase({ 'np-lock': availableSpot() });
            await seedLock(CLAIMER, 'np-lock', past(60_000));
        },
        write: () => deleteDoc(doc(testEnv.authenticatedContext(CLAIMER).firestore(), 'users', CLAIMER, 'activeIncomingClaims', 'current')),
    },
];

const actorOf = (p: PathCase) => (p.actor === 'finder' ? FINDER : CLAIMER);

function withEnv(name: string, rulesText: () => string, body: () => void) {
    describe(name, () => {
        beforeAll(async () => {
            testEnv = await initializeTestEnvironment({
                projectId: PROJECT_ID,
                firestore: { rules: rulesText(), host: rulesEmulator.host, port: rulesEmulator.port },
            });
        });
        afterAll(async () => { await testEnv.cleanup(); });
        beforeEach(async () => { await testEnv.clearFirestore(); });
        body();
    });
}

describe('t680u candidate file guards (no deploy path)', () => {
    it('GUARD I-G1: the candidate carries the NONDEPLOYABLE header and is not main firestore.rules', () => {
        const candidate = readCandidateRules();
        expect(candidate.split('\n')[1]).toContain('NONDEPLOYABLE');
        expect(candidate).not.toBe(readFileSync('firestore.rules', 'utf8'));
        expect(createHash('sha256').update(readFileSync(DEPLOYED_RULES_PATH)).digest('hex')).toBe(DEPLOYED_RULES_SHA256);
    });

    it('GUARD I-G2: firebase.json still targets firestore.rules and no root config, script or workflow references interim-candidate', () => {
        const fb = JSON.parse(readFileSync('firebase.json', 'utf8'));
        const targets = ([] as any[]).concat(fb.firestore ?? []).map((t) => t.rules);
        expect(targets).toEqual(['firestore.rules']);
        const scanned: string[] = [];
        const scan = (dir: string, filter: (f: string) => boolean) => {
            for (const f of readdirSync(dir)) {
                if (!filter(f)) continue;
                const p = dir === '.' ? f : `${dir}/${f}`;
                scanned.push(p);
                expect(readFileSync(p, 'utf8'), p).not.toContain('interim-candidate');
            }
        };
        scan('.', (f) => /^(firebase.*\.json|\.firebaserc|package\.json|apphosting.*\.ya?ml)$/.test(f));
        scan('.github/workflows', (f) => /\.ya?ml$/.test(f));
        scan('scripts/ci', (f) => /\.(m?js|sh|json)$/.test(f));
        expect(scanned.length).toBeGreaterThan(3);
    });
});

withEnv('t680u INTERIM candidate: the 11 T1 bypasses and CLAIM-deleted are denied', readCandidateRules, () => {
    for (const v of [...VARIANTS, ...EXTRA_VARIANTS]) {
        it(`SECURITY T1-I-CLAIM-${v.key}: old-client direct claim is denied for a ${v.label}`, async () => {
            await seedBase({ [`cl-${v.key}`]: availableSpot() });
            await applyActor(CLAIMER, v);
            await assertFails(legacyClaim(CLAIMER, `cl-${v.key}`, ACTIVE));
            const spot = await readSpot(`cl-${v.key}`);
            expect(spot?.status).toBe('available');
            expect(spot?.interestedUserId ?? null).toBeNull();
            expect(await readDoc(['users', CLAIMER, 'activeIncomingClaims', 'current'])).toBeNull();
        });

        it(`SECURITY T1-I-CANCEL-${v.key}: old-client claimer cancel + notice is denied for a ${v.label}`, async () => {
            const started = past(60_000);
            await seedBase({ [`cc-${v.key}`]: claimedSpot({ claimStartedAt: started }) });
            await seedLock(CLAIMER, `cc-${v.key}`, started);
            await applyActor(CLAIMER, v);
            await assertFails(legacyClaimerCancel(CLAIMER, `cc-${v.key}`));
            expect((await readSpot(`cc-${v.key}`))?.interestedUserId).toBe(CLAIMER);
            expect(await readDoc(['spotNotifications', `claimer_cancelled_cc-${v.key}_${started.toMillis()}`])).toBeNull();
        });

        it(`SECURITY T1-I-FINDER-${v.key}: old-client finder delete of a claimed Ping + notice is denied for a ${v.label} finder`, async () => {
            await seedBase({ [`fd-${v.key}`]: claimedSpot() });
            await applyActor(FINDER, v);
            await assertFails(legacyFinderCancel(FINDER, `fd-${v.key}`, CLAIMER));
            expect(await readSpot(`fd-${v.key}`)).not.toBeNull();
        });

        it(`SECURITY T1-I-FINDERDEL-${v.key}: a bare finder deleteDoc (no notice) is denied for a ${v.label} finder`, async () => {
            await seedBase({ [`fx-${v.key}`]: claimedSpot() });
            await applyActor(FINDER, v);
            await assertFails(deleteDoc(doc(testEnv.authenticatedContext(FINDER).firestore(), 'spots', `fx-${v.key}`)));
        });
    }
});

withEnv('t680u INTERIM candidate: Active old-client behavior is preserved', readCandidateRules, () => {
    it('COMPAT I-A1: Active old client claims (immediate, Arm 1 + lock) and cancels (Arm 3 + lock delete + notice)', async () => {
        await seedBase({ a1: availableSpot() });
        await expect(legacyClaim(CLAIMER, 'a1', ACTIVE)).resolves.toBe('claimed');
        const lock = await readDoc(['users', CLAIMER, 'activeIncomingClaims', 'current']);
        expect(lock?.spotId).toBe('a1');
        const claimed = await readSpot('a1');
        await expect(legacyClaimerCancel(CLAIMER, 'a1')).resolves.toBe('cancelled');
        const spot = await readSpot('a1');
        expect(spot?.status).toBe('available');
        expect(spot?.interestedUserId).toBeNull();
        expect(await readDoc(['users', CLAIMER, 'activeIncomingClaims', 'current'])).toBeNull();
        expect(await readDoc(['spotNotifications', `claimer_cancelled_a1_${claimed?.claimStartedAt.toMillis()}`])).not.toBeNull();
    });

    it('COMPAT I-A2: Active old client scheduled claim (committed) then commits to heading (Arm 2b) and updates ETA (Arm 2)', async () => {
        await seedBase({ a2: availableSpot({ pingMode: 'later' }) });
        await expect(legacyClaim(CLAIMER, 'a2', ACTIVE, 'committed')).resolves.toBe('claimed');
        await assertSucceeds(spotUpdate(CLAIMER, 'a2', { claimState: 'heading', etaMinutes: 6 }));
        await assertSucceeds(spotUpdate(CLAIMER, 'a2', { etaMinutes: 3 }));
        expect((await readSpot('a2'))?.claimState).toBe('heading');
    });

    it('COMPAT I-A3: Active old claimer cancels a claim on an expired Ping (Arm 3b) without reopening it', async () => {
        const started = past(60_000);
        await seedBase({ a3: claimedSpot({ claimStartedAt: started, expiresAt: past(5_000) }) });
        await seedLock(CLAIMER, 'a3', started);
        await expect(legacyClaimerCancel(CLAIMER, 'a3')).resolves.toBe('cancelled');
        const spot = await readSpot('a3');
        expect(spot?.status).toBe('interested');
        expect(spot?.interestedUserId).toBeNull();
    });

    it('COMPAT I-A4: Active old finder deletes a claimed Ping and sends its cancelled notice', async () => {
        await seedBase({ a4: claimedSpot() });
        await assertSucceeds(legacyFinderCancel(FINDER, 'a4', CLAIMER));
        expect(await readSpot('a4')).toBeNull();
    });

    it('COMPAT I-A5: Active old finder deletes an unclaimed Ping', async () => {
        await seedBase({ a5: availableSpot() });
        await assertSucceeds(legacyFinderCancel(FINDER, 'a5', null));
    });

    for (const p of NEW_PATHS) {
        it(`COMPAT I-A-${p.id}: an Active old client still succeeds on ${p.id}`, async () => {
            await p.seed();
            await assertSucceeds(p.write());
        });
    }

    it('COMPAT I-A6: arrival on a claim with no lock (legacy claim) still succeeds and full handoff attests on both sides', async () => {
        await seedBase({ a6: claimedSpot() });
        await expect(legacyArrival(CLAIMER, 'a6')).resolves.toBe('arrived');
        await assertSucceeds(legacyAttestation(CLAIMER, 'a6', 'claimer'));
        await assertSucceeds(legacyAttestation(FINDER, 'a6', 'finder'));
    });

    it('COMPAT I-A7: a second Ping in the same rolling hour carries the quota (pingCreateRate update path)', async () => {
        await seedBase({});
        await assertSucceeds(legacyPingCreate(FINDER, 'q1', 'bea'));
        await assertSucceeds(legacyPingCreate(FINDER, 'q2', 'bea'));
        expect((await readDoc(['users', FINDER, 'pingCreateRate', 'current']))?.spotIds).toEqual(['q1', 'q2']);
    });

    it('COMPAT I-A8: a profile without status or productAccessBlocked fields (pre-S7 profile) keeps legacy access', async () => {
        await seedBase({ a8: availableSpot() });
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            await setDoc(doc(ctx.firestore(), 'users', CLAIMER), { username: 'ada', fullName: 'Ada', crowns: 0 });
        });
        await expect(legacyClaim(CLAIMER, 'a8', ACTIVE)).resolves.toBe('claimed');
        await expect(legacyClaimerCancel(CLAIMER, 'a8')).resolves.toBe('cancelled');
    });

    it('COMPAT I-A9: the rollout gate dependency is unchanged — gate absent denies, gate open allows', async () => {
        await seedBase({ a9: availableSpot() }, false);
        await assertFails(legacyClaim(CLAIMER, 'a9', ACTIVE));
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            await setDoc(doc(ctx.firestore(), 'activeIncomingClaimRollout', 'status'), {
                enforced: true, locklessCount: 0, duplicateUserCount: 0, duplicatePingCount: 0,
            });
        });
        await expect(legacyClaim(CLAIMER, 'a9', ACTIVE)).resolves.toBe('claimed');
    });

    it('COMPAT I-A10: another user\'s fence or suspension does not block an Active actor (finder suspended, claimer Active cancels)', async () => {
        const started = past(60_000);
        await seedBase({ a10: claimedSpot({ claimStartedAt: started }) });
        await seedLock(CLAIMER, 'a10', started);
        await applyActor(FINDER, VARIANTS[0]);
        await testEnv.withSecurityRulesDisabled(async (ctx) => {
            await setDoc(doc(ctx.firestore(), 'accountLifecycle', FINDER), { decision: 'delete', fenceGeneration: 1 });
        });
        await expect(legacyClaimerCancel(CLAIMER, 'a10')).resolves.toBe('cancelled');
    });
});

withEnv('t680u INTERIM candidate: newly found direct-write paths are denied for restricted accounts', readCandidateRules, () => {
    for (const p of NEW_PATHS) {
        for (const v of VARIANTS) {
            it(`SECURITY NEW-I-${p.id}-${v.key}: ${p.actor} ${p.id} is denied for a ${v.label}`, async () => {
                await p.seed();
                await applyActor(actorOf(p), v);
                await assertFails(p.write());
            });
        }
    }
});

withEnv('t680u DEPLOYED snapshot characterization of the newly found paths (not a contract)', readDeployedRules, () => {
    for (const p of NEW_PATHS) {
        for (const v of VARIANTS) {
            const deniedAnyway = v.key === 'deleted' && p.deployedDeletedDenied === true;
            it(`CHARACTERIZATION NEW-D-${p.id}-${v.key}: deployed rules ${deniedAnyway ? 'deny' : 'ALLOW'} ${p.actor} ${p.id} for a ${v.label}`, async () => {
                await p.seed();
                await applyActor(actorOf(p), v);
                if (deniedAnyway) await assertFails(p.write());
                else await assertSucceeds(p.write());
            });
        }
    }
});

withEnv('t680u INTERIM candidate: generation-bearing claims and old clients', readCandidateRules, () => {
    it('GENERATION I-GEN1: an old-client direct claim on a Ping with a leftover claimGenerationId is denied (no inheritance)', async () => {
        await seedBase({ g1: availableSpot({ claimGenerationId: GEN_A }) });
        await assertFails(legacyClaim(CLAIMER, 'g1', ACTIVE));
        const spot = await readSpot('g1');
        expect(spot?.interestedUserId ?? null).toBeNull();
        expect(spot?.claimGenerationId).toBe(GEN_A);
    });

    it('GENERATION I-GEN2: an old-client claimer cancel of a callable-minted claim is denied (generation not stranded)', async () => {
        const started = past(60_000);
        await seedBase({ g2: claimedSpot({ claimStartedAt: started, claimGenerationId: GEN_A }) });
        await seedLock(CLAIMER, 'g2', started);
        await assertFails(legacyClaimerCancel(CLAIMER, 'g2'));
        const spot = await readSpot('g2');
        expect(spot?.interestedUserId).toBe(CLAIMER);
        expect(spot?.claimGenerationId).toBe(GEN_A);
    });

    it('GENERATION I-GEN3: an old-client claimer cancel of an expired callable-minted claim (Arm 3b) is denied', async () => {
        await seedBase({ g3: claimedSpot({ expiresAt: past(5_000), claimGenerationId: GEN_A }) });
        await assertFails(legacyClaimerCancel(CLAIMER, 'g3'));
    });

    it('GENERATION I-GEN4: an Active old finder may still delete a callable-minted claimed Ping (finder authority; deployed trigger handles cleanup)', async () => {
        await seedBase({ g4: claimedSpot({ claimGenerationId: GEN_A }) });
        await assertSucceeds(legacyFinderCancel(FINDER, 'g4', CLAIMER));
    });

    it('GENERATION I-GEN5: an Active old claimer may arrive on a callable-minted claim; the generation is untouched', async () => {
        await seedBase({ g5: claimedSpot({ claimGenerationId: GEN_A }) });
        await expect(legacyArrival(CLAIMER, 'g5')).resolves.toBe('arrived');
        expect((await readSpot('g5'))?.claimGenerationId).toBe(GEN_A);
    });

    it('GENERATION I-GEN6: an old client cannot write or clear claimGenerationId through any legacy arm', async () => {
        await seedBase({ g6: claimedSpot({ claimGenerationId: GEN_A }), g6b: availableSpot() });
        await assertFails(spotUpdate(CLAIMER, 'g6', { claimGenerationId: null }));
        await assertFails(spotUpdate(CLAIMER, 'g6', { etaMinutes: 5, claimGenerationId: 'cd'.repeat(32) }));
        await assertFails(spotUpdate(FINDER, 'g6', { claimGenerationId: null }));
        await assertFails(legacyClaimWithGeneration(CLAIMER, 'g6b'));
    });

    it('GENERATION I-GEN7: a Ping whose claimGenerationId is explicitly null is claimable and cancellable by an Active old client', async () => {
        await seedBase({ g7: availableSpot({ claimGenerationId: null }) });
        await expect(legacyClaim(CLAIMER, 'g7', ACTIVE)).resolves.toBe('claimed');
        await expect(legacyClaimerCancel(CLAIMER, 'g7')).resolves.toBe('cancelled');
    });

    it('GENERATION I-GEN8: a suspended claimer cannot cancel or arrive on a callable-minted claim', async () => {
        await seedBase({ g8: claimedSpot({ claimGenerationId: GEN_A }) });
        await applyActor(CLAIMER, VARIANTS[0]);
        await assertFails(legacyClaimerCancel(CLAIMER, 'g8'));
        await assertFails(legacyArrival(CLAIMER, 'g8'));
    });
});

// A forged claim that also tries to mint a generation in the same write.
async function legacyClaimWithGeneration(uid: string, spotId: string) {
    const db = testEnv.authenticatedContext(uid).firestore();
    const claimStartedAt = Timestamp.now();
    return runTransaction(db, async (tx) => {
        tx.update(doc(db, 'spots', spotId), {
            status: 'interested', claimState: 'heading', interestedUserId: uid, interestedUserName: 'ada',
            interestedUserTitle: 'Newcomer', claimStartedAt, etaMinutes: 4,
            interestExpiresAt: future(9 * 60_000), claimGenerationId: 'cd'.repeat(32),
        });
        tx.set(doc(db, 'users', uid, 'activeIncomingClaims', 'current'), {
            spotId, claimStartedAt, claimState: 'heading', updatedAt: claimStartedAt,
        });
    });
}

withEnv('t680u INTERIM candidate: carLocation, onboarding and unrelated access are unchanged', readCandidateRules, () => {
    it('COMPAT I-CAR1: Active owner creates, updates, reads and deletes private/carLocation', async () => {
        await seedBase({});
        await assertSucceeds(setDoc(carLocation(CLAIMER), CAR()));
        await assertSucceeds(setDoc(carLocation(CLAIMER), { ...CAR(), lat: 40.8 }));
        await assertSucceeds(getDoc(carLocation(CLAIMER)));
        await assertSucceeds(deleteDoc(carLocation(CLAIMER)));
    });

    it('COMPAT I-CAR2: carLocation stays owner-only and schema-bound', async () => {
        await seedBase({});
        await assertFails(setDoc(carLocation(OTHER, CLAIMER), CAR()));
        await assertFails(getDoc(carLocation(OTHER, CLAIMER)));
        await assertFails(setDoc(carLocation(CLAIMER), { ...CAR(), verification: 'VERIFIED' }));
        await assertFails(setDoc(carLocation(CLAIMER), { ...CAR(), curbId: 'x' }));
    });

    it('CHARACTERIZATION I-CAR3: carLocation is self-scoped and NOT gated by the interim candidate (a Suspended owner can still save it; main gates it)', async () => {
        await seedBase({});
        await applyActor(CLAIMER, VARIANTS[0]);
        await assertSucceeds(setDoc(carLocation(CLAIMER), CAR()));
    });

    it('COMPAT I-ONB1: a signed-in user with no profile yet (onboarding) keeps preferences, userLocations, profile reads and the public feed', async () => {
        await seedBase({ onb: availableSpot() });
        const db = testEnv.authenticatedContext(OTHER).firestore();
        await assertSucceeds(setDoc(doc(db, 'users', OTHER, 'private', 'preferences'), { lang: 'en', notificationsEnabled: true }));
        await assertSucceeds(setDoc(doc(db, 'userLocations', OTHER), { lastGeohash: 'dr5re', lastGeohashUpdatedAt: Timestamp.now() }));
        await assertSucceeds(setDoc(carLocation(OTHER), CAR()));
        await assertSucceeds(getDoc(doc(db, 'users', FINDER)));
        await assertSucceeds(getDoc(doc(db, 'spots', 'onb')));
        await assertFails(setDoc(doc(db, 'users', OTHER), { username: 'new' }));
    });

    it('COMPAT I-ONB2: an Active user can still edit vehicle fields and read their Pings', async () => {
        await seedBase({ onb2: claimedSpot() });
        const db = testEnv.authenticatedContext(CLAIMER).firestore();
        await assertSucceeds(updateDoc(doc(db, 'users', CLAIMER), { vehicleColor: 'red' }));
        await assertSucceeds(getDoc(doc(db, 'spots', 'onb2')));
    });

    it('SECURITY I-CLIENT1: clients still cannot read or write the rollout gate or the lifecycle fence', async () => {
        await seedBase({});
        const db = testEnv.authenticatedContext(CLAIMER).firestore();
        await assertFails(getDoc(doc(db, 'activeIncomingClaimRollout', 'status')));
        await assertFails(setDoc(doc(db, 'activeIncomingClaimRollout', 'status'), { enforced: true }));
        await assertFails(setDoc(doc(db, 'accountLifecycle', CLAIMER), { decision: 'cleared' }));
        await assertFails(deleteDoc(doc(db, 'accountLifecycle', CLAIMER)));
        await applyActor(CLAIMER, VARIANTS[1]);
        await assertFails(updateDoc(doc(db, 'users', CLAIMER), { productAccessBlocked: false }));
        await applyActor(CLAIMER, VARIANTS[0]);
        await assertFails(updateDoc(doc(db, 'users', CLAIMER), { status: 'Active' }));
    });
});

// Residual self-scoped / low-impact paths that the interim candidate leaves
// ungated (same as the deployed snapshot; main gates most of them with
// actorMayUseProduct). They cannot touch a Ping, a claim, a lock, a notice,
// feedback or another user's data. Recorded as CHARACTERIZATION, not a
// contract: a follow-up may gate them without breaking a legacy flow.
type Residual = { id: string; write: () => Promise<unknown>; needsProfile?: boolean };
const RESIDUAL_PATHS: Residual[] = [
    {
        id: 'PREFERENCES',
        write: () => setDoc(doc(testEnv.authenticatedContext(CLAIMER).firestore(), 'users', CLAIMER, 'private', 'preferences'), { lang: 'es' }),
    },
    {
        id: 'USER-LOCATION',
        write: () => setDoc(doc(testEnv.authenticatedContext(CLAIMER).firestore(), 'userLocations', CLAIMER), { lastGeohash: 'dr5re', lastGeohashUpdatedAt: Timestamp.now() }),
    },
    {
        id: 'PARKING-SESSION',
        write: () => setDoc(doc(testEnv.authenticatedContext(CLAIMER).firestore(), 'parkingSessions', CLAIMER), { active: true }),
    },
    {
        id: 'CAR-LOCATION',
        write: () => setDoc(carLocation(CLAIMER), CAR()),
    },
    {
        id: 'VEHICLE-UPDATE', needsProfile: true,
        write: () => updateDoc(doc(testEnv.authenticatedContext(CLAIMER).firestore(), 'users', CLAIMER), { vehicleColor: 'blue' }),
    },
    {
        id: 'PARSE-FAILURE',
        write: () => setDoc(doc(testEnv.authenticatedContext(CLAIMER).firestore(), 'parseFailures', 'pf-1'), { count: 1 }),
    },
    {
        id: 'REPORT-CREATE',
        write: () => addDoc(collection(testEnv.authenticatedContext(CLAIMER).firestore(), 'reports'), {
            reporterId: CLAIMER, reportedUserId: FINDER, type: 'other', reason: 'r', status: 'pending', createdAt: Timestamp.now(),
        }),
    },
    {
        id: 'CHAT-CREATE',
        write: () => setDoc(doc(testEnv.authenticatedContext(CLAIMER).firestore(), 'chats', `${CLAIMER}_${FINDER}`), {
            // chatIdForPair: sorted '_' join ('mv-claimer…' < 'mv-finder…').
            id: `${CLAIMER}_${FINDER}`, participants: [CLAIMER, FINDER],
        }),
    },
];

withEnv('t680u INTERIM candidate: residual ungated self-scoped paths (characterization, not a contract)', readCandidateRules, () => {
    for (const r of RESIDUAL_PATHS) {
        for (const v of VARIANTS) {
            const denied = v.profile === null && r.needsProfile === true;
            it(`CHARACTERIZATION RESIDUAL-I-${r.id}-${v.key}: candidate ${denied ? 'denies (no profile to update)' : 'still ALLOWS'} ${r.id} for a ${v.label}`, async () => {
                await seedBase({});
                await applyActor(CLAIMER, v);
                if (denied) await assertFails(r.write());
                else await assertSucceeds(r.write());
            });
        }
    }
});
