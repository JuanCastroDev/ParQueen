import React, { useState, useEffect, useRef } from 'react';
import { Car, CheckCircle2, XCircle, Users, MapPin, Clock, HelpCircle, Crown, Bell, ChevronLeft } from 'lucide-react';
import { TimePicker } from './TimePicker';
import { t, useLang } from '../../i18n';
import { HANDOFF_FAILURE_REASONS } from '../../utils/spotFeedback';

const FAILURE_REASON_ICONS = [Users, Clock, MapPin, HelpCircle] as const;
const FAILURE_REASONS = HANDOFF_FAILURE_REASONS.map((label, index) => ({
    label,
    icon: FAILURE_REASON_ICONS[index],
}));

const REMINDER_OPTIONS = [
    { label: '30 min', minutes: 30 },
    { label: '1 hr', minutes: 60 },
    { label: '2 hr', minutes: 120 },
];

interface HandoffFlowProps {
    step: 'outcome' | 'celebration' | 'failure_reason';
    finderName?: string | null;
    onOutcome: (outcome: 'success' | 'failed') => void;
    onFailureReason: (reason: string) => void;
    onSetTimer: (minutes: number) => void;
    onSkip: () => void;
    /** Set when the terminal write was rejected. Stays inside this sheet. */
    submitError?: string | null;
    submitting?: boolean;
    onRetry?: () => void;
}

export const HandoffFlow: React.FC<HandoffFlowProps> = ({
    step, finderName, onOutcome, onFailureReason, onSetTimer, onSkip,
    submitError = null, submitting = false, onRetry,
}) => {
    useLang();
    const [submitted, setSubmitted] = useState(false);
    const [timerSet, setTimerSet] = useState(false);
    const [showCustom, setShowCustom] = useState(false);
    const [customTime, setCustomTime] = useState<Date>(() => {
        const d = new Date();
        d.setHours(d.getHours() + 2, 0, 0, 0);
        return d;
    });
    const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // Stable ref so the auto-close timeout always calls the latest onSkip
    const onSkipRef = useRef(onSkip);
    onSkipRef.current = onSkip;

    useEffect(() => {
        if (submitError) setSubmitted(false);
    }, [submitError]);

    useEffect(() => {
        if (step === 'celebration') {
            setTimerSet(false);
            setShowCustom(false);
            const d = new Date();
            d.setHours(d.getHours() + 2, 0, 0, 0);
            setCustomTime(d);
        }
        return () => {
            if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
        };
    }, [step]);

    // Auto-close 1.5s after reminder confirmation
    useEffect(() => {
        if (!timerSet) return;
        closeTimerRef.current = setTimeout(() => onSkipRef.current(), 1500);
        return () => {
            if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
        };
    }, [timerSet]);

    const handleSetTimer = (minutes: number) => {
        onSetTimer(minutes);
        setTimerSet(true);
    };

    const handleSetCustomTimer = () => {
        const minutes = Math.max(1, Math.round((customTime.getTime() - Date.now()) / 60000));
        handleSetTimer(minutes);
    };

    const submissionStatus = (submitting || submitError) ? (
        <div className="mt-4">
            {submitting && (
                <p data-testid="handoff-submit-pending" className="text-sm text-center text-[var(--color-text-secondary)]">
                    {t('handoff.submit_saving')}
                </p>
            )}
            {submitError && !submitting && (
                <div role="alert" data-testid="handoff-submit-error" className="rounded-2xl border border-[var(--color-danger)]/40 bg-[var(--color-danger)]/10 px-4 py-3 text-center">
                    <p className="text-sm font-semibold text-[var(--color-text)]">{submitError}</p>
                    {onRetry && (
                        <button
                            type="button"
                            data-testid="handoff-submit-retry"
                            onClick={onRetry}
                            className="mt-3 w-full py-3 rounded-2xl text-sm font-bold text-white transition-all active:scale-95"
                            style={{ background: 'linear-gradient(90deg, var(--color-brand), var(--color-brand-2))' }}
                        >
                            {t('handoff.submit_retry')}
                        </button>
                    )}
                </div>
            )}
        </div>
    ) : null;

    if (step === 'outcome') {
        return (
            <div className="text-center">
                <div className="flex justify-center mb-5">
                    <div className="w-20 h-20 rounded-3xl flex items-center justify-center"
                        style={{ background: 'linear-gradient(135deg, #1e75ff22, #0ea5e922)', border: '1.5px solid #1e75ff44' }}>
                        <Car size={38} className="text-[var(--color-info)]" />
                    </div>
                </div>
                <h3 className="font-extrabold text-xl text-[var(--color-text)] mb-1">Did you get the spot?</h3>
                <p className="text-sm text-[var(--color-text-secondary)] mb-6">Let us know how it went</p>
                <div className="flex gap-3">
                    <button
                        onClick={() => { if (!submitted) { setSubmitted(true); onOutcome('success'); } }}
                        disabled={submitted}
                        className="flex-1 py-3.5 rounded-2xl text-sm font-bold text-white flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-50"
                        style={{ background: 'linear-gradient(90deg, var(--color-brand), var(--color-brand-2))' }}
                    >
                        <CheckCircle2 size={16} />
                        Yes, I'm in!
                    </button>
                    <button
                        onClick={() => { if (!submitted) { setSubmitted(true); onOutcome('failed'); } }}
                        disabled={submitted}
                        className="flex-1 py-3.5 rounded-2xl text-sm font-bold border border-[var(--color-border)] bg-white/5 hover:bg-white/10 transition-all active:scale-95 text-[var(--color-text)] flex items-center justify-center gap-2 disabled:opacity-50"
                    >
                        <XCircle size={16} className="text-[var(--color-danger)]" />
                        No luck
                    </button>
                </div>
                {submissionStatus}
            </div>
        );
    }

    if (step === 'celebration') {
        const hero = (
            <div className="rounded-3xl p-5 mb-6 text-center relative overflow-hidden"
                style={{ background: 'linear-gradient(135deg, #1e75ff18, #0ea5e918)', border: '1.5px solid #1e75ff33' }}>
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div className="w-32 h-32 rounded-full opacity-10" style={{ background: 'radial-gradient(circle, #1e75ff, transparent)' }} />
                </div>
                <div className="flex justify-center mb-3 relative">
                    <div className="w-20 h-20 rounded-3xl flex items-center justify-center"
                        style={{ background: 'linear-gradient(135deg, var(--color-brand), var(--color-brand-2))' }}>
                        <Car size={36} className="text-white" />
                    </div>
                </div>
                <h3 className="font-extrabold text-2xl text-[var(--color-text)] mb-1">{t('handoff.youre_parked')}</h3>
                <p className="text-sm text-[var(--color-text-secondary)]">
                    {finderName
                        ? t('handoff.finder_helped').replace('{name}', finderName)
                        : t('handoff.finder_helped_anon')}
                </p>
                <div className="flex items-center justify-center gap-1.5 mt-2 mb-3">
                    <Crown size={13} className="text-[var(--color-warning)]" />
                    <p className="text-[11px] font-bold text-[var(--color-warning)]">{t('handoff.crown_earned')}</p>
                </div>
                <div className="pt-3 border-t border-white/10">
                    <div className="flex items-center justify-center gap-1.5 mb-0.5">
                        <Car size={11} className="text-[var(--color-info)]" />
                        <p className="text-[11px] font-bold text-[var(--color-info)] uppercase tracking-widest">{t('handoff.saved_to_my_car')}</p>
                    </div>
                    <p className="text-[11px] text-[var(--color-text-secondary)] leading-relaxed">{t('handoff.saved_to_my_car_body')}</p>
                </div>
            </div>
        );

        // Confirmation shown after any reminder is set — auto-closes via useEffect
        if (timerSet) {
            return (
                <div>
                    {hero}
                    <div className="rounded-2xl bg-emerald-500/10 border border-emerald-500/20 p-4 mb-4">
                        <div className="flex items-center gap-2 mb-1">
                            <CheckCircle2 size={14} className="text-[var(--color-success)]" />
                            <p className="text-sm font-bold text-[var(--color-success)]">{t('handoff.reminder_set')}</p>
                        </div>
                        <p className="text-xs text-[var(--color-text-secondary)] leading-relaxed">{t('handoff.reminder_set_body')}</p>
                    </div>
                </div>
            );
        }

        // Custom time picker sub-screen
        if (showCustom) {
            return (
                <div>
                    {hero}
                    <div className="flex items-center gap-1.5 mb-4">
                        <Bell size={12} className="text-[var(--color-text-secondary)]" />
                        <p className="text-[11px] font-bold text-[var(--color-text-secondary)] uppercase tracking-widest">{t('handoff.reminder_title')}</p>
                    </div>
                    <TimePicker initialTime={customTime} onTimeChange={setCustomTime} />
                    <button
                        onClick={handleSetCustomTimer}
                        className="w-full mt-5 py-3.5 rounded-2xl text-sm font-bold text-white transition-all active:scale-95"
                        style={{ background: 'linear-gradient(90deg, var(--color-brand), var(--color-brand-2))' }}
                    >
                        {t('handoff.reminder_set_button')}
                    </button>
                    <button
                        onClick={() => setShowCustom(false)}
                        className="w-full mt-2 py-2.5 text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-all flex items-center justify-center gap-1"
                    >
                        <ChevronLeft size={13} />
                        Back
                    </button>
                </div>
            );
        }

        // Main celebration screen
        return (
            <div>
                {hero}
                <div className="flex items-center gap-1.5 mb-3">
                    <Bell size={12} className="text-[var(--color-text-secondary)]" />
                    <p className="text-[11px] font-bold text-[var(--color-text-secondary)] uppercase tracking-widest">{t('handoff.reminder_title')}</p>
                </div>
                <div className="grid grid-cols-2 gap-2 mb-3">
                    {REMINDER_OPTIONS.map(opt => (
                        <button
                            key={opt.minutes}
                            onClick={() => handleSetTimer(opt.minutes)}
                            className="py-3 rounded-2xl text-xs font-bold border border-[var(--color-border)] bg-white/5 hover:bg-white/10 transition-all active:scale-95 text-[var(--color-text)]"
                        >
                            {opt.label}
                        </button>
                    ))}
                    <button
                        onClick={() => setShowCustom(true)}
                        className="py-3 rounded-2xl text-xs font-bold border border-[var(--color-border)] bg-white/5 hover:bg-white/10 transition-all active:scale-95 text-[var(--color-text-secondary)]"
                    >
                        {t('handoff.reminder_custom')}
                    </button>
                </div>
                <p className="text-[11px] text-center text-[var(--color-text-secondary)] mb-4 leading-relaxed px-2">
                    {t('handoff.pay_it_forward_body')}
                </p>
                <button
                    onClick={onSkip}
                    className="w-full py-2.5 text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-all"
                >
                    {t('my_car.not_now')}
                </button>
            </div>
        );
    }

    if (step === 'failure_reason') {
        return (
            <div>
                <div className="flex justify-center mb-4">
                    <div className="w-16 h-16 rounded-2xl flex items-center justify-center"
                        style={{ background: 'rgba(239,68,68,0.12)', border: '1.5px solid rgba(239,68,68,0.25)' }}>
                        <XCircle size={30} className="text-[var(--color-danger)]" />
                    </div>
                </div>
                <h3 className="font-extrabold text-xl text-[var(--color-text)] mb-1 text-center">What happened?</h3>
                <p className="text-sm text-[var(--color-text-secondary)] mb-5 text-center">This helps us improve the experience</p>
                <div className="space-y-2">
                    {FAILURE_REASONS.map(({ label, icon: Icon }) => (
                        <button
                            key={label}
                            type="button"
                            disabled={submitting}
                            onClick={() => onFailureReason(label)}
                            className="handoff-failure-reason w-full py-3 px-4 rounded-2xl text-sm font-semibold border border-[var(--color-border)] bg-white/5 hover:bg-white/10 transition-all active:scale-95 text-[var(--color-text)] flex items-center gap-3 disabled:opacity-50"
                        >
                            <div className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
                                style={{ background: 'rgba(30,117,255,0.12)', border: '1px solid rgba(30,117,255,0.2)' }}>
                                <Icon size={15} className="text-[var(--color-info)]" />
                            </div>
                            {label}
                        </button>
                    ))}
                </div>
                {submissionStatus}
            </div>
        );
    }

    return null;
};
