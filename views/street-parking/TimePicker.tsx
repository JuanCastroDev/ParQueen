import React, { useState, useEffect, useRef } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { t, useLang } from '../../i18n';

export const TimePicker: React.FC<{
    initialTime: Date;
    onTimeChange: (time: Date) => void;
    variant?: 'default' | 'glass';
}> = ({ initialTime, onTimeChange, variant = 'default' }) => {
    useLang();
    const [hour, setHour] = useState(initialTime.getHours() % 12 || 12);
    const [minute, setMinute] = useState(initialTime.getMinutes());
    const [amPm, setAmPm] = useState<'AM' | 'PM'>(initialTime.getHours() >= 12 ? 'PM' : 'AM');
    const hourInputRef = useRef<HTMLInputElement>(null);
    const minuteInputRef = useRef<HTMLInputElement>(null);
    const glass = variant === 'glass';

    const updateTime = (h: number, m: number, ap: 'AM' | 'PM') => {
        const newDate = new Date(initialTime);
        let newHour = h;
        if (ap === 'PM' && newHour < 12) newHour += 12;
        if (ap === 'AM' && newHour === 12) newHour = 0;
        newDate.setHours(newHour, m, 0, 0);
        onTimeChange(newDate);
    };

    useEffect(() => { updateTime(hour, minute, amPm); }, [hour, minute, amPm]);

    useEffect(() => {
        if (hourInputRef.current && document.activeElement !== hourInputRef.current)
            hourInputRef.current.value = hour.toString().padStart(2, '0');
    }, [hour]);

    useEffect(() => {
        if (minuteInputRef.current && document.activeElement !== minuteInputRef.current)
            minuteInputRef.current.value = minute.toString().padStart(2, '0');
    }, [minute]);

    const incrementHour = () => setHour(h => (h % 12) + 1);
    const decrementHour = () => setHour(h => (h - 1 <= 0 ? 12 : h - 1));
    const incrementMinute = () => setMinute(m => (m + 1) % 60);
    const decrementMinute = () => setMinute(m => (m - 1 < 0 ? 59 : m - 1));

    const handleHourChange = (raw: string) => {
        const digits = raw.replace(/\D/g, '').slice(0, 2);
        if (hourInputRef.current) hourInputRef.current.value = digits;
        if (digits === '') return;
        const n = parseInt(digits, 10);
        if (digits.length === 2 && n >= 1 && n <= 12) {
            setHour(n);
            minuteInputRef.current?.focus();
            minuteInputRef.current?.select();
        }
    };

    const handleHourBlur = () => {
        const raw = hourInputRef.current?.value || '';
        const n = parseInt(raw, 10);
        const valid = n >= 1 && n <= 12 ? n : hour;
        setHour(valid);
        if (hourInputRef.current) hourInputRef.current.value = valid.toString().padStart(2, '0');
    };

    const handleMinuteChange = (raw: string) => {
        const digits = raw.replace(/\D/g, '').slice(0, 2);
        if (minuteInputRef.current) minuteInputRef.current.value = digits;
        if (digits === '') return;
        const n = parseInt(digits, 10);
        if (digits.length === 2 && n >= 0 && n <= 59) {
            setMinute(n);
            minuteInputRef.current?.blur();
        }
    };

    const handleMinuteBlur = () => {
        const raw = minuteInputRef.current?.value || '';
        const n = parseInt(raw, 10);
        const valid = n >= 0 && n <= 59 ? n : minute;
        setMinute(valid);
        if (minuteInputRef.current) minuteInputRef.current.value = valid.toString().padStart(2, '0');
    };

    const chevronClass = glass
        ? 'pq-time-chevron'
        : 'w-10 h-10 rounded-xl flex items-center justify-center text-[var(--color-text-secondary)] hover:bg-[var(--color-overlay)] active:scale-90 transition-all';
    const digitInputClass = glass
        ? 'pq-time-digit'
        : 'text-4xl font-bold w-16 text-center text-[var(--color-text)] tabular-nums bg-transparent border-none outline-none focus:bg-[var(--color-overlay)] rounded-lg caret-transparent';

    return (
        <div className={glass ? 'pq-time' : 'flex items-center justify-center gap-2'}>
            <span className="sr-only" aria-live="polite">
                {t('time_picker.selected', { time: `${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')} ${amPm}` })}
            </span>
            <div className={glass ? 'pq-time-wheel' : 'flex items-center gap-2'}>
                <div className={glass ? 'pq-time-col' : 'flex flex-col items-center'}>
                    <button type="button" aria-label={t('time_picker.increase_hour')} onClick={incrementHour} className={chevronClass}><ChevronUp size={glass ? 18 : 22} /></button>
                    <input
                        ref={hourInputRef}
                        type="text"
                        aria-label={t('time_picker.hour')}
                        inputMode="numeric"
                        pattern="[0-9]*"
                        defaultValue={hour.toString().padStart(2, '0')}
                        maxLength={2}
                        onChange={(e) => handleHourChange(e.target.value)}
                        onFocus={(e) => e.target.select()}
                        onClick={(e) => (e.target as HTMLInputElement).select()}
                        onBlur={handleHourBlur}
                        className={digitInputClass}
                    />
                    <button type="button" aria-label={t('time_picker.decrease_hour')} onClick={decrementHour} className={chevronClass}><ChevronDown size={glass ? 18 : 22} /></button>
                </div>
                <span className={glass ? 'pq-time-colon' : 'text-3xl font-bold text-[var(--color-text)] pb-1'} aria-hidden="true">:</span>
                <div className={glass ? 'pq-time-col' : 'flex flex-col items-center'}>
                    <button type="button" aria-label={t('time_picker.increase_minute')} onClick={incrementMinute} className={chevronClass}><ChevronUp size={glass ? 18 : 22} /></button>
                    <input
                        ref={minuteInputRef}
                        type="text"
                        aria-label={t('time_picker.minute')}
                        inputMode="numeric"
                        pattern="[0-9]*"
                        defaultValue={minute.toString().padStart(2, '0')}
                        maxLength={2}
                        onChange={(e) => handleMinuteChange(e.target.value)}
                        onFocus={(e) => e.target.select()}
                        onClick={(e) => (e.target as HTMLInputElement).select()}
                        onBlur={handleMinuteBlur}
                        className={digitInputClass}
                    />
                    <button type="button" aria-label={t('time_picker.decrease_minute')} onClick={decrementMinute} className={chevronClass}><ChevronDown size={glass ? 18 : 22} /></button>
                </div>
            </div>
            <div
                role="group"
                aria-label={t('time_picker.period')}
                className={glass ? 'pq-time-period' : 'flex flex-col gap-1.5 ml-2'}
            >
                <button type="button" aria-label="AM" aria-pressed={amPm === 'AM'} onClick={() => setAmPm('AM')}
                    className={glass
                        ? `pq-time-period-btn${amPm === 'AM' ? ' is-active' : ''}`
                        : `px-3 py-1.5 rounded-lg text-sm font-bold transition-all ${amPm === 'AM' ? 'bg-blue-500 text-white' : 'bg-[var(--color-overlay)] text-[var(--color-text-secondary)] border border-[var(--color-border)]'}`}>
                    AM
                </button>
                <button type="button" aria-label="PM" aria-pressed={amPm === 'PM'} onClick={() => setAmPm('PM')}
                    className={glass
                        ? `pq-time-period-btn${amPm === 'PM' ? ' is-active' : ''}`
                        : `px-3 py-1.5 rounded-lg text-sm font-bold transition-all ${amPm === 'PM' ? 'bg-blue-500 text-white' : 'bg-[var(--color-overlay)] text-[var(--color-text-secondary)] border border-[var(--color-border)]'}`}>
                    PM
                </button>
            </div>
        </div>
    );
};
