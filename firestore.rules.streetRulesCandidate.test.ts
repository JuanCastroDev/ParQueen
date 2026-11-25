/**
 * Candidate rules are the complete firestore.rules file with only the two
 * streetRules read clauses closed. The production file is not modified.
 * Runs only on the isolated emulator at 127.0.0.1:8181.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collectionGroup, doc, getDoc, getDocs, setDoc } from 'firebase/firestore';
import { readRulesEmulatorEndpoint } from './firestoreRulesEmulator';

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(root, 'functions/package.json'));
const { buildStreetRulesClosedCandidate, streetRulesReadDiff } = require('./curbIntelligence/streetRulesCandidate');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const isolated = process.env.PARQUEEN_RULES_ISOLATED === '1'
  && process.env.FIRESTORE_EMULATOR_HOST === '127.0.0.1:8181';

describe.skipIf(!isolated)('full ruleset streetRules candidate', () => {
  let testEnv: RulesTestEnvironment;
  const rulesEmulator = isolated ? readRulesEmulatorEndpoint() : { host: '127.0.0.1' as const, port: 8181 };
  const deployed = readFileSync(path.join(root, 'firestore.rules'), 'utf8');
  const candidate = buildStreetRulesClosedCandidate(deployed);

  beforeAll(async () => {
    expect(streetRulesReadDiff(deployed, candidate)).toHaveLength(2);
    expect(candidate.length).toBeGreaterThan(deployed.length - 20);
    testEnv = await initializeTestEnvironment({
      projectId: 'demo-parkqueen-rules-test',
      firestore: { rules: candidate, host: rulesEmulator.host, port: rulesEmulator.port },
    });
    if (!getApps().some(app => app.name === 'rules-admin')) {
      initializeApp({ projectId: 'demo-parkqueen-rules-test' }, 'rules-admin');
    }
  });

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'streetSegments', 'seg-1'), { streetName: 'Melville Street', status: 'active' });
      await setDoc(doc(db, 'streetSegments', 'seg-1', 'streetRules', 'rule-1'), { type: 'streetCleaning', schedules: [{ side: 'West' }] });
      await setDoc(doc(db, 'other', 'parent', 'streetRules', 'rule-wild'), { type: 'streetCleaning' });
      await setDoc(doc(db, 'suspensions', 'susp-1'), { status: 'active' });
      await setDoc(doc(db, 'users', 'someone', 'private', 'account'), { reportCount: 1 });
    });
  });

  it('denies anonymous, authenticated, and token-role admin schedule reads', async () => {
    const anon = testEnv.unauthenticatedContext().firestore();
    const user = testEnv.authenticatedContext('old-client').firestore();
    const adminToken = testEnv.authenticatedContext('admin-user', { role: 'admin' }).firestore();
    await assertSucceeds(getDoc(doc(anon, 'streetSegments', 'seg-1')));
    await assertFails(getDoc(doc(anon, 'streetSegments', 'seg-1', 'streetRules', 'rule-1')));
    await assertFails(getDoc(doc(user, 'streetSegments', 'seg-1', 'streetRules', 'rule-1')));
    await assertFails(getDoc(doc(adminToken, 'streetSegments', 'seg-1', 'streetRules', 'rule-1')));
  });

  it('denies collection-group and overlapping wildcard schedule reads', async () => {
    const anon = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDocs(collectionGroup(anon, 'streetRules')));
    await assertFails(getDoc(doc(anon, 'other', 'parent', 'streetRules', 'rule-wild')));
  });

  it('preserves public suspension reads, closed client writes, and private account reads', async () => {
    const anon = testEnv.unauthenticatedContext().firestore();
    const user = testEnv.authenticatedContext('old-client').firestore();
    await assertSucceeds(getDoc(doc(anon, 'suspensions', 'susp-1')));
    await assertFails(setDoc(doc(user, 'streetSegments', 'seg-2'), { streetName: 'New' }));
    await assertFails(setDoc(doc(user, 'streetSegments', 'seg-1', 'streetRules', 'rule-2'), { type: 'streetCleaning' }));
    await assertFails(getDoc(doc(user, 'users', 'someone', 'private', 'account')));
  });

  it('SS-5: admin token cannot read streetRules directly', async () => {
    const adminToken = testEnv.authenticatedContext('admin-user', { role: 'admin' }).firestore();
    await assertFails(getDoc(doc(adminToken, 'streetSegments', 'seg-1', 'streetRules', 'rule-1')));
    await assertSucceeds(getDoc(doc(adminToken, 'streetSegments', 'seg-1')));
  });

  it('SS-8: public segment reads stay open and streetRules reads are denied', async () => {
    const anon = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(anon, 'streetSegments', 'seg-1')));
    await assertFails(getDoc(doc(anon, 'streetSegments', 'seg-1', 'streetRules', 'rule-1')));
  });

  it('F: street segments and suspensions stay publicly readable while street rules are denied', async () => {
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'streetSegments', 'seg-s7'), { name: 'Main' });
      await setDoc(doc(db, 'streetSegments', 'seg-s7', 'streetRules', 'rule-s7'), { days: ['Mon'] });
      await setDoc(doc(db, 'suspensions', 'curb-s7'), { reason: 'sweep' });
    });
    const anon = testEnv.unauthenticatedContext().firestore();
    const user = testEnv.authenticatedContext('old-client').firestore();
    await assertSucceeds(getDoc(doc(anon, 'streetSegments', 'seg-s7')));
    await assertFails(getDoc(doc(anon, 'streetSegments', 'seg-s7', 'streetRules', 'rule-s7')));
    await assertSucceeds(getDoc(doc(anon, 'suspensions', 'curb-s7')));
    await assertSucceeds(getDoc(doc(user, 'streetSegments', 'seg-s7')));
    await assertSucceeds(getDoc(doc(user, 'suspensions', 'curb-s7')));
    await assertFails(getDoc(doc(user, 'streetSegments', 'seg-s7', 'streetRules', 'rule-s7')));
  });

  it('lets the Admin SDK read a schedule the client rules deny', async () => {
    const snap = await getFirestore(getApps().find(app => app.name === 'rules-admin')!).doc('streetSegments/seg-1/streetRules/rule-1').get();
    expect(snap.exists).toBe(true);
    expect(snap.data()?.type).toBe('streetCleaning');
  });
});
