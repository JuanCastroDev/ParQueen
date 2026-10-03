import { registerPlugin, WebPlugin } from '@capacitor/core';
import { captureClientException, type SafeErrorContext } from './errorReporting';

export interface NativePhoneVerificationRequest {
  phoneNumber: string;
  resend?: boolean;
}

export interface AndroidPhoneVerificationResult {
  verificationId: string;
}

export interface IosPhoneVerificationResult {
  sessionId: string;
}

export interface IosPhoneConfirmRequest {
  sessionId: string;
  code: string;
  expectedUid?: string;
}

export interface IosPhoneConfirmResult {
  customToken: string;
  uid: string;
}

export interface PhoneAuthPlugin {
  startVerification(options: NativePhoneVerificationRequest): Promise<AndroidPhoneVerificationResult | IosPhoneVerificationResult>;
  confirmVerification(options: IosPhoneConfirmRequest): Promise<IosPhoneConfirmResult>;
}

export const IOS_PHONE_AUTH_ERROR_CODES = [
  'ios_phone_auth_app_verification_failed',
  'ios_phone_auth_invalid_number',
  'ios_phone_auth_invalid_code',
  'ios_phone_auth_code_expired',
  'ios_phone_auth_invalid_session',
  'ios_phone_auth_too_many_requests',
  'ios_phone_auth_network',
  'ios_phone_auth_configuration',
  'ios_phone_auth_uid_mismatch',
  'ios_phone_auth_bridge_failed',
  'ios_phone_auth_unknown',
] as const;

export type IosPhoneAuthErrorCode = (typeof IOS_PHONE_AUTH_ERROR_CODES)[number];

export type IosPhoneAuthUiTone = 'invalid_number' | 'too_many_requests' | 'invalid_code' | 'expired' | 'generic';

export type IosPhoneAuthReportRoute =
  | 'signup_send_code'
  | 'signup_resend_code'
  | 'signup_confirm_code'
  | 'deletion_reauth_send'
  | 'deletion_reauth_resend'
  | 'deletion_reauth_confirm';

const IOS_PHONE_AUTH_ERROR_CODE_SET = new Set<string>(IOS_PHONE_AUTH_ERROR_CODES);

export const readIosPhoneAuthErrorCode = (error: unknown): IosPhoneAuthErrorCode | null => {
  if (!error || typeof error !== 'object') return null;
  const code = (error as { code?: unknown }).code;
  if (typeof code !== 'string' || !IOS_PHONE_AUTH_ERROR_CODE_SET.has(code)) return null;
  return code as IosPhoneAuthErrorCode;
};

export const iosPhoneAuthUiTone = (error: unknown): IosPhoneAuthUiTone | null => {
  const code = readIosPhoneAuthErrorCode(error);
  if (!code) return null;
  if (code === 'ios_phone_auth_invalid_number') return 'invalid_number';
  if (code === 'ios_phone_auth_too_many_requests') return 'too_many_requests';
  if (code === 'ios_phone_auth_invalid_code') return 'invalid_code';
  if (code === 'ios_phone_auth_code_expired' || code === 'ios_phone_auth_invalid_session') return 'expired';
  return 'generic';
};

const reportIosPhoneAuth = (
  error: unknown,
  route: IosPhoneAuthReportRoute,
  message: 'ios_phone_auth_send_failed' | 'ios_phone_auth_confirm_failed',
  capture: (error: Error, context: SafeErrorContext) => void,
): void => {
  const errorCode = readIosPhoneAuthErrorCode(error);
  if (!errorCode) return;
  capture(new Error(message), {
    route,
    component: 'phoneAuth',
    platform: 'ios',
    errorCode,
  });
};

export const reportIosPhoneAuthFailure = (
  error: unknown,
  route: IosPhoneAuthReportRoute,
  capture: (error: Error, context: SafeErrorContext) => void = captureClientException,
): void => {
  reportIosPhoneAuth(error, route, 'ios_phone_auth_send_failed', capture);
};

export const reportIosPhoneAuthConfirmFailure = (
  error: unknown,
  route: Extract<IosPhoneAuthReportRoute, 'signup_confirm_code' | 'deletion_reauth_confirm'>,
  capture: (error: Error, context: SafeErrorContext) => void = captureClientException,
): void => {
  reportIosPhoneAuth(error, route, 'ios_phone_auth_confirm_failed', capture);
};

/**
 * Map a JavaScript Auth failure from the custom-token bridge onto a closed code.
 * Only error.code is read. Provider message and stack are discarded.
 */
export const normalizeIosPhoneAuthBridgeError = (error: unknown): IosPhoneAuthError => {
  if (error instanceof IosPhoneAuthError) return error;
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : undefined;
  if (code === 'auth/network-request-failed') return new IosPhoneAuthError('ios_phone_auth_network');
  if (code === 'auth/too-many-requests') return new IosPhoneAuthError('ios_phone_auth_too_many_requests');
  return new IosPhoneAuthError('ios_phone_auth_bridge_failed');
};

export class IosPhoneAuthError extends Error {
  readonly code: IosPhoneAuthErrorCode;

  constructor(code: IosPhoneAuthErrorCode) {
    super(code);
    this.name = 'IosPhoneAuthError';
    this.code = code;
  }
}

class PhoneAuthWeb extends WebPlugin implements PhoneAuthPlugin {
  async startVerification(): Promise<AndroidPhoneVerificationResult> {
    throw this.unimplemented('Native phone auth is only available in the iOS and Android app.');
  }

  async confirmVerification(): Promise<IosPhoneConfirmResult> {
    throw this.unimplemented('Native phone auth is only available in the iOS and Android app.');
  }
}

const PhoneAuth = registerPlugin<PhoneAuthPlugin>('PhoneAuth', {
  web: () => new PhoneAuthWeb(),
});

export const nativeStartPhoneVerification = (
  options: NativePhoneVerificationRequest,
): Promise<AndroidPhoneVerificationResult> => (
  PhoneAuth.startVerification(options) as Promise<AndroidPhoneVerificationResult>
);

export const iosStartPhoneVerification = (
  options: NativePhoneVerificationRequest,
): Promise<IosPhoneVerificationResult> => (
  PhoneAuth.startVerification(options) as Promise<IosPhoneVerificationResult>
);

export const iosConfirmPhoneVerification = (
  options: IosPhoneConfirmRequest,
): Promise<IosPhoneConfirmResult> => PhoneAuth.confirmVerification(options);
