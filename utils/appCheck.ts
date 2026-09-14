import {
  CustomProvider,
  initializeAppCheck,
  ReCaptchaEnterpriseProvider,
} from 'firebase/app-check';
import type { FirebaseApp } from 'firebase/app';
import { nativeGetAppCheckToken, type NativeAppCheckToken } from './appCheckNative';
import { resolveAppCheckPath, type AppCheckPath } from './appCheckPlatform';

export const NATIVE_APP_CHECK_FAILURE = 'Native App Check token request failed.';

export interface AppCheckInitDependencies {
  resolvePath?: () => AppCheckPath;
  getNativeToken?: () => Promise<NativeAppCheckToken>;
  initializeAppCheck?: typeof initializeAppCheck;
  CustomProvider?: typeof CustomProvider;
  ReCaptchaEnterpriseProvider?: typeof ReCaptchaEnterpriseProvider;
  siteKey?: string | undefined;
  isDev?: boolean;
  warn?: (message: string) => void;
}

let initialized = false;

export const resetParQueenAppCheckInitForTests = (): void => {
  initialized = false;
};

const sanitizeNativeToken = (result: NativeAppCheckToken | null | undefined): NativeAppCheckToken => {
  const token = typeof result?.token === 'string' ? result.token : '';
  const expireTimeMillis = Number(result?.expireTimeMillis);
  if (!token || !Number.isFinite(expireTimeMillis)) {
    throw new Error(NATIVE_APP_CHECK_FAILURE);
  }
  return { token, expireTimeMillis };
};

export const fetchNativeAppCheckToken = async (
  getNativeToken: () => Promise<NativeAppCheckToken> = nativeGetAppCheckToken,
  warn: (message: string) => void = (message) => console.warn(message),
): Promise<NativeAppCheckToken> => {
  try {
    return sanitizeNativeToken(await getNativeToken());
  } catch {
    warn('[AppCheck] Native token request failed.');
    throw new Error(NATIVE_APP_CHECK_FAILURE);
  }
};

/**
 * Single JS App Check initialization.
 *
 * Capacitor Android → CustomProvider wrapping the native Play Integrity /
 * Debug bridge. Web/PWA (and Capacitor iOS) → existing
 * ReCaptchaEnterpriseProvider gated on VITE_FIREBASE_APPCHECK_SITE_KEY.
 *
 * Android never falls back to WebView reCAPTCHA.
 */
export const initializeParQueenAppCheck = (
  app: FirebaseApp,
  deps: AppCheckInitDependencies = {},
): void => {
  if (initialized) {
    return;
  }
  initialized = true;

  const resolvePath = deps.resolvePath ?? (() => resolveAppCheckPath());
  const getNativeToken = deps.getNativeToken ?? nativeGetAppCheckToken;
  const init = deps.initializeAppCheck ?? initializeAppCheck;
  const Custom = deps.CustomProvider ?? CustomProvider;
  const Recaptcha = deps.ReCaptchaEnterpriseProvider ?? ReCaptchaEnterpriseProvider;
  const siteKey = deps.siteKey ?? import.meta.env.VITE_FIREBASE_APPCHECK_SITE_KEY;
  const isDev = deps.isDev ?? import.meta.env.DEV;
  const warn = deps.warn ?? ((message: string) => console.warn(message));
  const path = resolvePath();

  if (path === 'native-android') {
    try {
      init(app, {
        provider: new Custom({
          getToken: () => fetchNativeAppCheckToken(getNativeToken, warn),
        }),
        isTokenAutoRefreshEnabled: true,
      });
    } catch {
      warn('[AppCheck] Native initialization failed.');
    }
    return;
  }

  const appCheckSiteKey = siteKey;
  if (appCheckSiteKey) {
    try {
      init(app, {
        provider: new Recaptcha(appCheckSiteKey),
        isTokenAutoRefreshEnabled: true,
      });
    } catch {
      warn('[AppCheck] Initialization failed.');
    }
  } else if (isDev) {
    warn('[AppCheck] TM-12 OPEN: VITE_FIREBASE_APPCHECK_SITE_KEY not set. App Check not initialized.');
  }
};
