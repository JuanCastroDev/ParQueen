import { Capacitor } from '@capacitor/core';

const requiredBrowserCredential = (name: string, value: string | undefined): string => {
  const credential = value?.trim();
  if (!credential) {
    throw new Error(
      `[configuration] ${name} is required. Add it to .env.local for development or the approved production environment.`,
    );
  }
  return credential;
};

export interface MapboxTokenEnv {
  isNative: boolean;
  platform: string;
  webToken?: string;
  iosToken?: string;
}

export const readMapboxTokenEnv = (): MapboxTokenEnv => ({
  isNative: Capacitor.isNativePlatform(),
  platform: Capacitor.getPlatform(),
  webToken: import.meta.env.VITE_MAPBOX_TOKEN,
  iosToken: import.meta.env.VITE_MAPBOX_IOS_TOKEN,
});

/**
 * Web/PWA and Capacitor Android keep the existing web token.
 * Capacitor iOS runs Mapbox GL JS from a native WebView, so URL restrictions
 * on the web token do not authorize that origin. Native iOS therefore uses a
 * dedicated public Mapbox token injected only into iOS production builds.
 */
export const resolveMapboxToken = (
  env: MapboxTokenEnv = readMapboxTokenEnv(),
): string => {
  if (env.isNative && env.platform === 'ios') {
    return requiredBrowserCredential('VITE_MAPBOX_IOS_TOKEN', env.iosToken);
  }
  return requiredBrowserCredential('VITE_MAPBOX_TOKEN', env.webToken);
};

export const getMapboxToken = (): string => resolveMapboxToken();

export { requiredBrowserCredential };
