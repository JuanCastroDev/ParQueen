/**
 * Phase 16B-1I: Firestore emulator-backed analytics withdrawal tests.
 *
 * NEVER run against production. This suite requires FIRESTORE_EMULATOR_HOST
 * to be localhost/127.0.0.1 and uses a fixed demo-* project ID.
 *
 * Run via:
 * firebase emulators:exec --only firestore --project demo-parkqueen-rules-test \
 *   "node node_modules/vitest/vitest.mjs run utils/analyticsConsentFirestore.emulator.test.ts"
 *
 * Tests real Firebase Firestore SDK network disable/enable and Rules authorization.
 * The mocked app auth object mirrors the same UID as an emulator-authenticated
 * Firestore client. It does NOT verify device process termination, Web offline
 * persistence, or simultaneous writes originating on different devices.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  disableNetwork,
  doc,
  enableNetwork,
  getDocFromServer,
  setDoc,
  type Firestore,
} from 'firebase/firestore';

const fakeApp = vi.hoisted(() => ({
  auth: { currentUser: null as null | { uid: string } },
  database: null as Firestore | null,
}));

// Crucial: prevent importing the app's real firebase.ts and production config.
// The coordinator still talks to a REAL Firestore SDK instance from the local
// RulesTestEnvironment, authenticated with an emulator-only identity.
vi.mock('../firebase', () => ({
  get db() { return fakeApp.database; },
  get auth() { return fakeApp.auth; },
}));

import {
  beginAnalyticsConsentSession,
  getAnalyticsConsentDisplayState,
  hasPendingAnalyticsOptOut,
  isAnalyticsCollectionAllowed,
  receiveAnalyticsConsentSnapshot,
} from './analyticsConsentSession';
import {
  reconcilePendingAnalyticsOptOut,
  requestAnalyticsConsentChange,
} from './analyticsConsentReconciliation';

const PROJECT_ID = 'demo-parkqueen-rules-test';
const VERIFIED = { fromCache: false, hasPendingWrites: false };
const PENDING_PREFIX = 'parqueen_analytics_pending_optout_v1_';
const storageMap = new Map<string, string>();
let environment: RulesTestEnvironment;

function emulatorAddress() {
  const raw = process.env.FIRESTORE_EMULATOR_HOST ?? '';
  const match = /^(localhost|127\.0\.0\.1):(\d+)$/.exec(raw);
  if (!match) {
    throw new Error('STOP: FIRESTORE_EMULATOR_HOST must point to a local emulator. Never use production.');
  }
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error('STOP: Invalid Firestore emulator port.');
  }
  return { host: match[1], port };
}

function signedInClient(uid: string): Firestore {
  fakeApp.auth.currentUser = { uid };
  // RulesTestEnvironment returns a compat Firestore type; the modular SDK
  // accepts its underlying delegate at runtime (verified by emulator tests).
  const client = environment.authenticatedContext(uid).firestore() as unknown as Firestore;
  fakeApp.database = client;
  beginAnalyticsConsentSession(uid);
  return client;
}

function preferences(db: Firestore, uid: string) {
  return doc(db, 'users', uid, 'private', 'preferences');
}

async function seedPreference(uid: string, analyticsConsent: boolean) {
  await environment.withSecurityRulesDisabled(async context => {
    await setDoc(preferences(context.firestore() as unknown as Firestore, uid), { analyticsConsent });
  });
}

async function acknowledgeServerSnapshot(db: Firestore, uid: string) {
  const snap = await getDocFromServer(preferences(db, uid));
  expect(snap.exists()).toBe(true);
  expect(snap.metadata.fromCache).toBe(false);
  expect(snap.metadata.hasPendingWrites).toBe(false);
  receiveAnalyticsConsentSnapshot(uid, snap.data(), VERIFIED);
}

async function within<T>(promise: Promise<T>, label: string, ms = 25000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`STOP: ${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

beforeAll(async () => {
  const { host, port } = emulatorAddress();
  environment = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      host,
      port,
      rules: readFileSync(path.resolve('firestore.rules'), 'utf8'),
    },
  });
}, 45000);

beforeEach(async () => {
  storageMap.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storageMap.get(key) ?? null,
    setItem: (key: string, value: string) => { storageMap.set(key, String(value)); },
    removeItem: (key: string) => { storageMap.delete(key); },
  });
  fakeApp.auth.currentUser = null;
  fakeApp.database = null;
  beginAnalyticsConsentSession(null);
  await environment.clearFirestore();
});

afterEach(() => {
  beginAnalyticsConsentSession(null);
  fakeApp.auth.currentUser = null;
  fakeApp.database = null;
  vi.unstubAllGlobals();
});

afterAll(async () => {
  if (environment) await environment.cleanup();
}, 45000);

describe('Phase 16B-1I local Firestore emulator consent behavior', () => {
  it('submits OFF while an older ON write is unresolved offline and confirms final server OFF', async () => {
    const uid = 'emulator-analytics-race';
    await seedPreference(uid, true);
    const client = signedInClient(uid);
    await acknowledgeServerSnapshot(client, uid);
    expect(isAnalyticsCollectionAllowed()).toBe(true);

    await within(disableNetwork(client), 'disable Firestore network');
    let restored = false;
    try {
      // ON remains queued in Firestore; OFF must be submitted immediately,
      // without awaiting ON. Neither write is acknowledged while offline.
      const pendingOn = requestAnalyticsConsentChange(uid, true);
      const pendingOff = requestAnalyticsConsentChange(uid, false);

      expect(hasPendingAnalyticsOptOut(uid)).toBe(true);
      expect(storageMap.get(PENDING_PREFIX + uid)).toBe('1');
      expect(getAnalyticsConsentDisplayState(uid)).toBe('pending_off');
      expect(isAnalyticsCollectionAllowed()).toBe(false);

      await within(enableNetwork(client), 'enable Firestore network');
      restored = true;
      await within(Promise.all([pendingOn, pendingOff]), 'ON/OFF server reconciliation');

      const server = await within(getDocFromServer(preferences(client, uid)), 'read server preference');
      expect(server.data()?.analyticsConsent).toBe(false);
      expect(hasPendingAnalyticsOptOut(uid)).toBe(false);
      expect(storageMap.has(PENDING_PREFIX + uid)).toBe(false);
      expect(isAnalyticsCollectionAllowed()).toBe(false);
    } finally {
      if (!restored) await enableNetwork(client);
    }
  }, 60000);

  it('recovers a persisted OFF marker at startup with the server still ON', async () => {
    const uid = 'emulator-analytics-startup';
    await seedPreference(uid, true);

    // Simulates a fresh app session that discovers the saved marker after
    // reconnecting. This is NOT a full browser process termination test.
    storageMap.set(PENDING_PREFIX + uid, '1');
    const client = signedInClient(uid);
    expect(hasPendingAnalyticsOptOut(uid)).toBe(true);
    expect(getAnalyticsConsentDisplayState(uid)).toBe('pending_off');
    expect(isAnalyticsCollectionAllowed()).toBe(false);

    const initial = await getDocFromServer(preferences(client, uid));
    expect(initial.data()?.analyticsConsent).toBe(true);
    receiveAnalyticsConsentSnapshot(uid, initial.data(), VERIFIED);
    expect(isAnalyticsCollectionAllowed()).toBe(false);

    await within(reconcilePendingAnalyticsOptOut(uid, true), 'startup OFF reconciliation');

    const finalServer = await within(getDocFromServer(preferences(client, uid)), 'read reconciled preference');
    expect(finalServer.data()?.analyticsConsent).toBe(false);
    expect(storageMap.has(PENDING_PREFIX + uid)).toBe(false);
    expect(hasPendingAnalyticsOptOut(uid)).toBe(false);
    expect(isAnalyticsCollectionAllowed()).toBe(false);
  }, 60000);
});
