import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createNativePhoneReauthSession,
  PhoneReauthError,
  requireAuthPhoneUser,
  requireLiveAuthUid,
  resendPhoneReauthentication,
  startPhoneReauthentication,
  type PhoneReauthDependencies,
} from './phoneReauth';
import type { RecaptchaVerifierRef } from './recaptchaLifecycle';

const replaceVerifier = vi.fn((ref: RecaptchaVerifierRef, _auth: unknown, _id: string) => {
  const verifier = { clear: vi.fn() };
  ref.current = verifier as never;
  return verifier;
});
const clearVerifier = vi.fn((ref: RecaptchaVerifierRef) => {
  ref.current = null;
});
const reauthenticateWithPhoneNumber = vi.fn();
const reauthenticateWithCredential = vi.fn();
const credentialFromVerification = vi.fn((verificationId: string, code: string) => ({
  verificationId,
  code,
  kind: 'phone-credential',
}));
const startNative = vi.fn();
const currentUser = {
  uid: 'uid-keep',
  phoneNumber: '+15555550100',
};
const authState = {
  name: 'js-auth',
  currentUser: currentUser as { uid: string; phoneNumber: string } | null,
};
const auth = authState as never;

const baseDeps = {
  replaceVerifier,
  clearVerifier,
  reauthenticateWithPhoneNumber,
  reauthenticateWithCredential,
  credentialFromVerification,
  startNative,
  auth,
} as PhoneReauthDependencies;

const webDeps = {
  ...baseDeps,
  resolvePath: () => 'web' as const,
} as PhoneReauthDependencies;

const nativeDeps = {
  ...baseDeps,
  resolvePath: () => 'native' as const,
} as PhoneReauthDependencies;

describe('requireAuthPhoneUser', () => {
  it('fails safely when there is no signed-in user', () => {
    expect(() => requireAuthPhoneUser({ currentUser: null } as never)).toThrow(PhoneReauthError);
    try {
      requireAuthPhoneUser({ currentUser: null } as never);
    } catch (error) {
      expect((error as PhoneReauthError).code).toBe('auth/missing-user');
    }
  });

  it('fails safely when Auth user has no phoneNumber', () => {
    expect(() => requireAuthPhoneUser({ currentUser: { uid: 'u1' } } as never)).toThrow(PhoneReauthError);
    try {
      requireAuthPhoneUser({ currentUser: { uid: 'u1' } } as never);
    } catch (error) {
      expect((error as PhoneReauthError).code).toBe('auth/missing-phone');
    }
  });

  it('returns the Auth user when phoneNumber is present', () => {
    const user = { uid: 'u1', phoneNumber: '+15555550100' };
    expect(requireAuthPhoneUser({ currentUser: user } as never)).toBe(user);
  });
});

describe('requireLiveAuthUid', () => {
  it('fails when auth.currentUser is null', () => {
    expect(() => requireLiveAuthUid({ currentUser: null } as never, 'uid-keep')).toThrow(PhoneReauthError);
    try {
      requireLiveAuthUid({ currentUser: null } as never, 'uid-keep');
    } catch (error) {
      expect((error as PhoneReauthError).code).toBe('auth/missing-user');
    }
  });

  it('fails when live UID differs from the captured uid', () => {
    try {
      requireLiveAuthUid({ currentUser: { uid: 'other' } } as never, 'uid-keep');
      throw new Error('expected throw');
    } catch (error) {
      expect((error as PhoneReauthError).code).toBe('auth/account-switched');
    }
  });
});

describe('startPhoneReauthentication web path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.currentUser = currentUser;
    reauthenticateWithPhoneNumber.mockResolvedValue({ confirm: vi.fn() });
  });

  it('uses reauthenticateWithPhoneNumber + RecaptchaVerifier and currentUser.phoneNumber', async () => {
    const ref: RecaptchaVerifierRef = { current: null };
    const session = await startPhoneReauthentication({
      currentUser: currentUser as never,
      recaptchaRef: ref,
      containerId: 'reauth-recaptcha-anchor',
      deps: webDeps,
    });

    expect(startNative).not.toHaveBeenCalled();
    expect(replaceVerifier).toHaveBeenCalledWith(ref, auth, 'reauth-recaptcha-anchor');
    expect(reauthenticateWithPhoneNumber).toHaveBeenCalledWith(
      currentUser,
      '+15555550100',
      expect.anything(),
    );
    expect(clearVerifier).toHaveBeenCalledWith(ref);
    expect(session).toEqual(expect.objectContaining({ confirm: expect.any(Function) }));
  });

  it('confirm delegates to Firebase ConfirmationResult.confirm after a live UID check', async () => {
    const confirm = vi.fn().mockResolvedValue({ user: currentUser });
    reauthenticateWithPhoneNumber.mockResolvedValue({ confirm });
    const ref: RecaptchaVerifierRef = { current: null };
    const session = await startPhoneReauthentication({
      currentUser: currentUser as never,
      recaptchaRef: ref,
      containerId: 'reauth-recaptcha-anchor',
      deps: webDeps,
    });
    await session.confirm('654321');
    expect(confirm).toHaveBeenCalledWith('654321');
    expect(reauthenticateWithCredential).not.toHaveBeenCalled();
  });
});

describe('startPhoneReauthentication native Android path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.currentUser = currentUser;
    startNative.mockResolvedValue({ verificationId: 'native-reauth-vid' });
    reauthenticateWithCredential.mockResolvedValue({ user: currentUser });
  });

  it('does not create RecaptchaVerifier and uses nativeStartPhoneVerification', async () => {
    const ref: RecaptchaVerifierRef = { current: null };
    await startPhoneReauthentication({
      currentUser: currentUser as never,
      recaptchaRef: ref,
      containerId: 'reauth-recaptcha-anchor',
      deps: nativeDeps,
    });
    expect(replaceVerifier).not.toHaveBeenCalled();
    expect(clearVerifier).not.toHaveBeenCalled();
    expect(reauthenticateWithPhoneNumber).not.toHaveBeenCalled();
    expect(startNative).toHaveBeenCalledWith({ phoneNumber: '+15555550100' });
  });

  it('OTP builds credential and calls reauthenticateWithCredential', async () => {
    const ref: RecaptchaVerifierRef = { current: null };
    const session = await startPhoneReauthentication({
      currentUser: currentUser as never,
      recaptchaRef: ref,
      containerId: 'reauth-recaptcha-anchor',
      deps: nativeDeps,
    });
    await session.confirm('123456');
    expect(credentialFromVerification).toHaveBeenCalledWith('native-reauth-vid', '123456');
    expect(reauthenticateWithCredential).toHaveBeenCalledWith(currentUser, {
      verificationId: 'native-reauth-vid',
      code: '123456',
      kind: 'phone-credential',
    });
  });
});

describe('resendPhoneReauthentication', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.currentUser = currentUser;
    reauthenticateWithPhoneNumber.mockResolvedValue({ confirm: vi.fn() });
    startNative.mockResolvedValue({ verificationId: 'native-reauth-vid-2' });
  });

  it('native resend uses resend=true', async () => {
    const ref: RecaptchaVerifierRef = { current: null };
    await resendPhoneReauthentication({
      currentUser: currentUser as never,
      recaptchaRef: ref,
      containerId: 'reauth-recaptcha-anchor',
      deps: nativeDeps,
    });
    expect(startNative).toHaveBeenCalledWith({ phoneNumber: '+15555550100', resend: true });
  });

  it('web resend replaces/recreates verifier', async () => {
    const ref: RecaptchaVerifierRef = { current: { clear: vi.fn() } as never };
    await resendPhoneReauthentication({
      currentUser: currentUser as never,
      recaptchaRef: ref,
      containerId: 'reauth-recaptcha-anchor',
      deps: webDeps,
    });
    expect(replaceVerifier).toHaveBeenCalledWith(ref, auth, 'reauth-recaptcha-anchor');
    expect(reauthenticateWithPhoneNumber).toHaveBeenCalled();
    expect(clearVerifier).toHaveBeenCalledWith(ref);
  });
});

describe('createNativePhoneReauthSession', () => {
  it('calls reauthenticateWithCredential with the live Auth user', async () => {
    authState.currentUser = currentUser;
    reauthenticateWithCredential.mockResolvedValue({});
    const session = createNativePhoneReauthSession(currentUser as never, 'vid', nativeDeps);
    await session.confirm('999999');
    expect(reauthenticateWithCredential).toHaveBeenCalled();
    expect(reauthenticateWithCredential.mock.calls[0][0]).toBe(currentUser);
  });
});

describe('live Auth user / UID safety', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.currentUser = currentUser;
  });

  it('rejects missing auth.currentUser before verification start', async () => {
    const ref: RecaptchaVerifierRef = { current: null };
    const deps = {
      ...webDeps,
      auth: { currentUser: null },
    } as never;
    await expect(
      startPhoneReauthentication({
        currentUser: currentUser as never,
        recaptchaRef: ref,
        containerId: 'reauth-recaptcha-anchor',
        deps,
      }),
    ).rejects.toMatchObject({ code: 'auth/missing-user' });
    expect(reauthenticateWithPhoneNumber).not.toHaveBeenCalled();
    expect(startNative).not.toHaveBeenCalled();
  });

  it('rejects when live UID differs from captured currentUser.uid before start', async () => {
    const ref: RecaptchaVerifierRef = { current: null };
    const deps = {
      ...webDeps,
      auth: { currentUser: { uid: 'other-uid', phoneNumber: '+15555550999' } },
    } as never;
    await expect(
      startPhoneReauthentication({
        currentUser: currentUser as never,
        recaptchaRef: ref,
        containerId: 'reauth-recaptcha-anchor',
        deps,
      }),
    ).rejects.toMatchObject({ code: 'auth/account-switched' });
    expect(reauthenticateWithPhoneNumber).not.toHaveBeenCalled();
  });

  it('rejects missing phone on the provided currentUser', async () => {
    const ref: RecaptchaVerifierRef = { current: null };
    await expect(
      startPhoneReauthentication({
        currentUser: { uid: 'uid-keep' } as never,
        recaptchaRef: ref,
        containerId: 'reauth-recaptcha-anchor',
        deps: webDeps,
      }),
    ).rejects.toMatchObject({ code: 'auth/missing-phone' });
    expect(reauthenticateWithPhoneNumber).not.toHaveBeenCalled();
    expect(startNative).not.toHaveBeenCalled();
  });

  it('missing auth.currentUser before native confirm does not call reauthenticateWithCredential', async () => {
    startNative.mockResolvedValue({ verificationId: 'native-reauth-vid' });
    const ref: RecaptchaVerifierRef = { current: null };
    const session = await startPhoneReauthentication({
      currentUser: currentUser as never,
      recaptchaRef: ref,
      containerId: 'reauth-recaptcha-anchor',
      deps: nativeDeps,
    });
    authState.currentUser = null;
    await expect(session.confirm('123456')).rejects.toMatchObject({ code: 'auth/missing-user' });
    expect(reauthenticateWithCredential).not.toHaveBeenCalled();
    expect(credentialFromVerification).not.toHaveBeenCalled();
  });

  it('changed UID before native confirm does not call reauthenticateWithCredential', async () => {
    startNative.mockResolvedValue({ verificationId: 'native-reauth-vid' });
    const ref: RecaptchaVerifierRef = { current: null };
    const session = await startPhoneReauthentication({
      currentUser: currentUser as never,
      recaptchaRef: ref,
      containerId: 'reauth-recaptcha-anchor',
      deps: nativeDeps,
    });
    authState.currentUser = { uid: 'switched', phoneNumber: '+15555550999' };
    await expect(session.confirm('123456')).rejects.toMatchObject({ code: 'auth/account-switched' });
    expect(reauthenticateWithCredential).not.toHaveBeenCalled();
  });

  it('missing auth.currentUser before web confirm does not call ConfirmationResult.confirm', async () => {
    const confirm = vi.fn().mockResolvedValue({});
    reauthenticateWithPhoneNumber.mockResolvedValue({ confirm });
    const ref: RecaptchaVerifierRef = { current: null };
    const session = await startPhoneReauthentication({
      currentUser: currentUser as never,
      recaptchaRef: ref,
      containerId: 'reauth-recaptcha-anchor',
      deps: webDeps,
    });
    authState.currentUser = null;
    await expect(session.confirm('654321')).rejects.toMatchObject({ code: 'auth/missing-user' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('changed UID before web confirm does not call ConfirmationResult.confirm', async () => {
    const confirm = vi.fn().mockResolvedValue({});
    reauthenticateWithPhoneNumber.mockResolvedValue({ confirm });
    const ref: RecaptchaVerifierRef = { current: null };
    const session = await startPhoneReauthentication({
      currentUser: currentUser as never,
      recaptchaRef: ref,
      containerId: 'reauth-recaptcha-anchor',
      deps: webDeps,
    });
    authState.currentUser = { uid: 'switched', phoneNumber: '+15555550999' };
    await expect(session.confirm('654321')).rejects.toMatchObject({ code: 'auth/account-switched' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('phone number source is only currentUser.phoneNumber (no alternate phone arg)', async () => {
    const keys = Object.keys({
      currentUser,
      recaptchaRef: { current: null },
      containerId: 'x',
      deps: webDeps,
    } as const);
    expect(keys).not.toContain('phoneNumber');
  });
});

describe('deletion reauth does not use signup sign-in APIs', () => {
  it('utils/phoneReauth.ts does not import signInWithCredential', () => {
    const source = readFileSync(new URL('./phoneReauth.ts', import.meta.url), 'utf8');
    const firebaseImport = source.slice(0, source.indexOf("from 'firebase/auth'"));
    expect(firebaseImport).not.toContain('signInWithCredential');
    expect(source).not.toMatch(/signInWithCredential\s*[:(]/);
    expect(source).toContain('reauthenticateWithCredential');
    expect(source).toContain('reauthenticateWithPhoneNumber');
  });

  it('signup utils/phoneAuth.ts still uses signInWithCredential', () => {
    const source = readFileSync(new URL('./phoneAuth.ts', import.meta.url), 'utf8');
    expect(source).toContain('signInWithCredential');
  });
});
