import { Capacitor } from '@capacitor/core';
import { streetIntelQaBuild } from './demoFirebase';

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
 * The streetintelqa build uses the Auth emulator through the web path.
 * Capacitor iOS verifies and confirms on the Apple SDK, then bridges with a custom token.
 */
export const resolvePhoneAuthPath = (
  env: PhoneAuthPlatformEnv = readPhoneAuthPlatformEnv(),
): PhoneAuthPath => {
  if (streetIntelQaBuild()) return 'web';
  if (!env.isNative) return 'web';
  if (env.platform === 'android') return 'native-android';
  if (env.platform === 'ios') return 'native-ios';
  return 'web';
};
