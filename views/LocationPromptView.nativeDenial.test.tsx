// The real geolocation module with a fake Capacitor plugin: a first Android "Don't allow" must leave the
// Enable Location screen as a denial, never with the "location was not blocked" timeout hint.
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// i18n and locationAccess read localStorage while loading; install a fresh in-memory store first.
const store = vi.hoisted(() => {
  const map = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, String(value)); },
    removeItem: (key: string) => { map.delete(key); },
    clear: () => map.clear(),
  };
  return map;
});

import { __setLocationBackendForTests, createNativeGeolocation, type NativeGeolocationPlugin } from '../utils/geolocation';

vi.mock('../utils/geolocationPlatform', () => ({ resolveGeolocationPath: () => 'native' }));

import { LocationPromptView } from './LocationPromptView';
import { setLang, t } from '../i18n';

const plugin = (requestResult: { location: string; coarseLocation: string }): NativeGeolocationPlugin => ({
  getCurrentPosition: vi.fn(),
  watchPosition: vi.fn(),
  clearWatch: vi.fn(async () => undefined),
  checkPermissions: vi.fn(async () => ({ location: 'prompt', coarseLocation: 'prompt' })),
  requestPermissions: vi.fn(async () => requestResult),
});

const flush = () => act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });

async function renderWith(fake: NativeGeolocationPlugin) {
  __setLocationBackendForTests(createNativeGeolocation(fake));
  const onComplete = vi.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<LocationPromptView onComplete={onComplete} />);
  });
  await flush();
  const enable = renderer.root.find(n => n.type === 'button' && n.props.className === 'pq-loc-enable');
  await act(async () => { enable.props.onClick(); });
  await flush();
  return { onComplete, text: JSON.stringify(renderer.toJSON()) };
}

beforeEach(() => {
  store.clear();
});

afterEach(() => {
  __setLocationBackendForTests();
});

describe('Enable Location with the native backend', () => {
  it('continues as denied after a first "Don\'t allow" and never shows the "not blocked" hint', async () => {
    setLang('en');
    const fake = plugin({ location: 'prompt-with-rationale', coarseLocation: 'prompt-with-rationale' });
    const { onComplete, text } = await renderWith(fake);
    expect(fake.requestPermissions).toHaveBeenCalledTimes(1);
    expect(onComplete).toHaveBeenCalledWith('denied');
    expect(text).not.toContain(t('location_prompt.try_again'));
  });

  it('continues as granted after Allow', async () => {
    setLang('en');
    const { onComplete } = await renderWith(plugin({ location: 'granted', coarseLocation: 'granted' }));
    expect(onComplete).toHaveBeenCalledWith('granted');
  });
});
