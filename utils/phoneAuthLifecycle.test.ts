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
    const successfulConfirmation = source.slice(source.indexOf('await confirmationResult.confirm'), source.indexOf('} catch (e: any)', source.indexOf('await confirmationResult.confirm')));

    expect(source).toContain("replaceRecaptchaVerifier(reauthRecaptchaRef, auth, 'reauth-recaptcha-anchor')");
    expect(source).toContain('const reauthSendingRef = useRef(false)');
    expect(source).toContain('const reauthVerifyingRef = useRef(false)');
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
