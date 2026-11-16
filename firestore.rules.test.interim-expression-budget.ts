/**
 * S7 INTERIM CANDIDATE: EXPRESSION-BUDGET AND DOCUMENT-ACCESS REGRESSION (t685u).
 * LOCAL EMULATOR ONLY. Nothing here is a deploy path.
 *
 * Candidate under test (NONDEPLOYABLE):
 *   test-fixtures/interim-candidate/firestore.interim-legacy-hardened.rules
 *
 * Why this file exists: in t684u the first candidate (sha256 daf120c6...)
 * passed its suite while every denied spot update reached the emulator's
 * 1,000-expression evaluation limit. A denial caused by the limit is not a
 * rules decision, and the suite could not tell the two apart. The corrected
 * candidate evaluates each spot update arm behind a conditional on its own
 * leading role/state test. This file fails if a denial again comes from the
 * limit or from any other unexpected evaluation failure.
 *
 * Each denied spot update must satisfy all of:
 *   1. the request is denied with permission-denied;
 *   2. the message has no expression-limit text;
 *   3. every clause of the message is either "false for '<op>' @ L<n>" or
 *      "evaluation error at L<n>:<c> for '<op>' @ L<n>" where L<n> is an
 *      allow statement and <c> is the start of its condition (this emulator
 *      reports one extra evaluation of every condition, in which request and
 *      resource are undefined; see EVAL-1). Any other text, such as a service
 *      call (document-access) error, fails the test;
 *   4. the spot update rule reports "false", and the rule-coverage report shows
 *      the named authorization predicate evaluated to false in this request
 *      and the whole spot update condition never evaluated to true;
 *   5. a paired legitimate request that differs only in that attribute is
 *      allowed, and the same predicate evaluates to true there.
 *
 * Document access (Firestore: 10 per single-document request or per operation,
 * 20 per transaction or batch; distinct documents): ACCESS-* measure, for the
 * worst-case realistic valid operations, how many lookups remain by padding an
 * in-memory copy of the candidate with extra exists() calls on existing
 * documents until the emulator refuses. The padded copies exist only in memory.
 *
 * Old-client write shapes replicate 1ffeba94a09d01247c5d960aa3c4ff0672a8432e
 * (same as the t680u interim suite). The rollout gate is SEEDED.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import { initializeTestEnvironment, type RulesTestContext, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import {
    doc,
    getDoc,
    setDoc,
    updateDoc,
    Timestamp,
    runTransaction,
    writeBatch,
    type Transaction,
    type WriteBatch,
} from 'firebase/firestore';
import { assertRulesProject, readRulesEmulatorEndpoint } from './firestoreRulesEmulator';

const PROJECT_ID = 'demo-parkqueen-rules-test';
const rulesEmulator = readRulesEmulatorEndpoint();
assertRulesProject(PROJECT_ID);

const CANDIDATE_RULES_PATH = 'test-fixtures/interim-candidate/firestore.interim-legacy-hardened.rules';
// t685u corrected candidate. The first candidate daf120c6... is the one that
// reached the expression limit; it must not come back.
const CANDIDATE_SHA256 = 'c1508fa02a15fff9b3a2d4a965d40254f540c7c69ffe5aed6405c0a6bb090400';
const LIMIT_CANDIDATE_SHA256 = 'daf120c65921852785414c3baa570dd175ac98dc0861f0ac0e8336eb1ba71469';

const FINDER = 'eb-finder-0001';
const CLAIMER = 'eb-claimer-0002';
const OTHER = 'eb-other-0003';
const GEN_A = 'ab'.repeat(32);
const ACTIVE: Record<string, unknown> = { username: 'ada', fullName: 'Ada', crowns: 0, status: 'Active', productAccessBlocked: false };
const FINDER_ACTIVE: Record<string, unknown> = { ...ACTIVE, username: 'bea', fullName: 'Bea' };
const OTHER_ACTIVE: Record<string, unknown> = { ...ACTIVE, username: 'cy', fullName: 'Cy' };
// Cached vehicle on the profile matches the claim's display fields.
const ACTIVE_VEHICLE: Record<string, unknown> = { ...ACTIVE, vehicleColor: 'red', vehicleType: 'sedan', vehicleBrand: 'Saab' };

// ---------------------------------------------------------------------------
// Candidate text and positions
// ---------------------------------------------------------------------------
const candidateBytes = readFileSync(CANDIDATE_RULES_PATH);
const CANDIDATE_TEXT = candidateBytes.toString('utf8');
const CANDIDATE_DIGEST = createHash('sha256').update(candidateBytes).digest('hex');
const LINES = CANDIDATE_TEXT.split('\n');

function positionOf(snippet: string, after = 0): { line: number; column: number } {
    const at = CANDIDATE_TEXT.indexOf(snippet, after);
    if (at < 0) throw new Error(`snippet not found in candidate: ${snippet}`);
    const before = CANDIDATE_TEXT.slice(0, at).split('\n');
    return { line: before.length, column: before[before.length - 1].length + 1 };
}
function offsetPosition(at: number): { line: number; column: number } {
    if (at < 2) throw new Error('offset not found in candidate');
    const before = CANDIDATE_TEXT.slice(0, at).split('\n');
    return { line: before.length, column: before[before.length - 1].length + 1 };
}
function uniquePosition(snippet: string, after = 0) {
    const at = CANDIDATE_TEXT.indexOf(snippet, after);
    if (at >= 0 && CANDIDATE_TEXT.indexOf(snippet, at + 1) >= 0 && after === 0) throw new Error(`snippet not unique: ${snippet}`);
    return positionOf(snippet, after);
}

const SPOTS_MATCH = CANDIDATE_TEXT.indexOf('match /spots/{spotId} {');
const SPOT_UPDATE_CONDITION = positionOf('signedIn() && legacyAccountWriteEligible()\n        && spotUpdateArmAllows(', SPOTS_MATCH);
const SPOT_UPDATE_LINE = SPOT_UPDATE_CONDITION.line;

// Named authorization predicates (outermost expression that starts there).
const PRED = {
    noClaimGeneration: uniquePosition("resource.data.get('claimGenerationId', null) == null"),
    isClaimer: positionOf("resource.data.get('interestedUserId', null) == request.auth.uid", CANDIDATE_TEXT.indexOf('function isClaimer()')),
    isFinder: positionOf('resource.data.finderId == request.auth.uid', CANDIDATE_TEXT.indexOf('function isFinder()')),
    profileExists: positionOf('exists(profilePath)', CANDIDATE_TEXT.indexOf('function legacyAccountWriteEligible()')),
    notSuspended: uniquePosition("get(profilePath).data.get('status', '') != 'Suspended'"),
    notBlocked: uniquePosition("get(profilePath).data.get('productAccessBlocked', false) == false"),
    notFenced: uniquePosition('!exists(/databases/$(database)/documents/accountLifecycle/$(request.auth.uid))'),
    // The emulator's coverage reports an arm body's value at the "(" that opens it
    // (the call node inside carries no boolean), so etaOnly is the Arm 2 body.
    etaOnly: offsetPosition(CANDIDATE_TEXT.lastIndexOf('? (', CANDIDATE_TEXT.indexOf("changed.hasOnly(['etaMinutes'])")) + 2),
    spotUpdate: SPOT_UPDATE_CONDITION,
};
type PredKey = keyof typeof PRED;

// Condition start column of every allow statement (1-based), by line.
const ALLOW_CONDITION_COLUMN: Record<number, number> = {};
LINES.forEach((text, i) => {
    const m = /^\s*allow [a-z, ]+: if /.exec(text);
    if (m) ALLOW_CONDITION_COLUMN[i + 1] = m[0].length + 1;
});

// Allow statements whose condition calls legacyAccountWriteEligible() (the T1 gate).
const ELIGIBILITY_GATED_LINES = new Set<number>();
for (const line of Object.keys(ALLOW_CONDITION_COLUMN).map(Number)) {
    const start = LINES.slice(0, line - 1).join('\n').length + 1;
    const end = CANDIDATE_TEXT.indexOf(';', start);
    if (CANDIDATE_TEXT.slice(start, end).includes('legacyAccountWriteEligible()')) ELIGIBILITY_GATED_LINES.add(line);
}
function falseLines(message: string): number[] {
    return [...message.matchAll(/false for '[a-z]+' @ L(\d+)/g)].map((m) => Number(m[1]));
}

// ---------------------------------------------------------------------------
// Denial message grammar
// ---------------------------------------------------------------------------
export type Denial = 'allowed' | 'evaluation-limit' | 'rule-false' | 'unexpected';
const LIMIT_TEXT = /maximum of \d+ expressions to evaluate has been reached/i;
const FALSE_CLAUSE = /^false for '(get|list|create|update|delete)' @ L(\d+)$/;
const ERROR_CLAUSE = /^evaluation error at L(\d+):(\d+) for '(get|list|create|update|delete)' @ L(\d+)$/;

export function classifyDenial(message: string, allowColumns: Record<number, number> = ALLOW_CONDITION_COLUMN): { kind: Exclude<Denial, 'allowed'>; clauses: string[]; problems: string[] } {
    if (LIMIT_TEXT.test(message)) return { kind: 'evaluation-limit', clauses: [], problems: ['expression limit'] };
    const body = message.replace(/^\s*(\d+ )?PERMISSION_DENIED:\s*/, '').trim();
    const clauses = body.split(/, (?=false for |evaluation error at )/).map((c) => c.trim()).filter(Boolean);
    const problems: string[] = [];
    let sawFalse = false;
    for (const clause of clauses) {
        const f = FALSE_CLAUSE.exec(clause);
        if (f) { sawFalse = true; if (!(Number(f[2]) in allowColumns)) problems.push(`false clause off an allow line: ${clause}`); continue; }
        const e = ERROR_CLAUSE.exec(clause);
        if (e) {
            const line = Number(e[1]);
            if (line !== Number(e[4]) || allowColumns[line] !== Number(e[2])) problems.push(`evaluation error inside a condition: ${clause}`);
            continue;
        }
        problems.push(`unexpected text: ${clause.slice(0, 160)}`);
    }
    if (!sawFalse) problems.push('no rule reported false');
    return { kind: problems.length ? 'unexpected' : 'rule-false', clauses, problems };
}

// ---------------------------------------------------------------------------
// Emulator rule coverage
// ---------------------------------------------------------------------------
type Counts = { true: number; false: number; undefined: number; other: number };
type Coverage = Map<string, Counts>;

async function coverage(): Promise<Coverage> {
    const res = await fetch(`http://${rulesEmulator.endpoint}/emulator/v1/projects/${PROJECT_ID}:ruleCoverage`);
    if (!res.ok) throw new Error(`rule coverage unavailable: ${res.status}`);
    const body = (await res.json()) as { report?: unknown[] };
    const out: Coverage = new Map();
    const walk = (nodes: unknown) => {
        if (!Array.isArray(nodes)) return;
        for (const node of nodes as Array<Record<string, any>>) {
            const sp = node.sourcePosition;
            if (sp) {
                const key = `${sp.line}:${sp.column}:${sp.currentOffset}:${sp.endOffset}`;
                const c: Counts = out.get(key) || { true: 0, false: 0, undefined: 0, other: 0 };
                for (const v of node.values || []) {
                    const val = v.value || {};
                    const n = Number(v.count) || 0;
                    if (val.boolValue === true) c.true += n;
                    else if (val.boolValue === false) c.false += n;
                    else if ('undefined' in val) c.undefined += n;
                    else c.other += n;
                }
                out.set(key, c);
            }
            walk(node.children);
        }
    };
    walk(body.report);
    return out;
}

function predicateDelta(before: Coverage, after: Coverage, key: PredKey): Counts {
    const { line, column } = PRED[key];
    let best: { span: number; counts: Counts } | null = null;
    for (const [k, counts] of after) {
        const [l, c, start, end] = k.split(':').map(Number);
        if (l !== line || c !== column) continue;
        const span = end - start;
        if (!best || span > best.span) {
            const prev = before.get(k) || { true: 0, false: 0, undefined: 0, other: 0 };
            best = { span, counts: { true: counts.true - prev.true, false: counts.false - prev.false, undefined: counts.undefined - prev.undefined, other: counts.other - prev.other } };
        }
    }
    if (!best) return { true: 0, false: 0, undefined: 0, other: 0 };
    return best.counts;
}

// ---------------------------------------------------------------------------
// Environment, seeding and old-client write shapes (1ffeba94)
// ---------------------------------------------------------------------------
let testEnv: RulesTestEnvironment;
async function useRules(text: string) {
    if (testEnv) await testEnv.cleanup();
    testEnv = await initializeTestEnvironment({
        projectId: PROJECT_ID,
        firestore: { rules: text, host: rulesEmulator.host, port: rulesEmulator.port },
    });
    await testEnv.clearFirestore();
}

function future(ms: number) { return Timestamp.fromMillis(Date.now() + ms); }
function past(ms: number) { return Timestamp.fromMillis(Date.now() - ms); }

function availableSpot(extra: Record<string, unknown> = {}) {
    return {
        finderId: FINDER, finderName: 'bea', address: '1 Budget Way', lat: 40.7, lng: -74.0, type: 'free',
        status: 'available', pingMode: 'now', reportedAt: future(60_000), expiresAt: future(20 * 60_000), ...extra,
    };
}
function claimedSpot(extra: Record<string, unknown> = {}) {
    return availableSpot({
        status: 'interested', claimState: 'heading', interestedUserId: CLAIMER, interestedUserName: 'ada',
        interestedUserTitle: 'Newcomer', claimStartedAt: past(60_000), etaMinutes: 4, interestExpiresAt: future(9 * 60_000), ...extra,
    });
}

type Seed = {
    spots: Record<string, Record<string, unknown>>;
    claimer?: Record<string, unknown> | null;
    fenced?: boolean;
    lock?: Record<string, unknown>;
    feedback?: string[];
    extraDocs?: Record<string, Record<string, unknown>>;
};
async function seed(s: Seed) {
    await testEnv.clearFirestore();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const db = ctx.firestore();
        await setDoc(doc(db, 'activeIncomingClaimRollout', 'status'), { enforced: true, locklessCount: 0, duplicateUserCount: 0, duplicatePingCount: 0 });
        await setDoc(doc(db, 'users', FINDER), FINDER_ACTIVE);
        await setDoc(doc(db, 'users', OTHER), OTHER_ACTIVE);
        const claimer = s.claimer === undefined ? ACTIVE : s.claimer;
        if (claimer) await setDoc(doc(db, 'users', CLAIMER), claimer);
        if (s.fenced) await setDoc(doc(db, 'accountLifecycle', CLAIMER), { decision: 'delete', fenceGeneration: 1, source: 'deleteAccount' });
        if (s.lock) await setDoc(doc(db, 'users', CLAIMER, 'activeIncomingClaims', 'current'), s.lock);
        for (const id of s.feedback || []) await setDoc(doc(db, 'spotFeedback', id), { spotId: id.split('_')[0], outcome: 'failed' });
        for (const [id, data] of Object.entries(s.spots)) await setDoc(doc(db, 'spots', id), data);
        for (const [path, data] of Object.entries(s.extraDocs || {})) await setDoc(doc(db, path), data);
    });
}

async function readSpot(id: string): Promise<Record<string, any> | null> {
    let data: Record<string, any> | null = null;
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
        const snap = await getDoc(doc(ctx.firestore(), 'spots', id));
        data = snap.exists() ? (snap.data() as Record<string, any>) : null;
    });
    return data as Record<string, any> | null;
}

// The rules-unit-testing context database (what every write shape receives).
type TestDb = ReturnType<RulesTestContext['firestore']>;
type Extra = (db: TestDb, w: Transaction | WriteBatch) => void;
function claimFields(claimStartedAt: Timestamp, claimState: string, vehicle: boolean) {
    return {
        status: 'interested', claimState, ownerLeavingNow: null, interestedUserId: CLAIMER, interestedUserName: 'ada',
        interestedUserVehicleColor: vehicle ? 'red' : null, interestedUserVehicleType: vehicle ? 'sedan' : null,
        interestedUserVehicleBrand: vehicle ? 'Saab' : null, interestedUserTitle: 'Newcomer', claimStartedAt, etaMinutes: 4,
        interestExpiresAt: Timestamp.fromMillis(Date.now() + 9 * 60000),
    };
}

// acquireActiveIncomingClaim: one transaction, Ping update + lock set.
function legacyClaim(spotId: string, opts: { claimState?: 'heading' | 'committed'; vehicle?: boolean; extra?: Extra } = {}) {
    const db = testEnv.authenticatedContext(CLAIMER).firestore();
    const spotRef = doc(db, 'spots', spotId);
    const lockRef = doc(db, 'users', CLAIMER, 'activeIncomingClaims', 'current');
    const claimState = opts.claimState || 'heading';
    return runTransaction(db, async (tx) => {
        const spotSnap = await tx.get(spotRef);
        await tx.get(lockRef);
        if (!spotSnap.exists() || (spotSnap.data() as any).status !== 'available') throw new Error('unavailable');
        const claimStartedAt = Timestamp.now();
        tx.update(spotRef, claimFields(claimStartedAt, claimState, Boolean(opts.vehicle)));
        tx.set(lockRef, { spotId, claimStartedAt, claimState, updatedAt: claimStartedAt });
        if (opts.extra) opts.extra(db, tx);
        return 'claimed';
    });
}

// The same two writes as one batched write (no reads).
function batchedClaim(spotId: string, opts: { extra?: Extra } = {}) {
    const db = testEnv.authenticatedContext(CLAIMER).firestore();
    const batch = writeBatch(db);
    const claimStartedAt = Timestamp.now();
    batch.update(doc(db, 'spots', spotId), claimFields(claimStartedAt, 'heading', false));
    batch.set(doc(db, 'users', CLAIMER, 'activeIncomingClaims', 'current'), { spotId, claimStartedAt, claimState: 'heading', updatedAt: claimStartedAt });
    if (opts.extra) opts.extra(db, batch);
    return batch.commit();
}

// cancelClaimTransaction: Ping clear (+ reopen unless expired), lock delete, claimer_cancelled notice.
function legacyClaimerCancel(spotId: string, opts: { extra?: Extra } = {}) {
    const db = testEnv.authenticatedContext(CLAIMER).firestore();
    const spotRef = doc(db, 'spots', spotId);
    const lockRef = doc(db, 'users', CLAIMER, 'activeIncomingClaims', 'current');
    return runTransaction(db, async (tx) => {
        const fresh = await tx.get(spotRef);
        const spot = fresh.data() as Record<string, any>;
        const lockSnap = await tx.get(lockRef);
        const clear = {
            claimState: null, ownerLeavingNow: null, ownerLeavingNowAt: null, interestedUserId: null, interestedUserName: null,
            interestedUserVehicleColor: null, interestedUserVehicleType: null, interestedUserVehicleBrand: null, interestedUserTitle: null,
            etaMinutes: null, interestExpiresAt: null, claimReminderAt: null, claimReminderSentAt: null,
            claimAutoReleaseAt: null, claimAutoReleasedAt: null, claimStartedAt: null,
        };
        const expired = spot.expiresAt?.toMillis?.() != null && spot.expiresAt.toMillis() <= Date.now();
        tx.update(spotRef, expired ? clear : { ...clear, status: 'available' });
        if (lockSnap.exists() && lockSnap.data()?.spotId === spotId) tx.delete(lockRef);
        tx.set(doc(db, 'spotNotifications', `claimer_cancelled_${spotId}_${spot.claimStartedAt?.toMillis?.() ?? 'x'}`), {
            spotId, senderId: CLAIMER, targetUserId: spot.finderId, type: 'claimer_cancelled',
            message: 'The other driver canceled — your spot is available again.', createdAt: Timestamp.fromMillis(Date.now() - 1000),
        });
        if (opts.extra) opts.extra(db, tx);
        return 'cancelled';
    });
}

// markClaimArrived: Ping arrival + lock delete when it names this Ping.
function legacyArrival(spotId: string, opts: { extra?: Extra } = {}) {
    const db = testEnv.authenticatedContext(CLAIMER).firestore();
    const spotRef = doc(db, 'spots', spotId);
    const lockRef = doc(db, 'users', CLAIMER, 'activeIncomingClaims', 'current');
    return runTransaction(db, async (tx) => {
        await tx.get(spotRef);
        const lockSnap = await tx.get(lockRef);
        tx.update(spotRef, { status: 'occupied', claimState: 'arrived_pending_outcome', arrivedAt: Timestamp.now() });
        if (lockSnap.exists() && lockSnap.data()?.spotId === spotId) tx.delete(lockRef);
        if (opts.extra) opts.extra(db, tx);
        return 'arrived';
    });
}

// Single-document spot update (ETA, heading, finder actions).
function spotUpdate(uid: string, spotId: string, patch: Record<string, unknown>, opts: { extra?: Extra } = {}) {
    const db = testEnv.authenticatedContext(uid).firestore();
    if (!opts.extra) return updateDoc(doc(db, 'spots', spotId), patch);
    const batch = writeBatch(db);
    batch.update(doc(db, 'spots', spotId), patch);
    opts.extra(db, batch);
    return batch.commit();
}

type Outcome = { ok: boolean; code: string | null; message: string; before: Coverage; after: Coverage };
async function attempt(fn: () => Promise<unknown>): Promise<Outcome> {
    const before = await coverage();
    let ok = false; let code: string | null = null; let message = '';
    try { await fn(); ok = true; } catch (e: any) { code = e?.code ? String(e.code) : 'error'; message = String(e?.message ?? e); }
    const after = await coverage();
    return { ok, code, message, before, after };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
const lockFor = (spotId: string, claimStartedAt: Timestamp) => ({ spotId, claimStartedAt, claimState: 'heading', updatedAt: Timestamp.now() });
const SUSPENDED = { ...ACTIVE, status: 'Suspended' };
const BLOCKED = { ...ACTIVE, productAccessBlocked: true };

type Case = { seed: () => Seed; run: () => Promise<unknown> };
// gate 'spot' (default): the spot update rule itself is decisively false.
// gate 'eligibility': a multi-write old-client request whose first decisive
// denial may come from another write's rule; every such rule must call
// legacyAccountWriteEligible(), and the spot update must never be true.
type DenyCase = { id: string; area: string; decisive: PredKey; gate?: 'spot' | 'eligibility'; deny: Case; control: Case };

const STARTED = past(60_000);
const DENY_CASES: DenyCase[] = [
    // Generation-bearing and stale-generation Pings (old-client direct writes).
    { id: 'GEN-1 claim of an available Ping with a leftover generation (transaction)', area: 'generation', decisive: 'noClaimGeneration',
        deny: { seed: () => ({ spots: { s: availableSpot({ claimGenerationId: GEN_A }) } }), run: () => legacyClaim('s') },
        control: { seed: () => ({ spots: { s: availableSpot() } }), run: () => legacyClaim('s') } },
    { id: 'GEN-2 batched claim of a leftover-generation Ping', area: 'batched', decisive: 'noClaimGeneration',
        deny: { seed: () => ({ spots: { s: availableSpot({ claimGenerationId: GEN_A }) } }), run: () => batchedClaim('s') },
        control: { seed: () => ({ spots: { s: availableSpot() } }), run: () => batchedClaim('s') } },
    { id: 'GEN-3 claim with vehicle, committed, stale own lock, leftover generation', area: 'generation', decisive: 'noClaimGeneration',
        deny: { seed: () => ({ spots: { s: availableSpot({ claimGenerationId: GEN_A }), old: availableSpot() }, claimer: ACTIVE_VEHICLE, lock: lockFor('old', past(120_000)) }), run: () => legacyClaim('s', { vehicle: true, claimState: 'committed' }) },
        control: { seed: () => ({ spots: { s: availableSpot(), old: availableSpot() }, claimer: ACTIVE_VEHICLE, lock: lockFor('old', past(120_000)) }), run: () => legacyClaim('s', { vehicle: true, claimState: 'committed' }) } },
    { id: 'GEN-4 claimer cancel of a generation claim (Arm 3)', area: 'legacy-cancel', decisive: 'noClaimGeneration',
        deny: { seed: () => ({ spots: { s: claimedSpot({ claimStartedAt: STARTED, claimGenerationId: GEN_A }) }, lock: lockFor('s', STARTED) }), run: () => legacyClaimerCancel('s') },
        control: { seed: () => ({ spots: { s: claimedSpot({ claimStartedAt: STARTED }) }, lock: lockFor('s', STARTED) }), run: () => legacyClaimerCancel('s') } },
    { id: 'GEN-5 claimer cancel of a generation claim on an expired Ping (Arm 3b)', area: 'legacy-cancel', decisive: 'noClaimGeneration',
        deny: { seed: () => ({ spots: { s: claimedSpot({ expiresAt: past(5_000), claimGenerationId: GEN_A }) } }), run: () => legacyClaimerCancel('s') },
        control: { seed: () => ({ spots: { s: claimedSpot({ expiresAt: past(5_000) }) } }), run: () => legacyClaimerCancel('s') } },
    { id: 'GEN-6 claimant clears the generation on a live claim', area: 'generation', decisive: 'etaOnly',
        deny: { seed: () => ({ spots: { s: claimedSpot({ claimGenerationId: GEN_A }) } }), run: () => spotUpdate(CLAIMER, 's', { claimGenerationId: null }) },
        control: { seed: () => ({ spots: { s: claimedSpot({ claimGenerationId: GEN_A }) } }), run: () => spotUpdate(CLAIMER, 's', { etaMinutes: 6 }) } },
    { id: 'GEN-7 another user updates ETA on a generation claim', area: 'active-client', decisive: 'isClaimer',
        deny: { seed: () => ({ spots: { s: claimedSpot({ claimGenerationId: GEN_A }) } }), run: () => spotUpdate(OTHER, 's', { etaMinutes: 9 }) },
        control: { seed: () => ({ spots: { s: claimedSpot({ claimGenerationId: GEN_A }) } }), run: () => spotUpdate(CLAIMER, 's', { etaMinutes: 9 }) } },
    // T1 restricted accounts (legacyAccountWriteEligible).
    { id: 'T1-1 claim by a Suspended account', gate: 'eligibility', area: 'restricted', decisive: 'notSuspended',
        deny: { seed: () => ({ spots: { s: availableSpot() }, claimer: SUSPENDED }), run: () => legacyClaim('s') },
        control: { seed: () => ({ spots: { s: availableSpot() } }), run: () => legacyClaim('s') } },
    { id: 'T1-2 claim by a productAccessBlocked account', gate: 'eligibility', area: 'restricted', decisive: 'notBlocked',
        deny: { seed: () => ({ spots: { s: availableSpot() }, claimer: BLOCKED }), run: () => legacyClaim('s') },
        control: { seed: () => ({ spots: { s: availableSpot() } }), run: () => legacyClaim('s') } },
    { id: 'T1-3 claim by a lifecycle-fenced account', gate: 'eligibility', area: 'restricted', decisive: 'notFenced',
        deny: { seed: () => ({ spots: { s: availableSpot() }, fenced: true }), run: () => legacyClaim('s') },
        control: { seed: () => ({ spots: { s: availableSpot() } }), run: () => legacyClaim('s') } },
    { id: 'T1-4 claim by a deleted account (no profile, token still valid)', gate: 'eligibility', area: 'restricted', decisive: 'profileExists',
        deny: { seed: () => ({ spots: { s: availableSpot() }, claimer: null }), run: () => legacyClaim('s') },
        control: { seed: () => ({ spots: { s: availableSpot() } }), run: () => legacyClaim('s') } },
    { id: 'T1-5 batched claim by a Suspended account', gate: 'eligibility', area: 'batched', decisive: 'notSuspended',
        deny: { seed: () => ({ spots: { s: availableSpot() }, claimer: SUSPENDED }), run: () => batchedClaim('s') },
        control: { seed: () => ({ spots: { s: availableSpot() } }), run: () => batchedClaim('s') } },
    { id: 'T1-6 claimer cancel by a Suspended account (3-write transaction)', gate: 'eligibility', area: 'restricted', decisive: 'notSuspended',
        deny: { seed: () => ({ spots: { s: claimedSpot({ claimStartedAt: STARTED }) }, claimer: SUSPENDED, lock: lockFor('s', STARTED) }), run: () => legacyClaimerCancel('s') },
        control: { seed: () => ({ spots: { s: claimedSpot({ claimStartedAt: STARTED }) }, lock: lockFor('s', STARTED) }), run: () => legacyClaimerCancel('s') } },
    { id: 'T1-7 arrival by a lifecycle-fenced account', area: 'restricted', decisive: 'notFenced',
        deny: { seed: () => ({ spots: { s: claimedSpot() }, fenced: true }), run: () => legacyArrival('s') },
        control: { seed: () => ({ spots: { s: claimedSpot() } }), run: () => legacyArrival('s') } },
    { id: 'T1-8 ETA update by a productAccessBlocked claimant on a generation claim', area: 'restricted', decisive: 'notBlocked',
        deny: { seed: () => ({ spots: { s: claimedSpot({ claimGenerationId: GEN_A }) }, claimer: BLOCKED }), run: () => spotUpdate(CLAIMER, 's', { etaMinutes: 7 }) },
        control: { seed: () => ({ spots: { s: claimedSpot({ claimGenerationId: GEN_A }) } }), run: () => spotUpdate(CLAIMER, 's', { etaMinutes: 7 }) } },
    // Single spot writes, so the spot update rule itself is the decisive denial.
    { id: 'T1-9 ETA update by a Suspended claimant (spot write only)', area: 'restricted', decisive: 'notSuspended',
        deny: { seed: () => ({ spots: { s: claimedSpot() }, claimer: SUSPENDED }), run: () => spotUpdate(CLAIMER, 's', { etaMinutes: 8 }) },
        control: { seed: () => ({ spots: { s: claimedSpot() } }), run: () => spotUpdate(CLAIMER, 's', { etaMinutes: 8 }) } },
    { id: 'T1-10 ETA update by a deleted claimant (no profile, spot write only)', area: 'restricted', decisive: 'profileExists',
        deny: { seed: () => ({ spots: { s: claimedSpot() }, claimer: null }), run: () => spotUpdate(CLAIMER, 's', { etaMinutes: 8 }) },
        control: { seed: () => ({ spots: { s: claimedSpot() } }), run: () => spotUpdate(CLAIMER, 's', { etaMinutes: 8 }) } },
    { id: 'T1-11 ETA update by a lifecycle-fenced claimant (spot write only)', area: 'restricted', decisive: 'notFenced',
        deny: { seed: () => ({ spots: { s: claimedSpot() }, fenced: true }), run: () => spotUpdate(CLAIMER, 's', { etaMinutes: 8 }) },
        control: { seed: () => ({ spots: { s: claimedSpot() } }), run: () => spotUpdate(CLAIMER, 's', { etaMinutes: 8 }) } },
];

// Legitimate old-client operations, including on generation-bearing claims.
type AllowCase = { id: string; area: string } & Case;
const ALLOW_CASES: AllowCase[] = [
    { id: 'OK-1 claim of a plain available Ping', area: 'legacy-claim', seed: () => ({ spots: { s: availableSpot() } }), run: () => legacyClaim('s') },
    { id: 'OK-2 claim of a Ping with claimGenerationId null', area: 'legacy-claim', seed: () => ({ spots: { s: availableSpot({ claimGenerationId: null }) } }), run: () => legacyClaim('s') },
    { id: 'OK-3 claim with vehicle, committed, stale own lock', area: 'legacy-claim', seed: () => ({ spots: { s: availableSpot(), old: availableSpot() }, claimer: ACTIVE_VEHICLE, lock: lockFor('old', past(120_000)) }), run: () => legacyClaim('s', { vehicle: true, claimState: 'committed' }) },
    { id: 'OK-4 claimant ETA on a generation claim', area: 'active-client', seed: () => ({ spots: { s: claimedSpot({ claimGenerationId: GEN_A }) } }), run: () => spotUpdate(CLAIMER, 's', { etaMinutes: 8 }) },
    { id: 'OK-5 claimant commits to heading on a generation claim', area: 'active-client', seed: () => ({ spots: { s: claimedSpot({ claimGenerationId: GEN_A, claimState: 'committed' }) } }), run: () => spotUpdate(CLAIMER, 's', { claimState: 'heading' }) },
    { id: 'OK-6 claimant arrival on a generation claim', area: 'active-client', seed: () => ({ spots: { s: claimedSpot({ claimGenerationId: GEN_A }) } }), run: () => legacyArrival('s') },
    { id: 'OK-7 finder extends a generation claim', area: 'active-client', seed: () => ({ spots: { s: claimedSpot({ claimGenerationId: GEN_A }) } }), run: () => spotUpdate(FINDER, 's', { interestExpiresAt: future(12 * 60_000) }) },
    { id: 'OK-8 finder confirms arrival on a generation claim', area: 'active-client', seed: () => ({ spots: { s: claimedSpot({ claimGenerationId: GEN_A }) } }), run: () => spotUpdate(FINDER, 's', { status: 'occupied' }) },
    { id: 'OK-9 finder signals leaving now on a generation claim', area: 'active-client', seed: () => ({ spots: { s: claimedSpot({ claimGenerationId: GEN_A }) } }), run: () => spotUpdate(FINDER, 's', { ownerLeavingNow: true, ownerLeavingNowAt: Timestamp.now(), claimAutoReleaseAt: future(5 * 60_000) }) },
    { id: 'OK-10 legacy claimer cancel with lock and notice (Arm 3)', area: 'legacy-cancel', seed: () => ({ spots: { s: claimedSpot({ claimStartedAt: STARTED }) }, lock: lockFor('s', STARTED) }), run: () => legacyClaimerCancel('s') },
    { id: 'OK-11 legacy claimer cancel on an expired Ping (Arm 3b)', area: 'legacy-cancel', seed: () => ({ spots: { s: claimedSpot({ expiresAt: past(5_000) }) } }), run: () => legacyClaimerCancel('s') },
    { id: 'OK-12 legacy arrival without a lock (legacy claim)', area: 'legacy-arrival', seed: () => ({ spots: { s: claimedSpot() } }), run: () => legacyArrival('s') },
    { id: 'OK-13 batched claim of a plain Ping', area: 'batched', seed: () => ({ spots: { s: availableSpot() } }), run: () => batchedClaim('s') },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('t685u interim candidate: expression budget (denials are rule decisions)', () => {
    beforeAll(async () => {
        console.log(`[t685u] candidate sha256 ${CANDIDATE_DIGEST}`);
        await useRules(CANDIDATE_TEXT);
    });
    afterAll(async () => { if (testEnv) await testEnv.cleanup(); });

    it('BUDGET-PIN: the candidate is the corrected NONDEPLOYABLE file, not the limit-reaching one', () => {
        expect(LINES[1]).toContain('NONDEPLOYABLE');
        expect(LINES[1]).toContain('DO NOT DEPLOY');
        expect(CANDIDATE_DIGEST).not.toBe(LIMIT_CANDIDATE_SHA256);
        expect(CANDIDATE_DIGEST).toBe(CANDIDATE_SHA256);
    });

    it('BUDGET-0: the message grammar accepts only rule decisions', () => {
        const cols = { 718: 24, 580: 34 } as Record<number, number>;
        expect(classifyDenial("7 PERMISSION_DENIED: \nUnable to evaluate the expression as the maximum of 1000 expressions to evaluate has been reached. for 'update' @ L718, false for 'update' @ L718", cols).kind).toBe('evaluation-limit');
        expect(classifyDenial("7 PERMISSION_DENIED: \nevaluation error at L718:24 for 'update' @ L718, evaluation error at L580:34 for 'create' @ L580, false for 'create' @ L580, false for 'update' @ L718", cols).kind).toBe('rule-false');
        expect(classifyDenial("7 PERMISSION_DENIED: \nfalse for 'update' @ L718", cols).kind).toBe('rule-false');
        // An error positioned inside a condition, a service-call (document access) error, or no false clause is unexpected.
        expect(classifyDenial("7 PERMISSION_DENIED: \nevaluation error at L718:40 for 'update' @ L718, false for 'update' @ L718", cols).kind).toBe('unexpected');
        expect(classifyDenial("7 PERMISSION_DENIED: \nevaluation error at L580:34 for 'create' @ L580, false for 'create' @ L580, Service call error. Function: [exists], Argument: [path_value {}]", cols).kind).toBe('unexpected');
        expect(classifyDenial("7 PERMISSION_DENIED: \nevaluation error at L718:24 for 'update' @ L718", cols).kind).toBe('unexpected');
        expect(classifyDenial("7 PERMISSION_DENIED: \nfalse for 'update' @ L719", cols).kind).toBe('unexpected');
        // The positions this file relies on exist in the candidate.
        expect(ALLOW_CONDITION_COLUMN[SPOT_UPDATE_LINE]).toBe(SPOT_UPDATE_CONDITION.column);
        expect(ELIGIBILITY_GATED_LINES.has(SPOT_UPDATE_LINE)).toBe(true);
        expect(ELIGIBILITY_GATED_LINES.size).toBeGreaterThanOrEqual(4);
        expect(falseLines("false for 'create' @ L584, false for 'update' @ L725")).toEqual([584, 725]);
    });

    for (const c of DENY_CASES) {
        it(`SECURITY ${c.id}: denied by ${c.decisive} = false (not the expression limit); paired control allowed`, async () => {
            await seed(c.deny.seed());
            const before = await readSpot('s');
            const denied = await attempt(c.deny.run);
            const cls = denied.ok ? null : classifyDenial(denied.message);
            const decisive = predicateDelta(denied.before, denied.after, c.decisive);
            const whole = predicateDelta(denied.before, denied.after, 'spotUpdate');
            await seed(c.control.seed());
            const control = await attempt(c.control.run);
            const controlDecisive = predicateDelta(control.before, control.after, c.decisive);
            const controlWhole = predicateDelta(control.before, control.after, 'spotUpdate');
            console.log(JSON.stringify({ t685u: 'deny', id: c.id, area: c.area, gate: c.gate ?? 'spot', kind: cls?.kind ?? 'allowed', problems: cls?.problems ?? [], decisive, whole, control: control.ok, controlDecisive, controlWhole, message: denied.message.slice(0, 300) }));

            // 1. denied
            expect(denied.ok).toBe(false);
            expect(denied.code).toBe('permission-denied');
            // 2 + 3. not the expression limit, and no other evaluation failure
            expect(LIMIT_TEXT.test(denied.message)).toBe(false);
            expect(cls?.problems).toEqual([]);
            expect(cls?.kind).toBe('rule-false');
            // 4. the named predicate is false and the spot update condition is never true;
            //    gate 'spot': the spot update rule is the decisive false;
            //    gate 'eligibility': every decisive false is an eligibility-gated rule.
            const lines = falseLines(denied.message);
            expect(lines.length).toBeGreaterThan(0);
            if ((c.gate ?? 'spot') === 'spot') {
                expect(denied.message).toContain(`false for 'update' @ L${SPOT_UPDATE_LINE}`);
                expect(whole.false).toBeGreaterThan(0);
            } else {
                for (const l of lines) expect(ELIGIBILITY_GATED_LINES.has(l), `L${l} is eligibility-gated`).toBe(true);
            }
            expect(decisive.false).toBeGreaterThan(0);
            expect(whole.true).toBe(0);
            expect(whole.other).toBe(0);
            // 5. the paired legitimate request succeeds and the predicate is true there
            expect(control.ok).toBe(true);
            expect(controlDecisive.true).toBeGreaterThan(0);
            expect(controlWhole.true).toBeGreaterThan(0);
            expect(controlWhole.false).toBe(0);
            // The denied write left the Ping unchanged.
            await seed(c.deny.seed());
            const again = await attempt(c.deny.run);
            expect(again.ok).toBe(false);
            const afterSpot = await readSpot('s');
            expect(afterSpot?.status).toBe(before?.status);
            expect(afterSpot?.interestedUserId ?? null).toBe(before?.interestedUserId ?? null);
            expect(afterSpot?.claimGenerationId ?? null).toBe(before?.claimGenerationId ?? null);
        });
    }

    for (const c of ALLOW_CASES) {
        it(`COMPAT ${c.id}: allowed; the spot update condition is true and never false`, async () => {
            await seed(c.seed());
            const out = await attempt(c.run);
            const whole = predicateDelta(out.before, out.after, 'spotUpdate');
            console.log(JSON.stringify({ t685u: 'allow', id: c.id, area: c.area, ok: out.ok, whole, message: out.message.slice(0, 300) }));
            expect(out.message).toBe('');
            expect(out.ok).toBe(true);
            expect(whole.true).toBeGreaterThan(0);
            expect(whole.false).toBe(0);
        });
    }

    it('EVAL-1: the extra evaluation behind "evaluation error at L<n>:<condition start>" is present on allowed requests too, so it is not what denies', async () => {
        await seed({ spots: { s: availableSpot() } });
        const allowed = await attempt(() => legacyClaim('s'));
        await seed({ spots: { s: availableSpot({ claimGenerationId: GEN_A }) } });
        const denied = await attempt(() => legacyClaim('s'));
        const a = predicateDelta(allowed.before, allowed.after, 'spotUpdate');
        const d = predicateDelta(denied.before, denied.after, 'spotUpdate');
        console.log(JSON.stringify({ t685u: 'eval-1', allowed: a, denied: d }));
        expect(allowed.ok).toBe(true);
        expect(denied.ok).toBe(false);
        expect(a.undefined).toBeGreaterThan(0);
        expect(d.undefined).toBe(a.undefined);
        expect(a.true).toBeGreaterThan(0);
        expect(d.false).toBeGreaterThan(0);
    });
});

// ---------------------------------------------------------------------------
// Document access (10 per operation, 20 per transaction or batch)
// ---------------------------------------------------------------------------
const PAD_DOCS = 'eb685uPadDocs';
const PAD_WRITES = 'eb685uPadWrites';
function padTerms(k: number, idExpr: string) {
    return Array.from({ length: k }, (_, i) => `exists(/databases/$(database)/documents/${PAD_DOCS}/$(${idExpr} + '_${i}'))`);
}
// In-memory copy: K extra distinct existing-document lookups on the spot update
// condition, and a pad-write collection whose create rule makes `n` lookups
// (n is the document id prefix). Nothing is written to disk.
function paddedRules(spotK: number): string {
    const anchor = 'spotUpdateArmAllows(request.resource.data.diff(resource.data).affectedKeys());';
    const at = CANDIDATE_TEXT.indexOf(anchor);
    if (at < 0 || CANDIDATE_TEXT.indexOf(anchor, at + 1) >= 0) throw new Error('pad anchor not unique');
    const spotPad = spotK > 0 ? ` && ${padTerms(spotK, "'spot'").join(' && ')}` : '';
    let text = CANDIDATE_TEXT.slice(0, at) + anchor.slice(0, -1) + spotPad + ';' + CANDIDATE_TEXT.slice(at + anchor.length);
    const padMatches = Array.from({ length: 10 }, (_, n) => n + 1).map((n) =>
        `    match /${PAD_WRITES}${n}/{id} { allow create: if ${padTerms(n, 'id').join(' && ')}; }`).join('\n');
    const dbMatch = 'match /databases/{database}/documents {\n';
    const dm = text.indexOf(dbMatch);
    text = text.slice(0, dm + dbMatch.length) + padMatches + '\n' + text.slice(dm + dbMatch.length);
    return text;
}
function padDocs(): Record<string, Record<string, unknown>> {
    const out: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 10; i += 1) out[`${PAD_DOCS}/spot_${i}`] = { p: 1 };
    for (const w of ['wa', 'wb']) for (let i = 0; i < 10; i += 1) out[`${PAD_DOCS}/${w}_${i}`] = { p: 1 };
    return out;
}
// p extra lookups in the same request, as one or two pad writes (ids wa / wb).
function padWrites(p: number): Extra | undefined {
    if (p <= 0) return undefined;
    const a = Math.min(p, 10); const b = p - a;
    return (db, w) => {
        (w as any).set(doc(db, `${PAD_WRITES}${a}`, 'wa'), { p: 1 });
        if (b > 0) (w as any).set(doc(db, `${PAD_WRITES}${b}`, 'wb'), { p: 1 });
    };
}

type AccessCase = { id: string; seed: () => Seed; run: (extra?: Extra) => Promise<unknown> };
const ACCESS_CASES: AccessCase[] = [
    { id: 'ACCESS-1 claim: vehicle, committed, stale own lock on another live Ping, prior feedback doc (transaction, 2 writes)',
        seed: () => ({ spots: { s: availableSpot(), old: availableSpot() }, claimer: ACTIVE_VEHICLE, lock: lockFor('old', past(120_000)), feedback: [`s_${CLAIMER}`] }),
        run: (extra) => legacyClaim('s', { vehicle: true, claimState: 'committed', extra }) },
    { id: 'ACCESS-2 claimer cancel with lock and notice (transaction, 3 writes)',
        seed: () => ({ spots: { s: claimedSpot({ claimStartedAt: STARTED }) }, lock: lockFor('s', STARTED) }),
        run: (extra) => legacyClaimerCancel('s', { extra }) },
    { id: 'ACCESS-3 claimer cancel on an expired Ping with lock and notice (transaction, 3 writes)',
        seed: () => ({ spots: { s: claimedSpot({ claimStartedAt: STARTED, expiresAt: past(5_000) }) }, lock: lockFor('s', STARTED) }),
        run: (extra) => legacyClaimerCancel('s', { extra }) },
    { id: 'ACCESS-4 arrival with lock (transaction, 2 writes)',
        seed: () => ({ spots: { s: claimedSpot({ claimStartedAt: STARTED }) }, lock: lockFor('s', STARTED) }),
        run: (extra) => legacyArrival('s', { extra }) },
    { id: 'ACCESS-5 claimant ETA on a generation claim (single write)',
        seed: () => ({ spots: { s: claimedSpot({ claimGenerationId: GEN_A }) }, lock: lockFor('s', STARTED) }),
        run: (extra) => spotUpdate(CLAIMER, 's', { etaMinutes: 5 }, { extra }) },
    { id: 'ACCESS-6 finder confirms arrival (single write)',
        seed: () => ({ spots: { s: claimedSpot() } }),
        run: (extra) => spotUpdate(FINDER, 's', { status: 'occupied' }, { extra }) },
];

// Budget the candidate must keep: at least this many lookups of headroom.
const MIN_OPERATION_HEADROOM = 2;
const MIN_REQUEST_HEADROOM = 4;

describe('t685u interim candidate: document-access limits (10 per operation, 20 per request)', () => {
    afterAll(async () => { if (testEnv) await testEnv.cleanup(); });

    it('ACCESS-0: this emulator enforces 10 per operation and 20 per request on distinct documents', async () => {
        await useRules(paddedRules(0));
        await seed({ spots: {}, extraDocs: padDocs() });
        const db = () => testEnv.authenticatedContext(CLAIMER).firestore();
        const one = async (n: number) => { try { await setDoc(doc(db(), `${PAD_WRITES}${n}`, 'wa'), { p: 1 }); return true; } catch { return false; } };
        expect(await one(10)).toBe(true);
        const batch = async (a: number, b: number, c = 0) => {
            const d = db(); const w = writeBatch(d);
            w.set(doc(d, `${PAD_WRITES}${a}`, 'wa'), { p: 1 }); w.set(doc(d, `${PAD_WRITES}${b}`, 'wb'), { p: 1 });
            if (c) w.set(doc(d, `${PAD_WRITES}${c}`, 'spot'), { p: 1 });
            try { await w.commit(); return true; } catch { return false; }
        };
        await seed({ spots: {}, extraDocs: padDocs() });
        expect(await batch(10, 10)).toBe(true);
        await seed({ spots: {}, extraDocs: padDocs() });
        expect(await batch(10, 10, 1)).toBe(false);
    });

    for (const c of ACCESS_CASES) {
        it(`${c.id}: valid at K=0 and keeps headroom`, async () => {
            // Operation headroom: largest K extra lookups on the spot update that still pass.
            let opHeadroom = -1;
            for (let k = 10; k >= 0; k -= 1) {
                await useRules(paddedRules(k));
                await seed({ ...c.seed(), extraDocs: { ...(c.seed().extraDocs || {}), ...padDocs() } });
                try { await c.run(); opHeadroom = k; break; } catch { /* over a limit at this K */ }
            }
            // Request headroom: largest P extra lookups in pad writes that still pass.
            await useRules(paddedRules(0));
            let requestHeadroom = -1;
            for (let p = 20; p >= 0; p -= 1) {
                await seed({ ...c.seed(), extraDocs: { ...(c.seed().extraDocs || {}), ...padDocs() } });
                try { await c.run(padWrites(p)); requestHeadroom = p; break; } catch { /* over a limit */ }
            }
            const record = { t685u: 'access', id: c.id, operationLookups: 10 - opHeadroom, operationHeadroom: opHeadroom, requestLookups: 20 - requestHeadroom, requestHeadroom };
            console.log(JSON.stringify(record));
            expect(opHeadroom).toBeGreaterThanOrEqual(MIN_OPERATION_HEADROOM);
            expect(requestHeadroom).toBeGreaterThanOrEqual(MIN_REQUEST_HEADROOM);
        }, 240_000);
    }
});
