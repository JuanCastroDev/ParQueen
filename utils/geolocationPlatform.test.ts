import { describe, expect, it } from 'vitest';
import { resolveGeolocationPath } from './geolocationPlatform';

describe('resolveGeolocationPath', () => {
  it('selects the browser geolocation path for Web and PWA', () => {
    expect(resolveGeolocationPath({ isNative: false, platform: 'web' })).toBe('browser');
  });

  it('selects the native Capacitor path on Android', () => {
    expect(resolveGeolocationPath({ isNative: true, platform: 'android' })).toBe('native');
  });

  it('selects the native Capacitor path on iOS', () => {
    expect(resolveGeolocationPath({ isNative: true, platform: 'ios' })).toBe('native');
  });

  it('does not treat a non-native ios-like environment as native', () => {
    expect(resolveGeolocationPath({ isNative: false, platform: 'ios' })).toBe('browser');
  });
});
