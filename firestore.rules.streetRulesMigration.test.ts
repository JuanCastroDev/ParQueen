/**
 * Proposed streetRules read boundary. This does not load firestore.rules
 * and does not change the deployed rules. It runs only against the isolated
 * emulator on 127.0.0.1:8181 so the PR #369 emulator on 8080 is left alone.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, beforeAll, afterAll, beforeEach, expect } from 'vitest';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { collectionGroup, doc, getDoc, getDocs, setDoc } from 'firebase/firestore';
import { readRulesEmulatorEndpoint } from './firestoreRulesEmulator';

const root = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(root, 'functions/package.json'));
const { PROPOSED_STREET_RULES } = require('./curbIntelligence/streetRulesClientAccess');
const isolated = process.env.PARQUEEN_RULES_ISOLATED === '1'
  && process.env.FIRESTORE_EMULATOR_HOST === '127.0.0.1:8181';

describe.skipIf(!isolated)('proposed streetRules reads require founder approval', () => {
  let testEnv: RulesTestEnvironment;
  const rulesEmulator = isolated ? readRulesEmulatorEndpoint() : { host: '127.0.0.1' as const, port: 8181 };

  beforeAll(async () => {
    const deployed = readFileSync(path.join(root, 'firestore.rules'), 'utf8');
    expect(deployed).toMatch(/allow read: if true;/);
    expect(PROPOSED_STREET_RULES).toContain('allow read: if false;');
    expect(PROPOSED_STREET_RULES).not.toBe(deployed);
    testEnv = await initializeTestEnvironment({
      projectId: 'demo-parkqueen-rules-test',
      firestore: {
        rules: PROPOSED_STREET_RULES,
        host: rulesEmulator.host,
        port: rulesEmulator.port,
      },
    });
  });

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  beforeEach(async () => {
    await testEnv.clearFirestore();
    await testEnv.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, 'streetSegments', 'seg-1'), { streetName: 'Melville Street', status: 'active' });
      await setDoc(doc(db, 'streetSegments', 'seg-1', 'streetRules', 'rule-1'), {
        type: 'streetCleaning',
        supersededAt: null,
      });
    });
  });

  it('lets a client read the segment and denies the nested schedule', async () => {
    const anon = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(anon, 'streetSegments', 'seg-1')));
    await assertFails(getDoc(doc(anon, 'streetSegments', 'seg-1', 'streetRules', 'rule-1')));
  });

  it('denies an authenticated client and a token-role admin the same schedule', async () => {
    const user = testEnv.authenticatedContext('old-client').firestore();
    const admin = testEnv.authenticatedContext('admin-user', { role: 'admin' }).firestore();
    await assertFails(getDoc(doc(user, 'streetSegments', 'seg-1', 'streetRules', 'rule-1')));
    await assertFails(getDoc(doc(admin, 'streetSegments', 'seg-1', 'streetRules', 'rule-1')));
  });

  it('denies a collection-group schedule query', async () => {
    const anon = testEnv.unauthenticatedContext().firestore();
    await assertFails(getDocs(collectionGroup(anon, 'streetRules')));
  });

  it('keeps client writes closed', async () => {
    const user = testEnv.authenticatedContext('old-client').firestore();
    await assertFails(setDoc(doc(user, 'streetSegments', 'seg-2'), { streetName: 'New' }));
    await assertFails(setDoc(doc(user, 'streetSegments', 'seg-1', 'streetRules', 'rule-2'), { type: 'streetCleaning' }));
  });
});
