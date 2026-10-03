import { describe, expect, it } from 'vitest';
import { resolvePhoneAuthPath } from './phoneAuthPlatform';

describe('resolvePhoneAuthPath', () => {
  it('selects the web RecaptchaVerifier path for browser and PWA', () => {
    expect(resolvePhoneAuthPath({ isNative: false, platform: 'web' })).toBe('web');
  });

  it('selects the native path on Capacitor Android', () => {
    expect(resolvePhoneAuthPath({ isNative: true, platform: 'android' })).toBe('native');
  });

  it('selects the native path on Capacitor iOS', () => {
    expect(resolvePhoneAuthPath({ isNative: true, platform: 'ios' })).toBe('native');
  });
});
