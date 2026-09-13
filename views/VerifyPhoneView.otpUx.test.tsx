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

const signInWithPhoneNumber = vi.fn();
vi.mock('firebase/auth', () => ({
  RecaptchaVerifier: class {},
  signInWithPhoneNumber: (...a: unknown[]) => signInWithPhoneNumber(...a),
  signInWithCredential: vi.fn(),
  PhoneAuthProvider: { credential: vi.fn() },
}));
vi.mock('../firebaseConfig', () => ({ auth: {} }));
vi.mock('../utils/recaptchaLifecycle', () => ({
  clearRecaptchaVerifier: vi.fn(),
  replaceRecaptchaVerifier: vi.fn(() => ({})),
}));

import { VerifyPhoneView } from './VerifyPhoneView';

/** Stand-in DOM node so refs expose a spyable focus(), as react-test-renderer has no DOM. */
function makeTree(confirm: () => Promise<unknown>, onVerify = vi.fn(), onEditNumber = vi.fn()) {
  const focus = vi.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  // inside act() so mount effects (including the autofocus) flush
  act(() => {
    renderer = TestRenderer.create(
      <VerifyPhoneView
        phone="+15555551234"
        confirmationResult={{ confirm } as never}
        onVerify={onVerify}
        onEditNumber={onEditNumber}
      />,
      { createNodeMock: () => ({ focus }) },
    );
  });
  return { renderer, focus, onVerify, onEditNumber };
}

const otpInput = (r: TestRenderer.ReactTestRenderer) =>
  r.root.findAll(n => n.type === 'input')[0];

const typeCode = async (r: TestRenderer.ReactTestRenderer, code: string) => {
  await act(async () => {
    otpInput(r).props.onChange({ target: { value: code } });
  });
};

beforeEach(() => { vi.clearAllMocks(); });

describe('OTP field autofocus on arrival', () => {
  it('focuses the code input as soon as the verification screen mounts', () => {
    // The bug: nothing focused the hidden input, so the user had to tap the cells
    // before they could type the code they had just received.
    const { focus } = makeTree(vi.fn());
    expect(focus).toHaveBeenCalled();
  });

  it('keeps the one-time-code autofill contract intact', () => {
    const { renderer } = makeTree(vi.fn());
    const input = otpInput(renderer);
    expect(input.props.autoComplete).toBe('one-time-code');
    expect(input.props.inputMode).toBe('numeric');
    expect(input.props.maxLength).toBe(6);
  });
});

describe('recovery after an incorrect code', () => {
  it('clears every entered digit so the next attempt can be typed', async () => {
    // Previously the rejected 6 digits stayed in state; with maxLength=6 the field
    // was full, so further keystrokes were silently dropped and the user was stuck.
    const confirm = vi.fn().mockRejectedValue({ code: 'auth/invalid-verification-code' });
    const { renderer } = makeTree(confirm);

    await typeCode(renderer, '123456');
    await act(async () => { await new Promise(r => setTimeout(r, 120)); });

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(otpInput(renderer).props.value).toBe('');
  });

  it('refocuses the input after the failed attempt re-enables it', async () => {
    const confirm = vi.fn().mockRejectedValue({ code: 'auth/invalid-verification-code' });
    const { renderer, focus } = makeTree(confirm);
    focus.mockClear();                      // ignore the mount focus

    await typeCode(renderer, '123456');
    await act(async () => { await new Promise(r => setTimeout(r, 120)); });

    expect(focus).toHaveBeenCalled();
  });

  it('stays on the code screen and never re-sends an SMS', async () => {
    const confirm = vi.fn().mockRejectedValue({ code: 'auth/invalid-verification-code' });
    const { renderer, onVerify, onEditNumber } = makeTree(confirm);

    await typeCode(renderer, '123456');
    await act(async () => { await new Promise(r => setTimeout(r, 120)); });

    expect(onVerify).not.toHaveBeenCalled();       // did not advance
    expect(onEditNumber).not.toHaveBeenCalled();   // did not bounce to phone entry
    expect(signInWithPhoneNumber).not.toHaveBeenCalled(); // no automatic resend
  });

  it('surfaces the invalid-code message and leaves the input usable', async () => {
    const confirm = vi.fn().mockRejectedValue({ code: 'auth/invalid-verification-code' });
    const { renderer } = makeTree(confirm);

    await typeCode(renderer, '123456');
    await act(async () => { await new Promise(r => setTimeout(r, 120)); });

    const alert = renderer.root.findAll(n => n.props?.role === 'alert');
    expect(alert.length).toBe(1);
    // readOnly, not disabled: a disabled input blurs and drops the mobile keyboard.
    expect(otpInput(renderer).props.readOnly).toBe(false);
    expect(otpInput(renderer).props.disabled).toBeUndefined();
  });

  it('accepts a correct code on the retry after a rejection', async () => {
    const confirm = vi.fn()
      .mockRejectedValueOnce({ code: 'auth/invalid-verification-code' })
      .mockResolvedValueOnce({});
    const { renderer, onVerify } = makeTree(confirm);

    await typeCode(renderer, '111111');
    await act(async () => { await new Promise(r => setTimeout(r, 120)); });
    expect(onVerify).not.toHaveBeenCalled();

    await typeCode(renderer, '222222');
    await act(async () => { await new Promise(r => setTimeout(r, 120)); });

    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenLastCalledWith('222222');
    expect(onVerify).toHaveBeenCalledTimes(1);
  });
});

describe('untouched behaviour', () => {
  it('Edit number still calls back to the phone-entry step', () => {
    const { renderer, onEditNumber } = makeTree(vi.fn());
    const edit = renderer.root.findAll(
      n => n.type === 'button' && typeof n.props.onClick === 'function',
    ).find(n => n.props.onClick === onEditNumber);
    expect(edit).toBeTruthy();
  });

  it('starts with the resend cooldown running, so resend is not offered immediately', () => {
    const { renderer } = makeTree(vi.fn());
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain('Resend in');
  });
});
