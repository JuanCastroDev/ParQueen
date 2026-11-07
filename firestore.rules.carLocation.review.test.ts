import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  setDoc,
  Timestamp,
} from 'firebase/firestore';
import { rulesFirestorePort } from './rulesEmulatorPorts';

const PROJECT_ID = 'demo-parkqueen-s7-fn-iso';
const OWNER = 'car-owner';
const OTHER = 'car-other';

let env: RulesTestEnvironment;

function bookmark(savedAt = Timestamp.now()) {
  return {
    verification: 'UNVERIFIED',
    approximate: true,
    lat: 40.71,
    lng: -74.0,
    accuracyMeters: 50,
    savedAt,
  };
}

async function seedUser(uid: string, data: Record<string, unknown>) {
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), 'users', uid), data);
  });
}

describe('private/carLocation production bookmark under product denial', () => {
  beforeAll(async () => {
    env = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: readFileSync('firestore.rules', 'utf8'),
        host: '127.0.0.1',
        port: rulesFirestorePort(),
      },
    });
  });

  afterAll(async () => {
    await env.cleanup();
  });

  beforeEach(async () => {
    await env.clearFirestore();
  });

  it('lets an active owner save, read, and delete an approximate unverified bookmark', async () => {
    await seedUser(OWNER, { status: 'Active', productAccessBlocked: false });
    const db = env.authenticatedContext(OWNER).firestore();
    const ref = doc(db, 'users', OWNER, 'private', 'carLocation');
    await assertSucceeds(setDoc(ref, bookmark()));
    const saved = await assertSucceeds(getDoc(ref));
    expect(saved.data()?.verification).toBe('UNVERIFIED');
    await assertSucceeds(deleteDoc(ref));
  });

  it('keeps the legacy allow when productAccessBlocked is absent', async () => {
    await seedUser(OWNER, { status: 'Active' });
    const db = env.authenticatedContext(OWNER).firestore();
    await assertSucceeds(setDoc(doc(db, 'users', OWNER, 'private', 'carLocation'), bookmark()));
  });

  it('denies another user, a list, a verified flag, an out-of-range coordinate, and an extra field', async () => {
    await seedUser(OWNER, { status: 'Active', productAccessBlocked: false });
    const owner = env.authenticatedContext(OWNER).firestore();
    const other = env.authenticatedContext(OTHER).firestore();
    const ref = doc(owner, 'users', OWNER, 'private', 'carLocation');
    await assertSucceeds(setDoc(ref, bookmark()));
    await assertFails(getDoc(doc(other, 'users', OWNER, 'private', 'carLocation')));
    await assertFails(getDocs(collection(owner, 'users', OWNER, 'private')));
    await assertFails(setDoc(ref, { ...bookmark(), verification: 'VERIFIED' }));
    await assertFails(setDoc(ref, { ...bookmark(), lat: 91 }));
    await assertFails(setDoc(ref, { ...bookmark(), note: 'home' }));
  });

  it('denies a deletion-fenced owner', async () => {
    await seedUser(OWNER, { status: 'Active', productAccessBlocked: false });
    await env.withSecurityRulesDisabled(async (ctx) => {
      await setDoc(doc(ctx.firestore(), 'accountLifecycle', OWNER), { decision: 'delete' });
    });
    const db = env.authenticatedContext(OWNER).firestore();
    const ref = doc(db, 'users', OWNER, 'private', 'carLocation');
    await assertFails(setDoc(ref, bookmark()));
    await assertFails(getDoc(ref));
  });

  it('denies a suspended owner and a malformed or true block flag', async () => {
    const db = () => env.authenticatedContext(OWNER).firestore();
    const ref = () => doc(db(), 'users', OWNER, 'private', 'carLocation');
    await seedUser(OWNER, { status: 'Suspended', productAccessBlocked: false });
    await assertFails(setDoc(ref(), bookmark()));
    await assertFails(getDoc(ref()));
    for (const productAccessBlocked of [true, 'false', 1, null]) {
      await seedUser(OWNER, { status: 'Active', productAccessBlocked });
      await assertFails(setDoc(ref(), bookmark()));
    }
  });
});
