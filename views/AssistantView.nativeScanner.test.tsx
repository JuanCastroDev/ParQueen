import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const analyzeParkingSign = vi.fn();
const captureFromCamera = vi.fn();
const pickFromGallery = vi.fn();
const usesNativeSignCapture = vi.fn(() => true);
let restoredListener: ((outcome: { status: string; image?: { previewUrl: string; imageData: string } }) => void) | null = null;

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
vi.mock('../utils/signScanner', () => ({
  usesNativeSignCapture: () => usesNativeSignCapture(),
  captureFromCamera: (...args: any[]) => captureFromCamera(...args),
  pickFromGallery: (...args: any[]) => pickFromGallery(...args),
  subscribeRestoredSignCapture: (listener: typeof restoredListener) => {
    restoredListener = listener;
    return () => { restoredListener = null; };
  },
}));

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

async function openScanner(r: TestRenderer.ReactTestRenderer) {
  await act(async () => { buttonWith(r, 'Scan a Parking Sign').props.onClick(); });
}

beforeEach(() => {
  analyzeParkingSign.mockReset();
  captureFromCamera.mockReset();
  pickFromGallery.mockReset();
  usesNativeSignCapture.mockReset();
  usesNativeSignCapture.mockReturnValue(true);
  restoredListener = null;
});

describe('AI Sign Scanner — native Android capture', () => {
  it('previews a native camera photo without spending an AI request', async () => {
    captureFromCamera.mockResolvedValue({
      status: 'captured',
      image: { previewUrl: 'data:image/jpeg;base64,abc', imageData: 'abc' },
    });
    const r = await mount();
    await openScanner(r);
    await act(async () => { await buttonWith(r, 'Open camera').props.onClick(); });
    expect(r.root.findAllByType('img').length).toBe(1);
    expect(analyzeParkingSign).not.toHaveBeenCalled();
    expect(textOf(r)).toContain('Analyze Sign');
    expect(captureFromCamera).toHaveBeenCalledTimes(1);
  });

  it('previews a native gallery pick without spending an AI request', async () => {
    pickFromGallery.mockResolvedValue({
      status: 'captured',
      image: { previewUrl: 'data:image/png;base64,xyz', imageData: 'xyz' },
    });
    const r = await mount();
    await openScanner(r);
    await act(async () => { await buttonWith(r, 'Choose from photos').props.onClick(); });
    expect(r.root.findAllByType('img').length).toBe(1);
    expect(analyzeParkingSign).not.toHaveBeenCalled();
    expect(pickFromGallery).toHaveBeenCalledTimes(1);
  });

  it('returns to the idle scanner when the user cancels the camera or picker', async () => {
    captureFromCamera.mockResolvedValue({ status: 'cancelled' });
    pickFromGallery.mockResolvedValue({ status: 'cancelled' });
    const r = await mount();
    await openScanner(r);
    await act(async () => { await buttonWith(r, 'Open camera').props.onClick(); });
    expect(r.root.findAllByType('img').length).toBe(0);
    expect(textOf(r)).toContain('Open camera');
    await act(async () => { await buttonWith(r, 'Choose from photos').props.onClick(); });
    expect(r.root.findAllByType('img').length).toBe(0);
    expect(analyzeParkingSign).not.toHaveBeenCalled();
  });

  it('ignores malformed native results without entering an error state', async () => {
    captureFromCamera.mockResolvedValue({ status: 'empty' });
    const r = await mount();
    await openScanner(r);
    await act(async () => { await buttonWith(r, 'Open camera').props.onClick(); });
    expect(r.root.findAllByType('img').length).toBe(0);
    expect(textOf(r)).not.toContain("We couldn't read that sign.");
    expect(analyzeParkingSign).not.toHaveBeenCalled();
  });

  it('applies a restored camera capture as a preview, not an analysis', async () => {
    const r = await mount();
    await act(async () => {
      restoredListener?.({
        status: 'captured',
        image: { previewUrl: 'data:image/jpeg;base64,restored', imageData: 'restored' },
      });
    });
    expect(r.root.findAllByType('img').length).toBe(1);
    expect(analyzeParkingSign).not.toHaveBeenCalled();
    expect(textOf(r)).toContain('Analyze Sign');
  });

  it('does not call the native camera path when native capture is off', async () => {
    usesNativeSignCapture.mockReturnValue(false);
    const r = await mount();
    await openScanner(r);
    expect(r.root.findAllByType('input')).toHaveLength(2);
    await act(async () => { buttonWith(r, 'Open camera').props.onClick(); });
    await act(async () => { buttonWith(r, 'Choose from photos').props.onClick(); });
    expect(captureFromCamera).not.toHaveBeenCalled();
    expect(pickFromGallery).not.toHaveBeenCalled();
  });
});
