import { describe, expect, it } from 'vitest';
import {
  NO_ANALYTICS_CONSENT,
  consentFromPreferences,
  canCollectAnalytics,
} from './analyticsConsent';

describe('analytics consent privacy gate', () => {
  it('defaults to disabled', () => {
    expect(canCollectAnalytics(NO_ANALYTICS_CONSENT, 'user-a')).toBe(false);
  });

  it('rejects missing or invalid preferences', () => {
    for (const prefs of [null, {}, { analyticsConsent: 'yes' }]) {
      expect(canCollectAnalytics(consentFromPreferences('user-a', prefs), 'user-a')).toBe(false);
    }
  });

  it('rejects explicit refusal', () => {
    expect(canCollectAnalytics(
      consentFromPreferences('user-a', { analyticsConsent: false }),
      'user-a',
    )).toBe(false);
  });

  it('accepts explicit consent for the matching account', () => {
    const state = consentFromPreferences('user-a', { analyticsConsent: true });
    expect(canCollectAnalytics(state, 'user-a')).toBe(true);
    expect(canCollectAnalytics(state, 'user-b')).toBe(false);
  });

  it('stops when the user logs out', () => {
    const state = consentFromPreferences('user-a', { analyticsConsent: true });
    expect(canCollectAnalytics(state, null)).toBe(false);
  });
});