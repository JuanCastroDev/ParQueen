import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  const store = new Map<string, string>();
  const localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: vi.fn(() => { store.clear(); }),
    key: () => null,
    get length() { return store.size; },
  };
  const listeners: Array<(user: unknown) => Promise<void> | void> = [];
  const unsubscribers: Array<ReturnType<typeof vi.fn>> = [];
  const onAuthStateChanged = vi.fn((_auth: unknown, callback: (user: unknown) => void) => {
    listeners.push(callback);
    const unsubscribe = vi.fn();
    unsubscribers.push(unsubscribe);
    return unsubscribe;
  });
  const signOut = vi.fn();
  const getDoc = vi.fn();
  const snapshotCallbacks = new Map<string, (snapshot: any) => void>();
  const onSnapshot = vi.fn((ref: { __path?: string }, ...args: any[]) => {
    const callback = typeof args[0] === 'function' ? args[0] : args[1];
    snapshotCallbacks.set(ref.__path ?? '', callback);
    return vi.fn();
  });
  const notificationInspect = vi.fn(async () => ({ capability: 'supported' as const, permission: 'granted' as const, registration: 'not_registered' as const }));
  const notificationRefreshGranted = vi.fn(async () => ({ capability: 'supported' as const, permission: 'granted' as const, registration: 'registered' as const }));
  const foregroundUnsubscribers: Array<ReturnType<typeof vi.fn>> = [];
  const notificationSubscribeForeground = vi.fn(async () => {
    const unsubscribe = vi.fn();
    foregroundUnsubscribers.push(unsubscribe);
    return unsubscribe;
  });
  const notificationEnable = vi.fn(async () => ({ capability: 'supported' as const, permission: 'granted' as const, registration: 'registered' as const }));
  const renderedUsers: any[] = [];
  const renderedMapProps: any[] = [];
  const receiveAnalyticsConsentSnapshot = vi.fn();
  const reconcilePendingAnalyticsOptOut = vi.fn(async () => {});
  const captureClientException = vi.fn();
  const reload = vi.fn();
  const documentListeners = new Map<string, Set<() => void>>();
  const documentMock = {
    documentElement: {
      lang: 'en',
      classList: { add() {}, remove() {} },
    },
    addEventListener: (event: string, listener: () => void) => {
      const listenersForEvent = documentListeners.get(event) ?? new Set();
      listenersForEvent.add(listener);
      documentListeners.set(event, listenersForEvent);
    },
    removeEventListener: (event: string, listener: () => void) => {
      documentListeners.get(event)?.delete(listener);
    },
    visibilityState: 'visible',
  };
  (globalThis as any).localStorage = localStorage;
  (globalThis as any).window = {
    location: { hostname: 'localhost', search: '', hash: '', href: 'http://localhost/', reload },
    history: { replaceState() {}, pushState() {} },
    document: documentMock,
    matchMedia: () => ({ matches: true, addEventListener() {}, removeEventListener() {} }),
    addEventListener() {},
    removeEventListener() {},
  };
  (globalThis as any).document = documentMock;
  return {
    store,
    localStorage,
    listeners,
    unsubscribers,
    onAuthStateChanged,
    signOut,
    getDoc,
    snapshotCallbacks,
    onSnapshot,
    notificationInspect,
    notificationRefreshGranted,
    notificationSubscribeForeground,
    notificationEnable,
    foregroundUnsubscribers,
    renderedUsers,
    renderedMapProps,
    receiveAnalyticsConsentSnapshot,
    reconcilePendingAnalyticsOptOut,
    captureClientException,
    reload,
    documentListeners,
  };
});

vi.mock('./firebaseConfig', () => ({
  auth: { name: 'auth' },
  db: { name: 'db' },
}));
vi.mock('./firebase', () => ({
  auth: { name: 'auth' },
  db: { name: 'db' },
}));
vi.mock('firebase/auth', () => ({
  onAuthStateChanged: harness.onAuthStateChanged,
  signOut: harness.signOut,
  sendPasswordResetEmail: vi.fn(),
  RecaptchaVerifier: class {},
}));
vi.mock('firebase/firestore', () => ({
  doc: vi.fn((_db: unknown, ...path: string[]) => ({ __path: path.join('/') })),
  getDoc: harness.getDoc,
  onSnapshot: harness.onSnapshot,
  updateDoc: vi.fn(),
  deleteField: vi.fn(),
  collection: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
}));
vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(),
  httpsCallable: vi.fn(),
}));
vi.mock('firebase/app', () => ({ getApp: vi.fn() }));
vi.mock('./utils/errorReporting', () => ({
  captureClientException: harness.captureClientException,
}));
vi.mock('./utils/analyticsConsentSession', () => ({
  beginAnalyticsConsentSession: vi.fn(),
  receiveAnalyticsConsentSnapshot: harness.receiveAnalyticsConsentSnapshot,
  invalidateAnalyticsConsent: vi.fn(),
}));
vi.mock('./utils/analyticsConsentReconciliation', () => ({
  observePendingAnalyticsOptOut: vi.fn(() => () => {}),
  reconcilePendingAnalyticsOptOut: harness.reconcilePendingAnalyticsOptOut,
}));
vi.mock('./utils/geolocation', () => ({
  checkLocationPermission: vi.fn(async () => ({ status: 'granted', locationServicesEnabled: true })),
  requestLocationPermission: vi.fn(),
}));
vi.mock('./views/StreetParkingView', () => ({
  MapView: (props: { user: unknown }) => {
    harness.renderedUsers.push(props.user);
    harness.renderedMapProps.push(props);
    return null;
  },
}));
vi.mock('./views/street-parking/useUnreadMessages', () => ({
  useUnreadMessages: vi.fn(() => 0),
}));
vi.mock('./utils/notificationRegistration', () => ({
  notificationRegistration: {
    inspect: harness.notificationInspect,
    refreshGranted: harness.notificationRefreshGranted,
    subscribeForeground: harness.notificationSubscribeForeground,
    subscribeOpen: vi.fn(async () => () => {}),
    enable: harness.notificationEnable,
  },
}));

import App from './App';
import { AUTH_INITIAL_STATE_TIMEOUT_MS } from './utils/authBootstrap';
import { AppView } from './types';

const treeText = (renderer: TestRenderer.ReactTestRenderer) => JSON.stringify(renderer.toJSON());
const hasLoading = (renderer: TestRenderer.ReactTestRenderer) => (
  renderer.root.findAll((node) => node.props?.['aria-label'] === 'Loading ParQueen').length > 0
);
const hasStartupError = (renderer: TestRenderer.ReactTestRenderer) => (
  renderer.root.findAll((node) => node.props?.role === 'alert').length > 0
);
const latestRenderedUser = () => harness.renderedUsers[harness.renderedUsers.length - 1];
const emitVisible = async () => {
  await act(async () => {
    for (const listener of harness.documentListeners.get('visibilitychange') ?? []) listener();
  });
};

const emitSnapshot = async (
  path: string,
  data: Record<string, unknown>,
  metadata = { fromCache: false, hasPendingWrites: false },
) => {
  const callback = harness.snapshotCallbacks.get(path);
  expect(callback, `snapshot listener for ${path}`).toBeTypeOf('function');
  await act(async () => {
    callback!({
      id: path.split('/')[1],
      exists: () => true,
      data: () => data,
      metadata,
    });
  });
};
const emitMissingSnapshot = async (
  path: string,
  metadata = { fromCache: false, hasPendingWrites: false },
) => {
  const callback = harness.snapshotCallbacks.get(path);
  expect(callback, `snapshot listener for ${path}`).toBeTypeOf('function');
  await act(async () => {
    callback!({
      id: path.split('/')[1],
      exists: () => false,
      data: () => ({}),
      metadata,
    });
  });
};

describe('auth startup watchdog', () => {
  beforeEach(() => {
    harness.store.clear();
    harness.listeners.length = 0;
    harness.unsubscribers.length = 0;
    harness.onAuthStateChanged.mockClear();
    harness.signOut.mockClear();
    harness.getDoc.mockReset();
    harness.snapshotCallbacks.clear();
    harness.onSnapshot.mockClear();
    harness.foregroundUnsubscribers.length = 0;
    harness.notificationInspect.mockReset().mockResolvedValue({ capability: 'supported', permission: 'granted', registration: 'not_registered' });
    harness.notificationRefreshGranted.mockReset().mockResolvedValue({ capability: 'supported', permission: 'granted', registration: 'registered' });
    harness.notificationSubscribeForeground.mockReset().mockImplementation(async () => {
      const unsubscribe = vi.fn();
      harness.foregroundUnsubscribers.push(unsubscribe);
      return unsubscribe;
    });
    harness.notificationEnable.mockReset().mockResolvedValue({ capability: 'supported', permission: 'granted', registration: 'registered' });
    harness.renderedUsers.length = 0;
    harness.renderedMapProps.length = 0;
    harness.receiveAnalyticsConsentSnapshot.mockClear();
    harness.reconcilePendingAnalyticsOptOut.mockClear();
    harness.captureClientException.mockClear();
    harness.localStorage.clear.mockClear();
    harness.reload.mockClear();
    harness.documentListeners.clear();
    (window.location as any).hostname = 'localhost';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows a recoverable startup error when the first auth callback never arrives', async () => {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<App />);
    });
    expect(hasLoading(renderer!)).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTH_INITIAL_STATE_TIMEOUT_MS);
    });

    expect(hasLoading(renderer!)).toBe(false);
    expect(hasStartupError(renderer!)).toBe(true);
    expect(treeText(renderer!)).toContain('ParQueen couldn’t finish starting.');
    expect(treeText(renderer!)).toContain('Check your connection and try again.');
    expect(treeText(renderer!)).toContain('Try Again');
    expect(treeText(renderer!)).not.toContain('Get Started');
    expect(harness.signOut).not.toHaveBeenCalled();
    expect(harness.localStorage.clear).not.toHaveBeenCalled();
    expect(harness.getDoc).not.toHaveBeenCalled();
    expect(harness.onSnapshot).not.toHaveBeenCalled();
    expect(harness.captureClientException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'auth_initial_state_timeout' }),
      expect.objectContaining({
        component: 'App',
        route: 'auth_initial_state_timeout',
        timeoutMs: AUTH_INITIAL_STATE_TIMEOUT_MS,
      }),
    );
    const reported = JSON.stringify(harness.captureClientException.mock.calls[0]);
    expect(reported).not.toMatch(/phone|email|uid|token|apiKey|AIza/i);

    const retry = renderer!.root.findByProps({ children: 'Try Again' });
    await act(async () => {
      retry.props.onClick();
    });
    expect(harness.reload).toHaveBeenCalledTimes(1);
  });

  it('cancels the watchdog and shows onboarding when auth settles logged out', async () => {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<App />);
    });

    await act(async () => {
      await harness.listeners[0](null);
    });

    expect(hasStartupError(renderer!)).toBe(false);
    expect(hasLoading(renderer!)).toBe(false);
    expect(treeText(renderer!)).toContain('Get Started');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTH_INITIAL_STATE_TIMEOUT_MS);
    });

    expect(hasStartupError(renderer!)).toBe(false);
    expect(harness.captureClientException).not.toHaveBeenCalled();
    expect(treeText(renderer!)).toContain('Get Started');
  });

  it('lets a late auth callback replace the startup error with normal logged-out routing', async () => {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<App />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTH_INITIAL_STATE_TIMEOUT_MS);
    });
    expect(hasStartupError(renderer!)).toBe(true);

    await act(async () => {
      await harness.listeners[0](null);
    });

    expect(hasStartupError(renderer!)).toBe(false);
    expect(hasLoading(renderer!)).toBe(false);
    expect(treeText(renderer!)).toContain('Get Started');
    expect(harness.signOut).not.toHaveBeenCalled();
  });

  it('cancels the timer and unsubscribes on unmount', async () => {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<App />);
    });
    expect(harness.onAuthStateChanged).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer.unmount();
    });

    expect(harness.unsubscribers[0]).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(AUTH_INITIAL_STATE_TIMEOUT_MS);
      await harness.listeners[0](null);
    });
    expect(harness.captureClientException).not.toHaveBeenCalled();
    expect(harness.signOut).not.toHaveBeenCalled();
    expect(harness.localStorage.clear).not.toHaveBeenCalled();
    expect(harness.getDoc).not.toHaveBeenCalled();
  });

  it('keeps notification lifecycle unresolved when account snapshots are unavailable', async () => {
    harness.getDoc.mockRejectedValue({ code: 'unavailable' });
    const authUser = (uid: string) => ({
      uid,
      getIdTokenResult: vi.fn(async () => ({ claims: {} })),
    });
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<App />);
    });

    await act(async () => {
      await harness.listeners[0](authUser('user-a'));
    });
    expect(harness.notificationRefreshGranted).not.toHaveBeenCalled();
    expect(harness.notificationSubscribeForeground).not.toHaveBeenCalled();

    await act(async () => {
      await harness.listeners[0](authUser('user-b'));
    });
    expect(harness.notificationRefreshGranted).not.toHaveBeenCalled();
    expect(harness.notificationSubscribeForeground).not.toHaveBeenCalled();

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('does not seed the consumer notification lifecycle for an authenticated admin-domain user', async () => {
    (window.location as any).hostname = 'admin.parqueen.app';
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<App />);
    });

    await act(async () => {
      await harness.listeners[0]({
        uid: 'admin-user',
        getIdTokenResult: vi.fn(async () => ({ claims: { role: 'admin' } })),
      });
    });

    expect(harness.notificationRefreshGranted).not.toHaveBeenCalled();
    expect(harness.notificationSubscribeForeground).not.toHaveBeenCalled();
    expect(harness.onSnapshot).not.toHaveBeenCalled();

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('waits for trusted explicit consent and keeps exactly one enabled foreground listener', async () => {
    harness.localStorage.setItem('locationAccessChoice', 'granted');
    harness.getDoc.mockResolvedValue({ exists: () => true });
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<App />);
    });
    await act(async () => {
      await harness.listeners[0]({
        uid: 'user-a',
        getIdTokenResult: vi.fn(async () => ({ claims: {} })),
      });
    });

    await emitSnapshot('users/user-a', { displayName: 'Alex' });
    await emitSnapshot('users/user-a', { displayName: 'Alex Updated' });
    expect(harness.notificationRefreshGranted).not.toHaveBeenCalled();
    expect(harness.notificationSubscribeForeground).not.toHaveBeenCalled();

    await emitSnapshot(
      'users/user-a/private/preferences',
      { notificationsEnabled: true },
      { fromCache: true, hasPendingWrites: false },
    );
    await emitSnapshot(
      'users/user-a/private/preferences',
      { notificationsEnabled: true },
      { fromCache: true, hasPendingWrites: true },
    );
    expect(latestRenderedUser().notificationPreferenceStatus).toBeUndefined();
    expect(harness.notificationRefreshGranted).not.toHaveBeenCalled();
    expect(harness.notificationSubscribeForeground).not.toHaveBeenCalled();

    await emitSnapshot(
      'users/user-a/private/preferences',
      { notificationsEnabled: true },
      { fromCache: false, hasPendingWrites: false },
    );
    expect(latestRenderedUser().notificationPreferenceStatus).toBe('enabled');
    expect(harness.notificationRefreshGranted).toHaveBeenCalledTimes(1);
    expect(harness.notificationRefreshGranted).toHaveBeenLastCalledWith('user-a', true);
    expect(harness.notificationSubscribeForeground).toHaveBeenCalledTimes(1);

    await emitSnapshot(
      'users/user-a/private/preferences',
      { notificationsEnabled: true },
      { fromCache: false, hasPendingWrites: false },
    );
    expect(harness.notificationRefreshGranted).toHaveBeenCalledTimes(1);
    expect(harness.notificationSubscribeForeground).toHaveBeenCalledTimes(1);

    await emitSnapshot(
      'users/user-a/private/preferences',
      { notificationsEnabled: false },
      { fromCache: false, hasPendingWrites: false },
    );
    expect(latestRenderedUser().notificationPreferenceStatus).toBe('disabled');
    expect(harness.foregroundUnsubscribers[0]).toHaveBeenCalledTimes(1);
    expect(harness.notificationRefreshGranted).toHaveBeenLastCalledWith('user-a', false);
    expect(harness.notificationSubscribeForeground).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('returns enabled notification consent to unresolved when preferences disappear', async () => {
    harness.localStorage.setItem('locationAccessChoice', 'granted');
    harness.getDoc.mockResolvedValue({ exists: () => true });
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<App />);
    });
    await act(async () => {
      await harness.listeners[0]({
        uid: 'user-a',
        getIdTokenResult: vi.fn(async () => ({ claims: {} })),
      });
    });
    await emitSnapshot(
      'users/user-a/private/preferences',
      { notificationsEnabled: true },
      { fromCache: false, hasPendingWrites: false },
    );
    expect(harness.notificationSubscribeForeground).toHaveBeenCalledTimes(1);

    harness.notificationInspect.mockClear();
    harness.notificationRefreshGranted.mockClear();
    await emitMissingSnapshot('users/user-a/private/preferences');

    expect(latestRenderedUser().notificationPreferenceStatus).toBeUndefined();
    expect(harness.foregroundUnsubscribers[0]).toHaveBeenCalledTimes(1);
    expect(harness.notificationInspect).toHaveBeenCalledTimes(1);
    expect(harness.notificationRefreshGranted).not.toHaveBeenCalled();
    expect(harness.notificationSubscribeForeground).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('blocks a superseded enabled account from installing a late foreground listener', async () => {
    harness.localStorage.setItem('locationAccessChoice', 'granted');
    harness.getDoc.mockResolvedValue({ exists: () => true });
    let resolveAccountA!: (value: {
      capability: 'supported';
      permission: 'granted';
      registration: 'registered';
    }) => void;
    harness.notificationRefreshGranted.mockImplementationOnce(() => new Promise(resolve => {
      resolveAccountA = resolve;
    }));
    const authUser = (uid: string) => ({
      uid,
      getIdTokenResult: vi.fn(async () => ({ claims: {} })),
    });
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<App />);
    });
    await act(async () => {
      await harness.listeners[0](authUser('user-a'));
    });
    await emitSnapshot(
      'users/user-a/private/preferences',
      { notificationsEnabled: true },
      { fromCache: false, hasPendingWrites: false },
    );
    expect(harness.notificationRefreshGranted).toHaveBeenCalledWith('user-a', true);

    await act(async () => {
      await harness.listeners[0](authUser('user-b'));
    });
    expect(latestRenderedUser()).toEqual({ id: 'user-b' });
    await act(async () => {
      resolveAccountA({ capability: 'supported', permission: 'granted', registration: 'registered' });
      await Promise.resolve();
    });
    expect(harness.notificationSubscribeForeground).not.toHaveBeenCalled();

    await emitSnapshot(
      'users/user-b/private/preferences',
      { notificationsEnabled: false },
      { fromCache: false, hasPendingWrites: false },
    );
    expect(harness.notificationRefreshGranted).toHaveBeenLastCalledWith('user-b', false);
    expect(harness.notificationSubscribeForeground).not.toHaveBeenCalled();

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('gates resume refresh by resolved preference state', async () => {
    harness.localStorage.setItem('locationAccessChoice', 'granted');
    harness.getDoc.mockResolvedValue({ exists: () => true });
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<App />);
    });
    await act(async () => {
      await harness.listeners[0]({
        uid: 'user-a',
        getIdTokenResult: vi.fn(async () => ({ claims: {} })),
      });
    });

    harness.notificationInspect.mockClear();
    harness.notificationRefreshGranted.mockClear();
    await emitVisible();
    expect(harness.notificationInspect).not.toHaveBeenCalled();
    expect(harness.notificationRefreshGranted).not.toHaveBeenCalled();

    await emitSnapshot(
      'users/user-a/private/preferences',
      { notificationsEnabled: false },
      { fromCache: false, hasPendingWrites: false },
    );
    harness.notificationInspect.mockClear();
    harness.notificationRefreshGranted.mockClear();
    await emitVisible();
    expect(harness.notificationInspect).toHaveBeenCalledTimes(1);
    expect(harness.notificationRefreshGranted).toHaveBeenCalledWith('user-a', false);
    expect(harness.notificationSubscribeForeground).not.toHaveBeenCalled();

    await emitSnapshot(
      'users/user-a/private/preferences',
      { notificationsEnabled: true },
      { fromCache: false, hasPendingWrites: false },
    );
    harness.notificationInspect.mockClear();
    harness.notificationRefreshGranted.mockClear();
    harness.notificationSubscribeForeground.mockClear();
    await emitVisible();
    expect(harness.notificationInspect).toHaveBeenCalledTimes(1);
    expect(harness.notificationRefreshGranted).toHaveBeenCalledWith('user-a', true);
    expect(harness.notificationSubscribeForeground).not.toHaveBeenCalled();

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('drops a resume inspection after the authenticated account changes', async () => {
    harness.localStorage.setItem('locationAccessChoice', 'granted');
    harness.getDoc.mockResolvedValue({ exists: () => true });
    const authUser = (uid: string) => ({
      uid,
      getIdTokenResult: vi.fn(async () => ({ claims: {} })),
    });
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<App />);
    });
    await act(async () => {
      await harness.listeners[0](authUser('user-a'));
    });
    await emitSnapshot(
      'users/user-a/private/preferences',
      { notificationsEnabled: true },
      { fromCache: false, hasPendingWrites: false },
    );

    let resolveInspection!: (value: {
      capability: 'supported';
      permission: 'granted';
      registration: 'not_registered';
    }) => void;
    harness.notificationInspect.mockImplementationOnce(() => new Promise(resolve => {
      resolveInspection = resolve;
    }));
    harness.notificationRefreshGranted.mockClear();
    await emitVisible();
    await act(async () => {
      await harness.listeners[0](authUser('user-b'));
    });
    await act(async () => {
      resolveInspection({ capability: 'supported', permission: 'granted', registration: 'not_registered' });
      await Promise.resolve();
    });

    expect(latestRenderedUser()).toEqual({ id: 'user-b' });
    expect(harness.notificationRefreshGranted).not.toHaveBeenCalledWith('user-a', true);

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('keeps explicit Enable gesture-bound while automatic consent is unresolved', async () => {
    harness.localStorage.setItem('locationAccessChoice', 'granted');
    harness.getDoc.mockResolvedValue({ exists: () => true });
    await import('./views/NotificationsSettingsView');
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<App />);
    });
    await act(async () => {
      await harness.listeners[0]({
        uid: 'user-a',
        getIdTokenResult: vi.fn(async () => ({ claims: {} })),
      });
    });
    expect(harness.notificationRefreshGranted).not.toHaveBeenCalled();
    expect(harness.notificationSubscribeForeground).not.toHaveBeenCalled();

    await act(async () => {
      harness.renderedMapProps[harness.renderedMapProps.length - 1].setView(AppView.NOTIFICATIONS_SETTINGS);
      await Promise.resolve();
    });
    const enableButton = renderer!.root.findByProps({ 'data-notification-action': 'enable' });
    await act(async () => {
      enableButton.props.onClick();
    });
    expect(harness.notificationEnable).toHaveBeenCalledWith('user-a');
    expect(harness.notificationRefreshGranted).not.toHaveBeenCalled();

    await emitSnapshot(
      'users/user-a/private/preferences',
      { notificationsEnabled: true },
      { fromCache: false, hasPendingWrites: false },
    );
    expect(harness.notificationRefreshGranted).toHaveBeenCalledWith('user-a', true);
    expect(harness.notificationSubscribeForeground).toHaveBeenCalledTimes(1);

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('rechecks unresolved preferences without attempting registration', async () => {
    harness.localStorage.setItem('locationAccessChoice', 'granted');
    harness.getDoc.mockResolvedValue({ exists: () => true });
    harness.notificationInspect.mockResolvedValue({ capability: 'supported', permission: 'denied', registration: 'not_registered' } as any);
    await import('./views/NotificationsSettingsView');
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<App />);
    });
    await act(async () => {
      await harness.listeners[0]({
        uid: 'user-a',
        getIdTokenResult: vi.fn(async () => ({ claims: {} })),
      });
    });
    await act(async () => {
      harness.renderedMapProps[harness.renderedMapProps.length - 1].setView(AppView.NOTIFICATIONS_SETTINGS);
      await Promise.resolve();
    });

    harness.notificationInspect.mockClear();
    const recheckButton = renderer!.root.findByProps({ 'data-notification-action': 'recheck' });
    await act(async () => {
      recheckButton.props.onClick();
    });

    expect(harness.notificationInspect).toHaveBeenCalledTimes(1);
    expect(harness.notificationRefreshGranted).not.toHaveBeenCalled();
    expect(harness.notificationSubscribeForeground).not.toHaveBeenCalled();

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('rechecks an opt-out without registering or installing a listener', async () => {
    harness.localStorage.setItem('locationAccessChoice', 'granted');
    harness.getDoc.mockResolvedValue({ exists: () => true });
    harness.notificationRefreshGranted.mockResolvedValueOnce({ capability: 'supported', permission: 'denied', registration: 'not_registered' } as any);
    await import('./views/NotificationsSettingsView');
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<App />);
    });
    await act(async () => {
      await harness.listeners[0]({
        uid: 'user-a',
        getIdTokenResult: vi.fn(async () => ({ claims: {} })),
      });
    });
    await emitSnapshot(
      'users/user-a/private/preferences',
      { notificationsEnabled: false },
      { fromCache: false, hasPendingWrites: false },
    );
    await act(async () => {
      harness.renderedMapProps[harness.renderedMapProps.length - 1].setView(AppView.NOTIFICATIONS_SETTINGS);
      await Promise.resolve();
    });

    harness.notificationInspect.mockClear();
    harness.notificationRefreshGranted.mockClear();
    const recheckButton = renderer!.root.findByProps({ 'data-notification-action': 'recheck' });
    await act(async () => {
      recheckButton.props.onClick();
    });

    expect(harness.notificationInspect).toHaveBeenCalledTimes(1);
    expect(harness.notificationRefreshGranted).toHaveBeenCalledWith('user-a', false);
    expect(harness.notificationSubscribeForeground).not.toHaveBeenCalled();

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('preserves private opt-outs and radius authority through real App snapshot ordering', async () => {
    harness.localStorage.setItem('locationAccessChoice', 'granted');
    harness.getDoc.mockResolvedValue({ exists: () => true });
    const authUser = {
      uid: 'user-a',
      getIdTokenResult: vi.fn(async () => ({ claims: {} })),
    };
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<App />);
    });
    await act(async () => {
      await harness.listeners[0](authUser);
    });

    await emitSnapshot('users/user-a', {
      displayName: 'Alex',
      notificationRadius: 5,
      notificationsEnabled: true,
      sharePreciseLocation: true,
    });
    expect(latestRenderedUser()).toMatchObject({ id: 'user-a', displayName: 'Alex' });
    expect(latestRenderedUser().notificationRadius).toBeUndefined();
    expect(latestRenderedUser().notificationsEnabled).toBeUndefined();
    expect(latestRenderedUser().sharePreciseLocation).toBeUndefined();

    await emitSnapshot(
      'users/user-a/private/preferences',
      { notificationRadius: 2, notificationsEnabled: false, sharePreciseLocation: false },
      { fromCache: true, hasPendingWrites: false },
    );
    expect(latestRenderedUser()).toMatchObject({
      id: 'user-a',
      notificationRadius: 2,
      notificationsEnabled: false,
      sharePreciseLocation: false,
    });
    expect(harness.notificationRefreshGranted).toHaveBeenLastCalledWith('user-a', false);
    expect(harness.notificationSubscribeForeground).not.toHaveBeenCalled();
    const lifecycleCallsAfterOptOut = harness.notificationRefreshGranted.mock.calls.length;

    await emitSnapshot('users/user-a', {
      displayName: 'Alex Updated',
      notificationRadius: 5,
      notificationsEnabled: true,
      sharePreciseLocation: true,
    });
    await act(async () => {
      harness.snapshotCallbacks.get('users/user-a')!({
        id: 'user-a',
        exists: () => false,
        data: () => ({}),
        metadata: { fromCache: false, hasPendingWrites: false },
      });
    });
    expect(latestRenderedUser()).toMatchObject({
      id: 'user-a',
      notificationRadius: 2,
      notificationsEnabled: false,
      sharePreciseLocation: false,
    });
    await emitSnapshot('users/user-a', { displayName: 'Alex Final' });
    expect(latestRenderedUser()).toMatchObject({
      id: 'user-a',
      displayName: 'Alex Final',
      notificationRadius: 2,
      notificationsEnabled: false,
      sharePreciseLocation: false,
    });
    expect(harness.notificationRefreshGranted).toHaveBeenCalledTimes(lifecycleCallsAfterOptOut);

    await emitSnapshot(
      'users/user-a/private/preferences',
      { notificationRadius: 5, notificationsEnabled: false, sharePreciseLocation: false },
      { fromCache: true, hasPendingWrites: true },
    );
    expect(latestRenderedUser().notificationRadius).toBe(2);

    await emitSnapshot(
      'users/user-a/private/preferences',
      { notificationRadius: 2, notificationsEnabled: false, sharePreciseLocation: false },
      { fromCache: false, hasPendingWrites: false },
    );
    expect(latestRenderedUser().notificationRadius).toBe(2);
    expect(harness.renderedUsers.some(user => user?.notificationRadius === 5)).toBe(false);

    await emitSnapshot(
      'users/user-a/private/preferences',
      { notificationRadius: 5, notificationsEnabled: false, sharePreciseLocation: false },
      { fromCache: true, hasPendingWrites: true },
    );
    expect(latestRenderedUser().notificationRadius).toBe(2);
    await emitSnapshot(
      'users/user-a/private/preferences',
      { notificationRadius: 5, notificationsEnabled: false, sharePreciseLocation: false },
      { fromCache: false, hasPendingWrites: false },
    );
    expect(latestRenderedUser().notificationRadius).toBe(5);
    expect(harness.receiveAnalyticsConsentSnapshot).toHaveBeenCalledTimes(5);
    expect(harness.reconcilePendingAnalyticsOptOut).toHaveBeenCalled();

    await act(async () => {
      renderer!.unmount();
    });
  });

  it('isolates private preferences across accounts, stale callbacks, and logout', async () => {
    harness.localStorage.setItem('locationAccessChoice', 'granted');
    harness.getDoc.mockResolvedValue({ exists: () => true });
    const authUser = (uid: string) => ({
      uid,
      getIdTokenResult: vi.fn(async () => ({ claims: {} })),
    });
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<App />);
    });
    await act(async () => {
      await harness.listeners[0](authUser('user-a'));
    });
    await emitSnapshot('users/user-a', { displayName: 'Alex' });
    await emitSnapshot(
      'users/user-a/private/preferences',
      { notificationRadius: 2, notificationsEnabled: false, sharePreciseLocation: false },
      { fromCache: false, hasPendingWrites: false },
    );
    const staleProfileA = harness.snapshotCallbacks.get('users/user-a')!;
    const stalePreferencesA = harness.snapshotCallbacks.get('users/user-a/private/preferences')!;

    await act(async () => {
      await harness.listeners[0](authUser('user-b'));
    });
    expect(latestRenderedUser()).toEqual({ id: 'user-b' });

    await emitSnapshot(
      'users/user-b/private/preferences',
      { notificationRadius: 3, notificationsEnabled: true, sharePreciseLocation: true },
      { fromCache: true, hasPendingWrites: false },
    );
    expect(latestRenderedUser()).toMatchObject({
      id: 'user-b',
      notificationRadius: 3,
      notificationsEnabled: true,
      sharePreciseLocation: true,
    });
    await emitSnapshot('users/user-b', {
      displayName: 'Blair',
      notificationRadius: 1,
      notificationsEnabled: false,
      sharePreciseLocation: false,
    });
    expect(latestRenderedUser()).toMatchObject({
      id: 'user-b',
      displayName: 'Blair',
      notificationRadius: 3,
      notificationsEnabled: true,
      sharePreciseLocation: true,
    });

    await act(async () => {
      staleProfileA({
        id: 'user-a',
        exists: () => true,
        data: () => ({ displayName: 'Stale Alex' }),
        metadata: { fromCache: false, hasPendingWrites: false },
      });
      stalePreferencesA({
        id: 'preferences',
        exists: () => true,
        data: () => ({ notificationRadius: 5, notificationsEnabled: false, sharePreciseLocation: false }),
        metadata: { fromCache: false, hasPendingWrites: false },
      });
    });
    expect(latestRenderedUser()).toMatchObject({
      id: 'user-b',
      displayName: 'Blair',
      notificationRadius: 3,
      notificationsEnabled: true,
      sharePreciseLocation: true,
    });

    await act(async () => {
      await harness.listeners[0](null);
    });
    expect(harness.notificationSubscribeForeground).not.toHaveBeenCalled();

    await act(async () => {
      await harness.listeners[0](authUser('user-c'));
    });
    expect(latestRenderedUser()).toEqual({ id: 'user-c' });

    await act(async () => {
      renderer!.unmount();
    });
  });
});
