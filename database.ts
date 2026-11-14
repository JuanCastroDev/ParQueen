import { auth, db } from './firebaseConfig';
import { signOut, sendPasswordResetEmail as _sendPasswordResetEmail } from 'firebase/auth';
import { doc, updateDoc, deleteField } from "firebase/firestore";
import { getFunctions, httpsCallable } from 'firebase/functions';
import { ONBOARDING_V2_ENABLED } from './utils/onboardingFlags';

// Account creation (username + base doc) and display-name changes are now
// authoritative-server-owned via the claimUsername/updateDisplayName
// callables (App.tsx) — see docs/PROFILE_IDENTITY_HARDENING.md. The former
// saveUserProfile() client-side create/update path has been retired.

export const logoutUser = async () => {
  // Preserve device-level preferences; clear all account-scoped browser state.
  // Capture fcm owner marker before clear: if Firestore cleanup fails (offline),
  // we restore it so the next sign-in by a different user detects the ownership
  // transition and rotates the browser registration before associating it.
  const theme = localStorage.getItem('theme');
  const fcmOwnerUid = localStorage.getItem('parqueen_fcm_owner_uid');
  // Onboarding 2.0 (Blueprint D13/D14): a signed-out device keeps its language and skips the story.
  // The pending onboarding intention is account-scoped and is cleared with everything else.
  const lang = ONBOARDING_V2_ENABLED ? localStorage.getItem('parqueen_lang') : null;
  const seenOnboarding = ONBOARDING_V2_ENABLED ? localStorage.getItem('hasSeenOnboarding') : null;
  localStorage.clear();
  if (theme !== null) localStorage.setItem('theme', theme);
  if (lang !== null) localStorage.setItem('parqueen_lang', lang);
  if (seenOnboarding !== null) localStorage.setItem('hasSeenOnboarding', seenOnboarding);

  const uid = auth.currentUser?.uid;
  if (uid) {
    const cleaned = await updateDoc(
      doc(db, 'users', uid, 'private', 'preferences'),
      { fcmToken: deleteField() }
    ).then(() => true).catch(() => false); // best-effort: offline must never block logout

    if (!cleaned && fcmOwnerUid !== null) {
      // Cleanup failed — restore marker so account-switch detection still works.
      localStorage.setItem('parqueen_fcm_owner_uid', fcmOwnerUid);
    }
  }

  await signOut(auth);
};

export const updateUser = async (userId: string, data: Record<string, any>) => {
  await updateDoc(doc(db, 'users', userId), data);
};

export const sendPasswordResetEmail = (email: string) =>
  _sendPasswordResetEmail(auth, email);

// Best-effort FCM token removal from private/preferences before account deletion.
// Called while Auth is still valid. Covers the gap in the pre-recursiveDelete server
// implementation where private/preferences was not included in the batch delete.
// Errors are swallowed — deletion must not be blocked by a failed token unlink.
export const unlinkFcmTokenBeforeDeletion = async (): Promise<void> => {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  await updateDoc(
    doc(db, 'users', uid, 'private', 'preferences'),
    { fcmToken: deleteField() }
  ).catch(() => {});
};

export const deleteUser = async () => {
  if (!auth.currentUser) throw new Error("No user is currently signed in.");
  const fn = httpsCallable(getFunctions(undefined, 'us-central1'), 'deleteAccount');
  await fn();
  await signOut(auth);
};
