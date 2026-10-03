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
  reportIosPhoneAuthConfirmFailure,
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
const signInWithCustomToken = vi.fn();
const signOut = vi.fn();
const credentialFromVerification = vi.fn((verificationId: string, code: string) => ({ verificationId, code }));
const startNative = vi.fn();
const startIos = vi.fn();
const confirmIos = vi.fn();
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
  resolvePath: () => 'native-android' as const,
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
    ...webDeps,
    resolvePath: () => resolvePhoneAuthPath({ isNative: true, platform: 'ios' }),
    startIos,
    confirmIos,
    signInWithCustomToken,
    signOut,
  } as PhoneAuthDependencies;

  beforeEach(() => {
    vi.clearAllMocks();
    startIos.mockResolvedValue({ sessionId: 'opaque-session-1' });
    confirmIos.mockResolvedValue({ customToken: 'custom-token-1', uid: 'uid-ios' });
    signInWithCustomToken.mockResolvedValue({ user: { uid: 'uid-ios' } });
    signOut.mockResolvedValue(undefined);
  });

  it('does not create RecaptchaVerifier while preparing', () => {
    const ref: RecaptchaVerifierRef = { current: null };
    preparePhoneAuth(ref, 'recaptcha-container', iosDeps);
    expect(replaceVerifier).not.toHaveBeenCalled();
  });

  it('one send invokes exactly one native start and returns an opaque session', async () => {
    const ref: RecaptchaVerifierRef = { current: null };
    const session = await startPhoneVerification('+15555550100', ref, 'recaptcha-container', iosDeps);
    expect(startIos).toHaveBeenCalledTimes(1);
    expect(startIos).toHaveBeenCalledWith({ phoneNumber: '+15555550100' });
    expect(startNative).not.toHaveBeenCalled();
    expect(signInWithPhoneNumber).not.toHaveBeenCalled();
    expect(replaceVerifier).not.toHaveBeenCalled();
    expect(session).toBeTruthy();
  });

  it('resend asks native iOS for a new session', async () => {
    const ref: RecaptchaVerifierRef = { current: null };
    await resendPhoneVerification('+15555550100', ref, 'recaptcha-resend', iosDeps);
    expect(startIos).toHaveBeenCalledTimes(1);
    expect(startIos).toHaveBeenCalledWith({ phoneNumber: '+15555550100', resend: true });
  });

  it('confirms through native confirmVerification and the existing JS Auth custom token', async () => {
    const ref: RecaptchaVerifierRef = { current: null };
    const session = await startPhoneVerification('+15555550100', ref, 'recaptcha-container', iosDeps);
    await session.confirm('123456');
    expect(credentialFromVerification).not.toHaveBeenCalled();
    expect(signInWithCredential).not.toHaveBeenCalled();
    expect(confirmIos).toHaveBeenCalledWith({ sessionId: 'opaque-session-1', code: '123456' });
    expect(signInWithCustomToken).toHaveBeenCalledWith(auth, 'custom-token-1');
    expect(signOut).not.toHaveBeenCalled();
  });

  it('signs out and fails closed when the JS uid does not match the native uid', async () => {
    signInWithCustomToken.mockResolvedValue({ user: { uid: 'other-uid' } });
    const ref: RecaptchaVerifierRef = { current: null };
    const session = await startPhoneVerification('+15555550100', ref, 'recaptcha-container', iosDeps);
    await expect(session.confirm('123456')).rejects.toMatchObject({ code: 'ios_phone_auth_uid_mismatch' });
    expect(signOut).toHaveBeenCalledWith(auth);
  });

  it('does not let a raw Firebase custom-token error escape the bridge', async () => {
    const leaked = 'custom-token-1 eyJhbGci provider text +15551212';
    signInWithCustomToken.mockRejectedValue(Object.assign(new Error(leaked), {
      code: 'auth/invalid-custom-token',
      stack: `Error: ${leaked}`,
    }));
    const ref: RecaptchaVerifierRef = { current: null };
    const session = await startPhoneVerification('+15555550100', ref, 'recaptcha-container', iosDeps);
    const capture = vi.fn();
    await expect(session.confirm('123456')).rejects.toMatchObject({
      name: 'IosPhoneAuthError',
      code: 'ios_phone_auth_bridge_failed',
      message: 'ios_phone_auth_bridge_failed',
    });
    try {
      await session.confirm('123456');
    } catch (error) {
      reportIosPhoneAuthConfirmFailure(error, 'signup_confirm_code', capture);
      expect(String((error as Error).stack)).not.toContain(leaked);
      expect((error as Error).message).not.toContain('eyJhbGci');
    }
    const [reported, context] = capture.mock.calls[0];
    expect(reported.message).toBe('ios_phone_auth_confirm_failed');
    expect(context.errorCode).toBe('ios_phone_auth_bridge_failed');
    expect(JSON.stringify(capture.mock.calls)).not.toContain(leaked);
  });

  it('maps custom-token network and throttle failures onto closed codes', async () => {
    const ref: RecaptchaVerifierRef = { current: null };
    signInWithCustomToken.mockRejectedValueOnce(Object.assign(new Error('offline raw'), {
      code: 'auth/network-request-failed',
    }));
    const networkSession = await startPhoneVerification('+15555550100', ref, 'recaptcha-container', iosDeps);
    await expect(networkSession.confirm('123456')).rejects.toMatchObject({
      code: 'ios_phone_auth_network',
      message: 'ios_phone_auth_network',
    });
    signInWithCustomToken.mockRejectedValueOnce(Object.assign(new Error('quota raw'), {
      code: 'auth/too-many-requests',
    }));
    const throttleSession = await startPhoneVerification('+15555550100', ref, 'recaptcha-container', iosDeps);
    await expect(throttleSession.confirm('123456')).rejects.toMatchObject({
      code: 'ios_phone_auth_too_many_requests',
      message: 'ios_phone_auth_too_many_requests',
    });
  });
});

describe('iOS native phone auth errors', () => {
  it('maps the closed code set onto invalid, throttle, or generic UI', () => {
    expect(iosPhoneAuthUiTone({ code: 'ios_phone_auth_invalid_number' })).toBe('invalid_number');
    expect(iosPhoneAuthUiTone({ code: 'ios_phone_auth_too_many_requests' })).toBe('too_many_requests');
    expect(iosPhoneAuthUiTone({ code: 'ios_phone_auth_invalid_code' })).toBe('invalid_code');
    expect(iosPhoneAuthUiTone({ code: 'ios_phone_auth_code_expired' })).toBe('expired');
    expect(iosPhoneAuthUiTone({ code: 'ios_phone_auth_invalid_session' })).toBe('expired');
    for (const code of IOS_PHONE_AUTH_ERROR_CODES) {
      if (
        code === 'ios_phone_auth_invalid_number'
        || code === 'ios_phone_auth_too_many_requests'
        || code === 'ios_phone_auth_invalid_code'
        || code === 'ios_phone_auth_code_expired'
        || code === 'ios_phone_auth_invalid_session'
      ) continue;
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

  it('reports confirm failures with a synthetic confirm error', () => {
    const capture = vi.fn();
    reportIosPhoneAuthConfirmFailure(
      { code: 'ios_phone_auth_bridge_failed', message: 'custom token leaked' },
      'signup_confirm_code',
      capture,
    );
    const [error, context] = capture.mock.calls[0];
    expect(error.message).toBe('ios_phone_auth_confirm_failed');
    expect(context).toEqual({
      route: 'signup_confirm_code',
      component: 'phoneAuth',
      platform: 'ios',
      errorCode: 'ios_phone_auth_bridge_failed',
    });
    expect(JSON.stringify(capture.mock.calls)).not.toContain('custom token leaked');
  });
});
