import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

describe('Android Phase 2B foreground location contracts', () => {
  it('declares only foreground location permissions required by @capacitor/geolocation', () => {
    const manifest = read('./app/src/main/AndroidManifest.xml');
    expect(manifest).toContain('android.permission.ACCESS_COARSE_LOCATION');
    expect(manifest).toContain('android.permission.ACCESS_FINE_LOCATION');
    expect(manifest).not.toContain('ACCESS_BACKGROUND_LOCATION');
  });

  it('does not add background location anywhere under android/', () => {
    const manifest = read('./app/src/main/AndroidManifest.xml');
    const gradle = read('./app/build.gradle');
    expect(manifest + gradle).not.toMatch(/ACCESS_BACKGROUND_LOCATION/);
  });
});
