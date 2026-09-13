import { registerPlugin, WebPlugin } from '@capacitor/core';

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

class PhoneAuthWeb extends WebPlugin implements PhoneAuthPlugin {
  async startVerification(): Promise<NativePhoneVerificationResult> {
    throw this.unimplemented('Native phone auth is only available on Capacitor Android.');
  }
}

const PhoneAuth = registerPlugin<PhoneAuthPlugin>('PhoneAuth', {
  web: () => new PhoneAuthWeb(),
});

export const nativeStartPhoneVerification = (
  options: NativePhoneVerificationRequest,
): Promise<NativePhoneVerificationResult> => PhoneAuth.startVerification(options);
