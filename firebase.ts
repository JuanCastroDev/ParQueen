
import { initializeApp, getApps, getApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";
import { browserLocalPersistence, setPersistence } from "firebase/auth";
import { auth as parqueenAuth } from "./firebaseConfig";
import { usesCapacitorIosAuthPersistence } from "./utils/authInitialization";

const firebaseConfig = {
  apiKey: "AIzaSyCKSqWVd6JqpcrNUG6hei8Ug1njaIkAI7Y",
  authDomain: "parkqueen-46475363-ccf36.firebaseapp.com",
  projectId: "parkqueen-46475363-ccf36",
  storageBucket: "parkqueen-46475363-ccf36.firebasestorage.app",
  messagingSenderId: "768131391875",
  appId: "1:768131391875:web:613c5d2a948862333196b6"
};

const app = (() => {
  try {
    if (typeof window === 'undefined') return null;
    return getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
  } catch (error) {
    console.warn("Firebase App initialization failed.");
    return null;
  }
})();

export const db = app ? getFirestore(app) : null;

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
