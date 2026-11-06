import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { deleteDoc, doc, getDoc, setDoc, Timestamp } from 'firebase/firestore';

const PROJECT_ID = 'demo-parkqueen-rules-test';
const OWNER = 'ping-delete-owner';
const OTHER = 'ping-delete-other';
const CLAIM_GENERATION = 'ab'.repeat(32);
let env: RulesTestEnvironment;

const baseSpot = (overrides: Record<string, unknown> = {}) => ({
  finderId: OWNER,
  finderName: 'Owner',
  address: 'Emulator test street',
  lat: 40.71,
  lng: -74.0,
  type: 'free',
  status: 'available',
  pingMode: 'now',
  reportedAt: Timestamp.now(),
  expiresAt: Timestamp.fromMillis(Date.now() + 30 * 60_000),
  ...overrides,
});

async function seed(path: [string, ...string[]], data: Record<string, unknown>) {
  await env.withSecurityRulesDisabled(async (context) => {
    await setDoc(doc(context.firestore(), ...path), data);
  });
}

async function exists(path: [string, ...string[]]) {
  let present = false;
  await env.withSecurityRulesDisabled(async (context) => {
    present = (await getDoc(doc(context.firestore(), ...path))).exists();
  });
  return present;
}

describe('Ping direct-delete fallback rules', () => {
  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: { rules: readFileSync('firestore.rules', 'utf8') },
    });
  });

  beforeEach(async () => {
    await env.clearFirestore();
    await seed(['users', OWNER], { username: 'owner', status: 'Active' });
    await seed(['users', OTHER], { username: 'other', status: 'Active' });
  });

  afterAll(async () => env.cleanup());

  it('allows the owner to delete an available unclaimed Ping', async () => {
    await seed(['spots', 'open'], baseSpot());
    await assertSucceeds(deleteDoc(doc(env.authenticatedContext(OWNER).firestore(), 'spots', 'open')));
    expect(await exists(['spots', 'open'])).toBe(false);
  });

  it('allows the owner to delete an eligible scheduled Ping', async () => {
    await seed(['spots', 'scheduled'], baseSpot({
      pingMode: 'later',
      reportedAt: Timestamp.fromMillis(Date.now() + 20 * 60_000),
      expiresAt: Timestamp.fromMillis(Date.now() + 50 * 60_000),
    }));
    await assertSucceeds(deleteDoc(doc(env.authenticatedContext(OWNER).firestore(), 'spots', 'scheduled')));
    expect(await exists(['spots', 'scheduled'])).toBe(false);
  });

  it('denies another user', async () => {
    await seed(['spots', 'not-owner'], baseSpot());
    await assertFails(deleteDoc(doc(env.authenticatedContext(OTHER).firestore(), 'spots', 'not-owner')));
    expect(await exists(['spots', 'not-owner'])).toBe(true);
  });

  it('uses current server state and denies a Ping claimed after confirmation', async () => {
    await seed(['spots', 'concurrent'], baseSpot());
    await seed(['spots', 'concurrent'], baseSpot({
      status: 'interested',
      interestedUserId: OTHER,
      claimState: 'heading',
      claimGenerationId: CLAIM_GENERATION,
    }));
    await assertFails(deleteDoc(doc(env.authenticatedContext(OWNER).firestore(), 'spots', 'concurrent')));
    expect(await exists(['spots', 'concurrent'])).toBe(true);
  });

  it.each([
    ['stored generation', { claimGenerationId: CLAIM_GENERATION }],
    ['released claim retaining identity', { interestedUserId: null, claimState: null, claimGenerationId: CLAIM_GENERATION }],
    ['retained claim state', { interestedUserId: null, claimState: 'released', claimGenerationId: null }],
  ])('denies an available Ping with %s', async (_label, identity) => {
    await seed(['spots', 'protected'], baseSpot(identity));
    await assertFails(deleteDoc(doc(env.authenticatedContext(OWNER).firestore(), 'spots', 'protected')));
    expect(await exists(['spots', 'protected'])).toBe(true);
  });

  it('does not alter claim locks, cancellation receipts, or notifications', async () => {
    await seed(['spots', 'invariants'], baseSpot());
    await seed(['users', OTHER, 'activeIncomingClaims', 'current'], { spotId: 'different-spot' });
    await seed(['finderCancelReceipts', 'existing'], { spotId: 'different-spot' });
    await seed(['notifications', 'existing'], { userId: OTHER, type: 'claim_cancelled' });

    await assertSucceeds(deleteDoc(doc(env.authenticatedContext(OWNER).firestore(), 'spots', 'invariants')));

    expect(await exists(['users', OTHER, 'activeIncomingClaims', 'current'])).toBe(true);
    expect(await exists(['finderCancelReceipts', 'existing'])).toBe(true);
    expect(await exists(['notifications', 'existing'])).toBe(true);
  });
});
