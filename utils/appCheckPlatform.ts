import { Capacitor } from '@capacitor/core';

export type AppCheckPath = 'native-android' | 'web';

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
 * Capacitor iOS stays on the web / reCAPTCHA path in this phase — App Attest
 * is out of scope.
 */
export const resolveAppCheckPath = (
  env: AppCheckPlatformEnv = readAppCheckPlatformEnv(),
): AppCheckPath => (env.isNative && env.platform === 'android' ? 'native-android' : 'web');
