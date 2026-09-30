import type { NotificationRuntimeState } from './notificationRegistration';

export type NotificationPresentationKind =
  | 'checking'
  | 'enable'
  | 'enabled'
  | 'off'
  | 'ios_install_required'
  | 'ios_native_unavailable'
  | 'unsupported'
  | 'denied'
  | 'registration_failed';

export interface NotificationPresentation {
  kind: NotificationPresentationKind;
  action: 'none' | 'enable' | 'recheck' | 'retry';
}

export function deriveNotificationPresentation(
  productPreferenceEnabled: boolean,
  runtime: NotificationRuntimeState | null,
): NotificationPresentation {
  if (!runtime) return { kind: 'checking', action: 'none' };
  if (runtime.capability === 'ios_native_unavailable') {
    return { kind: 'ios_native_unavailable', action: 'none' };
  }
  if (runtime.capability === 'ios_install_required') {
    return { kind: 'ios_install_required', action: 'none' };
  }
  if (runtime.capability === 'unsupported') return { kind: 'unsupported', action: 'none' };
  if (runtime.permission === 'denied') return { kind: 'denied', action: 'recheck' };
  if (runtime.permission === 'granted' && runtime.registration === 'failed') {
    return { kind: 'registration_failed', action: 'retry' };
  }
  if (!productPreferenceEnabled) return { kind: 'off', action: 'enable' };
  if (runtime.permission === 'granted' && runtime.registration === 'registered') {
    return { kind: 'enabled', action: 'none' };
  }
  return { kind: 'enable', action: 'enable' };
}
