export type AnalyticsConsentStatus = 'unknown' | 'granted' | 'denied';

export interface AnalyticsConsentState {
  userId: string | null;
  status: AnalyticsConsentStatus;
}

export const NO_ANALYTICS_CONSENT: AnalyticsConsentState = {
  userId: null,
  status: 'unknown',
};

export function consentFromPreferences(
  userId: string,
  preferences: unknown,
): AnalyticsConsentState {
  if (!userId || !preferences || typeof preferences !== 'object') {
    return NO_ANALYTICS_CONSENT;
  }

  const value = (preferences as Record<string, unknown>).analyticsConsent;

  return {
    userId,
    status: value === true ? 'granted' : value === false ? 'denied' : 'unknown',
  };
}

export function canCollectAnalytics(
  state: AnalyticsConsentState,
  currentUserId: string | null,
): boolean {
  return Boolean(currentUserId)
    && state.userId === currentUserId
    && state.status === 'granted';
}