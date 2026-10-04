import { describe, expect, it } from 'vitest';
import { resolveAppCheckPath } from './appCheckPlatform';

describe('resolveAppCheckPath', () => {
  it('selects the web ReCaptchaEnterpriseProvider path for browser and PWA', () => {
    expect(resolveAppCheckPath({ isNative: false, platform: 'web' })).toBe('web');
  });

  it('selects the native CustomProvider bridge only on Capacitor Android', () => {
    expect(resolveAppCheckPath({ isNative: true, platform: 'android' })).toBe('native-android');
  });

  it('selects the native App Attest bridge on Capacitor iOS', () => {
    expect(resolveAppCheckPath({ isNative: true, platform: 'ios' })).toBe('native-ios');
  });
});
