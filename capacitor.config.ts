/// <reference types="@capacitor/push-notifications" />
import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Phase 1 Capacitor shell config.
 * Provisional appId `app.parqueen` (derived from parqueen.app) — confirm before treating as permanent.
 * Loads the Vite `dist/` bundle only. Do not set `server.url` (no live-reload / no remote Hosting shell).
 *
 * PushNotifications.presentationOptions is empty so Android foreground
 * delivery matches Web/PWA: in-app toast only, not a second system banner.
 * Background / killed-state OS notifications still come from FCM.
 */
const config: CapacitorConfig = {
  appId: 'app.parqueen',
  appName: 'ParQueen',
  webDir: 'dist',
  plugins: {
    PushNotifications: {
      presentationOptions: [],
    },
  },
};

export default config;
