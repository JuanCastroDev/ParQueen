import React, { useState } from 'react';
import { MessageSquare, MapPin, Clock, Navigation, Car } from 'lucide-react';
import { MapItem } from './types';
import { t, useLang } from '../../i18n';
import { getDistance, formatTimeLeft } from './utils';
import { getVehicleHex, VehicleIcon } from '../../utils/vehicleIcon';
import { getTierForTitle, TIER_VISUALS } from '../../utils/crowns';
import { CrownBadge } from '../../utils/CrownBadge';
import { derivePingLifecycle, timestampToMillis } from '../../utils/pingLifecycle';

// QUICK_REPLIES moved inside SpotDetailsCardInner so they re-resolve on language change

interface SpotDetailsCardProps {
    selectedItem: any;
    freeSpots: MapItem[];
    user: any;
    userLocation: [number, number] | null;
    spotAddress: string;
    onHeadingThere: () => void;
    onScheduledClaim?: () => void;
    onCommitToHeading?: () => void;
    onOwnerLeaveNow?: () => void;
    onEditSpot: (spot: any) => void;
    onDeletePing: () => void;
    onArrival: () => void;
    onCancelByFinder: (reason: string) => void;
    onCancelByClaimer: (reason: string) => void;
    cancelingClaim?: boolean;
    claiming?: boolean;
    arriving?: boolean;
    onDriverArrived: () => void;
    onMessageUser: (userId: string, context: string, returnSpotId?: string) => void;
    interestError: string | null;
    estDriveMinutes: number | null;
    isWithinArrivalRange: boolean;
    maxEtaMinutes: number;
    manageMode?: boolean;
    nowMs?: number;
    backLabel?: string;
    onBack?: () => void;
}

export const SpotDetailsCard: React.FC<SpotDetailsCardProps> = ({
    selectedItem, freeSpots, user, userLocation, spotAddress,
    onHeadingThere, onScheduledClaim, onCommitToHeading, onOwnerLeaveNow,
    onEditSpot, onDeletePing, onArrival,
    onCancelByFinder, onCancelByClaimer, cancelingClaim = false, claiming = false, arriving = false, onDriverArrived, onMessageUser,
    interestError, estDriveMinutes, isWithinArrivalRange, maxEtaMinutes, manageMode = false, nowMs = Date.now(),
    backLabel, onBack,
}) => {
    if (!selectedItem) return null;

    return (
        <>
            {onBack && (
                <button
                    onClick={onBack}
                    className="flex items-center gap-1 text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-colors mb-3"
                >
                    <span>‹</span>
                    <span>{backLabel ?? 'Back'}</span>
                </button>
            )}
            <SpotDetailsCardInner {...{ selectedItem, freeSpots, user, userLocation, spotAddress, onHeadingThere, onScheduledClaim, onCommitToHeading, onOwnerLeaveNow, onEditSpot, onDeletePing, onArrival, onCancelByFinder, onCancelByClaimer, cancelingClaim, claiming, arriving, onDriverArrived, onMessageUser, interestError, estDriveMinutes, isWithinArrivalRange, maxEtaMinutes, manageMode, nowMs }} />
        </>
    );
};

const SpotDetailsCardInner: React.FC<Omit<SpotDetailsCardProps, 'backLabel' | 'onBack'>> = ({
    selectedItem, freeSpots, user, userLocation, spotAddress,
    onHeadingThere, onScheduledClaim, onCommitToHeading, onOwnerLeaveNow,
    onEditSpot, onDeletePing, onArrival,
    onCancelByFinder, onCancelByClaimer, cancelingClaim = false, claiming = false, arriving = false, onDriverArrived, onMessageUser,
    interestError, estDriveMinutes, isWithinArrivalRange, maxEtaMinutes, manageMode = false, nowMs = Date.now(),
}) => {
    useLang();
    const claimerCancelReasons = [
        { key: 'found_other', label: t('claim_flow.cancel_reason_found_other'), value: 'Found parking elsewhere' },
        { key: 'traffic',     label: t('claim_flow.cancel_reason_traffic'),     value: 'Traffic is too heavy' },
        { key: 'changed',     label: t('claim_flow.cancel_reason_changed_mind'), value: 'Changed my mind' },
    ];
    const finderCancelReasons = [
        { key: 'cant_wait',  label: t('claim_flow.cancel_reason_cant_wait'), value: "Can't wait anymore" },
        { key: 'spot_gone',  label: t('claim_flow.cancel_reason_spot_gone'), value: 'Spot no longer available' },
    ];
    const [showClaimerReasons, setShowClaimerReasons] = useState(false);
    const [showFinderReasons, setShowFinderReasons] = useState(false);
    const distanceVal = userLocation ? getDistance(userLocation[1], userLocation[0], selectedItem.lat, selectedItem.lng) : null;
    const distanceText = distanceVal
        ? (distanceVal * 0.621371 < 0.1 ? `${Math.round(distanceVal * 1000 * 1.09361)} yd` : `${(distanceVal * 0.621371).toFixed(1)} mi`)
        : '';

    const departureMs = timestampToMillis(selectedItem.reportedAt);
    const departureDate = departureMs ? new Date(departureMs) : null;
    const lifecycle = derivePingLifecycle(selectedItem, nowMs, user?.id);
    const isScheduled = lifecycle.phase === 'scheduled';
    const departureText = departureDate ? departureDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const timeLeftMs = timestampToMillis(selectedItem.expiresAt) - nowMs;

    const isFinder = user?.id === selectedItem.finderId;
    const isInterestedUser = user?.id === selectedItem.interestedUserId;
    const spotStatus = selectedItem.status;

    type CardState = 'available' | 'my_claim' | 'my_scheduled_claim' | 'my_ping_available' | 'my_ping_claimed' | 'my_ping_scheduled_claimed' | 'third_party';
    const isCommitted = spotStatus === 'interested' && selectedItem.claimState === 'committed';
    let state: CardState;
    if (isFinder && isCommitted && !manageMode) state = 'my_ping_scheduled_claimed';
    else if (isFinder && spotStatus === 'interested' && !manageMode) state = 'my_ping_claimed';
    else if (isFinder) state = 'my_ping_available';
    else if (isInterestedUser && isCommitted) state = 'my_scheduled_claim';
    else if (isInterestedUser && spotStatus === 'interested') state = 'my_claim';
    else if (spotStatus === 'available') state = 'available';
    else state = 'third_party';

    // For the finder's own ping, read vehicle info from the live user object (always current).
    // For others, read from the denormalized spot fields (written at ping creation time).
    const vehicleColor = isFinder ? (user?.vehicleColor || selectedItem.finderVehicleColor) : selectedItem.finderVehicleColor;
    const vehicleType = isFinder ? (user?.vehicleType || selectedItem.finderVehicleType) : selectedItem.finderVehicleType;
    const vehicleBrand = isFinder ? (user?.vehicleBrand || selectedItem.finderVehicleBrand) : selectedItem.finderVehicleBrand;

    const vehicleHex = getVehicleHex(vehicleColor);
    const hasVehicle = vehicleType || vehicleColor || vehicleBrand;
    const vehicleLabel = [vehicleColor, vehicleBrand, vehicleType].filter(Boolean).join(' · ');

    // Finder initial avatar
    const finderName = selectedItem.finderName || 'Driver';
    const finderInitial = finderName.charAt(0).toUpperCase();

    // Status badge config
    const badgeConfig = state === 'my_claim'
        ? { label: t('spot_details.badge_en_route'), color: 'text-[var(--color-accent)] bg-blue-500/10 border-blue-500/20' }
        : spotStatus === 'available' && isScheduled
        ? { label: t('spot_details.badge_soon'), color: 'text-[var(--color-warning)] bg-yellow-500/10 border-yellow-500/20' }
        : spotStatus === 'available'
        ? { label: t('spot_details.badge_free'), color: 'text-[var(--color-success)] bg-green-500/10 border-green-500/20' }
        : { label: t('spot_details.badge_reserved'), color: 'text-[var(--color-warning)] bg-amber-500/10 border-amber-500/20' };

    // Claimer heading to spot — finder's vehicle is the hero
    if (state === 'my_claim') {
        return (
            <div>
                {/* Header */}
                <p className="text-[10px] font-semibold text-[var(--color-info)] uppercase tracking-widest text-center mb-1">{t('spot_details.on_your_way')}</p>
                <p className="text-[18px] font-bold text-[var(--color-text)] text-center mb-1 leading-snug">{t('spot_details.heading_title')}</p>
                <p className="text-[12px] text-[var(--color-text-secondary)] text-center mb-5 px-2 leading-relaxed">{t('spot_details.heading_subtitle')}</p>

                {/* Finder card */}
                <div className="flex items-center gap-3 bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl px-4 py-3.5 mb-4">
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0 text-white font-bold text-lg"
                        style={{ background: 'linear-gradient(135deg, var(--color-brand), var(--color-brand-2))' }}>
                        {finderInitial}
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-[15px] font-bold text-[var(--color-text)] truncate">{finderName}</p>
                        {selectedItem.finderTitle ? (() => {
                            const ft = getTierForTitle(selectedItem.finderTitle);
                            return (
                                <div className="flex items-center gap-1 mt-0.5">
                                    <CrownBadge tier={ft} size={11} />
                                    <span className="text-[11px] font-semibold" style={{ color: TIER_VISUALS[ft].textColor }}>{selectedItem.finderTitle}</span>
                                </div>
                            );
                        })() : (
                            <span className="inline-flex items-center gap-1 mt-0.5 px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-400/20 text-[10px] font-semibold text-[var(--color-info)]">
                                <span className="w-1.5 h-1.5 rounded-full bg-[#38bdf8] shrink-0" />
                                Trusted Driver
                            </span>
                        )}
                    </div>
                </div>

                {/* Vehicle — what to look out for */}
                {hasVehicle && (
                    <>
                        <p className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-widest mb-2">{t('claim_flow.look_out_for')}</p>
                        <div className="flex items-center gap-4 bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl px-4 py-3.5 mb-5">
                            <div className="w-11 h-11 rounded-xl flex items-center justify-center shrink-0 border border-white/10"
                                style={{ background: vehicleHex + '33' }}>
                                <VehicleIcon type={vehicleType} color={vehicleColor} size={24} />
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-[15px] font-bold text-[var(--color-text)] truncate">
                                    {[vehicleColor, vehicleBrand].filter(Boolean).join(' · ') || vehicleType}
                                </p>
                                {vehicleType && (vehicleColor || vehicleBrand) && (
                                    <p className="text-[12px] text-[var(--color-text-secondary)]">{vehicleType}</p>
                                )}
                            </div>
                        </div>
                    </>
                )}

                {interestError && <p className="text-[var(--color-danger)] text-xs mb-2 text-center">{interestError}</p>}

                {showClaimerReasons ? (
                    <div>
                        <p className="text-[11px] font-bold text-[var(--color-text-secondary)] uppercase tracking-widest text-center mb-3">{t('claim_flow.why_canceling')}</p>
                        <div className="space-y-2 mb-2">
                            {claimerCancelReasons.map(({ key, label, value }) => (
                                <button key={key} onClick={() => onCancelByClaimer(value)} disabled={cancelingClaim}
                                    aria-busy={cancelingClaim}
                                    className="w-full py-3 px-4 rounded-2xl text-sm font-semibold border border-[var(--color-border)] bg-white/5 hover:bg-white/10 transition-all active:scale-95 text-[var(--color-text)] text-left disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100">
                                    {cancelingClaim ? t('claim_flow.canceling') : label}
                                </button>
                            ))}
                        </div>
                        <button onClick={() => setShowClaimerReasons(false)}
                            className="w-full py-2.5 text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-all">
                            ← {t('ping_modal.back')}
                        </button>
                    </div>
                ) : (
                    <>
                        <div className="grid grid-cols-2 gap-2 mb-2">
                            <button onClick={() => setShowClaimerReasons(true)}
                                className="flex items-center justify-center gap-2 py-3.5 rounded-2xl border border-red-500/30 hover:bg-red-500/10 text-[var(--color-danger)] font-semibold text-sm transition-all active:scale-95">
                                {t('claim_flow.cancel')}
                            </button>
                            <button onClick={() => onMessageUser(selectedItem.finderId, `Spot pinged by ${finderName}`, selectedItem.id)}
                                className="flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-[var(--color-card)] border border-[var(--color-border)] hover:bg-white/10 text-[var(--color-text)] font-semibold text-sm transition-all active:scale-95">
                                <MessageSquare size={15} />
                                {t('claim_flow.message')}
                            </button>
                        </div>
                        <button onClick={onArrival} disabled={!isWithinArrivalRange || arriving}
                            aria-busy={arriving}
                            className="w-full font-bold py-4 rounded-2xl transition-all text-sm active:scale-95 text-white disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 flex items-center justify-center gap-2"
                            style={{ background: 'linear-gradient(90deg, var(--color-brand), var(--color-brand-2))' }}>
                            {isWithinArrivalRange ? t('claim_flow.ive_arrived') : (distanceText ? t('claim_flow.dist_away', { dist: distanceText }) : t('claim_flow.get_closer'))}
                        </button>
                    </>
                )}
            </div>
        );
    }

    // Claimer committed to a scheduled Ping — not heading there yet
    if (state === 'my_scheduled_claim') {
        const ownerLeaving = !!selectedItem.ownerLeavingNow;
        return (
            <div>
                <p className="text-[10px] font-semibold text-[var(--color-info)] uppercase tracking-widest text-center mb-1">
                    {t('scheduled_claim.eyebrow')}
                </p>
                <p className="text-[18px] font-bold text-[var(--color-text)] text-center mb-1 leading-snug">
                    {t('scheduled_claim.title')}
                </p>

                {ownerLeaving ? (
                    <p className="text-[13px] font-semibold text-[var(--color-warning)] text-center mb-4 px-2 leading-snug">
                        {t('scheduled_claim.owner_leaving_now', { name: finderName })}
                    </p>
                ) : (
                    <p className="text-[12px] text-[var(--color-text-secondary)] text-center mb-4 px-2 leading-relaxed">
                        {departureText ? t('scheduled_claim.opens_at', { time: departureText }) : ''}
                    </p>
                )}

                {/* Finder card */}
                <div className="flex items-center gap-3 bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl px-4 py-3.5 mb-4">
                    <div className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0 text-white font-bold text-lg"
                        style={{ background: 'linear-gradient(135deg, var(--color-brand), var(--color-brand-2))' }}>
                        {finderInitial}
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-[15px] font-bold text-[var(--color-text)] truncate">{finderName}</p>
                        {selectedItem.finderTitle ? (() => {
                            const ft = getTierForTitle(selectedItem.finderTitle);
                            return (
                                <div className="flex items-center gap-1 mt-0.5">
                                    <CrownBadge tier={ft} size={11} />
                                    <span className="text-[11px] font-semibold" style={{ color: TIER_VISUALS[ft].textColor }}>{selectedItem.finderTitle}</span>
                                </div>
                            );
                        })() : (
                            <span className="inline-flex items-center gap-1 mt-0.5 px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-400/20 text-[10px] font-semibold text-[var(--color-info)]">
                                <span className="w-1.5 h-1.5 rounded-full bg-[#38bdf8] shrink-0" />
                                Trusted Driver
                            </span>
                        )}
                    </div>
                    {!ownerLeaving && departureText && (
                        <div className="text-right shrink-0">
                            <p className="text-[9px] font-bold text-[var(--color-text-secondary)] uppercase tracking-wide mb-0.5">{t('spot_details.leaving_at', { time: '' }).trim()}</p>
                            <p className="text-[13px] font-bold text-[var(--color-warning)]">{departureText}</p>
                        </div>
                    )}
                </div>

                {!ownerLeaving && (
                    <p className="text-[11px] text-[var(--color-text-secondary)] text-center mb-4 px-2">
                        {t('scheduled_claim.when_ready')}
                    </p>
                )}

                {interestError && <p className="text-[var(--color-danger)] text-xs mb-2 text-center">{interestError}</p>}

                <div className="grid grid-cols-2 gap-2 mb-2">
                    <button onClick={() => onCancelByClaimer('Changed my mind')} disabled={cancelingClaim}
                        aria-busy={cancelingClaim}
                        className="flex items-center justify-center gap-2 py-3.5 rounded-2xl border border-red-500/30 hover:bg-red-500/10 text-[var(--color-danger)] font-semibold text-sm transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100">
                        {cancelingClaim ? t('claim_flow.canceling') : t('scheduled_claim.cancel')}
                    </button>
                    <button onClick={() => onMessageUser(selectedItem.finderId, `Spot pinged by ${finderName}`, selectedItem.id)}
                        className="flex items-center justify-center gap-2 py-3.5 rounded-2xl bg-[var(--color-card)] border border-[var(--color-border)] hover:bg-white/10 text-[var(--color-text)] font-semibold text-sm transition-all active:scale-95">
                        <MessageSquare size={15} />
                        {t('claim_flow.message')}
                    </button>
                </div>
                <button onClick={onCommitToHeading} disabled={claiming}
                    aria-busy={claiming}
                    className="w-full font-bold py-4 rounded-2xl transition-all text-sm active:scale-95 text-white flex items-center justify-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
                    style={{ background: ownerLeaving ? 'linear-gradient(90deg, #f59e0b, #d97706)' : 'linear-gradient(90deg, var(--color-brand), var(--color-brand-2))' }}>
                    <Navigation size={14} />
                    {t('scheduled_claim.im_heading_there')}
                </button>
            </div>
        );
    }

    // Owner view — someone committed to a scheduled Ping
    if (state === 'my_ping_scheduled_claimed') {
        const claimerName = selectedItem.interestedUserName || 'Someone';
        const claimerInitial = claimerName.charAt(0).toUpperCase();
        const ownerLeaving = !!selectedItem.ownerLeavingNow;

        return (
            <div>
                <p className="text-[10px] font-bold tracking-widest uppercase text-[var(--color-info)] text-center mb-1">
                    {t('scheduled_claim.owner_eyebrow')}
                </p>
                <h2 className="text-lg font-bold text-[var(--color-text)] text-center leading-snug">
                    {t('scheduled_claim.owner_title', { name: claimerName })}
                </h2>
                {ownerLeaving ? (
                    <p className="text-[12px] text-[var(--color-warning)] text-center mt-0.5 mb-4">
                        {t('scheduled_claim.owner_waiting', { name: claimerName })}
                    </p>
                ) : (
                    <p className="text-[12px] text-[var(--color-text-secondary)] text-center mt-0.5 mb-4">
                        {departureText ? t('scheduled_claim.owner_subtitle', { time: departureText }) : ''}
                    </p>
                )}

                {/* Claimer identity card */}
                <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl p-4 mb-3">
                    <div className="flex items-center gap-3">
                        <div className="rounded-2xl flex items-center justify-center shrink-0 text-white font-bold text-xl"
                            style={{ background: 'linear-gradient(135deg, var(--color-brand), var(--color-brand-2))', width: 52, height: 52 }}>
                            {claimerInitial}
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-base font-extrabold text-[var(--color-text)] truncate">{claimerName}</p>
                            {selectedItem.interestedUserTitle && (() => {
                                const ct = getTierForTitle(selectedItem.interestedUserTitle);
                                return (
                                    <div className="flex items-center gap-1 mt-0.5">
                                        <CrownBadge tier={ct} size={11} />
                                        <span className="text-[11px] font-semibold" style={{ color: TIER_VISUALS[ct].textColor }}>{selectedItem.interestedUserTitle}</span>
                                    </div>
                                );
                            })()}
                        </div>
                    </div>
                </div>

                <div className="flex flex-col gap-2">
                    <button onClick={() => onMessageUser(selectedItem.interestedUserId, `Scheduled claim by ${claimerName}`, selectedItem.id)}
                        className="w-full text-white font-bold py-4 rounded-2xl flex items-center justify-center gap-2 transition-all text-sm active:scale-95"
                        style={{ background: 'linear-gradient(90deg, var(--color-brand), var(--color-brand-2))' }}>
                        <MessageSquare size={15} />
                        {t('claim_flow.message')}
                    </button>
                    {!ownerLeaving && (
                        <button onClick={onOwnerLeaveNow}
                            className="w-full font-semibold py-3 rounded-2xl text-sm border border-amber-500/40 text-[var(--color-warning)] hover:bg-amber-500/10 transition-all active:scale-95">
                            {t('scheduled_claim.owner_leave_now')}
                        </button>
                    )}
                    <button onClick={() => onCancelByFinder("Can't wait anymore")}
                        className="w-full font-semibold py-3 rounded-2xl text-sm border border-red-500/40 text-[var(--color-danger)] hover:bg-red-500/10 transition-all active:scale-95">
                        {t('scheduled_claim.owner_cancel')}
                    </button>
                </div>
            </div>
        );
    }

    // Finder view — claimer's vehicle is the hero
    if (state === 'my_ping_claimed') {
        const vc = selectedItem.interestedUserVehicleColor;
        const vt = selectedItem.interestedUserVehicleType;
        const vb = selectedItem.interestedUserVehicleBrand;
        const claimerName = selectedItem.interestedUserName || 'Someone';
        const claimerInitial = claimerName.charAt(0).toUpperCase();
        const vehicleHexClaimer = getVehicleHex(vc);
        const hasClaimerVehicle = vc || vt || vb;
        const eta = selectedItem.etaMinutes;
        const etaDisplay = eta === null || eta === undefined
            ? t('en_route.waiting_location')
            : eta === 0
            ? t('en_route.arriving_now')
            : `${eta} ${t('claim_flow.min_away')}`;

        return (
            <div>
                {/* Header */}
                <p className="text-[10px] font-bold tracking-widest uppercase text-[var(--color-info)] text-center mb-1">{t('en_route.eyebrow')}</p>
                <h2 className="text-lg font-bold text-[var(--color-text)] text-center leading-snug">{t('en_route.title')}</h2>
                <p className="text-[12px] text-[var(--color-text-secondary)] text-center mt-0.5 mb-4">{t('en_route.subtitle')}</p>

                {/* Identity + ETA card */}
                <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl p-4 mb-3">
                    <div className="flex items-center gap-3">
                        <div className="rounded-2xl flex items-center justify-center shrink-0 text-white font-bold text-xl"
                            style={{ background: 'linear-gradient(135deg, var(--color-brand), var(--color-brand-2))', width: 52, height: 52 }}>
                            {claimerInitial}
                        </div>
                        <div className="flex-1 min-w-0">
                            <p className="text-base font-extrabold text-[var(--color-text)] truncate">{claimerName}</p>
                            {selectedItem.interestedUserTitle && (() => {
                                const ct = getTierForTitle(selectedItem.interestedUserTitle);
                                return (
                                    <div className="flex items-center gap-1 mt-0.5">
                                        <CrownBadge tier={ct} size={11} />
                                        <span className="text-[11px] font-semibold" style={{ color: TIER_VISUALS[ct].textColor }}>{selectedItem.interestedUserTitle}</span>
                                    </div>
                                );
                            })()}
                        </div>
                        <div className="text-right shrink-0">
                            <p className="text-[9px] font-bold text-[var(--color-text-secondary)] uppercase tracking-wide mb-0.5">{t('en_route.arrival_label')}</p>
                            <p className="text-[13px] font-bold text-[var(--color-info)] whitespace-nowrap">{etaDisplay}</p>
                        </div>
                    </div>
                </div>

                {/* Vehicle card */}
                {hasClaimerVehicle && (
                    <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-2xl p-4 mb-4">
                        <p className="text-[10px] font-bold text-[var(--color-text-secondary)] uppercase tracking-widest mb-3">{t('claim_flow.look_out_for')}</p>
                        <div className="flex items-center gap-3">
                            <div className="w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 border border-white/10"
                                style={{ background: vehicleHexClaimer + '33' }}>
                                <VehicleIcon type={vt} color={vc} size={24} />
                            </div>
                            <div className="flex-1 min-w-0">
                                <p className="text-base font-extrabold text-[var(--color-text)] truncate">
                                    {[vc, vb].filter(Boolean).join(' ') || vt}
                                </p>
                                {vt && (vc || vb) && (
                                    <p className="text-sm text-[var(--color-text-secondary)]">{vt}</p>
                                )}
                            </div>
                        </div>
                    </div>
                )}

                {/* Actions */}
                {showFinderReasons ? (
                    <div>
                        <p className="text-[11px] font-bold text-[var(--color-text-secondary)] uppercase tracking-widest text-center mb-3">{t('claim_flow.whats_happening')}</p>
                        <div className="space-y-2 mb-2">
                            <button onClick={onDriverArrived}
                                className="w-full py-3 px-4 rounded-2xl text-sm font-semibold border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/15 transition-all active:scale-95 text-[var(--color-success)] text-left">
                                {t('claim_flow.driver_arrived')}
                            </button>
                            {finderCancelReasons.map(({ key, label, value }) => (
                                <button key={key} onClick={() => onCancelByFinder(value)}
                                    className="w-full py-3 px-4 rounded-2xl text-sm font-semibold border border-[var(--color-border)] bg-white/5 hover:bg-white/10 transition-all active:scale-95 text-[var(--color-text)] text-left">
                                    {label}
                                </button>
                            ))}
                        </div>
                        <button onClick={() => setShowFinderReasons(false)}
                            className="w-full py-2.5 text-xs font-semibold text-[var(--color-text-secondary)] hover:text-[var(--color-text)] transition-all">
                            ← {t('ping_modal.back')}
                        </button>
                    </div>
                ) : (
                    <div className="flex flex-col gap-2">
                        <button
                            onClick={() => onMessageUser(selectedItem.interestedUserId, `Spot claimed by ${claimerName}`, selectedItem.id)}
                            className="w-full text-white font-bold py-4 rounded-2xl flex items-center justify-center gap-2 transition-all text-sm active:scale-95"
                            style={{ background: 'linear-gradient(90deg, var(--color-brand), var(--color-brand-2))' }}>
                            <MessageSquare size={15} />
                            {t('claim_flow.message')}
                        </button>
                        <button onClick={() => setShowFinderReasons(true)}
                            className="w-full font-semibold py-3 rounded-2xl text-sm border border-red-500/40 text-[var(--color-danger)] hover:bg-red-500/10 transition-all active:scale-95">
                            {t('claim_flow.cancel')}
                        </button>
                    </div>
                )}
            </div>
        );
    }

    // Someone else's ping — no address, just enough to decide
    if (state === 'available') {
        return (
            <div>
                <p className="text-[11px] font-bold text-[var(--color-info)] uppercase tracking-widest text-center mb-4">{t('spot_details.available')}</p>

                <div className="flex items-center gap-3 mb-4">
                    <div className="w-14 h-14 rounded-2xl flex items-center justify-center shrink-0 text-white font-bold text-xl"
                        style={{ background: 'linear-gradient(135deg, var(--color-brand), var(--color-brand-2))' }}>
                        {finderInitial}
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-lg font-extrabold text-[var(--color-text)] truncate">{finderName}</p>
                        {selectedItem.finderTitle && (() => {
                            const ft = getTierForTitle(selectedItem.finderTitle);
                            return (
                                <div className="flex items-center gap-1 mt-0.5">
                                    <CrownBadge tier={ft} size={11} />
                                    <span className="text-[11px] font-semibold" style={{ color: TIER_VISUALS[ft].textColor }}>{selectedItem.finderTitle}</span>
                                </div>
                            );
                        })()}
                    </div>
                    <span className={`text-[10px] font-bold px-2 py-1 rounded-xl border shrink-0 ${badgeConfig.color}`}>
                        {badgeConfig.label}
                    </span>
                </div>

                <div className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-card)] p-4 mb-4">
                    <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                            <Clock size={14} className={isScheduled ? 'text-[var(--color-warning)] shrink-0' : 'text-[var(--color-success)] shrink-0'} />
                            <span className="text-sm font-bold text-[var(--color-text)]">
                                {isScheduled ? t('spot_details.leaving_at', { time: departureText }) : t('spot_details.leaving_now')}
                            </span>
                        </div>
                        <div className="flex items-center gap-2">
                            {distanceText && (
                                <span className="text-sm font-bold text-[var(--color-text-secondary)]">{distanceText}</span>
                            )}
                            {!isScheduled && timeLeftMs > 0 && (
                                <span className="text-xs text-[var(--color-text-secondary)]">{t('spot_details.expires_in', { time: formatTimeLeft(timeLeftMs) })}</span>
                            )}
                        </div>
                    </div>
                </div>

                {interestError && <p className="text-[var(--color-danger)] text-xs mb-3 text-center">{interestError}</p>}

                <div className="flex gap-2">
                    <button onClick={() => onMessageUser(selectedItem.finderId, `Spot pinged by ${finderName}`)}
                        aria-label={t('spot_details.message_finder')}
                        className="bg-white/10 hover:bg-white/20 text-[var(--color-text)] p-3.5 rounded-2xl flex items-center justify-center transition-all shrink-0 active:scale-95">
                        <MessageSquare size={16} />
                    </button>
                    {isScheduled ? (
                        <button onClick={onScheduledClaim} disabled={claiming}
                            aria-busy={claiming}
                            className="flex-1 font-bold py-3.5 rounded-2xl transition-all text-sm active:scale-95 text-white flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
                            style={{ background: 'linear-gradient(90deg, var(--color-brand), var(--color-brand-2))' }}>
                            {departureText ? t('claim_flow.claim_for_time', { time: departureText }) : t('claim_flow.claim_this_spot')}
                        </button>
                    ) : estDriveMinutes !== null && estDriveMinutes > maxEtaMinutes ? (
                        <span className="flex-1 text-xs text-[var(--color-text-secondary)] self-center text-center">
                            {t('claim_flow.too_far_drive', { min: estDriveMinutes })}
                        </span>
                    ) : (
                        <button onClick={onHeadingThere} disabled={claiming}
                            aria-busy={claiming}
                            className="flex-1 font-bold py-3.5 rounded-2xl transition-all text-sm active:scale-95 text-white flex items-center justify-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:active:scale-100"
                            style={{ background: 'linear-gradient(90deg, var(--color-brand), var(--color-brand-2))' }}>
                            <Navigation size={14} />
                            {t('claim_flow.im_heading_there')}
                        </button>
                    )}
                </div>
            </div>
        );
    }

    // Finder's own ping management view — address visible, edit/delete actions
    if (state === 'my_ping_available') {
        const pingBadge = isScheduled
            ? { label: t('spot_details.badge_scheduled'), color: 'text-[var(--color-warning)] bg-amber-500/10 border-amber-500/20' }
            : { label: t('spot_details.badge_available_now'), color: 'text-[var(--color-success)] bg-emerald-500/10 border-emerald-500/20' };

        return (
            <div>
                {/* Status header */}
                <p className="text-[10px] font-bold text-[var(--color-accent)] uppercase tracking-widest text-center mb-1">{t('spot_details.ping_active')}</p>
                <p className="text-[20px] font-extrabold text-[var(--color-text)] text-center leading-snug mb-1">{t('spot_details.spot_live')}</p>
                <p className="text-[12px] text-[var(--color-text-secondary)] text-center mb-5">{t('spot_details.spot_live_subtitle')}</p>

                {/* Identity row */}
                <div className="flex items-center gap-3 mb-4">
                    <div className="w-12 h-12 rounded-[12px] flex items-center justify-center shrink-0 text-white font-extrabold text-xl"
                        style={{ background: 'linear-gradient(135deg, #1e3a5f, #1e40af)' }}>
                        {finderInitial}
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-[16px] font-extrabold text-[var(--color-text)] truncate">{finderName}</p>
                        <span className={`inline-flex items-center gap-1.5 text-[10px] font-bold px-2.5 py-0.5 rounded-full border mt-1 ${pingBadge.color}`}>
                            <span className="w-1.5 h-1.5 rounded-full bg-current shrink-0" />
                            {pingBadge.label}
                        </span>
                    </div>
                </div>

                {/* Details card */}
                <div className="pq-own-ping-card rounded-2xl border p-4 mb-4 space-y-3">
                    <div className="flex items-center gap-2">
                        <MapPin size={14} className="text-[var(--color-info)] shrink-0" />
                        <span className="text-sm font-semibold text-[var(--color-text)] truncate">
                            {selectedItem.title || spotAddress || 'Street Parking Spot'}
                        </span>
                    </div>
                    <div className="flex items-center justify-between border-t pq-own-ping-divider pt-3">
                        <div className="flex items-center gap-2">
                            <Clock size={14} className={isScheduled ? 'text-[var(--color-warning)] shrink-0' : 'text-[var(--color-success)] shrink-0'} />
                            <span className="text-sm font-bold text-[var(--color-text)]">
                                {isScheduled ? t('spot_details.leaving_at', { time: departureText }) : t('spot_details.leaving_now')}
                            </span>
                        </div>
                        {!isScheduled && timeLeftMs > 0 && (
                            <span className="text-xs text-[var(--color-text-secondary)]">{t('spot_details.expires_in', { time: formatTimeLeft(timeLeftMs) })}</span>
                        )}
                    </div>
                </div>

                <p className="text-[11px] text-[var(--color-text-secondary)] text-center mb-5">{t('spot_details.spot_live_hint')}</p>

                <button onClick={() => onEditSpot(selectedItem)}
                    className="pq-own-ping-edit w-full border text-[var(--color-text)] font-bold py-3.5 rounded-2xl transition-all text-[15px] active:scale-95 mb-2.5">
                    {t('spot_details.edit_ping')}
                </button>
                <button onClick={onDeletePing}
                    className="w-full border border-red-500/30 hover:bg-red-500/10 text-[var(--color-danger)] font-semibold py-3 rounded-2xl transition-all text-sm active:scale-95">
                    {t('spot_details.delete_ping')}
                </button>
            </div>
        );
    }

    // Third party — spot is taken
    return (
        <div>
            <div className="flex items-center gap-3 mb-4">
                <div className="w-14 h-14 rounded-2xl flex items-center justify-center shrink-0 text-white font-bold text-xl"
                    style={{ background: 'linear-gradient(135deg, var(--color-brand), var(--color-brand-2))' }}>
                    {finderInitial}
                </div>
                <div className="flex-1 min-w-0">
                    <p className="text-lg font-extrabold text-[var(--color-text)] truncate">{finderName}</p>
                    {selectedItem.finderTitle && (
                        <p className="text-[11px] font-semibold text-[var(--color-info)] mt-0.5">{selectedItem.finderTitle}</p>
                    )}
                </div>
            </div>
            <span className="flex w-full text-xs font-bold text-[var(--color-warning)] justify-center px-2 py-3 bg-amber-500/10 rounded-2xl border border-amber-500/20">
                {t('spot_details.someone_on_way')}
            </span>
        </div>
    );
};
