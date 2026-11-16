import { Capacitor } from '@capacitor/core';
import { streetIntelQaBuild } from './demoFirebase';

export type NotificationPath = 'native' | 'browser';

export interface NotificationPlatformEnv {
  isNative: boolean;
  platform: string;
}

export const readNotificationPlatformEnv = (): NotificationPlatformEnv => ({
  isNative: Capacitor.isNativePlatform(),
  platform: Capacitor.getPlatform(),
});

/**
 * Web/PWA keep Firebase Web Messaging. Capacitor Android uses the official
 * `@capacitor/push-notifications` plugin. Capacitor iOS stays on the browser
 * path and does not register for APNs. Native-shell availability is classified
 * separately so the installed app does not inherit Safari Home Screen guidance.
 */
export const resolveNotificationPath = (
  env: NotificationPlatformEnv = readNotificationPlatformEnv(),
): NotificationPath => {
  if (streetIntelQaBuild()) return 'browser';
  return env.isNative && env.platform === 'android' ? 'native' : 'browser';
};
