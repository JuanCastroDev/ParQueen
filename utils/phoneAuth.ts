import {
  PhoneAuthProvider,
  signInWithCredential,
  signInWithCustomToken,
  signInWithPhoneNumber,
  signOut,
  type Auth,
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
  type IosPhoneConfirmRequest,
  type IosPhoneConfirmResult,
  type IosPhoneVerificationResult,
  type AndroidPhoneVerificationResult,
} from './phoneAuthNative';
import { resolvePhoneAuthPath, type PhoneAuthPath } from './phoneAuthPlatform';

/** Shared confirm() surface used by signup OTP and Firebase ConfirmationResult. */
export interface PhoneVerificationSession {
  confirm(verificationCode: string): Promise<unknown>;
}

export interface PhoneAuthDependencies {
  resolvePath?: () => PhoneAuthPath;
  startNative?: (options: { phoneNumber: string; resend?: boolean }) => Promise<AndroidPhoneVerificationResult>;
  startIos?: (options: { phoneNumber: string; resend?: boolean }) => Promise<IosPhoneVerificationResult>;
  confirmIos?: (options: IosPhoneConfirmRequest) => Promise<IosPhoneConfirmResult>;
  signInWithPhoneNumber?: typeof signInWithPhoneNumber;
  signInWithCredential?: (firebaseAuth: Auth, credential: unknown) => Promise<unknown>;
  signInWithCustomToken?: (firebaseAuth: Auth, customToken: string) => Promise<UserCredential>;
  signOut?: (firebaseAuth: Auth) => Promise<void>;
  credentialFromVerification?: (verificationId: string, code: string) => unknown;
  auth?: Auth;
  replaceVerifier?: typeof replaceRecaptchaVerifier;
}

const resolveDeps = (deps: PhoneAuthDependencies = {}) => ({
  resolvePath: deps.resolvePath ?? (() => resolvePhoneAuthPath()),
  startNative: deps.startNative ?? nativeStartPhoneVerification,
  startIos: deps.startIos ?? iosStartPhoneVerification,
  confirmIos: deps.confirmIos ?? iosConfirmPhoneVerification,
  signInWithPhoneNumber: deps.signInWithPhoneNumber ?? signInWithPhoneNumber,
  signInWithCredential: deps.signInWithCredential ?? signInWithCredential,
  signInWithCustomToken: deps.signInWithCustomToken ?? ((firebaseAuth, customToken) => (
    signInWithCustomToken(firebaseAuth, customToken)
  )),
  signOut: deps.signOut ?? ((firebaseAuth) => signOut(firebaseAuth)),
  credentialFromVerification:
    deps.credentialFromVerification ?? ((verificationId: string, code: string) => (
      PhoneAuthProvider.credential(verificationId, code)
    )),
  auth: deps.auth ?? auth,
  replaceVerifier: deps.replaceVerifier ?? replaceRecaptchaVerifier,
});

export const preparePhoneAuth = (
  recaptchaRef: RecaptchaVerifierRef,
  containerId: string,
  deps: PhoneAuthDependencies = {},
): (() => void) => {
  const resolved = resolveDeps(deps);
  if (resolved.resolvePath() !== 'web') {
    return () => {};
  }
  resolved.replaceVerifier(recaptchaRef, resolved.auth, containerId);
  return () => clearRecaptchaVerifier(recaptchaRef);
};

export const createNativePhoneSession = (
  verificationId: string,
  deps: PhoneAuthDependencies = {},
): PhoneVerificationSession => {
  const resolved = resolveDeps(deps);
  return {
    confirm: (code: string) => resolved.signInWithCredential(
      resolved.auth,
      resolved.credentialFromVerification(verificationId, code) as Parameters<typeof signInWithCredential>[1],
    ),
  };
};

export const createIosPhoneSession = (
  sessionId: string,
  deps: PhoneAuthDependencies = {},
): PhoneVerificationSession => {
  const resolved = resolveDeps(deps);
  return {
    confirm: async (code: string) => {
      const nativeResult = await resolved.confirmIos({ sessionId, code });
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
        if (result.user.uid !== nativeResult.uid) {
          await resolved.signOut(resolved.auth);
          throw new IosPhoneAuthError('ios_phone_auth_uid_mismatch');
        }
        return result;
      } finally {
        customToken = null;
      }
    },
  };
};

export const startPhoneVerification = async (
  phoneE164: string,
  recaptchaRef: RecaptchaVerifierRef,
  containerId: string,
  deps: PhoneAuthDependencies = {},
): Promise<PhoneVerificationSession> => {
  const resolved = resolveDeps(deps);
  const path = resolved.resolvePath();
  if (path === 'native-ios') {
    const { sessionId } = await resolved.startIos({ phoneNumber: phoneE164 });
    return createIosPhoneSession(sessionId, resolved);
  }
  if (path === 'native-android') {
    const { verificationId } = await resolved.startNative({ phoneNumber: phoneE164 });
    return createNativePhoneSession(verificationId, resolved);
  }
  const verifier = recaptchaRef.current
    ?? resolved.replaceVerifier(recaptchaRef, resolved.auth, containerId);
  return resolved.signInWithPhoneNumber(resolved.auth, phoneE164, verifier);
};

export const resendPhoneVerification = async (
  phoneE164: string,
  recaptchaRef: RecaptchaVerifierRef,
  containerId: string,
  deps: PhoneAuthDependencies = {},
): Promise<PhoneVerificationSession> => {
  const resolved = resolveDeps(deps);
  const path = resolved.resolvePath();
  if (path === 'native-ios') {
    const { sessionId } = await resolved.startIos({ phoneNumber: phoneE164, resend: true });
    return createIosPhoneSession(sessionId, resolved);
  }
  if (path === 'native-android') {
    const { verificationId } = await resolved.startNative({ phoneNumber: phoneE164, resend: true });
    return createNativePhoneSession(verificationId, resolved);
  }
  const verifier = resolved.replaceVerifier(recaptchaRef, resolved.auth, containerId);
  return resolved.signInWithPhoneNumber(resolved.auth, phoneE164, verifier);
};
