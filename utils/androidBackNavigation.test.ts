import { describe, expect, it, vi } from 'vitest';
import { AppView } from '../types';
import {
  dispatchAndroidSystemBack,
  editVehicleAfterOnboarding,
  resolveAndroidBack,
  resolveAssistantAndroidBack,
  resolveMessagesAndroidBack,
  resolveOnboardingAndroidBack,
} from './androidBackNavigation';

const base = {
  vehicleOnboarding: false,
  locationAccess: 'granted' as const,
};

describe('resolveAndroidBack', () => {
  it('minimizes on root MAP and never suggests exitApp', () => {
    expect(resolveAndroidBack({ ...base, currentView: AppView.MAP })).toEqual({ type: 'minimize' });
  });

  it('delegates Messages to the Messages hierarchy handler', () => {
    expect(resolveAndroidBack({ ...base, currentView: AppView.MESSAGES })).toEqual({
      type: 'delegateMessages',
    });
  });

  it('routes legal screens to closeLegal', () => {
    expect(resolveAndroidBack({ ...base, currentView: AppView.PRIVACY_POLICY })).toEqual({
      type: 'closeLegal',
    });
    expect(resolveAndroidBack({ ...base, currentView: AppView.TERMS_OF_USE })).toEqual({
      type: 'closeLegal',
    });
  });

  it('mirrors primary visible onBack parents', () => {
    expect(resolveAndroidBack({ ...base, currentView: AppView.PROFILE })).toEqual({
      type: 'navigate',
      view: AppView.MAP,
    });
    expect(resolveAndroidBack({ ...base, currentView: AppView.SETTINGS })).toEqual({
      type: 'navigate',
      view: AppView.PROFILE,
    });
    expect(resolveAndroidBack({ ...base, currentView: AppView.NOTIFICATIONS })).toEqual({
      type: 'navigate',
      view: AppView.MAP,
    });
    expect(resolveAndroidBack({ ...base, currentView: AppView.AI_ASSISTANT })).toEqual({
      type: 'delegateAssistant',
    });
    expect(resolveAndroidBack({ ...base, currentView: AppView.EDIT_PROFILE })).toEqual({
      type: 'navigate',
      view: AppView.SETTINGS,
    });
    expect(resolveAndroidBack({ ...base, currentView: AppView.PARKING_SPACE })).toEqual({
      type: 'navigate',
      view: AppView.PROFILE,
    });
    expect(resolveAndroidBack({ ...base, currentView: AppView.CONTACT_US })).toEqual({
      type: 'navigate',
      view: AppView.PROFILE,
    });
  });

  it('routes nested settings screens to SETTINGS', () => {
    for (const view of [
      AppView.NOTIFICATIONS_SETTINGS,
      AppView.LOCATION_SETTINGS,
      AppView.LANGUAGE_SETTINGS,
    ]) {
      expect(resolveAndroidBack({ ...base, currentView: view })).toEqual({
        type: 'navigate',
        view: AppView.SETTINGS,
      });
    }
  });

  it('preserves EditVehicle state-dependent destinations', () => {
    expect(
      resolveAndroidBack({
        currentView: AppView.EDIT_VEHICLE,
        vehicleOnboarding: false,
        locationAccess: 'granted',
      }),
    ).toEqual({ type: 'navigate', view: AppView.PROFILE });

    expect(
      resolveAndroidBack({
        currentView: AppView.EDIT_VEHICLE,
        vehicleOnboarding: true,
        locationAccess: 'granted',
      }),
    ).toEqual({ type: 'navigate', view: AppView.MAP });

    expect(
      resolveAndroidBack({
        currentView: AppView.EDIT_VEHICLE,
        vehicleOnboarding: true,
        locationAccess: 'unknown',
      }),
    ).toEqual({ type: 'navigate', view: AppView.LOCATION_PROMPT });

    expect(editVehicleAfterOnboarding('unknown')).toBe(AppView.LOCATION_PROMPT);
    expect(editVehicleAfterOnboarding('denied')).toBe(AppView.MAP);
  });

  it('mirrors VerifyPhone edit-number and CompleteProfile skip', () => {
    expect(resolveAndroidBack({ ...base, currentView: AppView.VERIFY_PHONE })).toEqual({
      type: 'navigate',
      view: AppView.CREATE_ACCOUNT,
    });
    expect(resolveAndroidBack({ ...base, currentView: AppView.COMPLETE_PROFILE })).toEqual({
      type: 'navigate',
      view: AppView.PROFILE,
    });
  });

  it('minimizes auth/onboarding/admin/legacy roots without inventing parents', () => {
    const minimizeViews = [
      AppView.CREATE_ACCOUNT,
      AppView.SETUP_PROFILE,
      AppView.LOCATION_PROMPT,
      AppView.ADMIN_LOGIN,
      AppView.ADMIN_DASHBOARD,
      AppView.SPLASH,
      AppView.GARAGE_LIST,
      AppView.HOST_DASHBOARD,
    ];
    for (const view of minimizeViews) {
      expect(resolveAndroidBack({ ...base, currentView: view })).toEqual({ type: 'minimize' });
    }
  });

  it('covers every AppView enum member with an explicit expected action type', () => {
    const expectedTypeByView: Record<AppView, ReturnType<typeof resolveAndroidBack>['type']> = {
      [AppView.MAP]: 'minimize',
      [AppView.MESSAGES]: 'delegateMessages',
      [AppView.ONBOARDING]: 'delegateOnboarding',
      [AppView.PRIVACY_POLICY]: 'closeLegal',
      [AppView.TERMS_OF_USE]: 'closeLegal',
      [AppView.EDIT_PROFILE]: 'navigate',
      [AppView.AI_ASSISTANT]: 'delegateAssistant',
      [AppView.PROFILE]: 'navigate',
      [AppView.SETTINGS]: 'navigate',
      [AppView.NOTIFICATIONS_SETTINGS]: 'navigate',
      [AppView.LOCATION_SETTINGS]: 'navigate',
      [AppView.LANGUAGE_SETTINGS]: 'navigate',
      [AppView.NOTIFICATIONS]: 'navigate',
      [AppView.PARKING_SPACE]: 'navigate',
      [AppView.CONTACT_US]: 'navigate',
      [AppView.EDIT_VEHICLE]: 'navigate',
      [AppView.VERIFY_PHONE]: 'navigate',
      [AppView.COMPLETE_PROFILE]: 'navigate',
      [AppView.CREATE_ACCOUNT]: 'minimize',
      [AppView.SETUP_PROFILE]: 'minimize',
      [AppView.LOCATION_PROMPT]: 'minimize',
      [AppView.ADMIN_LOGIN]: 'minimize',
      [AppView.ADMIN_DASHBOARD]: 'minimize',
      [AppView.SPLASH]: 'minimize',
      [AppView.GARAGE_LIST]: 'minimize',
      [AppView.HOST_DASHBOARD]: 'minimize',
    };

    const enumValues = Object.values(AppView);
    expect(Object.keys(expectedTypeByView).sort()).toEqual([...enumValues].sort());

    for (const view of enumValues) {
      expect(resolveAndroidBack({ ...base, currentView: view }).type).toBe(expectedTypeByView[view]);
    }
  });

  it('delegates ONBOARDING instead of unconditional minimize', () => {
    expect(resolveAndroidBack({ ...base, currentView: AppView.ONBOARDING })).toEqual({
      type: 'delegateOnboarding',
    });
  });

  it('delegates Parking Tools instead of jumping straight to Map', () => {
    expect(resolveAndroidBack({ ...base, currentView: AppView.AI_ASSISTANT })).toEqual({
      type: 'delegateAssistant',
    });
  });
});

describe('resolveMessagesAndroidBack', () => {
  it('closes an inbox-opened thread without leaving Messages', () => {
    expect(
      resolveMessagesAndroidBack({
        activeConversationId: 'chat_ab',
        openedFromPing: false,
      }),
    ).toBe('closeThread');
  });

  it('leaves Messages for a Ping-opened thread (mirrors visible thread Back)', () => {
    expect(
      resolveMessagesAndroidBack({
        activeConversationId: 'chat_ab',
        openedFromPing: true,
      }),
    ).toBe('leaveMessages');
  });

  it('leaves Messages when already at the inbox', () => {
    expect(
      resolveMessagesAndroidBack({
        activeConversationId: null,
        openedFromPing: false,
      }),
    ).toBe('leaveMessages');
  });
});

describe('resolveOnboardingAndroidBack', () => {
  it('goes to the previous slide from slide 2 and slide 3', () => {
    expect(resolveOnboardingAndroidBack(1)).toBe('previousSlide');
    expect(resolveOnboardingAndroidBack(2)).toBe('previousSlide');
  });

  it('requests root minimize on the first onboarding slide', () => {
    expect(resolveOnboardingAndroidBack(0)).toBe('minimize');
  });
});

describe('resolveAssistantAndroidBack', () => {
  it('returns nested tools to the Parking Tools hub', () => {
    expect(resolveAssistantAndroidBack(false)).toBe('backToHub');
  });

  it('leaves Parking Tools from the hub', () => {
    expect(resolveAssistantAndroidBack(true)).toBe('leaveAssistant');
  });
});

describe('dispatchAndroidSystemBack', () => {
  it('dismisses the top overlay and does not resolve AppView navigation', () => {
    const resolve = vi.fn();
    const apply = vi.fn();
    dispatchAndroidSystemBack(() => true, resolve, apply);
    expect(resolve).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it('resolves and applies AppView navigation when no overlay consumes Back', () => {
    const apply = vi.fn();
    dispatchAndroidSystemBack(
      () => false,
      () => ({ type: 'navigate', view: AppView.MAP }),
      apply,
    );
    expect(apply).toHaveBeenCalledWith({ type: 'navigate', view: AppView.MAP });
  });

  it('keeps Map as the home for bottom-nav roots', () => {
    expect(resolveAndroidBack({ ...base, currentView: AppView.NOTIFICATIONS })).toEqual({
      type: 'navigate',
      view: AppView.MAP,
    });
    expect(resolveAndroidBack({ ...base, currentView: AppView.PROFILE })).toEqual({
      type: 'navigate',
      view: AppView.MAP,
    });
    expect(resolveAndroidBack({ ...base, currentView: AppView.MESSAGES })).toEqual({
      type: 'delegateMessages',
    });
    expect(resolveMessagesAndroidBack({
      activeConversationId: null,
      openedFromPing: false,
    })).toBe('leaveMessages');
  });
});
