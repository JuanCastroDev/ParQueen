import { classifyAppCheckToken, appCheckQaEnabled, failureCategory, expectedProviderFor } from './appCheckQa';
import { simulatedDemoAppCheckToken } from './demoFirebaseAppCheck';

describe('App Check QA diagnostic', () => {
  it('is off unless the explicit QA flag is the string true', () => {
    expect(appCheckQaEnabled({})).toBe(false);
    expect(appCheckQaEnabled({ VITE_PARQUEEN_APPCHECK_QA: 'false' })).toBe(false);
    expect(appCheckQaEnabled({ VITE_PARQUEEN_APPCHECK_QA: 'true' })).toBe(true);
  });

  it('rejects an empty token, a short token, and the emulator dummy token', () => {
    expect(classifyAppCheckToken('')).toBe('empty');
    expect(classifyAppCheckToken('not-a-token')).toBe('empty');
    expect(classifyAppCheckToken(simulatedDemoAppCheckToken().token)).toBe('dummy');
  });

  it('accepts a three-part token that is not the emulator dummy', () => {
    const payload = btoa(JSON.stringify({ sub: 'app', iss: 'https://firebaseappcheck.googleapis.com' }))
      .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    expect(classifyAppCheckToken(`eyJhbGciOiJIUzI1NiJ9.${payload}.signaturevalue`)).toBe('pass');
  });

  it('maps failures without using the error message', () => {
    expect(failureCategory({ code: 'appCheck/throttled', message: 'secret-token' })).toBe('throttled');
    expect(failureCategory({ code: 'appCheck/recaptcha-error', message: 'raw' })).toBe('attestation-failed');
    expect(failureCategory(new Error('App Check is not initialized.'))).toBe('not-initialized');
  });

  it('names the provider for each platform', () => {
    expect(expectedProviderFor('web', 'release')).toBe('reCAPTCHA Enterprise');
    expect(expectedProviderFor('android', 'debug')).toBe('Debug provider');
    expect(expectedProviderFor('android', 'release')).toBe('Play Integrity');
    expect(expectedProviderFor('ios', 'TestFlight')).toBe('App Attest');
  });
});
