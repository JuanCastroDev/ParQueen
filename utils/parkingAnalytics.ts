import { captureProductAnalyticsEvent } from './posthogAnalyticsRuntime';
import type { ProductAnalyticsEvent } from './productAnalyticsEvents';

/**
 * Analytics is strictly observational. Failed collection must never turn a
 * successful parking/claim/handoff operation into a failed user action.
 * The runtime itself requires confirmed consent and a disabled-by-default flag.
 */
/** Isolate synchronous analytics failures from user-visible parking actions. */
export function runAnalyticsCaptureSafely(capture: () => unknown): void {
  try {
    capture();
  } catch {
    // Best-effort analytics only. Never log event context or identity.
  }
}

export function recordParkingAnalyticsEvent(event: ProductAnalyticsEvent): void {
  runAnalyticsCaptureSafely(() => captureProductAnalyticsEvent(event));
}

/** A locally pending/cached snapshot cannot prove server-confirmed success. */
export function isConfirmedServerHandoffSuccess(
  claimState: unknown,
  metadata: { fromCache: boolean; hasPendingWrites: boolean } | undefined,
): boolean {
  return claimState === 'completed_success'
    && metadata?.fromCache === false
    && metadata?.hasPendingWrites === false;
}
