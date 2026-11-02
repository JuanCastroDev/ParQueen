import { initializeApp, deleteApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { describe, expect, it } from 'vitest';
import {
  assertDemoFirebaseAllowed,
  demoFirebaseAppConfig,
  DEMO_PROJECT_ID,
  PRODUCTION_APP_ID,
  PRODUCTION_PROJECT_ID,
} from './demoFirebase';
import { simulatedDemoAppCheckToken } from './demoFirebaseAppCheck';
import { bindDemoEmulators } from './demoFirebaseRuntime';

describe('demo Firebase isolation', () => {
  it('refuses demo mode in a production build', () => {
    expect(() => assertDemoFirebaseAllowed({
      PROD: true,
      DEV: false,
      VITE_PARQUEEN_DEMO_FIREBASE: 'local',
    })).toThrow(/refused outside a development build/);
  });

  it('leaves the default production path untouched when demo mode is off', () => {
    expect(assertDemoFirebaseAllowed({ DEV: true, PROD: false })).toBe(false);
    expect(assertDemoFirebaseAllowed({
      DEV: true,
      PROD: false,
      VITE_PARQUEEN_DEMO_FIREBASE: 'off',
    })).toBe(false);
  });

  it('uses a demo project configuration with no production credentials', () => {
    const config = demoFirebaseAppConfig();
    expect(config.projectId).toBe(DEMO_PROJECT_ID);
    expect(config.projectId).not.toBe(PRODUCTION_PROJECT_ID);
    expect(config.appId).not.toBe(PRODUCTION_APP_ID);
    expect(JSON.stringify(config)).not.toContain(PRODUCTION_PROJECT_ID);
    expect(JSON.stringify(config)).not.toContain('AIza');
  });

  it('connects Auth, Firestore, and Functions before any service call', async () => {
    const app = initializeApp(demoFirebaseAppConfig(), 'demo-isolation-test');
    try {
      const auth = getAuth(app);
      const db = getFirestore(app);
      const functions = bindDemoEmulators({ app, auth, db });
      expect(auth.emulatorConfig).toMatchObject({ protocol: 'http', host: '127.0.0.1', port: 9099 });
      expect(functions).toBeDefined();
      const url = (functions as { _url?: (name: string) => string })._url?.('createSegmentFromSweepNYC')
        ?? (functions as { _delegate?: { _url?: (name: string) => string } })._delegate?._url?.('createSegmentFromSweepNYC');
      expect(url).toBe(
        'http://127.0.0.1:5001/demo-parkqueen-functions-test/us-central1/createSegmentFromSweepNYC',
      );
    } finally {
      await deleteApp(app);
    }
  });

  it('builds a simulated emulator App Check token for the demo app only', () => {
    const { token } = simulatedDemoAppCheckToken(1_700_000_000_000);
    expect(token).toMatch(/^[a-zA-Z0-9\-_=]+?\.[a-zA-Z0-9\-_=]+?\.([a-zA-Z0-9\-_=]+)?$/);
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    expect(payload.sub).toBe('demo-parkqueen-local');
    expect(payload.sub).not.toBe(PRODUCTION_APP_ID);
    expect(payload.simulatedEmulatorAppCheck).toBe(true);
    expect(payload.aud).toEqual([`projects/${DEMO_PROJECT_ID}`]);
  });
});
