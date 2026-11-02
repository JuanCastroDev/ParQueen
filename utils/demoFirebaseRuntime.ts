import { connectAuthEmulator, type Auth } from 'firebase/auth';
import { connectFirestoreEmulator, type Firestore } from 'firebase/firestore';
import { connectFunctionsEmulator, getFunctions, type Functions } from 'firebase/functions';
import type { FirebaseApp } from 'firebase/app';
import {
  assertDemoEndpoints,
  DEMO_EMULATORS,
  DEMO_PROJECT_ID,
  PRODUCTION_APP_ID,
  PRODUCTION_PROJECT_ID,
} from './demoFirebase';

function functionsOrigin(functions: Functions): string | null {
  const service = functions as Functions & {
    emulatorOrigin?: string | null;
    _delegate?: { emulatorOrigin?: string | null };
  };
  return service.emulatorOrigin ?? service._delegate?.emulatorOrigin ?? null;
}

function firestoreHost(db: Firestore): string | null {
  const service = db as Firestore & {
    _settings?: { host?: string };
    _delegate?: { _settings?: { host?: string } };
  };
  return service._delegate?._settings?.host ?? service._settings?.host ?? null;
}

export function bindDemoEmulators(input: { app: FirebaseApp; auth: Auth; db: Firestore }): Functions {
  assertDemoEndpoints();
  const projectId = input.app.options.projectId ?? '';
  const productionProject: string = PRODUCTION_PROJECT_ID;
  if (projectId !== DEMO_PROJECT_ID || projectId === productionProject) {
    throw new Error('Refusing to attach local emulators to a non-demo Firebase app.');
  }
  if (input.app.options.appId === PRODUCTION_APP_ID) {
    throw new Error('Refusing to attach local emulators to the production Firebase app.');
  }

  const { auth, functions, firestore } = DEMO_EMULATORS;
  connectAuthEmulator(input.auth, `http://${auth.host}:${auth.port}`, { disableWarnings: true });
  connectFirestoreEmulator(input.db, firestore.host, firestore.port);
  const functionsService = getFunctions(input.app, 'us-central1');
  connectFunctionsEmulator(functionsService, functions.host, functions.port);

  const authConfig = input.auth.emulatorConfig;
  if (!authConfig || authConfig.protocol !== 'http' || authConfig.host !== auth.host || authConfig.port !== auth.port) {
    throw new Error('Auth is not connected to the local emulator.');
  }
  if (firestoreHost(input.db) !== `${firestore.host}:${firestore.port}`) {
    throw new Error('Firestore is not connected to the local emulator.');
  }
  const sameFunctions = getFunctions(input.app, 'us-central1');
  if (sameFunctions !== functionsService || functionsOrigin(sameFunctions) !== `http://${functions.host}:${functions.port}`) {
    throw new Error('Functions us-central1 is not connected to the local emulator.');
  }
  return sameFunctions;
}
