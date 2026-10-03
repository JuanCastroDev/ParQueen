/** Keep only digits, max 6 characters */
export const filterOtpInput = (raw: string): string =>
    raw.replace(/\D/g, '').slice(0, 6);

/** Map a Firebase or closed iOS OTP error code to the corresponding i18n message key */
export const otpErrorKey = (code: string): string => {
    switch (code) {
        case 'auth/invalid-verification-code':
        case 'ios_phone_auth_invalid_code':
            return 'verify_phone.invalid_code';
        case 'auth/code-expired':
        case 'ios_phone_auth_code_expired':
        case 'ios_phone_auth_invalid_session':
            return 'verify_phone.expired';
        case 'auth/too-many-requests':
        case 'ios_phone_auth_too_many_requests':
            return 'verify_phone.too_many';
        case 'ios_phone_auth_network':
            return 'verify_phone.failed_retry';
        case 'ios_phone_auth_configuration':
        case 'ios_phone_auth_uid_mismatch':
        case 'ios_phone_auth_bridge_failed':
        case 'ios_phone_auth_unknown':
            return 'verify_phone.failed_retry';
        default:
            return 'verify_phone.failed_retry';
    }
};

/** True when the OTP string is exactly 6 digits */
export const isOtpComplete = (code: string): boolean => code.length === 6;
