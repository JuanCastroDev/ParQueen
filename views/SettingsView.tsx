import React, { useState, useRef, useEffect } from 'react';
import { useFocusOnMount } from '../hooks/useFocusOnMount';
import { ChevronLeft, ChevronRight, Edit, Mail, Bell, Moon, LogOut, Trash2, Check, AlertCircle, Navigation, Play, Globe, Shield, FileText, MessageCircle } from 'lucide-react';
import { t, useLang, getLang } from '../i18n';
import { doc, updateDoc } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { getApp } from 'firebase/app';
import { db } from '../firebase';
import { AppView } from '../types';
import { getNotificationsSummaryState, getLocationSummaryState } from '../utils/settingsSummary';
import type { LocationPermissionState } from '../utils/nearbyActivity';
import type { NotificationRuntimeState } from '../utils/notificationRegistration';
import { LEGAL_PATHS } from '../utils/legalRoutes';

interface SettingsViewProps {
    user: any;
    setView: (view: AppView) => void;
    onBack: () => void;
    onLogout: () => void;
    onDeleteAccount: () => void;
    theme: string;
    toggleTheme: () => void;
    permissionState?: LocationPermissionState;
    notificationRuntime?: NotificationRuntimeState | null;
}

const focusRing = 'focus-visible:ring-2 focus-visible:ring-[#38bdf8] focus-visible:outline-none';

// One row language for the whole screen: icon, title, optional detail, and a
// trailing chevron only when the row navigates somewhere.
const RowBody = ({ icon, title, detail, trailing, tone = 'primary' }: {
    icon: React.ReactNode;
    title: React.ReactNode;
    detail?: React.ReactNode;
    trailing?: React.ReactNode;
    tone?: 'primary' | 'quiet' | 'bare';
}) => (
    <>
        <span className={`pq-row-icon${tone === 'quiet' ? ' pq-row-icon--quiet' : tone === 'bare' ? ' pq-row-icon--bare' : ''}`} aria-hidden="true">{icon}</span>
        <span className="flex-1 min-w-0">
            <span className={`block ${tone === 'primary' ? 'text-[15px]' : tone === 'quiet' ? 'text-[14px]' : 'text-[13.5px]'} font-semibold text-[var(--color-text)] leading-snug`}>{title}</span>
            {detail && <span className="block mt-0.5 text-[12.5px] leading-snug text-[var(--color-text-secondary)]">{detail}</span>}
        </span>
        {trailing}
    </>
);

const Chevron = () => <ChevronRight size={17} className="pq-row-chevron shrink-0" aria-hidden="true" />;

export const SettingsView: React.FC<SettingsViewProps> = ({ user, setView, onBack, onLogout, onDeleteAccount, theme, toggleTheme, permissionState, notificationRuntime }) => {
    useLang();
    const [emailStep, setEmailStep] = useState<'view' | 'input' | 'otp'>('view');
    const [emailDraft, setEmailDraft] = useState(user?.email || '');
    const [otpDigits, setOtpDigits] = useState<string[]>(Array(6).fill(''));
    const [otpCooldown, setOtpCooldown] = useState(0);
    const [emailError, setEmailError] = useState('');
    const [emailSending, setEmailSending] = useState(false);
    const otpRefs = useRef<(HTMLInputElement | null)[]>([]);
    const headingRef = useRef<HTMLHeadingElement>(null);
    useFocusOnMount(headingRef);

    useEffect(() => {
        if (otpCooldown <= 0) return;
        const timer = setTimeout(() => setOtpCooldown(c => c - 1), 1000);
        return () => clearTimeout(timer);
    }, [otpCooldown]);

    const handleSendEmailOTP = async () => {
        setEmailError('');
        setEmailSending(true);
        try {
            const functions = getFunctions(getApp(), 'us-central1');
            await httpsCallable(functions, 'generateEmailOTP')({ email: emailDraft.trim() });
            setEmailStep('otp');
            setOtpDigits(Array(6).fill(''));
            setOtpCooldown(60);
        } catch (e: any) {
            setEmailError(e.details || e.message || t('settings.email_send_failed'));
        } finally {
            setEmailSending(false);
        }
    };

    const handleVerifyEmailOTP = async () => {
        setEmailError('');
        setEmailSending(true);
        try {
            const functions = getFunctions(getApp(), 'us-central1');
            await httpsCallable(functions, 'verifyEmailOTP')({ email: emailDraft.trim(), code: otpDigits.join('') });
            setEmailStep('view');
        } catch (e: any) {
            setEmailError(e.details || e.message || t('settings.email_verify_failed'));
        } finally {
            setEmailSending(false);
        }
    };

    const handleOtpChange = (index: number, value: string) => {
        if (!/^\d*$/.test(value)) return;
        const next = [...otpDigits];
        next[index] = value.slice(-1);
        setOtpDigits(next);
        if (value && index < 5) otpRefs.current[index + 1]?.focus();
    };

    const handleOtpKeyDown = (index: number, e: React.KeyboardEvent) => {
        if (e.key === 'Backspace' && !otpDigits[index] && index > 0) otpRefs.current[index - 1]?.focus();
    };

    const notifSummary = getNotificationsSummaryState(
        user?.notificationsEnabled ?? true,
        user?.notificationRadius ?? 1,
        notificationRuntime,
    );
    const locSummary = permissionState
        ? getLocationSummaryState(permissionState, user?.sharePreciseLocation ?? true)
        : null;
    const isDark = theme === 'dark';

    // Inset ring: grouped surfaces clip overflow, so an outer ring would lose its sides.
    const rowClass = `pq-settings-row w-full flex items-center gap-3.5 px-4 py-3 text-left ${focusRing} focus-visible:ring-inset`;

    return (
        <div className="pq-settings mobile-safe-top md:pt-4 min-h-full bg-[var(--color-bg)] text-[var(--color-text)] px-4 pb-12">
            <div className="max-w-md mx-auto flex flex-col">

                {/* Header — same icon-button language and centred title as Profile.
                    Settings is a pushed screen, so it keeps its Back control. */}
                <header className="relative flex items-center justify-center h-11">
                    <button
                        onClick={onBack}
                        aria-label={t('settings.back_aria')}
                        className={`pq-icon-btn absolute left-0 top-0 bg-[var(--color-overlay)] border border-[var(--color-border)] ${focusRing}`}
                    >
                        <ChevronLeft size={20} aria-hidden="true" />
                    </button>
                    <h1 ref={headingRef} tabIndex={-1} className="text-[17px] font-extrabold tracking-tight focus:outline-none">
                        {t('settings.title')}
                    </h1>
                </header>

                {/* ── Account ────────────────────────────────────────────── */}
                <section aria-labelledby="pq-set-account" className="mt-6">
                    <h2 id="pq-set-account" className="pq-group-label">{t('settings.section_account')}</h2>
                    <div className="pq-group">
                        <button onClick={() => setView(AppView.EDIT_PROFILE)} className={rowClass}>
                            <RowBody icon={<Edit size={17} />} title={t('settings.edit_profile')} detail={t('settings.edit_profile_subtitle')} trailing={<Chevron />} />
                        </button>

                        {/* Email: view → input → one-time code, exactly as before. */}
                        {emailStep === 'otp' ? (
                            <div className="pq-settings-row px-4 py-4">
                                <div className="flex items-center gap-3.5 mb-4">
                                    <span className="pq-row-icon" aria-hidden="true"><Mail size={17} /></span>
                                    <span className="min-w-0">
                                        <span className="block text-[15px] font-semibold">{t('settings.email_enter_code')}</span>
                                        <span className="block mt-0.5 text-[12.5px] text-[var(--color-text-secondary)] break-all">{t('settings.email_sent_to', { email: emailDraft })}</span>
                                    </span>
                                </div>
                                <div className="flex gap-2 justify-center mb-3">
                                    {otpDigits.map((d, i) => (
                                        <input key={i} ref={el => { otpRefs.current[i] = el; }} type="text" inputMode="numeric" maxLength={1} value={d}
                                            onChange={e => handleOtpChange(i, e.target.value)} onKeyDown={e => handleOtpKeyDown(i, e)}
                                            aria-label={t('settings.email_code_digit', { n: i + 1 })}
                                            className="pq-settings-input w-11 h-12 text-center text-lg font-bold"
                                            autoFocus={i === 0} />
                                    ))}
                                </div>
                                {emailError && <p role="alert" className="pq-inline-note pq-inline-note--error mb-2">{emailError}</p>}
                                <div className="flex items-center justify-between mb-3">
                                    <button onClick={() => setEmailStep('input')} className={`min-h-[44px] px-1 text-[13px] text-[var(--color-text-secondary)] rounded-lg ${focusRing}`}>{t('settings.email_back')}</button>
                                    <p className="text-[13px] text-[var(--color-text-secondary)]">
                                        {otpCooldown > 0
                                            ? t('settings.email_resend_in', { seconds: otpCooldown })
                                            : <button onClick={handleSendEmailOTP} className={`pq-accent-text min-h-[44px] px-1 font-semibold rounded-lg ${focusRing}`}>{t('settings.email_resend')}</button>}
                                    </p>
                                </div>
                                <button onClick={handleVerifyEmailOTP} disabled={otpDigits.some(d => !d) || emailSending}
                                    className={`pq-settings-primary w-full h-12 rounded-2xl font-bold text-white text-[15px] disabled:opacity-40 ${focusRing}`}>
                                    {emailSending ? t('settings.email_verifying') : t('settings.email_verify')}
                                </button>
                            </div>
                        ) : emailStep === 'input' ? (
                            <div className="pq-settings-row px-4 py-3">
                                <div className="flex items-center gap-3">
                                    <span className="pq-row-icon" aria-hidden="true"><Mail size={17} /></span>
                                    <input type="email" value={emailDraft} onChange={(e) => setEmailDraft(e.target.value)}
                                        placeholder={t('settings.email_placeholder')} aria-label={t('settings.email_address')}
                                        className="pq-settings-input flex-1 min-w-0 h-11 px-3 text-[16px]" autoFocus />
                                    <button onClick={handleSendEmailOTP} disabled={!emailDraft.includes('@') || emailSending}
                                        className={`pq-accent-text min-h-[44px] px-1 font-bold text-[13px] shrink-0 disabled:opacity-40 rounded-lg ${focusRing}`}>
                                        {emailSending ? t('settings.email_sending') : t('settings.email_send_code')}
                                    </button>
                                </div>
                                {emailError && <p role="alert" className="pq-inline-note pq-inline-note--error mt-2 text-left pl-[50px]">{emailError}</p>}
                            </div>
                        ) : (
                            <button onClick={() => setEmailStep('input')} className={rowClass}>
                                <RowBody
                                    icon={<Mail size={17} />}
                                    title={
                                        <span className="flex items-center gap-2 flex-wrap">
                                            {t('settings.email_address')}
                                            {user?.email && user?.emailVerified && (
                                                <span className="pq-badge pq-badge--ok"><Check size={11} aria-hidden="true" />{t('settings.email_verified')}</span>
                                            )}
                                            {user?.email && !user?.emailVerified && (
                                                <span className="pq-badge pq-badge--warn"><AlertCircle size={11} aria-hidden="true" />{t('settings.email_unverified')}</span>
                                            )}
                                        </span>
                                    }
                                    detail={<span className="pq-settings-email block truncate" title={user?.email || undefined}>{user?.email || t('settings.email_add')}</span>}
                                    trailing={<Chevron />}
                                />
                            </button>
                        )}
                    </div>
                </section>

                {/* ── Preferences ────────────────────────────────────────── */}
                <section aria-labelledby="pq-set-prefs" className="mt-7">
                    <h2 id="pq-set-prefs" className="pq-group-label">{t('settings.section_preferences')}</h2>
                    <div className="pq-group">
                        <button onClick={() => setView(AppView.NOTIFICATIONS_SETTINGS)} className={rowClass}>
                            <RowBody
                                icon={<Bell size={17} />}
                                title={t('settings.notifications')}
                                detail={<>{t(notifSummary.statusKey)}{notifSummary.showRadius && `${t('settings.location_summary_separator')}${notifSummary.radius} mi`}</>}
                                trailing={<Chevron />}
                            />
                        </button>

                        <button onClick={() => setView(AppView.LOCATION_SETTINGS)} className={rowClass}>
                            <RowBody
                                icon={<Navigation size={17} />}
                                title={t('settings.location')}
                                detail={locSummary && <>{t(locSummary.permissionKey)}{locSummary.preciseKey && `${t('settings.location_summary_separator')}${t(locSummary.preciseKey)}`}</>}
                                trailing={<Chevron />}
                            />
                        </button>

                        {/* The whole row is the switch — a 56px target with a real
                            switch role, name and state. */}
                        <button role="switch" aria-checked={isDark} aria-label={t('settings.dark_theme')} onClick={toggleTheme} className={rowClass}>
                            <RowBody
                                icon={<Moon size={17} />}
                                title={t('settings.dark_theme')}
                                detail={t('settings.dark_theme_subtitle')}
                                trailing={<span className={`pq-switch${isDark ? ' pq-switch--on' : ''}`} aria-hidden="true"><span className="pq-switch-thumb" /></span>}
                            />
                        </button>

                        <button onClick={() => setView(AppView.LANGUAGE_SETTINGS)} className={rowClass}>
                            <RowBody
                                icon={<Globe size={17} />}
                                title={t('settings.language')}
                                detail={getLang() === 'en' ? t('settings.language_english') : t('settings.language_spanish')}
                                trailing={<Chevron />}
                            />
                        </button>
                    </div>
                </section>

                {/* ── Help & Support — open list, lighter than the groups ─── */}
                <section aria-labelledby="pq-set-help" className="mt-7">
                    <h2 id="pq-set-help" className="pq-group-label">{t('settings.section_help')}</h2>
                    <div className="pq-plain-list">
                        <button
                            onClick={() => {
                                localStorage.removeItem('parqueenAppTourSeen_v1');
                                setView(AppView.MAP);
                            }}
                            className={`${rowClass} px-1`}
                        >
                            <RowBody tone="quiet" icon={<Play size={16} />} title={t('tour.replay_label')} detail={t('tour.replay_subtitle')} trailing={<Chevron />} />
                        </button>
                        <button onClick={() => setView(AppView.CONTACT_US)} className={`${rowClass} px-1`}>
                            <RowBody tone="quiet" icon={<MessageCircle size={16} />} title={t('profile.contact_us')} detail={t('profile.contact_subtitle')} trailing={<Chevron />} />
                        </button>
                    </div>
                </section>

                {/* ── Legal — lightest weight ─────────────────────────────── */}
                <section aria-labelledby="pq-set-legal" className="mt-7">
                    <h2 id="pq-set-legal" className="pq-group-label">{t('settings.section_legal')}</h2>
                    <div className="pq-plain-list pq-plain-list--legal">
                        <a
                            href={LEGAL_PATHS.privacy}
                            onClick={event => {
                                event.preventDefault();
                                setView(AppView.PRIVACY_POLICY);
                            }}
                            className={`${rowClass} px-1`}
                        >
                            <RowBody tone="bare" icon={<Shield size={16} />} title={t('profile.privacy_policy')} detail={t('profile.privacy_policy_subtitle')} trailing={<Chevron />} />
                        </a>
                        <a
                            href={LEGAL_PATHS.terms}
                            onClick={event => {
                                event.preventDefault();
                                setView(AppView.TERMS_OF_USE);
                            }}
                            className={`${rowClass} px-1`}
                        >
                            <RowBody tone="bare" icon={<FileText size={16} />} title={t('profile.terms_of_use')} detail={t('profile.terms_subtitle')} trailing={<Chevron />} />
                        </a>
                    </div>
                </section>

                {/* ── Account actions — set apart from ordinary settings ──── */}
                <section aria-labelledby="pq-set-actions" className="mt-9">
                    <h2 id="pq-set-actions" className="sr-only">{t('settings.section_account_actions')}</h2>
                    <button onClick={onLogout} className={`pq-signout w-full min-h-[52px] rounded-2xl flex items-center justify-center gap-2 text-[15px] font-semibold ${focusRing}`}>
                        <LogOut size={17} aria-hidden="true" />
                        {t('settings.logout')}
                    </button>
                    <button onClick={onDeleteAccount} className={`pq-danger-link w-full min-h-[44px] mt-3 rounded-xl flex flex-col items-center justify-center text-center ${focusRing}`}>
                        <span className="flex items-center gap-1.5 text-[13.5px] font-semibold"><Trash2 size={14} aria-hidden="true" />{t('settings.delete_account')}</span>
                        <span className="text-[11.5px] text-[var(--color-text-secondary)] mt-0.5">{t('settings.delete_account_subtitle')}</span>
                    </button>
                </section>

            </div>
        </div>
    );
};
