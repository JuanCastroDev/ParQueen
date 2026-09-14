import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getMessaging, isSupported } from 'firebase/messaging';
import { initializeParQueenAppCheck } from './utils/appCheck';

const firebaseConfig = {
  apiKey: "AIzaSyCKSqWVd6JqpcrNUG6hei8Ug1njaIkAI7Y",
  authDomain: "parkqueen-46475363-ccf36.firebaseapp.com",
  projectId: "parkqueen-46475363-ccf36",
  storageBucket: "parkqueen-46475363-ccf36.firebasestorage.app",
  messagingSenderId: "768131391875",
  appId: "1:768131391875:web:613c5d2a948862333196b6"
};

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

// ── App Check (TM-12 / Phase 2E) ─────────────────────────────────────────────
// Exactly one initializeAppCheck, split by platform in utils/appCheck.ts:
//   Capacitor Android → CustomProvider wrapping the native Play Integrity /
//     Debug bridge. Not gated on the reCAPTCHA site key. Never falls back
//     to WebView reCAPTCHA.
//   Web/PWA (and Capacitor iOS, out of scope) → existing
//     ReCaptchaEnterpriseProvider, still gated on VITE_FIREBASE_APPCHECK_SITE_KEY.
// isTokenAutoRefreshEnabled remains true on both paths.
// Required before any protected Firebase service call so App Check tokens
// are available when Auth/Firestore/Functions requests are issued.
//
// Enforcement of Cloud Functions is independent of this client init — see
// docs/APP_CHECK_ROLLOUT.md. This phase does not change enforceAppCheck.
initializeParQueenAppCheck(app);

export const auth = getAuth(app);
export const db = getFirestore(app);

export const getFCM = async () => {
    const supported = await isSupported();
    return supported ? getMessaging(app) : null;
};
