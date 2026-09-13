import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createNativePhoneSession,
  preparePhoneAuth,
  resendPhoneVerification,
  startPhoneVerification,
} from './phoneAuth';
import type { RecaptchaVerifierRef } from './recaptchaLifecycle';

const replaceVerifier = vi.fn((ref: RecaptchaVerifierRef, _auth: unknown, _id: string) => {
  const verifier = { clear: vi.fn() };
  ref.current = verifier as never;
  return verifier;
});
const signInWithPhoneNumber = vi.fn();
const signInWithCredential = vi.fn();
const credentialFromVerification = vi.fn((verificationId: string, code: string) => ({ verificationId, code }));
const startNative = vi.fn();
const auth = { name: 'js-auth' } as never;

const webDeps = {
  resolvePath: () => 'web' as const,
  replaceVerifier,
  signInWithPhoneNumber,
  signInWithCredential,
  credentialFromVerification,
  startNative,
  auth,
};

const nativeDeps = {
  ...webDeps,
  resolvePath: () => 'native' as const,
};

describe('preparePhoneAuth', () => {
  beforeEach(() => vi.clearAllMocks());

  it('mounts the invisible RecaptchaVerifier on the web path', () => {
    const ref: RecaptchaVerifierRef = { current: null };
    const cleanup = preparePhoneAuth(ref, 'recaptcha-container', webDeps);
    expect(replaceVerifier).toHaveBeenCalledWith(ref, auth, 'recaptcha-container');
    cleanup();
    expect(ref.current).toBeNull();
  });

  it('does not construct a RecaptchaVerifier on the Android native path', () => {
    const ref: RecaptchaVerifierRef = { current: null };
    const cleanup = preparePhoneAuth(ref, 'recaptcha-container', nativeDeps);
    expect(replaceVerifier).not.toHaveBeenCalled();
    cleanup();
    expect(ref.current).toBeNull();
  });
});

describe('startPhoneVerification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signInWithPhoneNumber.mockResolvedValue({ confirm: vi.fn() });
    startNative.mockResolvedValue({ verificationId: 'native-vid-1' });
  });

  it('uses RecaptchaVerifier + signInWithPhoneNumber on web', async () => {
    const ref: RecaptchaVerifierRef = { current: null };
    await startPhoneVerification('+15555550100', ref, 'recaptcha-container', webDeps);
    expect(startNative).not.toHaveBeenCalled();
    expect(signInWithPhoneNumber).toHaveBeenCalledWith(auth, '+15555550100', expect.anything());
  });

  it('starts native verification and stores verificationId for OTP confirmation', async () => {
    const ref: RecaptchaVerifierRef = { current: null };
    const session = await startPhoneVerification('+15555550100', ref, 'recaptcha-container', nativeDeps);
    expect(startNative).toHaveBeenCalledWith({ phoneNumber: '+15555550100' });
    expect(signInWithPhoneNumber).not.toHaveBeenCalled();

    signInWithCredential.mockResolvedValue({ user: { uid: 'uid-1' } });
    await session.confirm('123456');
    expect(credentialFromVerification).toHaveBeenCalledWith('native-vid-1', '123456');
    expect(signInWithCredential).toHaveBeenCalledWith(auth, { verificationId: 'native-vid-1', code: '123456' });
  });
});

describe('createNativePhoneSession', () => {
  it('signs the existing Firebase JS Auth instance in with verificationId + OTP', async () => {
    signInWithCredential.mockResolvedValue({ user: { uid: 'uid-js' } });
    const session = createNativePhoneSession('stored-vid', nativeDeps);
    const result = await session.confirm('654321');
    expect(credentialFromVerification).toHaveBeenCalledWith('stored-vid', '654321');
    expect(signInWithCredential).toHaveBeenCalledWith(auth, { verificationId: 'stored-vid', code: '654321' });
    expect(result).toEqual({ user: { uid: 'uid-js' } });
  });
});

describe('resendPhoneVerification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    signInWithPhoneNumber.mockResolvedValue({ confirm: vi.fn() });
    startNative.mockResolvedValue({ verificationId: 'native-vid-2' });
  });

  it('resends through signInWithPhoneNumber on web', async () => {
    const ref: RecaptchaVerifierRef = { current: null };
    await resendPhoneVerification('+15555550100', ref, 'recaptcha-resend', webDeps);
    expect(replaceVerifier).toHaveBeenCalledWith(ref, auth, 'recaptcha-resend');
    expect(signInWithPhoneNumber).toHaveBeenCalledWith(auth, '+15555550100', expect.anything());
    expect(startNative).not.toHaveBeenCalled();
  });

  it('resends through the native Android bridge', async () => {
    const ref: RecaptchaVerifierRef = { current: null };
    await resendPhoneVerification('+15555550100', ref, 'recaptcha-resend', nativeDeps);
    expect(startNative).toHaveBeenCalledWith({ phoneNumber: '+15555550100', resend: true });
    expect(signInWithPhoneNumber).not.toHaveBeenCalled();
  });
});
