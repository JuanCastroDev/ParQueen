import { describe, expect, it, vi } from 'vitest';
import { createNotificationLifecycle } from './notificationLifecycle';

const runtime = {
  capability: 'supported' as const,
  permission: 'granted' as const,
  registration: 'registered' as const,
};

describe('notification lifecycle ownership', () => {
  it('only inspects runtime state while the product preference is unresolved', async () => {
    const service = {
      inspect: vi.fn().mockResolvedValue(runtime),
      refreshGranted: vi.fn().mockResolvedValue(runtime),
      subscribeForeground: vi.fn().mockResolvedValue(vi.fn()),
    };
    const onState = vi.fn();
    const lifecycle = createNotificationLifecycle(service, { onState, onPayload: vi.fn() });

    await lifecycle.setUser({ uid: 'user-a', productPreferenceEnabled: null });

    expect(service.inspect).toHaveBeenCalledTimes(1);
    expect(service.refreshGranted).not.toHaveBeenCalled();
    expect(service.subscribeForeground).not.toHaveBeenCalled();
    expect(onState).toHaveBeenLastCalledWith(runtime);
  });

  it('inspects without registering or subscribing when the product preference is disabled', async () => {
    const service = {
      inspect: vi.fn().mockResolvedValue(runtime),
      refreshGranted: vi.fn().mockResolvedValue(runtime),
      subscribeForeground: vi.fn().mockResolvedValue(vi.fn()),
    };
    const onState = vi.fn();
    const lifecycle = createNotificationLifecycle(service, { onState, onPayload: vi.fn() });

    await lifecycle.setUser({ uid: 'user-a', productPreferenceEnabled: false });

    expect(service.refreshGranted).toHaveBeenCalledWith('user-a', false);
    expect(service.subscribeForeground).not.toHaveBeenCalled();
    expect(onState).toHaveBeenLastCalledWith(runtime);
  });

  it('authentication uses silent refresh and installs exactly one foreground listener', async () => {
    const unsubscribe = vi.fn();
    const service = {
      inspect: vi.fn().mockResolvedValue(runtime),
      refreshGranted: vi.fn().mockResolvedValue(runtime),
      subscribeForeground: vi.fn().mockResolvedValue(unsubscribe),
    };
    const onState = vi.fn();
    const lifecycle = createNotificationLifecycle(service, { onState, onPayload: vi.fn() });

    await lifecycle.setUser({ uid: 'user-a', productPreferenceEnabled: true });

    expect(service.refreshGranted).toHaveBeenCalledWith('user-a', true);
    expect(service.subscribeForeground).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenLastCalledWith(runtime);
    expect(unsubscribe).not.toHaveBeenCalled();
  });

  it('account transition removes the previous listener before installing the next one', async () => {
    const unsubscribeA = vi.fn();
    const unsubscribeB = vi.fn();
    const service = {
      inspect: vi.fn().mockResolvedValue(runtime),
      refreshGranted: vi.fn().mockResolvedValue(runtime),
      subscribeForeground: vi.fn()
        .mockResolvedValueOnce(unsubscribeA)
        .mockResolvedValueOnce(unsubscribeB),
    };
    const lifecycle = createNotificationLifecycle(service, { onState: vi.fn(), onPayload: vi.fn() });

    await lifecycle.setUser({ uid: 'user-a', productPreferenceEnabled: true });
    await lifecycle.setUser({ uid: 'user-b', productPreferenceEnabled: true });

    expect(unsubscribeA).toHaveBeenCalledTimes(1);
    expect(service.subscribeForeground).toHaveBeenCalledTimes(2);
    lifecycle.dispose();
    expect(unsubscribeB).toHaveBeenCalledTimes(1);
  });

  it('cleans a late listener from a superseded async account transition', async () => {
    let resolveA!: (unsubscribe: () => void) => void;
    const unsubscribeA = vi.fn();
    const unsubscribeB = vi.fn();
    const service = {
      inspect: vi.fn().mockResolvedValue(runtime),
      refreshGranted: vi.fn().mockResolvedValue(runtime),
      subscribeForeground: vi.fn()
        .mockImplementationOnce(() => new Promise<() => void>(resolve => { resolveA = resolve; }))
        .mockResolvedValueOnce(unsubscribeB),
    };
    const lifecycle = createNotificationLifecycle(service, { onState: vi.fn(), onPayload: vi.fn() });

    const first = lifecycle.setUser({ uid: 'user-a', productPreferenceEnabled: true });
    await Promise.resolve();
    await lifecycle.setUser({ uid: 'user-b', productPreferenceEnabled: true });
    resolveA(unsubscribeA);
    await first;

    expect(unsubscribeA).toHaveBeenCalledTimes(1);
    expect(unsubscribeB).not.toHaveBeenCalled();
    lifecycle.dispose();
    expect(unsubscribeB).toHaveBeenCalledTimes(1);
  });

  it('logout removes the active listener and clears runtime state', async () => {
    const unsubscribe = vi.fn();
    const onState = vi.fn();
    const service = {
      inspect: vi.fn().mockResolvedValue(runtime),
      refreshGranted: vi.fn().mockResolvedValue(runtime),
      subscribeForeground: vi.fn().mockResolvedValue(unsubscribe),
    };
    const lifecycle = createNotificationLifecycle(service, { onState, onPayload: vi.fn() });
    await lifecycle.setUser({ uid: 'user-a', productPreferenceEnabled: true });

    await lifecycle.setUser(null);

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(onState).toHaveBeenLastCalledWith(null);
  });
});
