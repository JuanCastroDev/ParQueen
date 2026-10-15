import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginAnalyticsConsentSession,
  receiveAnalyticsConsentSnapshot,
  invalidateAnalyticsConsent,
  revokeAnalyticsConsentImmediately,
  isAnalyticsCollectionAllowed,
  subscribeAnalyticsConsent,
  getAnalyticsConsentDisplayState,
  confirmAnalyticsOptOutReconciled,
  hasPendingAnalyticsOptOut,
} from './analyticsConsentSession';

const confirmed = { fromCache: false, hasPendingWrites: false };

const storedValues = new Map<string, string>();

beforeEach(() => {
  storedValues.clear();

  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storedValues.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storedValues.set(key, value);
    },
    removeItem: (key: string) => {
      storedValues.delete(key);
    },
  });

  beginAnalyticsConsentSession(null);
});

afterEach(() => {
  // Pending opt-outs intentionally survive session resets.
  // End each test with a confirmed OFF snapshot so subsequent
  // tests cannot inherit this test's in-memory veto.
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storedValues.get(key) ?? null,
    setItem: (key: string, value: string) => {
      storedValues.set(key, value);
    },
    removeItem: (key: string) => {
      storedValues.delete(key);
    },
  });

  const confirmedOff = {
    fromCache: false,
    hasPendingWrites: false,
  };

  for (const uid of ['user-a', 'user-b']) {
    beginAnalyticsConsentSession(uid);
    receiveAnalyticsConsentSnapshot(
      uid,
      { analyticsConsent: false },
      confirmedOff,
    );
    confirmAnalyticsOptOutReconciled(uid);
  }

  beginAnalyticsConsentSession(null);
  vi.unstubAllGlobals();
});

describe('analytics consent session', () => {
  it('starts disabled until server-confirmed consent arrives', () => {
    beginAnalyticsConsentSession('user-a');
    expect(isAnalyticsCollectionAllowed()).toBe(false);

    receiveAnalyticsConsentSnapshot('user-a', { analyticsConsent: true }, confirmed);
    expect(isAnalyticsCollectionAllowed()).toBe(true);
  });

  it('rejects cached and pending-write consent', () => {
    beginAnalyticsConsentSession('user-a');

    receiveAnalyticsConsentSnapshot(
      'user-a', { analyticsConsent: true },
      { fromCache: true, hasPendingWrites: false },
    );
    expect(isAnalyticsCollectionAllowed()).toBe(false);

    receiveAnalyticsConsentSnapshot(
      'user-a', { analyticsConsent: true },
      { fromCache: false, hasPendingWrites: true },
    );
    expect(isAnalyticsCollectionAllowed()).toBe(false);
  });

  it('resets on account switch and ignores old-account updates', () => {
    beginAnalyticsConsentSession('user-a');
    receiveAnalyticsConsentSnapshot('user-a', { analyticsConsent: true }, confirmed);
    expect(isAnalyticsCollectionAllowed()).toBe(true);

    beginAnalyticsConsentSession('user-b');
    expect(isAnalyticsCollectionAllowed()).toBe(false);

    receiveAnalyticsConsentSnapshot('user-a', { analyticsConsent: true }, confirmed);
    expect(isAnalyticsCollectionAllowed()).toBe(false);
  });

  it('invalidates consent on errors, refusal, or missing preferences', () => {
    beginAnalyticsConsentSession('user-a');
    receiveAnalyticsConsentSnapshot('user-a', { analyticsConsent: true }, confirmed);

    invalidateAnalyticsConsent();
    expect(isAnalyticsCollectionAllowed()).toBe(false);

    receiveAnalyticsConsentSnapshot('user-a', { analyticsConsent: false }, confirmed);
    expect(isAnalyticsCollectionAllowed()).toBe(false);

    receiveAnalyticsConsentSnapshot('user-a', null, confirmed);
    expect(isAnalyticsCollectionAllowed()).toBe(false);
  });

  it('disables collection immediately on logout', () => {
    beginAnalyticsConsentSession('user-a');
    receiveAnalyticsConsentSnapshot('user-a', { analyticsConsent: true }, confirmed);

    beginAnalyticsConsentSession(null);
    expect(isAnalyticsCollectionAllowed()).toBe(false);
  });
});

describe('immediate opt-out protection', () => {
  const confirmed = { fromCache: false, hasPendingWrites: false };

  it('blocks old server consent after immediate revocation', () => {
    beginAnalyticsConsentSession('user-a');
    receiveAnalyticsConsentSnapshot(
      'user-a', { analyticsConsent: true }, confirmed,
    );
    expect(isAnalyticsCollectionAllowed()).toBe(true);

    revokeAnalyticsConsentImmediately();
    expect(isAnalyticsCollectionAllowed()).toBe(false);

    receiveAnalyticsConsentSnapshot(
      'user-a', { analyticsConsent: true }, confirmed,
    );
    expect(isAnalyticsCollectionAllowed()).toBe(false);
  });

  it('preserves a pending opt-out across sessions', () => {
    beginAnalyticsConsentSession('user-a');
    receiveAnalyticsConsentSnapshot(
      'user-a', { analyticsConsent: true }, confirmed,
    );

    revokeAnalyticsConsentImmediately();
    beginAnalyticsConsentSession(null);
    beginAnalyticsConsentSession('user-a');

    receiveAnalyticsConsentSnapshot(
      'user-a', { analyticsConsent: true }, confirmed,
    );
    expect(isAnalyticsCollectionAllowed()).toBe(false);
  });

  it('keeps pending opt-outs account-specific', () => {
    beginAnalyticsConsentSession('user-a');
    revokeAnalyticsConsentImmediately();

    beginAnalyticsConsentSession('user-b');
    receiveAnalyticsConsentSnapshot(
      'user-b', { analyticsConsent: true }, confirmed,
    );
    expect(isAnalyticsCollectionAllowed()).toBe(true);

    beginAnalyticsConsentSession('user-a');
    receiveAnalyticsConsentSnapshot(
      'user-a', { analyticsConsent: true }, confirmed,
    );
    expect(isAnalyticsCollectionAllowed()).toBe(false);
  });

  it('clears the veto only after confirmed OFF', () => {
    beginAnalyticsConsentSession('user-a');
    revokeAnalyticsConsentImmediately();

    receiveAnalyticsConsentSnapshot(
      'user-a', { analyticsConsent: true }, confirmed,
    );
    expect(isAnalyticsCollectionAllowed()).toBe(false);

    receiveAnalyticsConsentSnapshot(
      'user-a', { analyticsConsent: false }, confirmed,
    );
    expect(isAnalyticsCollectionAllowed()).toBe(false);

    // A previous OFF snapshot is NOT enough to clear the local intent.
    expect(getAnalyticsConsentDisplayState('user-a')).toBe('pending_off');
    confirmAnalyticsOptOutReconciled('user-a');
    expect(getAnalyticsConsentDisplayState('user-a')).toBe('off');

    // A later explicit server-confirmed opt-in can be honored.
    receiveAnalyticsConsentSnapshot(
      'user-a', { analyticsConsent: true }, confirmed,
    );
    expect(isAnalyticsCollectionAllowed()).toBe(true);
  });

  it('fails closed when browser storage is unavailable', () => {
    vi.stubGlobal('localStorage', undefined);

    beginAnalyticsConsentSession('user-a');
    receiveAnalyticsConsentSnapshot(
      'user-a', { analyticsConsent: true }, confirmed,
    );
    expect(isAnalyticsCollectionAllowed()).toBe(false);

    revokeAnalyticsConsentImmediately();
    expect(isAnalyticsCollectionAllowed()).toBe(false);
  });
});
describe('analytics consent display subscriptions', () => {
  const confirmed = { fromCache: false, hasPendingWrites: false };

  it('displays OFF until server consent is confirmed', () => {
    beginAnalyticsConsentSession('user-a');
    expect(getAnalyticsConsentDisplayState('user-a')).toBe('off');

    receiveAnalyticsConsentSnapshot(
      'user-a', { analyticsConsent: true }, confirmed,
    );
    expect(getAnalyticsConsentDisplayState('user-a')).toBe('on');
  });

  it('shows pending opt-out until the server confirms OFF', () => {
    beginAnalyticsConsentSession('user-a');
    revokeAnalyticsConsentImmediately();

    expect(getAnalyticsConsentDisplayState('user-a')).toBe('pending_off');

    beginAnalyticsConsentSession(null);
    beginAnalyticsConsentSession('user-a');

    expect(getAnalyticsConsentDisplayState('user-a')).toBe('pending_off');
    expect(getAnalyticsConsentDisplayState('user-b')).toBe('unavailable');

    receiveAnalyticsConsentSnapshot(
      'user-a', { analyticsConsent: false }, confirmed,
    );
    expect(getAnalyticsConsentDisplayState('user-a')).toBe('pending_off');
    confirmAnalyticsOptOutReconciled('user-a');
    expect(getAnalyticsConsentDisplayState('user-a')).toBe('off');
  });

  it('notifies subscribers and stops after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeAnalyticsConsent(listener);

    try {
      beginAnalyticsConsentSession('user-a');
      receiveAnalyticsConsentSnapshot(
        'user-a', { analyticsConsent: true }, confirmed,
      );
      revokeAnalyticsConsentImmediately();

      expect(listener).toHaveBeenCalledTimes(3);

      unsubscribe();
      beginAnalyticsConsentSession(null);

      expect(listener).toHaveBeenCalledTimes(3);
    } finally {
      unsubscribe();
    }
  });
});
describe('analytics consent storage-write safety', () => {
  it('stays OFF when storage reads work but writes fail', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('storage blocked'); },
      removeItem: () => {},
    });

    const confirmed = { fromCache: false, hasPendingWrites: false };

    beginAnalyticsConsentSession('user-a');
    receiveAnalyticsConsentSnapshot(
      'user-a', { analyticsConsent: true }, confirmed,
    );
    // Readable but unwritable storage is no longer sufficient for a safe opt-in.
    expect(isAnalyticsCollectionAllowed()).toBe(false);

    revokeAnalyticsConsentImmediately();

    // An old confirmed snapshot must not restore collection.
    receiveAnalyticsConsentSnapshot(
      'user-a', { analyticsConsent: true }, confirmed,
    );

    expect(isAnalyticsCollectionAllowed()).toBe(false);
    expect(getAnalyticsConsentDisplayState('user-a')).toBe('pending_off');

    // Snapshot alone cannot discharge a withdrawal; the coordinator must
    // also confirm an acknowledged OFF write and a fresh server read.
    receiveAnalyticsConsentSnapshot(
      'user-a', { analyticsConsent: false }, confirmed,
    );
    expect(getAnalyticsConsentDisplayState('user-a')).toBe('pending_off');
    confirmAnalyticsOptOutReconciled('user-a');
    expect(isAnalyticsCollectionAllowed()).toBe(false);
    expect(getAnalyticsConsentDisplayState('user-a')).toBe('off');
  });
});

describe('durable opt-out acknowledgments', () => {
  it('keeps local withdrawal pending despite an older server OFF snapshot', () => {
    beginAnalyticsConsentSession('user-a');
    revokeAnalyticsConsentImmediately();
    receiveAnalyticsConsentSnapshot('user-a', { analyticsConsent: false }, confirmed);
    expect(hasPendingAnalyticsOptOut('user-a')).toBe(true);
    receiveAnalyticsConsentSnapshot('user-a', { analyticsConsent: true }, confirmed);
    expect(isAnalyticsCollectionAllowed()).toBe(false);
    confirmAnalyticsOptOutReconciled('user-a');
    expect(hasPendingAnalyticsOptOut('user-a')).toBe(false);
    expect(isAnalyticsCollectionAllowed()).toBe(false);
  });

  it('does not grant consent when storage reads succeed but writes fail', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => { throw new Error('unwritable'); },
      removeItem: () => {},
    });
    beginAnalyticsConsentSession('user-a');
    receiveAnalyticsConsentSnapshot('user-a', { analyticsConsent: true }, confirmed);
    expect(isAnalyticsCollectionAllowed()).toBe(false);
  });
});
