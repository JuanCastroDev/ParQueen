/// <reference types="@capacitor/push-notifications" />
import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Phase 1 Capacitor shell config.
 * Locked appId `app.parqueen`. The Apple Developer explicit App ID is registered. Do not change it.
 * Loads the Vite `dist/` bundle only. Do not set `server.url` (no live-reload / no remote Hosting shell).
 *
 * PushNotifications.presentationOptions is empty so Android foreground
 * delivery matches Web/PWA: in-app toast only, not a second system banner.
 * Background / killed-state OS notifications still come from FCM.
 */
const streetIntelQa = process.env.PARQUEEN_STREET_INTEL_QA === 'app.parqueen.qa';

const config: CapacitorConfig = {
  appId: streetIntelQa ? 'app.parqueen.qa' : 'app.parqueen',
  appName: streetIntelQa ? 'ParQueen QA' : 'ParQueen',
  webDir: 'dist',
  ...(streetIntelQa
    ? { server: { androidScheme: 'http' as const, cleartext: true, hostname: 'localhost' } }
    : {}),
  // Before the first web frame the WebView paints this, not white. Equals the
  // dark --color-bg and the native launch background (pq_launch_background).
  android: {
    backgroundColor: '#050d1c',
  },
  plugins: {
    PushNotifications: {
      presentationOptions: [],
    },
  },
};

export default config;
