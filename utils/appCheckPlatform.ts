import { Capacitor } from '@capacitor/core';

export type AppCheckPath = 'native-android' | 'native-ios' | 'web';

export interface AppCheckPlatformEnv {
  isNative: boolean;
  platform: string;
}

export const readAppCheckPlatformEnv = (): AppCheckPlatformEnv => ({
  isNative: Capacitor.isNativePlatform(),
  platform: Capacitor.getPlatform(),
});

/**
 * Web/PWA keep Firebase JS ReCaptchaEnterpriseProvider. Capacitor Android
 * uses the narrow native App Check bridge (Play Integrity / Debug).
 * Capacitor iOS uses the same JS CustomProvider bridge backed by native
 * Firebase App Check + App Attest.
 */
export const resolveAppCheckPath = (
  env: AppCheckPlatformEnv = readAppCheckPlatformEnv(),
): AppCheckPath => {
  if (!env.isNative) return 'web';
  if (env.platform === 'android') return 'native-android';
  if (env.platform === 'ios') return 'native-ios';
  return 'web';
};
