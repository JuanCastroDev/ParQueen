import { Capacitor } from '@capacitor/core';

export type PhoneAuthPath = 'web' | 'native';

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
 * Capacitor Android and Capacitor iOS use the native Phone Auth bridge.
 * The native bridge returns a verification ID; the existing JS Auth instance
 * completes sign-in or deletion reauth.
 */
export const resolvePhoneAuthPath = (
  env: PhoneAuthPlatformEnv = readPhoneAuthPlatformEnv(),
): PhoneAuthPath => (
  env.isNative && (env.platform === 'android' || env.platform === 'ios') ? 'native' : 'web'
);
