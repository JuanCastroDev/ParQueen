import { useState, useEffect, useRef, useCallback } from 'react';
import { App as CapacitorApp } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';

const STORAGE_KEY = 'pq_parking_timer';

/** Stored under pq_parking_timer. `id` is new and optional: legacy records ({expiresAt, address}) still load. */
interface ParkingTimer {
    expiresAt: number;
    address: string;
    id?: string;
}

/**
 * An expiry discovered at most this long after expiresAt (inclusive) still gets the single on-time
 * notification; anything later was suspended (backgrounded WebView, sleep) and is cleared silently.
 * Applied identically by the timeout and the foreground reconcile, so their order never changes the result.
 * 5s: well above normal timer jitter and the ~1s alignment browsers apply to a single (non-chained)
 * timeout in a hidden tab, and far below any real suspension we care about.
 */
const LATE_NOTIFY_TOLERANCE_MS = 5_000;

/** Per-start identity. randomUUID needs Safari/iOS 15.4+, so fall back to getRandomValues (iOS 15.0,
 *  Android WebView). Last resort only matters for identity, not security. */
function newTimerId(): string {
    const c = (globalThis as { crypto?: Crypto }).crypto;
    if (c && typeof c.randomUUID === 'function') return c.randomUUID();
    if (c && typeof c.getRandomValues === 'function') {
        const bytes = c.getRandomValues(new Uint8Array(16));
        return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
    }
    return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}`;
}

// Identity: the id when present; legacy (id-less) records fall back to expiresAt + address.
const timerKey = (t: ParkingTimer) => (t.id ? `id:${t.id}` : `legacy:${t.expiresAt}|${t.address}`);
const sameTimer = (a: ParkingTimer | null, b: ParkingTimer | null) => {
    if (!a || !b) return false;
    if (a.id || b.id) return !!a.id && a.id === b.id; // exactly one id => different timers
    return a.expiresAt === b.expiresAt && a.address === b.address;
};

// Page-wide guards shared by every hook instance (same tab only).
const notifiedTimers = new Set<string>(); // one notification per timer
const expiredTimers = new Set<string>(); // genuinely expired (vs cancelled/replaced)
const cancelledTimers = new Set<string>(); // End Session: never notify or fire onExpire
// Same-tab signal so every mounted instance (Map, Assistant) drops a cancelled reminder at once.
const CANCEL_EVENT = 'pq-parking-timer-cancelled';

/** Test-only: reset the module-level guards. */
export function __resetParkingTimerForTests() {
    notifiedTimers.clear();
    expiredTimers.clear();
    cancelledTimers.clear();
}

function readStored(): ParkingTimer | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as ParkingTimer;
        if (typeof parsed?.expiresAt !== 'number') return null;
        return typeof parsed.id === 'string' && parsed.id ? parsed : { expiresAt: parsed.expiresAt, address: parsed.address };
    } catch { return null; }
}

const minutesLeft = (t: ParkingTimer | null) =>
    t ? Math.max(0, Math.ceil((t.expiresAt - Date.now()) / 60_000)) : null;

export function useParkingTimer() {
    const [timer, setTimer] = useState<ParkingTimer | null>(() => {
        const parsed = readStored();
        return parsed && parsed.expiresAt > Date.now() ? parsed : null;
    });
    // Displayed minute; only used to trigger a re-render when it changes (setState bails out on equal values).
    const [, setDisplayedMinute] = useState<number | null>(() => minutesLeft(timer));
    const timerRef = useRef(timer);
    timerRef.current = timer;
    // onExpire belongs to the timer (id) this instance started; it never runs for any other timer.
    const onExpireRef = useRef<{ key: string; fn: () => void } | null>(null);
    // Per-instance guard: each timer is finished at most once by this instance.
    const finishedRef = useRef<string | null>(null);

    const showTimer = useCallback((t: ParkingTimer | null) => {
        timerRef.current = t;
        if (t) finishedRef.current = null;
        setTimer(t);
        setDisplayedMinute(minutesLeft(t));
    }, []);

    const startTimer = (minutes: number, address: string, onExpire?: () => void) => {
        const t: ParkingTimer = { expiresAt: Date.now() + minutes * 60_000, address, id: newTimerId() };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(t));
        onExpireRef.current = onExpire ? { key: timerKey(t), fn: onExpire } : null;
        showTimer(t);
    };

    /** Cancel. Removes the stored timer only if it is the one this instance shows (or this instance shows
     *  none, the existing explicit-clear behavior); a newer timer saved by another screen is left untouched. */
    const clearTimer = useCallback(() => {
        const own = timerRef.current;
        if (!own || sameTimer(readStored(), own)) localStorage.removeItem(STORAGE_KEY);
        onExpireRef.current = null;
        showTimer(null);
    }, [showTimer]);

    /** Explicit End Parking Session: cancels whatever reminder is persisted, whichever screen created it.
     *  Separate from clearTimer (which stays guarded). Never notifies, never runs onExpire, not marked expired. */
    const cancelCurrentReminder = useCallback(() => {
        const stored = readStored();
        if (stored) cancelledTimers.add(timerKey(stored));
        const own = timerRef.current;
        if (own) cancelledTimers.add(timerKey(own));
        localStorage.removeItem(STORAGE_KEY);
        onExpireRef.current = null;
        showTimer(null);
        if (typeof window !== 'undefined') window.dispatchEvent(new Event(CANCEL_EVENT));
    }, [showTimer]);

    const runOwnCallback = (key: string) => {
        const cb = onExpireRef.current;
        if (cb && cb.key === key) { onExpireRef.current = null; cb.fn(); }
    };

    /** Expiry side effects, re-checked against storage right before acting. Idempotent per timer.
     *  Same rule whichever path (timeout or foreground reconcile) discovers the expiry first. */
    const finish = useCallback((t: ParkingTimer) => {
        if (Date.now() < t.expiresAt) return; // only ever called at/after expiry
        const key = timerKey(t);
        if (finishedRef.current === key) return;
        finishedRef.current = key;
        if (cancelledTimers.has(key)) { showTimer(null); return; } // cancelled: silent
        const stored = readStored();
        if (sameTimer(stored, t)) {
            // Still the current timer: it genuinely expired.
            localStorage.removeItem(STORAGE_KEY);
            expiredTimers.add(key);
            const withinTolerance = Date.now() - t.expiresAt <= LATE_NOTIFY_TOLERANCE_MS;
            if (withinTolerance && !notifiedTimers.has(key) && 'Notification' in window && Notification.permission === 'granted') {
                new Notification('ParQueen — Time to check your car', {
                    body: `Your parking reminder is up${t.address ? ` at ${t.address}` : ''}.`,
                    icon: '/Parqueen_Logo.png',
                });
            }
            notifiedTimers.add(key);
            showTimer(null);
            runOwnCallback(key);
        } else if (!stored && expiredTimers.has(key)) {
            // Another instance already expired this same timer (and notified if within tolerance).
            showTimer(null);
            runOwnCallback(key);
        } else if (stored && stored.expiresAt > Date.now()) {
            // Replaced by a newer timer elsewhere: show it, never touch it, no callback for the obsolete one.
            showTimer(stored);
        } else {
            // Cancelled elsewhere (or an unrelated stale record): drop silently, storage untouched.
            showTimer(null);
        }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [showTimer]);

    /** Re-derive state from storage and the absolute expiresAt; never extends or restarts a timer. */
    const reconcile = useCallback(() => {
        const t = timerRef.current;
        if (!t) return;
        if (Date.now() >= t.expiresAt) { finish(t); return; }
        const stored = readStored();
        if (sameTimer(stored, t)) { setDisplayedMinute(minutesLeft(t)); return; }
        showTimer(stored && stored.expiresAt > Date.now() ? stored : null);
    }, [finish, showTimer]);

    // Expiry timeout + minute-aligned tick, only while a timer exists.
    useEffect(() => {
        if (!timer) return;
        const remaining = timer.expiresAt - Date.now();
        if (remaining <= 0) { finish(timer); return; }

        const expiryId = setTimeout(() => finish(timer), remaining);
        let tickId: ReturnType<typeof setTimeout> | undefined;
        const scheduleTick = () => {
            const left = timer.expiresAt - Date.now();
            if (left <= 0) return;
            // Fire when the displayed (ceil) minute changes.
            const delay = left % 60_000 || 60_000;
            tickId = setTimeout(() => {
                setDisplayedMinute(minutesLeft(timer));
                scheduleTick();
            }, delay);
        };
        scheduleTick();

        return () => { clearTimeout(expiryId); if (tickId) clearTimeout(tickId); };
    }, [timer, finish]);

    // Foreground reconciliation (browser): suspended timeouts may not have fired.
    useEffect(() => {
        if (!timer) return;
        if (typeof document === 'undefined' || typeof window === 'undefined') return;
        const onVisibility = () => { if (document.visibilityState === 'visible') reconcile(); };
        document.addEventListener('visibilitychange', onVisibility);
        window.addEventListener('focus', reconcile);
        window.addEventListener('pageshow', reconcile);
        window.addEventListener(CANCEL_EVENT, reconcile);
        return () => {
            window.removeEventListener(CANCEL_EVENT, reconcile);
            document.removeEventListener('visibilitychange', onVisibility);
            window.removeEventListener('focus', reconcile);
            window.removeEventListener('pageshow', reconcile);
        };
    }, [timer, reconcile]);

    // Foreground reconciliation (native): Capacitor appStateChange, listener handle removed on cleanup.
    useEffect(() => {
        if (!timer || !Capacitor.isNativePlatform()) return;
        let removed = false;
        let handle: { remove: () => Promise<void> } | undefined;
        void CapacitorApp.addListener('appStateChange', ({ isActive }) => { if (isActive) reconcile(); })
            .then(l => { if (removed) void l.remove(); else handle = l; })
            .catch(() => { /* listener unavailable: browser events still reconcile */ });
        return () => { removed = true; if (handle) void handle.remove(); };
    }, [timer, reconcile]);

    const minutesRemaining = minutesLeft(timer);

    return { timer, minutesRemaining, startTimer, clearTimer, cancelCurrentReminder };
}
