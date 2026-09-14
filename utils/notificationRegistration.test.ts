import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createNotificationRegistrationService,
  detectNotificationPlatform,
  type NotificationRegistrationDependencies,
} from './notificationRegistration';

function dependencies(overrides: Partial<NotificationRegistrationDependencies> = {}) {
  const calls: string[] = [];
  const deps: NotificationRegistrationDependencies = {
    getPlatform: () => 'supported',
    getPermission: () => 'default',
    requestPermission: async () => { calls.push('requestPermission'); return 'granted'; },
    getMessaging: async () => { calls.push('getMessaging'); return { name: 'messaging' }; },
    getToken: async (_messaging, options) => {
      calls.push(options?.vapidKey ? 'getToken:vapid' : 'getToken');
      return 'token-123';
    },
    deleteToken: async () => { calls.push('deleteToken'); return true; },
    writePreferences: async (_uid, values) => {
      calls.push(`write:${Object.keys(values).sort().join(',')}`);
    },
    getLocal: () => null,
    setLocal: (key, value) => { calls.push(`setLocal:${key}:${value}`); },
    onMessage: (_messaging, _handler) => {
      calls.push('onMessage');
      return () => calls.push('unsubscribe');
    },
    ...overrides,
  };
  return { deps, calls };
}

describe('notification platform detection', () => {
  it('requires an iPhone/iPad ordinary browser to install before enabling', () => {
    expect(detectNotificationPlatform({
      notificationAvailable: true,
      serviceWorkerAvailable: true,
      pushManagerAvailable: true,
      standalone: false,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      platform: 'iPhone',
      maxTouchPoints: 5,
    })).toBe('ios_install_required');
  });

  it('treats the same iPhone launched standalone as capability eligible', () => {
    expect(detectNotificationPlatform({
      notificationAvailable: true,
      serviceWorkerAvailable: true,
      pushManagerAvailable: true,
      standalone: true,
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)',
      platform: 'iPhone',
      maxTouchPoints: 5,
    })).toBe('supported');
  });

  it('fails closed when a required browser capability is absent', () => {
    expect(detectNotificationPlatform({
      notificationAvailable: true,
      serviceWorkerAvailable: false,
      pushManagerAvailable: true,
      standalone: false,
      userAgent: 'Mozilla/5.0 (Windows NT 10.0)',
      platform: 'Win32',
      maxTouchPoints: 0,
    })).toBe('unsupported');
  });
});

describe('notification registration service', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('requests permission synchronously from Enable before registration work', async () => {
    const { deps, calls } = dependencies();
    const service = createNotificationRegistrationService(deps);
    await service.inspect();
    calls.length = 0;

    const resultPromise = service.enable('user-a');
    expect(calls).toEqual(['requestPermission']);
    await expect(resultPromise).resolves.toMatchObject({
      capability: 'supported', permission: 'granted', registration: 'registered',
    });
  });

  it('never requests again when permission is denied', async () => {
    const { deps, calls } = dependencies({ getPermission: () => 'denied' });
    const service = createNotificationRegistrationService(deps);
    await service.inspect();
    await expect(service.enable('user-a')).resolves.toMatchObject({
      permission: 'denied', registration: 'not_registered',
    });
    expect(calls).not.toContain('requestPermission');
    expect(calls).not.toContain('getToken');
  });

  it.each(['unsupported', 'ios_install_required'] as const)(
    'does not request permission for %s',
    async (platform) => {
      const { deps, calls } = dependencies({ getPlatform: () => platform });
      const service = createNotificationRegistrationService(deps);
      await service.inspect();
      await service.enable('user-a');
      expect(calls).not.toContain('requestPermission');
      expect(calls).not.toContain('getToken');
    },
  );

  it('silently refreshes an already-granted enabled user without requesting permission', async () => {
    const { deps, calls } = dependencies({ getPermission: () => 'granted' });
    const service = createNotificationRegistrationService(deps);
    await expect(service.refreshGranted('user-a', true)).resolves.toMatchObject({
      permission: 'granted', registration: 'registered',
    });
    expect(calls).not.toContain('requestPermission');
    expect(calls).toContain('getToken');
  });

  it('does not silently register when the product preference is off', async () => {
    const { deps, calls } = dependencies({ getPermission: () => 'granted' });
    const service = createNotificationRegistrationService(deps);
    await service.refreshGranted('user-a', false);
    expect(calls).not.toContain('getToken');
  });

  it('reports permission-granted registration failure without marking enabled', async () => {
    const { deps } = dependencies({
      getPermission: () => 'granted',
      getToken: async () => { throw new Error('registration failed'); },
    });
    const service = createNotificationRegistrationService(deps);
    await expect(service.refreshGranted('user-a', true)).resolves.toMatchObject({
      permission: 'granted', registration: 'failed',
    });
  });

  it('rotates an account-mismatched token before getting and associating the replacement', async () => {
    const local = new Map([
      ['parqueen_fcm_owner_uid', 'user-old'],
      ['parqueen_fcm_owner_version', '1'],
    ]);
    const { deps, calls } = dependencies({
      getPermission: () => 'granted',
      getLocal: key => local.get(key) ?? null,
      setLocal: (key, value) => { local.set(key, value); calls.push(`setLocal:${key}:${value}`); },
    });
    const service = createNotificationRegistrationService(deps);
    await service.refreshGranted('user-new', true);

    expect(calls.indexOf('deleteToken')).toBeLessThan(calls.indexOf('getToken'));
    expect(calls.indexOf('getToken')).toBeLessThan(calls.indexOf('write:fcmToken'));
    expect(calls.indexOf('write:fcmToken')).toBeLessThan(
      calls.indexOf('setLocal:parqueen_fcm_owner_uid:user-new'),
    );
  });

  it('enabling writes only the scalar token and product preference with merge semantics delegated to the boundary', async () => {
    const writePreferences = vi.fn().mockResolvedValue(undefined);
    const { deps } = dependencies({ writePreferences });
    const service = createNotificationRegistrationService(deps);
    await service.inspect();
    await service.enable('user-a');
    expect(writePreferences).toHaveBeenCalledWith('user-a', {
      fcmToken: 'token-123', notificationsEnabled: true,
    });
  });

  it('passes a configured public VAPID key without exposing it in runtime state', async () => {
    const getToken = vi.fn().mockResolvedValue('token-123');
    const { deps } = dependencies({ getPermission: () => 'granted', getToken, vapidKey: 'public-vapid' });
    const service = createNotificationRegistrationService(deps);
    const state = await service.refreshGranted('user-a', true);
    expect(getToken).toHaveBeenCalledWith(expect.anything(), { vapidKey: 'public-vapid' });
    expect(JSON.stringify(state)).not.toContain('public-vapid');
  });

  it('reports missing VAPID configuration without inventing a credential', () => {
    const { deps } = dependencies({ vapidKey: undefined });
    expect(createNotificationRegistrationService(deps).getVapidStatus()).toBe('missing');
  });

  it('returns the real foreground unsubscribe so lifecycle owners can prevent accumulation', async () => {
    const { deps, calls } = dependencies({ getPermission: () => 'granted' });
    const service = createNotificationRegistrationService(deps);
    const unsubscribe = await service.subscribeForeground('user-a', vi.fn());
    expect(calls.filter(call => call === 'onMessage')).toHaveLength(1);
    unsubscribe();
    expect(calls.filter(call => call === 'unsubscribe')).toHaveLength(1);
  });

  it('keeps Web/PWA subscribeOpen as a no-op so the service-worker listener stays authoritative', async () => {
    const { deps } = dependencies();
    const service = createNotificationRegistrationService(deps);
    const unsubscribe = await service.subscribeOpen(vi.fn());
    expect(typeof unsubscribe).toBe('function');
    unsubscribe();
  });
});
