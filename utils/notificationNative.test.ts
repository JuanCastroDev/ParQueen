import { describe, expect, it, vi } from 'vitest';
import {
  createNativeNotificationRegistrationService,
  mapNativeReceivePermission,
  normalizeNativePushPayload,
  type NativePushPlugin,
} from './notificationNative';
import { FCM_OWNER_UID_KEY, FCM_OWNER_VERSION, FCM_OWNER_VERSION_KEY } from './notificationOwnership';

const makePlugin = (overrides: Partial<NativePushPlugin> = {}): NativePushPlugin & {
  listeners: Map<string, Array<(event: unknown) => void>>;
} => {
  const listeners = new Map<string, Array<(event: unknown) => void>>();
  const plugin: NativePushPlugin & { listeners: typeof listeners } = {
    listeners,
    checkPermissions: vi.fn(async () => ({ receive: 'prompt' })),
    requestPermissions: vi.fn(async () => ({ receive: 'granted' })),
    register: vi.fn(async () => {
      listeners.get('registration')?.forEach(listener => listener({ value: 'native-fcm-token' }));
    }),
    unregister: vi.fn(async () => undefined),
    createChannel: vi.fn(async () => undefined),
    addListener: vi.fn(async (eventName, listenerFunc) => {
      const bucket = listeners.get(eventName) ?? [];
      bucket.push(listenerFunc as (event: unknown) => void);
      listeners.set(eventName, bucket);
      return { remove: vi.fn(async () => undefined) };
    }),
    ...overrides,
  };
  return plugin;
};

function dependencies(plugin: NativePushPlugin, overrides: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const local = new Map<string, string>();
  return {
    calls,
    local,
    deps: {
      plugin,
      writePreferences: vi.fn(async (_uid: string, values: { fcmToken: string; notificationsEnabled?: true }) => {
        calls.push(`write:${Object.keys(values).sort().join(',')}`);
      }),
      getLocal: (key: string) => local.get(key) ?? null,
      setLocal: (key: string, value: string) => {
        local.set(key, value);
        calls.push(`setLocal:${key}`);
      }),
      ...overrides,
    },
  };
}

describe('mapNativeReceivePermission', () => {
  it('maps not-yet-requested Android states to default', () => {
    expect(mapNativeReceivePermission('prompt')).toBe('default');
    expect(mapNativeReceivePermission('prompt-with-rationale')).toBe('default');
  });

  it('maps grant and deny to the shared runtime permission states', () => {
    expect(mapNativeReceivePermission('granted')).toBe('granted');
    expect(mapNativeReceivePermission('denied')).toBe('denied');
  });
});

describe('normalizeNativePushPayload', () => {
  it('matches the foreground toast / intent payload shape without exposing a token', () => {
    const payload = normalizeNativePushPayload({
      title: 'New Spot Near You!',
      body: 'Someone just left a spot.',
      data: { navigationVersion: '1', navigationType: 'ping', spotId: 'spot-1' },
    });
    expect(payload).toEqual({
      notification: { title: 'New Spot Near You!', body: 'Someone just left a spot.' },
      data: { navigationVersion: '1', navigationType: 'ping', spotId: 'spot-1' },
    });
    expect(JSON.stringify(payload)).not.toMatch(/fcm|token/i);
  });
});

describe('native Android notification registration', () => {
  it('treats a fresh / not-yet-requested OS state as default and does not register on inspect', async () => {
    const plugin = makePlugin();
    const { deps, calls } = dependencies(plugin);
    const service = createNativeNotificationRegistrationService(deps);

    await expect(service.inspect()).resolves.toMatchObject({
      capability: 'supported',
      permission: 'default',
      registration: 'not_registered',
    });
    expect(plugin.requestPermissions).not.toHaveBeenCalled();
    expect(plugin.register).not.toHaveBeenCalled();
    expect(calls).not.toContain('write:fcmToken,notificationsEnabled');
  });

  it('requests the native Android permission only on explicit Enable, then registers', async () => {
    const plugin = makePlugin();
    const { deps } = dependencies(plugin);
    const service = createNativeNotificationRegistrationService(deps);

    await expect(service.enable('user-a')).resolves.toMatchObject({
      capability: 'supported',
      permission: 'granted',
      registration: 'registered',
    });
    expect(plugin.requestPermissions).toHaveBeenCalledTimes(1);
    expect(plugin.register).toHaveBeenCalledTimes(1);
    expect(deps.writePreferences).toHaveBeenCalledWith('user-a', {
      fcmToken: 'native-fcm-token',
      notificationsEnabled: true,
    });
  });

  it('does not call Notification.requestPermission or the web messaging path', async () => {
    const requestPermission = vi.fn();
    Object.defineProperty(globalThis, 'Notification', {
      configurable: true,
      value: { permission: 'default', requestPermission },
    });
    const plugin = makePlugin();
    const service = createNativeNotificationRegistrationService(dependencies(plugin).deps);
    await service.enable('user-a');
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('never requests again when Android has denied notifications', async () => {
    const plugin = makePlugin({
      checkPermissions: vi.fn(async () => ({ receive: 'denied' })),
      requestPermissions: vi.fn(async () => ({ receive: 'denied' })),
    });
    const { deps } = dependencies(plugin);
    const service = createNativeNotificationRegistrationService(deps);

    await expect(service.enable('user-a')).resolves.toMatchObject({
      permission: 'denied',
      registration: 'not_registered',
    });
    expect(plugin.requestPermissions).not.toHaveBeenCalled();
    expect(plugin.register).not.toHaveBeenCalled();
    expect(deps.writePreferences).not.toHaveBeenCalled();
  });

  it('does not mark enabled after a native grant unless registration succeeds', async () => {
    const plugin = makePlugin({
      checkPermissions: vi.fn(async () => ({ receive: 'granted' })),
      register: vi.fn(async () => {
        plugin.listeners.get('registrationError')?.forEach(listener => listener({ error: 'failed' }));
      }),
    });
    const { deps } = dependencies(plugin);
    const service = createNativeNotificationRegistrationService(deps);

    await expect(service.enable('user-a')).resolves.toMatchObject({
      permission: 'granted',
      registration: 'failed',
    });
    expect(deps.writePreferences).not.toHaveBeenCalled();
  });

  it('silently refreshes an already-granted enabled user without requesting permission', async () => {
    const plugin = makePlugin({
      checkPermissions: vi.fn(async () => ({ receive: 'granted' })),
    });
    const { deps } = dependencies(plugin);
    const service = createNativeNotificationRegistrationService(deps);

    await expect(service.refreshGranted('user-a', true)).resolves.toMatchObject({
      permission: 'granted',
      registration: 'registered',
    });
    expect(plugin.requestPermissions).not.toHaveBeenCalled();
    expect(deps.writePreferences).toHaveBeenCalledWith('user-a', { fcmToken: 'native-fcm-token' });
  });

  it('does not silently register when the product preference is off', async () => {
    const plugin = makePlugin({
      checkPermissions: vi.fn(async () => ({ receive: 'granted' })),
    });
    const { deps } = dependencies(plugin);
    const service = createNativeNotificationRegistrationService(deps);
    await service.refreshGranted('user-a', false);
    expect(plugin.register).not.toHaveBeenCalled();
  });

  it('recovers after an Android Settings change from denied to granted on recheck', async () => {
    const plugin = makePlugin({
      checkPermissions: vi.fn(async () => ({ receive: 'denied' })),
    });
    const { deps } = dependencies(plugin);
    const service = createNativeNotificationRegistrationService(deps);

    await expect(service.inspect()).resolves.toMatchObject({ permission: 'denied' });

    plugin.checkPermissions = vi.fn(async () => ({ receive: 'granted' }));
    await expect(service.refreshGranted('user-a', true)).resolves.toMatchObject({
      permission: 'granted',
      registration: 'registered',
    });
    expect(plugin.requestPermissions).not.toHaveBeenCalled();
  });

  it('reflects a later Android Settings denial without prompting again', async () => {
    const plugin = makePlugin({
      checkPermissions: vi.fn(async () => ({ receive: 'granted' })),
    });
    const { deps } = dependencies(plugin);
    const service = createNativeNotificationRegistrationService(deps);
    await service.refreshGranted('user-a', true);

    plugin.checkPermissions = vi.fn(async () => ({ receive: 'denied' }));
    await expect(service.inspect()).resolves.toMatchObject({
      permission: 'denied',
      registration: 'not_registered',
    });
    expect(plugin.requestPermissions).not.toHaveBeenCalled();
  });

  it('rotates an account-mismatched native token before associating the replacement', async () => {
    const plugin = makePlugin({
      checkPermissions: vi.fn(async () => ({ receive: 'granted' })),
    });
    const { deps, calls, local } = dependencies(plugin);
    local.set(FCM_OWNER_UID_KEY, 'user-old');
    local.set(FCM_OWNER_VERSION_KEY, FCM_OWNER_VERSION);
    const service = createNativeNotificationRegistrationService(deps);
    await service.refreshGranted('user-new', true);

    expect(plugin.unregister).toHaveBeenCalled();
    expect(calls.indexOf('write:fcmToken')).toBeGreaterThan(-1);
    expect(local.get(FCM_OWNER_UID_KEY)).toBe('user-new');
  });

  it('never logs the native FCM token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const plugin = makePlugin();
    const service = createNativeNotificationRegistrationService(dependencies(plugin).deps);
    await service.enable('user-a');
    const printed = [...warn.mock.calls, ...log.mock.calls, ...info.mock.calls]
      .map(args => args.map(value => String(value)).join(' '))
      .join('\n');
    expect(printed).not.toContain('native-fcm-token');
    warn.mockRestore();
    log.mockRestore();
    info.mockRestore();
  });

  it('delivers foreground payloads as in-app toasts and skips the finder', async () => {
    const plugin = makePlugin({
      checkPermissions: vi.fn(async () => ({ receive: 'granted' })),
    });
    const handler = vi.fn();
    const service = createNativeNotificationRegistrationService(dependencies(plugin).deps);
    const unsubscribe = await service.subscribeForeground('finder-1', handler);

    plugin.listeners.get('pushNotificationReceived')?.forEach(listener => listener({
      title: 'Nearby',
      body: 'A spot opened',
      data: { finderId: 'finder-1' },
    }));
    expect(handler).not.toHaveBeenCalled();

    plugin.listeners.get('pushNotificationReceived')?.forEach(listener => listener({
      title: 'Nearby',
      body: 'A spot opened',
      data: { finderId: 'other', navigationType: 'ping', spotId: 'spot-1' },
    }));
    expect(handler).toHaveBeenCalledWith({
      notification: { title: 'Nearby', body: 'A spot opened' },
      data: { finderId: 'other', navigationType: 'ping', spotId: 'spot-1' },
    });
    unsubscribe();
  });
});
