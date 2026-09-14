import { describe, expect, it } from 'vitest';
import { resolveGeolocationPath } from './geolocationPlatform';

describe('resolveGeolocationPath', () => {
  it('selects the browser geolocation path for Web and PWA', () => {
    expect(resolveGeolocationPath({ isNative: false, platform: 'web' })).toBe('browser');
  });

  it('selects the native Capacitor path only on Capacitor Android', () => {
    expect(resolveGeolocationPath({ isNative: true, platform: 'android' })).toBe('native');
  });

  it('keeps the browser path on Capacitor iOS so this phase does not change iOS location', () => {
    expect(resolveGeolocationPath({ isNative: true, platform: 'ios' })).toBe('browser');
  });
});
