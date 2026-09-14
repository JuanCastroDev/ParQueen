import { describe, expect, it } from 'vitest';
import { resolveSignScannerPath } from './signScannerPlatform';

describe('resolveSignScannerPath', () => {
  it('selects the browser file-input path for Web and PWA', () => {
    expect(resolveSignScannerPath({ isNative: false, platform: 'web' })).toBe('browser');
  });

  it('selects the native Capacitor camera path only on Capacitor Android', () => {
    expect(resolveSignScannerPath({ isNative: true, platform: 'android' })).toBe('native');
  });

  it('keeps the browser path on Capacitor iOS so this phase does not change iOS camera', () => {
    expect(resolveSignScannerPath({ isNative: true, platform: 'ios' })).toBe('browser');
  });
});
