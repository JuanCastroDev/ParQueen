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

const win = () => (globalThis as any).window as EventTarget;
const late = (ms: number) => vi.setSystemTime(Date.now() + ms);

describe('ownership: a stale instance never damages a newer timer', () => {
  it('A starts, B replaces, A clears: B stays saved and active; A expiry is silent; B expires once', () => {
    const cbA = vi.fn(); const cbB = vi.fn();
    const A = mount(); const B = mount();
    act(() => A.ref.h.startTimer(10, 'A st', cbA));
    act(() => B.ref.h.startTimer(30, 'B st', cbB));
    const bExp = stored().expiresAt;
    act(() => A.ref.h.clearTimer());
    expect(stored()).toMatchObject({ expiresAt: bExp, address: 'B st' });
    expect(B.ref.h.timer?.expiresAt).toBe(bExp);
    expect(A.ref.h.timer).toBeNull();
    advance(10 * 60_000 + 10); // A's original expiry
    expect(NotificationMock).not.toHaveBeenCalled();
    expect(cbA).not.toHaveBeenCalled();
    expect(stored()?.expiresAt).toBe(bExp);
    expect(B.ref.h.minutesRemaining).toBe(20);
    advance(20 * 60_000);
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(cbB).toHaveBeenCalledTimes(1);
    expect(cbA).not.toHaveBeenCalled();
    expect(values.has(KEY)).toBe(false);
    act(() => { A.r.unmount(); B.r.unmount(); });
  });

  it('A never cleared: its own timeout for the replaced timer neither notifies, calls back, nor deletes B', () => {
    const cbA = vi.fn(); const cbB = vi.fn();
    const A = mount(); const B = mount();
    act(() => A.ref.h.startTimer(5, 'A', cbA));
    act(() => B.ref.h.startTimer(20, 'B', cbB));
    const bExp = stored().expiresAt;
    advance(5 * 60_000 + 10);
    expect(NotificationMock).not.toHaveBeenCalled();
    expect(cbA).not.toHaveBeenCalled();
    expect(stored()?.expiresAt).toBe(bExp);
    advance(15 * 60_000);
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(cbB).toHaveBeenCalledTimes(1);
    act(() => { A.r.unmount(); B.r.unmount(); });
  });

  it('rapid replacement in one instance: only the final timer notifies and calls back', () => {
    const cbs = [vi.fn(), vi.fn(), vi.fn()];
    const { ref, r } = mount();
    act(() => ref.h.startTimer(10, 'x', cbs[0]));
    act(() => ref.h.startTimer(11, 'x', cbs[1]));
    act(() => ref.h.startTimer(12, 'x', cbs[2]));
    advance(12 * 60_000 + 10);
    expect(cbs[0]).not.toHaveBeenCalled();
    expect(cbs[1]).not.toHaveBeenCalled();
    expect(cbs[2]).toHaveBeenCalledTimes(1);
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  it('duplicate instance of the same timer: one notification, starter callback once', () => {
    const cb = vi.fn();
    const A = mount();
    act(() => A.ref.h.startTimer(5, 'same', cb));
    const C = mount(); // cold-start copy of the same stored timer
    expect(C.ref.h.timer).toEqual(A.ref.h.timer);
    advance(5 * 60_000 + 10);
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(A.ref.h.timer).toBeNull(); expect(C.ref.h.timer).toBeNull();
    act(() => { A.r.unmount(); C.r.unmount(); });
  });

  it('cancellation from another instance: the starter stays silent at the old expiry', () => {
    const cb = vi.fn();
    const A = mount();
    act(() => A.ref.h.startTimer(5, 'z', cb));
    const C = mount();
    act(() => C.ref.h.clearTimer());
    expect(values.has(KEY)).toBe(false);
    advance(5 * 60_000 + 10);
    expect(NotificationMock).not.toHaveBeenCalled();
    expect(cb).not.toHaveBeenCalled();
    act(() => { A.r.unmount(); C.r.unmount(); });
  });

  it('unmount/remount keeps expiresAt; the remounted copy notifies once (callback is not persisted)', () => {
    const cb = vi.fn();
    const A = mount();
    act(() => A.ref.h.startTimer(5, 'm', cb));
    const exp = stored().expiresAt;
    act(() => A.r.unmount());
    const B = mount();
    expect(B.ref.h.timer?.expiresAt).toBe(exp);
    advance(5 * 60_000 + 10);
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(cb).not.toHaveBeenCalled();
    act(() => B.r.unmount());
  });
});

describe('resume with a replaced timer', () => {
  it('before A expiry: stale A adopts the stored replacement without changing it', () => {
    const A = mount(); const B = mount();
    act(() => A.ref.h.startTimer(10, 'A'));
    act(() => B.ref.h.startTimer(30, 'B'));
    const bExp = stored().expiresAt;
    suspend(4 * 60_000); visible();
    expect(stored()?.expiresAt).toBe(bExp);
    expect(A.ref.h.timer?.expiresAt).toBe(bExp);
    expect(A.ref.h.minutesRemaining).toBe(26);
    act(() => { A.r.unmount(); B.r.unmount(); });
  });

  it('after A expiry (suspended): no notification, no A callback, B untouched', () => {
    const cbA = vi.fn();
    const A = mount(); const B = mount();
    act(() => A.ref.h.startTimer(10, 'A', cbA));
    act(() => B.ref.h.startTimer(30, 'B'));
    const bExp = stored().expiresAt;
    suspend(12 * 60_000); fire(win(), 'focus'); visible();
    expect(stored()?.expiresAt).toBe(bExp);
    expect(cbA).not.toHaveBeenCalled();
    expect(NotificationMock).not.toHaveBeenCalled();
    expect(B.ref.h.minutesRemaining).toBe(18);
    act(() => { A.r.unmount(); B.r.unmount(); });
  });
});

describe('late timeout tolerance', () => {
  it('timeout firing well after expiresAt (suspended) clears silently: onExpire once, no notification', () => {
    const cb = vi.fn();
    const { ref, r } = mount();
    act(() => ref.h.startTimer(10, 'L', cb));
    late(30_000); // wall clock jumps 30s while timers are frozen
    advance(10 * 60_000); // the frozen timeout now fires 30s late
    expect(NotificationMock).not.toHaveBeenCalled();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(values.has(KEY)).toBe(false);
    expect(ref.h.timer).toBeNull();
    act(() => r.unmount());
  });

  it('timeout within tolerance (3s late) still notifies once', () => {
    const cb = vi.fn();
    const { ref, r } = mount();
    act(() => ref.h.startTimer(10, 'L', cb));
    late(3_000);
    advance(10 * 60_000);
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  it('on-time expiry while the document is hidden still notifies (desktop background tab)', () => {
    const { ref, r } = mount();
    act(() => ref.h.startTimer(2, 'H'));
    doc.visibilityState = 'hidden';
    advance(2 * 60_000 + 10);
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  it('minute-by-minute accuracy for a replacement timer', () => {
    const A = mount(); const B = mount();
    act(() => A.ref.h.startTimer(3, 'A'));
    act(() => B.ref.h.startTimer(6, 'B'));
    for (let m = 1; m <= 5; m++) { advance(60_000); expect(B.ref.h.minutesRemaining).toBe(6 - m); }
    expect(NotificationMock).not.toHaveBeenCalled();
    act(() => { A.r.unmount(); B.r.unmount(); });
  });
});
