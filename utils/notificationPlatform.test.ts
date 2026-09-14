import { describe, expect, it } from 'vitest';
import { resolveNotificationPath } from './notificationPlatform';

describe('resolveNotificationPath', () => {
  it('selects the browser Firebase Messaging path for Web and PWA', () => {
    expect(resolveNotificationPath({ isNative: false, platform: 'web' })).toBe('browser');
  });

  it('selects the native Capacitor path only on Capacitor Android', () => {
    expect(resolveNotificationPath({ isNative: true, platform: 'android' })).toBe('native');
  });

  it('keeps the browser path on Capacitor iOS so this phase does not change iOS push', () => {
    expect(resolveNotificationPath({ isNative: true, platform: 'ios' })).toBe('browser');
  });
});
