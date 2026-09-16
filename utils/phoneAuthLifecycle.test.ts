import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import en from '../i18n/en';
import es from '../i18n/es';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('phone-auth flow integration', () => {
  it('wires Create Account to the platform abstraction and owned cleanup boundaries', () => {
    const source = read('views/CreateAccountView.tsx');
    const web = read('utils/phoneAuth.ts');

    expect(source).toContain("preparePhoneAuth(recaptchaRef, 'recaptcha-container')");
    expect(source).toContain("startPhoneVerification(phoneE164, recaptchaRef, 'recaptcha-container')");
    expect(source).toContain('clearRecaptchaVerifier(recaptchaRef)');
    expect(source).toContain('const sendingRef = useRef(false)');
    expect(source).toMatch(/if \(!phoneE164 \|\| sendingRef\.current\) return;/);
    expect(source).toMatch(/onContinue\(phoneE164, result\);\s*clearRecaptchaVerifier\(recaptchaRef\);/);
    expect(web).toContain('resolved.replaceVerifier(recaptchaRef, resolved.auth, containerId)');
    expect(web).toContain('resolved.signInWithPhoneNumber(resolved.auth, phoneE164, verifier)');
  });

  it('wires Verify Phone resend through the same platform abstraction', () => {
    const source = read('views/VerifyPhoneView.tsx');
    const web = read('utils/phoneAuth.ts');

    expect(source).toContain("resendPhoneVerification(phone, recaptchaRef, 'recaptcha-resend')");
    expect(source).toContain('const resendingRef = useRef(false)');
    expect(source).toContain('const verifyingRef = useRef(false)');
    expect(source).toMatch(/setConfirmation\(result\);\s*clearRecaptchaVerifier\(recaptchaRef\);/);
    expect(source).not.toMatch(/if \(!recaptchaRef\.current\)/);
    expect(web).toContain('resend: true');
    expect(web).toContain('resolved.signInWithPhoneNumber(resolved.auth, phoneE164, verifier)');
  });

  it('clears deletion reauthentication state on success and auth sign-out', () => {
    const source = read('App.tsx');
    const authNullStart = source.indexOf('// No user is logged in');
    const authNullBranch = source.slice(authNullStart, source.indexOf('setLoading(false)', authNullStart));
    const confirmCall = source.includes('await activeSession.confirm')
      ? 'await activeSession.confirm'
      : 'await confirmationResult.confirm';
    const successfulConfirmation = source.slice(source.indexOf(confirmCall), source.indexOf('} catch (e: any)', source.indexOf(confirmCall)));

    expect(source).toContain('startPhoneReauthentication');
    expect(source).toContain('resendPhoneReauthentication');
    expect(source).not.toMatch(/reauthenticateWithPhoneNumber\s*\(/);
    expect(source).toContain('const reauthSendingRef = useRef(false)');
    expect(source).toContain('const reauthVerifyingRef = useRef(false)');
    const reauthHelper = read('utils/phoneReauth.ts');
    expect(reauthHelper).toContain("resolved.replaceVerifier(recaptchaRef, resolved.auth, containerId)");
    expect(reauthHelper).toContain('reauthenticateWithCredential');
    expect(reauthHelper).toContain("resolved.resolvePath() === 'native'");
    expect(authNullBranch).toContain('clearReauthState()');
    expect(successfulConfirmation).toContain('clearReauthState()');
    expect(successfulConfirmation.indexOf('clearReauthState()')).toBeLessThan(successfulConfirmation.indexOf('await unlinkFcmTokenBeforeDeletion()'));
  });

  it('keeps all phone-auth flows on unique container IDs', () => {
    const ids = [
      ...read('views/CreateAccountView.tsx').matchAll(/id="(recaptcha-[^"]+)"/g),
      ...read('views/VerifyPhoneView.tsx').matchAll(/id="(recaptcha-[^"]+)"/g),
      ...read('App.tsx').matchAll(/id="([^"]*recaptcha[^"]*)"/g),
    ].map(match => match[1]);

    expect(ids).toEqual([
      'recaptcha-container',
      'recaptcha-resend',
      'reauth-recaptcha-anchor',
    ]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('ships retryable expired-verification copy in English and Spanish', () => {
    expect(en['phone_auth.error_expired']).toBe('Verification expired. Please try sending the code again.');
    expect(es['phone_auth.error_expired']).toBe('La verificación expiró. Intenta enviar el código de nuevo.');
  });
});

describe('deletion reauth race / stale-flow source contracts (App.tsx, not mounted)', () => {
  const source = read('App.tsx');
  const fn = (name: string, next: string) => {
    const start = source.indexOf(`const ${name}`);
    const end = source.indexOf(`const ${next}`, start);
    return source.slice(start, end);
  };
  const send = fn('handleReauthSendOtp', 'handleReauthVerifyOtp');
  const verify = fn('handleReauthVerifyOtp', 'handleReauthResend');
  const resend = fn('handleReauthResend', 'handleDeleteConfirm');
  const clear = fn('clearReauthState', 'handleDeleteModalDismiss');
  const dismissStart = source.indexOf('const handleDeleteModalDismiss');
  const dismiss = source.slice(dismissStart, source.indexOf('useEffect', dismissStart));

  it('duplicate Send is gated by reauthSendingRef', () => {
    expect(source).toContain('const reauthSendingRef = useRef(false)');
    expect(send).toMatch(/if \(reauthSendingRef\.current\) return;/);
    expect(send.indexOf('if (reauthSendingRef.current) return')).toBeLessThan(
      send.indexOf('startPhoneReauthentication'),
    );
  });

  it('duplicate Verify is gated by reauthVerifyingRef', () => {
    expect(source).toContain('const reauthVerifyingRef = useRef(false)');
    expect(verify).toMatch(/if \(reauthVerifyingRef\.current\) return;/);
    expect(verify.indexOf('if (reauthVerifyingRef.current) return')).toBeLessThan(
      verify.indexOf('activeSession.confirm'),
    );
  });

  it('clear/dismiss increments the reauth session generation', () => {
    expect(source).toContain('const reauthSessionGenRef = useRef(0)');
    expect(clear).toContain('reauthSessionGenRef.current += 1');
    expect(clear.indexOf('reauthSessionGenRef.current += 1')).toBeLessThan(
      clear.indexOf('setConfirmationResult(null)'),
    );
    expect(dismiss).toContain('clearReauthState()');
  });

  it('stale Send cannot call setConfirmationResult or advance to OTP', () => {
    const awaitIdx = send.indexOf('await startPhoneReauthentication');
    const staleIdx = send.indexOf('if (sessionGen !== reauthSessionGenRef.current) return', awaitIdx);
    const setResultIdx = send.indexOf('setConfirmationResult(result)', awaitIdx);
    const otpPhaseIdx = send.indexOf("setDeletePhase('reauth_verifying_otp')", awaitIdx);
    expect(staleIdx).toBeGreaterThan(awaitIdx);
    expect(setResultIdx).toBeGreaterThan(staleIdx);
    expect(otpPhaseIdx).toBeGreaterThan(staleIdx);
  });

  it('stale Resend cannot replace the active session', () => {
    const awaitIdx = resend.indexOf('await resendPhoneReauthentication');
    const staleIdx = resend.indexOf('if (sessionGen !== reauthSessionGenRef.current) return', awaitIdx);
    const setResultIdx = resend.indexOf('setConfirmationResult(result)', awaitIdx);
    expect(staleIdx).toBeGreaterThan(awaitIdx);
    expect(setResultIdx).toBeGreaterThan(staleIdx);
  });

  it('OTP confirmation completing after reset/dismiss cannot reach UID verification or deletion', () => {
    const confirmIdx = verify.indexOf('await activeSession.confirm');
    const staleIdx = verify.indexOf('if (sessionGen !== reauthSessionGenRef.current) return', confirmIdx);
    const uidIdx = verify.indexOf('verifyUidUnchanged', confirmIdx);
    const unlinkIdx = verify.indexOf('unlinkFcmTokenBeforeDeletion()', confirmIdx);
    const deleteIdx = verify.indexOf('await deleteUser()', confirmIdx);
    expect(staleIdx).toBeGreaterThan(confirmIdx);
    expect(uidIdx).toBeGreaterThan(staleIdx);
    expect(unlinkIdx).toBeGreaterThan(staleIdx);
    expect(deleteIdx).toBeGreaterThan(staleIdx);
  });
});
