import type { NotificationRuntimeState } from './notificationRegistration';

interface NotificationLifecycleService {
  inspect: () => Promise<NotificationRuntimeState>;
  refreshGranted: (uid: string, productPreferenceEnabled: boolean) => Promise<NotificationRuntimeState>;
  subscribeForeground: (uid: string, handler: (payload: unknown) => void) => Promise<() => void>;
}

interface NotificationLifecycleCallbacks {
  onState: (state: NotificationRuntimeState | null) => void;
  onPayload: (payload: unknown) => void;
}

interface NotificationLifecycleUser {
  uid: string;
  productPreferenceEnabled: boolean | null;
}

export function createNotificationLifecycle(
  service: NotificationLifecycleService,
  callbacks: NotificationLifecycleCallbacks,
) {
  let generation = 0;
  let activeUnsubscribe: (() => void) | null = null;

  const clearListener = () => {
    activeUnsubscribe?.();
    activeUnsubscribe = null;
  };

  const setUser = async (user: NotificationLifecycleUser | null) => {
    const ownGeneration = ++generation;
    clearListener();
    if (!user) {
      callbacks.onState(null);
      return;
    }
    const state = user.productPreferenceEnabled === null
      ? await service.inspect()
      : await service.refreshGranted(user.uid, user.productPreferenceEnabled);
    if (ownGeneration !== generation) return;
    callbacks.onState(state);

    if (user.productPreferenceEnabled !== true) return;

    const unsubscribe = await service.subscribeForeground(user.uid, callbacks.onPayload);
    if (ownGeneration !== generation) {
      unsubscribe();
      return;
    }
    activeUnsubscribe = unsubscribe;
  };

  return {
    setUser,
    dispose: () => {
      generation++;
      clearListener();
    },
  };
}
