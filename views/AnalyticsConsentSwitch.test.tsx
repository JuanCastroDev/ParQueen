import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../firebase', () => ({
  db: { name: 'db' },
  auth: { currentUser: { uid: 'user-a' } },
}));

vi.mock('firebase/firestore', () => ({
  doc: vi.fn((_db, ...parts: string[]) => ({
    path: parts.join('/'),
  })),
  setDoc: vi.fn(async () => {}),
  getDocFromServer: vi.fn(async () => ({
    exists: () => true,
    data: () => ({ analyticsConsent: false }),
  })),
}));

import { auth } from '../firebase';
import { t } from '../i18n';
import { setDoc } from 'firebase/firestore';
import { AnalyticsConsentSwitch } from './AnalyticsConsentSwitch';
import {
  beginAnalyticsConsentSession,
  isAnalyticsCollectionAllowed,
  getAnalyticsConsentDisplayState,
  receiveAnalyticsConsentSnapshot,
  confirmAnalyticsOptOutReconciled,
} from '../utils/analyticsConsentSession';

const confirmed = {
  fromCache: false,
  hasPendingWrites: false,
};

let renderer: TestRenderer.ReactTestRenderer | null = null;

const storage = vi.hoisted(() => {
  const map = new Map<string, string>();

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => {
        map.set(key, String(value));
      },
      removeItem: (key: string) => {
        map.delete(key);
      },
      clear: () => {
        map.clear();
      },
    },
  });

  return map;
});

function switchNode() {
  return renderer!.root.findByProps({
    'aria-label': t('settings.analytics_title'),
  });
}

function renderSwitch(userId: string | null = 'user-a') {
  act(() => {
    renderer = TestRenderer.create(
      <AnalyticsConsentSwitch
        userId={userId}
        rowClass="pq-settings-row"
      />,
    );
  });
}

beforeEach(() => {
  storage.clear();


  (auth as any).currentUser = { uid: 'user-a' };
  vi.mocked(setDoc).mockReset();
  vi.mocked(setDoc).mockResolvedValue(undefined);

  beginAnalyticsConsentSession(null);
});

afterEach(() => {
  act(() => {
    renderer?.unmount();
    renderer = null;
    for (const uid of ['user-a', 'race-test-account']) {
      beginAnalyticsConsentSession(uid);
      confirmAnalyticsOptOutReconciled(uid);
    }
    beginAnalyticsConsentSession(null);
  });

});

describe('Product Analytics Settings switch', () => {
  it('starts OFF and is disabled before the account session is ready', () => {
    renderSwitch();

    expect(switchNode().props['aria-checked']).toBe(false);
    expect(switchNode().props.disabled).toBe(true);
  });

  it('requires server confirmation before showing ON', async () => {
    beginAnalyticsConsentSession('user-a');
    renderSwitch();

    expect(switchNode().props['aria-checked']).toBe(false);

    act(() => switchNode().props.onClick());

    expect(setDoc).toHaveBeenCalledWith(
      { path: 'users/user-a/private/preferences' },
      { analyticsConsent: true },
      { merge: true },
    );

    // A successful write alone does not grant collection.
    expect(isAnalyticsCollectionAllowed()).toBe(false);

    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      receiveAnalyticsConsentSnapshot(
        'user-a', { analyticsConsent: true }, confirmed,
      );
    });

    expect(switchNode().props['aria-checked']).toBe(true);
  });

  it('revokes immediately and ignores a stale server ON', async () => {
    beginAnalyticsConsentSession('user-a');
    receiveAnalyticsConsentSnapshot(
      'user-a', { analyticsConsent: true }, confirmed,
    );

    let rejectWrite!: (reason: Error) => void;

    vi.mocked(setDoc).mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => {
        rejectWrite = reject;
      }),
    );

    renderSwitch();

    expect(switchNode().props['aria-checked']).toBe(true);

    act(() => switchNode().props.onClick());

    expect(isAnalyticsCollectionAllowed()).toBe(false);
    expect(switchNode().props['aria-checked']).toBe(false);

    act(() => {
      receiveAnalyticsConsentSnapshot(
        'user-a', { analyticsConsent: true }, confirmed,
      );
    });

    expect(isAnalyticsCollectionAllowed()).toBe(false);

    await act(async () => {
      rejectWrite(new Error('offline'));
      await Promise.resolve();
    });

    expect(renderer!.root.findAllByProps({ role: 'alert' }))
      .toHaveLength(1);

    act(() => switchNode().props.onClick());

    expect(setDoc).toHaveBeenLastCalledWith(
      { path: 'users/user-a/private/preferences' },
      { analyticsConsent: false },
      { merge: true },
    );
  });

  it('treats a tap during cached OFF after server-confirmed ON as a durable offline withdrawal', async () => {
    beginAnalyticsConsentSession('user-a');
    receiveAnalyticsConsentSnapshot('user-a', { analyticsConsent: true }, confirmed);
    renderSwitch();
    expect(switchNode().props['aria-checked']).toBe(true);

    // Firestore disconnects: cached ON is not collection consent; UI falls back OFF.
    act(() => {
      receiveAnalyticsConsentSnapshot(
        'user-a', { analyticsConsent: true },
        { fromCache: true, hasPendingWrites: false },
      );
    });
    expect(switchNode().props['aria-checked']).toBe(false);
    expect(isAnalyticsCollectionAllowed()).toBe(false);

    // The user's tap MUST be OFF (not a queued ON opt-in).
    act(() => switchNode().props.onClick());
    expect(storage.get('parqueen_analytics_pending_optout_v1_user-a')).toBe('1');
    expect(setDoc).toHaveBeenCalledWith(
      { path: 'users/user-a/private/preferences' },
      { analyticsConsent: false },
      { merge: true },
    );
    expect(vi.mocked(setDoc).mock.calls.some(call => (call[1] as { analyticsConsent?: boolean })?.analyticsConsent === true)).toBe(false);
    expect(isAnalyticsCollectionAllowed()).toBe(false);

    // Allow the mocked OFF server confirmation to settle; the user can opt
    // back IN after a later authoritative server-confirmed OFF snapshot.
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => receiveAnalyticsConsentSnapshot('user-a', { analyticsConsent: false }, confirmed));
    expect(switchNode().props['aria-checked']).toBe(false);
    act(() => switchNode().props.onClick());
    expect(vi.mocked(setDoc).mock.calls.some(call => (call[1] as { analyticsConsent?: boolean })?.analyticsConsent === true)).toBe(true);
  });

  it('refuses to write for a different signed-in account', () => {
    beginAnalyticsConsentSession('user-a');
    (auth as any).currentUser = { uid: 'user-b' };

    renderSwitch();

    expect(switchNode().props.disabled).toBe(true);

    act(() => switchNode().props.onClick());

    expect(setDoc).not.toHaveBeenCalled();
  });
});
describe('rapid ON to OFF cancellation', () => {
  it('stays OFF when an earlier ON write finishes late', async () => {
    let resolveFirstWrite!: () => void;

    vi.mocked(setDoc).mockImplementationOnce(
      () => new Promise<void>(resolve => {
        resolveFirstWrite = () => resolve();
      }),
    );

    // Use a dedicated account so another test's pending opt-out
    // cannot change the starting conditions.
    (auth as any).currentUser = { uid: 'race-test-account' };
    beginAnalyticsConsentSession('race-test-account');
    renderSwitch('race-test-account');

    expect(getAnalyticsConsentDisplayState('race-test-account'))
      .toBe('off');

    // First tap: request opt-in, but keep its write pending.
    act(() => switchNode().props.onClick());

    expect(setDoc).toHaveBeenNthCalledWith(
      1,
      { path: 'users/race-test-account/private/preferences' },
      { analyticsConsent: true },
      { merge: true },
    );

    expect(isAnalyticsCollectionAllowed()).toBe(false);

    // Second tap: cancel the pending opt-in.
    act(() => switchNode().props.onClick());

    // OFF is submitted immediately, without awaiting the unfinished ON.
    expect(setDoc).toHaveBeenNthCalledWith(
      2,
      { path: 'users/race-test-account/private/preferences' },
      { analyticsConsent: false },
      { merge: true },
    );
    expect(isAnalyticsCollectionAllowed()).toBe(false);

    // An older confirmed ON snapshot must not restore access.
    act(() => {
      receiveAnalyticsConsentSnapshot(
        'race-test-account', { analyticsConsent: true }, confirmed,
      );
    });

    expect(isAnalyticsCollectionAllowed()).toBe(false);
    expect(switchNode().props['aria-checked']).toBe(false);

    // The original ON request completes. OFF is reasserted afterward.
    await act(async () => {
      resolveFirstWrite();
      await Promise.resolve();
    });

    expect(setDoc).toHaveBeenNthCalledWith(
      3,
      { path: 'users/race-test-account/private/preferences' },
      { analyticsConsent: false },
      { merge: true },
    );

    expect(isAnalyticsCollectionAllowed()).toBe(false);
    expect(switchNode().props['aria-checked']).toBe(false);

    // Finally, Firestore confirms OFF.
    act(() => {
      receiveAnalyticsConsentSnapshot(
        'race-test-account', { analyticsConsent: false }, confirmed,
      );
    });

    expect(isAnalyticsCollectionAllowed()).toBe(false);
    expect(switchNode().props['aria-checked']).toBe(false);
  });
});
