import { Capacitor } from '@capacitor/core';
import type { FirebaseApp } from 'firebase/app';
import {
  browserLocalPersistence,
  getAuth,
  initializeAuth,
  type Auth,
} from 'firebase/auth';

export interface AuthPlatformEnv {
  isNative: boolean;
  platform: string;
}

export const readAuthPlatformEnv = (): AuthPlatformEnv => ({
  isNative: Capacitor.isNativePlatform(),
  platform: Capacitor.getPlatform(),
});

/**
 * Capacitor iOS avoids Firebase Auth's default IndexedDB persistence, which
 * can stall before the first auth-state callback. Web, PWA, and Capacitor
 * Android keep getAuth().
 */
export const usesCapacitorIosAuthPersistence = (
  env: AuthPlatformEnv = readAuthPlatformEnv(),
): boolean => env.isNative && env.platform === 'ios';

export const startupDiagnosticPlatform = (
  env: AuthPlatformEnv = readAuthPlatformEnv(),
): 'ios' | 'android' | 'web' | undefined => (
  env.platform === 'ios' || env.platform === 'android' || env.platform === 'web'
    ? env.platform
    : undefined
);

export interface ParQueenAuthDependencies {
  getAuth?: typeof getAuth;
  initializeAuth?: typeof initializeAuth;
  platform?: AuthPlatformEnv;
}

/**
 * One Auth instance for the default app.
 * Capacitor iOS: initializeAuth with browserLocalPersistence only.
 * Every other supported platform: getAuth(app), unchanged.
 * Unexpected initialization errors propagate.
 */
export const initializeParQueenAuth = (
  app: FirebaseApp,
  deps: ParQueenAuthDependencies = {},
): Auth => {
  const platform = deps.platform ?? readAuthPlatformEnv();
  if (usesCapacitorIosAuthPersistence(platform)) {
    const init = deps.initializeAuth ?? initializeAuth;
    return init(app, {
      persistence: browserLocalPersistence,
    });
  }
  const retrieve = deps.getAuth ?? getAuth;
  return retrieve(app);
};
