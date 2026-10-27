/**
 * Phase 16B-1D: explicitly approved Product Analytics events.
 *
 * These events contain no custom properties, personal identifiers,
 * parking details, coordinates, URLs, or user-generated content.
 *
 * This module does not initialize an SDK or transmit anything.
 */

export const PRODUCT_ANALYTICS_EVENTS = Object.freeze([
  'map_opened',
  'ping_creation_started',
  'ping_creation_succeeded',
  'parking_claim_started',
  'handoff_success_recorded',
  'handoff_failure_recorded',
] as const);

export type ProductAnalyticsEvent =
  (typeof PRODUCT_ANALYTICS_EVENTS)[number];

export type ApprovedProductAnalyticsEvent = Readonly<{
  event: ProductAnalyticsEvent;
}>;

const approvedEventNames = new Set<string>(
  PRODUCT_ANALYTICS_EVENTS,
);

export function isApprovedProductAnalyticsEvent(
  value: unknown,
): value is ProductAnalyticsEvent {
  return typeof value === 'string'
    && approvedEventNames.has(value);
}

/**
 * Runtime allowlist validation.
 *
 * Returns an event name only; deliberately strips all other
 * input properties. Future SDK code must use this boundary.
 */
export function createApprovedProductAnalyticsEvent(
  input: unknown,
): ApprovedProductAnalyticsEvent | null {
  if (!isApprovedProductAnalyticsEvent(input)) {
    return null;
  }

  return Object.freeze({ event: input });
}