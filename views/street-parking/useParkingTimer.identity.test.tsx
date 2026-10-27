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
const setPermission = (p: string) => { (NotificationMock as any).permission = p; };
afterEach(() => setPermission('granted'));

describe('LOW-1: durable per-start id', () => {
  it('stores {expiresAt, address, id} under pq_parking_timer with a unique id per start', () => {
    const { ref, r } = mount();
    act(() => ref.h.startTimer(5, 'X'));
    const first = stored();
    expect(typeof first.id).toBe('string');
    expect(first.id.length).toBeGreaterThanOrEqual(16);
    act(() => ref.h.startTimer(5, 'X')); // same ms, same address
    const second = stored();
    expect(second.expiresAt).toBe(first.expiresAt);
    expect(second.address).toBe(first.address);
    expect(second.id).not.toBe(first.id);
    act(() => r.unmount());
  });

  it('QA collision: stale A clear does not delete an identical-timestamp replacement B', () => {
    const cbA = vi.fn(); const cbB = vi.fn();
    const A = mount(); const B = mount();
    act(() => A.ref.h.startTimer(5, 'Same', cbA));
    act(() => B.ref.h.startTimer(5, 'Same', cbB)); // identical expiresAt + address
    const bId = stored().id;
    act(() => A.ref.h.clearTimer());
    expect(stored()?.id).toBe(bId);
    expect(B.ref.h.timer).not.toBeNull();
    advance(5 * 60_000 + 10);
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(cbA).not.toHaveBeenCalled();
    expect(cbB).toHaveBeenCalledTimes(1);
    act(() => { A.r.unmount(); B.r.unmount(); });
  });

  it('QA collision after remount/reload: the reloaded screen owns only the stored id', () => {
    const cbA = vi.fn();
    const A = mount();
    act(() => A.ref.h.startTimer(5, 'Same', cbA));
    const B = mount();
    act(() => B.ref.h.startTimer(5, 'Same'));
    const bId = stored().id;
    act(() => B.r.unmount());
    const reloaded = mount(); // cold start reads B (with id)
    expect((reloaded.ref.h.timer as any)?.id).toBe(bId);
    act(() => A.ref.h.clearTimer()); // stale A
    expect(stored()?.id).toBe(bId);
    act(() => reloaded.ref.h.clearTimer());
    expect(values.has(KEY)).toBe(false);
    act(() => { A.r.unmount(); reloaded.r.unmount(); });
  });

  it('legacy record without id reloads, counts down and expires (one notification)', () => {
    values.set(KEY, JSON.stringify({ expiresAt: T0 + 3 * 60_000, address: 'Legacy' }));
    const a = mount(); const b = mount();
    expect(a.ref.h.minutesRemaining).toBe(3);
    advance(60_000);
    expect(a.ref.h.minutesRemaining).toBe(2);
    advance(2 * 60_000 + 10);
    expect(a.ref.h.timer).toBeNull(); expect(b.ref.h.timer).toBeNull();
    expect(values.has(KEY)).toBe(false);
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    act(() => { a.r.unmount(); b.r.unmount(); });
  });

  it('a legacy screen never treats a new id timer with the same timestamp as its own', () => {
    values.set(KEY, JSON.stringify({ expiresAt: T0 + 5 * 60_000, address: 'Same' }));
    const L = mount(); // legacy, no id
    const B = mount();
    act(() => B.ref.h.startTimer(5, 'Same')); // same expiresAt/address, has id
    act(() => L.ref.h.clearTimer());
    expect(stored()?.id).toBeTruthy();
    act(() => { L.r.unmount(); B.r.unmount(); });
  });

  it('End Session cancels a legacy record too', () => {
    values.set(KEY, JSON.stringify({ expiresAt: T0 + 5 * 60_000, address: 'L' }));
    const a = mount();
    act(() => cancel(a.ref.h));
    expect(values.has(KEY)).toBe(false);
    advance(6 * 60_000);
    expect(NotificationMock).not.toHaveBeenCalled();
    act(() => a.r.unmount());
  });

  it('rapid cancel/restart with identical timestamps: only the last start notifies and calls back', () => {
    const cbs = [vi.fn(), vi.fn(), vi.fn()];
    const A = mount(); const B = mount();
    act(() => A.ref.h.startTimer(5, 'S', cbs[0]));
    act(() => cancel(B.ref.h));
    act(() => A.ref.h.startTimer(5, 'S', cbs[1]));
    act(() => B.ref.h.startTimer(5, 'S', cbs[2]));
    advance(5 * 60_000 + 10);
    expect(cbs[0]).not.toHaveBeenCalled();
    expect(cbs[1]).not.toHaveBeenCalled();
    expect(cbs[2]).toHaveBeenCalledTimes(1);
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    act(() => { A.r.unmount(); B.r.unmount(); });
  });

  it('falls back to getRandomValues when randomUUID is unavailable (iOS < 15.4)', () => {
    const orig = (globalThis as any).crypto;
    const getRandomValues = vi.fn((a: Uint8Array) => { for (let i = 0; i < a.length; i++) a[i] = i * 7 + 1; return a; });
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues } });
    try {
      const { ref, r } = mount();
      act(() => ref.h.startTimer(5, 'F'));
      expect(getRandomValues).toHaveBeenCalled();
      expect(stored().id).toMatch(/^[0-9a-f]{32}$/);
      act(() => r.unmount());
    } finally { Object.defineProperty(globalThis, 'crypto', { configurable: true, value: orig }); }
  });

  it('React StrictMode: one notification and one callback', () => {
    const cb = vi.fn();
    const ref: { h: Hook } = { h: null as unknown as Hook };
    let r!: TestRenderer.ReactTestRenderer;
    act(() => { r = TestRenderer.create(<React.StrictMode><Harness expose={v => { ref.h = v; }} /></React.StrictMode>); });
    act(() => ref.h.startTimer(2, 'SM', cb));
    advance(60_000);
    expect(ref.h.minutesRemaining).toBe(1);
    advance(60_000 + 10);
    expect(NotificationMock).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledTimes(1);
    act(() => r.unmount());
  });
});

describe('LOW-2: one tolerance rule in both orders', () => {
  const cases: Array<[number, boolean]> = [[0, true], [1, true], [4999, true], [5000, true], [5001, false]];
  for (const [delta, notifies] of cases) {
    for (const order of ['timeout-first', 'foreground-first'] as const) {
      it(`+${delta}ms ${order}: ${notifies ? 'notifies once' : 'silent'}, onExpire once`, () => {
        const cb = vi.fn();
        const { ref, r } = mount();
        act(() => ref.h.startTimer(10, 'Tol', cb));
        if (order === 'timeout-first') {
          suspend(delta);            // timers frozen while the wall clock moves
          advance(10 * 60_000);      // timeout fires `delta` ms after expiresAt
          visible(); fire((globalThis as any).window, 'focus');
        } else {
          suspend(10 * 60_000 + delta); // wall clock past expiry, timeout not yet run
          visible();                    // foreground check runs first
          advance(10 * 60_000);         // the late timeout then fires
        }
        expect(NotificationMock).toHaveBeenCalledTimes(notifies ? 1 : 0);
        expect(cb).toHaveBeenCalledTimes(1);
        expect(ref.h.timer).toBeNull();
        expect(values.has(KEY)).toBe(false);
        act(() => r.unmount());
      });
    }
  }

  for (const permission of ['granted', 'denied', 'default']) {
    it(`permission ${permission}: notifies only when granted, never prompts, onExpire once`, () => {
      setPermission(permission);
      const requestPermission = vi.fn();
      (NotificationMock as any).requestPermission = requestPermission;
      const cb = vi.fn();
      const { ref, r } = mount();
      act(() => ref.h.startTimer(1, 'P', cb));
      suspend(60_000 + 2000); visible();
      expect(NotificationMock).toHaveBeenCalledTimes(permission === 'granted' ? 1 : 0);
      expect(requestPermission).not.toHaveBeenCalled();
      expect(cb).toHaveBeenCalledTimes(1);
      act(() => r.unmount());
    });
  }

  it('a cancelled or superseded timer never notifies within the tolerance window', () => {
    const cbA = vi.fn();
    const A = mount(); const B = mount();
    act(() => A.ref.h.startTimer(1, 'C', cbA));
    act(() => B.ref.h.startTimer(1, 'C')); // identical timestamp, supersedes A
    act(() => cancel(B.ref.h));
    suspend(60_000 + 1000); visible(); advance(60_000);
    expect(NotificationMock).not.toHaveBeenCalled();
    expect(cbA).not.toHaveBeenCalled();
    act(() => { A.r.unmount(); B.r.unmount(); });
  });
});
