import { describe, expect, it } from 'vitest';

import {
  PRODUCT_ANALYTICS_EVENTS,
  createApprovedProductAnalyticsEvent,
  isApprovedProductAnalyticsEvent,
} from './productAnalyticsEvents';

describe('Product Analytics event allowlist', () => {
  it('contains exactly the six approved event names', () => {
    expect(PRODUCT_ANALYTICS_EVENTS).toEqual([
      'map_opened',
      'ping_creation_started',
      'ping_creation_succeeded',
      'parking_claim_started',
      'handoff_success_recorded',
      'handoff_failure_recorded',
    ]);
  });

  it('accepts each approved event', () => {
    for (const event of PRODUCT_ANALYTICS_EVENTS) {
      expect(isApprovedProductAnalyticsEvent(event)).toBe(true);
      expect(createApprovedProductAnalyticsEvent(event))
        .toEqual({ event });
    }
  });

  it('rejects unapproved event names', () => {
    for (const value of [
      'user_identified',
      'location_changed',
      'chat_message_sent',
      'screen_view',
      '$pageview',
      '',
    ]) {
      expect(isApprovedProductAnalyticsEvent(value)).toBe(false);
      expect(createApprovedProductAnalyticsEvent(value))
        .toBeNull();
    }
  });

  it('rejects arbitrary objects and malformed values', () => {
    for (const value of [
      null,
      undefined,
      123,
      true,
      {},
      { event: 'map_opened', userId: 'private-id' },
      ['map_opened'],
    ]) {
      expect(createApprovedProductAnalyticsEvent(value))
        .toBeNull();
    }
  });

  it('never adds custom event properties', () => {
    const approved = createApprovedProductAnalyticsEvent(
      'map_opened',
    );

    expect(approved).not.toBeNull();
    expect(Object.keys(approved!)).toEqual(['event']);
    expect(Object.isFrozen(approved)).toBe(true);
  });

  it('keeps the approved event list immutable', () => {
    expect(Object.isFrozen(PRODUCT_ANALYTICS_EVENTS))
      .toBe(true);
  });
});