import { Capacitor } from '@capacitor/core';

export type GeolocationPath = 'native' | 'browser';

export interface GeolocationPlatformEnv {
  isNative: boolean;
  platform: string;
}

export const readGeolocationPlatformEnv = (): GeolocationPlatformEnv => ({
  isNative: Capacitor.isNativePlatform(),
  platform: Capacitor.getPlatform(),
});

/**
 * Web/PWA keep `navigator.geolocation`. Native Capacitor shells use the
 * official `@capacitor/geolocation` plugin in the foreground on both
 * Android and iOS. This avoids relying on WKWebView's browser geolocation
 * bridge for physical-device handoff proximity checks.
 */
export const resolveGeolocationPath = (
  env: GeolocationPlatformEnv = readGeolocationPlatformEnv(),
): GeolocationPath => (
  env.isNative && (env.platform === 'android' || env.platform === 'ios')
    ? 'native'
    : 'browser'
);
