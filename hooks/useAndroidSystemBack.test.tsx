import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppView } from '../types';
import { applyAndroidBackAction, useAndroidSystemBack } from './useAndroidSystemBack';

const addListener = vi.fn();
const removeAllListeners = vi.fn();
const getPlatform = vi.fn();

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: (...args: unknown[]) => addListener(...args),
    removeAllListeners: (...args: unknown[]) => removeAllListeners(...args),
    minimizeApp: vi.fn(),
    exitApp: vi.fn(),
  },
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => getPlatform(),
  },
}));

function Probe({ handleBack }: { handleBack: () => void }) {
  useAndroidSystemBack({ handleBack });
  return null;
}

describe('useAndroidSystemBack', () => {
  beforeEach(() => {
    addListener.mockReset();
    removeAllListeners.mockReset();
    getPlatform.mockReset();
    addListener.mockResolvedValue({ remove: vi.fn().mockResolvedValue(undefined) });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers Capacitor backButton only on Android', async () => {
    getPlatform.mockReturnValue('android');
    await act(async () => {
      TestRenderer.create(<Probe handleBack={() => undefined} />);
    });
    await vi.waitFor(() => {
      expect(addListener).toHaveBeenCalledTimes(1);
    });
    expect(addListener.mock.calls[0][0]).toBe('backButton');
    expect(removeAllListeners).not.toHaveBeenCalled();
  });

  it('does not register on web/PWA', async () => {
    getPlatform.mockReturnValue('web');
    await act(async () => {
      TestRenderer.create(<Probe handleBack={() => undefined} />);
    });
    await Promise.resolve();
    expect(addListener).not.toHaveBeenCalled();
  });

  it('removes only its own listener on cleanup and never removeAllListeners', async () => {
    getPlatform.mockReturnValue('android');
    const remove = vi.fn().mockResolvedValue(undefined);
    addListener.mockResolvedValue({ remove });
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Probe handleBack={() => undefined} />);
    });
    await vi.waitFor(() => expect(addListener).toHaveBeenCalled());
    await act(async () => {
      renderer!.unmount();
    });
    await vi.waitFor(() => expect(remove).toHaveBeenCalledTimes(1));
    expect(removeAllListeners).not.toHaveBeenCalled();
  });

  it('invokes the latest handleBack ref when backButton fires', async () => {
    getPlatform.mockReturnValue('android');
    let captured: (() => void) | undefined;
    addListener.mockImplementation(async (_event: string, cb: () => void) => {
      captured = cb;
      return { remove: vi.fn().mockResolvedValue(undefined) };
    });

    const first = vi.fn();
    const second = vi.fn();
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(<Probe handleBack={first} />);
    });
    await vi.waitFor(() => expect(captured).toBeTypeOf('function'));
    await act(async () => {
      renderer!.update(<Probe handleBack={second} />);
    });
    captured!();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('applyAndroidBackAction', () => {
  it('navigates, closes legal, delegates messages, and minimizes', () => {
    const navigate = vi.fn();
    const closeLegal = vi.fn();
    const delegateMessages = vi.fn();
    const delegateOnboarding = vi.fn();
    const minimize = vi.fn();
    const clearVehicleOnboarding = vi.fn();

    applyAndroidBackAction(
      { type: 'navigate', view: AppView.MAP },
      {
        navigate,
        closeLegal,
        delegateMessages,
        delegateOnboarding,
        minimize,
        clearVehicleOnboarding,
        currentView: AppView.PROFILE,
      },
    );
    expect(navigate).toHaveBeenCalledWith(AppView.MAP);
    expect(clearVehicleOnboarding).not.toHaveBeenCalled();

    applyAndroidBackAction(
      { type: 'navigate', view: AppView.PROFILE },
      {
        navigate,
        closeLegal,
        delegateMessages,
        delegateOnboarding,
        minimize,
        clearVehicleOnboarding,
        currentView: AppView.EDIT_VEHICLE,
      },
    );
    expect(clearVehicleOnboarding).toHaveBeenCalledTimes(1);

    applyAndroidBackAction(
      { type: 'closeLegal' },
      { navigate, closeLegal, delegateMessages, delegateOnboarding, minimize, currentView: AppView.PRIVACY_POLICY },
    );
    expect(closeLegal).toHaveBeenCalledTimes(1);

    applyAndroidBackAction(
      { type: 'delegateMessages' },
      { navigate, closeLegal, delegateMessages, delegateOnboarding, minimize, currentView: AppView.MESSAGES },
    );
    expect(delegateMessages).toHaveBeenCalledTimes(1);

    applyAndroidBackAction(
      { type: 'delegateOnboarding' },
      { navigate, closeLegal, delegateMessages, delegateOnboarding, minimize, currentView: AppView.ONBOARDING },
    );
    expect(delegateOnboarding).toHaveBeenCalledTimes(1);

    applyAndroidBackAction(
      { type: 'minimize' },
      { navigate, closeLegal, delegateMessages, delegateOnboarding, minimize, currentView: AppView.MAP },
    );
    expect(minimize).toHaveBeenCalledTimes(1);
  });

  it('App.tsx uses minimizeApp and never exitApp for native Back', () => {
    const appSource = readFileSync(resolve(__dirname, '../App.tsx'), 'utf8');
    expect(appSource).toContain('minimizeApp');
    expect(appSource).not.toMatch(/exitApp\s*\(/);
    expect(appSource).not.toContain('removeAllListeners');
  });
});
