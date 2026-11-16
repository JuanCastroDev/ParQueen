
import { initializeApp, getApps, getApp } from "firebase/app";
import { browserLocalPersistence, setPersistence } from "firebase/auth";
import { auth as parqueenAuth, db as parqueenDb } from "./firebaseConfig";
import { usesCapacitorIosAuthPersistence } from "./utils/authInitialization";
import { DEMO_PROJECT_ID } from "./utils/demoFirebase";

const streetIntelQa = import.meta.env.MODE === 'streetintelqa'
  && import.meta.env.VITE_PARQUEEN_STREET_INTEL_QA === 'app.parqueen.qa';
const demoMode = streetIntelQa
  || (import.meta.env.DEV && import.meta.env.VITE_PARQUEEN_DEMO_FIREBASE === 'local');

const app = (() => {
  try {
    if (typeof window === 'undefined') return null;
    if (getApps().length === 0) {
      if (streetIntelQa || demoMode) throw new Error('Demo Firebase app was not initialized before use.');
      return initializeApp({
        apiKey: "AIzaSyCKSqWVd6JqpcrNUG6hei8Ug1njaIkAI7Y",
        authDomain: "parkqueen-46475363-ccf36.firebaseapp.com",
        projectId: "parkqueen-46475363-ccf36",
        storageBucket: "parkqueen-46475363-ccf36.firebasestorage.app",
        messagingSenderId: "768131391875",
        appId: "1:768131391875:web:613c5d2a948862333196b6"
      });
    }
    const existing = getApp();
    if (demoMode && existing.options.projectId !== DEMO_PROJECT_ID) {
      throw new Error('Refusing production Firebase during demo mode.');
    }
    return existing;
  } catch (error) {
    if (demoMode) throw error;
    console.warn("Firebase App initialization failed.");
    return null;
  }
})();

export const db = app ? parqueenDb : null;

// Auth is created once in firebaseConfig. This module only retrieves that
// instance. Web/PWA/Android still apply the existing local persistence call.
// Capacitor iOS already selected browserLocalPersistence at initialization
// and must not open another persistence implementation here.
export const auth = app ? parqueenAuth : null;
if (auth && !usesCapacitorIosAuthPersistence()) {
  setPersistence(auth, browserLocalPersistence)
    .then(() => {
      // Existing and future Auth states are persisted in the browser's local storage.
      console.log("Firebase Auth persistence set to local storage.");
    })
    .catch((error) => {
      console.error("Auth persistence failed", error);
    });
}
