import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, String(value)); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => values.clear(),
    },
  });
  return values;
});

import {
  ONBOARDING_INTENT_KEY,
  ONBOARDING_INTENT_TTL_MS,
  bindPendingIntent,
  clearPendingIntent,
  isOnboardingIntent,
  peekPendingIntent,
  savePendingIntent,
  takePendingIntent,
} from './onboardingIntent';

const T0 = 1_800_000_000_000;

describe('onboarding intention store (local navigation context only)', () => {
  beforeEach(() => store.clear());

  it('accepts only the three approved intentions', () => {
    expect(isOnboardingIntent('find')).toBe(true);
    expect(isOnboardingIntent('leave')).toBe(true);
    expect(isOnboardingIntent('explore')).toBe(true);
    expect(isOnboardingIntent('admin')).toBe(false);
    expect(isOnboardingIntent(undefined)).toBe(false);
    savePendingIntent('publish' as never, T0);
    expect(peekPendingIntent()).toBeNull();
  });

  it('binds to the first account and is consumed exactly once', () => {
    savePendingIntent('leave', T0);
    bindPendingIntent('alice', T0 + 1000);
    expect(peekPendingIntent()?.uid).toBe('alice');
    expect(takePendingIntent('alice', T0 + 2000)).toBe('leave');
    expect(takePendingIntent('alice', T0 + 3000)).toBeNull();
    expect(store.has(ONBOARDING_INTENT_KEY)).toBe(false);
  });

  it('never leaks to another account: a different uid discards it', () => {
    savePendingIntent('explore', T0);
    bindPendingIntent('alice', T0);
    bindPendingIntent('bob', T0 + 10);
    expect(peekPendingIntent()).toBeNull();
    savePendingIntent('find', T0);
    bindPendingIntent('alice', T0);
    expect(takePendingIntent('bob', T0)).toBeNull();
    expect(store.has(ONBOARDING_INTENT_KEY)).toBe(false);
  });

  it('an unbound intention is not usable until an account binds it', () => {
    savePendingIntent('find', T0);
    expect(takePendingIntent('alice', T0)).toBeNull();
    expect(peekPendingIntent()).toBeNull();
  });

  it('expires 24 hours after it was chosen', () => {
    savePendingIntent('leave', T0);
    bindPendingIntent('alice', T0);
    expect(takePendingIntent('alice', T0 + ONBOARDING_INTENT_TTL_MS + 1)).toBeNull();
    savePendingIntent('leave', T0);
    bindPendingIntent('alice', T0 + ONBOARDING_INTENT_TTL_MS + 1);
    expect(peekPendingIntent()).toBeNull();
    savePendingIntent('leave', T0);
    bindPendingIntent('alice', T0);
    expect(takePendingIntent('alice', T0 + ONBOARDING_INTENT_TTL_MS)).toBe('leave');
  });

  it('rejects records from the future (clock rollback) and malformed or tampered records', () => {
    savePendingIntent('leave', T0 + 60_000);
    bindPendingIntent('alice', T0);
    expect(peekPendingIntent()).toBeNull();
    const bad = [
      'not json',
      '{"v":2,"intent":"find","createdAt":1}',
      '{"v":1,"intent":"grant","createdAt":1}',
      '{"v":1,"intent":"find","createdAt":"x"}',
      '{"v":1,"intent":"find","createdAt":1,"uid":7}',
    ];
    for (const raw of bad) {
      store.set(ONBOARDING_INTENT_KEY, raw);
      expect(takePendingIntent('alice', 2)).toBeNull();
      expect(store.has(ONBOARDING_INTENT_KEY)).toBe(false);
    }
  });

  it('a later choice replaces an earlier one', () => {
    savePendingIntent('find', T0);
    savePendingIntent('explore', T0 + 5);
    bindPendingIntent('alice', T0 + 6);
    expect(takePendingIntent('alice', T0 + 7)).toBe('explore');
  });

  it('is removed by logout or deletion clears and by clearPendingIntent', () => {
    savePendingIntent('leave', T0);
    bindPendingIntent('alice', T0);
    localStorage.clear();
    expect(takePendingIntent('alice', T0)).toBeNull();
    savePendingIntent('leave', T0);
    clearPendingIntent();
    expect(peekPendingIntent()).toBeNull();
  });

  it('fails closed when storage throws', () => {
    const original = globalThis.localStorage;
    const deny = () => { throw new Error('denied'); };
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: { getItem: deny, setItem: deny, removeItem: deny, clear: () => {} },
    });
    try {
      expect(() => savePendingIntent('find', T0)).not.toThrow();
      expect(() => bindPendingIntent('alice', T0)).not.toThrow();
      expect(takePendingIntent('alice', T0)).toBeNull();
    } finally {
      Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: original });
    }
  });
});
