import React, { useState, useEffect } from 'react';
import { MapPin, Zap, Clock, Check, ChevronLeft } from 'lucide-react';
import { StreetSpot } from '../../types';
import { TimePicker } from './TimePicker';
import { GlassDatePicker } from './GlassDatePicker';
import { BottomSheet } from './BottomSheet';
import { localDateStr, combineDateAndTime } from './dateUtils';
import { t, useLang } from '../../i18n';

interface SpotModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSave: (departure: Date | null) => void;
    spot?: StreetSpot | null;
    spotAddress?: string;
    user?: any;
}

export const SpotModal: React.FC<SpotModalProps> = ({ isOpen, onClose, onSave, spot, spotAddress, user }) => {
    useLang();
    const [view, setView] = useState<'main' | 'timePicker'>('main');
    const [departureTime, setDepartureTime] = useState(new Date());
    const [selectedDateStr, setSelectedDateStr] = useState(() => localDateStr());
    const [pingType, setPingType] = useState<'now' | 'later'>('now');
    const [timeError, setTimeError] = useState<string | null>(null);

    useEffect(() => {
        if (isOpen) {
            const hasToDate = spot && spot.reportedAt && typeof spot.reportedAt.toDate === 'function';
            const initialDate = hasToDate
                ? spot.reportedAt.toDate()
                : (spot && spot.reportedAt ? new Date(spot.reportedAt) : new Date(Date.now() + 2 * 60_000));
            setDepartureTime(initialDate);
            setSelectedDateStr(localDateStr());
            setPingType('now');
            setView('main');
            setTimeError(null);
        }
    }, [spot, isOpen]);

    const handleSetTime = () => {
        if (pingType === 'later') {
            const combined = combineDateAndTime(selectedDateStr, departureTime);
            if (combined.getTime() <= Date.now()) {
                setTimeError('Please choose a future time.');
                return;
            }
            onSave(combined);
            return;
        }
        onSave(null);
    };

    const isEditing = !!spot;

    return (
        <BottomSheet isOpen={isOpen} onClose={onClose} ariaLabel={t('ping_modal.sheet_label')}>
            {view === 'main' ? (
                <div>
                    <div className="pq-ping-sheet-header flex flex-col items-center text-center mb-6">
                        <p className="pq-ping-sheet-eyebrow text-[10px] font-semibold tracking-widest uppercase text-[var(--color-info)] mb-1">{t('ping_modal.eyebrow')}</p>
                        <h2 className="pq-ping-sheet-title text-[17px] font-bold text-[var(--color-text)] leading-snug">
                            {isEditing ? t('ping_modal.title_edit') : t('ping_modal.title_new')}
                        </h2>
                        <p className="pq-ping-sheet-subtitle text-[12px] text-[var(--color-text-secondary)] mt-1">{t('ping_modal.subtitle')}</p>
                        <div className="pq-ping-sheet-location flex items-center gap-1.5 mt-3.5 px-3 py-1.5 rounded-xl max-w-full">
                            <MapPin size={12} className="text-[var(--color-info)] shrink-0" />
                            <p className="text-[12px] font-semibold text-[var(--color-text)] truncate">{spotAddress || t('ping_modal.locating')}</p>
                        </div>
                    </div>

                    <div className="space-y-3">
                        <button
                            onClick={() => setPingType('now')}
                            className={`pq-ping-option w-full p-3.5 flex items-center gap-3 transition-all ${
                                pingType === 'now' ? 'is-selected' : ''
                            }`}
                        >
                            <div className={`pq-ping-option-icon w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                                pingType === 'now' ? 'is-selected' : ''
                            }`}>
                                <Zap size={18} />
                            </div>
                            <div className="flex-1 text-left">
                                <div className="text-sm font-bold text-[var(--color-text)]">{t('ping_modal.leaving_now')}</div>
                                <div className="text-[11px] text-[var(--color-text-secondary)]">{t('ping_modal.spot_opens')}</div>
                            </div>
                            <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                                pingType === 'now' ? 'pq-ping-option-radio is-selected border-transparent' : 'pq-ping-option-radio border-[var(--color-border)]'
                            }`}>
                                {pingType === 'now' && <Check size={12} className="text-white" />}
                            </div>
                        </button>

                        <button
                            onClick={() => { setPingType('later'); setView('timePicker'); }}
                            className={`pq-ping-option w-full p-3.5 flex items-center gap-3 transition-all ${
                                pingType === 'later' ? 'is-selected' : ''
                            }`}
                        >
                            <div className={`pq-ping-option-icon w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                                pingType === 'later' ? 'is-selected' : ''
                            }`}>
                                <Clock size={18} />
                            </div>
                            <div className="flex-1 text-left">
                                <div className="text-sm font-bold text-[var(--color-text)]">{t('ping_modal.leaving_later')}</div>
                                <div className="text-[11px] text-[var(--color-text-secondary)]">
                                    {pingType === 'later'
                                        ? (() => {
                                            const combined = combineDateAndTime(selectedDateStr, departureTime);
                                            const isToday = combined.toDateString() === new Date().toDateString();
                                            const time = combined.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                                            return isToday ? time : combined.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) + ' · ' + time;
                                        })()
                                        : t('ping_modal.set_time')}
                                </div>
                            </div>
                            <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center shrink-0 ${
                                pingType === 'later' ? 'pq-ping-option-radio is-selected border-transparent' : 'pq-ping-option-radio border-[var(--color-border)]'
                            }`}>
                                {pingType === 'later' && <Check size={12} className="text-white" />}
                            </div>
                        </button>
                    </div>

                    {timeError && (
                        <p className="mt-4 text-sm text-[var(--color-danger)] font-semibold text-center">{t('ping_modal.future_time_error')}</p>
                    )}
                    <button
                        onClick={handleSetTime}
                        className="pq-ping-sheet-cta w-full mt-4 font-bold py-3.5 rounded-full flex items-center justify-center gap-2 text-white active:scale-[0.98] transition-transform"
                    >
                        <MapPin size={18} />
                        <span>{isEditing ? t('ping_modal.update') : pingType === 'later' ? t('ping_modal.schedule_ping') : t('ping_modal.ping_now')}</span>
                    </button>
                </div>
            ) : (
                <>
                    {/* Header */}
                    <div className="flex items-center gap-3 mb-4">
                        <button
                            onClick={() => setView('main')}
                            aria-label={t('ping_modal.back')}
                            className="w-9 h-9 rounded-full bg-[var(--color-card)] border border-[var(--color-border)] flex items-center justify-center shrink-0"
                        >
                            <ChevronLeft size={18} className="text-[var(--color-text-secondary)]" />
                        </button>
                        <div>
                            <p className="text-[10px] font-semibold tracking-widest uppercase text-[var(--color-info)] mb-0.5">{t('ping_modal.schedule_eyebrow')}</p>
                            <p className="text-[16px] font-semibold text-[var(--color-text)] leading-tight">{t('ping_modal.schedule_title')}</p>
                            <p className="text-[12px] text-[var(--color-text-secondary)] mt-0.5">{t('ping_modal.schedule_subtitle')}</p>
                        </div>
                    </div>

                    {/* Date — shared GlassDatePicker (same as Set Departure Time) */}
                    <p className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-widest mb-1.5">{t('ping_modal.date')}</p>
                    <div className="mb-3">
                        <GlassDatePicker
                            id="pq-ping-later-date"
                            value={selectedDateStr}
                            min={localDateStr()}
                            onChange={setSelectedDateStr}
                        />
                    </div>

                    {/* Time */}
                    <p className="text-[10px] font-semibold text-[var(--color-text-secondary)] uppercase tracking-widest mb-1.5">{t('ping_modal.time')}</p>
                    <div className="mb-3 rounded-2xl bg-[var(--color-card)] border border-[var(--color-border)] px-3 py-2">
                        <TimePicker initialTime={departureTime} onTimeChange={setDepartureTime} variant="glass" />
                    </div>

                    {/* Helper */}
                    <p className="text-[11px] text-[var(--color-text-secondary)] text-center mb-3 px-2 leading-relaxed">{t('ping_modal.schedule_helper')}</p>

                    {timeError && (
                        <p className="mb-3 text-sm text-[var(--color-danger)] font-semibold text-center">{t('ping_modal.future_time_error')}</p>
                    )}
                    <button
                        onClick={() => {
                            const combined = combineDateAndTime(selectedDateStr, departureTime);
                            if (combined.getTime() <= Date.now()) {
                                setTimeError('Please choose a future time.');
                                return;
                            }
                            onSave(combined);
                        }}
                        className="pq-ping-sheet-cta w-full font-bold py-3.5 rounded-full flex items-center justify-center gap-2 text-white active:scale-[0.98] transition-transform"
                    >
                        <MapPin size={18} />
                        {isEditing ? t('ping_modal.update') : t('ping_modal.schedule_ping')}
                    </button>
                </>
            )}
        </BottomSheet>
    );
};
