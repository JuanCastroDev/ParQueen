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
  androidToken?: string;
}

export const readMapboxTokenEnv = (): MapboxTokenEnv => ({
  isNative: Capacitor.isNativePlatform(),
  platform: Capacitor.getPlatform(),
  webToken: import.meta.env.VITE_MAPBOX_TOKEN,
  iosToken: import.meta.env.VITE_MAPBOX_IOS_TOKEN,
  androidToken: import.meta.env.VITE_MAPBOX_ANDROID_TOKEN,
});

/**
 * Web/PWA use the website token. Native WebViews use platform-specific public
 * tokens so their origins do not depend on website-token URL restrictions.
 */
export const resolveMapboxToken = (
  env: MapboxTokenEnv = readMapboxTokenEnv(),
): string => {
  if (env.isNative && env.platform === 'ios') {
    return requiredBrowserCredential('VITE_MAPBOX_IOS_TOKEN', env.iosToken);
  }
  if (env.isNative && env.platform === 'android') {
    return requiredBrowserCredential('VITE_MAPBOX_ANDROID_TOKEN', env.androidToken);
  }
  return requiredBrowserCredential('VITE_MAPBOX_TOKEN', env.webToken);
};

export const getMapboxToken = (): string => resolveMapboxToken();

export { requiredBrowserCredential };
