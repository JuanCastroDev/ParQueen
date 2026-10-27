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

const cancel = (h: Hook) => (h as Hook & { cancelCurrentReminder: () => void }).cancelCurrentReminder();

describe('End Session cancels the one global reminder', () => {
  it('A starts, B replaces, A ordinary clear: B survives (guarded clear unchanged)', () => {
    const A = mount(); const B = mount();
    act(() => A.ref.h.startTimer(10, 'A'));
    act(() => B.ref.h.startTimer(30, 'B'));
    act(() => A.ref.h.clearTimer());
    expect(stored()?.address).toBe('B');
    expect(B.ref.h.timer?.address).toBe('B');
    act(() => { A.r.unmount(); B.r.unmount(); });
  });

  it('A starts, B replaces, End Session from stale A cancels the persisted reminder everywhere', () => {
    const cbA = vi.fn(); const cbB = vi.fn();
    const A = mount(); const B = mount();
    act(() => A.ref.h.startTimer(10, 'A', cbA));
    act(() => B.ref.h.startTimer(30, 'B', cbB));
    act(() => cancel(A.ref.h));
    expect(values.has(KEY)).toBe(false);
    expect(A.ref.h.timer).toBeNull();
    expect(B.ref.h.timer).toBeNull(); // the other screen stops displaying it immediately
    expect(B.ref.h.minutesRemaining).toBeNull();
    advance(60 * 60_000);
    visible();
    expect(NotificationMock).not.toHaveBeenCalled();
    expect(cbA).not.toHaveBeenCalled();
    expect(cbB).not.toHaveBeenCalled();
    act(() => { A.r.unmount(); B.r.unmount(); });
  });

  it('End Session from a screen showing no timer still cancels the stored reminder', () => {
    const cb = vi.fn();
    const B = mount();
    const S = mount(); // nothing stored yet: S shows no timer
    act(() => B.ref.h.startTimer(5, 'B2', cb));
    expect(S.ref.h.timer).toBeNull();
    act(() => cancel(S.ref.h));
    expect(values.has(KEY)).toBe(false);
    expect(B.ref.h.timer).toBeNull();
    advance(10 * 60_000);
    expect(NotificationMock).not.toHaveBeenCalled();
    expect(cb).not.toHaveBeenCalled();
    act(() => { B.r.unmount(); S.r.unmount(); });
  });

  it('a cancelled timer never notifies even if a suspended timeout fires late', () => {
    const cb = vi.fn();
    const A = mount();
    act(() => A.ref.h.startTimer(5, 'A', cb));
    const C = mount(); // copy that will not get a chance to re-render before its timeout
    act(() => cancel(A.ref.h));
    suspend(6 * 60_000); advance(6 * 60_000); visible(); fire((globalThis as any).window, 'focus');
    expect(NotificationMock).not.toHaveBeenCalled();
    expect(cb).not.toHaveBeenCalled();
    expect(C.ref.h.timer).toBeNull();
    act(() => { A.r.unmount(); C.r.unmount(); });
  });

  it('a new timer after cancellation works normally, with exactly one notification', () => {
    const cb = vi.fn();
    const A = mount(); const B = mount();
    act(() => A.ref.h.startTimer(5, 'A'));
    act(() => cancel(B.ref.h));
    act(() => B.ref.h.startTimer(3, 'N', cb));
    advance(60_000);
    expect(B.ref.h.minutesRemaining).toBe(2);
    advance(2 * 60_000 + 10);
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledTimes(1);
    act(() => { A.r.unmount(); B.r.unmount(); });
  });
});

describe('identity collision: same expiresAt and address', () => {
  it('cancel then identical restart in the same ms: the new timer notifies and calls back', () => {
    const cb1 = vi.fn(); const cb2 = vi.fn();
    const { ref, r } = mount();
    act(() => ref.h.startTimer(5, 'Same', cb1));
    act(() => cancel(ref.h));
    act(() => ref.h.startTimer(5, 'Same', cb2)); // clock frozen: identical key
    advance(5 * 60_000 + 10);
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });

  it('A replaced by an identical B from another screen: only B callback, one notification', () => {
    const cbA = vi.fn(); const cbB = vi.fn();
    const A = mount(); const B = mount();
    act(() => A.ref.h.startTimer(10, 'Same', cbA));
    advance(5 * 60_000);
    act(() => B.ref.h.startTimer(5, 'Same', cbB)); // same expiresAt, same address
    expect(stored().expiresAt).toBe(A.ref.h.timer?.expiresAt);
    advance(5 * 60_000 + 10);
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(cbA).not.toHaveBeenCalled();
    expect(cbB).toHaveBeenCalledTimes(1);
    act(() => { A.r.unmount(); B.r.unmount(); });
  });

  it('stale A holding an identical-key timer does not keep showing it after expiry', () => {
    const A = mount(); const B = mount();
    act(() => A.ref.h.startTimer(10, 'Same'));
    act(() => cancel(B.ref.h));
    advance(5 * 60_000);
    act(() => B.ref.h.startTimer(5, 'Same'));
    visible(); // A adopts the stored timer
    advance(5 * 60_000 + 10);
    expect(A.ref.h.timer).toBeNull();
    expect(B.ref.h.timer).toBeNull();
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    act(() => { A.r.unmount(); B.r.unmount(); });
  });
});
