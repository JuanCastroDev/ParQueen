import { describe, expect, it } from 'vitest';
import { resolveAppCheckPath } from './appCheckPlatform';

describe('resolveAppCheckPath', () => {
  it('selects the web ReCaptchaEnterpriseProvider path for browser and PWA', () => {
    expect(resolveAppCheckPath({ isNative: false, platform: 'web' })).toBe('web');
  });

  it('selects the native CustomProvider bridge only on Capacitor Android', () => {
    expect(resolveAppCheckPath({ isNative: true, platform: 'android' })).toBe('native-android');
  });

  it('keeps the web path on Capacitor iOS so this phase does not add App Attest', () => {
    expect(resolveAppCheckPath({ isNative: true, platform: 'ios' })).toBe('web');
  });
});
