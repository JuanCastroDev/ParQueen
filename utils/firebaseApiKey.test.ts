import { describe, expect, it } from 'vitest';
import { resolveFirebaseApiKey } from './firebaseApiKey';

const BROWSER_KEY = 'browser-key-sentinel';

describe('resolveFirebaseApiKey', () => {
  it('keeps the existing restricted Browser key for web/PWA', () => {
    expect(resolveFirebaseApiKey(BROWSER_KEY, {
      isNative: false,
      platform: 'web',
      iosJsApiKey: 'ios-dedicated-key',
    })).toBe(BROWSER_KEY);
  });

  it('keeps the existing Browser key for Capacitor Android', () => {
    expect(resolveFirebaseApiKey(BROWSER_KEY, {
      isNative: true,
      platform: 'android',
      iosJsApiKey: 'ios-dedicated-key',
    })).toBe(BROWSER_KEY);
  });

  it('uses the injected dedicated Firebase key for Capacitor iOS', () => {
    expect(resolveFirebaseApiKey(BROWSER_KEY, {
      isNative: true,
      platform: 'ios',
      iosJsApiKey: '  ios-dedicated-key  ',
    })).toBe('ios-dedicated-key');
  });

  it('fails closed when the native iOS key is missing', () => {
    expect(() => resolveFirebaseApiKey(BROWSER_KEY, {
      isNative: true,
      platform: 'ios',
      iosJsApiKey: '',
    })).toThrow('Missing VITE_FIREBASE_IOS_JS_API_KEY');
  });
});
