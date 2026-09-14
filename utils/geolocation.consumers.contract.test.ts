import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const consumers = [
  '../App.tsx',
  '../views/LocationPromptView.tsx',
  '../views/StreetParkingView.tsx',
  '../views/NotificationsView.tsx',
  '../views/assistant/HydrantDistanceTool.tsx',
] as const;

describe('location consumers use the shared abstraction', () => {
  it.each(consumers)('%s does not call navigator.geolocation or branch on Capacitor itself', (rel) => {
    const source = read(rel);
    expect(source).not.toMatch(/navigator\.geolocation/);
    expect(source).not.toMatch(/navigator\.permissions/);
    expect(source).not.toMatch(/Capacitor\.(isNativePlatform|getPlatform)/);
    expect(source).not.toMatch(/from '@capacitor\/geolocation'/);
    expect(source).toMatch(/from ['"].*utils\/geolocation['"]/);
  });

  it('App.tsx uses platform-aware reconciliation instead of the web-only snapshot helper', () => {
    const app = read('../App.tsx');
    expect(app).toMatch(/reconcileLocationAccess\(/);
    expect(app).not.toMatch(/resolveFromPermissionSnapshot\(/);
    expect(app).toMatch(/persistReconciledAccess\(/);
  });

  it('does not declare background location permission in the Android manifest', () => {
    const manifest = read('../android/app/src/main/AndroidManifest.xml');
    expect(manifest).toContain('android.permission.ACCESS_COARSE_LOCATION');
    expect(manifest).toContain('android.permission.ACCESS_FINE_LOCATION');
    expect(manifest).not.toMatch(/uses-permission[^>]*ACCESS_BACKGROUND_LOCATION/);
  });
});
