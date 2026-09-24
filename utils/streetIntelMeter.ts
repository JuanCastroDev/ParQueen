import { formatDaysLabel } from './streetIntelDays';
import { nycMinutesSinceMidnight, nycWeekday } from './streetIntelligence';

export interface MeterWindow {
  side: string;
  days: string[];
  startTime: string;
  endTime: string;
}

function formatClock(time: string): string {
  const [hourText, minuteText] = time.split(':');
  const hour = Number(hourText);
  const minute = Number(minuteText);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) return time;
  const ampm = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour % 12 || 12;
  return minute === 0 ? `${displayHour} ${ampm}` : `${displayHour}:${String(minute).padStart(2, '0')} ${ampm}`;
}

export function formatMeterWindowLabel(window: MeterWindow): string {
  const days = formatDaysLabel(window.days);
  return `${days} · ${formatClock(window.startTime)}–${formatClock(window.endTime)}`;
}

export function isMeterWindowActive(window: MeterWindow, now: Date = new Date()): boolean {
  const today = nycWeekday(now);
  if (!window.days.includes(today)) return false;
  const nowMinutes = nycMinutesSinceMidnight(now);
  const [sh, sm] = window.startTime.split(':').map(Number);
  const [eh, em] = window.endTime.split(':').map(Number);
  if (![sh, sm, eh, em].every(Number.isFinite)) return false;
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  if (end < start) return nowMinutes >= start || nowMinutes < end;
  return nowMinutes >= start && nowMinutes < end;
}

export function formatMeterStatus(windows: MeterWindow[], now: Date = new Date()): string {
  if (windows.some(window => isMeterWindowActive(window, now))) {
    const active = windows.find(window => isMeterWindowActive(window, now));
    return active ? `Meter active · until ${formatClock(active.endTime)}` : 'Metered parking';
  }
  if (windows.length) return 'Meter not active right now';
  return 'Metered parking';
}

export function formatMaxStay(minutes: number | null | undefined): string | null {
  if (!Number.isInteger(minutes) || !minutes || minutes <= 0) return null;
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '1 hr maximum' : `${hours} hr maximum`;
  }
  return `${minutes} min maximum`;
}
