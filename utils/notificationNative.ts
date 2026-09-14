import { FCM_OWNER_UID_KEY, FCM_OWNER_VERSION, FCM_OWNER_VERSION_KEY } from './notificationOwnership';
import type {
  NotificationPermissionState,
  NotificationRegistrationState,
  NotificationRuntimeState,
} from './notificationRegistration';

export const NATIVE_ALERT_CHANNEL_ID = 'parqueen_parking';
const REGISTRATION_TIMEOUT_MS = 20_000;

export interface NativePushRegistrationEvent {
  value?: string;
}

export interface NativePushNotification {
  title?: string;
  body?: string;
  data?: unknown;
}

export interface NativePushActionPerformed {
  notification?: NativePushNotification;
}

export interface NativePushPlugin {
  checkPermissions: () => Promise<{ receive: string }>;
  requestPermissions: () => Promise<{ receive: string }>;
  register: () => Promise<void>;
  unregister: () => Promise<void>;
  createChannel: (channel: {
    id: string;
    name: string;
    description?: string;
    importance?: 0 | 1 | 2 | 3 | 4 | 5;
    vibration?: boolean;
  }) => Promise<void>;
  addListener: (
    eventName: 'registration' | 'registrationError' | 'pushNotificationReceived' | 'pushNotificationActionPerformed',
    listenerFunc: (event: NativePushRegistrationEvent & NativePushNotification & NativePushActionPerformed) => void,
  ) => Promise<{ remove: () => Promise<void> }>;
}

export interface NativeNotificationRegistrationDependencies {
  plugin: NativePushPlugin;
  writePreferences: (uid: string, values: { fcmToken: string; notificationsEnabled?: true }) => Promise<void>;
  getLocal: (key: string) => string | null;
  setLocal: (key: string, value: string) => void;
}

const stateFor = (
  permission: NotificationPermissionState,
  registration: NotificationRegistrationState = 'not_registered',
): NotificationRuntimeState => ({
  capability: 'supported',
  permission,
  registration,
});

export function mapNativeReceivePermission(receive: string): NotificationPermissionState {
  if (receive === 'granted') return 'granted';
  if (receive === 'denied') return 'denied';
  return 'default';
}

export function normalizeNativePushPayload(notification: NativePushNotification): {
  notification: { title?: string; body?: string };
  data: Record<string, unknown>;
} {
  const data = typeof notification.data === 'object' && notification.data !== null && !Array.isArray(notification.data)
    ? notification.data as Record<string, unknown>
    : {};
  return {
    notification: { title: notification.title, body: notification.body },
    data,
  };
}

async function ensureAlertChannel(plugin: NativePushPlugin): Promise<void> {
  try {
    await plugin.createChannel({
      id: NATIVE_ALERT_CHANNEL_ID,
      name: 'Parking alerts',
      description: 'Nearby parking Pings and parking updates',
      importance: 4,
      vibration: true,
    });
  } catch {
    // Channel may already exist; FCM can still use its fallback channel.
  }
}

async function obtainNativeToken(plugin: NativePushPlugin): Promise<string> {
  let registrationHandle: { remove: () => Promise<void> } | undefined;
  let errorHandle: { remove: () => Promise<void> } | undefined;

  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const succeed = (value: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(
        () => fail(new Error('native push registration timed out')),
        REGISTRATION_TIMEOUT_MS,
      );

      void (async () => {
        try {
          registrationHandle = await plugin.addListener('registration', event => {
            const value = typeof event?.value === 'string' ? event.value.trim() : '';
            if (!value) {
              fail(new Error('native push registration returned no token'));
              return;
            }
            succeed(value);
          });
          errorHandle = await plugin.addListener('registrationError', () => {
            fail(new Error('native push registration failed'));
          });
          await plugin.register();
        } catch {
          fail(new Error('native push registration failed'));
        }
      })();
    });
  } finally {
    await registrationHandle?.remove().catch(() => undefined);
    await errorHandle?.remove().catch(() => undefined);
  }
}

export function createNativeNotificationRegistrationService(
  deps: NativeNotificationRegistrationDependencies,
) {
  const inspect = async (): Promise<NotificationRuntimeState> => {
    try {
      const status = await deps.plugin.checkPermissions();
      return stateFor(mapNativeReceivePermission(status.receive));
    } catch {
      return stateFor('unavailable');
    }
  };

  const register = async (
    uid: string,
    enablePreference: boolean,
  ): Promise<NotificationRuntimeState> => {
    try {
      const storedOwnerUid = deps.getLocal(FCM_OWNER_UID_KEY);
      const ownerMismatch = storedOwnerUid !== null && storedOwnerUid !== uid;
      const legacyInstall = storedOwnerUid === null
        && deps.getLocal(FCM_OWNER_VERSION_KEY) !== FCM_OWNER_VERSION;
      if (ownerMismatch || legacyInstall) {
        try {
          await deps.plugin.unregister();
        } catch {
          // Continue; last-writer-wins still replaces the stored token.
        }
      }

      await ensureAlertChannel(deps.plugin);
      const token = await obtainNativeToken(deps.plugin);
      if (!token) return stateFor('granted', 'failed');

      await deps.writePreferences(uid, {
        fcmToken: token,
        ...(enablePreference ? { notificationsEnabled: true as const } : {}),
      });
      deps.setLocal(FCM_OWNER_UID_KEY, uid);
      deps.setLocal(FCM_OWNER_VERSION_KEY, FCM_OWNER_VERSION);
      return stateFor('granted', 'registered');
    } catch (error) {
      console.warn('FCM setup error', error);
      return stateFor('granted', 'failed');
    }
  };

  const enable = async (uid: string): Promise<NotificationRuntimeState> => {
    const current = await inspect();
    if (current.permission === 'denied') return stateFor('denied');
    if (current.permission === 'unavailable') return { capability: 'unsupported', permission: 'unavailable', registration: 'not_registered' };

    let permission: NotificationPermissionState = current.permission;
    if (permission === 'default') {
      const requested = await deps.plugin.requestPermissions();
      permission = mapNativeReceivePermission(requested.receive);
    }
    if (permission !== 'granted') return stateFor(permission);
    return register(uid, true);
  };

  const refreshGranted = async (
    uid: string,
    productPreferenceEnabled: boolean,
  ): Promise<NotificationRuntimeState> => {
    const current = await inspect();
    if (!productPreferenceEnabled || current.capability !== 'supported' || current.permission !== 'granted') {
      return current;
    }
    return register(uid, false);
  };

  const subscribeForeground = async (
    uid: string,
    handler: (payload: unknown) => void,
  ): Promise<() => void> => {
    const handle = await deps.plugin.addListener('pushNotificationReceived', notification => {
      const payload = normalizeNativePushPayload(notification);
      if (payload.data.finderId === uid) return;
      handler(payload);
    });
    return () => {
      void handle.remove();
    };
  };

  const subscribeOpen = async (
    handler: (payload: unknown) => void,
  ): Promise<() => void> => {
    const handle = await deps.plugin.addListener('pushNotificationActionPerformed', action => {
      handler(normalizeNativePushPayload(action.notification ?? {}));
    });
    return () => {
      void handle.remove();
    };
  };

  return {
    inspect,
    enable,
    refreshGranted,
    subscribeForeground,
    subscribeOpen,
    getVapidStatus: () => 'configured' as const,
  };
}
