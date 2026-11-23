// Behaviour of the redesigned location primer: the art is new, the permission flow is not.
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

const geo = vi.hoisted(() => ({
  checkLocationPermission: vi.fn(),
  requestLocationPermission: vi.fn(),
}));
const access = vi.hoisted(() => ({
  readPersistedAccess: vi.fn(() => 'unknown'),
  reconcileLocationAccess: vi.fn(() => 'unknown'),
}));

vi.mock('../utils/geolocation', () => geo);
vi.mock('../utils/locationAccess', () => access);
vi.mock('../utils/geolocationPlatform', () => ({ resolveGeolocationPath: () => 'web' }));

import { LocationPromptView } from './LocationPromptView';
import { setLang, translateIn } from '../i18n';

const snap = (status: string, locationServicesEnabled: boolean | null = null) => ({
  status, accuracy: 'unknown', precise: false, approximate: false, locationServicesEnabled,
});

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

const render = async (props: Partial<React.ComponentProps<typeof LocationPromptView>> = {}) => {
  const onComplete = vi.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<LocationPromptView onComplete={onComplete} {...props} />);
  });
  await flush();
  const button = (cls: string) => renderer.root.find(n => n.type === 'button' && n.props.className === cls);
  const text = () => JSON.stringify(renderer.toJSON());
  return { renderer, onComplete, enable: button('pq-loc-enable'), skip: button('pq-loc-skip'), text };
};

describe('LocationPromptView', () => {
  beforeEach(() => {
    setLang('en');
    vi.clearAllMocks();
    geo.checkLocationPermission.mockResolvedValue(snap('prompt'));
    access.reconcileLocationAccess.mockReturnValue('unknown');
  });

  it('renders the vector neighborhood, one heading and two explicit actions without prompting', async () => {
    const { renderer, onComplete, text } = await render();
    const art = renderer.root.findByProps({ 'data-testid': 'location-neighborhood-art' });
    expect(art.type).toBe('svg');
    expect(art.props.role).toBe('img');
    expect(art.props['aria-label']).toBe(translateIn('en', 'location_prompt.map_desc'));
    expect(renderer.root.findAllByType('h1')).toHaveLength(1);
    expect(text()).toContain(translateIn('en', 'location_prompt.enable'));
    expect(text()).toContain(translateIn('en', 'location_prompt.skip'));
    expect(text()).toContain(translateIn('en', 'location_prompt.reassurance'));
    expect(geo.checkLocationPermission).toHaveBeenCalledTimes(1);
    expect(geo.requestLocationPermission).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it.each(['granted', 'denied'] as const)('skips itself when the OS already reports %s', async (resolved) => {
    access.reconcileLocationAccess.mockReturnValue(resolved);
    const { onComplete } = await render();
    expect(onComplete).toHaveBeenCalledWith(resolved);
  });

  it('Enable location requests permission and completes as granted', async () => {
    geo.requestLocationPermission.mockResolvedValue(snap('granted', true));
    const { enable, onComplete } = await render();
    await act(async () => { await enable.props.onClick(); });
    expect(geo.requestLocationPermission).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith('granted');
  });

  it('Enable location completes as denied when the OS denies', async () => {
    geo.requestLocationPermission.mockResolvedValue(snap('denied'));
    const { enable, onComplete } = await render();
    await act(async () => { await enable.props.onClick(); });
    expect(onComplete).toHaveBeenCalledWith('denied');
  });

  it('shows the services-off hint in the live region and stays on the screen', async () => {
    geo.requestLocationPermission.mockResolvedValue(snap('granted', false));
    const { renderer, enable, onComplete, text } = await render();
    await act(async () => { await enable.props.onClick(); });
    expect(onComplete).not.toHaveBeenCalled();
    const live = renderer.root.findByProps({ 'aria-live': 'polite' });
    const hintText = live.findByType('p').findAllByType('span').map(s => s.props.children).join(' ');
    expect(hintText).toContain(translateIn('en', 'location_prompt.services_off'));
    expect(text()).toContain(translateIn('en', 'location_prompt.enable'));
  });

  it.each([
    ['an unresolved prompt', () => geo.requestLocationPermission.mockResolvedValue(snap('prompt'))],
    ['a request error', () => geo.requestLocationPermission.mockRejectedValue(new Error('timeout'))],
  ])('shows the retry hint after %s', async (_label, arrange) => {
    arrange();
    const { enable, onComplete, text } = await render();
    await act(async () => { await enable.props.onClick(); });
    expect(onComplete).not.toHaveBeenCalled();
    expect(text()).toContain(translateIn('en', 'location_prompt.try_again'));
  });

  it('Not now continues without permission and never requests it', async () => {
    const { skip, onComplete } = await render();
    act(() => skip.props.onClick());
    expect(onComplete).toHaveBeenCalledWith('declined');
    expect(geo.requestLocationPermission).not.toHaveBeenCalled();
  });

  it('preview mode never checks or requests OS permission', async () => {
    const { enable, onComplete } = await render({ previewMode: true });
    await act(async () => { await enable.props.onClick(); });
    expect(geo.checkLocationPermission).not.toHaveBeenCalled();
    expect(geo.requestLocationPermission).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith('declined');
  });
});
