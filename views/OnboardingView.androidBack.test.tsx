import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const matchMedia = vi.fn().mockReturnValue({
  matches: true,
  addListener: vi.fn(),
  removeListener: vi.fn(),
  addEventListener: vi.fn(),
  removeEventListener: vi.fn(),
});

Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    matchMedia,
    history: { state: null, pushState: vi.fn(), back: vi.fn() },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  },
});

vi.mock('../i18n', () => ({
  useLang: () => 'en',
  t: (key: string) => key,
}));

vi.mock('../assets/Parqueen_Logo.png', () => ({ default: 'logo.png' }));

import type { OnboardingAndroidBackHandle } from './OnboardingView';
import { OnboardingView } from './OnboardingView';

function selectedSlideLabels(renderer: TestRenderer.ReactTestRenderer): string[] {
  return renderer.root
    .findAll((node) => node.props['aria-selected'] === true && typeof node.props['aria-label'] === 'string')
    .map((node) => node.props['aria-label'] as string);
}

describe('OnboardingView Android Back delegation', () => {
  beforeEach(() => {
    matchMedia.mockClear();
  });

  it('moves from slide 2 to slide 1 and from slide 3 to slide 2', async () => {
    const backRef = { current: null as OnboardingAndroidBackHandle | null };
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <OnboardingView onComplete={() => undefined} initialSlide={2} androidBackRef={backRef} />,
      );
    });
    expect(backRef.current).toBeTruthy();
    expect(selectedSlideLabels(renderer!).some((label) => label === 'Slide 3 of 3')).toBe(true);

    await act(async () => {
      expect(backRef.current!.handleAndroidBack()).toBe('handled');
    });
    expect(selectedSlideLabels(renderer!).some((label) => label === 'Slide 2 of 3')).toBe(true);

    await act(async () => {
      expect(backRef.current!.handleAndroidBack()).toBe('handled');
    });
    expect(selectedSlideLabels(renderer!).some((label) => label === 'Slide 1 of 3')).toBe(true);
  });

  it('requests root minimize on the first slide', async () => {
    const backRef = { current: null as OnboardingAndroidBackHandle | null };
    await act(async () => {
      TestRenderer.create(
        <OnboardingView onComplete={() => undefined} initialSlide={0} androidBackRef={backRef} />,
      );
    });
    expect(backRef.current!.handleAndroidBack()).toBe('minimize');
  });
});
