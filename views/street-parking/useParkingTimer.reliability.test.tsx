import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const appListeners: Record<string, (s: { isActive: boolean }) => void> = {};
const removeSpy = vi.fn(async () => {});
let native = false;
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => native, getPlatform: () => (native ? 'ios' : 'web') } }));
vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn(async (ev: string, cb: (s: { isActive: boolean }) => void) => { appListeners[ev] = cb; return { remove: removeSpy }; }) },
}));

import * as mod from './useParkingTimer';
const { useParkingTimer } = mod;

const KEY = 'pq_parking_timer';
const T0 = Date.parse('2026-10-13T12:00:00Z');
const values = new Map<string, string>();
const NotificationMock = vi.fn();
let doc: EventTarget & { visibilityState: string };
type Hook = ReturnType<typeof useParkingTimer>;

function Harness({ expose, onRender }: { expose: (v: Hook) => void; onRender?: () => void }) {
  onRender?.();
  expose(useParkingTimer());
  return null;
}
function mount(onRender?: () => void) {
  const ref: { h: Hook } = { h: null as unknown as Hook };
  let r!: TestRenderer.ReactTestRenderer;
  act(() => { r = TestRenderer.create(<Harness expose={v => { ref.h = v; }} onRender={onRender} />); });
  return { ref, r };
}
const stored = () => (values.get(KEY) ? JSON.parse(values.get(KEY)!) : null);
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });
/** Simulates a suspended WebView: wall clock moves, no JS timers run. */
const suspend = (ms: number) => vi.setSystemTime(Date.now() + ms);
const fire = (target: EventTarget, type: string) => act(() => { target.dispatchEvent(new Event(type)); });
const visible = () => { doc.visibilityState = 'visible'; fire(doc, 'visibilitychange'); };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  values.clear();
  NotificationMock.mockClear();
  native = false;
  for (const k of Object.keys(appListeners)) delete appListeners[k];
  (mod as { __resetParkingTimerForTests?: () => void }).__resetParkingTimerForTests?.();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
    getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => values.set(k, v), removeItem: (k: string) => values.delete(k) } });
  const win = new EventTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(win, { Notification: Object.assign(NotificationMock, { permission: 'granted' }) }) });
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: (globalThis as any).window.Notification });
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: doc });
});
afterEach(() => { vi.useRealTimers(); });

describe('D1: countdown stays fresh while idle', () => {
  it.each([1, 5, 15, 20])('updates the label after %i idle minutes without changing expiresAt', (m) => {
    const { ref, r } = mount();
    act(() => ref.h.startTimer(30, 'Broadway'));
    const expiresAt = stored().expiresAt;
    expect(ref.h.minutesRemaining).toBe(30);
    advance(m * 60_000);
    expect(ref.h.minutesRemaining).toBe(30 - m);
    expect(stored().expiresAt).toBe(expiresAt);
    expect(ref.h.timer?.expiresAt).toBe(expiresAt);
    act(() => r.unmount());
  });

  it('re-renders only when the displayed minute changes', () => {
    let renders = 0;
    const { ref, r } = mount(() => { renders++; });
    act(() => ref.h.startTimer(10, 'A'));
    const base = renders;
    advance(5 * 60_000);
    expect(ref.h.minutesRemaining).toBe(5);
    expect(renders - base).toBeLessThanOrEqual(6);
    act(() => r.unmount());
  });

  it('schedules no ticking timers when there is no timer, and cleans up on unmount', () => {
    const { ref, r } = mount();
    expect(vi.getTimerCount()).toBe(0);
    act(() => ref.h.startTimer(10, 'A'));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    act(() => r.unmount());
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('D2: reconcile on foreground', () => {
  it('refreshes an active timer on visibilitychange after a suspended background', () => {
    const { ref, r } = mount();
    act(() => ref.h.startTimer(30, 'A'));
    doc.visibilityState = 'hidden'; fire(doc, 'visibilitychange');
    suspend(12 * 60_000);
    visible();
    expect(ref.h.minutesRemaining).toBe(18);
    expect(ref.h.timer).not.toBeNull();
    act(() => r.unmount());
  });

  it('clears an overdue timer on visibilitychange when its timeout was suspended', () => {
    const onExpire = vi.fn();
    const { ref, r } = mount();
    act(() => ref.h.startTimer(10, 'A', onExpire));
    suspend(15 * 60_000);
    visible();
    expect(ref.h.timer).toBeNull();
    expect(ref.h.minutesRemaining).toBeNull();
    expect(values.has(KEY)).toBe(false);
    expect(onExpire).toHaveBeenCalledTimes(1);
    advance(60 * 60_000); // late-firing suspended timeout must not double-fire
    expect(onExpire).toHaveBeenCalledTimes(1);
    expect(NotificationMock).toHaveBeenCalledTimes(0);
    act(() => r.unmount());
  });

  it.each(['focus', 'pageshow'])('clears an overdue timer on window %s', (ev) => {
    const { ref, r } = mount();
    act(() => ref.h.startTimer(10, 'A'));
    suspend(11 * 60_000);
    fire((globalThis as any).window, ev);
    expect(ref.h.timer).toBeNull();
    expect(values.has(KEY)).toBe(false);
    act(() => r.unmount());
  });

  it('reconciles on Capacitor appStateChange (native, mocked) and removes the listener on unmount', async () => {
    native = true;
    const { ref, r } = mount();
    await act(async () => { await Promise.resolve(); });
    act(() => ref.h.startTimer(10, 'A'));
    await act(async () => { await Promise.resolve(); });
    expect(appListeners.appStateChange).toBeTypeOf('function');
    suspend(4 * 60_000);
    act(() => appListeners.appStateChange({ isActive: true }));
    expect(ref.h.minutesRemaining).toBe(6);
    suspend(7 * 60_000);
    act(() => appListeners.appStateChange({ isActive: true }));
    expect(ref.h.timer).toBeNull();
    act(() => r.unmount());
    await act(async () => { await Promise.resolve(); });
    expect(removeSpy).toHaveBeenCalled();
  });

  it('natural expiry while foregrounded notifies exactly once and calls onExpire once', () => {
    const onExpire = vi.fn();
    const { ref, r } = mount();
    act(() => ref.h.startTimer(5, 'Broadway', onExpire));
    advance(5 * 60_000 + 10);
    visible(); fire((globalThis as any).window, 'focus');
    advance(10 * 60_000);
    expect(ref.h.timer).toBeNull();
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(onExpire).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  it('two mounted instances produce one notification for the same timer', () => {
    const a = mount(); const b = mount();
    act(() => a.ref.h.startTimer(5, 'A'));
    act(() => b.r.unmount());
    const b2 = mount(); // picks up the stored timer on cold start
    expect(b2.ref.h.timer?.expiresAt).toBe(stored().expiresAt);
    advance(5 * 60_000 + 10);
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    act(() => { a.r.unmount(); b2.r.unmount(); });
  });
});

describe('cold start, cancel, replace, remount', () => {
  it('cold start with a valid stored timer shows the correct remaining minutes', () => {
    values.set(KEY, JSON.stringify({ expiresAt: T0 + 20 * 60_000, address: 'X' }));
    const { ref, r } = mount();
    expect(ref.h.minutesRemaining).toBe(20);
    advance(3 * 60_000);
    expect(ref.h.minutesRemaining).toBe(17);
    act(() => r.unmount());
  });

  it('cold start with an expired stored timer shows nothing and sends no notification', () => {
    values.set(KEY, JSON.stringify({ expiresAt: T0 - 60_000, address: 'X' }));
    const { ref, r } = mount();
    expect(ref.h.timer).toBeNull();
    advance(60_000);
    expect(NotificationMock).not.toHaveBeenCalled();
    act(() => r.unmount());
  });

  it('cancel stops everything; replace uses the new expiresAt only', () => {
    const first = vi.fn(); const second = vi.fn();
    const { ref, r } = mount();
    act(() => ref.h.startTimer(10, 'A', first));
    act(() => ref.h.clearTimer());
    expect(values.has(KEY)).toBe(false);
    advance(11 * 60_000);
    expect(first).not.toHaveBeenCalled();
    act(() => ref.h.startTimer(10, 'B', first));
    advance(2 * 60_000);
    act(() => ref.h.startTimer(30, 'C', second));
    expect(stored().address).toBe('C');
    advance(10 * 60_000);
    expect(first).not.toHaveBeenCalled();
    expect(ref.h.minutesRemaining).toBe(20);
    advance(20 * 60_000 + 10);
    expect(second).toHaveBeenCalledTimes(1);
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  it('unmount then remount keeps the absolute expiry', () => {
    const a = mount();
    act(() => a.ref.h.startTimer(15, 'A'));
    const exp = stored().expiresAt;
    act(() => a.r.unmount());
    suspend(6 * 60_000);
    const b = mount();
    expect(b.ref.h.timer?.expiresAt).toBe(exp);
    expect(b.ref.h.minutesRemaining).toBe(9);
    act(() => b.r.unmount());
  });
});
