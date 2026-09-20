import { AppView } from '../types';
import type { LocationAccess } from './locationAccess';

/**
 * Pure Android system-Back decision table for ParQueen AppView navigation.
 * Overlay/sheet/search dismiss happens BEFORE this table (see dispatchAndroidSystemBack).
 * No Capacitor / React / Android APIs — App.tsx applies the returned action.
 */
export type AndroidBackAction =
  | { type: 'navigate'; view: AppView }
  | { type: 'closeLegal' }
  | { type: 'delegateMessages' }
  | { type: 'delegateOnboarding' }
  | { type: 'delegateAssistant' }
  | { type: 'minimize' }
  | { type: 'noop' };

/**
 * Overlay-first Android Back: dismiss the top sheet/modal/search, otherwise
 * resolve+apply the AppView table. Map is the stable home for bottom-nav roots.
 */
export function dispatchAndroidSystemBack(
  dismissOverlay: () => boolean,
  resolve: () => AndroidBackAction,
  apply: (action: AndroidBackAction) => void,
): void {
  if (dismissOverlay()) return;
  apply(resolve());
}

export type AndroidBackContext = {
  currentView: AppView;
  vehicleOnboarding: boolean;
  locationAccess: LocationAccess;
};

/** Destination after finishing vehicle onboarding (mirrors EditVehicle visible onBack). */
export function editVehicleAfterOnboarding(locationAccess: LocationAccess): AppView {
  return locationAccess === 'unknown' ? AppView.LOCATION_PROMPT : AppView.MAP;
}

/**
 * Resolve what Android system Back should do for the current AppView.
 * Mirrors visible onBack / header Back semantics; does not invent parents.
 */
export function resolveAndroidBack(ctx: AndroidBackContext): AndroidBackAction {
  const { currentView, vehicleOnboarding, locationAccess } = ctx;

  switch (currentView) {
    case AppView.MAP:
      return { type: 'minimize' };

    case AppView.MESSAGES:
      return { type: 'delegateMessages' };

    case AppView.PRIVACY_POLICY:
    case AppView.TERMS_OF_USE:
      return { type: 'closeLegal' };

    case AppView.EDIT_PROFILE:
      return { type: 'navigate', view: AppView.SETTINGS };

    case AppView.AI_ASSISTANT:
      return { type: 'delegateAssistant' };

    case AppView.PROFILE:
      return { type: 'navigate', view: AppView.MAP };

    case AppView.SETTINGS:
      return { type: 'navigate', view: AppView.PROFILE };

    case AppView.NOTIFICATIONS_SETTINGS:
    case AppView.LOCATION_SETTINGS:
    case AppView.LANGUAGE_SETTINGS:
      return { type: 'navigate', view: AppView.SETTINGS };

    case AppView.NOTIFICATIONS:
      return { type: 'navigate', view: AppView.MAP };

    case AppView.PARKING_SPACE:
      return { type: 'navigate', view: AppView.PROFILE };

    case AppView.CONTACT_US:
      return { type: 'navigate', view: AppView.PROFILE };

    case AppView.EDIT_VEHICLE:
      return {
        type: 'navigate',
        view: vehicleOnboarding
          ? editVehicleAfterOnboarding(locationAccess)
          : AppView.PROFILE,
      };

    case AppView.VERIFY_PHONE:
      // Mirrors VerifyPhoneView onEditNumber.
      return { type: 'navigate', view: AppView.CREATE_ACCOUNT };

    case AppView.COMPLETE_PROFILE:
      // Mirrors SetupProfileView onSkip destination.
      return { type: 'navigate', view: AppView.PROFILE };

    case AppView.ONBOARDING:
      return { type: 'delegateOnboarding' };

    // Auth / admin / unused legacy: no legitimate in-app parent.
    case AppView.CREATE_ACCOUNT:
    case AppView.SETUP_PROFILE:
    case AppView.LOCATION_PROMPT:
    case AppView.ADMIN_LOGIN:
    case AppView.ADMIN_DASHBOARD:
    case AppView.SPLASH:
    case AppView.GARAGE_LIST:
    case AppView.HOST_DASHBOARD:
      return { type: 'minimize' };

    default: {
      const _exhaustive: never = currentView;
      void _exhaustive;
      return { type: 'minimize' };
    }
  }
}

/** Messages owns conversation state; App only receives this high-level decision. */
export type MessagesAndroidBackAction = 'closeThread' | 'leaveMessages';

/**
 * Mirror MessagesView visible Back:
 * - inbox thread (no Ping context) -> close thread, stay on inbox
 * - Ping-opened thread -> leave Messages (same as visible thread Back / onBack)
 * - inbox root -> leave Messages (Map)
 */
export function resolveMessagesAndroidBack(opts: {
  activeConversationId: string | null;
  openedFromPing: boolean;
}): MessagesAndroidBackAction {
  if (opts.activeConversationId && !opts.openedFromPing) {
    return 'closeThread';
  }
  return 'leaveMessages';
}

/** Onboarding owns slide index; App only receives this high-level decision. */
export type OnboardingAndroidBackAction = 'previousSlide' | 'minimize';

/**
 * Mirror OnboardingView goBack():
 * - slide index > 0 -> previous slide (stay in ONBOARDING)
 * - slide index === 0 -> root minimize
 */
export function resolveOnboardingAndroidBack(slideIndex: number): OnboardingAndroidBackAction {
  return slideIndex > 0 ? 'previousSlide' : 'minimize';
}

/** Parking Tools owns tool-mode; App only receives this high-level decision. */
export type AssistantAndroidBackAction = 'backToHub' | 'leaveAssistant';

/**
 * Mirror AssistantView visible Back:
 * - nested tool (scanner / hydrant / check) -> hub
 * - hub -> leave to Map
 */
export function resolveAssistantAndroidBack(isOnHub: boolean): AssistantAndroidBackAction {
  return isOnHub ? 'leaveAssistant' : 'backToHub';
}
