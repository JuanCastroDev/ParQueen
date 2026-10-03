import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createNativePhoneSession,
  preparePhoneAuth,
  resendPhoneVerification,
  startPhoneVerification,
  type PhoneAuthDependencies,
} from './phoneAuth';
import {
  IOS_PHONE_AUTH_ERROR_CODES,
  iosPhoneAuthUiTone,
  reportIosPhoneAuthFailure,
} from './phoneAuthNative';
import { resolvePhoneAuthPath } from './phoneAuthPlatform';
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
} as PhoneAuthDependencies;

const nativeDeps = {
  ...webDeps,
  resolvePath: () => 'native' as const,
} as PhoneAuthDependencies;

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

describe('Capacitor iOS phone auth', () => {
  const iosDeps = {
    ...nativeDeps,
    resolvePath: () => resolvePhoneAuthPath({ isNative: true, platform: 'ios' }),
  } as PhoneAuthDependencies;

  beforeEach(() => {
    vi.clearAllMocks();
    startNative.mockResolvedValue({ verificationId: 'ios-vid-1' });
    signInWithCredential.mockResolvedValue({ user: { uid: 'uid-ios' } });
  });

  it('does not create RecaptchaVerifier while preparing', () => {
    const ref: RecaptchaVerifierRef = { current: null };
    preparePhoneAuth(ref, 'recaptcha-container', iosDeps);
    expect(replaceVerifier).not.toHaveBeenCalled();
  });

  it('sends through the native PhoneAuth bridge', async () => {
    const ref: RecaptchaVerifierRef = { current: null };
    await startPhoneVerification('+15555550100', ref, 'recaptcha-container', iosDeps);
    expect(startNative).toHaveBeenCalledWith({ phoneNumber: '+15555550100' });
    expect(signInWithPhoneNumber).not.toHaveBeenCalled();
    expect(replaceVerifier).not.toHaveBeenCalled();
  });

  it('resends through the native PhoneAuth bridge', async () => {
    const ref: RecaptchaVerifierRef = { current: null };
    await resendPhoneVerification('+15555550100', ref, 'recaptcha-resend', iosDeps);
    expect(startNative).toHaveBeenCalledWith({ phoneNumber: '+15555550100', resend: true });
    expect(signInWithPhoneNumber).not.toHaveBeenCalled();
  });

  it('confirms with the JS credential on the existing auth instance', async () => {
    const ref: RecaptchaVerifierRef = { current: null };
    const session = await startPhoneVerification('+15555550100', ref, 'recaptcha-container', iosDeps);
    await session.confirm('123456');
    expect(credentialFromVerification).toHaveBeenCalledWith('ios-vid-1', '123456');
    expect(signInWithCredential).toHaveBeenCalledWith(auth, { verificationId: 'ios-vid-1', code: '123456' });
  });
});

describe('iOS native phone auth errors', () => {
  it('maps the closed code set onto invalid, throttle, or generic UI', () => {
    expect(iosPhoneAuthUiTone({ code: 'ios_phone_auth_invalid_number' })).toBe('invalid_number');
    expect(iosPhoneAuthUiTone({ code: 'ios_phone_auth_too_many_requests' })).toBe('too_many_requests');
    for (const code of IOS_PHONE_AUTH_ERROR_CODES) {
      if (code === 'ios_phone_auth_invalid_number' || code === 'ios_phone_auth_too_many_requests') continue;
      expect(iosPhoneAuthUiTone({ code })).toBe('generic');
    }
    expect(iosPhoneAuthUiTone({ code: 'auth/invalid-phone-number' })).toBeNull();
    expect(iosPhoneAuthUiTone({ message: 'ios_phone_auth_network' })).toBeNull();
  });

  it('reports a synthetic error and does not attach provider text', () => {
    const capture = vi.fn();
    reportIosPhoneAuthFailure(
      { code: 'ios_phone_auth_network', message: 'provider said +15551212 and a verification id' },
      'signup_send_code',
      capture,
    );
    expect(capture).toHaveBeenCalledTimes(1);
    const [error, context] = capture.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe('ios_phone_auth_send_failed');
    expect(context).toEqual({
      route: 'signup_send_code',
      component: 'phoneAuth',
      platform: 'ios',
      errorCode: 'ios_phone_auth_network',
    });
    expect(JSON.stringify(capture.mock.calls)).not.toContain('+15551212');
    expect(JSON.stringify(capture.mock.calls)).not.toContain('provider said');
  });

  it('does not report codes outside the closed set', () => {
    const capture = vi.fn();
    reportIosPhoneAuthFailure(
      { code: 'auth/invalid-phone-number', message: 'raw firebase text' },
      'signup_send_code',
      capture,
    );
    expect(capture).not.toHaveBeenCalled();
  });
});
