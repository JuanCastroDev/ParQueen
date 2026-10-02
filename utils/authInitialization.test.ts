import { readFileSync } from 'node:fs';
import type { FirebaseApp } from 'firebase/app';
import { browserLocalPersistence } from 'firebase/auth';
import { describe, expect, it, vi } from 'vitest';
import { initializeParQueenAuth } from './authInitialization';

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

const app = { name: '[DEFAULT]' } as FirebaseApp;

describe('initializeParQueenAuth', () => {
  it('uses initializeAuth with browserLocalPersistence on Capacitor iOS', () => {
    const created = { name: 'ios-auth' };
    const getAuth = vi.fn((_app: unknown) => ({ name: 'default-auth' }));
    const initializeAuth = vi.fn((_app: unknown, _deps: { persistence?: unknown }) => created);

    const result = initializeParQueenAuth(app, {
      getAuth: getAuth as never,
      initializeAuth: initializeAuth as never,
      platform: { isNative: true, platform: 'ios' },
    });

    expect(result).toBe(created);
    expect(initializeAuth).toHaveBeenCalledTimes(1);
    expect(getAuth).not.toHaveBeenCalled();
    const deps = initializeAuth.mock.calls[0][1] as { persistence?: unknown };
    expect(initializeAuth.mock.calls[0][0]).toBe(app);
    expect(deps.persistence).toBe(browserLocalPersistence);
    expect(deps).not.toHaveProperty('popupRedirectResolver');
    expect(Object.keys(deps)).toEqual(['persistence']);
  });

  it('keeps getAuth on Capacitor Android', () => {
    const retrieved = { name: 'android-auth' };
    const getAuth = vi.fn(() => retrieved);
    const initializeAuth = vi.fn();

    const result = initializeParQueenAuth(app, {
      getAuth: getAuth as never,
      initializeAuth: initializeAuth as never,
      platform: { isNative: true, platform: 'android' },
    });

    expect(result).toBe(retrieved);
    expect(getAuth).toHaveBeenCalledTimes(1);
    expect(getAuth).toHaveBeenCalledWith(app);
    expect(initializeAuth).not.toHaveBeenCalled();
  });

  it('keeps getAuth on web and PWA', () => {
    const retrieved = { name: 'web-auth' };
    const getAuth = vi.fn(() => retrieved);
    const initializeAuth = vi.fn();

    const result = initializeParQueenAuth(app, {
      getAuth: getAuth as never,
      initializeAuth: initializeAuth as never,
      platform: { isNative: false, platform: 'web' },
    });

    expect(result).toBe(retrieved);
    expect(getAuth).toHaveBeenCalledTimes(1);
    expect(getAuth).toHaveBeenCalledWith(app);
    expect(initializeAuth).not.toHaveBeenCalled();
  });

  it('has one authoritative initialization and does not use IndexedDB or a popup resolver', () => {
    const initializer = read('./authInitialization.ts');
    const config = read('../firebaseConfig.ts');
    const legacy = read('../firebase.ts');
    const phone = read('./phoneAuth.ts');
    const recaptcha = read('./recaptchaLifecycle.ts');

    expect(initializer).not.toContain('indexedDBLocalPersistence');
    expect(initializer).not.toContain('browserPopupRedirectResolver');
    expect(initializer).toContain('browserLocalPersistence');
    expect(config.match(/initializeParQueenAuth\(/g)).toHaveLength(1);
    expect(config).not.toMatch(/\bgetAuth\s*\(\s*app\s*\)/);
    expect(legacy).not.toMatch(/\bgetAuth\s*\(/);
    expect(legacy).not.toContain('initializeAuth(');
    expect(phone).toContain('signInWithPhoneNumber');
    expect(phone).not.toContain('signInWithPopup');
    expect(phone).not.toContain('signInWithRedirect');
    expect(recaptcha).toContain('new RecaptchaVerifier');
  });
});
