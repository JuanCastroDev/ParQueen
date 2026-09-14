import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FirebaseApp } from 'firebase/app';
import {
  fetchNativeAppCheckToken,
  initializeParQueenAppCheck,
  NATIVE_APP_CHECK_FAILURE,
  resetParQueenAppCheckInitForTests,
  type AppCheckInitDependencies,
} from './appCheck';

const app = { name: '[DEFAULT]' } as FirebaseApp;
const initializeAppCheck = vi.fn();
const CustomProvider = vi.fn(function CustomProviderMock(this: { options: unknown }, options: unknown) {
  this.options = options;
  return { kind: 'custom', options };
});
const ReCaptchaEnterpriseProvider = vi.fn(function RecaptchaMock(this: { siteKey: string }, siteKey: string) {
  this.siteKey = siteKey;
  return { kind: 'recaptcha', siteKey };
});
const getNativeToken = vi.fn();
const warn = vi.fn();

const androidDeps = (): AppCheckInitDependencies => ({
  resolvePath: () => 'native-android',
  getNativeToken,
  initializeAppCheck,
  CustomProvider: CustomProvider as never,
  ReCaptchaEnterpriseProvider: ReCaptchaEnterpriseProvider as never,
  siteKey: 'web-recaptcha-site-key',
  isDev: true,
  warn,
});

const webDeps = (): AppCheckInitDependencies => ({
  ...androidDeps(),
  resolvePath: () => 'web',
});

const capturedCustomGetToken = (): (() => Promise<{ token: string; expireTimeMillis: number }>) => {
  const providerArg = CustomProvider.mock.calls[0]?.[0] as { getToken: () => Promise<{ token: string; expireTimeMillis: number }> };
  return providerArg.getToken;
};

describe('initializeParQueenAppCheck', () => {
  beforeEach(() => {
    resetParQueenAppCheckInitForTests();
    vi.clearAllMocks();
    getNativeToken.mockResolvedValue({
      token: 'test-token-not-for-console',
      expireTimeMillis: 1_700_000_000_000,
    });
  });

  it('uses CustomProvider on Capacitor Android and does not construct ReCaptchaEnterpriseProvider', () => {
    initializeParQueenAppCheck(app, androidDeps());
    expect(CustomProvider).toHaveBeenCalledTimes(1);
    expect(ReCaptchaEnterpriseProvider).not.toHaveBeenCalled();
    expect(initializeAppCheck).toHaveBeenCalledTimes(1);
    expect(initializeAppCheck).toHaveBeenCalledWith(app, expect.objectContaining({
      isTokenAutoRefreshEnabled: true,
    }));
  });

  it('does not fall back from native Android App Check to WebView reCAPTCHA when the site key is absent', () => {
    initializeParQueenAppCheck(app, { ...androidDeps(), siteKey: undefined });
    expect(CustomProvider).toHaveBeenCalledTimes(1);
    expect(ReCaptchaEnterpriseProvider).not.toHaveBeenCalled();
    expect(initializeAppCheck).toHaveBeenCalledTimes(1);
  });

  it('uses ReCaptchaEnterpriseProvider on Web/PWA when the site key is present', () => {
    initializeParQueenAppCheck(app, webDeps());
    expect(ReCaptchaEnterpriseProvider).toHaveBeenCalledWith('web-recaptcha-site-key');
    expect(CustomProvider).not.toHaveBeenCalled();
    expect(initializeAppCheck).toHaveBeenCalledTimes(1);
    expect(initializeAppCheck).toHaveBeenCalledWith(app, expect.objectContaining({
      isTokenAutoRefreshEnabled: true,
    }));
  });

  it('keeps ReCaptchaEnterpriseProvider on Capacitor iOS (web path) and does not use the native bridge', () => {
    initializeParQueenAppCheck(app, {
      ...webDeps(),
      resolvePath: () => 'web',
    });
    expect(ReCaptchaEnterpriseProvider).toHaveBeenCalledTimes(1);
    expect(CustomProvider).not.toHaveBeenCalled();
    expect(getNativeToken).not.toHaveBeenCalled();
  });

  it('does not initialize App Check twice', () => {
    const deps = androidDeps();
    initializeParQueenAppCheck(app, deps);
    initializeParQueenAppCheck(app, deps);
    initializeParQueenAppCheck(app, webDeps());
    expect(initializeAppCheck).toHaveBeenCalledTimes(1);
    expect(CustomProvider).toHaveBeenCalledTimes(1);
    expect(ReCaptchaEnterpriseProvider).not.toHaveBeenCalled();
  });

  it('skips web initialization without a site key and emits the DEV TM-12 warning', () => {
    initializeParQueenAppCheck(app, { ...webDeps(), siteKey: undefined, isDev: true });
    expect(initializeAppCheck).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[AppCheck] TM-12 OPEN: VITE_FIREBASE_APPCHECK_SITE_KEY not set. App Check not initialized.',
    );
  });

  it('does not warn about a missing site key on the native Android path', () => {
    initializeParQueenAppCheck(app, { ...androidDeps(), siteKey: undefined, isDev: true });
    expect(warn.mock.calls.flat().join('\n')).not.toMatch(/VITE_FIREBASE_APPCHECK_SITE_KEY/);
  });

  it('passes the native token and real expireTimeMillis through CustomProvider without inventing TTL', async () => {
    initializeParQueenAppCheck(app, androidDeps());
    const token = await capturedCustomGetToken()();
    expect(token).toEqual({
      token: 'test-token-not-for-console',
      expireTimeMillis: 1_700_000_000_000,
    });
    expect(getNativeToken).toHaveBeenCalledTimes(1);
  });

  it('never logs token contents on the native success path', async () => {
    initializeParQueenAppCheck(app, androidDeps());
    await capturedCustomGetToken()();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('test-token-not-for-console');
    expect(logged).not.toContain('1700000000000');
  });

  it('fails native token requests without crashing, inventing TTL, or leaking token material', async () => {
    getNativeToken.mockRejectedValue({
      message: 'test-token-not-for-console leaked from plugin',
    });
    initializeParQueenAppCheck(app, androidDeps());
    await expect(capturedCustomGetToken()()).rejects.toThrow(NATIVE_APP_CHECK_FAILURE);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('test-token-not-for-console');
    expect(logged).toContain('[AppCheck] Native token request failed.');
  });

  it('rejects an incomplete native token instead of inventing expireTimeMillis', async () => {
    getNativeToken.mockResolvedValue({ token: 'test-token-not-for-console' });
    initializeParQueenAppCheck(app, androidDeps());
    await expect(capturedCustomGetToken()()).rejects.toThrow(NATIVE_APP_CHECK_FAILURE);
  });

  it('does not crash if native initializeAppCheck throws', () => {
    initializeAppCheck.mockImplementation(() => {
      throw new Error('test-token-not-for-console');
    });
    expect(() => initializeParQueenAppCheck(app, androidDeps())).not.toThrow();
    expect(warn).toHaveBeenCalledWith('[AppCheck] Native initialization failed.');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('test-token-not-for-console');
  });
});

describe('fetchNativeAppCheckToken', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the native expireTimeMillis unchanged', async () => {
    const token = await fetchNativeAppCheckToken(
      async () => ({ token: 'test-token-not-for-console', expireTimeMillis: 42 }),
      warn,
    );
    expect(token.expireTimeMillis).toBe(42);
    expect(warn).not.toHaveBeenCalled();
  });
});
