import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const analyzeParkingSign = vi.fn();

vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  };
  (globalThis as any).window = { addEventListener: () => {}, removeEventListener: () => {} };
});

vi.mock('../services/geminiService', () => ({
  analyzeParkingSign: (...args: any[]) => analyzeParkingSign(...args),
}));
vi.mock('../hooks/useFocusOnMount', () => ({ useFocusOnMount: () => {} }));
vi.mock('./street-parking/useParkingTimer', () => ({
  useParkingTimer: () => ({ startTimer: vi.fn(), timer: null }),
}));

import { AssistantView } from './AssistantView';
import { loadRecentScans, recordScan, clearRecentScans } from '../utils/recentScans';

class FakeFileReader {
  result = 'data:image/png;base64,aW1hZ2U=';
  onloadend: null | (() => void) = null;
  readAsDataURL() { this.onloadend?.(); }
}

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
const textOf = (r: TestRenderer.ReactTestRenderer) => collectText(r.root);
const buttonWith = (r: TestRenderer.ReactTestRenderer, label: string) => {
  const b = r.root.findAllByType('button').find(x => collectText(x).includes(label));
  if (!b) throw new Error(`no button containing "${label}"`);
  return b;
};

async function mount() {
  let r: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(<AssistantView />); });
  return r!;
}
async function choosePhoto(r: TestRenderer.ReactTestRenderer) {
  await act(async () => { buttonWith(r, 'Scan a Parking Sign').props.onClick(); });
  await act(async () => {
    r.root.findAllByType('input')[0].props.onChange({ target: { files: [{}], value: '' } });
    await Promise.resolve();
  });
}

beforeEach(() => {
  analyzeParkingSign.mockReset();
  analyzeParkingSign.mockResolvedValue({ status: 'YES', explanation: 'Parking allowed after 6pm.' });
  (globalThis as any).FileReader = FakeFileReader;
  clearRecentScans();
});

describe('Parking Tools - hub', () => {
  it('leads with featured Scan and secondary tool tiles', async () => {
    const r = await mount();
    const text = textOf(r);
    expect(text).toContain('Parking Tools');
    expect(text).toContain('Scan a Parking Sign');
    expect(text).toContain('Hydrant Distance');
    expect(text).toContain('Am I Safe Here?');
    const buttons = r.root.findAllByType('button');
    expect(buttons.find(b => b.props['aria-label'] === 'Check Hydrant Distance')).toBeDefined();
    expect(buttons.find(b => b.props.className?.includes('pq-tool-featured'))).toBeDefined();
    expect(r.root.findAll(n => n.props?.className === 'pq-tools-secondary')).toHaveLength(1);
  });

  it('shows one header and one back control at a time', async () => {
    const r = await mount();
    const headings = () => r.root.findAllByType('h1');
    const backs = () => r.root.findAllByType('button').filter(b => /Back to/.test(b.props['aria-label'] ?? ''));
    expect(headings()).toHaveLength(1);
    expect(collectText(headings()[0])).toBe('Parking Tools');
    expect(backs()).toHaveLength(1);
    expect(backs()[0].props['aria-label']).toBe('Back to the map');

    await act(async () => { buttonWith(r, 'Scan a Parking Sign').props.onClick(); });
    expect(headings()).toHaveLength(1);
    expect(collectText(headings()[0])).toBe('Scan a Parking Sign');
    expect(backs()).toHaveLength(1);
    expect(backs()[0].props['aria-label']).toBe('Back to the assistant home');
  });

  it('sends the hub back control out of the assistant', async () => {
    const onBack = vi.fn();
    let r: TestRenderer.ReactTestRenderer;
    await act(async () => { r = TestRenderer.create(<AssistantView onBack={onBack} />); });
    const back = r!.root.findAllByType('button').find(b => b.props['aria-label'] === 'Back to the map')!;
    await act(async () => { back.props.onClick(); });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('moves the scanner steps off the hub and into the scan flow', async () => {
    const r = await mount();
    expect(textOf(r)).not.toContain('HOW IT WORKS');
    await act(async () => { buttonWith(r, 'Scan a Parking Sign').props.onClick(); });
    expect(textOf(r)).toContain('Take a clear photo of the parking sign.');
  });

  it('has no Soon badge and no disabled tool left on the hub', async () => {
    const r = await mount();
    expect(textOf(r)).not.toContain('Soon');
    const buttons = r.root.findAllByType('button');
    expect(buttons.some(b => b.props.disabled)).toBe(false);
    // Every tool card is a real destination with a working handler (aria keeps full titles).
    for (const title of ['Scan a Parking Sign', 'Check Hydrant Distance', 'Am I Safe Here?']) {
      const card = buttons.find(b => b.props['aria-label'] === title);
      expect(card).toBeDefined();
      expect(typeof card!.props.onClick).toBe('function');
    }
  });

  it('names each tool card rather than reciting its whole contents', async () => {
    const r = await mount();
    const card = r.root.findAllByType('button').find(b => collectText(b).includes('Scan a Parking Sign'))!;
    expect(card.props['aria-label']).toBe('Scan a Parking Sign');
  });

  it('does not claim accuracy or guarantee safety anywhere on the hub', async () => {
    const text = textOf(await mount());
    for (const banned of ['Accurate', 'GUARANTEED', '100% SAFE', 'LEGAL', 'LIVE']) {
      expect(text).not.toContain(banned);
    }
  });

  it('shows an empty state rather than sample scans', async () => {
    const text = textOf(await mount());
    expect(text).toContain('No parking checks yet');
    expect(text).toContain('Your recent parking activity will appear here.');
  });

  it('lists a real scan after one completes', async () => {
    const r = await mount();
    await choosePhoto(r);
    await act(async () => {
      buttonWith(r, 'Analyze Sign').props.onClick();
      await Promise.resolve(); await Promise.resolve();
    });
    await act(async () => { buttonWith(r, 'Scan another sign').props.onClick(); });
    // back to the hub via the single header's back control
    await act(async () => {
      r.root.findAllByType('button')
        .find(b => b.props['aria-label'] === 'Back to the assistant home')!.props.onClick();
    });
    expect(textOf(r)).toContain('Parking allowed after 6pm.');
  });
});

describe('Sign Scanner â€” scan states', () => {
  it('previews the photo and waits for an explicit Analyze before calling the model', async () => {
    const r = await mount();
    await choosePhoto(r);
    expect(r.root.findAllByType('img').length).toBe(1);
    expect(analyzeParkingSign).not.toHaveBeenCalled();
    expect(textOf(r)).toContain('Retake photo');
    expect(textOf(r)).toContain('Cancel');
  });

  it('shows the full sign photo with object-contain in preview and compact result', async () => {
    const r = await mount();
    await choosePhoto(r);
    const previewImg = r.root.findByType('img');
    expect(previewImg.props.className).toContain('object-contain');
    expect(previewImg.props.className).not.toContain('object-cover');
    expect(previewImg.props.className).toContain('max-h-[340px]');

    await act(async () => {
      buttonWith(r, 'Analyze Sign').props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    const doneImg = r.root.findByType('img');
    expect(doneImg.props.className).toContain('object-contain');
    expect(doneImg.props.className).not.toContain('object-cover');
    expect(doneImg.props.className).toContain('max-h-[160px]');
    expect(textOf(r)).toContain('Parking allowed after 6pm.');
  });

  it('prevents duplicate submissions from a double tap', async () => {
    let resolveCall: (v: any) => void = () => {};
    analyzeParkingSign.mockImplementation(() => new Promise(res => { resolveCall = res; }));
    const r = await mount();
    await choosePhoto(r);
    const analyze = buttonWith(r, 'Analyze Sign');
    await act(async () => { analyze.props.onClick(); analyze.props.onClick(); });
    expect(analyzeParkingSign).toHaveBeenCalledTimes(1);
    await act(async () => { resolveCall({ status: 'YES', explanation: 'ok' }); await Promise.resolve(); });
  });

  it('announces the analyzing state politely for screen readers', async () => {
    analyzeParkingSign.mockImplementation(() => new Promise(() => {}));
    const r = await mount();
    await choosePhoto(r);
    await act(async () => { buttonWith(r, 'Analyze Sign').props.onClick(); });
    const live = r.root.findAll(n => n.props?.['aria-live'] === 'polite');
    expect(live.length).toBeGreaterThan(0);
    expect(collectText(live[0])).toContain('Reading the sign');
  });

  it('retake returns to the capture step and clears the photo', async () => {
    const r = await mount();
    await choosePhoto(r);
    await act(async () => { buttonWith(r, 'Retake photo').props.onClick(); });
    expect(r.root.findAllByType('img').length).toBe(0);
    expect(textOf(r)).toContain('Open camera');
  });

  it('cancel leaves the scanner and returns to the hub', async () => {
    const r = await mount();
    await choosePhoto(r);
    await act(async () => { buttonWith(r, 'Cancel').props.onClick(); });
    expect(textOf(r)).toContain('Hydrant Distance');
    expect(
      r.root.findAllByType('button').some(b => b.props['aria-label'] === 'Check Hydrant Distance'),
    ).toBe(true);
  });

  it('does not print the error headline twice when it matches the card label', async () => {
    analyzeParkingSign.mockResolvedValue({
      status: 'ERROR',
      explanation: "We couldn't read that sign.\nTry a straight-on photo.",
    });
    const r = await mount();
    await choosePhoto(r);
    await act(async () => {
      buttonWith(r, 'Analyze Sign').props.onClick();
      await Promise.resolve(); await Promise.resolve();
    });
    const text = textOf(r);
    expect(text.split("We couldn't read that sign.").length - 1).toBe(1);
    expect(text).toContain('Try a straight-on photo.');
  });

  it('offers recovery actions on an unreadable sign', async () => {
    analyzeParkingSign.mockResolvedValue({ status: 'ERROR', explanation: 'Bad photo' });
    const r = await mount();
    await choosePhoto(r);
    await act(async () => {
      buttonWith(r, 'Analyze Sign').props.onClick();
      await Promise.resolve(); await Promise.resolve();
    });
    const text = textOf(r);
    expect(text).toContain("We couldn't read that sign.");
    expect(text).toContain('Try again');
    expect(text).toContain('Choose another photo');
  });
});

describe('recentScans store', () => {
  it('keeps only title, verdict and timestamp â€” never a photo or location', async () => {
    const list = recordScan({ status: 'YES', explanation: 'Parking allowed.\nDetails here.' } as any);
    expect(list).toHaveLength(1);
    expect(Object.keys(list[0]).sort()).toEqual(['id', 'status', 'title', 'ts']);
    expect(list[0].title).toBe('Parking allowed.');
  });

  it('does not record failed reads', () => {
    recordScan({ status: 'ERROR', explanation: 'nope' } as any);
    expect(loadRecentScans()).toHaveLength(0);
  });

  it('caps history at five entries, newest first', () => {
    for (let i = 1; i <= 7; i++) recordScan({ status: 'YES', explanation: `Scan ${i}` } as any);
    const list = loadRecentScans();
    expect(list).toHaveLength(5);
    expect(list[0].title).toBe('Scan 7');
  });

  it('survives unusable storage without throwing', () => {
    const original = (globalThis as any).localStorage;
    (globalThis as any).localStorage = {
      getItem() { throw new Error('blocked'); },
      setItem() { throw new Error('blocked'); },
      removeItem() { throw new Error('blocked'); },
    };
    expect(() => loadRecentScans()).not.toThrow();
    expect(loadRecentScans()).toEqual([]);
    (globalThis as any).localStorage = original;
  });
});
