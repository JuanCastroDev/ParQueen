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
 * Web/PWA keep `navigator.geolocation`. Capacitor Android uses the official
 * `@capacitor/geolocation` plugin (foreground only). Capacitor iOS stays on
 * the browser path in this phase so we do not broaden into iOS native
 * location validation.
 */
export const resolveGeolocationPath = (
  env: GeolocationPlatformEnv = readGeolocationPlatformEnv(),
): GeolocationPath => (env.isNative && env.platform === 'android' ? 'native' : 'browser');
