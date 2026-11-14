import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Check, X, Loader2 } from 'lucide-react';
import { getApp } from 'firebase/app';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { db } from '../firebase';
import { doc, getDoc } from 'firebase/firestore';
import { t, useLang } from '../i18n';
import { SignupProgress } from '../components/SignupProgress';
import { ONBOARDING_V2_ENABLED } from '../utils/onboardingFlags';
import { validateUsername, parseCooldownDays } from '../utils/username';
import { moderateUsername } from '../utils/moderation';
import { reportCriticalActionFailure } from '../utils/errorReporting';

// Evaluated once at module load — same pattern as CreateAccountView / LocationPromptView
const prefersReduced =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

interface NameEntryViewProps {
    // Username is required in this release.
    // Product decision: "Username is required during account setup until personal-only
    // access and community-action gating are implemented."
    onComplete: (username: string) => void;
}

type Availability = 'idle' | 'checking' | 'available' | 'taken' | 'invalid' | 'network';

export const NameEntryView: React.FC<NameEntryViewProps> = ({ onComplete }) => {
    useLang();
    const [username, setUsername] = useState('');
    const [availability, setAvailability] = useState<Availability>('idle');
    const [statusMsg, setStatusMsg] = useState('');
    const [claimError, setClaimError] = useState('');
    const [submitting, setSubmitting] = useState(false);

    // Stale-response guard — incremented on every new debounce dispatch
    const genRef = useRef(0);
    // Cache of the last successfully resolved check {norm, result} — avoids redundant reads.
    // Only populated after a real Firestore response; cleared on network failure so retry works.
    const lastConfirmedRef = useRef<{ norm: string; result: 'available' | 'taken' } | null>(null);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        setClaimError('');

        const trimmed = username.trim();

        if (!trimmed) {
            setAvailability('idle');
            setStatusMsg('');
            return;
        }

        // Format validation — mirrors claimUsername CF rules exactly, operates on trimmed value
        const validationKey = validateUsername(trimmed);
        if (validationKey) {
            setAvailability('invalid');
            setStatusMsg(t(validationKey));
            return;
        }

        // Content moderation — shared production helper, not duplicated here
        const moderationError = moderateUsername(trimmed);
        if (moderationError) {
            setAvailability('invalid');
            setStatusMsg(moderationError);
            return;
        }

        // Normalize for Firestore lookup — same logic as claimUsername CF
        const norm = trimmed.toLowerCase();

        // Use cached result if this exact normalized value was previously confirmed.
        // Covers: JuanParks / juanparks / JUANPARKS / "juanparks " after trim — all same norm.
        if (lastConfirmedRef.current?.norm === norm) {
            const cached = lastConfirmedRef.current.result;
            setAvailability(cached);
            setStatusMsg(cached === 'available'
                ? t('edit_profile.username_available')
                : t('edit_profile.username_taken'));
            return;
        }

        setAvailability('checking');
        setStatusMsg('');

        const gen = ++genRef.current;

        debounceRef.current = setTimeout(async () => {
            try {
                const snap = await getDoc(doc(db, 'usernames', norm));
                // Discard stale responses — user may have typed further while this was in-flight
                if (gen !== genRef.current) return;

                const result: 'available' | 'taken' = snap.exists() ? 'taken' : 'available';
                setAvailability(result);
                setStatusMsg(result === 'available'
                    ? t('edit_profile.username_available')
                    : t('edit_profile.username_taken'));
                // Mark confirmed only after a real Firestore success
                lastConfirmedRef.current = { norm, result };
            } catch {
                if (gen !== genRef.current) return;
                setAvailability('network');
                setStatusMsg(t('name_entry.error_network'));
                // Do NOT update lastConfirmedRef — failure leaves the value eligible for retry
            }
        }, 400);

        return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    }, [username]);

    const handleSubmit = useCallback(async () => {
        if (availability !== 'available' || submitting) return;

        const trimmed = username.trim();
        setSubmitting(true);
        setClaimError('');

        try {
            const functions = getFunctions(getApp(), 'us-central1');
            await httpsCallable(functions, 'claimUsername')({ username: trimmed });
            // claimUsername atomically reserves usernames/{normalized} AND, for a
            // brand-new account, creates the full users/{uid} doc (plus its
            // private/social and private/preferences siblings) — no separate
            // client-side account-creation step is needed.
            onComplete(trimmed);
        } catch (e: any) {
            const code: string = e?.code ?? '';
            const msg: string = e?.details ?? e?.message ?? '';

            if (code === 'functions/already-exists' || msg.toLowerCase().includes('taken')) {
                // Race: another user claimed the name between our check and the CF.
                // Return to taken state without clearing the input.
                setAvailability('taken');
                setStatusMsg(t('edit_profile.username_taken'));
                lastConfirmedRef.current = null; // force fresh check on next attempt
            } else if (code === 'functions/failed-precondition') {
                // 30-day cooldown — parse days from CF message and show localized copy
                const days = parseCooldownDays(msg);
                setClaimError(days !== null
                    ? t('name_entry.error_cooldown', { days })
                    : t('name_entry.error_network'));
            } else if (
                code === 'functions/invalid-argument' &&
                (msg.includes('choose') || msg.includes('available') || msg.includes('not available'))
            ) {
                // Server-side moderation or reserved-word rejection
                setAvailability('invalid');
                setStatusMsg(msg);
            } else if (code === 'functions/unauthenticated') {
                setClaimError('Please sign in and try again.');
            } else {
                // Genuinely unexpected — not a known business-rule rejection
                // (those are already understood via the callable's own deliberate
                // response and need no extra monitoring). Never forwards `msg`,
                // which can otherwise echo moderation/cooldown text derived from
                // user input; only the safe, enum-like error code is tagged.
                reportCriticalActionFailure('account_create', e, code ? { errorCode: code } : undefined);
                setClaimError(t('name_entry.error_network'));
            }
        } finally {
            setSubmitting(false);
        }
    }, [availability, submitting, username, onComplete]);

    // Derive the status text shown below the input
    const displayStatus =
        statusMsg ||
        (availability === 'checking' ? t('name_entry.checking') :
         availability === 'idle'     ? t('name_entry.helper')   : '');

    const statusColor =
        availability === 'available'
            ? 'text-[var(--color-success)]'
            : (availability === 'taken' || availability === 'invalid' || availability === 'network')
                ? 'text-[var(--color-danger)]'
                : 'text-[var(--color-text-secondary)]';

    const canSubmit = availability === 'available' && !submitting;

    return (
        <div className="h-full w-full bg-[var(--color-bg)] flex flex-col px-6 pt-10">

            {/* Top nav row — matches Steps 1 & 2 exactly */}
            <div className="flex items-center justify-between mb-3">
                <div className="w-11 h-11" aria-hidden="true" />
                <span className="text-[12px] font-semibold text-[var(--color-text-secondary)] tracking-wide">
                    {ONBOARDING_V2_ENABLED ? t('onboarding_v2.signup_step', { n: 3 }) : t('name_entry.step')}
                </span>
            </div>

            {/* 4-segment progress bar */}
            <SignupProgress step={3} total={ONBOARDING_V2_ENABLED ? 3 : 4} />

            {/* Content block — entrance animation matching Steps 1 & 2 */}
            <div className={prefersReduced ? '' : 'auth-fade-in'}>

                {/* Eyebrow */}
                <p className="text-[11px] font-bold tracking-[0.13em] text-[var(--color-accent)] uppercase mb-3 mt-2">
                    {t('name_entry.eyebrow')}
                </p>

                {/* Headline */}
                <h1 className="text-[26px] font-bold text-[var(--color-text)] leading-tight mb-2">
                    {t('name_entry.headline')}
                </h1>

                {/* Supporting */}
                <p className="text-[15px] text-[var(--color-text-secondary)] leading-relaxed mb-8">
                    {t('name_entry.supporting')}
                </p>

                {/* Persistent field label */}
                <label
                    className="block text-[10px] font-bold uppercase tracking-[0.1em] text-[var(--color-text-secondary)] mb-2"
                    htmlFor="username-input"
                >
                    {t('name_entry.label')}
                </label>

                {/* Input with decorative @ prefix */}
                <div
                    className={`flex items-center bg-[var(--color-card)] border rounded-[18px] transition-all duration-[180ms] ${
                        availability === 'invalid' || availability === 'taken'
                            ? 'border-red-500/70 shadow-[0_0_0_3px_rgba(239,68,68,0.15)]'
                            : availability === 'available'
                                ? 'border-emerald-500/50 shadow-[0_0_0_3px_rgba(52,211,153,0.12)]'
                                : 'border-[var(--color-border)] focus-within:border-blue-500 focus-within:shadow-[0_0_0_3px_rgba(30,117,255,0.18)]'
                    }`}
                    style={{ height: 58 }}
                >
                    {/* @ is visual only — not submitted, aria-hidden */}
                    <span
                        className="pl-5 pr-1 text-[16px] font-semibold select-none"
                        style={{ color: 'rgba(255,255,255,0.35)' }}
                        aria-hidden="true"
                    >
                        @
                    </span>

                    <input
                        id="username-input"
                        type="text"
                        value={username}
                        onChange={(e) => setUsername(e.target.value.replace(/\s/g, ''))}
                        placeholder={t('name_entry.placeholder')}
                        className="flex-1 bg-transparent py-4 text-[var(--color-text)] font-semibold outline-none placeholder-[var(--color-text-secondary)] text-[16px]"
                        autoComplete="username"
                        autoCapitalize="none"
                        spellCheck={false}
                        autoFocus
                        maxLength={20}
                        inputMode="text"
                        aria-describedby="username-status"
                    />

                    {/* Availability indicator icon */}
                    <div className="pr-4 flex items-center">
                        {availability === 'checking' && (
                            <Loader2 size={18} className="text-[var(--color-text-secondary)] animate-spin" />
                        )}
                        {availability === 'available' && (
                            <Check size={18} className="text-[var(--color-success)]" />
                        )}
                        {(availability === 'taken' || availability === 'invalid') && (
                            <X size={18} className="text-[var(--color-danger)]" />
                        )}
                    </div>
                </div>

                {/* Helper / status area — aria-live so screen readers announce changes */}
                <div id="username-status" className="mt-2 min-h-[20px]" aria-live="polite">
                    {displayStatus && (
                        <p className={`text-[13px] ${statusColor}`}>{displayStatus}</p>
                    )}
                    {claimError && (
                        <p className="text-[13px] text-[var(--color-danger)] mt-1">{claimError}</p>
                    )}
                </div>

                {/* Action group — flows directly below the field, not pinned to the screen bottom */}
                <div className="mt-8">
                    <button
                        type="button"
                        onClick={handleSubmit}
                        disabled={!canSubmit}
                        className="w-full h-[58px] rounded-full font-semibold text-[16px] text-white active:scale-[0.985] transition-transform disabled:opacity-40"
                        style={{ background: 'linear-gradient(90deg, var(--color-brand), var(--color-brand-2))' }}
                    >
                        {submitting ? t('name_entry.cta_loading') : t('name_entry.cta')}
                    </button>
                </div>

            </div>
        </div>
    );
};
