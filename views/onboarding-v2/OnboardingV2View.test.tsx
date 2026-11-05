import React from 'react';
import TestRenderer, { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, String(value)); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => values.clear(),
    },
  });
  const state = { reduceMotion: false, focused: [] as string[] };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      matchMedia: (q: string) => ({ matches: q.includes('reduce') ? state.reduceMotion : false }),
      addEventListener: () => {},
      removeEventListener: () => {},
    },
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { getElementById: (id: string) => ({ focus: () => state.focused.push(id) }) },
  });
  return state;
});

import { OnboardingV2View, type OnboardingV2AndroidBackHandle } from './OnboardingV2View';
import { getLang, setLang } from '../../i18n';
import en from '../../i18n/en';
import es from '../../i18n/es';

// Every element measures as a 360x712 stage with 200px panels.
const nodeMock = () => ({
  clientWidth: 360, clientHeight: 712, offsetWidth: 120, offsetHeight: 200, offsetTop: 24,
  scrollHeight: 200, scrollTop: 0, getBoundingClientRect: () => ({ left: 0 }), focus: () => {},
});

function inMeasurer(node: ReactTestInstance): boolean {
  for (let p: ReactTestInstance | null = node.parent; p; p = p.parent) {
    if (typeof p.props?.className === 'string' && p.props.className.split(' ').includes('obv2-measure')) return true;
  }
  return false;
}
function textOf(node: ReactTestInstance | string): string {
  if (typeof node === 'string') return node;
  return node.children.map(c => textOf(c as ReactTestInstance | string)).join('');
}
function liveButtons(r: TestRenderer.ReactTestRenderer) {
  return r.root.findAll(n => n.type === 'button' && !inMeasurer(n));
}
function button(r: TestRenderer.ReactTestRenderer, label: string) {
  const found = liveButtons(r).filter(b => textOf(b).includes(label) || b.props['aria-label'] === label);
  if (!found.length) throw new Error(`no button "${label}"`);
  return found[0];
}
const stage = (r: TestRenderer.ReactTestRenderer) => r.root.find(n => n.props['data-testid'] === 'obv2-stage');
const stateOf = (r: TestRenderer.ReactTestRenderer) => stage(r).props['data-state'];
const live = (r: TestRenderer.ReactTestRenderer) => textOf(r.root.find(n => n.props['data-testid'] === 'obv2-live'));

function mount(props: Partial<React.ComponentProps<typeof OnboardingV2View>> = {}) {
  const onChooseIntent = vi.fn();
  const onAccount = vi.fn();
  const androidBackRef = { current: null as OnboardingV2AndroidBackHandle | null };
  let r!: TestRenderer.ReactTestRenderer;
  act(() => {
    r = TestRenderer.create(
      <OnboardingV2View onChooseIntent={onChooseIntent} onAccount={onAccount} androidBackRef={androidBackRef} {...props} />,
      { createNodeMock: nodeMock },
    );
  });
  return { r, onChooseIntent, onAccount, androidBackRef };
}

describe('OnboardingV2View', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    env.reduceMotion = false;
    env.focused = [];
    setLang('en');
  });
  afterEach(() => vi.useRealTimers());

  it('opens on arrival with the approved copy and no auto-play', () => {
    const { r } = mount();
    expect(stateOf(r)).toBe('arrive');
    const t = textOf(r.root);
    expect(t).toContain(en['onboarding_v2.headline_1']);
    expect(t).toContain(en['onboarding_v2.primary']);
    act(() => { vi.advanceTimersByTime(20_000); });
    expect(stateOf(r)).toBe('arrive');
  });

  it('one tap plays the ~8.3 s story: captions at 2.3 s and 6 s, the three intentions at 7.7 s', () => {
    const { r } = mount();
    act(() => { button(r, en['onboarding_v2.primary']).props.onClick(); });
    expect(stateOf(r)).toBe('demo');
    expect(stage(r).props.className).toContain('play');
    const caption = () => textOf(r.root.find(n => n.props.id === 'obv2-cap'));
    expect(caption()).toBe(en['onboarding_v2.caption_1']);
    act(() => { vi.advanceTimersByTime(2299); });
    expect(caption()).toBe(en['onboarding_v2.caption_1']);
    act(() => { vi.advanceTimersByTime(1); });
    expect(caption()).toBe(en['onboarding_v2.caption_2']);
    act(() => { vi.advanceTimersByTime(6000 - 2300); });
    expect(caption()).toBe(en['onboarding_v2.caption_3']);
    act(() => { vi.advanceTimersByTime(7699 - 6000); });
    expect(stateOf(r)).toBe('demo');
    act(() => { vi.advanceTimersByTime(1); });
    expect(stateOf(r)).toBe('choose');
    act(() => { vi.advanceTimersByTime(200); });
    expect(live(r)).toBe(en['onboarding_v2.done']);
    expect(env.focused).toContain('obv2-h-choose');
  });

  it('tapping the car also starts the story', () => {
    const { r } = mount();
    const car = r.root.find(n => n.props['data-testid'] === 'obv2-car');
    expect(car.props.hidden).toBe(false);
    act(() => { car.props.onClick(); });
    expect(stateOf(r)).toBe('demo');
    expect(r.root.find(n => n.props['data-testid'] === 'obv2-car').props.hidden).toBe(true);
  });

  it('Skip on arrival and during the story goes straight to the choices', () => {
    const a = mount();
    act(() => { button(a.r, en['onboarding_v2.skip']).props.onClick(); });
    expect(stateOf(a.r)).toBe('choose');
    const b = mount();
    act(() => { button(b.r, en['onboarding_v2.primary']).props.onClick(); });
    act(() => { button(b.r, en['onboarding_v2.skip_to_choices']).props.onClick(); });
    expect(stateOf(b.r)).toBe('choose');
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(stateOf(b.r)).toBe('choose');
  });

  it('Replay runs the story again from the start; Back returns to arrival', () => {
    const { r } = mount({ initialState: 'choose' });
    expect(stateOf(r)).toBe('choose');
    act(() => { button(r, en['onboarding_v2.replay']).props.onClick(); });
    expect(stateOf(r)).toBe('demo');
    act(() => { vi.advanceTimersByTime(7700); });
    expect(stateOf(r)).toBe('choose');
    act(() => { button(r, en['onboarding_v2.back']).props.onClick(); });
    expect(stateOf(r)).toBe('arrive');
  });

  it('choosing an intention hands off after the highlight and never more than once', () => {
    const { r, onChooseIntent } = mount({ initialState: 'choose' });
    const opt = (id: string) => liveButtons(r).find(b => b.props['data-intent'] === id)!;
    act(() => { opt('leave').props.onClick(); });
    act(() => { opt('find').props.onClick(); });
    expect(onChooseIntent).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(200); });
    expect(onChooseIntent).toHaveBeenCalledTimes(1);
    expect(onChooseIntent).toHaveBeenCalledWith('leave');
  });

  it('offers exactly the three intentions plus an account link', () => {
    const { r, onAccount } = mount({ initialState: 'choose' });
    const ids = liveButtons(r).map(b => b.props['data-intent']).filter(Boolean);
    expect(ids).toEqual(['find', 'leave', 'explore']);
    const accountButtons = liveButtons(r).filter(b => textOf(b) === en['onboarding_v2.account']);
    act(() => { accountButtons[accountButtons.length - 1].props.onClick(); });
    expect(onAccount).toHaveBeenCalledTimes(1);
  });

  it('reduced motion: Play goes straight to the choices and choosing is immediate', () => {
    env.reduceMotion = true;
    const { r, onChooseIntent } = mount();
    expect(stage(r).props.className).not.toContain('intro');
    act(() => { button(r, en['onboarding_v2.primary']).props.onClick(); });
    expect(stateOf(r)).toBe('choose');
    act(() => { liveButtons(r).find(b => b.props['data-intent'] === 'explore')!.props.onClick(); });
    expect(onChooseIntent).toHaveBeenCalledWith('explore');
  });

  it('switches language in place and persists it', () => {
    const { r } = mount();
    act(() => { button(r, 'Español').props.onClick(); });
    expect(getLang()).toBe('es');
    expect(stage(r).props.lang).toBe('es');
    expect(textOf(r.root)).toContain(es['onboarding_v2.headline_1']);
    expect(localStorage.getItem('parqueen_lang')).toBe('es');
    expect(button(r, 'Español').props['aria-pressed']).toBe(true);
  });

  it('Android Back: story and choices step back to arrival; arrival minimizes', () => {
    const { r, androidBackRef } = mount();
    expect(androidBackRef.current?.handleAndroidBack()).toBe('minimize');
    act(() => { button(r, en['onboarding_v2.primary']).props.onClick(); });
    let result: string | undefined;
    act(() => { result = androidBackRef.current?.handleAndroidBack(); });
    expect(result).toBe('handled');
    expect(stateOf(r)).toBe('arrive');
    act(() => { vi.advanceTimersByTime(10_000); });
    expect(stateOf(r)).toBe('arrive');
  });

  it('inactive panels are inert and hidden from assistive technology', () => {
    const { r } = mount();
    const sections = r.root.findAll(n => n.type === 'section' && !inMeasurer(n));
    expect(sections).toHaveLength(3);
    const inactive = sections.filter(s => s.props.inert === '');
    expect(inactive).toHaveLength(2);
    inactive.forEach(s => expect(s.props['aria-hidden']).toBe(true));
  });

  it('describes the street as an example, never as live activity', () => {
    const { r } = mount();
    const art = r.root.find(n => n.props.role === 'img');
    expect(art.props['aria-label']).toBe(en['onboarding_v2.alt_arrive']);
    expect(en['onboarding_v2.alt_arrive'].toLowerCase()).toMatch(/example|illustrat/);
    expect(es['onboarding_v2.alt_arrive'].toLowerCase()).toMatch(/ejemplo|ilustra/);
  });
});
