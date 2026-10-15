import {
  isAnalyticsCollectionAllowed,
  subscribeAnalyticsConsent,
} from './analyticsConsentSession';
import { isApprovedProductAnalyticsEvent } from './productAnalyticsEvents';

/**
 * Phase 16B-1H. Deliberately no PostHog SDK import: the browser SDK's
 * retry queue can resend a failed event after consent is withdrawn.
 *
 * The project token is public (NOT a PostHog personal API key).
 * Firebase identities must never enter the analytics payload.
 */
const CAPTURE_URL = 'https://us.i.posthog.com/i/v0/e/';

type RequestSender = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface DirectAnalyticsDependencies {
  projectToken: string;
  sendRequest?: RequestSender;
}

/** Cryptographic only; no Math.random or persistent fallback. */
function randomAnonymousId(): string | null {
  try {
    const cryptoProvider = globalThis.crypto;
    if (!cryptoProvider) return null;
    if (typeof cryptoProvider.randomUUID === 'function') {
      return cryptoProvider.randomUUID();
    }
    if (typeof cryptoProvider.getRandomValues !== 'function') return null;
    const bytes = new Uint8Array(16);
    cryptoProvider.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  } catch {
    return null;
  }
}

/**
 * A single, best-effort event sender. No queue, batching, retry timer,
 * beacon, SDK persistence, or user identification.
 *
 * An already-delivered request cannot be recalled. Aborting an in-flight
 * fetch is best effort, not proof of server-side cancellation.
 */
export function createPostHogDirectTransport(deps: DirectAnalyticsDependencies) {
  let disposed = false;
  let anonymousId: string | null = null;
  const pending = new Set<AbortController>();

  const permitted = () => !disposed && isAnalyticsCollectionAllowed();

  function discardSession(): void {
    anonymousId = null;
    for (const controller of pending) {
      try { controller.abort(); } catch { /* best effort */ }
    }
    pending.clear();
  }

  function synchronize(): void {
    if (!permitted()) discardSession();
  }

  const unsubscribe = subscribeAnalyticsConsent(synchronize);
  synchronize();

  return {
    capture(candidate: unknown): boolean {
      if (!permitted()) {
        discardSession();
        return false;
      }
      if (!isApprovedProductAnalyticsEvent(candidate)) return false;

      const token = deps.projectToken;
      if (!token || /\s/.test(token) || token.length > 256) return false;

      const request = deps.sendRequest ?? globalThis.fetch;
      if (typeof request !== 'function' || typeof AbortController === 'undefined') return false;

      const id = anonymousId ?? randomAnonymousId();
      const eventId = randomAnonymousId();
      if (!id || !eventId) return false;

      let controller: AbortController;
      try {
        controller = new AbortController();
      } catch {
        return false;
      }

      // Keep a stable *memory-only* ID for this one continuously permitted
      // session; dispose/withdrawal/auth change discards it.
      anonymousId = id;
      const body = JSON.stringify({
        api_key: token,
        event: candidate,
        distinct_id: id,
        uuid: eventId,
        properties: { $process_person_profile: false },
      });

      pending.add(controller);
      try {
        // Synchronous final permission check, directly before fetch starts.
        if (!permitted()) {
          discardSession();
          return false;
        }
        const sent = request(CAPTURE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          mode: 'cors',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          cache: 'no-store',
          keepalive: false,
          redirect: 'error',
          signal: controller.signal,
        });
        // Observe settlement only to clean up the controller. A 503, a
        // rejected promise, or an abort will NEVER initiate another request.
        void Promise.resolve(sent).then(
          () => { pending.delete(controller); },
          () => { pending.delete(controller); },
        );
        return true;
      } catch {
        pending.delete(controller);
        return false;
      }
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      discardSession();
    },
  };
}
