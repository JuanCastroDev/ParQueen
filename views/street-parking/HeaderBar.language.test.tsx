import { readFileSync } from 'node:fs';
import React, { createRef } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, String(value)); },
      removeItem: (key: string) => { store.delete(key); },
      clear: () => { store.clear(); },
    },
  });
});

import { setLang } from '../../i18n';
import { AppView } from '../../types';
import { HeaderBar } from './HeaderBar';

const textOf = (node: any): string => typeof node === 'string'
  ? node
  : (node?.children ?? []).map(textOf).join('');

function renderHeader() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <HeaderBar
        user={null}
        setView={() => {}}
        inputRef={createRef()}
        searchQuery=""
        setSearchQuery={() => {}}
        searchOpen={false}
        setSearchOpen={() => {}}
        results={[]}
        setResults={() => {}}
        loading={false}
        handleCancelSearch={() => {}}
        unreadMessagesCount={0}
        pendingUpdatesCount={0}
        setPendingUpdatesCount={() => {}}
        onSelectResult={() => {}}
      />,
    );
  });
  return renderer;
}

beforeEach(() => setLang('en'));
afterEach(() => setLang('en'));

describe('HeaderBar language', () => {
  it('switches Scan and the search placeholder without remounting', () => {
    const renderer = renderHeader();
    expect(textOf(renderer.toJSON())).toContain('Scan');
    const placeholder = renderer.root.findByType('input').props.placeholder;
    expect(placeholder).toBe('Search a neighborhood');

    act(() => setLang('es'));
    expect(textOf(renderer.toJSON())).toContain('Escanear');
    expect(textOf(renderer.toJSON())).not.toContain('Scan street sign');
    expect(renderer.root.findByType('input').props.placeholder).toBe('Busca un vecindario');
    expect(renderer.root.findByType('input').props['aria-label']).toBe('Busca un vecindario');

    act(() => setLang('en'));
    expect(renderer.root.findByType('input').props.placeholder).toBe('Search a neighborhood');
    expect(textOf(renderer.toJSON())).toContain('Scan');
  });
});

describe('My Car Spanish copy', () => {
  it('uses translation keys for the controls that were hardcoded in English', () => {
    const source = readFileSync(new URL('../StreetParkingView.tsx', import.meta.url), 'utf8');
    for (const key of [
      'my_car.navigate_short',
      'my_car.navigate',
      'my_car.cleaning_alert',
      'my_car.move_reminder',
      'my_car.reminder_on',
      'my_car.cleaning_reminder_detail',
    ]) {
      expect(source).toContain(`t('${key}')`);
    }
    expect(source).not.toContain('>Navigate<');
    expect(source).not.toContain('Cleaning alert');
    expect(source).not.toContain('Move reminder');
    expect(source).not.toContain("We'll remind you");
  });
});
