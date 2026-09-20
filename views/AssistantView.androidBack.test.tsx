import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  };
  (globalThis as any).window = { addEventListener: () => {}, removeEventListener: () => {} };
});

vi.mock('../hooks/useFocusOnMount', () => ({ useFocusOnMount: () => {} }));
vi.mock('./street-parking/useParkingTimer', () => ({
  useParkingTimer: () => ({ startTimer: vi.fn(), timer: null }),
}));
vi.mock('../services/geminiService', () => ({
  analyzeParkingSign: vi.fn(),
}));

import type { AssistantAndroidBackHandle } from './AssistantView';
import { AssistantView } from './AssistantView';

function collectText(node: TestRenderer.ReactTestInstance): string {
  const out: string[] = [];
  const visit = (n: TestRenderer.ReactTestInstance) => {
    for (const c of (n.children ?? [])) {
      if (typeof c === 'string') out.push(c);
      else visit(c as TestRenderer.ReactTestInstance);
    }
  };
  visit(node);
  return out.join(' ');
}

describe('AssistantView Android Back delegation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns nested tools to the hub without leaving Parking Tools', async () => {
    const onBack = vi.fn();
    const backRef = { current: null as AssistantAndroidBackHandle | null };
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AssistantView onBack={onBack} androidBackRef={backRef} />,
      );
    });
    const scan = renderer!.root.findAllByType('button').find(
      (b) => b.props['aria-label'] === 'Scan a Parking Sign',
    );
    expect(scan).toBeDefined();
    await act(async () => {
      scan!.props.onClick();
    });
    expect(collectText(renderer!.root)).toContain('Scan a Parking Sign');

    await act(async () => {
      expect(backRef.current!.handleAndroidBack()).toBe('handled');
    });
    expect(onBack).not.toHaveBeenCalled();
    expect(collectText(renderer!.root)).toContain('Parking Tools');
  });

  it('leaves Parking Tools from the hub', async () => {
    const onBack = vi.fn();
    const backRef = { current: null as AssistantAndroidBackHandle | null };
    await act(async () => {
      TestRenderer.create(
        <AssistantView onBack={onBack} androidBackRef={backRef} />,
      );
    });
    expect(backRef.current!.handleAndroidBack()).toBe('leave');
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
