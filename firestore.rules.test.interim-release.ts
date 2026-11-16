/**
 * S7 INTERIM RULES RELEASE ARTIFACT (t721u).
 *
 * firestore.interim.rules is the explicitly named release artifact for the
 * reviewed interim candidate. This file pins:
 *   - the source: the candidate fixture is still sha256 c1508fa0...;
 *   - the promotion: the release body (rules_version line to end of file) is
 *     byte-identical to the candidate body; only the header comment differs;
 *   - the release bytes themselves (sha256 pinned below);
 *   - selection: only firebase.interim-rules.json selects the artifact, and it
 *     carries a Firestore rules target and nothing else; firebase.json still
 *     targets firestore.rules;
 *   - carLocation parity: firestore.rules, the release artifact and the
 *     deployed production snapshot carry the identical private/carLocation
 *     match;
 *   - the artifact and head firestore.rules compile in the rules emulator, and
 *     head firestore.rules enforces the production carLocation behavior.
 * The candidate's own behavior is proven by
 * firestore.rules.test.interim-legacy-hardened.ts and
 * firestore.rules.test.interim-expression-budget.ts, unchanged.
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
import { doc, getDoc, setDoc, deleteDoc, Timestamp } from 'firebase/firestore';
import { assertRulesProject, readRulesEmulatorEndpoint } from './firestoreRulesEmulator';

const PROJECT_ID = 'demo-parkqueen-rules-test';
const rulesEmulator = readRulesEmulatorEndpoint();
assertRulesProject(PROJECT_ID);

const CANDIDATE_PATH = 'test-fixtures/interim-candidate/firestore.interim-legacy-hardened.rules';
const CANDIDATE_SHA256 = 'c1508fa02a15fff9b3a2d4a965d40254f540c7c69ffe5aed6405c0a6bb090400';
const RELEASE_PATH = 'firestore.interim.rules';
const RELEASE_SHA256 = 'f399f61765aa3738a49af49888772b87d35ea1b0cceb3a8a39cae11523479369';
const RELEASE_BODY_SHA256 = '566ee4dcc44e3d676b8eb265aa440b99778220d7162757e86440fcc875038e57';
const SELECTOR_PATH = 'firebase.interim-rules.json';
const DEPLOYED_PATH = 'test-fixtures/production-baseline/deployed-firestore-134a97cf.rules';
const DEPLOYED_SHA256 = '134a97cf8e25f2f8848ff4d2c0ff65ff5dd83434f1690901b4ba7dffe403810b';
const BODY_START = Buffer.from("rules_version = '2';");

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function bodyOf(bytes: Buffer): Buffer {
    const i = bytes.indexOf(BODY_START);
    if (i < 0) throw new Error('rules_version line not found');
    return bytes.subarray(i);
}

function carLocationBlock(text: string): string {
    const lines = text.split('\n');
    const start = lines.findIndex((l) => l.trim().startsWith('// private/carLocation'));
    if (start < 0) throw new Error('carLocation block not found');
    const end = lines.findIndex((l, i) => i > start && l === '      }');
    if (end < 0) throw new Error('carLocation block end not found');
    if (lines.filter((l) => l.includes('match /private/carLocation')).length !== 1) {
        throw new Error('expected exactly one carLocation match');
    }
    return lines.slice(start, end + 1).join('\n');
}

describe('t721u interim release artifact: identity and selection (offline)', () => {
    it('RELEASE R-ID1: the reviewed candidate is unchanged (sha256 c1508fa0...)', () => {
        expect(sha256(readFileSync(CANDIDATE_PATH))).toBe(CANDIDATE_SHA256);
    });

    it('RELEASE R-ID2: the release body is byte-identical to the candidate body; only the header differs', () => {
        const release = readFileSync(RELEASE_PATH);
        const candidate = readFileSync(CANDIDATE_PATH);
        expect(Buffer.compare(bodyOf(release), bodyOf(candidate))).toBe(0);
        expect(sha256(bodyOf(release))).toBe(RELEASE_BODY_SHA256);
        const header = release.subarray(0, release.indexOf(BODY_START)).toString('utf8');
        expect(header.split('\n').every((l) => l === '' || l.startsWith('//'))).toBe(true);
        expect(header).toContain(CANDIDATE_SHA256);
        expect(header).toContain(RELEASE_BODY_SHA256);
        expect(header).not.toContain('NONDEPLOYABLE');
    });

    it('RELEASE R-ID3: the release artifact bytes are pinned', () => {
        expect(sha256(readFileSync(RELEASE_PATH))).toBe(RELEASE_SHA256);
    });

    it('RELEASE R-SEL1: only firebase.interim-rules.json selects the artifact, with a Firestore rules target only', () => {
        const selector = JSON.parse(readFileSync(SELECTOR_PATH, 'utf8'));
        expect(selector).toEqual({ firestore: { rules: RELEASE_PATH } });
        const main = JSON.parse(readFileSync('firebase.json', 'utf8'));
        expect(([] as any[]).concat(main.firestore ?? []).map((t) => t.rules)).toEqual(['firestore.rules']);
        expect(readFileSync('firebase.json', 'utf8')).not.toContain(RELEASE_PATH);
        expect(readFileSync('package.json', 'utf8')).not.toContain(SELECTOR_PATH);
    });

    it('RELEASE R-CAR1: firestore.rules, the release artifact and the deployed snapshot carry the identical carLocation match', () => {
        const deployed = readFileSync(DEPLOYED_PATH);
        expect(sha256(deployed)).toBe(DEPLOYED_SHA256);
        const production = carLocationBlock(deployed.toString('utf8'));
        expect(carLocationBlock(readFileSync(RELEASE_PATH, 'utf8'))).toBe(production);
        expect(carLocationBlock(readFileSync('firestore.rules', 'utf8'))).toBe(production);
    });
});

const OWNER = 'car-owner';
const OTHER = 'car-other';
const CAR = () => ({ verification: 'UNVERIFIED', approximate: true, lat: 40.7, lng: -74, accuracyMeters: 25, savedAt: Timestamp.now() });

function rulesEnv(name: string, path: string, body: (env: () => RulesTestEnvironment) => void) {
    describe(name, () => {
        let testEnv: RulesTestEnvironment;
        beforeAll(async () => {
            testEnv = await initializeTestEnvironment({
                projectId: PROJECT_ID,
                firestore: { rules: readFileSync(path, 'utf8'), host: rulesEmulator.host, port: rulesEmulator.port },
            });
        });
        afterAll(async () => { await testEnv.cleanup(); });
        beforeEach(async () => { await testEnv.clearFirestore(); });
        body(() => testEnv);
    });
}

const car = (env: RulesTestEnvironment, actor: string, owner = actor) =>
    doc(env.authenticatedContext(actor).firestore(), 'users', owner, 'private', 'carLocation');

const seedProfile = (env: RulesTestEnvironment, uid: string, data: Record<string, unknown>) =>
    env.withSecurityRulesDisabled((ctx) => setDoc(doc(ctx.firestore(), 'users', uid), data));

rulesEnv('t721u release artifact compiles and serves carLocation like production', RELEASE_PATH, (env) => {
    it('RELEASE R-EMU1: the artifact loads; an owner saves, reads and deletes carLocation; another user cannot', async () => {
        await seedProfile(env(), OWNER, { username: 'owner', status: 'Active' });
        await assertSucceeds(setDoc(car(env(), OWNER), CAR()));
        await assertSucceeds(getDoc(car(env(), OWNER)));
        await assertFails(getDoc(car(env(), OTHER, OWNER)));
        await assertFails(setDoc(car(env(), OTHER, OWNER), CAR()));
        await assertSucceeds(deleteDoc(car(env(), OWNER)));
    });
});

rulesEnv('t721u head firestore.rules: production-compatible carLocation', 'firestore.rules', (env) => {
    it('HEAD H-CAR1: an owner creates, updates, reads and deletes private/carLocation', async () => {
        await seedProfile(env(), OWNER, { username: 'owner', status: 'Active' });
        await assertSucceeds(setDoc(car(env(), OWNER), CAR()));
        await assertSucceeds(setDoc(car(env(), OWNER), { ...CAR(), lat: 40.8 }));
        await assertSucceeds(getDoc(car(env(), OWNER)));
        await assertSucceeds(deleteDoc(car(env(), OWNER)));
    });

    it('HEAD H-CAR2: carLocation stays owner-only, unlistable and schema-bound', async () => {
        await seedProfile(env(), OWNER, { username: 'owner', status: 'Active' });
        await assertFails(setDoc(car(env(), OTHER, OWNER), CAR()));
        await assertFails(getDoc(car(env(), OTHER, OWNER)));
        await assertFails(setDoc(car(env(), OWNER), { ...CAR(), verification: 'VERIFIED' }));
        await assertFails(setDoc(car(env(), OWNER), { ...CAR(), approximate: false }));
        await assertFails(setDoc(car(env(), OWNER), { ...CAR(), curbId: 'x' }));
        await assertFails(setDoc(car(env(), OWNER), { ...CAR(), lat: 91 }));
        await assertFails(setDoc(car(env(), OWNER), { ...CAR(), savedAt: Timestamp.fromMillis(Date.now() - 10 * 60_000) }));
        await assertFails(setDoc(car(env(), OWNER), { ...CAR(), accuracyMeters: 100001 }));
        await assertFails(getDoc(doc(env().unauthenticatedContext().firestore(), 'users', OWNER, 'private', 'carLocation')));
    });

    it('CHARACTERIZATION H-CAR3: as in production, carLocation is self-scoped and not product-gated (a Suspended owner can still save it)', async () => {
        await seedProfile(env(), OWNER, { username: 'owner', status: 'Suspended', productAccessBlocked: true });
        await assertSucceeds(setDoc(car(env(), OWNER), CAR()));
    });
});
