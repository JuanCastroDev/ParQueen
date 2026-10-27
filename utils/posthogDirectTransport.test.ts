import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPostHogDirectTransport } from './posthogDirectTransport';
import {
  beginAnalyticsConsentSession,
  receiveAnalyticsConsentSnapshot,
  revokeAnalyticsConsentImmediately,
  invalidateAnalyticsConsent,
  confirmAnalyticsOptOutReconciled,
} from './analyticsConsentSession';
import { PRODUCT_ANALYTICS_EVENTS } from './productAnalyticsEvents';

const confirmed = { fromCache: false, hasPendingWrites: false };
const storage = new Map<string, string>();
let nextId = 0;

const id = () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, '0')}`;
const grant = (uid = 'transport-a') => {
  beginAnalyticsConsentSession(uid);
  receiveAnalyticsConsentSnapshot(uid, { analyticsConsent: true }, confirmed);
};

beforeEach(() => {
  storage.clear();
  nextId = 0;
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
    removeItem: (key: string) => { storage.delete(key); },
  });
  vi.stubGlobal('crypto', { randomUUID: vi.fn(id) });
  beginAnalyticsConsentSession(null);
});

afterEach(() => {
  for (const uid of ['transport-a', 'transport-b']) {
    beginAnalyticsConsentSession(uid);
    receiveAnalyticsConsentSnapshot(uid, { analyticsConsent: false }, confirmed);
    confirmAnalyticsOptOutReconciled(uid);
  }
  beginAnalyticsConsentSession(null);
  vi.unstubAllGlobals();
});

const parseRequest = (request: ReturnType<typeof vi.fn>, index = 0) => {
  const call: unknown = request.mock.calls[index];
  if (
    !Array.isArray(call) ||
    typeof call[0] !== 'string' ||
    !call[1] ||
    typeof call[1] !== 'object'
  ) {
    throw new Error(`Missing or malformed request at index ${index}`);
  }
  const options = call[1] as RequestInit;
  return {
    url: call[0] as string,
    options,
    body: JSON.parse(String(options.body)) as Record<string, unknown>,
  };
};

describe('consent-controlled direct PostHog transport', () => {
  it('sends nothing before server-confirmed consent or when cached/pending', () => {
    const sendRequest = vi.fn(async () => new Response(null, { status: 200 }));
    const sender = createPostHogDirectTransport({ projectToken: 'phc_fake', sendRequest });
    try {
      expect(sender.capture('map_opened')).toBe(false);
      beginAnalyticsConsentSession('transport-a');
      receiveAnalyticsConsentSnapshot('transport-a', { analyticsConsent: true }, { fromCache: true, hasPendingWrites: false });
      expect(sender.capture('map_opened')).toBe(false);
      receiveAnalyticsConsentSnapshot('transport-a', { analyticsConsent: true }, { fromCache: false, hasPendingWrites: true });
      expect(sender.capture('map_opened')).toBe(false);
      expect(sendRequest).not.toHaveBeenCalled();
    } finally { sender.dispose(); }
  });

  it('sends only the documented anonymous shape with private transport options', () => {
    const sendRequest = vi.fn(async () => new Response(null, { status: 200 }));
    const sender = createPostHogDirectTransport({ projectToken: 'phc_fake', sendRequest });
    try {
      grant();
      expect(sender.capture('map_opened')).toBe(true);
      const { url, options, body } = parseRequest(sendRequest);
      expect(url).toBe('https://us.i.posthog.com/i/v0/e/');
      expect(options).toMatchObject({
        method: 'POST', mode: 'cors', credentials: 'omit',
        referrerPolicy: 'no-referrer', cache: 'no-store',
        keepalive: false, redirect: 'error',
        headers: { 'Content-Type': 'application/json' },
      });
      expect(options.signal).toBeInstanceOf(AbortSignal);
      expect(Object.keys(body).sort()).toEqual(['api_key', 'distinct_id', 'event', 'properties', 'uuid']);
      expect(body).toMatchObject({
        api_key: 'phc_fake', event: 'map_opened',
        properties: { $process_person_profile: false },
      });
      expect(Object.keys(body.properties as object)).toEqual(['$process_person_profile']);
      expect(typeof body.distinct_id).toBe('string');
      expect(body.distinct_id).not.toBe('transport-a');
      expect(typeof body.uuid).toBe('string');
      expect(body.uuid).not.toBe(body.distinct_id);
      expect(storage.size).toBe(0);
    } finally { sender.dispose(); }
  });

  it('permits exactly the six named events and rejects arbitrary payloads', () => {
    const sendRequest = vi.fn(async () => new Response(null, { status: 200 }));
    const sender = createPostHogDirectTransport({ projectToken: 'phc_fake', sendRequest });
    try {
      grant();
      for (const event of PRODUCT_ANALYTICS_EVENTS) expect(sender.capture(event)).toBe(true);
      for (const invalid of ['$pageview', '$identify', 'chat_message_sent', { event: 'map_opened', uid: 'secret' }, null]) {
        expect(sender.capture(invalid)).toBe(false);
      }
      expect(sendRequest).toHaveBeenCalledTimes(6);
    } finally { sender.dispose(); }
  });

  it('makes one attempt only on HTTP 503, no scheduled retry', async () => {
    const sendRequest = vi.fn(async () => new Response(null, { status: 503 }));
    const sender = createPostHogDirectTransport({ projectToken: 'phc_fake', sendRequest });
    try {
      grant();
      expect(sender.capture('map_opened')).toBe(true);
      await Promise.resolve(); await Promise.resolve();
      revokeAnalyticsConsentImmediately();
      await Promise.resolve();
      expect(sendRequest).toHaveBeenCalledTimes(1);
    } finally { sender.dispose(); }
  });

  it('does not retry a rejected fetch', async () => {
    const sendRequest = vi.fn(async () => { throw new Error('offline'); });
    const sender = createPostHogDirectTransport({ projectToken: 'phc_fake', sendRequest });
    try {
      grant();
      expect(sender.capture('map_opened')).toBe(true);
      await Promise.resolve(); await Promise.resolve();
      revokeAnalyticsConsentImmediately();
      expect(sendRequest).toHaveBeenCalledTimes(1);
    } finally { sender.dispose(); }
  });

  it('aborts an in-flight fetch immediately on opt-out, and never starts another', () => {
    const sendRequest = vi.fn(() => new Promise<Response>(() => {}));
    const sender = createPostHogDirectTransport({ projectToken: 'phc_fake', sendRequest });
    try {
      grant();
      expect(sender.capture('map_opened')).toBe(true);
      const { options } = parseRequest(sendRequest);
      expect(options.signal?.aborted).toBe(false);
      revokeAnalyticsConsentImmediately();
      expect(options.signal?.aborted).toBe(true);
      expect(sender.capture('map_opened')).toBe(false);
      expect(sendRequest).toHaveBeenCalledTimes(1);
    } finally { sender.dispose(); }
  });

  it('discards identity on account change and never replays failed events', () => {
    const sendRequest = vi.fn(async () => new Response(null, { status: 503 }));
    const sender = createPostHogDirectTransport({ projectToken: 'phc_fake', sendRequest });
    try {
      grant('transport-a');
      expect(sender.capture('map_opened')).toBe(true);
      const firstId = parseRequest(sendRequest).body.distinct_id;
      beginAnalyticsConsentSession('transport-b');
      expect(sender.capture('map_opened')).toBe(false);
      receiveAnalyticsConsentSnapshot('transport-b', { analyticsConsent: true }, confirmed);
      expect(sender.capture('map_opened')).toBe(true);
      const secondBody = parseRequest(sendRequest, 1).body;
      expect(secondBody.distinct_id).not.toBe(firstId);
      expect(sendRequest).toHaveBeenCalledTimes(2);
    } finally { sender.dispose(); }
  });

  it('rotates identity after an OFF then new confirmed ON, and does not replay', () => {
    const sendRequest = vi.fn(async () => new Response(null, { status: 503 }));
    const sender = createPostHogDirectTransport({ projectToken: 'phc_fake', sendRequest });
    try {
      grant();
      sender.capture('map_opened');
      const firstId = parseRequest(sendRequest).body.distinct_id;
      revokeAnalyticsConsentImmediately();
      receiveAnalyticsConsentSnapshot('transport-a', { analyticsConsent: false }, confirmed);
      receiveAnalyticsConsentSnapshot('transport-a', { analyticsConsent: true }, confirmed);
      expect(sendRequest).toHaveBeenCalledTimes(1);
      // A stale OFF snapshot cannot silently clear an unacknowledged veto.
      expect(sender.capture('map_opened')).toBe(false);
      // Simulate the coordinator's acknowledged OFF + fresh server verification.
      confirmAnalyticsOptOutReconciled('transport-a');
      receiveAnalyticsConsentSnapshot('transport-a', { analyticsConsent: true }, confirmed);
      expect(sender.capture('map_opened')).toBe(true);
      const secondBody = parseRequest(sendRequest, 1).body;
      expect(secondBody.distinct_id).not.toBe(firstId);
    } finally { sender.dispose(); }
  });

  it('aborts on consent invalidation and logout', () => {
    const sendRequest = vi.fn(() => new Promise<Response>(() => {}));
    const sender = createPostHogDirectTransport({ projectToken: 'phc_fake', sendRequest });
    try {
      grant();
      sender.capture('map_opened');
      const first = parseRequest(sendRequest, 0).options.signal;
      invalidateAnalyticsConsent();
      expect(first?.aborted).toBe(true);
      receiveAnalyticsConsentSnapshot('transport-a', { analyticsConsent: true }, confirmed);
      sender.capture('map_opened');
      const second = parseRequest(sendRequest, 1).options.signal;
      beginAnalyticsConsentSession(null);
      expect(second?.aborted).toBe(true);
    } finally { sender.dispose(); }
  });

  it('fails closed without cryptographic randomness or when fetch throws synchronously', () => {
    const sendRequest = vi.fn(() => { throw new Error('blocked'); });
    const sender = createPostHogDirectTransport({ projectToken: 'phc_fake', sendRequest });
    try {
      grant();
      vi.stubGlobal('crypto', undefined);
      expect(sender.capture('map_opened')).toBe(false);
      expect(sendRequest).not.toHaveBeenCalled();
      vi.stubGlobal('crypto', { randomUUID: vi.fn(id) });
      expect(sender.capture('map_opened')).toBe(false);
      expect(sendRequest).toHaveBeenCalledTimes(1);
    } finally { sender.dispose(); }
  });

  it('aborts pending requests when disposed and refuses further captures', () => {
    const sendRequest = vi.fn(() => new Promise<Response>(() => {}));
    const sender = createPostHogDirectTransport({ projectToken: 'phc_fake', sendRequest });
    grant();
    sender.capture('map_opened');
    const signal = parseRequest(sendRequest).options.signal;
    sender.dispose();
    expect(signal?.aborted).toBe(true);
    expect(sender.capture('map_opened')).toBe(false);
    expect(sendRequest).toHaveBeenCalledTimes(1);
  });
});
