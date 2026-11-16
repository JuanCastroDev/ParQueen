export const DEMO_PROJECT_ID = 'demo-parkqueen-functions-test';
export const PRODUCTION_PROJECT_ID = 'parkqueen-46475363-ccf36';
export const PRODUCTION_APP_ID = '1:768131391875:web:613c5d2a948862333196b6';
export const DEMO_APP_CHECK_ID = 'demo-parkqueen-local';

export const DEMO_EMULATORS = {
  auth: { host: '127.0.0.1', port: 9099 },
  functions: { host: '127.0.0.1', port: 5001 },
  firestore: { host: '127.0.0.1', port: 8080 },
} as const;

export interface DemoFirebaseEnv {
  DEV?: boolean;
  PROD?: boolean;
  VITE_PARQUEEN_DEMO_FIREBASE?: string;
}

export function demoFirebaseRequested(env: DemoFirebaseEnv): boolean {
  return env.VITE_PARQUEEN_DEMO_FIREBASE === 'local';
}

export function assertDemoFirebaseAllowed(env: DemoFirebaseEnv): boolean {
  if (!demoFirebaseRequested(env)) return false;
  if (env.PROD || !env.DEV) {
    throw new Error('Demo Firebase mode is refused outside a development build.');
  }
  return true;
}

export const STREET_INTEL_QA_MODE = 'streetintelqa';
export const STREET_INTEL_QA_PACKAGE = 'app.parqueen.qa';

export interface StreetIntelQaEnv {
  MODE?: string;
  VITE_PARQUEEN_STREET_INTEL_QA?: string;
}

export function assertStreetIntelQaBuildAllowed(env: StreetIntelQaEnv): boolean {
  const requested = env.VITE_PARQUEEN_STREET_INTEL_QA;
  if (requested == null || requested === '') return false;
  if (requested !== STREET_INTEL_QA_PACKAGE || env.MODE !== STREET_INTEL_QA_MODE) {
    throw new Error('Street Intelligence QA is refused outside the streetintelqa build.');
  }
  return true;
}

export function streetIntelQaBuild(): boolean {
  return import.meta.env.MODE === STREET_INTEL_QA_MODE
    && import.meta.env.VITE_PARQUEEN_STREET_INTEL_QA === STREET_INTEL_QA_PACKAGE;
}

export function assertDemoEndpoints(): void {
  const { auth, functions, firestore } = DEMO_EMULATORS;
  if (auth.host !== '127.0.0.1' || auth.port !== 9099
    || functions.host !== '127.0.0.1' || functions.port !== 5001
    || firestore.host !== '127.0.0.1' || firestore.port !== 8080) {
    throw new Error('Demo Firebase emulator endpoints are incorrect.');
  }
}

export function demoFirebaseAppConfig() {
  assertDemoEndpoints();
  const config = {
    apiKey: 'demo-parkqueen-functions-test',
    authDomain: '127.0.0.1:9099',
    projectId: DEMO_PROJECT_ID,
    storageBucket: 'demo-parkqueen-functions-test.appspot.com',
    messagingSenderId: '000000000000',
    appId: '1:000000000000:web:demo-parkqueen-functions-test',
  };
  const projectId: string = config.projectId;
  const appId: string = config.appId;
  const apiKey: string = config.apiKey;
  const productionProject: string = PRODUCTION_PROJECT_ID;
  const productionApp: string = PRODUCTION_APP_ID;
  if (projectId !== DEMO_PROJECT_ID
    || projectId === productionProject
    || appId === productionApp
    || apiKey.includes('AIza')) {
    throw new Error('Demo Firebase configuration reused production credentials.');
  }
  return config;
}
