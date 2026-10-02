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
  const onSnapshot = vi.fn(() => () => {});
  const captureClientException = vi.fn();
  const reload = vi.fn();
  const documentMock = {
    documentElement: {
      lang: 'en',
      classList: { add() {}, remove() {} },
    },
    addEventListener() {},
    removeEventListener() {},
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
    onSnapshot,
    captureClientException,
    reload,
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
  doc: vi.fn(),
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
vi.mock('./utils/notificationRegistration', () => ({
  notificationRegistration: {
    inspect: vi.fn(async () => ({ capability: 'unsupported', permission: 'unavailable', registration: 'not_registered' })),
    refreshGranted: vi.fn(async () => ({ capability: 'unsupported', permission: 'unavailable', registration: 'not_registered' })),
    subscribeOpen: vi.fn(async () => () => {}),
  },
}));
vi.mock('./utils/notificationLifecycle', () => ({
  createNotificationLifecycle: () => ({
    setUser: vi.fn(async () => {}),
    dispose: vi.fn(),
  }),
}));

import App from './App';
import { AUTH_INITIAL_STATE_TIMEOUT_MS } from './utils/authBootstrap';

const treeText = (renderer: TestRenderer.ReactTestRenderer) => JSON.stringify(renderer.toJSON());
const hasLoading = (renderer: TestRenderer.ReactTestRenderer) => (
  renderer.root.findAll((node) => node.props?.['aria-label'] === 'Loading ParQueen').length > 0
);
const hasStartupError = (renderer: TestRenderer.ReactTestRenderer) => (
  renderer.root.findAll((node) => node.props?.role === 'alert').length > 0
);

describe('auth startup watchdog', () => {
  beforeEach(() => {
    harness.store.clear();
    harness.listeners.length = 0;
    harness.unsubscribers.length = 0;
    harness.onAuthStateChanged.mockClear();
    harness.signOut.mockClear();
    harness.getDoc.mockClear();
    harness.onSnapshot.mockClear();
    harness.captureClientException.mockClear();
    harness.localStorage.clear.mockClear();
    harness.reload.mockClear();
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
});
