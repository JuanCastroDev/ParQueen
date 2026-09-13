import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { matchMedia: () => ({ matches: true }) },
  });
});

vi.mock('firebase/auth', () => ({
  RecaptchaVerifier: class {},
  signInWithPhoneNumber: vi.fn(),
  signInWithCredential: vi.fn(),
  PhoneAuthProvider: { credential: vi.fn() },
}));
vi.mock('../firebaseConfig', () => ({ auth: {} }));
vi.mock('../utils/recaptchaLifecycle', () => ({
  clearRecaptchaVerifier: vi.fn(),
  replaceRecaptchaVerifier: vi.fn(() => ({})),
}));
vi.mock('../components/CountrySelector', () => ({ CountrySelector: () => null }));

import { setLang } from '../i18n';
import { CreateAccountView } from './CreateAccountView';

const legalLinks = (renderer: TestRenderer.ReactTestRenderer) =>
  renderer.root.findAll(node => node.type === 'a').map(node => ({
    href: node.props.href,
    text: node.children.join(''),
  }));

describe('CreateAccountView legal notice', () => {
  beforeEach(() => setLang('en'));

  it('links Privacy and Terms before the user sends an OTP', () => {
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<CreateAccountView onContinue={vi.fn()} />);
    });
    expect(legalLinks(renderer!)).toEqual([
      { href: '/terms', text: 'Terms of Use' },
      { href: '/privacy', text: 'Privacy Policy' },
    ]);
    expect(renderer!.root.findAll(node => node.type === 'a').every(node => node.props.target == null)).toBe(true);
  });

  it('opens Terms and Privacy in-app and does not navigate the WebView to /terms or /privacy', () => {
    const onOpenLegal = vi.fn();
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<CreateAccountView onContinue={vi.fn()} onOpenLegal={onOpenLegal} />);
    });
    const links = renderer!.root.findAll(node => node.type === 'a');
    const preventDefault = vi.fn();
    act(() => links[0].props.onClick({ preventDefault }));
    act(() => links[1].props.onClick({ preventDefault }));
    expect(preventDefault).toHaveBeenCalledTimes(2);
    expect(onOpenLegal).toHaveBeenCalledWith('terms');
    expect(onOpenLegal).toHaveBeenCalledWith('privacy');
  });

  it('renders equivalent Spanish legal-link labels', () => {
    setLang('es');
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(<CreateAccountView onContinue={vi.fn()} />);
    });
    expect(legalLinks(renderer!)).toEqual([
      { href: '/terms', text: 'Términos de uso' },
      { href: '/privacy', text: 'Política de privacidad' },
    ]);
  });
});
