import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../firebase', () => ({
  db: { name: 'test-db' },
  auth: { currentUser: { uid: 'none' } },
}));

vi.mock('firebase/firestore', () => ({
  doc: vi.fn((_db, ...parts: string[]) => ({ path: parts.join('/') })),
  setDoc: vi.fn(async () => {}),
  getDocFromServer: vi.fn(async () => ({
    exists: () => true,
    data: () => ({ analyticsConsent: false }),
  })),
}));

import { auth } from '../firebase';
import { getDocFromServer, setDoc } from 'firebase/firestore';
import {
  beginAnalyticsConsentSession,
  confirmAnalyticsOptOutReconciled,
  getAnalyticsConsentDisplayState,
  hasPendingAnalyticsOptOut,
  isAnalyticsCollectionAllowed,
  receiveAnalyticsConsentSnapshot,
  revokeAnalyticsConsentImmediately,
} from './analyticsConsentSession';
import {
  observePendingAnalyticsOptOut,
  reconcilePendingAnalyticsOptOut,
  requestAnalyticsConsentChange,
} from './analyticsConsentReconciliation';

const confirmed = { fromCache: false, hasPendingWrites: false };
const storage = new Map<string, string>();
let uid: string;
let seq = 0;
let serverValue: boolean;

const flush = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

function mockedWriteValues(): boolean[] {
  return vi.mocked(setDoc).mock.calls.map(call => {
    const args: unknown = call;
    if (!Array.isArray(args) || typeof args[1] !== 'object' || args[1] === null) {
      throw new Error('Malformed Firestore write');
    }
    return (args[1] as { analyticsConsent: boolean }).analyticsConsent;
  });
}

beforeEach(() => {
  uid = `reconcile-account-${++seq}`;
  serverValue = true;
  storage.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, String(value)); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  (auth as { currentUser: { uid: string } | null }).currentUser = { uid };
  beginAnalyticsConsentSession(uid);
  vi.mocked(setDoc).mockReset();
  vi.mocked(setDoc).mockImplementation(async (_ref, data) => {
    serverValue = (data as { analyticsConsent: boolean }).analyticsConsent;
  });
  vi.mocked(getDocFromServer).mockReset();
  vi.mocked(getDocFromServer).mockImplementation(async () => ({
    exists: () => true,
    data: () => ({ analyticsConsent: serverValue }),
  } as never));
});

afterEach(() => {
  (auth as { currentUser: { uid: string } | null }).currentUser = { uid };
  beginAnalyticsConsentSession(uid);
  confirmAnalyticsOptOutReconciled(uid);
  beginAnalyticsConsentSession(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('durable analytics withdrawal reconciliation', () => {
  it('submits OFF immediately even if an older ON write is pending', async () => {
    let resolveOn!: () => void;
    vi.mocked(setDoc).mockImplementation((_ref, data) => {
      const enabled = (data as { analyticsConsent: boolean }).analyticsConsent;
      if (enabled) return new Promise<void>(resolve => {
        resolveOn = () => { serverValue = true; resolve(); };
      });
      serverValue = false;
      return Promise.resolve();
    });

    const on = requestAnalyticsConsentChange(uid, true);
    const off = requestAnalyticsConsentChange(uid, false);
    expect(mockedWriteValues()).toEqual([true, false]);
    expect(hasPendingAnalyticsOptOut(uid)).toBe(true);
    expect(isAnalyticsCollectionAllowed()).toBe(false);

    await flush();
    // The veto cannot clear while the earlier ON might still arrive.
    expect(getAnalyticsConsentDisplayState(uid)).toBe('pending_off');

    resolveOn();
    await on;
    await off;
    expect(mockedWriteValues()).toEqual([true, false, false]);
    expect(serverValue).toBe(false);
    expect(hasPendingAnalyticsOptOut(uid)).toBe(false);
    expect(isAnalyticsCollectionAllowed()).toBe(false);
  });

  it('does not clear the durable veto on an unrelated confirmed OFF snapshot', async () => {
    let release!: () => void;
    vi.mocked(setDoc).mockImplementationOnce(() => new Promise<void>(resolve => {
      release = () => resolve();
    }));

    const off = requestAnalyticsConsentChange(uid, false);
    receiveAnalyticsConsentSnapshot(uid, { analyticsConsent: false }, confirmed);
    expect(getAnalyticsConsentDisplayState(uid)).toBe('pending_off');
    expect(vi.mocked(getDocFromServer)).not.toHaveBeenCalled();

    serverValue = false;
    release();
    await off;
    expect(hasPendingAnalyticsOptOut(uid)).toBe(false);
  });

  it('recovers an OFF intent after logout, restart, and login', async () => {
    revokeAnalyticsConsentImmediately();
    beginAnalyticsConsentSession(null);
    beginAnalyticsConsentSession(uid);
    receiveAnalyticsConsentSnapshot(uid, { analyticsConsent: true }, confirmed);
    expect(getAnalyticsConsentDisplayState(uid)).toBe('pending_off');

    await reconcilePendingAnalyticsOptOut(uid);
    expect(mockedWriteValues()).toEqual([false]);
    expect(vi.mocked(getDocFromServer)).toHaveBeenCalledTimes(1);
    expect(hasPendingAnalyticsOptOut(uid)).toBe(false);
    expect(isAnalyticsCollectionAllowed()).toBe(false);
  });

  it('keeps the veto after a rejected write and succeeds on later retry', async () => {
    vi.mocked(setDoc).mockRejectedValueOnce(new Error('offline or permission error'));
    await expect(requestAnalyticsConsentChange(uid, false)).rejects.toThrow();
    expect(getAnalyticsConsentDisplayState(uid)).toBe('pending_off');
    await expect(reconcilePendingAnalyticsOptOut(uid, true)).resolves.toBeUndefined();
    expect(mockedWriteValues()).toEqual([false, false]);
    expect(hasPendingAnalyticsOptOut(uid)).toBe(false);
  });

  it('retains veto when Firestore verification is offline or not OFF', async () => {
    vi.mocked(getDocFromServer).mockRejectedValueOnce(new Error('offline'));
    await expect(requestAnalyticsConsentChange(uid, false)).rejects.toThrow('offline');
    expect(hasPendingAnalyticsOptOut(uid)).toBe(true);

    vi.mocked(getDocFromServer).mockImplementationOnce(async () => ({
      exists: () => true,
      data: () => ({ analyticsConsent: true }),
    } as never));
    await expect(reconcilePendingAnalyticsOptOut(uid, true))
      .rejects.toThrow('not confirmed');
    expect(hasPendingAnalyticsOptOut(uid)).toBe(true);

    await reconcilePendingAnalyticsOptOut(uid, true);
    expect(hasPendingAnalyticsOptOut(uid)).toBe(false);
  });

  it('never permits a new ON write while withdrawal is pending', async () => {
    revokeAnalyticsConsentImmediately();
    await expect(requestAnalyticsConsentChange(uid, true))
      .rejects.toThrow('pending analytics withdrawal');
    expect(setDoc).not.toHaveBeenCalled();
  });

  it('does not reconcile the wrong account or clear its pending marker', async () => {
    revokeAnalyticsConsentImmediately();
    (auth as { currentUser: { uid: string } | null }).currentUser = { uid: 'another-account' };
    beginAnalyticsConsentSession('another-account');

    await reconcilePendingAnalyticsOptOut(uid);
    expect(setDoc).not.toHaveBeenCalled();
    expect(hasPendingAnalyticsOptOut(uid)).toBe(true);

    (auth as { currentUser: { uid: string } | null }).currentUser = { uid };
    beginAnalyticsConsentSession(uid);
    await reconcilePendingAnalyticsOptOut(uid);
    expect(mockedWriteValues()).toEqual([false]);
  });

  it('deduplicates simultaneous OFF reconciliation triggers', async () => {
    let release!: () => void;
    revokeAnalyticsConsentImmediately();
    vi.mocked(setDoc).mockImplementationOnce(() => new Promise<void>(resolve => {
      release = () => { serverValue = false; resolve(); };
    }));

    const a = reconcilePendingAnalyticsOptOut(uid);
    const b = reconcilePendingAnalyticsOptOut(uid);
    expect(mockedWriteValues()).toEqual([false]);
    release();
    await Promise.all([a, b]);
    expect(mockedWriteValues()).toEqual([false]);
  });

  it('retries on the browser online event after an interrupted session', async () => {
    revokeAnalyticsConsentImmediately();
    const events = new EventTarget();
    const page = new EventTarget();
    Object.defineProperty(page, 'visibilityState', { value: 'visible' });
    vi.stubGlobal('window', events);
    vi.stubGlobal('document', page);
    const unsubscribe = observePendingAnalyticsOptOut();
    try {
      events.dispatchEvent(new Event('online'));
      await flush();
      expect(mockedWriteValues()).toEqual([false]);
      expect(hasPendingAnalyticsOptOut(uid)).toBe(false);
    } finally {
      unsubscribe();
    }
  });

  it('keeps the marker after account switch mid-write and retries on return', async () => {
    let release!: () => void;
    vi.mocked(setDoc).mockImplementationOnce(() => new Promise<void>(resolve => {
      release = () => { serverValue = false; resolve(); };
    }));
    const off = requestAnalyticsConsentChange(uid, false);
    (auth as { currentUser: { uid: string } | null }).currentUser = null;
    beginAnalyticsConsentSession(null);
    release();
    await off;
    expect(hasPendingAnalyticsOptOut(uid)).toBe(true);
    (auth as { currentUser: { uid: string } | null }).currentUser = { uid };
    beginAnalyticsConsentSession(uid);
    await reconcilePendingAnalyticsOptOut(uid);
    expect(mockedWriteValues()).toEqual([false, false]);
    expect(hasPendingAnalyticsOptOut(uid)).toBe(false);
  });

  it('does not silently change server consent when storage is unavailable', async () => {
    vi.stubGlobal('localStorage', undefined);
    beginAnalyticsConsentSession(uid);
    receiveAnalyticsConsentSnapshot(uid, { analyticsConsent: true }, confirmed);
    expect(isAnalyticsCollectionAllowed()).toBe(false);
    await reconcilePendingAnalyticsOptOut(uid);
    expect(setDoc).not.toHaveBeenCalled();
  });

  it('requires a current authenticated account for any UI write', async () => {
    (auth as { currentUser: { uid: string } | null }).currentUser = null;
    await expect(requestAnalyticsConsentChange(uid, false)).rejects.toThrow('unavailable');
    expect(setDoc).not.toHaveBeenCalled();
  });
});
