import { Capacitor } from '@capacitor/core';

export interface FirebaseApiKeyEnv {
  isNative: boolean;
  platform: string;
  iosJsApiKey?: string;
}

export const readFirebaseApiKeyEnv = (): FirebaseApiKeyEnv => ({
  isNative: Capacitor.isNativePlatform(),
  platform: Capacitor.getPlatform(),
  iosJsApiKey: import.meta.env.VITE_FIREBASE_IOS_JS_API_KEY,
});

/**
 * Web/PWA and Capacitor Android keep the existing Browser key supplied by the
 * caller. Capacitor iOS runs the Firebase JS SDK from a native WebView context,
 * so it must use the dedicated Firebase-only API key injected by the iOS build.
 */
export const resolveFirebaseApiKey = (
  browserApiKey: string,
  env: FirebaseApiKeyEnv = readFirebaseApiKeyEnv(),
): string => {
  if (env.isNative && env.platform === 'ios') {
    const iosJsApiKey = env.iosJsApiKey?.trim();
    if (!iosJsApiKey) {
      throw new Error(
        'Missing VITE_FIREBASE_IOS_JS_API_KEY for native iOS Firebase initialization.',
      );
    }
    return iosJsApiKey;
  }

  return browserApiKey;
};
