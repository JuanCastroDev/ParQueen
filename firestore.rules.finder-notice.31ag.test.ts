import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc, Timestamp } from 'firebase/firestore';
import { assertRulesProject, readRulesEmulatorEndpoint, RULES_PROJECT_ID } from './firestoreRulesEmulator';
import { rulesTextUnderTest } from './firestoreRulesUnderTest';

const rulesEmulator = readRulesEmulatorEndpoint();
assertRulesProject(RULES_PROJECT_ID);

const FINDER = 'finder-31ag';
const CLAIMER = 'claimer-31ag';
let env: RulesTestEnvironment;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: RULES_PROJECT_ID,
    firestore: { rules: rulesTextUnderTest(), host: rulesEmulator.host, port: rulesEmulator.port },
  });
});

beforeEach(async () => {
  await env.clearFirestore();
});

afterAll(async () => {
  await env.cleanup();
});

describe('finder cancellation notice authority', () => {
  it('denies a client cancellation notice and a client receipt write', async () => {
    await env.withSecurityRulesDisabled(async (ctx) => {
      // t743u: both participants are signed-up users with a profile.
      const fs = ctx.firestore();
      await setDoc(doc(fs, 'users', FINDER), { status: 'Active' });
      await setDoc(doc(fs, 'users', CLAIMER), { status: 'Active' });
      await setDoc(doc(fs, 'spots', 'live'), {
        finderId: FINDER,
        status: 'interested',
        interestedUserId: CLAIMER,
        claimState: 'heading',
        claimGenerationId: 'a'.repeat(64),
        address: 'Live',
        lat: 40.7,
        lng: -74,
      });
    });
    const finder = env.authenticatedContext(FINDER).firestore();
    const createdAt = Timestamp.fromMillis(Date.now() - 1000);
    await expect(setDoc(doc(finder, 'spotNotifications', 'forged'), {
      spotId: 'live',
      senderId: FINDER,
      targetUserId: CLAIMER,
      type: 'cancelled',
      message: 'The spot is no longer available.',
      createdAt,
    })).rejects.toHaveProperty('code', 'permission-denied');
    await expect(setDoc(doc(finder, 'finderCancelReceipts', 'live_generation'), {
      spotId: 'live',
      finderId: FINDER,
      kind: 'generation',
    })).rejects.toHaveProperty('code', 'permission-denied');
    await expect(getDoc(doc(finder, 'finderCancelReceipts', 'live_generation'))).rejects.toHaveProperty('code', 'permission-denied');
    const claimer = env.authenticatedContext(CLAIMER).firestore();
    await setDoc(doc(claimer, 'spotNotifications', 'claimer-ok'), {
      spotId: 'live',
      senderId: CLAIMER,
      targetUserId: FINDER,
      type: 'claimer_cancelled',
      message: 'The claimer released the spot.',
      createdAt,
    });
  });

  it('keeps finder-cancel notices out of the client create list', () => {
    const rules = rulesTextUnderTest();
    const notification = rules.slice(rules.indexOf('match /spotNotifications/'), rules.indexOf('// Design A attestations'));
    expect(notification).not.toContain("'cancelled',");
    expect(notification).toContain("'claimer_cancelled'");
    expect(rules).toContain('match /finderCancelReceipts/{receiptId}');
    expect(rules).toContain('allow read, write: if false;');
  });
});
