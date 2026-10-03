import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getMessaging, isSupported } from 'firebase/messaging';
import { initializeParQueenAppCheck } from './utils/appCheck';
import { initializeParQueenAuth } from './utils/authInitialization';
import { resolveFirebaseApiKey } from './utils/firebaseApiKey';

const firebaseConfig = {
  apiKey: "AIzaSyCKSqWVd6JqpcrNUG6hei8Ug1njaIkAI7Y",
  authDomain: "parkqueen-46475363-ccf36.firebaseapp.com",
  projectId: "parkqueen-46475363-ccf36",
  storageBucket: "parkqueen-46475363-ccf36.firebasestorage.app",
  messagingSenderId: "768131391875",
  appId: "1:768131391875:web:613c5d2a948862333196b6"
};

firebaseConfig.apiKey = resolveFirebaseApiKey(firebaseConfig.apiKey);

// ── App Check debug token (DEV only) ─────────────────────────────────────────
// import.meta.env.DEV → false in production builds (Vite static replacement);
// this entire block is dead code that Rollup tree-shakes from prod bundles.
// Set VITE_APPCHECK_DEBUG_TOKEN in .env.local; obtain the token from
// Firebase Console → App Check → Apps → overflow menu → Manage debug tokens.
if (import.meta.env.DEV) {
  const debugToken = import.meta.env.VITE_APPCHECK_DEBUG_TOKEN;
  if (debugToken) {
    (self as any).FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken;
  }
}

// Initialize Firebase — single app instance shared by all service exports.
// getApps() guard makes this idempotent: if firebase.ts evaluates first (e.g., in
// a test or future refactor), App Check and service exports still attach to the
// same [DEFAULT] app rather than throwing app/duplicate-app.
const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();

// Initialization order for the default app:
// 1. initializeApp / getApp
// 2. initializeParQueenAppCheck — synchronous from this caller's perspective.
//    It registers the existing provider and returns without awaiting a token,
//    so it does not block Auth construction. Capacitor iOS stays on the web
//    ReCaptchaEnterpriseProvider path. Native App Attest / DeviceCheck is a
//    follow-up and is not part of this startup repair.
// 3. initializeParQueenAuth — the only Auth initialization. Capacitor iOS uses
//    initializeAuth with browserLocalPersistence and no popup/redirect resolver.
//    Web, PWA, and Capacitor Android keep getAuth().
initializeParQueenAppCheck(app);

export const auth = initializeParQueenAuth(app);
export const db = getFirestore(app);

export const getFCM = async () => {
    const supported = await isSupported();
    return supported ? getMessaging(app) : null;
};
