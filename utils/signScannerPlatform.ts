import { Capacitor } from '@capacitor/core';

export type SignScannerPath = 'native' | 'browser';

export interface SignScannerPlatformEnv {
  isNative: boolean;
  platform: string;
}

export const readSignScannerPlatformEnv = (): SignScannerPlatformEnv => ({
  isNative: Capacitor.isNativePlatform(),
  platform: Capacitor.getPlatform(),
});

/**
 * Web/PWA keep the existing hidden file inputs. Capacitor Android uses the
 * official `@capacitor/camera` plugin (system camera + Photo Picker).
 * Capacitor iOS stays on the browser / file-input path in this phase so we
 * do not broaden into iOS native camera.
 */
export const resolveSignScannerPath = (
  env: SignScannerPlatformEnv = readSignScannerPlatformEnv(),
): SignScannerPath => (env.isNative && env.platform === 'android' ? 'native' : 'browser');
