import { Capacitor } from '@capacitor/core';

export type PhoneAuthPath = 'web' | 'native-android' | 'native-ios';

export interface PhoneAuthPlatformEnv {
  isNative: boolean;
  platform: string;
}

export const readPhoneAuthPlatformEnv = (): PhoneAuthPlatformEnv => ({
  isNative: Capacitor.isNativePlatform(),
  platform: Capacitor.getPlatform(),
});

/**
 * Web/PWA keeps Firebase JS RecaptchaVerifier + signInWithPhoneNumber.
 * Capacitor Android keeps native send plus JS PhoneAuthProvider.credential.
 * Capacitor iOS verifies and confirms on the Apple SDK, then bridges with a custom token.
 */
export const resolvePhoneAuthPath = (
  env: PhoneAuthPlatformEnv = readPhoneAuthPlatformEnv(),
): PhoneAuthPath => {
  if (!env.isNative) return 'web';
  if (env.platform === 'android') return 'native-android';
  if (env.platform === 'ios') return 'native-ios';
  return 'web';
};
