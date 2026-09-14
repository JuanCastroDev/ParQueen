import { PushNotifications } from '@capacitor/push-notifications';
import { doc, setDoc } from 'firebase/firestore';
import { deleteToken, getToken, onMessage, type MessagePayload, type Messaging } from 'firebase/messaging';
import { db, getFCM } from '../firebaseConfig';
import { createNativeNotificationRegistrationService, type NativePushPlugin } from './notificationNative';
import { FCM_OWNER_UID_KEY, FCM_OWNER_VERSION, FCM_OWNER_VERSION_KEY } from './notificationOwnership';
import { resolveNotificationPath, type NotificationPath } from './notificationPlatform';

export type NotificationCapability = 'supported' | 'ios_install_required' | 'unsupported';
export type NotificationPermissionState = NotificationPermission | 'unavailable';
export type NotificationRegistrationState = 'not_registered' | 'registered' | 'failed';

export interface NotificationRuntimeState {
  capability: NotificationCapability;
  permission: NotificationPermissionState;
  registration: NotificationRegistrationState;
}

export interface NotificationPlatformInput {
  notificationAvailable: boolean;
  serviceWorkerAvailable: boolean;
  pushManagerAvailable: boolean;
  standalone: boolean;
  userAgent: string;
  platform: string;
  maxTouchPoints: number;
}

export interface NotificationRegistrationDependencies {
  getPlatform: () => NotificationCapability;
  getPermission: () => NotificationPermissionState;
  requestPermission: () => Promise<NotificationPermission>;
  getMessaging: () => Promise<unknown | null>;
  getToken: (messaging: unknown, options?: { vapidKey: string }) => Promise<string>;
  deleteToken: (messaging: unknown) => Promise<boolean>;
  writePreferences: (uid: string, values: { fcmToken: string; notificationsEnabled?: true }) => Promise<void>;
  getLocal: (key: string) => string | null;
  setLocal: (key: string, value: string) => void;
  onMessage: (messaging: unknown, handler: (payload: unknown) => void) => () => void;
  vapidKey?: string;
}

export { FCM_OWNER_UID_KEY, FCM_OWNER_VERSION, FCM_OWNER_VERSION_KEY } from './notificationOwnership';

export const writeNotificationPreferences = (
  uid: string,
  values: { fcmToken: string; notificationsEnabled?: true },
) => setDoc(doc(db, 'users', uid, 'private', 'preferences'), values, { merge: true });

export function detectNotificationPlatform(input: NotificationPlatformInput): NotificationCapability {
  const iosDevice = /iPad|iPhone|iPod/i.test(input.userAgent)
    || (input.platform === 'MacIntel' && input.maxTouchPoints > 1);

  if (iosDevice && !input.standalone) return 'ios_install_required';
  if (!input.notificationAvailable || !input.serviceWorkerAvailable || !input.pushManagerAvailable) {
    return 'unsupported';
  }
  return 'supported';
}

export function inspectBrowserNotificationPlatform(): NotificationCapability {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return 'unsupported';
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches
    || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return detectNotificationPlatform({
    notificationAvailable: 'Notification' in window,
    serviceWorkerAvailable: 'serviceWorker' in navigator,
    pushManagerAvailable: 'PushManager' in window,
    standalone,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    maxTouchPoints: navigator.maxTouchPoints ?? 0,
  });
}

const stateFor = (
  capability: NotificationCapability,
  permission: NotificationPermissionState,
  registration: NotificationRegistrationState = 'not_registered',
): NotificationRuntimeState => ({ capability, permission, registration });

export function createNotificationRegistrationService(deps: NotificationRegistrationDependencies) {
  let cachedMessaging: unknown | null | undefined;

  const getMessaging = async () => {
    if (cachedMessaging !== undefined) return cachedMessaging;
    try {
      cachedMessaging = await deps.getMessaging();
    } catch {
      cachedMessaging = null;
    }
    return cachedMessaging;
  };

  const inspect = async (): Promise<NotificationRuntimeState> => {
    const capability = deps.getPlatform();
    if (capability !== 'supported') return stateFor(capability, 'unavailable');
    const messaging = await getMessaging();
    if (!messaging) return stateFor('unsupported', 'unavailable');
    return stateFor('supported', deps.getPermission());
  };

  const register = async (
    uid: string,
    enablePreference: boolean,
  ): Promise<NotificationRuntimeState> => {
    const messaging = await getMessaging();
    if (!messaging) return stateFor('unsupported', 'unavailable');

    try {
      const storedOwnerUid = deps.getLocal(FCM_OWNER_UID_KEY);
      const ownerMismatch = storedOwnerUid !== null && storedOwnerUid !== uid;
      const legacyInstall = storedOwnerUid === null
        && deps.getLocal(FCM_OWNER_VERSION_KEY) !== FCM_OWNER_VERSION;
      if (ownerMismatch || legacyInstall) await deps.deleteToken(messaging);

      const vapidKey = deps.vapidKey?.trim();
      const token = vapidKey
        ? await deps.getToken(messaging, { vapidKey })
        : await deps.getToken(messaging);
      if (!token) return stateFor('supported', 'granted', 'failed');

      await deps.writePreferences(uid, {
        fcmToken: token,
        ...(enablePreference ? { notificationsEnabled: true as const } : {}),
      });
      deps.setLocal(FCM_OWNER_UID_KEY, uid);
      deps.setLocal(FCM_OWNER_VERSION_KEY, FCM_OWNER_VERSION);
      return stateFor('supported', 'granted', 'registered');
    } catch (error) {
      console.warn('FCM setup error', error);
      return stateFor('supported', 'granted', 'failed');
    }
  };

  const enable = async (uid: string): Promise<NotificationRuntimeState> => {
    const capability = deps.getPlatform();
    if (capability !== 'supported') return stateFor(capability, 'unavailable');

    const currentPermission = deps.getPermission();
    if (currentPermission === 'denied') return stateFor('supported', 'denied');
    if (currentPermission === 'unavailable') return stateFor('unsupported', 'unavailable');

    // Keep this call before the first await. Browsers require the permission
    // request to remain directly attached to the user's Enable click.
    const permissionPromise = currentPermission === 'default'
      ? deps.requestPermission()
      : Promise.resolve(currentPermission);
    const permission = await permissionPromise;
    if (permission !== 'granted') return stateFor('supported', permission);
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
    if (deps.getPlatform() !== 'supported') return () => {};
    const messaging = await getMessaging();
    if (!messaging) return () => {};
    return deps.onMessage(messaging, payload => {
      const data = typeof payload === 'object' && payload !== null
        ? (payload as { data?: { finderId?: string } }).data
        : undefined;
      if (data?.finderId === uid) return;
      handler(payload);
    });
  };

  const subscribeOpen = async (_handler: (payload: unknown) => void): Promise<() => void> => () => {};

  return {
    inspect,
    enable,
    refreshGranted,
    subscribeForeground,
    subscribeOpen,
    getVapidStatus: () => deps.vapidKey?.trim() ? 'configured' as const : 'missing' as const,
  };
}

export type NotificationRegistrationService = ReturnType<typeof createNotificationRegistrationService>;

const configuredVapidKey = import.meta.env.VITE_FIREBASE_VAPID_KEY as string | undefined;

const browserLocalStorage = {
  getLocal: (key: string) => localStorage.getItem(key),
  setLocal: (key: string, value: string) => localStorage.setItem(key, value),
};

export function createParQueenNotificationRegistration(
  path: NotificationPath = resolveNotificationPath(),
  nativePlugin: NativePushPlugin = PushNotifications,
): NotificationRegistrationService {
  if (path === 'native') {
    return createNativeNotificationRegistrationService({
      plugin: nativePlugin,
      writePreferences: writeNotificationPreferences,
      ...browserLocalStorage,
    });
  }

  return createNotificationRegistrationService({
    getPlatform: inspectBrowserNotificationPlatform,
    getPermission: () => typeof Notification === 'undefined' ? 'unavailable' : Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    getMessaging: getFCM,
    getToken: (messaging, options) => getToken(messaging as Messaging, options),
    deleteToken: messaging => deleteToken(messaging as Messaging),
    writePreferences: writeNotificationPreferences,
    getLocal: browserLocalStorage.getLocal,
    setLocal: browserLocalStorage.setLocal,
    onMessage: (messaging, handler) => onMessage(
      messaging as Messaging,
      payload => handler(payload as MessagePayload),
    ),
    vapidKey: configuredVapidKey,
  });
}

export const notificationRegistration = createParQueenNotificationRegistration();
