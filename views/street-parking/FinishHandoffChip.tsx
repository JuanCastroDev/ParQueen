import React from 'react';
import { Car, CheckCircle2, ChevronRight } from 'lucide-react';
import { t, useLang } from '../../i18n';

interface FinishHandoffChipProps {
    onResume: () => void;
    role?: 'claimer' | 'finder';
    address?: string;
    driverName?: string;
    submitting?: boolean;
}

/**
 * Persistent bottom-anchored recovery card. The claimer reopens the outcome
 * sheet; the finder uses the explicit confirmation CTA for their own immutable
 * participant-success attestation.
 */
export const FinishHandoffChip: React.FC<FinishHandoffChipProps> = ({
    onResume,
    role = 'claimer',
    address = '',
    driverName = '',
    submitting = false,
}) => {
    useLang();

    const isFinder = role === 'finder';
    const title = isFinder ? t('handoff.finder_card_title') : t('handoff.claimer_card_title');
    const body = isFinder
        ? (address
            ? t('handoff.finder_card_body', { name: driverName || t('handoff.other_driver'), address })
            : t('handoff.finder_card_body_generic', { name: driverName || t('handoff.other_driver') }))
        : (address
            ? t('handoff.claimer_card_body', { address })
            : t('handoff.claimer_card_body_generic'));
    const action = isFinder
        ? (submitting ? t('handoff.finder_card_saving') : t('handoff.finder_card_cta'))
        : t('handoff.claimer_card_cta');

    return (
        <div
            className="handoff-action-card max-w-[380px] mx-auto w-full pointer-events-auto"
            data-testid="finish-handoff-chip"
            data-handoff-role={role}
        >
            <div className="rounded-2xl border border-[#1e75ff]/30 bg-[var(--color-card)] backdrop-blur-xl shadow-xl px-3.5 py-3">
                <div className="flex items-center gap-3">
                    <div
                        className="w-10 h-10 shrink-0 rounded-xl flex items-center justify-center border border-[#1e75ff]/25"
                        style={{ background: 'linear-gradient(135deg, #1e75ff22, #0ea5e922)' }}
                    >
                        {isFinder
                            ? <CheckCircle2 size={20} className="text-[var(--color-info)]" />
                            : <Car size={20} className="text-[var(--color-info)]" />}
                    </div>

                    <div className="min-w-0 flex-1">
                        <p className="text-[13px] font-extrabold leading-tight text-[var(--color-text)]">
                            {title}
                        </p>
                        <p className="mt-0.5 text-[11px] leading-snug text-[var(--color-text-secondary)] truncate">
                            {body}
                        </p>
                    </div>
                </div>

                <button
                    type="button"
                    onClick={onResume}
                    disabled={submitting}
                    className="mt-2.5 min-h-10 w-full inline-flex items-center justify-center gap-1 rounded-xl bg-[var(--color-brand)] px-3 py-2 text-[11px] font-bold text-white shadow-md transition-transform active:scale-[0.98] disabled:opacity-50"
                >
                    <span>{action}</span>
                    {!submitting && <ChevronRight size={13} />}
                </button>
            </div>
        </div>
    );
};
