/**
 * Isolated new-scheme collections: legacy streetSegments / streetRules
 * queries must not observe streetSegmentsV2 / streetRulesV2 documents,
 * and clients still cannot write either tree.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, getDocs, setDoc, collection, collectionGroup, query } from 'firebase/firestore';
import { assertRulesProject, readRulesEmulatorEndpoint } from './firestoreRulesEmulator';

const PROJECT_ID = 'demo-parkqueen-rules-test';
const rulesEmulator = readRulesEmulatorEndpoint();
assertRulesProject(PROJECT_ID);

let testEnv: RulesTestEnvironment;

describe('streetSegmentsV2 isolation', () => {
  beforeAll(async () => {
    testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: rulesEmulator.host,
        port: rulesEmulator.port,
        rules: readFileSync(path.join(process.cwd(), 'firestore.rules'), 'utf8'),
      },
    });
  });

  afterAll(async () => {
    await testEnv?.cleanup();
  });

  it('hides new-scheme documents from legacy streetSegments and streetRules queries', async () => {
    await testEnv.clearFirestore();
    await testEnv.withSecurityRulesDisabled(async (ctx) => {
      const db = ctx.firestore();
      await setDoc(doc(db, 'streetSegments/legacy-key'), { status: 'active', source: 'admin' });
      await setDoc(doc(db, 'streetSegments/legacy-key/streetRules/r1'), { category: 'cleaning' });
      await setDoc(doc(db, 'streetSegmentsV2/new-key'), {
        status: 'active',
        writeAuthority: { scheme: 1, generationId: 'a'.repeat(32), deadlineAtMs: 1, committedAt: 1, promotedAt: 2 },
      });
      await setDoc(doc(db, 'streetSegmentsV2/new-key/streetRulesV2/r1'), { category: 'cleaning' });
    });

    const anon = testEnv.unauthenticatedContext().firestore();
    await assertSucceeds(getDoc(doc(anon, 'streetSegments/legacy-key')));
    await assertSucceeds(getDoc(doc(anon, 'streetSegmentsV2/new-key')));
    await assertFails(setDoc(doc(anon, 'streetSegmentsV2/new-key'), { status: 'hacked' }));
    await assertFails(setDoc(doc(anon, 'streetSegmentsV2/new-key/streetRulesV2/r1'), { category: 'hacked' }));

    const legacyList = await assertSucceeds(getDocs(collection(anon, 'streetSegments')));
    const legacyIds = legacyList.docs.map((item) => item.id).sort();
    expect(legacyIds).toEqual(['legacy-key']);

    const v2List = await assertSucceeds(getDocs(collection(anon, 'streetSegmentsV2')));
    expect(v2List.docs.map((item) => item.id)).toEqual(['new-key']);

    const legacyGroup = await assertSucceeds(getDocs(query(collectionGroup(anon, 'streetRules'))));
    expect(legacyGroup.docs.map((item) => item.id).sort()).toEqual(['r1']);
    expect(legacyGroup.docs.every((item) => item.ref.path.startsWith('streetSegments/legacy-key/streetRules/'))).toBe(true);

    const v2Group = await assertSucceeds(getDocs(query(collectionGroup(anon, 'streetRulesV2'))));
    expect(v2Group.docs.map((item) => item.ref.path)).toEqual(['streetSegmentsV2/new-key/streetRulesV2/r1']);
  });
});
