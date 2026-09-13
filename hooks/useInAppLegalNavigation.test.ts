import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppView } from '../types';
import { useInAppLegalNavigation } from './useInAppLegalNavigation';

const history = vi.hoisted(() => ({
  state: null as unknown,
  pushState: vi.fn((state: unknown) => { history.state = state; }),
  back: vi.fn(),
}));

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    history,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
});

const Probe = ({
  currentView,
  setCurrentView,
  onReady,
}: {
  currentView: AppView;
  setCurrentView: (view: AppView) => void;
  onReady: (api: ReturnType<typeof useInAppLegalNavigation>) => void;
}) => {
  const api = useInAppLegalNavigation(currentView, setCurrentView);
  onReady(api);
  return null;
};

describe('useInAppLegalNavigation', () => {
  let currentView = AppView.CREATE_ACCOUNT;
  const setCurrentView = vi.fn((view: AppView) => { currentView = view; });
  let api: ReturnType<typeof useInAppLegalNavigation>;

  const mount = (view: AppView) => {
    currentView = view;
    act(() => {
      TestRenderer.create(
        <Probe
          currentView={view}
          setCurrentView={setCurrentView}
          onReady={next => { api = next; }}
        />,
      );
    });
  };

  beforeEach(() => {
    history.state = null;
    history.pushState.mockClear();
    history.back.mockClear();
    setCurrentView.mockClear();
    window.addEventListener = vi.fn();
    window.removeEventListener = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('opens legal from signup and returns to signup', () => {
    mount(AppView.CREATE_ACCOUNT);
    act(() => api.setViewWithLegalReturn(AppView.TERMS_OF_USE));
    expect(history.pushState).toHaveBeenCalledWith({ parqueenInAppLegal: true }, '');
    expect(setCurrentView).toHaveBeenCalledWith(AppView.TERMS_OF_USE);
    expect(api.legalReturnViewRef.current).toBe(AppView.CREATE_ACCOUNT);

    act(() => api.closeLegal());
    expect(history.back).toHaveBeenCalled();
  });

  it('opens legal from Settings/Profile and returns to Settings, not signup', () => {
    mount(AppView.SETTINGS);
    act(() => api.setViewWithLegalReturn(AppView.PRIVACY_POLICY));
    expect(setCurrentView).toHaveBeenCalledWith(AppView.PRIVACY_POLICY);
    expect(api.legalReturnViewRef.current).toBe(AppView.SETTINGS);

    history.state = null;
    act(() => api.closeLegal());
    expect(setCurrentView).toHaveBeenCalledWith(AppView.SETTINGS);
    expect(setCurrentView).not.toHaveBeenCalledWith(AppView.CREATE_ACCOUNT);
  });

  it('returns to Profile when legal was opened without a more specific caller', () => {
    mount(AppView.PROFILE);
    act(() => api.openLegalFrom('terms', AppView.PROFILE));
    expect(api.legalReturnViewRef.current).toBe(AppView.PROFILE);
    history.state = null;
    act(() => api.closeLegal());
    expect(setCurrentView).toHaveBeenCalledWith(AppView.PROFILE);
  });
});
