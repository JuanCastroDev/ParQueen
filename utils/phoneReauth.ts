import {
  PhoneAuthProvider,
  reauthenticateWithCredential,
  reauthenticateWithPhoneNumber,
  type Auth,
  type User,
} from 'firebase/auth';
import { auth } from '../firebaseConfig';
import {
  clearRecaptchaVerifier,
  replaceRecaptchaVerifier,
  type RecaptchaVerifierRef,
} from './recaptchaLifecycle';
import { nativeStartPhoneVerification, type NativePhoneVerificationResult } from './phoneAuthNative';
import { resolvePhoneAuthPath, type PhoneAuthPath } from './phoneAuthPlatform';

/** Shared confirm() surface for deletion reauth (web ConfirmationResult or native session). */
export interface PhoneReauthSession {
  confirm(verificationCode: string): Promise<unknown>;
}

export class PhoneReauthError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.name = 'PhoneReauthError';
    this.code = code;
  }
}

export interface PhoneReauthDependencies {
  resolvePath?: () => PhoneAuthPath;
  startNative?: (options: { phoneNumber: string; resend?: boolean }) => Promise<NativePhoneVerificationResult>;
  reauthenticateWithPhoneNumber?: typeof reauthenticateWithPhoneNumber;
  reauthenticateWithCredential?: (
    user: User,
    credential: unknown,
  ) => Promise<unknown>;
  credentialFromVerification?: (verificationId: string, code: string) => unknown;
  auth?: Auth;
  replaceVerifier?: typeof replaceRecaptchaVerifier;
  clearVerifier?: typeof clearRecaptchaVerifier;
}

const resolveDeps = (deps: PhoneReauthDependencies = {}) => ({
  resolvePath: deps.resolvePath ?? (() => resolvePhoneAuthPath()),
  startNative: deps.startNative ?? nativeStartPhoneVerification,
  reauthenticateWithPhoneNumber: deps.reauthenticateWithPhoneNumber ?? reauthenticateWithPhoneNumber,
  reauthenticateWithCredential: deps.reauthenticateWithCredential ?? reauthenticateWithCredential,
  credentialFromVerification:
    deps.credentialFromVerification
    ?? ((verificationId: string, code: string) => PhoneAuthProvider.credential(verificationId, code)),
  auth: deps.auth ?? auth,
  replaceVerifier: deps.replaceVerifier ?? replaceRecaptchaVerifier,
  clearVerifier: deps.clearVerifier ?? clearRecaptchaVerifier,
});

type ResolvedPhoneReauthDeps = ReturnType<typeof resolveDeps>;

/** Require a signed-in Firebase user with an Auth phone number (never profile/UI phone). */
export function requireAuthPhoneUser(firebaseAuth: Auth = auth): User {
  const currentUser = firebaseAuth.currentUser;
  if (!currentUser) {
    throw new PhoneReauthError('auth/missing-user', 'No signed-in Firebase user for reauthentication.');
  }
  if (!currentUser.phoneNumber) {
    throw new PhoneReauthError('auth/missing-phone', 'Signed-in user has no Auth phone number.');
  }
  return currentUser;
}

/** Require a live Auth user whose UID still matches the captured deletion-reauth user. */
export function requireLiveAuthUid(firebaseAuth: Auth, expectedUid: string): User {
  const liveUser = firebaseAuth.currentUser;
  if (!liveUser) {
    throw new PhoneReauthError('auth/missing-user', 'No signed-in Firebase user for reauthentication.');
  }
  if (liveUser.uid !== expectedUid) {
    throw new PhoneReauthError('auth/account-switched', 'Auth user changed during reauthentication.');
  }
  return liveUser;
}

const wrapLiveUserConfirm = (
  session: PhoneReauthSession,
  expectedUid: string,
  firebaseAuth: Auth,
): PhoneReauthSession => ({
  confirm: async (code: string) => {
    requireLiveAuthUid(firebaseAuth, expectedUid);
    return session.confirm(code);
  },
});

/**
 * Native deletion reauth session: OTP builds a credential and calls
 * reauthenticateWithCredential on the EXISTING user, never the signup sign-in API.
 */
export const createNativePhoneReauthSession = (
  currentUser: User,
  verificationId: string,
  deps: PhoneReauthDependencies = {},
): PhoneReauthSession => {
  const resolved = resolveDeps(deps);
  return {
    confirm: async (code: string) => {
      const liveUser = requireLiveAuthUid(resolved.auth, currentUser.uid);
      const credential = resolved.credentialFromVerification(verificationId, code);
      return resolved.reauthenticateWithCredential(
        liveUser,
        credential as Parameters<typeof reauthenticateWithCredential>[1],
      );
    },
  };
};

export type StartPhoneReauthenticationOptions = {
  /** Must be auth.currentUser -- phone is read only from user.phoneNumber. */
  currentUser: User;
  recaptchaRef: RecaptchaVerifierRef;
  containerId: string;
  /** When true, native path requests Firebase resend; web replaces verifier. */
  resend?: boolean;
  deps?: PhoneReauthDependencies;
};

const assertReadyForVerification = (
  currentUser: User | null | undefined,
  resolved: ResolvedPhoneReauthDeps,
): string => {
  if (!currentUser) {
    throw new PhoneReauthError('auth/missing-user');
  }
  const phoneNumber = currentUser.phoneNumber;
  if (!phoneNumber) {
    throw new PhoneReauthError('auth/missing-phone');
  }
  requireLiveAuthUid(resolved.auth, currentUser.uid);
  return phoneNumber;
};

/**
 * Start (or resend) phone reauthentication for account deletion.
 * Web/PWA: RecaptchaVerifier + reauthenticateWithPhoneNumber.
 * Android native: nativeStartPhoneVerification -> verificationId session.
 */
export async function startPhoneReauthentication(
  options: StartPhoneReauthenticationOptions,
): Promise<PhoneReauthSession> {
  const { currentUser, recaptchaRef, containerId, resend = false, deps = {} } = options;
  const resolved = resolveDeps(deps);
  const phoneNumber = assertReadyForVerification(currentUser, resolved);

  if (resolved.resolvePath() === 'native') {
    // Never construct RecaptchaVerifier on Android native reauth.
    const { verificationId } = await resolved.startNative({
      phoneNumber,
      ...(resend ? { resend: true } : {}),
    });
    return createNativePhoneReauthSession(currentUser, verificationId, resolved);
  }

  // Always replace verifier (matches prior App.tsx behavior); clear after send so resend is fresh.
  const verifier = resolved.replaceVerifier(recaptchaRef, resolved.auth, containerId);
  try {
    const firebaseSession = await resolved.reauthenticateWithPhoneNumber(currentUser, phoneNumber, verifier);
    return wrapLiveUserConfirm(firebaseSession, currentUser.uid, resolved.auth);
  } finally {
    resolved.clearVerifier(recaptchaRef);
  }
}

export async function resendPhoneReauthentication(
  options: Omit<StartPhoneReauthenticationOptions, 'resend'>,
): Promise<PhoneReauthSession> {
  return startPhoneReauthentication({ ...options, resend: true });
}
