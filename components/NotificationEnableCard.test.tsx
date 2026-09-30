import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
});

import { NotificationEnableCard } from './NotificationEnableCard';
import type { NotificationRuntimeState } from '../utils/notificationRegistration';
import { setLang } from '../i18n';

const state = (
  values: Partial<NotificationRuntimeState> = {},
): NotificationRuntimeState => ({
  capability: 'supported',
  permission: 'default',
  registration: 'not_registered',
  ...values,
});

const text = (renderer: TestRenderer.ReactTestRenderer) =>
  JSON.stringify(renderer.toJSON());

describe('NotificationEnableCard', () => {
  beforeEach(() => setLang('en'));

  it('offers Enable and calls it only from the explicit button click', () => {
    const onEnable = vi.fn();
    const renderer = TestRenderer.create(
      <NotificationEnableCard
        runtime={state()}
        productPreferenceEnabled
        onEnable={onEnable}
        onRecheck={vi.fn()}
      />,
    );
    expect(onEnable).not.toHaveBeenCalled();
    const button = renderer.root.findByProps({ 'data-notification-action': 'enable' });
    act(() => button.props.onClick());
    expect(onEnable).toHaveBeenCalledTimes(1);
  });

  it('tells the installed iOS app that native alerts are not available yet', () => {
    const renderer = TestRenderer.create(
      <NotificationEnableCard
        runtime={state({ capability: 'ios_native_unavailable', permission: 'unavailable' })}
        productPreferenceEnabled
        onEnable={vi.fn()}
        onRecheck={vi.fn()}
      />,
    );
    const rendered = text(renderer);
    expect(rendered).toContain('Parking alerts aren’t available yet on iPhone');
    expect(rendered).toContain('not enabled in this TestFlight yet');
    expect(rendered).not.toContain('Add to Home Screen');
    expect(rendered).not.toContain('Safari');
    expect(renderer.root.findAllByProps({ 'data-notification-action': 'enable' })).toHaveLength(0);
  });

  it('shows iPhone Home Screen education without exposing an enable action', () => {
    const renderer = TestRenderer.create(
      <NotificationEnableCard
        runtime={state({ capability: 'ios_install_required', permission: 'unavailable' })}
        productPreferenceEnabled
        onEnable={vi.fn()}
        onRecheck={vi.fn()}
      />,
    );
    expect(text(renderer)).toContain('Add ParQueen to your Home Screen');
    expect(renderer.root.findAllByProps({ 'data-notification-action': 'enable' })).toHaveLength(0);
  });

  it('shows denied guidance and uses Recheck without calling Enable', () => {
    const onEnable = vi.fn();
    const onRecheck = vi.fn();
    const renderer = TestRenderer.create(
      <NotificationEnableCard
        runtime={state({ permission: 'denied' })}
        productPreferenceEnabled
        onEnable={onEnable}
        onRecheck={onRecheck}
      />,
    );
    const button = renderer.root.findByProps({ 'data-notification-action': 'recheck' });
    act(() => button.props.onClick());
    expect(onRecheck).toHaveBeenCalledTimes(1);
    expect(onEnable).not.toHaveBeenCalled();
  });

  it('keeps unsupported and registration failure visibly distinct', () => {
    const unsupported = TestRenderer.create(
      <NotificationEnableCard
        runtime={state({ capability: 'unsupported', permission: 'unavailable' })}
        productPreferenceEnabled
        onEnable={vi.fn()}
        onRecheck={vi.fn()}
      />,
    );
    expect(text(unsupported)).toContain('unavailable in this browser');

    const failed = TestRenderer.create(
      <NotificationEnableCard
        runtime={state({ permission: 'granted', registration: 'failed' })}
        productPreferenceEnabled
        onEnable={vi.fn()}
        onRecheck={vi.fn()}
      />,
    );
    expect(text(failed)).toContain('couldn’t finish setting up');
    expect(failed.root.findAllByProps({ 'data-notification-action': 'retry' })).toHaveLength(1);
  });

  it('claims alerts are enabled only for a registered granted state', () => {
    const renderer = TestRenderer.create(
      <NotificationEnableCard
        runtime={state({ permission: 'granted', registration: 'registered' })}
        productPreferenceEnabled
        onEnable={vi.fn()}
        onRecheck={vi.fn()}
      />,
    );
    expect(text(renderer)).toContain('Parking alerts are enabled');
    expect(renderer.root.findAll(n => n.type === 'button')).toHaveLength(0);
  });
});
