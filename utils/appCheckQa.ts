export const APP_CHECK_QA_FLAG = 'VITE_PARQUEEN_APPCHECK_QA';

export type AppCheckQaBuildType = 'debug' | 'release' | 'TestFlight' | 'unspecified';

export interface AppCheckQaReport {
  platform: string;
  buildIdentity: string;
  buildType: AppCheckQaBuildType;
  expectedProvider: string;
  initialized: 'YES' | 'FAIL';
  tokenRetrieval: 'PASS' | 'FAIL';
  failureCategory: string;
  debugOnly: boolean;
}

export const appCheckQaEnabled = (env: Record<string, string | undefined>): boolean =>
  env[APP_CHECK_QA_FLAG] === 'true';

export const classifyAppCheckToken = (token: unknown): 'pass' | 'empty' | 'dummy' => {
  if (typeof token !== 'string' || token.trim().length < 20) return 'empty';
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return 'dummy';
  if (parts[2] === 'sim') return 'dummy';
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    if (json.includes('simulatedEmulatorAppCheck')) return 'dummy';
  } catch {
    return 'dummy';
  }
  return 'pass';
};

export const failureCategory = (error: unknown): string => {
  const code = error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code || '')
    : '';
  if (code.includes('not-activated') || code.includes('use-before-activation')) return 'not-initialized';
  if (code.includes('throttl')) return 'throttled';
  if (code.includes('fetch') || code.includes('network')) return 'network';
  if (code.includes('recaptcha') || code.includes('app-check') || code.includes('appCheck')) return 'attestation-failed';
  if (error instanceof Error && error.message === 'App Check is not initialized.') return 'not-initialized';
  return 'unknown';
};

export const expectedProviderFor = (platform: string, buildType: AppCheckQaBuildType): string => {
  if (platform === 'android' && buildType === 'debug') return 'Debug provider';
  if (platform === 'android') return 'Play Integrity';
  if (platform === 'ios') return 'App Attest';
  return 'reCAPTCHA Enterprise';
};
