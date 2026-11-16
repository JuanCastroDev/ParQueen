// QA-only preview gate. Keep native platform checks out of App.tsx:
// notification/geolocation consumers must use dedicated platform abstractions.
import { Capacitor } from '@capacitor/core';
import { ONBOARDING_V2_ENABLED } from './onboardingFlags';

export const ONBOARDING_V2_ANDROID_PREVIEW_ENABLED: boolean =
  ONBOARDING_V2_ENABLED &&
  import.meta.env.VITE_OBV2_PREVIEW === '1' &&
  Capacitor.isNativePlatform() &&
  Capacitor.getPlatform() === 'android';
