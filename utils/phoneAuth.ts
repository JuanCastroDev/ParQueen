import {
  PhoneAuthProvider,
  signInWithCredential,
  signInWithPhoneNumber,
  type Auth,
} from 'firebase/auth';
import { auth } from '../firebaseConfig';
import {
  clearRecaptchaVerifier,
  replaceRecaptchaVerifier,
  type RecaptchaVerifierRef,
} from './recaptchaLifecycle';
import { nativeStartPhoneVerification, type NativePhoneVerificationResult } from './phoneAuthNative';
import { resolvePhoneAuthPath, type PhoneAuthPath } from './phoneAuthPlatform';

/** Shared confirm() surface used by signup OTP and Firebase ConfirmationResult. */
export interface PhoneVerificationSession {
  confirm(verificationCode: string): Promise<unknown>;
}

export interface PhoneAuthDependencies {
  resolvePath?: () => PhoneAuthPath;
  startNative?: (options: { phoneNumber: string; resend?: boolean }) => Promise<NativePhoneVerificationResult>;
  signInWithPhoneNumber?: typeof signInWithPhoneNumber;
  signInWithCredential?: (firebaseAuth: Auth, credential: unknown) => Promise<unknown>;
  credentialFromVerification?: (verificationId: string, code: string) => unknown;
  auth?: Auth;
  replaceVerifier?: typeof replaceRecaptchaVerifier;
}

const resolveDeps = (deps: PhoneAuthDependencies = {}) => ({
  resolvePath: deps.resolvePath ?? (() => resolvePhoneAuthPath()),
  startNative: deps.startNative ?? nativeStartPhoneVerification,
  signInWithPhoneNumber: deps.signInWithPhoneNumber ?? signInWithPhoneNumber,
  signInWithCredential: deps.signInWithCredential ?? signInWithCredential,
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
  if (resolved.resolvePath() === 'native') {
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

export const startPhoneVerification = async (
  phoneE164: string,
  recaptchaRef: RecaptchaVerifierRef,
  containerId: string,
  deps: PhoneAuthDependencies = {},
): Promise<PhoneVerificationSession> => {
  const resolved = resolveDeps(deps);
  if (resolved.resolvePath() === 'native') {
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
  if (resolved.resolvePath() === 'native') {
    const { verificationId } = await resolved.startNative({ phoneNumber: phoneE164, resend: true });
    return createNativePhoneSession(verificationId, resolved);
  }
  const verifier = resolved.replaceVerifier(recaptchaRef, resolved.auth, containerId);
  return resolved.signInWithPhoneNumber(resolved.auth, phoneE164, verifier);
};
