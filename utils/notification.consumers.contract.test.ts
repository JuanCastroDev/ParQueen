import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const uiConsumers = [
  '../App.tsx',
  '../views/NotificationsView.tsx',
  '../views/NotificationsSettingsView.tsx',
  '../views/SettingsView.tsx',
  '../components/NotificationEnableCard.tsx',
] as const;

describe('notification consumers use the shared abstraction', () => {
  it.each(uiConsumers)('%s does not request permission or branch on Capacitor itself', (rel) => {
    const source = read(rel);
    expect(source).not.toMatch(/Notification\.requestPermission/);
    expect(source).not.toMatch(/Capacitor\.(isNativePlatform|getPlatform)/);
    expect(source).not.toMatch(/from '@capacitor\/push-notifications'/);
  });

  it('native adapter never uses the browser Notification API or service worker', () => {
    const source = read('./notificationNative.ts');
    expect(source).not.toMatch(/Notification\.requestPermission/);
    expect(source).not.toMatch(/serviceWorker/);
    expect(source).not.toMatch(/PushManager/);
    expect(source).not.toMatch(/getFCM/);
    expect(source).not.toMatch(/console\.(log|info|debug).*(token|fcmToken)/i);
  });

  it('Web/PWA registration still uses Firebase Web Messaging and Notification.requestPermission', () => {
    const source = read('./notificationRegistration.ts');
    expect(source).toMatch(/Notification\.requestPermission/);
    expect(source).toMatch(/getFCM/);
    expect(source).toMatch(/firebase\/messaging/);
  });

  it('declares POST_NOTIFICATIONS and does not add background location', () => {
    const manifest = read('../android/app/src/main/AndroidManifest.xml');
    expect(manifest).toContain('android.permission.POST_NOTIFICATIONS');
    expect(manifest).toContain('android.permission.ACCESS_COARSE_LOCATION');
    expect(manifest).toContain('android.permission.ACCESS_FINE_LOCATION');
    expect(manifest).not.toMatch(/uses-permission[^>]*ACCESS_BACKGROUND_LOCATION/);
  });
});
