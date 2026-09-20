import { useEffect, useRef } from 'react';
import { App } from '@capacitor/app';
import { Capacitor } from '@capacitor/core';
import { AppView } from '../types';
import type { AndroidBackAction } from '../utils/androidBackNavigation';

export type AndroidSystemBackHandlers = {
  /** Latest resolve+apply for a Back press. Must read live state (refs), not stale closures. */
  handleBack: () => void | Promise<void>;
};

/**
 * Registers Capacitor backButton only on Android.
 * Cleans up ONLY the listener handle from this effect — never App.removeAllListeners().
 * Root Map minimization is the caller's job via resolveAndroidBack -> minimizeApp().
 */
export function useAndroidSystemBack(handlers: AndroidSystemBackHandlers): void {
  const handleBackRef = useRef(handlers.handleBack);
  handleBackRef.current = handlers.handleBack;

  useEffect(() => {
    if (Capacitor.getPlatform() !== 'android') {
      return;
    }

    let removed = false;
    let handle: { remove: () => Promise<void> } | undefined;

    const register = async () => {
      const listener = await App.addListener('backButton', () => {
        void handleBackRef.current();
      });
      if (removed) {
        await listener.remove();
        return;
      }
      handle = listener;
    };

    void register();

    return () => {
      removed = true;
      if (handle) {
        void handle.remove();
      }
    };
  }, []);
}

export type ApplyAndroidBackEffects = {
  navigate: (view: AppView) => void;
  closeLegal: () => void;
  delegateMessages: () => void;
  delegateOnboarding: () => void;
  delegateAssistant: () => void;
  minimize: () => void;
  /** Called when leaving EDIT_VEHICLE so onboarding flag clears like visible onBack. */
  clearVehicleOnboarding?: () => void;
  currentView: AppView;
};

/** Apply a resolved Android Back action with injectable side effects (testable). */
export function applyAndroidBackAction(
  action: AndroidBackAction,
  effects: ApplyAndroidBackEffects,
): void {
  switch (action.type) {
    case 'navigate':
      if (effects.currentView === AppView.EDIT_VEHICLE) {
        effects.clearVehicleOnboarding?.();
      }
      effects.navigate(action.view);
      return;
    case 'closeLegal':
      effects.closeLegal();
      return;
    case 'delegateMessages':
      effects.delegateMessages();
      return;
    case 'delegateOnboarding':
      effects.delegateOnboarding();
      return;
    case 'delegateAssistant':
      effects.delegateAssistant();
      return;
    case 'minimize':
      effects.minimize();
      return;
    case 'noop':
      return;
    default: {
      const _exhaustive: never = action;
      void _exhaustive;
    }
  }
}
