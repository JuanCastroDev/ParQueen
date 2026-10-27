import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProductAnalyticsRuntime } from './posthogAnalyticsRuntime';
import {
  beginAnalyticsConsentSession,
  receiveAnalyticsConsentSnapshot,
  revokeAnalyticsConsentImmediately,
  confirmAnalyticsOptOutReconciled,
} from './analyticsConsentSession';

const confirmed = { fromCache: false, hasPendingWrites: false };
const storage = new Map<string, string>();

beforeEach(() => {
  storage.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  beginAnalyticsConsentSession(null);
});

afterEach(() => {
  beginAnalyticsConsentSession('runtime-test-user');
  receiveAnalyticsConsentSnapshot('runtime-test-user', { analyticsConsent: false }, confirmed);
  confirmAnalyticsOptOutReconciled('runtime-test-user');
  beginAnalyticsConsentSession(null);
  vi.unstubAllGlobals();
});

const grant = () => {
  beginAnalyticsConsentSession('runtime-test-user');
  receiveAnalyticsConsentSnapshot('runtime-test-user', { analyticsConsent: true }, confirmed);
};

describe('PostHog application runtime (direct transport)', () => {
  it('does nothing when feature switch is off', () => {
    const sendRequest = vi.fn(async () => new Response(null, { status: 200 }));
    const runtime = createProductAnalyticsRuntime({ enabled: false, projectToken: 'phc_test', sendRequest });
    try {
      grant();
      expect(runtime.capture('map_opened')).toBe(false);
      expect(sendRequest).not.toHaveBeenCalled();
    } finally { runtime.dispose(); }
  });

  it('does nothing with a missing project token', () => {
    const sendRequest = vi.fn(async () => new Response(null, { status: 200 }));
    const runtime = createProductAnalyticsRuntime({ enabled: true, sendRequest });
    try {
      grant();
      expect(runtime.capture('map_opened')).toBe(false);
      expect(sendRequest).not.toHaveBeenCalled();
    } finally { runtime.dispose(); }
  });

  it('submits one approved event only after confirmed consent', () => {
    const sendRequest = vi.fn(async () => new Response(null, { status: 200 }));
    const runtime = createProductAnalyticsRuntime({ enabled: true, projectToken: 'phc_test', sendRequest });
    try {
      expect(runtime.capture('map_opened')).toBe(false);
      expect(sendRequest).not.toHaveBeenCalled();
      grant();
      expect(runtime.capture('map_opened')).toBe(true);
      expect(sendRequest).toHaveBeenCalledTimes(1);
      expect(runtime.capture('$pageview' as never)).toBe(false);
      expect(sendRequest).toHaveBeenCalledTimes(1);
    } finally { runtime.dispose(); }
  });

  it('stops requests immediately after withdrawal', () => {
    const sendRequest = vi.fn(() => new Promise<Response>(() => {}));
    const runtime = createProductAnalyticsRuntime({ enabled: true, projectToken: 'phc_test', sendRequest });
    try {
      grant();
      expect(runtime.capture('map_opened')).toBe(true);
      const signal = (sendRequest.mock.calls[0] as unknown as [string, RequestInit])[1].signal;
      revokeAnalyticsConsentImmediately();
      expect(signal?.aborted).toBe(true);
      expect(runtime.capture('map_opened')).toBe(false);
      expect(sendRequest).toHaveBeenCalledTimes(1);
    } finally { runtime.dispose(); }
  });
});
