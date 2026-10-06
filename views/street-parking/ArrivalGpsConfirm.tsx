import React, { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { t } from '../../i18n';
import {
    INITIAL_ARRIVAL_RANGE_MEMORY,
    stabilizeArrivalLocation,
    type ArrivalLocationDecision,
    type ArrivalLocationReading,
    type ArrivalRangeStabilityMemory,
} from './arrivalLocation';

interface ArrivalGpsConfirmProps {
    spotId: string;
    spot: { lat: number; lng: number };
    reading: ArrivalLocationReading;
    /** Frozen clock for tests. Production ticks once a second. */
    nowMs?: number;
    arriving: boolean;
    handoffWriteInFlight: boolean;
    retrying: boolean;
    onArrival: () => void;
    onRetry?: () => void;
}

const primaryClass = 'w-full font-bold py-4 rounded-2xl transition-all text-sm active:scale-95 text-white disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 flex items-center justify-center gap-2';
const primaryStyle = { background: 'linear-gradient(90deg, var(--color-brand), var(--color-brand-2))' };
const overrideClass = 'w-full font-bold py-4 rounded-2xl transition-all text-sm active:scale-95 text-white bg-amber-600 hover:bg-amber-500 disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100';
const secondaryClass = 'w-full font-semibold py-3.5 rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)] hover:bg-white/10 text-[var(--color-text)] text-sm transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100';

function useArrivalClock(frozenNowMs: number | undefined): number {
    const [now, setNow] = useState(() => frozenNowMs ?? Date.now());
    useEffect(() => {
        if (frozenNowMs != null) return;
        const id = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(id);
    }, [frozenNowMs]);
    return frozenNowMs ?? now;
}

/**
 * Proximity UI only. Every action that advances arrival calls `onArrival`,
 * which is the existing arrived_pending_outcome write. This component does
 * not award Crowns and does not submit coordinates.
 */
export const ArrivalGpsConfirm: React.FC<ArrivalGpsConfirmProps> = ({
    spotId,
    spot,
    reading,
    nowMs: frozenNowMs,
    arriving,
    handoffWriteInFlight,
    retrying,
    onArrival,
    onRetry,
}) => {
    const nowMs = useArrivalClock(frozenNowMs);
    const [rangeMemory, setRangeMemory] = useState<{ spotId: string; value: ArrivalRangeStabilityMemory }>({
        spotId,
        value: INITIAL_ARRIVAL_RANGE_MEMORY,
    });
    const previous = rangeMemory.spotId === spotId ? rangeMemory.value : INITIAL_ARRIVAL_RANGE_MEMORY;
    const stabilized = stabilizeArrivalLocation({
        reading,
        spot,
        nowMs,
        previous,
    });
    const decision = stabilized.decision;

    type SettledArrivalDecision = Exclude<ArrivalLocationDecision, { kind: 'pending' }>;
    const [settledDecision, setSettledDecision] = useState<{
        spotId: string;
        value: SettledArrivalDecision | null;
    }>({ spotId, value: null });
    const currentSettled = settledDecision.spotId === spotId ? settledDecision.value : null;

    // The sensor state may briefly pass through "pending" between platform fixes,
    // or later wobble back across the range boundary. Do not expose those raw
    // transitions as changing copy in the handoff sheet. Once the user has a
    // settled message, keep showing it while a new sample is being evaluated.
    // Once arrival has been confidently reached, keep "I've arrived" available
    // for the rest of this spot's handoff instead of revoking it on GPS drift.
    const visibleDecision: ArrivalLocationDecision = currentSettled?.kind === 'arrive'
        ? currentSettled
        : decision.kind === 'pending' && currentSettled
            ? currentSettled
            : decision;

    useEffect(() => {
        setSettledDecision(current => {
            const previousSettled = current.spotId === spotId ? current.value : null;

            if (previousSettled?.kind === 'arrive') {
                return current.spotId === spotId ? current : { spotId, value: previousSettled };
            }

            if (decision.kind === 'pending') {
                return current.spotId === spotId ? current : { spotId, value: null };
            }

            const sameDecision = previousSettled?.kind === decision.kind
                && (decision.kind !== 'override'
                    || (previousSettled.kind === 'override' && previousSettled.reason === decision.reason));
            if (current.spotId === spotId && sameDecision) return current;

            return { spotId, value: decision };
        });
    }, [
        spotId,
        decision.kind,
        decision.kind === 'override' ? decision.reason : null,
    ]);

    useEffect(() => {
        setRangeMemory(current => {
            const sameSpot = current.spotId === spotId;
            const sameValue = sameSpot
                && current.value.stable === stabilized.next.stable
                && current.value.candidate === stabilized.next.candidate
                && current.value.confirmations === stabilized.next.confirmations
                && current.value.lastSampleTimestampMs === stabilized.next.lastSampleTimestampMs;
            if (sameValue) return current;
            return { spotId, value: stabilized.next };
        });
    }, [
        spotId,
        stabilized.next.stable,
        stabilized.next.candidate,
        stabilized.next.confirmations,
        stabilized.next.lastSampleTimestampMs,
    ]);

    const decisionToken = visibleDecision.kind === 'override'
        ? `${spotId}:override:${visibleDecision.reason}`
        : `${spotId}:${visibleDecision.kind}`;
    const [ackedToken, setAckedToken] = useState<string | null>(null);
    const acknowledged = ackedToken === decisionToken;

    if (visibleDecision.kind === 'arrive') {
        return (
            <button
                onClick={onArrival}
                disabled={handoffWriteInFlight}
                aria-busy={arriving}
                className={primaryClass}
                style={primaryStyle}
            >
                {t('claim_flow.ive_arrived')}
            </button>
        );
    }

    if (visibleDecision.kind === 'pending') {
        return (
            <button type="button" disabled className={primaryClass} style={primaryStyle}>
                {t('claim_flow.arrival_checking')}
            </button>
        );
    }

    if (visibleDecision.kind === 'out_of_range') {
        return (
            <div>
                <div role="alert" className="mb-3 rounded-2xl border-2 border-amber-500 bg-amber-500/20 px-4 py-3.5">
                    <p className="flex items-center justify-center gap-2 text-[15px] font-bold text-[var(--color-warning)] text-center">
                        <AlertTriangle size={16} aria-hidden="true" />
                        {t('claim_flow.arrival_far_title')}
                    </p>
                    <p className="text-[12px] font-semibold text-[var(--color-text)] text-center mt-1.5 leading-relaxed">
                        {t('claim_flow.arrival_far_body')}
                    </p>
                </div>
                <button
                    type="button"
                    onClick={() => onRetry?.()}
                    disabled={retrying || handoffWriteInFlight || !onRetry}
                    aria-busy={retrying}
                    className={`${secondaryClass} mb-2`}
                >
                    {retrying ? t('claim_flow.arrival_retrying') : t('claim_flow.arrival_retry')}
                </button>
                {acknowledged ? (
                    <button
                        type="button"
                        onClick={onArrival}
                        disabled={handoffWriteInFlight}
                        aria-busy={arriving}
                        className={overrideClass}
                    >
                        {t('claim_flow.im_here_anyway')}
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={() => setAckedToken(decisionToken)}
                        disabled={handoffWriteInFlight}
                        className={secondaryClass}
                    >
                        {t('claim_flow.arrival_ack_far')}
                    </button>
                )}
            </div>
        );
    }

    const bodyKey = visibleDecision.reason === 'permission_denied'
        ? 'claim_flow.arrival_denied_body'
        : visibleDecision.reason === 'stale'
            ? 'claim_flow.arrival_stale_body'
            : 'claim_flow.arrival_unavailable_body';

    return (
        <div>
            <div role="alert" className="mb-3 rounded-2xl border border-amber-500/50 bg-amber-500/10 px-4 py-3.5">
                <p className="text-[14px] font-bold text-[var(--color-warning)] text-center">
                    {t('claim_flow.arrival_override_title')}
                </p>
                <p className="text-[12px] font-semibold text-[var(--color-text)] text-center mt-1.5 leading-relaxed">
                    {t(bodyKey)}
                </p>
            </div>
            {acknowledged ? (
                <button
                    type="button"
                    onClick={onArrival}
                    disabled={handoffWriteInFlight}
                    aria-busy={arriving}
                    className={overrideClass}
                >
                    {t('claim_flow.arrival_override')}
                </button>
            ) : (
                <button
                    type="button"
                    onClick={() => setAckedToken(decisionToken)}
                    disabled={handoffWriteInFlight}
                    className={secondaryClass}
                >
                    {t('claim_flow.arrival_ack_override')}
                </button>
            )}
        </div>
    );
};
