import React from 'react';
import { Car } from 'lucide-react';
import { t, useLang } from '../../i18n';

interface FinishHandoffChipProps {
    onResume: () => void;
}

/** Persistent map chip. Not a dialog — tapping reopens the existing handoff sheet. */
export const FinishHandoffChip: React.FC<FinishHandoffChipProps> = ({ onResume }) => {
    useLang();
    const label = t('handoff.resume_chip');
    return (
        <div className="finish-handoff-chip max-w-[380px] mx-auto w-full pointer-events-auto" data-testid="finish-handoff-chip">
            <button
                type="button"
                onClick={onResume}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-full bg-[var(--color-card)] backdrop-blur-xl border border-[#1e75ff]/30 shadow-md"
            >
                <Car size={12} className="text-[var(--color-info)] shrink-0" />
                <span className="text-[12px] font-semibold text-[var(--color-text)]">{label}</span>
            </button>
        </div>
    );
};
