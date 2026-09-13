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
 * Web/PWA (and Capacitor iOS, which is out of this phase) keep Firebase JS
 * RecaptchaVerifier + signInWithPhoneNumber. Only Capacitor Android uses the
 * native Phone Auth bridge so SMS can be sent without WebView reCAPTCHA.
 */
export const resolvePhoneAuthPath = (
  env: PhoneAuthPlatformEnv = readPhoneAuthPlatformEnv(),
): PhoneAuthPath => (env.isNative && env.platform === 'android' ? 'native' : 'web');
