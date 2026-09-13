import React, { useState, useRef, useEffect } from 'react';
import { RecaptchaVerifier } from 'firebase/auth';
import { t, useLang } from '../i18n';
import { maskPhone, maskPhoneForDisplay } from '../utils/phone';
import { filterOtpInput, otpErrorKey, isOtpComplete } from '../utils/otp';
import { SignupProgress } from '../components/SignupProgress';
import { clearRecaptchaVerifier } from '../utils/recaptchaLifecycle';
import { resendPhoneVerification, type PhoneVerificationSession } from '../utils/phoneAuth';

interface VerifyPhoneViewProps {
    // phone is canonical E.164, e.g. "+15555551234" or "+51987654321"
    phone: string;
    confirmationResult: PhoneVerificationSession;
    onVerify: (confirmationResult: PhoneVerificationSession) => void;
    onEditNumber: () => void;
}

/** Format seconds as m:ss for the resend countdown */
const formatCountdown = (s: number) => `0:${String(s).padStart(2, '0')}`;

export const VerifyPhoneView: React.FC<VerifyPhoneViewProps> = ({
    phone,
    confirmationResult: initialConfirmation,
    onVerify,
    onEditNumber,
}) => {
    useLang();
    const [code, setCode] = useState('');
    const [cooldown, setCooldown] = useState(30);
    const [verifying, setVerifying] = useState(false);
    const [error, setError] = useState('');
    const [confirmation, setConfirmation] = useState<PhoneVerificationSession>(initialConfirmation);
    const inputRef = useRef<HTMLInputElement>(null);
    const recaptchaRef = useRef<RecaptchaVerifier | null>(null);
    const resendingRef = useRef(false);
    const verifyingRef = useRef(false);

    const prefersReduced =
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const masked = maskPhoneForDisplay(phone);

    // Resend countdown — single timer, cleans up on unmount
    useEffect(() => {
        if (cooldown <= 0) return;
        const timer = setTimeout(() => setCooldown(c => c - 1), 1000);
        return () => clearTimeout(timer);
    }, [cooldown]);

    useEffect(() => () => clearRecaptchaVerifier(recaptchaRef), []);

    // Focus the hidden OTP input as soon as this screen mounts, so the code can be
    // typed (and pasted/autofilled) without tapping the cells first. On platforms
    // that allow programmatic focus this also opens the numeric keyboard; iOS may
    // still require a tap, which the cells' onClick already handles.
    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    // A rejected code re-enables the input on the next commit; focus it then so the
    // user can retype immediately. Keyed on the state rather than called inline in
    // the catch, because the input cannot take focus until that render lands.
    useEffect(() => {
        if (!verifying && error) inputRef.current?.focus();
    }, [verifying, error]);

    const doVerify = async (codeToVerify: string) => {
        if (verifyingRef.current) return;
        verifyingRef.current = true;
        setError('');
        setVerifying(true);
        try {
            await confirmation.confirm(codeToVerify);
            clearRecaptchaVerifier(recaptchaRef);
            onVerify(confirmation);
        } catch (e: any) {
            console.error('OTP verification failed:', e?.code);
            setError(t(otpErrorKey(e?.code ?? '')));
            // Firebase never accepts a rejected code on a retry, so the digits are
            // dead weight. Leaving them stranded was the bug: maxLength=6 meant a
            // full field silently swallowed every further keystroke, so the only
            // way out looked like going back to the phone-number step.
            setCode('');
            verifyingRef.current = false;
            setVerifying(false);
        }
    };

    const handleInput = (e: React.ChangeEvent<HTMLInputElement>) => {
        const val = filterOtpInput(e.target.value);
        setCode(val);
        if (error) setError('');
        if (isOtpComplete(val) && !verifying) {
            setTimeout(() => doVerify(val), 80);
        }
    };

    const handleVerify = () => {
        if (isOtpComplete(code) && !verifying) doVerify(code);
    };

    const handleResend = async () => {
        if (resendingRef.current) return;
        resendingRef.current = true;
        setError('');
        try {
            // phone is canonical E.164 — use directly, no stripping or prefix
            const result = await resendPhoneVerification(phone, recaptchaRef, 'recaptcha-resend');
            setConfirmation(result);
            clearRecaptchaVerifier(recaptchaRef);
            setCode('');
            setCooldown(30);
        } catch (e: any) {
            clearRecaptchaVerifier(recaptchaRef);
            console.error('Resend failed:', maskPhone(phone), e?.code);
            if (['auth/invalid-app-credential', 'auth/missing-app-credential', 'auth/captcha-check-failed'].includes(e?.code)) {
                setError(t('phone_auth.error_expired'));
            } else {
                setError(t('verify_phone.resend_failed'));
            }
        } finally {
            resendingRef.current = false;
        }
    };

    // Visual cell states derived from the code string
    const cells = Array.from({ length: 6 }, (_, i) => ({
        char: code[i] ?? '',
        focused: !verifying && !error && i === (code.length < 6 ? code.length : 5),
        filled: i < code.length,
    }));

    return (
        <div
            className="min-h-full w-full bg-[var(--color-bg)] flex flex-col px-6"
            style={{
                paddingTop: 'max(2.5rem, calc(env(safe-area-inset-top, 0px) + 1rem))',
                paddingBottom: 'max(2rem, calc(env(safe-area-inset-bottom, 0px) + 1rem))',
            }}
        >

            {/* Top nav row — matches Step 1 layout */}
            <div className="flex items-center justify-between mb-3 shrink-0">
                <div className="w-11 h-11" aria-hidden="true" />
                <span className="text-[12px] font-semibold text-[var(--color-text-secondary)] tracking-wide">
                    {t('verify_phone.step')}
                </span>
            </div>

            {/* 4-segment progress */}
            <div className="shrink-0">
                <SignupProgress step={2} />
            </div>

            {/* Content — entrance animation. shrink-0 so a short keyboard
                viewport scrolls instead of crushing the OTP row. */}
            <div className={`shrink-0 ${prefersReduced ? '' : 'auth-fade-in'}`}>

                {/* Eyebrow */}
                <p className="text-[11px] font-bold tracking-[0.13em] text-[var(--color-accent)] uppercase mb-3 mt-2">
                    {t('verify_phone.eyebrow')}
                </p>

                {/* Heading */}
                <h1 id="otp-heading" className="text-[26px] font-bold text-[var(--color-text)] leading-tight mb-2">
                    {t('verify_phone.heading')}
                </h1>

                {/* Masked phone — two-line layout keeps Edit on its own 44px row */}
                <p className="text-[15px] text-[var(--color-text-secondary)]">
                    {t('verify_phone.sent_to', { phone: masked })}
                </p>
                <button
                    type="button"
                    onClick={onEditNumber}
                    className="text-[var(--color-accent)] font-semibold text-[15px] min-h-[44px] flex items-center mb-6"
                >
                    {t('verify_phone.edit')}
                </button>

                {/* OTP group — single hidden input + 6 visual cells */}
                <div
                    role="group"
                    aria-labelledby="otp-heading"
                    className="relative flex gap-2.5 justify-center cursor-text"
                    onClick={() => inputRef.current?.focus()}
                >
                    {/* Hidden native input — drives keyboard and system OTP autocomplete */}
                    <input
                        ref={inputRef}
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        value={code}
                        onChange={handleInput}
                        maxLength={6}
                        readOnly={verifying}
                        aria-label={t('verify_phone.otp_label')}
                        className="absolute inset-0 w-full h-full opacity-0 z-10 cursor-text"
                    />

                    {/* Visual cells — presentational only */}
                    {cells.map((cell, i) => (
                        <div
                            key={i}
                            aria-hidden="true"
                            className="w-[52px] h-[56px] rounded-2xl flex items-center justify-center text-[22px] font-bold transition-colors duration-150 select-none"
                            style={{
                                background: '#0d1929',
                                border: `2px solid ${
                                    error
                                        ? 'rgba(248,113,113,0.65)'
                                        : cell.focused
                                        ? '#3b82f6'
                                        : cell.filled
                                        ? 'rgba(59,130,246,0.35)'
                                        : 'rgba(255,255,255,0.1)'
                                }`,
                                color: error ? '#f87171' : 'rgba(255,255,255,0.95)',
                                // restrained glow on focused cell — no outer halo
                                boxShadow:
                                    cell.focused && !error
                                        ? 'inset 0 0 0 1px rgba(59,130,246,0.25)'
                                        : 'none',
                            }}
                        >
                            {cell.char}
                        </div>
                    ))}
                </div>

                {/* Stable error area — reserved height prevents layout shift */}
                <div className="mt-3 min-h-[20px] flex items-center justify-center">
                    {error && (
                        <p role="alert" aria-live="assertive" className="text-[var(--color-danger)] text-[13px] text-center">
                            {error}
                        </p>
                    )}
                </div>

                {/* Resend — "Didn't get it? Resend in 0:30" → "Didn't get it? Resend code" */}
                <p className="text-center text-[14px] text-[var(--color-text-secondary)] mt-4">
                    {t('verify_phone.resend_prefix')}{' '}
                    {cooldown > 0 ? (
                        t('verify_phone.resend_cooldown', { time: formatCountdown(cooldown) })
                    ) : (
                        <button
                            type="button"
                            onClick={handleResend}
                            className="text-[var(--color-accent)] font-semibold"
                        >
                            {t('verify_phone.resend')}
                        </button>
                    )}
                </p>

                {/* Verify CTA — directly below OTP group */}
                <button
                    type="button"
                    onClick={handleVerify}
                    disabled={!isOtpComplete(code) || verifying}
                    className="w-full mt-6 mb-8 bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 active:scale-[0.98] text-white font-semibold text-[16px] py-4 rounded-full shadow-lg shadow-blue-500/30 transition-all disabled:opacity-40 disabled:active:scale-100"
                >
                    {verifying ? t('verify_phone.verifying') : t('verify_phone.verify')}
                </button>
            </div>

            <div id="recaptcha-resend" />
        </div>
    );
};
