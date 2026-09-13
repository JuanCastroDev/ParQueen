import React, { useState, useEffect, useRef } from 'react';
import { RecaptchaVerifier } from 'firebase/auth';
import { t, useLang } from '../i18n';
import { Shield, Loader2 } from 'lucide-react';
import { SignupProgress } from '../components/SignupProgress';
import { CountrySelector } from '../components/CountrySelector';
import {
    parseNationalToE164,
    parseInternationalPaste,
    isNANPCountry,
    maskPhone,
} from '../utils/phone';
import type { CountryCode } from '../utils/phone';
import { clearRecaptchaVerifier } from '../utils/recaptchaLifecycle';
import { LEGAL_PATHS } from '../utils/legalRoutes';
import type { PublicLegalDocument } from '../utils/legalRoutes';
import {
    preparePhoneAuth,
    startPhoneVerification,
    type PhoneVerificationSession,
} from '../utils/phoneAuth';

interface CreateAccountViewProps {
    onContinue: (phoneE164: string, confirmationResult: PhoneVerificationSession) => void;
    onOpenLegal?: (document: PublicLegalDocument) => void;
}

const NANP_PLACEHOLDERS: Partial<Record<string, string>> = {
    US: '(555) 555-1234',
    CA: '(555) 555-1234',
    PR: '(787) 555-1234',
    DO: '(809) 555-1234',
};
const NON_NANP_PLACEHOLDERS: Partial<Record<string, string>> = {
    MX: '55 1234 5678',
    PE: '987 654 321',
    GB: '07911 123456',
};

function formatNANP(digits: string): string {
    if (digits.length <= 3) return digits;
    if (digits.length <= 6) return `(${digits.slice(0, 3)}) ${digits.slice(3)}`;
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

export const CreateAccountView: React.FC<CreateAccountViewProps> = ({ onContinue, onOpenLegal }) => {
    useLang();
    const [selectedCountry, setSelectedCountry] = useState<CountryCode>('US');
    const [nationalInput, setNationalInput] = useState('');
    const [sending, setSending] = useState(false);
    const [error, setError] = useState('');
    const recaptchaRef = useRef<RecaptchaVerifier | null>(null);
    const sendingRef = useRef(false);

    const prefersReduced =
        typeof window !== 'undefined' &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const phoneE164 = parseNationalToE164(nationalInput, selectedCountry);
    const isValid = phoneE164 !== null;

    const displayValue = isNANPCountry(selectedCountry)
        ? formatNANP(nationalInput)
        : nationalInput;

    const placeholder =
        NANP_PLACEHOLDERS[selectedCountry] ??
        NON_NANP_PLACEHOLDERS[selectedCountry] ??
        '';

    useEffect(() => preparePhoneAuth(recaptchaRef, 'recaptcha-container'), []);

    const handleCountryChange = (country: CountryCode) => {
        setSelectedCountry(country);
        // Preserve digits; validity recomputes automatically for the new country
        setError('');
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const raw = e.target.value.replace(/\D/g, '');
        setNationalInput(raw.slice(0, 15));
        if (error) setError('');
    };

    const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
        const pasted = e.clipboardData.getData('text').trim();
        if (!pasted.startsWith('+')) return; // let normal change handler run
        e.preventDefault();
        const result = parseInternationalPaste(pasted, selectedCountry);
        if (result.unsupported) {
            setError(t('create_account.error_unsupported'));
            return;
        }
        setSelectedCountry(result.country);
        setNationalInput(result.nationalNumber.replace(/\D/g, '').slice(0, 15));
        setError('');
    };

    const handleSend = async () => {
        if (!phoneE164 || sendingRef.current) return;
        sendingRef.current = true;
        setError('');
        setSending(true);
        try {
            const result = await startPhoneVerification(phoneE164, recaptchaRef, 'recaptcha-container');
            onContinue(phoneE164, result);
            clearRecaptchaVerifier(recaptchaRef);
        } catch (e: any) {
            clearRecaptchaVerifier(recaptchaRef);
            // Log masked — never log full phone
            console.error('Send OTP failed:', maskPhone(phoneE164), e?.code);
            if (e.code === 'auth/too-many-requests') setError(t('create_account.error_too_many'));
            else if (e.code === 'auth/invalid-phone-number') setError(t('create_account.error_invalid'));
            else if (['auth/invalid-app-credential', 'auth/missing-app-credential', 'auth/captcha-check-failed'].includes(e?.code)) {
                setError(t('phone_auth.error_expired'));
            } else setError(t('create_account.error_generic'));
        } finally {
            sendingRef.current = false;
            setSending(false);
        }
    };

    const openLegal = (document: PublicLegalDocument, event: React.MouseEvent<HTMLAnchorElement>) => {
        if (!onOpenLegal) return;
        event.preventDefault();
        onOpenLegal(document);
    };

    return (
        <div
            className="min-h-full w-full bg-[var(--color-bg)] flex flex-col px-6"
            style={{
                paddingTop: 'max(2.5rem, calc(env(safe-area-inset-top, 0px) + 1rem))',
                paddingBottom: 'max(2rem, calc(env(safe-area-inset-bottom, 0px) + 1rem))',
            }}
        >

            {/* Top nav row — no visible Back on Step 1 */}
            <div className="flex items-center justify-between mb-3 shrink-0">
                {/* Left spacer keeps "Step 1 of 4" right-aligned without visual shift */}
                <div className="w-11 h-11" aria-hidden="true" />
                <span className="text-[12px] font-semibold text-[var(--color-text-secondary)] tracking-wide">
                    {t('create_account.step')}
                </span>
            </div>

            {/* 4-segment progress */}
            <div className="shrink-0">
                <SignupProgress step={1} />
            </div>

            {/* Content block — entrance animation. shrink-0 so the keyboard
                cannot vertically crush the phone field or trust copy. */}
            <div className={`shrink-0 ${prefersReduced ? '' : 'auth-fade-in'}`}>

                {/* Eyebrow */}
                <p className="text-[11px] font-bold tracking-[0.13em] text-[var(--color-accent)] uppercase mb-3 mt-2">
                    {t('create_account.eyebrow')}
                </p>

                {/* Headline */}
                <h1 className="text-[26px] font-bold text-[var(--color-text)] leading-tight mb-2">
                    {t('create_account.headline')}
                </h1>

                {/* Supporting */}
                <p className="text-[15px] text-[var(--color-text-secondary)] leading-relaxed mb-8">
                    {t('create_account.supporting')}
                </p>

                {/* Phone input */}
                <label
                    className="block text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--color-text-secondary)] mb-2"
                    htmlFor="phone-input"
                >
                    {t('create_account.label')}
                </label>
                <div
                    className={`flex items-center bg-[var(--color-card)] border rounded-[18px] transition-all duration-[180ms] ${
                        error
                            ? 'border-red-500/70 shadow-[0_0_0_3px_rgba(239,68,68,0.15)]'
                            : 'border-[var(--color-border)] focus-within:border-blue-500 focus-within:shadow-[0_0_0_3px_rgba(30,117,255,0.18)]'
                    }`}
                    style={{ height: 58 }}
                >
                    {/* Country selector — opens searchable bottom sheet */}
                    <CountrySelector
                        selected={selectedCountry}
                        onChange={handleCountryChange}
                    />

                    <input
                        id="phone-input"
                        type="tel"
                        inputMode="tel"
                        autoComplete="tel"
                        aria-label={t('create_account.label')}
                        aria-describedby={error ? 'phone-error' : 'phone-trust'}
                        aria-invalid={!!error}
                        value={displayValue}
                        onChange={handleChange}
                        onPaste={handlePaste}
                        onFocus={event => event.currentTarget.scrollIntoView({ block: 'center', inline: 'nearest' })}
                        placeholder={placeholder}
                        className="flex-1 bg-transparent px-4 h-full text-[var(--color-text)] font-semibold outline-none placeholder-[var(--color-text-secondary)] text-[16px]"
                    />
                </div>

                {/* Error or trust note */}
                {error ? (
                    <p id="phone-error" role="alert" className="text-[var(--color-danger)] text-[13px] mt-2 font-medium">
                        {error}
                    </p>
                ) : (
                    <p id="phone-trust" className="flex items-center gap-1.5 text-[12px] text-[var(--color-text-secondary)] mt-2.5">
                        <Shield size={12} className="shrink-0 opacity-60" />
                        {t('create_account.trust')}
                    </p>
                )}
            </div>

            {/* Flexible gap — shrinks on short/keyboard viewports instead of
                compressing the form. Parent overflow-y-auto then scrolls. */}
            <div className="flex-1 min-h-4" />

            {/* CTA */}
            <div className="shrink-0 pb-2">
                <button
                    onClick={handleSend}
                    disabled={!isValid || sending}
                    aria-busy={sending}
                    className={`w-full font-bold text-[16px] rounded-full flex items-center justify-center gap-2 transition-all duration-[160ms] ${
                        isValid && !sending
                            ? 'bg-gradient-to-r from-blue-600 to-cyan-500 hover:from-blue-500 hover:to-cyan-400 active:scale-[0.985] text-white shadow-lg shadow-blue-500/25'
                            : 'text-white/45 cursor-not-allowed'
                    }`}
                    style={{
                        height: 58,
                        ...((!isValid || sending) && { background: 'rgba(20, 40, 80, 0.55)' }),
                    }}
                >
                    {sending ? (
                        <>
                            <Loader2 size={18} className="animate-spin" />
                            {t('create_account.sending')}
                        </>
                    ) : (
                        t('create_account.send')
                    )}
                </button>
                <p className="mt-3 text-center text-[11px] leading-relaxed text-[var(--color-text-secondary)]">
                    {t('legal.signup_prefix')}{' '}
                    <a
                        href={LEGAL_PATHS.terms}
                        onClick={event => openLegal('terms', event)}
                        className="font-semibold text-[var(--color-info)] hover:underline"
                    >
                        {t('legal.terms')}
                    </a>{' '}
                    {t('legal.signup_between')}{' '}
                    <a
                        href={LEGAL_PATHS.privacy}
                        onClick={event => openLegal('privacy', event)}
                        className="font-semibold text-[var(--color-info)] hover:underline"
                    >
                        {t('legal.privacy')}
                    </a>.
                </p>
            </div>

            <div id="recaptcha-container" />
        </div>
    );
};
