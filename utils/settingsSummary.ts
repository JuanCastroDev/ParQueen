import type { LocationPermissionState } from './nearbyActivity';
import type { NotificationRuntimeState } from './notificationRegistration';
import { deriveNotificationPresentation } from './notificationPresentation';

export interface NotificationsSummaryState {
  statusKey:
    | 'settings.notif_on'
    | 'settings.notif_off'
    | 'settings.notif_not_ready'
    | 'settings.notif_unavailable';
  showRadius: boolean;
  radius: number;
}

export interface LocationSummaryState {
  permissionKey:
    | 'settings.location_allowed'
    | 'settings.location_not_enabled'
    | 'settings.location_not_allowed'
    | 'settings.location_blocked'
    | 'settings.location_services_off';
  /** Only present when permissionState === 'granted' */
  preciseKey?: 'settings.precise_on' | 'settings.precise_off';
}

export function getNotificationsSummaryState(
  enabled: boolean,
  radius: number,
  runtime?: NotificationRuntimeState | null,
): NotificationsSummaryState {
  if (runtime !== undefined) {
    const presentation = deriveNotificationPresentation(enabled, runtime);
    const ready = presentation.kind === 'enabled';
    const unavailable = presentation.kind === 'unsupported'
      || presentation.kind === 'ios_install_required'
      || presentation.kind === 'ios_native_unavailable';
    return {
      statusKey: ready
        ? 'settings.notif_on'
        : unavailable
          ? 'settings.notif_unavailable'
          : enabled
            ? 'settings.notif_not_ready'
            : 'settings.notif_off',
      showRadius: ready,
      radius,
    };
  }
  return {
    statusKey: enabled ? 'settings.notif_on' : 'settings.notif_off',
    showRadius: enabled,
    radius,
  };
}

export function getLocationSummaryState(
  permissionState: LocationPermissionState,
  precise: boolean,
): LocationSummaryState {
  const permissionKey: LocationSummaryState['permissionKey'] = (() => {
    switch (permissionState) {
      case 'granted':            return 'settings.location_allowed';
      case 'not_determined':     return 'settings.location_not_enabled';
      case 'denied_requestable': return 'settings.location_not_allowed';
      case 'permanently_blocked':return 'settings.location_blocked';
      case 'services_disabled':  return 'settings.location_services_off';
    }
  })();
  return {
    permissionKey,
    // preciseKey only when ParQueen actually has access
    ...(permissionState === 'granted'
      ? { preciseKey: precise ? 'settings.precise_on' : 'settings.precise_off' }
      : {}),
  };
}
