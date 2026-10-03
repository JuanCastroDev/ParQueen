import {
  PhoneAuthProvider,
  reauthenticateWithCredential,
  reauthenticateWithPhoneNumber,
  signInWithCustomToken,
  signOut,
  type Auth,
  type User,
  type UserCredential,
} from 'firebase/auth';
import { auth } from '../firebaseConfig';
import {
  clearRecaptchaVerifier,
  replaceRecaptchaVerifier,
  type RecaptchaVerifierRef,
} from './recaptchaLifecycle';
import {
  iosConfirmPhoneVerification,
  iosStartPhoneVerification,
  IosPhoneAuthError,
  normalizeIosPhoneAuthBridgeError,
  nativeStartPhoneVerification,
  type AndroidPhoneVerificationResult,
  type IosPhoneConfirmRequest,
  type IosPhoneConfirmResult,
  type IosPhoneVerificationResult,
} from './phoneAuthNative';
import { resolvePhoneAuthPath, type PhoneAuthPath } from './phoneAuthPlatform';

/** deleteAccount rejects sessions whose auth_time is older than 10 minutes. */
export const DELETE_ACCOUNT_AUTH_MAX_AGE_SEC = 600;

export function isAuthTimeRecent(
  authTimeSeconds: number,
  nowSeconds: number = Date.now() / 1000,
  maxAgeSec: number = DELETE_ACCOUNT_AUTH_MAX_AGE_SEC,
): boolean {
  return Number.isFinite(authTimeSeconds)
    && Number.isFinite(nowSeconds)
    && nowSeconds >= authTimeSeconds
    && nowSeconds - authTimeSeconds <= maxAgeSec;
}

export function readAuthTimeSeconds(tokenResult: {
  authTime?: string;
  claims?: { auth_time?: unknown };
}): number | null {
  const claim = tokenResult.claims?.auth_time;
  if (typeof claim === 'number' && Number.isFinite(claim)) return claim;
  if (typeof tokenResult.authTime === 'string') {
    const parsed = Date.parse(tokenResult.authTime);
    if (Number.isFinite(parsed)) return parsed / 1000;
  }
  return null;
}

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
  startNative?: (options: { phoneNumber: string; resend?: boolean }) => Promise<AndroidPhoneVerificationResult>;
  startIos?: (options: { phoneNumber: string; resend?: boolean }) => Promise<IosPhoneVerificationResult>;
  confirmIos?: (options: IosPhoneConfirmRequest) => Promise<IosPhoneConfirmResult>;
  signInWithCustomToken?: (firebaseAuth: Auth, customToken: string) => Promise<UserCredential>;
  signOut?: (firebaseAuth: Auth) => Promise<void>;
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
  startIos: deps.startIos ?? iosStartPhoneVerification,
  confirmIos: deps.confirmIos ?? iosConfirmPhoneVerification,
  signInWithCustomToken: deps.signInWithCustomToken ?? ((firebaseAuth, customToken) => (
    signInWithCustomToken(firebaseAuth, customToken)
  )),
  signOut: deps.signOut ?? ((firebaseAuth) => signOut(firebaseAuth)),
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

/**
 * iOS deletion reauth: native phone sign-in must match the current UID, then
 * signInWithCustomToken refreshes that same user on the existing JS Auth instance.
 */
export const createIosPhoneReauthSession = (
  currentUser: User,
  sessionId: string,
  deps: PhoneReauthDependencies = {},
): PhoneReauthSession => {
  const resolved = resolveDeps(deps);
  return {
    confirm: async (code: string) => {
      const liveUser = requireLiveAuthUid(resolved.auth, currentUser.uid);
      const nativeResult = await resolved.confirmIos({
        sessionId,
        code,
        expectedUid: liveUser.uid,
      });
      if (nativeResult.uid !== liveUser.uid) {
        await resolved.signOut(resolved.auth);
        throw new IosPhoneAuthError('ios_phone_auth_uid_mismatch');
      }
      let customToken: string | null = nativeResult.customToken;
      try {
        const token = customToken;
        if (!token) throw new IosPhoneAuthError('ios_phone_auth_bridge_failed');
        let result;
        try {
          result = await resolved.signInWithCustomToken(resolved.auth, token);
        } catch (error) {
          throw normalizeIosPhoneAuthBridgeError(error);
        }
        if (result.user.uid !== liveUser.uid) {
          await resolved.signOut(resolved.auth);
          throw new IosPhoneAuthError('ios_phone_auth_uid_mismatch');
        }
        let tokenResult;
        try {
          tokenResult = await result.user.getIdTokenResult(true);
        } catch (error) {
          throw normalizeIosPhoneAuthBridgeError(error);
        }
        const authTime = readAuthTimeSeconds(tokenResult);
        if (authTime === null || !isAuthTimeRecent(authTime)) {
          throw new IosPhoneAuthError('ios_phone_auth_bridge_failed');
        }
        return result;
      } finally {
        customToken = null;
      }
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
 * Android: native verificationId + reauthenticateWithCredential.
 * iOS: native confirm + custom token on the existing JS Auth user.
 */
export async function startPhoneReauthentication(
  options: StartPhoneReauthenticationOptions,
): Promise<PhoneReauthSession> {
  const { currentUser, recaptchaRef, containerId, resend = false, deps = {} } = options;
  const resolved = resolveDeps(deps);
  const phoneNumber = assertReadyForVerification(currentUser, resolved);

  if (resolved.resolvePath() === 'native-ios') {
    const { sessionId } = await resolved.startIos({
      phoneNumber,
      ...(resend ? { resend: true } : {}),
    });
    return createIosPhoneReauthSession(currentUser, sessionId, resolved);
  }

  if (resolved.resolvePath() === 'native-android') {
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
