import { registerPlugin, WebPlugin } from '@capacitor/core';
import { captureClientException, type SafeErrorContext } from './errorReporting';

export interface NativePhoneVerificationRequest {
  phoneNumber: string;
  resend?: boolean;
}

export interface NativePhoneVerificationResult {
  verificationId: string;
}

export interface PhoneAuthPlugin {
  startVerification(options: NativePhoneVerificationRequest): Promise<NativePhoneVerificationResult>;
}

export const IOS_PHONE_AUTH_ERROR_CODES = [
  'ios_phone_auth_app_verification_failed',
  'ios_phone_auth_invalid_number',
  'ios_phone_auth_too_many_requests',
  'ios_phone_auth_network',
  'ios_phone_auth_configuration',
  'ios_phone_auth_unknown',
] as const;

export type IosPhoneAuthErrorCode = (typeof IOS_PHONE_AUTH_ERROR_CODES)[number];

export type IosPhoneAuthUiTone = 'invalid_number' | 'too_many_requests' | 'generic';

export type IosPhoneAuthReportRoute =
  | 'signup_send_code'
  | 'signup_resend_code'
  | 'deletion_reauth_send'
  | 'deletion_reauth_resend';

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
  return 'generic';
};

export const reportIosPhoneAuthFailure = (
  error: unknown,
  route: IosPhoneAuthReportRoute,
  capture: (error: Error, context: SafeErrorContext) => void = captureClientException,
): void => {
  const errorCode = readIosPhoneAuthErrorCode(error);
  if (!errorCode) return;
  capture(new Error('ios_phone_auth_send_failed'), {
    route,
    component: 'phoneAuth',
    platform: 'ios',
    errorCode,
  });
};

class PhoneAuthWeb extends WebPlugin implements PhoneAuthPlugin {
  async startVerification(): Promise<NativePhoneVerificationResult> {
    throw this.unimplemented('Native phone auth is only available in the iOS and Android app.');
  }
}

const PhoneAuth = registerPlugin<PhoneAuthPlugin>('PhoneAuth', {
  web: () => new PhoneAuthWeb(),
});

export const nativeStartPhoneVerification = (
  options: NativePhoneVerificationRequest,
): Promise<NativePhoneVerificationResult> => PhoneAuth.startVerification(options);
