import type { AppCheckOptions, CustomProvider } from 'firebase/app-check';
import {
  DEMO_APP_CHECK_ID,
  DEMO_PROJECT_ID,
  PRODUCTION_APP_ID,
  STREET_INTEL_QA_MODE,
  STREET_INTEL_QA_PACKAGE,
} from './demoFirebase';

/**
 * Simulated emulator App Check token.
 *
 * The Functions emulator decodes a JWT and copies `sub` into `request.app.appId`
 * when its own debug feature `skipTokenVerification` is enabled. It does not
 * call production App Check. This token is not a production attestation, and
 * its app id is not the production app id.
 */
export function simulatedDemoAppCheckToken(now = Date.now()): { token: string; expireTimeMillis: number } {
  const demoAppId: string = DEMO_APP_CHECK_ID;
  if (demoAppId === PRODUCTION_APP_ID) {
    throw new Error('Simulated App Check reused the production app id.');
  }
  const encode = (value: object) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = '';
    bytes.forEach(byte => {
      binary += String.fromCharCode(byte);
    });
    return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  };
  const token = [
    encode({ alg: 'none', typ: 'JWT' }),
    encode({
      sub: DEMO_APP_CHECK_ID,
      aud: [`projects/${DEMO_PROJECT_ID}`],
      iss: 'demo-emulator',
      simulatedEmulatorAppCheck: true,
    }),
    'sim',
  ].join('.');
  return { token, expireTimeMillis: now + 60 * 60 * 1000 };
}

export function streetIntelQaAppCheckOptions(input: {
  mode?: string;
  packageId?: string;
  CustomProvider: new (options: ConstructorParameters<typeof CustomProvider>[0]) => CustomProvider;
}): AppCheckOptions | null {
  if (input.packageId == null || input.packageId === '') return null;
  if (input.mode !== STREET_INTEL_QA_MODE || input.packageId !== STREET_INTEL_QA_PACKAGE) {
    throw new Error('Simulated Street Intelligence App Check is refused outside the streetintelqa build.');
  }
  return {
    provider: new input.CustomProvider({
      getToken: () => Promise.resolve(simulatedDemoAppCheckToken()),
    }),
    isTokenAutoRefreshEnabled: true,
  };
}

export function localDemoAppCheckOptions(input: {
  dev: boolean;
  prod: boolean;
  mode?: string;
  CustomProvider: new (options: ConstructorParameters<typeof CustomProvider>[0]) => CustomProvider;
}): AppCheckOptions | null {
  if (input.mode !== 'local') return null;
  if (input.prod || !input.dev) {
    throw new Error('Simulated demo App Check is refused outside a development build.');
  }
  return {
    provider: new input.CustomProvider({
      getToken: () => Promise.resolve(simulatedDemoAppCheckToken()),
    }),
    isTokenAutoRefreshEnabled: true,
  };
}
