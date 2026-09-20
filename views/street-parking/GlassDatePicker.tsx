import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { t, useLang } from '../../i18n';
import { localDateStr } from './dateUtils';

const WEEKDAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;

const parseYmd = (ymd: string): Date => {
    const [y, m, d] = ymd.split('-').map(Number);
    return new Date(y, m - 1, d);
};

const sameYmd = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

const formatDisplay = (ymd: string) => {
    try {
        return parseYmd(ymd).toLocaleDateString(undefined, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        });
    } catch {
        return ymd;
    }
};

const monthTitle = (cursor: Date) =>
    cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

export const GlassDatePicker: React.FC<{
    value: string;
    min?: string;
    onChange: (ymd: string) => void;
    id?: string;
}> = ({ value, min, onChange, id }) => {
    useLang();
    const minYmd = min || localDateStr();
    const selected = useMemo(() => (value ? parseYmd(value) : null), [value]);
    const todayYmd = localDateStr();
    const today = useMemo(() => parseYmd(todayYmd), [todayYmd]);

    const [open, setOpen] = useState(false);
    const [cursor, setCursor] = useState(() => selected || today);
    const rootRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (open) {
            const base = selected || today;
            setCursor(new Date(base.getFullYear(), base.getMonth(), 1));
        }
    }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onDoc);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDoc);
            document.removeEventListener('keydown', onKey);
        };
    }, [open]);

    const cells = useMemo(() => {
        const year = cursor.getFullYear();
        const month = cursor.getMonth();
        const startPad = new Date(year, month, 1).getDay();
        const daysInMonth = new Date(year, month + 1, 0).getDate();
        const prevDays = new Date(year, month, 0).getDate();
        const out: { date: Date; inMonth: boolean; ymd: string; disabled: boolean }[] = [];

        for (let i = startPad - 1; i >= 0; i--) {
            const date = new Date(year, month - 1, prevDays - i);
            const ymd = localDateStr(date);
            out.push({ date, inMonth: false, ymd, disabled: ymd < minYmd });
        }
        for (let d = 1; d <= daysInMonth; d++) {
            const date = new Date(year, month, d);
            const ymd = localDateStr(date);
            out.push({ date, inMonth: true, ymd, disabled: ymd < minYmd });
        }
        let next = 1;
        while (out.length % 7 !== 0 || out.length < 42) {
            const date = new Date(year, month + 1, next++);
            const ymd = localDateStr(date);
            out.push({ date, inMonth: false, ymd, disabled: ymd < minYmd });
            if (out.length >= 42) break;
        }
        return out;
    }, [cursor, minYmd]);

    const canPrev = useMemo(() => {
        const prevMonthEnd = new Date(cursor.getFullYear(), cursor.getMonth(), 0);
        return localDateStr(prevMonthEnd) >= minYmd;
    }, [cursor, minYmd]);

    const selectDay = (ymd: string, disabled: boolean) => {
        if (disabled) return;
        onChange(ymd);
        setOpen(false);
    };

    const goToday = () => {
        if (todayYmd < minYmd) return;
        onChange(todayYmd);
        setCursor(new Date(today.getFullYear(), today.getMonth(), 1));
        setOpen(false);
    };

    const clearToMin = () => {
        // Native Clear empties the field; this screen always needs a schedulable date, so reset to min (today).
        onChange(minYmd);
        const d = parseYmd(minYmd);
        setCursor(new Date(d.getFullYear(), d.getMonth(), 1));
        setOpen(false);
    };

    return (
        <div className="pq-gdate" ref={rootRef}>
            <button
                type="button"
                id={id}
                className={`pq-gdate-trigger${open ? ' is-open' : ''}`}
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => setOpen(o => !o)}
            >
                <span className="pq-gdate-trigger-text">{value ? formatDisplay(value) : t('ping_modal.date')}</span>
                <Calendar size={16} strokeWidth={2} className="pq-gdate-trigger-icon" aria-hidden="true" />
            </button>

            {open && (
                <div className="pq-gdate-panel" role="dialog" aria-label={t('ping_modal.date')}>
                    <div className="pq-gdate-month">
                        <button
                            type="button"
                            className="pq-gdate-nav"
                            aria-label="Previous month"
                            disabled={!canPrev}
                            onClick={() => setCursor(c => new Date(c.getFullYear(), c.getMonth() - 1, 1))}
                        >
                            <ChevronLeft size={18} strokeWidth={2.2} />
                        </button>
                        <p className="pq-gdate-month-label">{monthTitle(cursor)}</p>
                        <button
                            type="button"
                            className="pq-gdate-nav"
                            aria-label="Next month"
                            onClick={() => setCursor(c => new Date(c.getFullYear(), c.getMonth() + 1, 1))}
                        >
                            <ChevronRight size={18} strokeWidth={2.2} />
                        </button>
                    </div>

                    <div className="pq-gdate-weekdays" aria-hidden="true">
                        {WEEKDAYS.map(d => (
                            <span key={d} className="pq-gdate-weekday">{d}</span>
                        ))}
                    </div>

                    <div className="pq-gdate-grid" role="grid" aria-label={monthTitle(cursor)}>
                        {cells.map(({ date, inMonth, ymd, disabled }) => {
                            const isSelected = !!selected && sameYmd(date, selected);
                            const isToday = sameYmd(date, today);
                            const cls = [
                                'pq-gdate-day',
                                inMonth ? '' : ' is-outside',
                                disabled ? ' is-disabled' : '',
                                isSelected ? ' is-selected' : '',
                                isToday && !isSelected ? ' is-today' : '',
                            ].join('');
                            return (
                                <button
                                    key={`${ymd}-${inMonth ? 'in' : 'out'}`}
                                    type="button"
                                    role="gridcell"
                                    className={cls}
                                    disabled={disabled}
                                    aria-selected={isSelected}
                                    aria-current={isToday ? 'date' : undefined}
                                    onClick={() => selectDay(ymd, disabled)}
                                >
                                    {date.getDate()}
                                </button>
                            );
                        })}
                    </div>

                    <div className="pq-gdate-footer">
                        <button type="button" className="pq-gdate-action" onClick={clearToMin}>
                            {t('ping_modal.clear')}
                        </button>
                        <button type="button" className="pq-gdate-action is-accent" onClick={goToday}>
                            {t('ping_modal.today')}
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
};
